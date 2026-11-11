import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, realpathSync, existsSync, accessSync, constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { conditionHolds, runJob } from './lib/actions-sim.mjs';
import { jobsOf, workflowText, inputDefaults, topLevelEnv, toolsHandler, TOOLS_ACTION } from './lib/dep-steward.mjs';
import { startGitServer, tokenOf, basicFor } from './lib/git-http-server.mjs';
import {
  CURL_STUB, GIT_ISOLATION, git,
  WORKFLOW_TOKEN, PUSH_TOKEN, GITHUB_API_URL,
} from './lib/autofix-harness.mjs';

/**
 * Who pushes the autofix commit decides whether CI ever runs on it.
 *
 * GitHub starts no workflow for a push made with GITHUB_TOKEN. The autofix job
 * pushed that way, so its fix sat with no CI run, no re-review and no merge-gate
 * wake-up until a person pushed to the branch: Runsense-ai/runsense#2693, fix
 * commit 9d4c6668, zero check runs for nine days. A push made with any other
 * token does start workflows. So when the repo has a DEP_STEWARD_PUSH_TOKEN
 * secret, the job pushes with it; without one it pushes with GITHUB_TOKEN and
 * the PR comment tells a person how to start CI.
 *
 * A push that starts CI also releases the brake GITHUB_TOKEN put on
 * fix -> CI red -> autofix -> fix, so the job makes ONE push per PR.
 *
 * Everything here RUNS the shipped autofix job (.github/workflows/review.yml) (test/lib/actions-sim.mjs:
 * every `if:`, every output, every `run:` block through bash as GitHub runs
 * it). The pushes go through real `git` to a real `git http-backend` behind a
 * local server that records each request's Authorization, which is the thing
 * GitHub attributes a push to. The working tree carries GITHUB_TOKEN where the
 * real job leaves it: claude-code-action rewrites `origin` to embed the job's
 * github_token (src/github/operations/git-config.ts), and a checkout that
 * persists its credential keeps a header in an included file under
 * RUNNER_TEMP (which claude-code-action v1.0.187 does not remove).
 * So "the push token pushed" is observed at the remote, not inferred from
 * argv. Only the agent is simulated: it writes the files a test names. A
 * `curl` stub logs any request a step makes, and the push makes none.
 */

// The shipped reusable workflow, called as the plugin's caller template calls
// it, with octocat as the assignee and every other input at its default.
const REVIEW_TEXT = workflowText('review');
const JOBS = jobsOf('review');
const INPUTS = { ...inputDefaults(REVIEW_TEXT), assignee: 'octocat' };
const WORKFLOW_ENV = topLevelEnv(REVIEW_TEXT);

const HEAD_BRANCH = 'dependabot/npm_and_yarn/ioredis-6.0.0';

// The comment a person gets when CI cannot start on its own: the text installs
// already post. The reason is what autofix-bounds.cjs says about a one-file,
// two-line fix.
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

const IN_BOUNDS_FIX = { 'src/client.ts': 'export const timeout = 2000;\n' };

/**
 * Run the rendered autofix job once, as GitHub would after CI failed on
 * Dependabot's PR.
 *   edits    files the agent writes (path -> content)
 *   commits  the PR's commits as gh reports them
 *   labels   the PR's labels
 *   pushToken  the repo's DEP_STEWARD_PUSH_TOKEN secret, when it has one
 *   refuse   credentials the remote refuses, with `refuseWith` (403 or 401)
 *   helper   leave a credential helper in the tree, as claude-code-action's
 *            allowed_non_write_users mode does, instead of a token in origin
 *   jobs     the parsed workflow to run (a test may take a permission away)
 *   toolsFail  the tools action fails (it could not read the default
 *            branch, say), so the job's scripts never arrive
 *   runnerTemp  a runner temp directory to reuse, as a self-hosted runner can
 *   forge    replace what the agent job hands the push job: { edits } becomes
 *            a patch against the commit the fixer saw, { patch } is used as
 *            given, each with decision=push, as a turned agent job could
 *            hand over
 *   moveBranch  push a new commit to the PR branch between the two jobs
 *   commitsSeenByPush  the PR's commits as the push job reads them, when a
 *            push landed in between
 *   outsideWrites  files the agent writes outside the checkout, keyed by a
 *            path relative to HOME or RUNNER_TEMP ('~/x', '$RUNNER_TEMP/x').
 *            A bare Write or Edit allow rule matches every path but Claude
 *            Code's protected ones, so the agent can.
 */
async function runAutofix({ edits = IN_BOUNDS_FIX, commits = [DEPENDABOT_COMMIT], labels = [], pushToken, refuse = [], refuseWith = 403, helper = false, jobs = JOBS, toolsFail = false, runnerTemp: sharedTemp, outsideWrites = {}, forge, moveBranch = false, commitsSeenByPush } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ds-autofix-'));
  const srv = join(root, 'srv');
  const bare = join(srv, 'octocat', 'repo.git');
  const work = join(root, 'work');
  const bin = join(root, 'bin');
  const runnerTemp = sharedTemp ?? join(root, 'runner-temp');
  const home = join(root, 'home');
  const commentsDir = join(root, 'comments');
  for (const d of [srv, work, bin, runnerTemp, home, commentsDir, join(work, 'src')]) {
    mkdirSync(d, { recursive: true });
  }

  // The PR head as the fixer finds it: the bump. dep-steward's scripts are
  // never in the repo; the tools action brings them from the release.
  writeFileSync(join(work, 'src/client.ts'), 'export const timeout = 1000;\n');
  writeFileSync(join(work, 'package.json'), '{"name":"app","dependencies":{"ioredis":"^6.0.0"}}\n');
  git(['init', '-q', '-b', 'main', work]);
  git(['config', 'user.email', 'test@example.invalid'], work);
  git(['config', 'user.name', 'test'], work);
  git(['add', '-A'], work);
  git(['commit', '-q', '-m', 'bump ioredis 5 -> 6'], work);
  const baseSha = git(['rev-parse', 'HEAD'], work).trim();
  const headSha = git(['rev-parse', 'HEAD'], work).trim();
  git(['init', '-q', '--bare', bare]);
  git(['push', '-q', bare, `HEAD:refs/heads/${HEAD_BRANCH}`], work);

  const server = await startGitServer(srv, { refuse, refuseWith });
  try {
    git(['remote', 'add', 'origin', `${server.url}/octocat/repo.git`], work);
    const creds = join(runnerTemp, 'git-credentials-0b1f.config');

    const calls = { fixer: [] };
    const tools = toolsHandler();
    const uses = {
      [TOOLS_ACTION]: toolsFail
        ? async () => ({ exitCode: 1, output: 'gh: HTTP 404: Not Found (repos/octocat/repo/git/trees/main)' })
        : tools,
      // The tree above already is the checkout. What actions/checkout v7 adds
      // unless told not to persist credentials: GITHUB_TOKEN as an
      // extraheader in a RUNNER_TEMP file the repo's config includes.
      'actions/checkout': async ({ with: w, cwd: tree }) => {
        if (w['persist-credentials'] !== 'false') {
          git(['config', '--file', creds, `http.${server.url}/.extraheader`, `AUTHORIZATION: ${basicFor(WORKFLOW_TOKEN)}`]);
          git(['config', '--local', `includeIf.gitdir:${realpathSync(tree)}/.git.path`, creds], tree);
          assert.equal(
            git(['config', '--get-all', `http.${server.url}/.extraheader`], tree).trim(),
            `AUTHORIZATION: ${basicFor(WORKFLOW_TOKEN)}`,
            'harness: the checkout credential must be live in the working tree',
          );
        }
        return { exitCode: 0 };
      },
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
        for (const [path, content] of Object.entries(outsideWrites)) {
          const abs = path.replace(/^~\//, `${home}/`).replace(/^\$RUNNER_TEMP\//, `${runnerTemp}/`);
          // A read-only file or directory refuses the write, as it would the
          // agent's; the attempt is recorded rather than thrown.
          try {
            mkdirSync(dirname(abs), { recursive: true });
            writeFileSync(abs, content, { mode: 0o755 });
          } catch (e) {
            if (e.code !== 'EACCES') throw e;
            calls.refusedWrites = [...(calls.refusedWrites ?? []), path];
          }
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

    const github = {
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
    };
    const secrets = {
      GITHUB_TOKEN: WORKFLOW_TOKEN,
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-test',
      ...(pushToken ? { DEP_STEWARD_PUSH_TOKEN: pushToken } : {}),
    };
    const env = {
      ...process.env,
      ...GIT_ISOLATION,
      PATH: `${bin}:${process.env.PATH}`,
      GH_LOG: ghLog,
      GH_COMMENTS: commentsDir,
      PR_COMMITS_JSON: commits === 'unreadable' ? 'unreadable' : JSON.stringify({ commits }),
      PR_LABELS_JSON: JSON.stringify({ labels: labels.map((name) => ({ name })) }),
      BUMP_PATHS: 'package.json',
      RUNNER_TEMP: runnerTemp,
      HOME: home,
      GITHUB_SHA: baseSha,
      GITHUB_SERVER_URL: server.url,
      GITHUB_API_URL,
      CURL_LOG: curlLog,
    };
    const agent = await runJob(jobs, 'autofix', { github, secrets, uses, cwd: work, env, inputs: INPUTS, workflowEnv: WORKFLOW_ENV });
    // What the fixer faced, before the push job (which shares this temp
    // directory here, as a self-hosted runner can) touches it.
    const copies = join(runnerTemp, 'dep-steward');
    const copiesAfterAgent = ['', 'autofix-bounds.cjs', 'bump-paths.txt', 'review-lint.cjs', 'autofix-prompt.md'].map((f) => {
      const path = join(copies, f);
      let writable = false;
      try { accessSync(path, constants.W_OK); writable = true; } catch { /* read-only, or absent */ }
      return { file: f || '.', exists: existsSync(path), writable };
    });

    // What the push job receives: the agent job's outputs, or what a turned
    // agent job could hand over instead.
    let handedOver = agent.outputs;
    if (forge?.patch !== undefined) {
      handedOver = { decision: 'push', base_sha: headSha, patch: Buffer.from(forge.patch).toString('base64') };
    } else if (forge) {
      const scratch = join(root, 'forge');
      git(['clone', '-q', '--branch', HEAD_BRANCH, bare, scratch]);
      for (const [path, content] of Object.entries(forge.edits)) {
        mkdirSync(dirname(join(scratch, path)), { recursive: true });
        writeFileSync(join(scratch, path), content);
      }
      git(['add', '-A'], scratch);
      const patch = execFileSync('git', ['diff', '--cached', '--binary', headSha], { cwd: scratch, env: { ...process.env, ...GIT_ISOLATION } }).toString('base64');
      handedOver = { decision: 'push', base_sha: headSha, patch };
    }
    if (moveBranch) {
      const mover = join(root, 'mover');
      git(['clone', '-q', '--branch', HEAD_BRANCH, bare, mover]);
      git(['config', 'user.email', 'dependabot@example.invalid'], mover);
      git(['config', 'user.name', 'dependabot[bot]'], mover);
      writeFileSync(join(mover, 'package-lock.json'), '{"lockfileVersion":3}\n');
      git(['add', '-A'], mover);
      git(['commit', '-q', '-m', 'rebase'], mover);
      git(['push', '-q', bare, `HEAD:refs/heads/${HEAD_BRANCH}`], mover);
    }
    const headBeforePush = git(['--git-dir', bare, 'rev-parse', HEAD_BRANCH]).trim();

    // The push job runs on a fresh runner: a clean clone, no agent ever near it.
    const pushTree = join(root, 'push-tree');
    git(['clone', '-q', '--branch', HEAD_BRANCH, bare, pushTree]);
    git(['remote', 'set-url', 'origin', `${server.url}/octocat/repo.git`], pushTree);
    const pushEnv = {
      ...env,
      ...(commitsSeenByPush ? { PR_COMMITS_JSON: JSON.stringify({ commits: commitsSeenByPush }) } : {}),
    };
    const push = await runJob(jobs, 'autofix-push', {
      github, secrets, uses, cwd: pushTree, env: pushEnv, inputs: INPUTS, workflowEnv: WORKFLOW_ENV,
      needs: { autofix: { outputs: handedOver, result: agent.failed ? 'failure' : 'success' } },
    });
    const result = {
      steps: [...agent.steps, ...push.steps],
      failed: agent.failed || push.failed,
      jobEnv: { ...agent.jobEnv, ...push.jobEnv },
      outputs: agent.outputs,
      pushJob: push,
    };

    const head = git(['--git-dir', bare, 'rev-parse', HEAD_BRANCH]).trim();
    const pushed = head !== headBeforePush;
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
      // Every request a step made with curl. No step needs one.
      curlCalls: readFileSync(curlLog, 'utf8').split('\n').filter(Boolean).map((l) => {
        const [step, method, url, auth] = l.split('\t');
        return { step, method, url, auth };
      }),
      log: result.steps.map((s) => `--- ${s.name} [${s.status}]\n${s.output}`).join('\n'),
      runnerTemp,
      copiesAfterAgent,
    };
  } finally {
    await server.close();
  }
}

// The plain in-bounds run, on a one-line install and on one with a push
// token: several tests read them, none changes them, so each runs once.
let plain;
const plainRun = () => (plain ??= runAutofix());
let withToken;
const tokenRun = () => (withToken ??= runAutofix({ pushToken: PUSH_TOKEN }));

const labelledAndAssigned = (ghCalls) =>
  ghCalls.some((c) => /^pr edit 1 --repo octocat\/repo --add-label needs-human-review --add-assignee octocat$/.test(c));

// ---- who pushes -----------------------------------------------------------

test('with nothing configured, the fix lands with GITHUB_TOKEN, the PR says how to start CI and how to make it start by itself', async () => {
  // A one-line install has no push token. The fix must still reach the
  // person, with what they need to run CI on it. That is the install working
  // as set up, so the job stays green.
  const r = await plainRun();
  assert.equal(r.failed, false, r.log);
  assert.equal(r.calls.fixer.length, 1, 'a PR with only Dependabot\'s commits gets its one attempt');
  assert.deepEqual(r.pushedAs, [WORKFLOW_TOKEN], r.log);
  assert.deepEqual(r.pushedFiles, ['src/client.ts']);
  assert.equal(r.pushedAuthor, 'dep-steward[bot] <dep-steward@users.noreply.github.com>');
  assert.equal(r.comments.length, 1);
  assert.ok(r.comments[0].startsWith(CLOSE_AND_REOPEN), r.comments[0]);
  assert.match(r.comments[0], /DEP_STEWARD_PUSH_TOKEN/);
});

test('with DEP_STEWARD_PUSH_TOKEN set, the fix reaches the PR branch with it, not with GITHUB_TOKEN', async () => {
  // The whole point of the token. GitHub starts CI for its push and not for
  // one by GITHUB_TOKEN, and the working tree still holds GITHUB_TOKEN twice
  // (checkout's header, the fixer's origin URL). Either one winning is the
  // #2693 defect again, silently.
  const r = await tokenRun();
  assert.equal(r.failed, false, r.log);
  assert.deepEqual(r.pushedAs, [PUSH_TOKEN], `the remote must see the push token on the push:\n${r.log}`);
  assert.deepEqual(r.pushedFiles, ['src/client.ts']);
  assert.equal(r.pushedAuthor, 'dep-steward[bot] <dep-steward@users.noreply.github.com>');
  assert.equal(r.comments.length, 1);
  assert.match(r.comments[0], /CI is now running on the fix/);
  assert.doesNotMatch(r.comments[0], /close and reopen/);
});

test('a refused push token falls back to GITHUB_TOKEN, says why CI did not start, and goes red', async () => {
  // An expired token, or a branch rule that exempts only github-actions. The
  // person set the token up so CI would start; when it doesn't, that must not
  // look like success, and it must not cost them the fix either.
  const r = await runAutofix({ pushToken: PUSH_TOKEN, refuse: [basicFor(PUSH_TOKEN)] });
  const refused = r.seen.filter((s) => s.status === 403).map((s) => tokenOf(s.auth));
  assert.ok(refused.includes(PUSH_TOKEN), `the push token must be tried first:\n${r.log}`);
  assert.deepEqual(r.pushedAs, [WORKFLOW_TOKEN], `the fix must not be lost:\n${r.log}`);
  assert.equal(r.failed, true);
  assert.equal(r.comments.length, 1);
  assert.ok(r.comments[0].startsWith(CLOSE_AND_REOPEN), r.comments[0]);
  assert.match(r.comments[0], /refused the push with DEP_STEWARD_PUSH_TOKEN/);
});

test('a credential helper in the tree cannot turn a rejected push token into a GITHUB_TOKEN push that claims to be the token', async () => {
  // GitHub answers an expired or revoked token with 401, and git answers a
  // 401 by asking its credential helpers for another. If the one
  // claude-code-action leaves could answer, the push would succeed as
  // GITHUB_TOKEN while the step reported the push token: "CI is now running"
  // on a commit where CI never starts.
  const r = await runAutofix({ pushToken: PUSH_TOKEN, helper: true, refuse: [basicFor(PUSH_TOKEN)], refuseWith: 401 });
  assert.equal(r.failed, true, r.log);
  assert.deepEqual(r.pushedAs, [WORKFLOW_TOKEN], 'the fallback push is the explicit one');
  assert.doesNotMatch(r.comments.join('\n'), /CI is now running/);
  assert.match(r.comments.join('\n'), /DEP_STEWARD_PUSH_TOKEN/);
});

test('when every push is refused, nothing lands and a person is told once', async () => {
  // A fix the bounds accepted and nobody could push used to end as a red step
  // nobody watches, with the fixer's own comment claiming a fix.
  for (const scenario of [
    { refuse: [basicFor(WORKFLOW_TOKEN)] },
    { pushToken: PUSH_TOKEN, refuse: [basicFor(PUSH_TOKEN), basicFor(WORKFLOW_TOKEN)] },
  ]) {
    const r = await runAutofix(scenario);
    assert.equal(r.pushed, false);
    assert.equal(r.failed, true);
    assert.equal(r.comments.length, 1, r.log);
    assert.match(r.comments[0], /could not push/i);
    assert.ok(labelledAndAssigned(r.ghCalls), `the escalation must label and assign:\n${r.ghCalls.join('\n')}`);
  }
});

test('a checkout that persists its credential still cannot make the push a GITHUB_TOKEN push', async () => {
  // The job's checkout does not persist it; the push step resets that header
  // anyway, so a workflow edit that brings it back does not bring #2693 back.
  const persisted = structuredClone(JOBS);
  for (const job of ['autofix', 'autofix-push']) {
    for (const step of persisted[job].steps) {
      if (step.uses?.startsWith('actions/checkout')) delete step.with['persist-credentials'];
    }
  }
  const r = await runAutofix({ jobs: persisted, pushToken: PUSH_TOKEN });
  assert.deepEqual(r.pushedAs, [PUSH_TOKEN], r.log);
  assert.equal(r.failed, false, r.log);
});

// ---- what the agent writes outside the checkout -----------------------------
//
// The fixer's Edit and Write allow rules name no path, and a rule with no path
// matches every path except Claude Code's protected ones (.git, .claude, shell
// rc files, ...). So the agent can write to its home directory and to
// RUNNER_TEMP. Nothing it writes there may steer a later step.

test('the agent cannot plant git config through checkout\'s credential file', async () => {
  // A persisted checkout credential is a RUNNER_TEMP file the repo's git
  // config includes. Written by the agent, a `core.fsmonitor` in it would run
  // a program on the bounds step's `git add`, with GITHUB_TOKEN in its
  // environment.
  const dir = mkdtempSync(join(tmpdir(), 'ds-fsmon-'));
  const ran = join(dir, 'ran');
  const program = join(dir, 'fsmonitor');
  writeFileSync(program, `#!/bin/sh\necho ran > ${JSON.stringify(ran)}\n`, { mode: 0o755 });
  const r = await runAutofix({ pushToken: PUSH_TOKEN, outsideWrites: { '$RUNNER_TEMP/git-credentials-0b1f.config': `[core]\n\tfsmonitor = ${program}\n` } });
  assert.ok(!existsSync(ran), `a program the agent named in git config ran:\n${r.log}`);
  assert.deepEqual(r.pushedAs, [PUSH_TOKEN], r.log);
});

// ---- where the push token goes ----------------------------------------------

test('the push token goes only to the git remote, and only for a fix that will be pushed', async () => {
  // No step sends a credential to any other server: the push is the one
  // request that carries it.
  const r = await tokenRun();
  assert.deepEqual(r.curlCalls, [], r.log);
  assert.deepEqual(
    [...new Set(r.seen.filter((x) => tokenOf(x.auth) === PUSH_TOKEN).map((x) => x.url.replace(/\?.*$/, '')))].sort(),
    ['/octocat/repo.git/git-receive-pack', '/octocat/repo.git/info/refs'],
    'the push token reaches the remote only to push',
  );
  for (const [what, scenario] of [
    ['a fix outside the bounds', { edits: { '.github/dependabot-autofix-prompt.md': 'rewritten\n' } }],
    ['a fixer that made no edits', { edits: {} }],
    ['a PR that already carries a dep-steward fix', { commits: [DEPENDABOT_COMMIT, AUTOFIX_COMMIT] }],
  ]) {
    const x = await runAutofix({ ...scenario, pushToken: PUSH_TOKEN });
    assert.ok(!x.seen.some((y) => tokenOf(y.auth) === PUSH_TOKEN), `the push token must not be used on ${what}`);
    assert.equal(x.pushed, false, `${what} is never pushed`);
  }
});

test('the push token never enters any step but the push', async () => {
  // The fixer reads attacker-influenced text; nothing it can see may carry a
  // credential that can push. And no job may mint one: none grants id-token.
  const r = await tokenRun();
  const carries = (map) => Object.values(map ?? {}).some((v) => String(v).includes(PUSH_TOKEN));
  assert.deepEqual(
    r.result.steps.filter((s) => carries(s.env) || carries(s.with) || carries(s.outputs)).map((s) => s.name),
    [r.result.steps.find((s) => s.name.startsWith('Push the fix')).name],
  );
  assert.ok(!carries(r.result.jobEnv), 'nor the job-level env, which every step inherits');
  for (const [name, job] of Object.entries(JOBS)) {
    assert.equal(job.permissions?.['id-token'], undefined, `${name} must not grant id-token`);
  }
});

// ---- one push per PR ---------------------------------------------------------

test('a PR that already carries a dep-steward fix gets no second attempt, and a person is told once', async () => {
  // A fix pushed as the App starts CI, so a fix CI rejects would start another
  // autofix run, and another fix, and another. The job must stop before the
  // fixer even runs.
  const r = await runAutofix({ commits: [DEPENDABOT_COMMIT, AUTOFIX_COMMIT] });
  assert.equal(r.calls.fixer.length, 0, `the fixer must not run a second time:\n${r.log}`);
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
});

test('bounds: a draft with no fix beside it is "no edits", not a push', async () => {
  const r = await runAutofix({ edits: { '.dep-steward-autofix-comment.md': "## dep-steward autofix\n\nEscalating: the failure is not the bump's fault.\n" } });
  assert.equal(r.pushed, false);
  assert.match(r.log, /The fixer made no edits/);
  assert.ok(r.ghCalls.some((c) => c.includes('needs-human-review')), 'a red build with no fix still reaches a person');
});

test('bounds: a fixer that rewrites the bounds check can neither run code with it nor talk its way past it', async () => {
  // The bounds step runs after the fixer, and the fixer can write any file it
  // can reach: the checkout, and RUNNER_TEMP, where the copy that runs lives.
  // Whatever the script runs with, the fixer's code would run with:
  // GITHUB_TOKEN. And its verdict decides what is pushed.
  const ran = join(mkdtempSync(join(tmpdir(), 'ds-ran-')), 'ran');
  const rewrite = `require('fs').writeFileSync(${JSON.stringify(ran)}, 'ran');\nconsole.log('decision=push');\nconsole.log('reason=looks fine');\n`;
  const r = await runAutofix({
    edits: { ...IN_BOUNDS_FIX, '.github/dependabot-automerge/autofix-bounds.cjs': rewrite },
    outsideWrites: { '$RUNNER_TEMP/dep-steward/autofix-bounds.cjs': rewrite },
  });
  assert.deepEqual(r.calls.refusedWrites, ['$RUNNER_TEMP/dep-steward/autofix-bounds.cjs'], 'the copy that runs is read-only');
  assert.ok(!existsSync(ran), `the fixer's rewrite of the bounds script ran:\n${r.log}`);
  assert.equal(r.pushed, false, 'a fix that touches .github/ is out of bounds, whatever the rewrite says');
  assert.match(r.comments.join('\n'), /exceeded the safe bounds/);
});

test('bounds: what decides the push is kept where the fixer cannot write it', async () => {
  // Claude Code may let the fixer's writes reach the runner's temp directory;
  // the copies are read-only, and the fixer has no shell to change that.
  const r = await plainRun();
  for (const c of r.copiesAfterAgent) {
    assert.ok(c.exists, `${c.file} must exist when the fixer runs`);
    assert.equal(c.writable, false, `${c.file} must not be writable by the fixer`);
  }
});

test('a runner that kept the last autofix job\'s read-only copies still takes fresh ones', async () => {
  // A self-hosted runner can keep its temp directory between jobs. The copies
  // are read-only, so copying over them would fail every autofix after the first.
  const runnerTemp = mkdtempSync(join(tmpdir(), 'ds-af-rt-'));
  await runAutofix({ runnerTemp });
  const r = await runAutofix({ runnerTemp });
  assert.equal(r.failed, false, r.log);
  assert.deepEqual(r.pushedAs, [WORKFLOW_TOKEN]);
});

test('the job takes its own files from the dep-steward release, not from the PR head', async () => {
  // The PR head holds no dep-steward file at all (an open Dependabot PR on a
  // fresh install predates it anyway). The prompt, the bounds script and the
  // lint come from the tools action at the release the caller pins.
  const r = await plainRun();
  assert.ok(r.copiesAfterAgent.every((c) => c.exists), JSON.stringify(r.copiesAfterAgent));
  assert.equal(r.calls.fixer.length, 1, r.log);
  assert.equal(r.failed, false, r.log);
  assert.deepEqual(r.pushedAs, [WORKFLOW_TOKEN]);
  assert.deepEqual(r.pushedFiles, ['src/client.ts']);
});

test('a step that fails before the fixer runs is reported as that, not as a fix the fixer declined', async () => {
  // The files come from the tools action; if it fails, the fixer never
  // starts. "It found nothing it could safely fix" would send the person
  // looking for a diagnosis that never happened.
  const r = await runAutofix({ toolsFail: true });
  assert.equal(r.calls.fixer.length, 0, r.log);
  assert.equal(r.pushed, false);
  assert.equal(r.failed, true, 'a step failed, and the job says so');
  assert.equal(r.comments.length, 1, r.log);
  assert.match(r.comments[0], /The fixer never ran/);
  assert.doesNotMatch(r.comments[0], /found nothing it could safely fix/);
  assert.ok(labelledAndAssigned(r.ghCalls), r.ghCalls.join('\n'));
});

// ---- the push job trusts nothing the agent job says -------------------------
//
// The autofix job runs an agent over attacker-influenced text, so a turned
// agent can make that job hand over anything: any patch, decision=push. The
// push job, which can push and runs no agent, re-derives everything it pushes
// on. These hand it what a turned agent job could.

const PUSH_JOB_TEXT = REVIEW_TEXT.slice(REVIEW_TEXT.indexOf('\n  autofix-push:'));

test('push job: it takes only a patch and the commit it was drafted for from the agent job', () => {
  // Not the PR, not the branch, not the words of its comment: those it reads
  // from the event and from its own checks, so a turned agent job cannot aim
  // the push or speak through the github-actions identity the gate trusts.
  const used = new Set([...PUSH_JOB_TEXT.matchAll(/needs\.autofix\.outputs\.([a-z_]+)/g)].map((m) => m[1]));
  assert.deepEqual([...used].sort(), ['base_sha', 'decision', 'patch']);
  // The regeneration's hand-off is the one other decision, and it makes the
  // push job read the regeneration itself (regenerate.test.mjs).
  assert.match(PUSH_JOB_TEXT, /^    if: needs\.autofix\.outputs\.decision == 'push' \|\| needs\.autofix\.outputs\.decision == 'regenerate'$/m, 'the decision only decides whether to look');
});

test('push job: a patch outside the bounds is not pushed, whatever the agent job said', async () => {
  for (const edits of [
    { 'package.json': '{"name":"app","dependencies":{"ioredis":"^6.0.0","left-pad":"1.0.0"}}\n' },
    { 'src/client.ts': 'export const timeout = 2000;\n', 'src/new-file.ts': 'export {};\n' },
  ]) {
    const r = await runAutofix({ forge: { edits } });
    assert.equal(r.pushed, false, `pushed ${Object.keys(edits)}:\n${r.log}`);
    assert.equal(r.failed, true, 'an agent job that vouched for an out-of-bounds fix is a malfunction');
    assert.match(r.comments.join('\n'), /did not push its fix[\s\S]*outside the safe bounds/);
  }
});

test('push job: a patch that does not apply is not pushed', async () => {
  const r = await runAutofix({ forge: { patch: 'not a patch at all\n' } });
  assert.equal(r.pushed, false, r.log);
  assert.match(r.comments.join('\n'), /does not apply|changes nothing/);
});

test('push job: a branch that moved while the fixer worked is not pushed to', async () => {
  const r = await runAutofix({ moveBranch: true });
  assert.equal(r.pushed, false, `the fix was drafted for an older commit:\n${r.log}`);
  assert.match(r.log, /moved to [0-9a-f]+ while the fixer worked/);
  assert.equal(r.failed, false, 'the next CI failure gets the next attempt; nothing broke');
});

test('push job: when a fix landed after the agent job looked, it does not push a second', async () => {
  const r = await runAutofix({ commitsSeenByPush: [DEPENDABOT_COMMIT, AUTOFIX_COMMIT] });
  assert.equal(r.pushed, false, r.log);
});

// ---- the review job and bot pushes --------------------------------------------

test('the review job starts only for pushers its Claude step will act for', () => {
  // claude-code-action refuses any bot actor not in its allowed_bots
  // (checkHumanActor: "Workflow initiated by non-human actor"). A job that
  // started for such a push anyway would fail, and its deliverable assertion
  // would label and assign a PR whose review was never attempted.
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
  assert.equal(runsFor({ login: 'claude[bot]', type: 'Bot' }), false, 'a bot outside allowed_bots');
  assert.equal(
    conditionHolds(review.if, { github: { event_name: 'workflow_dispatch', actor: 'raphaelcm', event: {} }, env: {}, steps: {}, jobFailed: false }),
    true,
    'a manual replay still runs',
  );
});
