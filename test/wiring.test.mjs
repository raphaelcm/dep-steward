import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Installer wiring — covers the cold-start GitHub side that the render tests
 * don't: with a stubbed `gh` on PATH (and real git), a full install must set
 * the CLAUDE_CODE_OAUTH_TOKEN secret in BOTH the Actions store AND the
 * Dependabot store (the marquee gotcha), create the needs-human-review label,
 * and enable auto-merge. We assert the exact `gh` command sequence the
 * installer emits, not GitHub's real response.
 */

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

const FAKE_GH = `#!/bin/sh
echo "$*" >> "$GH_LOG"
cmd="$1"; sub="\${2:-}"
case "$cmd" in
  auth) echo "Token scopes: 'repo', 'workflow'"; exit 0 ;;
  repo)
    case "$*" in
      *nameWithOwner*) echo "acme/widgets" ;;
      *defaultBranchRef*) echo "main" ;;
    esac
    exit 0 ;;
  label)
    case "$sub" in
      list) exit 0 ;;
      create) exit 0 ;;
    esac ;;
  secret)
    # Record the VALUE each store would hold, not just the command line: the
    # command can look right while storing the wrong thing. Mirrors gh: a
    # non-empty --body is stored verbatim; without --body, stdin is read and
    # its trailing newlines are dropped (cli/cli pkg/cmd/secret/set getBody).
    if [ "$sub" = set ]; then
      name="$3"; store=actions; has_body=''; body=''
      shift 3
      while [ $# -gt 0 ]; do
        case "$1" in
          --app) store="$2"; shift ;;
          --body) has_body=1; body="$2"; shift ;;
        esac
        shift
      done
      if [ -n "$has_body" ]; then value="$body"; else value=$(cat); fi
      printf '%s' "$value" > "$GH_SECRETS/$store.$name"
      exit 0
    fi
    if [ "$sub" = list ]; then printf '%s' "\${GH_SECRET_NAMES:-}"; exit 0; fi
    exit 0 ;;
  api)
    case "$*" in
      *"-X PATCH"*) exit 0 ;;
      # 'gh api user --jq .login' → the default escalation assignee.
      "api user"*) echo "octomaintainer"; exit 0 ;;
      # The installer runs 'gh api .../rules/branches/<b> --jq <expr>'. The stub
      # ignores --jq, so it emits the POST-jq value directly: the comma-joined
      # required-check contexts (GH_REQUIRED_CONTEXTS), empty by default.
      *rules/branches*) printf '%s' "\${GH_REQUIRED_CONTEXTS:-}"; exit 0 ;;
    esac
    exit 0 ;;
esac
exit 0
`;

// Stub for `claude`. The installer now VERIFIES the token with `claude -p` before
// storing it, so the harness must supply a deterministic, offline claude (a real
// one would make a network call with a fake token). Emits "OK" (authenticates) by
// default, or the 401 signature when CLAUDE_STUB_FAIL is set — so we can test that
// a bad token is rejected, not stored.
const FAKE_CLAUDE = `#!/bin/sh
case "$1" in
  -p)
    if [ -n "\${CLAUDE_STUB_FAIL:-}" ]; then
      echo 'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid bearer token"}}'
    else
      echo 'OK'
    fi
    exit 0 ;;
esac
exit 0
`;

function runInstaller(extraEnv = {}, { args = [], setup = () => {} } = {}) {
  const bin = mkdtempSync(join(tmpdir(), 'ds-bin-'));
  const ghLog = join(bin, 'gh.log');
  const secretsDir = join(bin, 'secrets');
  mkdirSync(secretsDir);
  writeFileSync(join(bin, 'gh'), FAKE_GH);
  chmodSync(join(bin, 'gh'), 0o755);
  writeFileSync(join(bin, 'claude'), FAKE_CLAUDE);
  chmodSync(join(bin, 'claude'), 0o755);

  const repoDir = mkdtempSync(join(tmpdir(), 'ds-target-'));
  writeFileSync(join(repoDir, 'package.json'), '{}\n');
  writeFileSync(join(repoDir, 'package-lock.json'), '{}\n');
  execFileSync('git', ['init', '-q'], { cwd: repoDir });
  setup(repoDir);

  const stdout = execFileSync('sh', [join(REPO, 'install.sh'), '--ci-name', 'CI', ...args], {
    cwd: repoDir,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GH_LOG: ghLog,
      GH_SECRETS: secretsDir,
      DEP_STEWARD_SRC: REPO,
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-tok-xyz',
      ...extraEnv,
    },
    encoding: 'utf8',
    stdio: 'pipe',
  });

  // `<store>.<NAME>` -> the value that store would hold.
  const stored = Object.fromEntries(
    readdirSync(secretsDir).map((f) => [f, readFileSync(join(secretsDir, f), 'utf8')]),
  );
  return { log: readFileSync(ghLog, 'utf8'), repoDir, stdout, stored };
}

const { log, repoDir, stored } = runInstaller();
const lines = log.split('\n');

test('sets the secret in the Actions store (no --app)', () => {
  assert.ok(
    lines.some((l) => l === 'secret set CLAUDE_CODE_OAUTH_TOKEN --repo acme/widgets'),
    `Actions-store secret set not found. gh log:\n${log}`,
  );
});

test('both stores hold the token itself, the one the installer just verified', () => {
  // The command line proves only which store was addressed. What the review
  // and fixer jobs authenticate with is the stored value, and gh stores a
  // non-empty `--body` VERBATIM: `--body -` stored the one-character string
  // "-" in both stores, while the token verified a few lines earlier was
  // piped to a gh that never read it. Every review then 401s, the assertion
  // step says to re-mint and re-run the installer, and the re-run stores "-"
  // again.
  assert.deepEqual(
    { actions: stored['actions.CLAUDE_CODE_OAUTH_TOKEN'], dependabot: stored['dependabot.CLAUDE_CODE_OAUTH_TOKEN'] },
    { actions: 'oauth-tok-xyz', dependabot: 'oauth-tok-xyz' },
  );
});

test('sets the secret in the Dependabot store (--app dependabot) — the marquee gotcha', () => {
  assert.ok(
    lines.some((l) => /^secret set CLAUDE_CODE_OAUTH_TOKEN .*--app dependabot/.test(l)),
    `Dependabot-store secret set not found. gh log:\n${log}`,
  );
});

test('creates the needs-human-review label', () => {
  assert.ok(
    lines.some((l) => /^label create needs-human-review/.test(l)),
    `label create not found. gh log:\n${log}`,
  );
});

test('enables auto-merge on the repo', () => {
  assert.ok(
    lines.some((l) => l === 'api -X PATCH repos/acme/widgets -F allow_auto_merge=true'),
    `allow_auto_merge PATCH not found. gh log:\n${log}`,
  );
});

test('writes the automation files into the target repo (repo scope only — no personal-config writes)', () => {
  for (const f of [
    '.github/dependabot.yml',
    '.github/dependabot-review-prompt.md',
    '.github/workflows/dependabot-review.yml',
    '.github/dependabot-automerge/gate.cjs',
    '.github/dependabot-automerge/review-lint.cjs',
  ]) {
    assert.ok(existsSync(join(repoDir, f)), `expected ${f} to be written`);
  }
  // The installer must NOT create a per-repo copy of the summary command — it is
  // a personal, install-once tool, not a repo artifact.
  assert.ok(!existsSync(join(repoDir, '.claude/commands/dep-steward-summary.md')),
    'installer should not write the summary command into the repo');
});

test('wires the default escalation assignee (from gh api user) into the escalate path', () => {
  const prompt = readFileSync(join(repoDir, '.github/dependabot-review-prompt.md'), 'utf8');
  const wf = readFileSync(join(repoDir, '.github/workflows/dependabot-review.yml'), 'utf8');
  assert.match(prompt, /--add-assignee octomaintainer/);
  assert.match(wf, /--add-label needs-human-review --add-assignee octomaintainer/);
});

test('reports required status checks from the effective-rules endpoint (regression: ruleset blind spot)', () => {
  // A ruleset that requires the "CI" context. The old code queried only the
  // classic /protection endpoint, which 404s on ruleset repos, so it would have
  // false-warned "CI is not required". The rules-aware check must report it.
  const { stdout } = runInstaller({ GH_REQUIRED_CONTEXTS: 'CI' });
  assert.match(stdout, /Required status checks on 'main': CI/);
  assert.doesNotMatch(stdout, /No status checks are required/);
});

test('a token that fails verification is never stored (no opaque bad-token installs)', () => {
  // With the `claude` probe returning 401, the env-provided token is invalid.
  // Non-interactively the installer must store NOTHING rather than poison both
  // secret stores with a token that fails three steps later, opaquely, in CI.
  const { log: badLog } = runInstaller({ CLAUDE_STUB_FAIL: '1' });
  assert.doesNotMatch(badLog, /secret set CLAUDE_CODE_OAUTH_TOKEN/,
    `a token rejected by the probe must not be written to either store. gh log:\n${badLog}`);
  // Contrast: the default run (probe returns OK) DOES set it in both stores —
  // proven by the 'sets the secret ...' tests above, which share this harness.
});

// ---- the claude-code-action pin survives a real reinstall --------------------
//
// action-pin.test.mjs covers the choice itself through --render-only. These two
// cover the other entry points: a full install resolves after `cd` to the repo
// root, and --dry-run must say what it would do.

const TEMPLATE_PIN = '1623c36729ac1cd5895198cded705a287de7db79 # v1.0.187';
const RUNSENSE_PIN = '4036a180cf690f49529f5d8c79c998855287f590 # v1.0.230';
const seedWorkflowAt = (pin) => (repoDir) => {
  const golden = readFileSync(join(REPO, 'test/fixtures/expected/reference/.github/workflows/dependabot-review.yml'), 'utf8');
  mkdirSync(join(repoDir, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(repoDir, '.github/workflows/dependabot-review.yml'), golden.split(TEMPLATE_PIN).join(pin));
};
const pinsIn = (workflow) => [...workflow.matchAll(/^\s*uses: anthropics\/claude-code-action@(.+)$/gm)].map((m) => m[1].trim());

test('a full reinstall keeps the repo\'s newer claude-code-action pin, and says so', () => {
  const { repoDir: dir, stdout } = runInstaller({}, { setup: seedWorkflowAt(RUNSENSE_PIN) });
  const written = readFileSync(join(dir, '.github/workflows/dependabot-review.yml'), 'utf8');
  assert.deepEqual(pinsIn(written), [RUNSENSE_PIN, RUNSENSE_PIN]);
  assert.match(stdout, /claude-code-action \(review job\): keeping v1\.0\.230 from the existing workflow \(template has v1\.0\.187\)/);
});

test('--dry-run reports the pin it would keep, and writes nothing', () => {
  const { repoDir: dir, stdout } = runInstaller({}, { args: ['--dry-run'], setup: seedWorkflowAt(RUNSENSE_PIN) });
  assert.match(stdout, /claude-code-action \(review job\): keeping v1\.0\.230 from the existing workflow/);
  assert.match(stdout, /\[dry-run\] no changes made\./);
  const onDisk = readFileSync(join(dir, '.github/workflows/dependabot-review.yml'), 'utf8');
  assert.deepEqual(pinsIn(onDisk), [RUNSENSE_PIN, RUNSENSE_PIN], 'a dry run must not touch the file');
});
