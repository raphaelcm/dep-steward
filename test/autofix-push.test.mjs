import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJobs, conditionHolds, runJob } from './lib/actions-sim.mjs';
import { startGitServer, tokenOf, basicFor } from './lib/git-http-server.mjs';

/**
 * Who pushes the autofix commit decides whether CI ever runs on it.
 *
 * GitHub starts no workflow for a push made with GITHUB_TOKEN. The autofix job
 * pushed that way, so its fix sat with no CI run, no re-review and no merge-gate
 * wake-up until a person pushed to the branch: Runsense-ai/runsense#2693, fix
 * commit 9d4c6668, zero check runs for nine days. A push made with a GitHub App
 * installation token does start workflows, so the job now pushes as
 * dep-steward's App when the repo has one.
 *
 * That GitHub rule was also the only brake on fix -> CI red -> autofix -> fix.
 * An App push releases it, so the job now makes ONE push per PR.
 *
 * Everything here RUNS the rendered autofix job (test/lib/actions-sim.mjs:
 * every `if:`, every output, every `run:` block through bash as GitHub runs
 * it). The pushes go through real `git` to a real `git http-backend` behind a
 * local server that records each request's Authorization, which is the thing
 * GitHub attributes a push to. The working tree carries GITHUB_TOKEN exactly
 * where the real job leaves it, twice:
 *   - actions/checkout v7 keeps its header in an included file under
 *     RUNNER_TEMP (which claude-code-action v1.0.187 does not remove), and
 *   - claude-code-action rewrites `origin` to embed the job's github_token
 *     (src/github/operations/git-config.ts).
 * So "the App pushed" is observed at the remote, not inferred from argv.
 * Only the agent itself is simulated: it writes the files a test names.
 */

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const REFERENCE_MANIFESTS = ['package.json', 'package-lock.json', 'requirements.txt', 'Cargo.toml', 'go.mod', 'Dockerfile'];

function render() {
  const fakeRepo = mkdtempSync(join(tmpdir(), 'ds-ap-repo-'));
  for (const m of REFERENCE_MANIFESTS) writeFileSync(join(fakeRepo, m), '\n');
  const out = mkdtempSync(join(tmpdir(), 'ds-ap-out-'));
  execFileSync(
    'sh',
    [join(REPO, 'install.sh'), '--render-only', '--out', out, '--ci-name', 'CI', '--assignee', 'octocat'],
    { cwd: fakeRepo, env: { ...process.env, DEP_STEWARD_SRC: REPO }, stdio: 'pipe' },
  );
  return out;
}

const RENDERED = render();
const JOBS = parseJobs(readFileSync(join(RENDERED, '.github/workflows/dependabot-review.yml'), 'utf8'));

const HEAD_BRANCH = 'dependabot/npm_and_yarn/ioredis-6.0.0';
const WORKFLOW_TOKEN = 'ghs_workflowTokenOfThisRun0000001';
const APP_TOKEN = 'ghs_appInstallationTokenOfThisRun02';
const APP_CLIENT_ID = 'Iv23liDepStewardTest';
const APP_PRIVATE_KEY = '-----BEGIN RSA PRIVATE KEY-----\nMIIEdepStewardTestKeyNotARealKey\n-----END RSA PRIVATE KEY-----';

// The comment a person gets when CI cannot start on its own. With no App it
// must stay byte-identical to the text installs already post. The reason is
// what autofix-bounds.cjs says about a one-file, two-line fix.
const REASON = 'source-only fix, 1 file(s), 2 line(s) within the 10-line budget';
const CLOSE_AND_REOPEN = `dep-steward autofix pushed a mechanical fix for this bump (${REASON}). GitHub doesn't run CI on a workflow-pushed commit, so to check the fix: **close and reopen this PR** (or push any commit to its branch). When CI is green, review and merge.`;

// Commit shapes exactly as `gh pr view --json commits` returned them for
// Runsense-ai/runsense#2693 (branch name aside).
const DEPENDABOT_COMMIT = {
  oid: '81252f2277a6cc1ca2d8e12d6b0e2e5f7c9d3a10',
  messageHeadline: 'build(deps): bump ioredis from 5.4.1 to 6.0.0',
  authors: [{ email: '49699333+dependabot[bot]@users.noreply.github.com', id: 'MDM6Qm90NDk2OTkzMzM=', login: 'dependabot[bot]', name: 'dependabot[bot]' }],
};
const AUTOFIX_COMMIT = {
  oid: '9d4c6668ba09d175b6e5e9be2ed83b365116de8a',
  messageHeadline: `fix(deps): mechanical fix for the ${HEAD_BRANCH} bump [dep-steward autofix]`,
  authors: [{ email: 'dep-steward@users.noreply.github.com', id: '', login: '', name: 'dep-steward[bot]' }],
};
const PERSON_MERGE_COMMIT = {
  oid: 'a7525ef36b0e5eee9700f45013cc10794a2d0a0a',
  messageHeadline: `Merge origin/main into ${HEAD_BRANCH}`,
  authors: [{ email: 'noreply@anthropic.com', id: 'MDQ6VXNlcjgxODQ3', login: 'claude', name: 'Claude' }],
};

// Answers every gh call the autofix job makes, from canned documents run
// through the step's own `--jq` with real jq (so the filter under test is the
// one that ships). An unexpected call fails loudly instead of succeeding.
const GH_STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GH_LOG"
flag() { local want="$1" prev='' a; shift; for a in "$@"; do if [ "$prev" = "$want" ]; then printf '%s' "$a"; return; fi; prev="$a"; done; }
case "$1 $2" in
  "pr list") doc='[{"number":1}]' ;;
  "pr view")
    case "$(flag --json "$@")" in
      author) doc='{"author":{"login":"app/dependabot"}}' ;;
      commits)
        [ "$PR_COMMITS_JSON" = unreadable ] && { echo "HTTP 502: Bad Gateway (https://api.github.com/graphql)" >&2; exit 1; }
        doc="$PR_COMMITS_JSON" ;;
      labels) doc="$PR_LABELS_JSON" ;;
      *) echo "gh stub: no canned answer for: $*" >&2; exit 1 ;;
    esac ;;
  "pr diff") printf '%s\\n' "$BUMP_PATHS"; exit 0 ;;
  "pr comment")
    n=$(ls "$GH_COMMENTS" | wc -l | tr -d ' ')
    flag --body "$@" > "$GH_COMMENTS/$n.md"
    exit 0 ;;
  "pr edit") exit 0 ;;
  *) echo "gh stub: unexpected call: $*" >&2; exit 1 ;;
esac
expr=$(flag --jq "$@")
if [ -n "$expr" ]; then printf '%s' "$doc" | jq -r "$expr"; else printf '%s\\n' "$doc"; fi
`;

// Keep the developer's own git config (credential helpers, above all) out of it.
const GIT_ISOLATION = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never',
};

const git = (args, cwd) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, ...GIT_ISOLATION } });

const IN_BOUNDS_FIX = { 'src/client.ts': 'export const timeout = 2000;\n' };

/**
 * Run the rendered autofix job once, as GitHub would after CI failed on
 * Dependabot's PR.
 *   edits    files the agent writes (path -> content)
 *   commits  the PR's commits as gh reports them
 *   labels   the PR's labels
 *   app      whether dep-steward's App secrets are set
 *   mint     'ok' or 'fails' (create-github-app-token's outcome)
 *   refuse   credentials the remote refuses, with `refuseWith` (403 or 401)
 *   helper   leave a credential helper in the tree, as claude-code-action's
 *            allowed_non_write_users mode does, instead of a token in origin
 */
async function runAutofix({ edits = IN_BOUNDS_FIX, commits = [DEPENDABOT_COMMIT], labels = [], app = false, mint = 'ok', refuse = [], refuseWith = 403, helper = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ds-autofix-'));
  const srv = join(root, 'srv');
  const bare = join(srv, 'octocat', 'repo.git');
  const work = join(root, 'work');
  const bin = join(root, 'bin');
  const runnerTemp = join(root, 'runner-temp');
  const commentsDir = join(root, 'comments');
  for (const d of [srv, work, bin, runnerTemp, commentsDir, join(work, 'src'), join(work, '.github/dependabot-automerge')]) {
    mkdirSync(d, { recursive: true });
  }

  // The PR head as the fixer finds it: the bump plus the pipeline's own files,
  // committed (uncommitted, `git add -A` would stage them as additions).
  writeFileSync(join(work, 'src/client.ts'), 'export const timeout = 1000;\n');
  writeFileSync(join(work, 'package.json'), '{"name":"app","dependencies":{"ioredis":"^6.0.0"}}\n');
  for (const f of ['.github/dependabot-automerge/autofix-bounds.cjs', '.github/dependabot-autofix-prompt.md']) {
    writeFileSync(join(work, f), readFileSync(join(RENDERED, f), 'utf8'));
  }
  git(['init', '-q', '-b', 'main', work]);
  git(['config', 'user.email', 'test@example.invalid'], work);
  git(['config', 'user.name', 'test'], work);
  git(['add', '-A'], work);
  git(['commit', '-q', '-m', 'bump ioredis 5 -> 6'], work);
  const baseSha = git(['rev-parse', 'HEAD'], work).trim();
  git(['init', '-q', '--bare', bare]);
  git(['push', '-q', bare, `HEAD:refs/heads/${HEAD_BRANCH}`], work);

  const server = await startGitServer(srv, { refuse, refuseWith });
  try {
    // What actions/checkout v7 leaves behind: an origin with no credential in
    // it, and GITHUB_TOKEN as an extraheader in a RUNNER_TEMP file the repo's
    // config includes.
    git(['remote', 'add', 'origin', `${server.url}/octocat/repo.git`], work);
    const creds = join(runnerTemp, 'git-credentials-0b1f.config');
    git(['config', '--file', creds, `http.${server.url}/.extraheader`, `AUTHORIZATION: ${basicFor(WORKFLOW_TOKEN)}`]);
    git(['config', '--local', `includeIf.gitdir:${realpathSync(work)}/.git.path`, creds], work);
    assert.equal(
      git(['config', '--get-all', `http.${server.url}/.extraheader`], work).trim(),
      `AUTHORIZATION: ${basicFor(WORKFLOW_TOKEN)}`,
      'harness: the checkout credential must be live in the working tree, or the identity tests are vacuous',
    );

    const calls = { fixer: [], mint: [] };
    const uses = {
      // The tree above already is the checkout.
      'actions/checkout': async () => ({ exitCode: 0 }),
      'anthropics/claude-code-action': async ({ with: w }) => {
        calls.fixer.push({ ...w });
        // Agent mode, before the agent runs (git-config.ts): its commit
        // identity, and origin rewritten to carry the job's github_token.
        git(['config', 'user.name', 'claude[bot]'], work);
        git(['config', 'user.email', '41898282+claude[bot]@users.noreply.github.com'], work);
        if (helper) {
          // Its other layout: a helper that answers any 401 with $GH_TOKEN,
          // which every later step of this job sets to GITHUB_TOKEN.
          const script = join(runnerTemp, 'git-credential-gh-token');
          writeFileSync(script, '#!/bin/sh\necho username=x-access-token\necho password="$GH_TOKEN"\n', { mode: 0o700 });
          git(['config', 'credential.helper', script], work);
        } else {
          git(['remote', 'set-url', 'origin', `${server.url.replace('http://', `http://x-access-token:${w.github_token}@`)}/octocat/repo.git`], work);
        }
        // Then what the agent wrote.
        for (const [path, content] of Object.entries(edits)) {
          mkdirSync(dirname(join(work, path)), { recursive: true });
          writeFileSync(join(work, path), content);
        }
        return { exitCode: 0, outputs: { execution_file: '' } };
      },
      'actions/create-github-app-token': async ({ with: w }) => {
        calls.mint.push({ ...w });
        // The real action throws on an empty client-id or private-key.
        if (!w['client-id'] || !w['private-key'] || mint === 'fails') {
          return { exitCode: 1, output: '::error::the App token could not be minted' };
        }
        return { exitCode: 0, outputs: { token: APP_TOKEN, 'app-slug': 'dep-steward-test', 'installation-id': '42' } };
      },
    };

    writeFileSync(join(bin, 'gh'), GH_STUB, { mode: 0o755 });
    const ghLog = join(bin, 'gh.log');
    writeFileSync(ghLog, '');

    const result = await runJob(JOBS, 'autofix', {
      github: {
        event_name: 'workflow_run',
        repository: 'octocat/repo',
        event: {
          workflow_run: {
            event: 'pull_request',
            conclusion: 'failure',
            head_branch: HEAD_BRANCH,
            run_started_at: '2026-09-21T04:41:00Z',
            created_at: '2026-09-21T04:40:12Z',
            actor: { login: 'dependabot[bot]', type: 'Bot' },
          },
          repository: { default_branch: 'main' },
        },
      },
      secrets: {
        GITHUB_TOKEN: WORKFLOW_TOKEN,
        CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-test',
        DEP_STEWARD_APP_CLIENT_ID: app ? APP_CLIENT_ID : '',
        DEP_STEWARD_APP_PRIVATE_KEY: app ? APP_PRIVATE_KEY : '',
      },
      uses,
      cwd: work,
      env: {
        ...process.env,
        ...GIT_ISOLATION,
        PATH: `${bin}:${process.env.PATH}`,
        GH_LOG: ghLog,
        GH_COMMENTS: commentsDir,
        PR_COMMITS_JSON: commits === 'unreadable' ? 'unreadable' : JSON.stringify({ commits }),
        PR_LABELS_JSON: JSON.stringify({ labels: labels.map((name) => ({ name })) }),
        BUMP_PATHS: 'package.json',
        RUNNER_TEMP: runnerTemp,
        GITHUB_SERVER_URL: server.url,
      },
    });

    const head = git(['--git-dir', bare, 'rev-parse', HEAD_BRANCH]).trim();
    const pushed = head !== baseSha;
    return {
      result,
      failed: result.failed,
      calls,
      seen: server.seen,
      // The credential on each receive-pack POST the remote accepted: the
      // identity GitHub would attribute the push to.
      pushedAs: server.seen
        .filter((r) => r.method === 'POST' && r.url.endsWith('/git-receive-pack') && r.status === 200)
        .map((r) => tokenOf(r.auth)),
      pushed,
      pushedFiles: pushed
        ? git(['--git-dir', bare, 'show', '--name-only', '--format=', HEAD_BRANCH]).split('\n').filter(Boolean)
        : [],
      pushedAuthor: pushed ? git(['--git-dir', bare, 'log', '-1', '--format=%an <%ae>', HEAD_BRANCH]).trim() : null,
      comments: readdirSync(commentsDir).sort().map((f) => readFileSync(join(commentsDir, f), 'utf8')),
      ghCalls: readFileSync(ghLog, 'utf8').split('\n').filter(Boolean),
      log: result.steps.map((s) => `--- ${s.name} [${s.status}]\n${s.output}`).join('\n'),
    };
  } finally {
    await server.close();
  }
}

// The plain App-configured, in-bounds run: several tests read it, none
// changes it, so it runs once.
let appConfigured;
const appConfiguredRun = () => (appConfigured ??= runAutofix({ app: true }));

const labelledAndAssigned = (ghCalls) =>
  ghCalls.some((c) => /^pr edit 1 --repo octocat\/repo --add-label needs-human-review --add-assignee octocat$/.test(c));

// ---- who pushes -----------------------------------------------------------

test('with the App configured, the fix reaches the PR branch as the App, not as GITHUB_TOKEN', async () => {
  // The whole point. GitHub starts CI for a push by the App's installation
  // token and not for one by GITHUB_TOKEN, and the working tree still holds
  // GITHUB_TOKEN twice (checkout's header, the fixer's origin URL). Either one
  // winning is the #2693 defect again, silently.
  const r = await appConfiguredRun();
  assert.equal(r.failed, false, r.log);
  assert.equal(r.calls.fixer.length, 1, 'a PR with only Dependabot\'s commits gets its one attempt');
  assert.deepEqual(r.pushedAs, [APP_TOKEN], `the remote must see the App token on the push:\n${r.log}`);
  assert.deepEqual(r.pushedFiles, ['src/client.ts']);
  assert.equal(r.pushedAuthor, 'dep-steward[bot] <dep-steward@users.noreply.github.com>');
  assert.equal(r.comments.length, 1);
  assert.match(r.comments[0], /CI is now running on the fix/);
});

test('the close-and-reopen comment is posted exactly when no App is configured', async () => {
  // Without the App nothing may change for an existing install: GITHUB_TOKEN
  // pushes, and the person is told how to start CI, in the words installs
  // already post. With the App that instruction is false (CI starts on its
  // own) and must not appear.
  const without = await runAutofix({ app: false });
  assert.equal(without.failed, false, without.log);
  assert.deepEqual(without.pushedAs, [WORKFLOW_TOKEN]);
  assert.deepEqual(without.comments, [CLOSE_AND_REOPEN]);
  assert.equal(without.calls.mint.length, 0, 'no App, no token');

  const withApp = await appConfiguredRun();
  assert.ok(
    !withApp.comments.some((c) => c.includes('close and reopen')),
    `an App push must not tell anyone to start CI by hand:\n${withApp.comments.join('\n---\n')}`,
  );
});

test('an App that cannot mint a token still lands the fix, and says the App is at fault', async () => {
  // A broken App must neither strand a fix the bounds accepted nor pass for a
  // working one. The fix goes out the old way, the person gets the old
  // instruction plus the reason, and the job is red: dep-steward's own setup
  // failed.
  const r = await runAutofix({ app: true, mint: 'fails' });
  assert.deepEqual(r.pushedAs, [WORKFLOW_TOKEN], `the fix must not be lost to a broken App:\n${r.log}`);
  assert.equal(r.failed, true, 'a configured App that cannot push is a malfunction and must look like one');
  assert.equal(r.comments.length, 1);
  assert.ok(r.comments[0].startsWith(CLOSE_AND_REOPEN), r.comments[0]);
  assert.match(r.comments[0], /GitHub App/);
});

test('a refused App push falls back to GITHUB_TOKEN, and goes red', async () => {
  // The token minted, but the push was refused (an App without Contents:
  // write, a branch rule that exempts only github-actions). Same outcome as a
  // failed mint: deliver the fix, name the App, go red.
  const r = await runAutofix({ app: true, refuse: [basicFor(APP_TOKEN)] });
  const refused = r.seen.filter((s) => s.status === 403).map((s) => tokenOf(s.auth));
  assert.ok(refused.includes(APP_TOKEN), `the App push must be tried first:\n${r.log}`);
  assert.deepEqual(r.pushedAs, [WORKFLOW_TOKEN]);
  assert.equal(r.failed, true);
  assert.match(r.comments.join('\n'), /GitHub App/);
});

test('a credential helper in the tree cannot turn a rejected App token into a GITHUB_TOKEN push that claims to be the App', async () => {
  // GitHub answers an expired or revoked token with 401, and git answers a
  // 401 by asking its credential helpers for another. If the one
  // claude-code-action leaves could answer, the push would succeed as
  // GITHUB_TOKEN while the step reported the App: "CI is now running" on a
  // commit where CI never starts.
  const r = await runAutofix({ app: true, helper: true, refuse: [basicFor(APP_TOKEN)], refuseWith: 401 });
  assert.equal(r.failed, true, r.log);
  assert.deepEqual(r.pushedAs, [WORKFLOW_TOKEN], 'the fallback push is the explicit one');
  assert.doesNotMatch(r.comments.join('\n'), /CI is now running/);
  assert.match(r.comments.join('\n'), /GitHub App/);
});

test('when every push is refused, nothing lands and a person is told once', async () => {
  // A fix the bounds accepted and nobody could push used to end as a red step
  // nobody watches, with the fixer's own comment claiming a fix.
  const r = await runAutofix({ app: true, refuse: [basicFor(APP_TOKEN), basicFor(WORKFLOW_TOKEN)] });
  assert.equal(r.pushed, false);
  assert.equal(r.failed, true);
  assert.equal(r.comments.length, 1, r.log);
  assert.match(r.comments[0], /could not push/i);
  assert.ok(labelledAndAssigned(r.ghCalls), `the escalation must label and assign:\n${r.ghCalls.join('\n')}`);
});

// ---- when a token exists at all --------------------------------------------

test('the push token is minted exactly when a fix will be pushed, and only for contents: write', async () => {
  const inBounds = await appConfiguredRun();
  assert.deepEqual(
    inBounds.calls.mint,
    [{ 'client-id': APP_CLIENT_ID, 'private-key': APP_PRIVATE_KEY, 'permission-contents': 'write' }],
    'one token, for this repository (no owner/repositories), able to push and nothing else',
  );
  for (const [what, scenario] of [
    ['a fix outside the bounds', { app: true, edits: { '.github/dependabot-autofix-prompt.md': 'rewritten\n' } }],
    ['a fixer that made no edits', { app: true, edits: {} }],
    ['a repo with no App', { app: false }],
  ]) {
    const r = await runAutofix(scenario);
    assert.equal(r.calls.mint.length, 0, `no token may exist for ${what}`);
    if (what !== 'a repo with no App') assert.equal(r.pushed, false, `${what} is never pushed`);
  }
});

test('the App\'s key and token reach only the steps that use them', async () => {
  // The fixer reads attacker-influenced text with an allow-listed toolset;
  // nothing it can see may carry a credential that starts workflows.
  const r = await appConfiguredRun();
  // Raw values, not JSON: the key's newlines would be escaped in JSON text.
  const carries = (map, secret) => Object.values(map ?? {}).some((v) => String(v).includes(secret));
  const holders = (secret) => r.result.steps.filter((s) => carries(s.env, secret) || carries(s.with, secret));
  const keyHolders = holders(APP_PRIVATE_KEY);
  assert.deepEqual(keyHolders.map((s) => s.uses?.split('@')[0]), ['actions/create-github-app-token'], 'only the mint sees the key');
  const tokenHolders = holders(APP_TOKEN);
  assert.equal(tokenHolders.length, 1, `exactly one step receives the token: ${tokenHolders.map((s) => s.name).join(', ')}`);
  assert.equal(tokenHolders[0].uses, null, 'the push is a run step');
  const fixerIndex = r.result.steps.findIndex((s) => s.uses?.startsWith('anthropics/claude-code-action'));
  assert.ok(r.result.steps.indexOf(tokenHolders[0]) > fixerIndex, 'and it runs after the fixer, never before');
  for (const secret of [APP_PRIVATE_KEY, APP_TOKEN]) {
    assert.ok(!carries(r.result.jobEnv, secret), 'no credential in the job-level env, which every step inherits');
  }
});

// ---- one push per PR ---------------------------------------------------------

test('a PR that already carries a dep-steward fix gets no second attempt, and a person is told once', async () => {
  // With the App, a fix that CI rejects would start another autofix run, and
  // another fix, and another. The job must stop before the fixer even runs.
  const r = await runAutofix({ app: true, commits: [DEPENDABOT_COMMIT, AUTOFIX_COMMIT] });
  assert.equal(r.calls.fixer.length, 0, `the fixer must not run a second time:\n${r.log}`);
  assert.equal(r.calls.mint.length, 0);
  assert.equal(r.pushed, false);
  assert.equal(r.failed, false, 'refusing is the guard working, not a malfunction');
  assert.equal(r.comments.length, 1);
  assert.match(r.comments[0], /already pushed a fix to this PR \(9d4c666\)/);
  assert.ok(labelledAndAssigned(r.ghCalls), r.ghCalls.join('\n'));
});

test('a person\'s commit on top of the fix does not buy a second attempt', async () => {
  // #2693's shape: a person merged main into the branch after the fix. The
  // head is no longer the fix, and a head-only check would try again.
  const r = await runAutofix({ app: true, commits: [DEPENDABOT_COMMIT, AUTOFIX_COMMIT, PERSON_MERGE_COMMIT] });
  assert.equal(r.calls.fixer.length, 0, r.log);
  assert.equal(r.pushed, false);
});

test('when the PR\'s commits cannot be read, the job attempts nothing and tells a person', async () => {
  // The guard cannot prove this is the first attempt, so it must not let the
  // fixer run; and since autofix owns a red build, staying silent would strand
  // the PR with nobody told.
  const r = await runAutofix({ app: true, commits: 'unreadable' });
  assert.equal(r.calls.fixer.length, 0, r.log);
  assert.equal(r.pushed, false);
  assert.equal(r.failed, true, 'dep-steward could not do its job, and must look like it');
  assert.equal(r.comments.length, 1);
  assert.match(r.comments[0], /could not read this PR's commits/);
  assert.ok(labelledAndAssigned(r.ghCalls), r.ghCalls.join('\n'));
});

test('a PR already waiting for a person is refused quietly', async () => {
  // The job wakes on every failing CI run; the notice is posted once.
  const r = await runAutofix({ app: true, commits: [DEPENDABOT_COMMIT, AUTOFIX_COMMIT], labels: ['needs-human-review'] });
  assert.equal(r.calls.fixer.length, 0, r.log);
  assert.equal(r.comments.length, 0);
  assert.ok(!r.ghCalls.some((c) => c.startsWith('pr edit')), r.ghCalls.join('\n'));
});

// ---- the bounds decide what is pushed ---------------------------------------
//
// autofix-bounds.cjs refuses any file status but M. The agent's comment draft
// used to be such a file (it invented `.autofix-comment.md` on two PRs), so a
// real fix was discarded beside it three times in one weekly batch. The draft
// now has one prescribed path the bounds step removes before staging.

test('bounds: the prescribed draft is discarded, and the real fix is pushed without it', async () => {
  const r = await runAutofix({
    edits: { ...IN_BOUNDS_FIX, '.dep-steward-autofix-comment.md': '## dep-steward autofix\n\nBumped the timeout to match ioredis 6.\n' },
  });
  assert.equal(r.failed, false, r.log);
  assert.ok(r.pushed, 'the fix must reach the PR branch');
  assert.deepEqual(r.pushedFiles, ['src/client.ts'], 'the draft must not ride along into the commit');
  assert.ok(!r.comments.some((c) => c.includes('exceeded the safe bounds')));
});

test('bounds: a scratch file the pipeline did not prescribe still escalates, and nothing is pushed', async () => {
  const r = await runAutofix({ app: true, edits: { ...IN_BOUNDS_FIX, '.autofix-comment.md': '## dep-steward autofix\n' } });
  assert.equal(r.pushed, false);
  assert.match(r.comments.join('\n'), /fix changes file status "A" \(\.autofix-comment\.md\)/);
  assert.equal(r.calls.mint.length, 0);
});

test('bounds: a draft with no fix beside it is "no edits", not a push', async () => {
  const r = await runAutofix({ edits: { '.dep-steward-autofix-comment.md': "## dep-steward autofix\n\nEscalating: the failure is not the bump's fault.\n" } });
  assert.equal(r.pushed, false);
  assert.match(r.log, /The fixer made no edits/);
  assert.ok(r.ghCalls.some((c) => c.includes('needs-human-review')), 'a red build with no fix still reaches a person');
});

// ---- the review job and the App's push ---------------------------------------

test('the review job starts only for pushers its Claude step will act for', () => {
  // claude-code-action refuses any bot actor not in its allowed_bots
  // (checkHumanActor: "Workflow initiated by non-human actor"). The App's
  // push fires pull_request synchronize with the App as the actor, so a job
  // that started anyway would fail, and its deliverable assertion would label
  // and assign a PR whose review was never attempted: on every autofix push.
  const review = JOBS.review;
  const claude = review.steps.find((s) => s.uses?.startsWith('anthropics/claude-code-action'));
  const allowed = claude.with.allowed_bots.split(',').map((b) => b.trim());
  const runsFor = (sender) =>
    conditionHolds(review.if, {
      github: { event_name: 'pull_request', actor: sender.login, event: { pull_request: { user: { login: 'dependabot[bot]' } }, sender } },
      env: {},
      steps: {},
      jobFailed: false,
    });
  for (const bot of allowed) assert.equal(runsFor({ login: bot, type: 'Bot' }), true, `${bot} is in allowed_bots`);
  assert.equal(runsFor({ login: 'raphaelcm', type: 'User' }), true, 'a person pushing to the PR');
  assert.equal(runsFor({ login: 'dep-steward-runsense[bot]', type: 'Bot' }), false, 'dep-steward\'s own App pushing a fix');
  assert.equal(
    conditionHolds(review.if, { github: { event_name: 'workflow_dispatch', actor: 'raphaelcm', event: {} }, env: {}, steps: {}, jobFailed: false }),
    true,
    'a manual replay still runs',
  );
});
