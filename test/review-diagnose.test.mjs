import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJobs, runJob } from './lib/actions-sim.mjs';

/**
 * A review is void only when it never read the diff.
 *
 * The review job's "Diagnose the review agent" step fails the job when the
 * agent was denied `gh pr diff`, because a verdict on a diff nobody read still
 * looks like a verdict. An agent that read the diff with a plain `gh pr diff`
 * and then tried a compound command its allowlist does not cover
 * (`gh pr diff 3034 > /tmp/d; wc -l /tmp/d`) has read it, and its verdict
 * stands. This file runs the rendered review job with a reviewer whose
 * execution log holds each of those shapes and checks which ones fail.
 */

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const REFERENCE_MANIFESTS = ['package.json', 'package-lock.json', 'requirements.txt', 'Cargo.toml', 'go.mod', 'Dockerfile'];
const DIAGNOSE = 'Diagnose the review agent (tool calls + denials + error)';

function render() {
  const fakeRepo = mkdtempSync(join(tmpdir(), 'ds-rd-repo-'));
  for (const m of REFERENCE_MANIFESTS) writeFileSync(join(fakeRepo, m), '\n');
  const out = mkdtempSync(join(tmpdir(), 'ds-rd-out-'));
  execFileSync(
    'sh',
    [join(REPO, 'plugin', 'install.sh'), '--render-only', '--out', out, '--ci-name', 'CI', '--assignee', 'octocat'],
    { cwd: fakeRepo, env: { ...process.env, DEP_STEWARD_SRC: join(REPO, 'plugin') }, stdio: 'pipe' },
  );
  return out;
}

const RENDERED = render();
const JOBS = parseJobs(readFileSync(join(RENDERED, '.github/workflows/dependabot-review.yml'), 'utf8'));
const PIPELINE_FILES = [
  '.github/dependabot-review-prompt.md',
  '.github/dependabot-automerge/gate.cjs',
  '.github/dependabot-automerge/review-lint.cjs',
];

// Every gh call is logged. The prompt step reads the PR's author, and `gh pr
// edit` (the label the step adds on a void review) succeeds; anything else
// fails, which no step before the one under test needs.
const GH_STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GH_LOG"
case "$1 $2" in
  "pr view") echo 'app/dependabot' ;;
  "pr edit") exit 0 ;;
  *) exit 1 ;;
esac
`;

// GNU date's \`-d\` does not exist on BSD/macOS, and the instant is not under test.
const DATE_STUB = `#!/usr/bin/env bash
echo 2026-10-20T18:00:00Z
`;

// The Bash calls the agent made, in claude-code-action's execution-file shape:
// each call a tool_use, its answer a tool_result, and the session's
// permission_denials on the closing result.
function executionLog(calls) {
  const log = [];
  const denials = [];
  calls.forEach(({ command, denied }, i) => {
    const id = `toolu_${i}`;
    log.push({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
    log.push({
      type: 'user',
      message: {
        content: [
          denied
            ? { type: 'tool_result', tool_use_id: id, is_error: true, content: `This Bash command contains multiple operations. The following parts require approval: ${command}` }
            : { type: 'tool_result', tool_use_id: id, content: 'diff --git a/package.json b/package.json' },
        ],
      },
    });
    if (denied) denials.push({ tool_name: 'Bash', tool_use_id: id, tool_input: { command } });
  });
  log.push({ type: 'result', subtype: 'success', is_error: false, num_turns: calls.length, permission_denials: denials, result: 'Posted the review.' });
  return log;
}

async function runReview(calls) {
  const root = mkdtempSync(join(tmpdir(), 'ds-rd-'));
  const work = join(root, 'work');
  const bin = join(root, 'bin');
  const runnerTemp = join(root, 'runner-temp');
  for (const d of [work, bin, runnerTemp]) mkdirSync(d, { recursive: true });
  for (const f of PIPELINE_FILES) {
    mkdirSync(dirname(join(work, f)), { recursive: true });
    writeFileSync(join(work, f), readFileSync(join(RENDERED, f)));
  }
  writeFileSync(join(bin, 'gh'), GH_STUB, { mode: 0o755 });
  writeFileSync(join(bin, 'date'), DATE_STUB, { mode: 0o755 });
  const ghLog = join(root, 'gh.log');
  writeFileSync(ghLog, '');
  const execFile = join(root, 'claude-execution-output.json');
  writeFileSync(execFile, JSON.stringify(executionLog(calls)));

  const result = await runJob(JOBS, 'review', {
    github: {
      event_name: 'pull_request',
      repository: 'octocat/repo',
      actor: 'dependabot[bot]',
      event: {
        pull_request: { number: 1, user: { login: 'dependabot[bot]' } },
        sender: { login: 'dependabot[bot]', type: 'Bot' },
      },
    },
    secrets: { GITHUB_TOKEN: 'ghs_workflowTokenOfThisRun0000001', CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-test' },
    uses: {
      'actions/checkout': async () => ({ exitCode: 0 }),
      'anthropics/claude-code-action': async () => ({ exitCode: 0, outputs: { execution_file: execFile } }),
    },
    cwd: work,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: runnerTemp, GH_LOG: ghLog },
  });
  const step = result.steps.find((s) => s.name === DIAGNOSE);
  assert.ok(step, `the review job has no "${DIAGNOSE}" step`);
  return { step, ghCalls: readFileSync(ghLog, 'utf8').split('\n').filter(Boolean) };
}

test('a review that read the diff stands, though a compound command over the diff was denied', async () => {
  const { step, ghCalls } = await runReview([
    { command: 'gh pr diff 1' },
    { command: 'gh pr diff 1 > /tmp/pr1.diff; wc -l /tmp/pr1.diff', denied: true },
  ]);
  assert.equal(step.status, 'success', step.output);
  assert.doesNotMatch(step.output, /::error::/);
  assert.deepEqual(ghCalls.filter((c) => c.startsWith('pr edit')), [], 'a review that read the diff is not sent to a person');
});

test('a review whose every `gh pr diff` was denied is void, and goes to a person', async () => {
  const { step, ghCalls } = await runReview([
    { command: 'gh pr diff 1 | head -100', denied: true },
    { command: 'gh pr diff 1 > /tmp/pr1.diff', denied: true },
  ]);
  assert.equal(step.status, 'failure', step.output);
  assert.match(step.output, /::error::The review agent was DENIED 'gh pr diff' on PR #1/);
  assert.equal(ghCalls.filter((c) => c.startsWith('pr edit 1') && c.includes('needs-human-review')).length, 1, ghCalls.join('\n'));
});

test('a review with no denial passes', async () => {
  const { step } = await runReview([{ command: 'gh pr diff 1' }]);
  assert.equal(step.status, 'success', step.output);
});
