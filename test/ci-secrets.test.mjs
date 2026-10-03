import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * The secrets CI needs on a Dependabot pull request.
 *
 * GitHub runs a Dependabot PR's workflows with Dependabot's own secret store,
 * not the Actions one. A CI that reads an Actions secret therefore fails on
 * every Dependabot PR, and the gate, which merges only on green CI, never
 * merges anything. The installer copies the secrets CI reads into Dependabot's
 * store, and no person handles a value: a short-lived run seals each one with
 * the store's public key, and the installer uploads only the sealed copy.
 *
 * Here the run is real in every part but the cipher. The installer creates
 * the branch through GitHub's git data API (no local push, so no local hook
 * runs). When it asks gh for the run, a stand-in gh runs the workflow the
 * installer actually created, through the actions simulator, with a stand-in
 * `nacl` whose "sealed box" records which key sealed which value. The cipher
 * itself is libsodium's.
 */

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const SIM = pathToFileURL(join(REPO, 'test/lib/actions-sim.mjs')).href;

const PUBLIC_KEY = Buffer.from('k'.repeat(32)).toString('base64');
const KEY_ID = '012345678912345678';
const ACTIONS_SECRETS = {
  OPENAI_API_KEY: 'sk-test-openai',
  FROM_REUSABLE: 'reusable-value',
  NOT_CI_SECRET: 'not-for-ci',
  ALREADY_THERE: 'actions-copy',
};

// The CI the gate keys on reads OPENAI_API_KEY itself and FROM_REUSABLE through
// a local reusable workflow. GITHUB_TOKEN is the run's own; ALREADY_THERE is in
// Dependabot's store already; NEVER_SET is set nowhere. Another workflow reads
// NOT_CI_SECRET, which CI does not need.
const CI_YML = `name: CI
on: pull_request
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
        env:
          OPENAI_API_KEY: \${{ secrets.OPENAI_API_KEY }}
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          ALREADY_THERE: \${{ secrets.ALREADY_THERE }}
          NEVER_SET: \${{ secrets.NEVER_SET }}
  more:
    uses: ./.github/workflows/reusable.yml
    secrets: inherit
`;
const REUSABLE_YML = `name: Reusable
on: workflow_call
jobs:
  x:
    runs-on: ubuntu-latest
    steps:
      - run: echo
        env:
          FROM_REUSABLE: \${{ secrets.FROM_REUSABLE }}
`;
const OTHER_YML = `name: Deploy
on: push
jobs:
  d:
    runs-on: ubuntu-latest
    steps:
      - run: echo
        env:
          NOT_CI_SECRET: \${{ secrets.NOT_CI_SECRET }}
`;

// Runs the workflow on the branch the installer created, as GitHub would run
// it on that push: ref -> commit -> tree -> blob, as the API calls stored them.
const SIMULATE_RUN = `import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseJobs, runJob } from '${SIM}';

const state = process.env.GH_STATE;
const read = (f) => JSON.parse(readFileSync(join(state, f), 'utf8'));
const branch = process.argv[2];
const commit = read('commit.' + read('ref.' + branch).sha + '.json');
const tree = read('tree.' + commit.tree + '.json');
const entry = tree.tree[0];
const wf = Buffer.from(readFileSync(join(state, 'blob.' + entry.sha), 'utf8'), 'base64').toString('utf8');
writeFileSync(process.env.SEAL_WORKFLOW_FILE, wf);
const jobs = parseJobs(wf);
const [jobName] = Object.keys(jobs);
const r = await runJob(jobs, jobName, {
  github: { event_name: 'push', ref: 'refs/heads/' + branch, repository: 'acme/widgets' },
  secrets: JSON.parse(process.env.ACTIONS_SECRETS),
  cwd: mkdtempSync(join(tmpdir(), 'ds-seal-run-')),
  env: { ...process.env, PATH: process.env.RUNNER_BIN + ':' + process.env.PATH, PYTHONPATH: process.env.STUB_NACL },
});
const log = r.steps.flatMap((s) => String(s.output).split('\\n').map((l) => jobName + '\\t' + s.name + '\\t2026-10-03T00:00:00.0000000Z ' + l));
writeFileSync(process.env.SEAL_LOG_FILE, log.join('\\n') + '\\n');
writeFileSync(process.env.SEAL_RUN_FILE, JSON.stringify([{ databaseId: 4242, status: 'completed', conclusion: r.failed ? 'failure' : 'success' }]));
`;

// gh, answering each call through its own --jq with real jq.
const FAKE_GH = `#!/bin/sh
echo "$*" >> "$GH_LOG"
flag() { want="$1"; shift; prev=''; for a in "$@"; do if [ "$prev" = "$want" ]; then printf '%s' "$a"; return; fi; prev="$a"; done; }
answer() { e=$(flag --jq "$@"); if [ -n "$e" ]; then jq -rc "$e"; else cat; fi; }
case "$1" in
  auth) echo "Token scopes: 'repo', 'workflow'"; exit 0 ;;
  repo)
    case "$*" in
      *nameWithOwner*) echo "acme/widgets" ;;
      *defaultBranchRef*) echo "main" ;;
    esac
    exit 0 ;;
  label) exit 0 ;;
  secret)
    case "$2" in
      list)
        case "$*" in
          *"--app dependabot"*) printf '%s' "$DEPENDABOT_SECRET_NAMES" ;;
          *) printf '%s' "$ACTIONS_SECRET_NAMES" ;;
        esac | jq -Rc 'split(" ") | map(select(. != "") | {name: .})' | answer "$@"
        exit 0 ;;
      set)
        name="$3"; store=actions
        case "$*" in *"--app dependabot"*) store=dependabot ;; esac
        cat > "$GH_SECRETS/$store.$name"
        exit 0 ;;
    esac
    exit 0 ;;
  run)
    case "$2" in
      list)
        b=$(flag --branch "$@")
        [ -f "$SEAL_RUN_FILE" ] || node "$SIMULATE_RUN" "$b" || exit 1
        answer "$@" < "$SEAL_RUN_FILE"
        exit 0 ;;
      view) cat "$SEAL_LOG_FILE"; exit 0 ;;
    esac
    exit 0 ;;
  api)
    case "$*" in
      # The git data API, as GitHub answers it: each object kept, a sha back.
      "api --method POST repos/acme/widgets/git/blobs "*)
        n=$(ls "$GH_STATE" | grep -c '^blob\\.' || true); sha="b$n$n$n$n"
        printf '%s' "$(printf '%s\\n' "$@" | sed -n 's/^content=//p')" > "$GH_STATE/blob.$sha"
        printf '{"sha":"%s"}' "$sha" | answer "$@"; exit 0 ;;
      "api --method POST repos/acme/widgets/git/trees "*)
        sha="t1111"; cat > "$GH_STATE/tree.$sha.json"; printf '{"sha":"%s"}' "$sha" | answer "$@"; exit 0 ;;
      "api --method POST repos/acme/widgets/git/commits "*)
        sha="c1111"; cat > "$GH_STATE/commit.$sha.json"; printf '{"sha":"%s"}' "$sha" | answer "$@"; exit 0 ;;
      "api --method POST repos/acme/widgets/git/refs "*)
        body=$(cat); ref=$(printf '%s' "$body" | jq -r '.ref | sub("^refs/heads/"; "")')
        printf '%s' "$body" > "$GH_STATE/ref.$ref"; printf '%s\\n' "$ref" >> "$GH_STATE/created-branches"
        printf '%s' "$body" | answer "$@"; exit 0 ;;
      "api --method DELETE repos/acme/widgets/git/refs/heads/"*)
        path=$(printf '%s\\n' "$@" | grep '^repos/' | head -1); rm -f "$GH_STATE/ref.\${path##*/}"; exit 0 ;;
      *dependabot/secrets/public-key*)
        printf '{"key_id":"%s","key":"%s"}' "$KEY_ID" "$PUBLIC_KEY" | answer "$@"; exit 0 ;;
      "api --method PUT repos/acme/widgets/dependabot/secrets/"*)
        path=$(printf '%s\\n' "$@" | grep '^repos/' | head -1)
        enc=$(printf '%s\\n' "$@" | sed -n 's/^encrypted_value=//p')
        kid=$(printf '%s\\n' "$@" | sed -n 's/^key_id=//p')
        printf '%s|%s' "$enc" "$kid" > "$GH_SECRETS/dependabot.\${path##*/}"
        exit 0 ;;
      "api --method DELETE repos/acme/widgets/actions/runs/"*) exit 0 ;;
      *"-X PATCH"*) exit 0 ;;
      "api user"*) echo "octomaintainer"; exit 0 ;;
      *rules/branches*) exit 0 ;;
    esac
    exit 0 ;;
esac
exit 0
`;

// A sealed box that says what it sealed: SEALED:<first 4 key bytes>:<value>.
const STUB_NACL_PUBLIC = `class PublicKey:
    def __init__(self, raw):
        assert isinstance(raw, bytes) and len(raw) == 32, 'a Curve25519 public key is 32 bytes'
        self.raw = raw

class SealedBox:
    def __init__(self, recipient):
        self.recipient = recipient

    def encrypt(self, plaintext):
        assert isinstance(plaintext, bytes)
        return b'SEALED:' + self.recipient.raw[:4] + b':' + plaintext
`;

const FAKE_CLAUDE = `#!/bin/sh
case "$1" in -p) echo OK ;; esac
exit 0
`;

function runInstaller({ args = ['--copy-ci-secrets'], dependabotNames = 'CLAUDE_CODE_OAUTH_TOKEN ALREADY_THERE' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ds-cis-'));
  const bin = join(root, 'bin');
  const runnerBin = join(root, 'runner-bin');
  const stubNacl = join(root, 'stub-python');
  const secretsDir = join(root, 'secrets');
  for (const d of [bin, runnerBin, join(stubNacl, 'nacl'), secretsDir]) mkdirSync(d, { recursive: true });
  writeFileSync(join(bin, 'gh'), FAKE_GH, { mode: 0o755 });
  writeFileSync(join(bin, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
  writeFileSync(join(root, 'simulate-run.mjs'), SIMULATE_RUN);
  // On the simulated runner, the package install succeeds and installs nothing;
  // the stand-in nacl is already on PYTHONPATH.
  writeFileSync(join(runnerBin, 'sudo'), '#!/bin/sh\n"$@"\n', { mode: 0o755 });
  writeFileSync(join(runnerBin, 'apt-get'), '#!/bin/sh\necho "apt-get $*" >> "$APT_LOG"\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(stubNacl, 'nacl', '__init__.py'), '');
  writeFileSync(join(stubNacl, 'nacl', 'public.py'), STUB_NACL_PUBLIC);

  const origin = join(root, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  const state = join(root, 'gh-state');
  mkdirSync(state);
  // A pre-push hook that refuses everything, as runsense's refuses a push with
  // no test attestation: the installer must get by without pushing.
  const hooks = join(root, 'hooks');
  mkdirSync(hooks);
  writeFileSync(join(hooks, 'pre-push'), '#!/bin/sh\necho "pre-push: refused" >&2\nexit 1\n', { mode: 0o755 });
  const repoDir = join(root, 'widgets');
  mkdirSync(join(repoDir, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(repoDir, 'package.json'), '{}\n');
  writeFileSync(join(repoDir, 'package-lock.json'), '{}\n');
  writeFileSync(join(repoDir, '.github/workflows/ci.yml'), CI_YML);
  writeFileSync(join(repoDir, '.github/workflows/reusable.yml'), REUSABLE_YML);
  writeFileSync(join(repoDir, '.github/workflows/deploy.yml'), OTHER_YML);
  const git = (...a) => execFileSync('git', a, { cwd: repoDir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-qm', 'base');
  git('remote', 'add', 'origin', origin);
  git('push', '-q', 'origin', 'main');
  git('config', 'core.hooksPath', hooks);
  const headBefore = git('rev-parse', 'HEAD');

  const files = {
    log: join(root, 'gh.log'), aptLog: join(root, 'apt.log'),
    workflow: join(root, 'seal-workflow.yml'), sealLog: join(root, 'seal-run.log'), run: join(root, 'seal-run.json'),
  };
  writeFileSync(files.log, '');
  const r = spawnSync('sh', [join(REPO, 'install.sh'), '--ci-name', 'CI', ...args], {
    cwd: repoDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      DEP_STEWARD_SRC: REPO,
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-tok-xyz',
      GH_LOG: files.log,
      GH_SECRETS: secretsDir,
      ACTIONS_SECRET_NAMES: Object.keys(ACTIONS_SECRETS).join(' ') + ' CLAUDE_CODE_OAUTH_TOKEN',
      DEPENDABOT_SECRET_NAMES: dependabotNames,
      ACTIONS_SECRETS: JSON.stringify(ACTIONS_SECRETS),
      PUBLIC_KEY, KEY_ID,
      GH_STATE: state,
      SIMULATE_RUN: join(root, 'simulate-run.mjs'),
      RUNNER_BIN: runnerBin,
      STUB_NACL: stubNacl,
      APT_LOG: files.aptLog,
      SEAL_WORKFLOW_FILE: files.workflow,
      SEAL_LOG_FILE: files.sealLog,
      SEAL_RUN_FILE: files.run,
    },
  });
  const stored = Object.fromEntries(readdirSync(secretsDir).map((f) => [f, readFileSync(join(secretsDir, f), 'utf8')]));
  const kept = (prefix) => readdirSync(state).filter((f) => f.startsWith(prefix));
  const json = (f) => JSON.parse(readFileSync(join(state, f), 'utf8'));
  const createdFile = join(state, 'created-branches');
  const created = existsSync(createdFile) ? readFileSync(createdFile, 'utf8').split('\n').filter(Boolean) : [];
  const read = (f) => (existsSync(f) ? readFileSync(f, 'utf8') : '');
  return {
    status: r.status, out: `${r.stdout}${r.stderr}`, stored, headBefore, headAfter: git('rev-parse', 'HEAD'),
    created, openRefs: kept('ref.').map((f) => f.slice(4)), trees: kept('tree.').map(json), commits: kept('commit.').map(json),
    ghLog: read(files.log), aptLog: read(files.aptLog), sealWorkflow: read(files.workflow),
  };
}

const sealedFor = (value) => `${Buffer.from(`SEALED:${'kkkk'}:${value}`).toString('base64')}|${KEY_ID}`;

const run = runInstaller();

test('copies into Dependabot\'s store exactly the secrets CI reads that it lacks', () => {
  // ...from a checkout whose pre-push hook refuses everything: it never pushes.
  assert.equal(run.status, 0, run.out);
  const copied = Object.keys(run.stored).filter((k) => k.startsWith('dependabot.') && k !== 'dependabot.CLAUDE_CODE_OAUTH_TOKEN').sort();
  assert.deepEqual(copied, ['dependabot.FROM_REUSABLE', 'dependabot.OPENAI_API_KEY'], run.out);
});

test('what it stores is each Actions value, sealed with the Dependabot store\'s own key', () => {
  assert.equal(run.stored['dependabot.OPENAI_API_KEY'], sealedFor('sk-test-openai'));
  assert.equal(run.stored['dependabot.FROM_REUSABLE'], sealedFor('reusable-value'));
});

test('a secret CI reads but that is set nowhere is reported, not stored', () => {
  assert.equal(run.stored['dependabot.NEVER_SET'], undefined);
  assert.match(run.out, /NEVER_SET/);
});

test('says what it copied and why, in the install output', () => {
  assert.match(run.out, /OPENAI_API_KEY/);
  assert.match(run.out, /Dependabot/);
});

test('the run that seals them is one workflow on a branch of its own, with no parent and nothing else in it', () => {
  // With no parent commit, none of the repository's own workflows exist on
  // that branch, so nothing else runs on the push.
  assert.equal(run.created.length, 1);
  assert.equal(run.trees.length, 1);
  assert.equal(run.trees[0].base_tree, undefined, 'a tree of its own, not one built on the repository');
  assert.equal(run.trees[0].tree.length, 1);
  assert.match(run.trees[0].tree[0].path, /^\.github\/workflows\/[^/]+\.yml$/);
  assert.deepEqual(run.commits.map((c) => c.parents), [[]]);
});

test('the sealing run holds no token permissions, checks out nothing, and installs only Ubuntu\'s signed NaCl package', () => {
  const wf = run.sealWorkflow;
  assert.match(wf, /^permissions: \{\}$/m);
  assert.doesNotMatch(wf, /actions\/checkout|uses:/);
  assert.doesNotMatch(wf, /\bpip\b|\bnpm\b|\bnpx\b|\bcurl\b|\bwget\b/);
  assert.match(run.aptLog, /install .*python3-nacl/);
  // Only the secrets being copied reach the run.
  const named = [...wf.matchAll(/secrets\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]).sort();
  assert.deepEqual(named, ['FROM_REUSABLE', 'NEVER_SET', 'OPENAI_API_KEY']);
});

test('the branch and the run are deleted afterwards, and the local checkout is untouched', () => {
  assert.deepEqual(run.openRefs, []);
  assert.match(run.ghLog, /^api --method DELETE repos\/acme\/widgets\/actions\/runs\/4242$/m);
  assert.equal(run.headAfter, run.headBefore);
});

test('without consent nothing is copied, and the output says how to give it', () => {
  const r = runInstaller({ args: [] });
  assert.equal(r.status, 0, r.out);
  assert.equal(r.stored['dependabot.OPENAI_API_KEY'], undefined);
  assert.deepEqual(r.created, [], 'no branch is created without consent');
  assert.match(r.out, /--copy-ci-secrets/);
});

test('nothing to copy when Dependabot\'s store already has every secret CI reads', () => {
  const r = runInstaller({ dependabotNames: 'CLAUDE_CODE_OAUTH_TOKEN ALREADY_THERE OPENAI_API_KEY FROM_REUSABLE NEVER_SET' });
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.created, []);
  assert.doesNotMatch(r.ghLog, /dependabot\/secrets\/public-key/);
});

test('--dry-run names what it would copy and pushes nothing', () => {
  const r = runInstaller({ args: ['--copy-ci-secrets', '--dry-run'] });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /OPENAI_API_KEY/);
  assert.deepEqual(r.created, []);
  assert.deepEqual(Object.keys(r.stored), []);
});
