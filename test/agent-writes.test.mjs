import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, accessSync, constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { runJob } from './lib/actions-sim.mjs';
import { jobsOf, workflowText, inputDefaults, topLevelEnv, TOOLS_DIR, TOOLS_ACTION, REFERENCE_ROOT_FILES } from './lib/dep-steward.mjs';

/**
 * Nothing an agent writes is ever run.
 *
 * Both agents can write files: the reviewer its comment draft, the fixer the
 * source it fixes. Their Write and Edit rules name no path, and Claude Code
 * matches such a rule everywhere, so they can write any file but its
 * protected ones (.git, .claude, shell rc files): the checkout, which holds
 * this pipeline's own scripts, and outside it too. So a script a job runs after its agent has started
 * could be one the agent rewrote, and the rewrite would run with whatever the
 * caller holds:
 *   - the review step's lint hook runs inside the Claude session, whose
 *     environment claude-code-action fills with the Claude App token
 *     (GH_TOKEN), the job's GITHUB_TOKEN and CLAUDE_CODE_OAUTH_TOKEN;
 *   - a later step holds GITHUB_TOKEN and the job's OIDC token, which buys a
 *     Claude App token.
 * A prompt injection in a dependency's changelog would then be code execution
 * with a token that can push to the PR it is reviewing.
 *
 * So every such script runs from a copy the tools action takes from the
 * dep-steward release before the agent starts, kept outside the checkout and
 * read-only (the agent has no shell to change that). This file runs the
 * shipped review job, with the tools action's own script, and a reviewer
 * that rewrites every pipeline script it can reach: the copies, and the
 * scripts an install from before 0.18 left in the checkout. It checks that
 * none of the rewrites runs while the real scripts still do their jobs. The
 * autofix job's bounds check gets the same test in autofix-push.test.mjs.
 */

const JOBS = jobsOf('review');
const REVIEW_TEXT = workflowText('review');

// Where a pipeline script can sit within the agent's reach: the job's own
// read-only copies, and the paths an install from before 0.18 left in the
// checkout (an adopter mid-upgrade still has them).
const COPIES = ['gate.cjs', 'review-lint.cjs', 'ecosystems.cjs'];
const LEGACY_SCRIPTS = ['.github/dependabot-automerge/gate.cjs', '.github/dependabot-automerge/review-lint.cjs'];

// The tools action as a runner runs it: its composite step's own script,
// with this action's directory as GITHUB_ACTION_PATH and gh answered by the
// stub. What it appends to GITHUB_ENV reaches later steps.
const ACTION_YML = readFileSync(join(TOOLS_DIR, 'action.yml'), 'utf8');
const ACTION_SCRIPT = (() => {
  const lines = ACTION_YML.split('\n');
  const i = lines.findIndex((l) => /^\s+run: \|\s*$/.test(l));
  assert.ok(i > 0, 'the tools action runs one script');
  const indent = /^(\s*)/.exec(lines[i + 1])[1].length;
  const body = [];
  for (const l of lines.slice(i + 1)) {
    if (l.trim() !== '' && /^(\s*)/.exec(l)[1].length < indent) break;
    body.push(l.slice(indent));
  }
  return body.join('\n');
})();

function realTools(runnerEnv) {
  return async ({ with: w }) => {
    const githubEnv = join(runnerEnv.RUNNER_TEMP, '..', `github_env_${Date.now()}_${Math.random()}`);
    writeFileSync(githubEnv, '');
    const r = spawnSync('bash', ['-c', ACTION_SCRIPT], {
      encoding: 'utf8',
      env: {
        ...runnerEnv,
        GH_TOKEN: w['github-token'],
        ASSIGNEE: w.assignee ?? '',
        REPO: 'octocat/repo',
        GITHUB_ACTION_PATH: TOOLS_DIR,
        GITHUB_ENV: githubEnv,
      },
    });
    const env = {};
    const m = /^ROOT_FILES<<(\S+)\n([\s\S]*?)\n\1$/m.exec(readFileSync(githubEnv, 'utf8'));
    if (m) env.ROOT_FILES = m[2];
    return { exitCode: r.status, output: r.stdout + r.stderr, env };
  };
}

const SINGLETON = 'dependabot/npm_and_yarn/ioredis-6.0.0';
const REVIEW_STARTED = '2026-09-23T10:00:00Z';
const POSTED_AT = '2026-09-23T10:03:00Z';

const WORKFLOW_TOKEN = 'ghs_workflowTokenOfThisRun0000001';

// A verdict that reports on CI (the reviewer never sees CI), and the same
// verdict without that clause.
const CI_REPORTING_VERDICT = `## Dependabot review — ESCALATE

**Assessment**: ESCALATE — a major bump of the repo's core test framework; I could not read CI status from this token to confirm green.

<!-- AUTOMERGE-DECISION-V1 -->
{"recommendation":"escalate","our_usage_affected":true,"reason":"Major vitest bump, and CI status was not readable from this token."}
<!-- /AUTOMERGE-DECISION-V1 -->`;
const CLEAN_VERDICT = `## Dependabot review — ESCALATE

**Assessment**: ESCALATE — the clear-mocks default flip reaches 12 specs that rely on persisted mock state.

<!-- AUTOMERGE-DECISION-V1 -->
{"recommendation":"escalate","our_usage_affected":true,"reason":"vitest 5 flips clearMocks to true by default, which reaches 12 specs."}
<!-- /AUTOMERGE-DECISION-V1 -->`;

// Every gh call the review job makes, answered from canned documents through
// the step's own `--jq` with real jq (strings raw, anything else compact JSON,
// as gh prints them). Comments live in a file, in the REST API's shape, which
// the simulated agent appends to when it posts; `gh pr view --json comments`
// prints the same comments with the bare login, as gh does.
const GH_STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GH_LOG"
flag() { local want="$1" prev='' a; shift; for a in "$@"; do if [ "$prev" = "$want" ]; then printf '%s' "$a"; return; fi; prev="$a"; done; }
if [ "$1" = api ]; then
  case "$*" in
    *repos/octocat/repo/issues/1/comments*) doc=$(cat "$PR_COMMENTS_FILE") ;;
    *repos/octocat/repo/git/trees/main*) doc=$(printf '%s\\n' $ROOT_FILE_NAMES | jq -Rsc '{tree: [split("\\n")[] | select(. != "") | {path: ., type: "blob"}]}') ;;
    "api repos/octocat/repo --jq .default_branch") doc='{"default_branch":"main"}' ;;
    *) echo "gh stub: unexpected call: $*" >&2; exit 1 ;;
  esac
else
  case "$1 $2" in
    "pr view")
      case "$(flag --json "$@")" in
        author) doc='{"author":{"is_bot":true,"login":"app/dependabot"}}' ;;
        headRefName,state) doc="{\\"headRefName\\":\\"$HEAD_BRANCH\\",\\"state\\":\\"OPEN\\"}" ;;
        comments) doc=$(jq -c '{comments: [.[] | {author: {login: (.user.login | rtrimstr("[bot]"))}, body, createdAt: .created_at}]}' "$PR_COMMENTS_FILE") ;;
        *) echo "gh stub: no canned answer for: $*" >&2; exit 1 ;;
      esac ;;
    "pr diff") echo package.json; exit 0 ;;
    "pr edit") exit 0 ;;
    *) echo "gh stub: unexpected call: $*" >&2; exit 1 ;;
  esac
fi
expr=$(flag --jq "$@")
if [ -n "$expr" ]; then printf '%s' "$doc" | jq -rc "$expr"; else printf '%s\\n' "$doc"; fi
`;

// GNU date's `-d` does not exist on BSD/macOS, and the instant is not under test.
const DATE_STUB = `#!/usr/bin/env bash
echo "${REVIEW_STARTED}"
`;

/**
 * Run the rendered review job on a Dependabot PR, with a reviewer that first
 * rewrites every pipeline script in the checkout (each rewrite records that it
 * ran), then tries to post each of `drafts` in turn through the one door it
 * has: `gh pr comment --body-file`, which Claude Code runs only after the
 * PreToolUse hook from the step's `settings` input allows it.
 */
async function runReview({ drafts, runnerTemp: sharedTemp }) {
  const root = mkdtempSync(join(tmpdir(), 'ds-aw-'));
  const work = join(root, 'work');
  const bin = join(root, 'bin');
  const runnerTemp = sharedTemp ?? join(root, 'runner-temp');
  for (const d of [work, bin, runnerTemp]) mkdirSync(d, { recursive: true });
  for (const f of LEGACY_SCRIPTS) {
    mkdirSync(dirname(join(work, f)), { recursive: true });
    writeFileSync(join(work, f), readFileSync(join(TOOLS_DIR, basename(f))));
  }
  const ran = join(root, 'ran');
  const commentsFile = join(root, 'comments.json');
  writeFileSync(commentsFile, '[]');
  writeFileSync(join(bin, 'gh'), GH_STUB, { mode: 0o755 });
  writeFileSync(join(bin, 'date'), DATE_STUB, { mode: 0o755 });
  const ghLog = join(bin, 'gh.log');
  writeFileSync(ghLog, '');

  // What every step, and the Claude session, starts from on a runner.
  const runnerEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    RUNNER_TEMP: runnerTemp,
    GH_LOG: ghLog,
    PR_COMMENTS_FILE: commentsFile,
    HEAD_BRANCH: SINGLETON,
    ROOT_FILE_NAMES: REFERENCE_ROOT_FILES.join(' '),
  };

  const hookRuns = [];
  const copyWritesRefused = [];
  const uses = {
    // The tree above already is the checkout.
    'actions/checkout': async () => ({ exitCode: 0 }),
    [TOOLS_ACTION]: realTools(runnerEnv),
    'anthropics/claude-code-action': async ({ with: w, env }) => {
      const rewrite = (f) => [
        `require('fs').appendFileSync(${JSON.stringify(ran)}, ${JSON.stringify(`${f}\n`)});`,
        "console.log('group=true');",
        "console.log('decision=post');",
        '',
      ].join('\n');
      for (const f of LEGACY_SCRIPTS) writeFileSync(join(work, f), rewrite(f));
      for (const f of COPIES) {
        const p = join(runnerTemp, 'dep-steward', f);
        try { writeFileSync(p, rewrite(p)); } catch { copyWritesRefused.push(f); }
      }
      const [hook] = JSON.parse(w.settings).hooks.PreToolUse.find((h) => h.matcher === 'Bash').hooks;
      const command = 'gh pr comment 1 --body-file .dep-steward-review.md';
      for (const draft of drafts) {
        writeFileSync(join(work, '.dep-steward-review.md'), draft);
        // As Claude Code runs a command hook: through the shell, in the
        // session's environment plus CLAUDE_PROJECT_DIR, the tool call on stdin.
        const h = spawnSync('sh', ['-c', hook.command], {
          cwd: work,
          encoding: 'utf8',
          input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: work }),
          env: { ...runnerEnv, ...env, CLAUDE_PROJECT_DIR: work },
        });
        hookRuns.push({ status: h.status, stderr: h.stderr });
        if (h.status === 2) continue; // refused: the agent rewrites the draft and tries again
        // claude-code-action posts with the token its `github_token` input
        // provides, and without one mints the Claude App's (setupGitHubToken),
        // so the comment is github-actions' only when the step hands it this
        // job's GITHUB_TOKEN.
        const poster = w.github_token === WORKFLOW_TOKEN
          ? { login: 'github-actions[bot]', type: 'Bot' }
          : { login: 'claude[bot]', type: 'Bot' };
        const doc = JSON.parse(readFileSync(commentsFile, 'utf8'));
        doc.push({ user: poster, body: draft, created_at: POSTED_AT });
        writeFileSync(commentsFile, JSON.stringify(doc));
      }
      return { exitCode: 0, outputs: { execution_file: '' } };
    },
  };

  const result = await runJob(JOBS, 'review', {
    inputs: { ...inputDefaults(REVIEW_TEXT), assignee: 'octocat' },
    workflowEnv: topLevelEnv(REVIEW_TEXT),
    github: {
      event_name: 'pull_request',
      repository: 'octocat/repo',
      actor: 'dependabot[bot]',
      event: {
        pull_request: { number: 1, user: { login: 'dependabot[bot]' } },
        sender: { login: 'dependabot[bot]', type: 'Bot' },
      },
    },
    secrets: { GITHUB_TOKEN: WORKFLOW_TOKEN, CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-test' },
    uses,
    cwd: work,
    env: runnerEnv,
  });
  return {
    failed: result.failed,
    skipped: result.skipped,
    hookRuns,
    copyWritesRefused,
    ran: existsSync(ran) ? readFileSync(ran, 'utf8').split('\n').filter(Boolean) : [],
    runnerTemp,
    log: result.steps.map((s) => `--- ${s.name} [${s.status}]\n${s.output}`).join('\n'),
  };
}

test('a reviewer that rewrites the pipeline\'s scripts gets none of them run, and the real ones still do their jobs', async () => {
  const r = await runReview({ drafts: [CI_REPORTING_VERDICT, CLEAN_VERDICT] });
  assert.equal(r.skipped, false, 'the review job must run for a Dependabot PR');
  assert.deepEqual(r.ran, [], `a script the agent rewrote was run:\n${r.log}`);
  assert.deepEqual(r.copyWritesRefused, COPIES, 'the copies the job runs must refuse the agent\'s writes');
  // The hook is the real lint: it refuses the verdict that reports on CI and
  // lets the clean one through.
  assert.deepEqual(r.hookRuns.map((h) => h.status), [2, 0], JSON.stringify(r.hookRuns, null, 2));
  assert.match(r.hookRuns[0].stderr, /review-lint refused this comment/);
  // And the deliverable assertion used the real gate to classify the PR (a
  // singleton, so a verdict is owed) and the real lint on what was posted.
  assert.equal(r.failed, false, r.log);
  assert.match(r.log, /V1 decision block posted during this run/);
  assert.match(r.log, /The review comment passes the prose lint/);
});

test('the copies the review job runs cannot be written, even by a tool that could name their path', async () => {
  // Claude Code already keeps the agent's writes inside the checkout; the
  // copies are read-only as well, so that stays true if the agent is ever
  // given the runner's temp directory.
  const r = await runReview({ drafts: [CLEAN_VERDICT] });
  const dir = join(r.runnerTemp, 'dep-steward');
  for (const p of [dir, join(dir, 'gate.cjs'), join(dir, 'review-lint.cjs')]) {
    assert.ok(existsSync(p), `${p} must exist: the job runs its scripts from there`);
    assert.throws(() => accessSync(p, constants.W_OK), `${p} must not be writable`);
  }
});

test('a runner that kept the last job\'s read-only copies still takes fresh ones', async () => {
  // A self-hosted runner can keep its temp directory between jobs. The copies
  // are read-only, so copying over them would fail every review after the first.
  const runnerTemp = mkdtempSync(join(tmpdir(), 'ds-aw-rt-'));
  await runReview({ drafts: [CLEAN_VERDICT], runnerTemp });
  const r = await runReview({ drafts: [CLEAN_VERDICT], runnerTemp });
  assert.equal(r.failed, false, r.log);
  assert.match(r.log, /The review comment passes the prose lint/);
});
