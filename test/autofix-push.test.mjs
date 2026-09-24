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
 * installation token does start workflows, and one App is on every repo this
 * pipeline runs in: the Claude Code GitHub App, which the review and fix jobs
 * already need. So the job pushes as that App, with a token from the same
 * OIDC exchange claude-code-action performs. Nothing to configure: a one-line
 * install is all it takes.
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
 * Only the agent and the two token endpoints are simulated: the agent writes
 * the files a test names, and a `curl` stub answers the OIDC request and the
 * exchange the way GitHub and Anthropic do (claude-code-action,
 * src/github/token.ts), recording which step asked.
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
const CLAUDE_APP_TOKEN = 'ghs_claudeAppInstallationToken02';
const OIDC_REQUEST_URL = 'https://pipelines.actions.test/idtoken/1?api-version=2.0';
const OIDC_REQUEST_TOKEN = 'oidc-request-token-3';
const OIDC_JWT = 'eyJoidcJwtOfThisJob4';
const GITHUB_API_URL = 'https://api.github.test';

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

// The two token endpoints, as GitHub and Anthropic answer them, plus the
// revoke. Every call is logged with the step that made it ($GITHUB_ACTION),
// so a test can say which step asked for a token, and when.
const CURL_STUB = `#!/usr/bin/env bash
method=GET; url=''; auth=''; ctype=''; body=''
while [ $# -gt 0 ]; do
  case "$1" in
    -X) method="$2"; shift ;;
    -H) case "$2" in [Aa]uthorization:*) auth="\${2#*: }" ;; [Cc]ontent-[Tt]ype:*) ctype="\${2#*: }" ;; esac; shift ;;
    -d|--data|--data-raw) body="$2"; shift ;;
    -o) shift ;;
    -*) ;;
    *) url="$1" ;;
  esac
  shift
done
printf '%s\\t%s\\t%s\\t%s\\t%s\\n' "\${GITHUB_ACTION:-}" "$method" "$url" "$auth" "$body" >> "$CURL_LOG"
case "$url" in
  "$ACTIONS_ID_TOKEN_REQUEST_URL"*)
    [ "$auth" = "Bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" ] || { echo '{"message":"Bad credentials"}'; exit 22; }
    printf '{"count":1,"value":"%s"}' "$OIDC_JWT" ;;
  https://api.anthropic.com/api/github/github-app-token-exchange)
    if [ "$EXCHANGE" = fails ]; then printf '{"error":{"message":"Claude Code is not installed on this repository"}}'; exit 22; fi
    { [ "$method" = POST ] && [ "$auth" = "Bearer $OIDC_JWT" ]; } || { printf '{"error":{"message":"invalid OIDC token"}}'; exit 22; }
    # A scope is asked for the way claude-code-action asks for one: a JSON
    # \`permissions\` body. EXCHANGE=narrow-refused is an endpoint that grants
    # only its default scope.
    if [ -n "$body" ]; then
      [ "$ctype" = application/json ] || { printf '{"error":{"message":"expected a JSON body"}}'; exit 22; }
      [ "$EXCHANGE" = narrow-refused ] && { printf '{"error":{"message":"Invalid permissions requested"}}'; exit 22; }
    fi
    printf '{"token":"%s"}' "$CLAUDE_APP_TOKEN" ;;
  "$GITHUB_API_URL/installation/token")
    [ "$method" = DELETE ] || exit 22 ;;
  *) echo "curl stub: unexpected URL $url" >&2; exit 2 ;;
esac
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
 *   exchange 'ok' or 'fails' (Anthropic's answer to the token exchange)
 *   refuse   credentials the remote refuses, with `refuseWith` (403 or 401)
 *   helper   leave a credential helper in the tree, as claude-code-action's
 *            allowed_non_write_users mode does, instead of a token in origin
 *   jobs     the parsed workflow to run (a test may take a permission away)
 */
async function runAutofix({ edits = IN_BOUNDS_FIX, commits = [DEPENDABOT_COMMIT], labels = [], exchange = 'ok', refuse = [], refuseWith = 403, helper = false, jobs = JOBS } = {}) {
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

    const calls = { fixer: [] };
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
    };

    writeFileSync(join(bin, 'gh'), GH_STUB, { mode: 0o755 });
    const ghLog = join(bin, 'gh.log');
    writeFileSync(ghLog, '');
    writeFileSync(join(bin, 'curl'), CURL_STUB, { mode: 0o755 });
    const curlLog = join(bin, 'curl.log');
    writeFileSync(curlLog, '');
    // Retries back off with sleep; the waiting is not what is under test.
    writeFileSync(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    // GitHub hands a job the OIDC request variables only when it grants
    // `id-token: write`, so the harness does the same.
    const oidc = jobs.autofix.permissions?.['id-token'] === 'write'
      ? { ACTIONS_ID_TOKEN_REQUEST_URL: OIDC_REQUEST_URL, ACTIONS_ID_TOKEN_REQUEST_TOKEN: OIDC_REQUEST_TOKEN }
      : {};

    const result = await runJob(jobs, 'autofix', {
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
        GITHUB_API_URL,
        CURL_LOG: curlLog,
        EXCHANGE: exchange,
        OIDC_JWT,
        CLAUDE_APP_TOKEN,
        ...oidc,
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
      tokenCalls: readFileSync(curlLog, 'utf8').split('\n').filter(Boolean).map((l) => {
        const [step, method, url, auth, body] = l.split('\t');
        const kind = url.startsWith(OIDC_REQUEST_URL) ? 'oidc'
          : url.endsWith('/github-app-token-exchange') ? 'exchange'
            : url.endsWith('/installation/token') ? 'revoke' : 'other';
        return { step, method, url, auth, body, kind };
      }),
      log: result.steps.map((s) => `--- ${s.name} [${s.status}]\n${s.output}`).join('\n'),
    };
  } finally {
    await server.close();
  }
}

// The plain in-bounds run on a one-line install: several tests read it, none
// changes it, so it runs once.
let plain;
const plainRun = () => (plain ??= runAutofix());

const labelledAndAssigned = (ghCalls) =>
  ghCalls.some((c) => /^pr edit 1 --repo octocat\/repo --add-label needs-human-review --add-assignee octocat$/.test(c));

// ---- who pushes -----------------------------------------------------------

test('with nothing configured, the fix reaches the PR branch as the Claude GitHub App, not as GITHUB_TOKEN', async () => {
  // The whole point, on a one-line install. GitHub starts CI for a push by an
  // App's installation token and not for one by GITHUB_TOKEN, and the working
  // tree still holds GITHUB_TOKEN twice (checkout's header, the fixer's origin
  // URL). Either one winning is the #2693 defect again, silently.
  const r = await plainRun();
  assert.equal(r.failed, false, r.log);
  assert.equal(r.calls.fixer.length, 1, 'a PR with only Dependabot\'s commits gets its one attempt');
  assert.deepEqual(r.pushedAs, [CLAUDE_APP_TOKEN], `the remote must see the Claude App token on the push:\n${r.log}`);
  assert.deepEqual(r.pushedFiles, ['src/client.ts']);
  assert.equal(r.pushedAuthor, 'dep-steward[bot] <dep-steward@users.noreply.github.com>');
  assert.equal(r.comments.length, 1);
  assert.match(r.comments[0], /CI is now running on the fix/);
  assert.doesNotMatch(r.comments[0], /close and reopen/);
});

test('when the Claude App token cannot be had, the fix still lands, the PR says how to start CI and why, and the job goes red', async () => {
  // A push that cannot start CI is dep-steward not doing its job, so it must
  // not look like success; but it must not cost the person the fix either.
  const r = await runAutofix({ exchange: 'fails' });
  assert.deepEqual(r.pushedAs, [WORKFLOW_TOKEN], `the fix must not be lost:\n${r.log}`);
  assert.equal(r.failed, true);
  assert.equal(r.comments.length, 1);
  assert.ok(r.comments[0].startsWith(CLOSE_AND_REOPEN), r.comments[0]);
  assert.match(r.comments[0], /Claude GitHub App/);
});

test('without id-token: write there is no OIDC token, and the job falls back the same loud way', async () => {
  // The permission is what lets the job ask for its OIDC token at all. Trimmed
  // away, every fix would quietly stop starting CI.
  const trimmed = structuredClone(JOBS);
  delete trimmed.autofix.permissions['id-token'];
  const r = await runAutofix({ jobs: trimmed });
  assert.deepEqual(r.pushedAs, [WORKFLOW_TOKEN], r.log);
  assert.equal(r.failed, true);
  assert.match(r.log, /id-token: write/);
});

test('a refused Claude App push falls back to GITHUB_TOKEN, and goes red', async () => {
  // The token came back, but the push was refused (a branch rule that exempts
  // only github-actions, say). Deliver the fix, name the cause, go red.
  const r = await runAutofix({ refuse: [basicFor(CLAUDE_APP_TOKEN)] });
  const refused = r.seen.filter((s) => s.status === 403).map((s) => tokenOf(s.auth));
  assert.ok(refused.includes(CLAUDE_APP_TOKEN), `the Claude App push must be tried first:\n${r.log}`);
  assert.deepEqual(r.pushedAs, [WORKFLOW_TOKEN]);
  assert.equal(r.failed, true);
  assert.match(r.comments.join('\n'), /Claude GitHub App/);
});

test('a credential helper in the tree cannot turn a rejected Claude App token into a GITHUB_TOKEN push that claims to be the App', async () => {
  // GitHub answers an expired or revoked token with 401, and git answers a
  // 401 by asking its credential helpers for another. If the one
  // claude-code-action leaves could answer, the push would succeed as
  // GITHUB_TOKEN while the step reported the App: "CI is now running" on a
  // commit where CI never starts.
  const r = await runAutofix({ helper: true, refuse: [basicFor(CLAUDE_APP_TOKEN)], refuseWith: 401 });
  assert.equal(r.failed, true, r.log);
  assert.deepEqual(r.pushedAs, [WORKFLOW_TOKEN], 'the fallback push is the explicit one');
  assert.doesNotMatch(r.comments.join('\n'), /CI is now running/);
  assert.match(r.comments.join('\n'), /Claude GitHub App/);
});

test('when every push is refused, nothing lands and a person is told once', async () => {
  // A fix the bounds accepted and nobody could push used to end as a red step
  // nobody watches, with the fixer's own comment claiming a fix.
  const r = await runAutofix({ refuse: [basicFor(CLAUDE_APP_TOKEN), basicFor(WORKFLOW_TOKEN)] });
  assert.equal(r.pushed, false);
  assert.equal(r.failed, true);
  assert.equal(r.comments.length, 1, r.log);
  assert.match(r.comments[0], /could not push/i);
  assert.ok(labelledAndAssigned(r.ghCalls), `the escalation must label and assign:\n${r.ghCalls.join('\n')}`);
});

// ---- when a token exists at all --------------------------------------------

test('the Claude App token is asked for only by the push step, only for a fix that will be pushed, and revoked right after', async () => {
  const r = await plainRun();
  assert.deepEqual(
    r.tokenCalls.map((c) => [c.step, c.method, c.kind]),
    [['push', 'GET', 'oidc'], ['push', 'POST', 'exchange'], ['push', 'DELETE', 'revoke']],
    'one OIDC request, one exchange, one revoke, all from the push step',
  );
  assert.match(r.tokenCalls[0].url, /[?&]audience=claude-code-github-action$/, 'the audience claude-code-action uses');
  assert.equal(r.tokenCalls[1].auth, `Bearer ${OIDC_JWT}`, 'the exchange presents this job\'s OIDC token');
  assert.equal(r.tokenCalls[2].auth, `Bearer ${CLAUDE_APP_TOKEN}`, 'and the token it got back is the one revoked');
  for (const [what, scenario] of [
    ['a fix outside the bounds', { edits: { '.github/dependabot-autofix-prompt.md': 'rewritten\n' } }],
    ['a fixer that made no edits', { edits: {} }],
    ['a PR that already carries a dep-steward fix', { commits: [DEPENDABOT_COMMIT, AUTOFIX_COMMIT] }],
  ]) {
    const x = await runAutofix(scenario);
    assert.deepEqual(x.tokenCalls, [], `no token may be asked for on ${what}`);
    assert.equal(x.pushed, false, `${what} is never pushed`);
  }
});

test('the token asked for can push code and nothing else: contents: write', async () => {
  // It lives for one push, and a push needs nothing more: not the comment,
  // label and issue scopes the exchange grants by default. The scope is asked
  // for the way claude-code-action asks for one (src/github/token.ts: a JSON
  // `permissions` body).
  const r = await plainRun();
  const asked = r.tokenCalls.filter((c) => c.kind === 'exchange').map((c) => c.body);
  assert.deepEqual(asked, ['{"permissions":{"contents":"write"}}'], r.log);
  assert.deepEqual(r.pushedAs, [CLAUDE_APP_TOKEN]);
});

test('an exchange that will not narrow the token still gets the fix out as the App, on the scope claude-code-action runs already hold', async () => {
  // Narrowing is the endpoint's to grant. Refused, the push takes the
  // endpoint's default scope, which every claude-code-action run in this repo
  // already holds, rather than giving up the fix's CI run.
  const r = await runAutofix({ exchange: 'narrow-refused' });
  assert.equal(r.failed, false, r.log);
  assert.deepEqual(r.pushedAs, [CLAUDE_APP_TOKEN], r.log);
  assert.match(r.comments.join('\n'), /CI is now running on the fix/);
  const asked = r.tokenCalls.filter((c) => c.kind === 'exchange').map((c) => c.body);
  assert.ok(asked.length >= 2, `the narrow ask, then the default one:\n${r.log}`);
  assert.ok(asked.slice(0, -1).every((b) => b === '{"permissions":{"contents":"write"}}'), 'contents: write is asked for first');
  assert.equal(asked.at(-1), '', 'and only then the default scope');
  assert.match(r.log, /default scope/, 'the log says which scope the push used');
  assert.deepEqual(r.tokenCalls.filter((c) => c.kind === 'revoke').map((c) => c.auth), [`Bearer ${CLAUDE_APP_TOKEN}`], 'it is revoked like any other');
});

test('the Claude App token never enters any step\'s inputs, env or outputs', async () => {
  // It is asked for, used and revoked inside the push step's own shell. The
  // fixer reads attacker-influenced text; nothing it can see may carry a
  // credential that starts workflows.
  const r = await plainRun();
  const carries = (map) => Object.values(map ?? {}).some((v) => String(v).includes(CLAUDE_APP_TOKEN));
  assert.deepEqual(r.result.steps.filter((s) => carries(s.env) || carries(s.with) || carries(s.outputs)).map((s) => s.name), []);
  assert.ok(!carries(r.result.jobEnv), 'nor the job-level env, which every step inherits');
  assert.deepEqual(r.pushedAs, [CLAUDE_APP_TOKEN], 'and yet the push used it');
});

// ---- one push per PR ---------------------------------------------------------

test('a PR that already carries a dep-steward fix gets no second attempt, and a person is told once', async () => {
  // A fix pushed as the App starts CI, so a fix CI rejects would start another
  // autofix run, and another fix, and another. The job must stop before the
  // fixer even runs.
  const r = await runAutofix({ commits: [DEPENDABOT_COMMIT, AUTOFIX_COMMIT] });
  assert.equal(r.calls.fixer.length, 0, `the fixer must not run a second time:\n${r.log}`);
  assert.deepEqual(r.tokenCalls, []);
  assert.equal(r.pushed, false);
  assert.equal(r.failed, false, 'refusing is the guard working, not a malfunction');
  assert.equal(r.comments.length, 1);
  assert.match(r.comments[0], /already pushed a fix to this PR \(9d4c666\)/);
  assert.ok(labelledAndAssigned(r.ghCalls), r.ghCalls.join('\n'));
});

test('a person\'s commit on top of the fix does not buy a second attempt', async () => {
  // #2693's shape: a person merged main into the branch after the fix. The
  // head is no longer the fix, and a head-only check would try again.
  const r = await runAutofix({ commits: [DEPENDABOT_COMMIT, AUTOFIX_COMMIT, PERSON_MERGE_COMMIT] });
  assert.equal(r.calls.fixer.length, 0, r.log);
  assert.equal(r.pushed, false);
});

test('when the PR\'s commits cannot be read, the job attempts nothing and tells a person', async () => {
  // The guard cannot prove this is the first attempt, so it must not let the
  // fixer run; and since autofix owns a red build, staying silent would strand
  // the PR with nobody told.
  const r = await runAutofix({ commits: 'unreadable' });
  assert.equal(r.calls.fixer.length, 0, r.log);
  assert.equal(r.pushed, false);
  assert.equal(r.failed, true, 'dep-steward could not do its job, and must look like it');
  assert.equal(r.comments.length, 1);
  assert.match(r.comments[0], /could not read this PR's commits/);
  assert.ok(labelledAndAssigned(r.ghCalls), r.ghCalls.join('\n'));
});

test('a PR already waiting for a person is refused quietly', async () => {
  // The job wakes on every failing CI run; the notice is posted once.
  const r = await runAutofix({ commits: [DEPENDABOT_COMMIT, AUTOFIX_COMMIT], labels: ['needs-human-review'] });
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
  const r = await runAutofix({ edits: { ...IN_BOUNDS_FIX, '.autofix-comment.md': '## dep-steward autofix\n' } });
  assert.equal(r.pushed, false);
  assert.match(r.comments.join('\n'), /fix changes file status "A" \(\.autofix-comment\.md\)/);
  assert.deepEqual(r.tokenCalls, []);
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
  // (checkHumanActor: "Workflow initiated by non-human actor"). Autofix's push
  // fires pull_request synchronize with the Claude App as the actor, so a job
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
  assert.equal(runsFor({ login: 'claude[bot]', type: 'Bot' }), false, 'the Claude App pushing autofix\'s fix');
  assert.equal(
    conditionHolds(review.if, { github: { event_name: 'workflow_dispatch', actor: 'raphaelcm', event: {} }, env: {}, steps: {}, jobFailed: false }),
    true,
    'a manual replay still runs',
  );
});
