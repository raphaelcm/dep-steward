import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, accessSync, constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJobs, runJob } from './lib/actions-sim.mjs';

/**
 * Nothing an agent writes is ever run.
 *
 * Both agents can write files: the reviewer its comment draft, the fixer the
 * source it fixes. Claude Code lets them write anywhere in the checkout except
 * a few protected paths (.git, .claude, ...), and the checkout also holds this
 * pipeline's own scripts. So a script a job runs after its agent has started
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
 * So every such script runs from a copy taken before the agent starts, kept
 * outside the checkout, where Claude Code does not let the agent write, and
 * made read-only as well. This file runs the review job with a reviewer that
 * rewrites every pipeline script it can reach, and checks that none of the
 * rewrites runs while the real scripts still do their jobs. The autofix job's
 * bounds check gets the same test in autofix-push.test.mjs.
 */

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const REFERENCE_MANIFESTS = ['package.json', 'package-lock.json', 'requirements.txt', 'Cargo.toml', 'go.mod', 'Dockerfile'];

function render() {
  const fakeRepo = mkdtempSync(join(tmpdir(), 'ds-aw-repo-'));
  for (const m of REFERENCE_MANIFESTS) writeFileSync(join(fakeRepo, m), '\n');
  const out = mkdtempSync(join(tmpdir(), 'ds-aw-out-'));
  execFileSync(
    'sh',
    [join(REPO, 'install.sh'), '--render-only', '--out', out, '--ci-name', 'CI', '--assignee', 'octocat'],
    { cwd: fakeRepo, env: { ...process.env, DEP_STEWARD_SRC: REPO }, stdio: 'pipe' },
  );
  return out;
}

const RENDERED = render();
const JOBS = parseJobs(readFileSync(join(RENDERED, '.github/workflows/dependabot-review.yml'), 'utf8'));

// The scripts the review job runs, as the installer lays them out.
const PIPELINE_SCRIPTS = ['.github/dependabot-automerge/gate.cjs', '.github/dependabot-automerge/review-lint.cjs'];

const SINGLETON = 'dependabot/npm_and_yarn/ioredis-6.0.0';
const REVIEW_STARTED = '2026-09-23T10:00:00Z';
const POSTED_AT = '2026-09-23T10:03:00Z';

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
// the step's own `--jq` with real jq. Comments come from a file the simulated
// agent appends to when it posts.
const GH_STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GH_LOG"
flag() { local want="$1" prev='' a; shift; for a in "$@"; do if [ "$prev" = "$want" ]; then printf '%s' "$a"; return; fi; prev="$a"; done; }
case "$1 $2" in
  "pr view")
    case "$(flag --json "$@")" in
      author) doc='{"author":{"login":"app/dependabot"}}' ;;
      headRefName,state) doc="{\\"headRefName\\":\\"$HEAD_BRANCH\\",\\"state\\":\\"OPEN\\"}" ;;
      comments) doc=$(cat "$PR_COMMENTS_FILE") ;;
      *) echo "gh stub: no canned answer for: $*" >&2; exit 1 ;;
    esac ;;
  "pr diff") echo package.json; exit 0 ;;
  "pr edit") exit 0 ;;
  *) echo "gh stub: unexpected call: $*" >&2; exit 1 ;;
esac
expr=$(flag --jq "$@")
if [ -n "$expr" ]; then printf '%s' "$doc" | jq -r "$expr"; else printf '%s\\n' "$doc"; fi
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
  for (const f of ['.github/dependabot-review-prompt.md', ...PIPELINE_SCRIPTS]) {
    mkdirSync(dirname(join(work, f)), { recursive: true });
    writeFileSync(join(work, f), readFileSync(join(RENDERED, f)));
  }
  const ran = join(root, 'ran');
  const commentsFile = join(root, 'comments.json');
  writeFileSync(commentsFile, JSON.stringify({ comments: [] }));
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
  };

  const hookRuns = [];
  const uses = {
    // The tree above already is the checkout.
    'actions/checkout': async () => ({ exitCode: 0 }),
    'anthropics/claude-code-action': async ({ with: w, env }) => {
      for (const f of PIPELINE_SCRIPTS) {
        writeFileSync(join(work, f), [
          `require('fs').appendFileSync(${JSON.stringify(ran)}, ${JSON.stringify(`${f}\n`)});`,
          "console.log('group=true');",
          "console.log('decision=post');",
          '',
        ].join('\n'));
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
        const doc = JSON.parse(readFileSync(commentsFile, 'utf8'));
        doc.comments.push({ createdAt: POSTED_AT, body: draft });
        writeFileSync(commentsFile, JSON.stringify(doc));
      }
      return { exitCode: 0, outputs: { execution_file: '' } };
    },
  };

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
    uses,
    cwd: work,
    env: runnerEnv,
  });
  return {
    failed: result.failed,
    skipped: result.skipped,
    hookRuns,
    ran: existsSync(ran) ? readFileSync(ran, 'utf8').split('\n').filter(Boolean) : [],
    runnerTemp,
    log: result.steps.map((s) => `--- ${s.name} [${s.status}]\n${s.output}`).join('\n'),
  };
}

test('a reviewer that rewrites the pipeline\'s scripts gets none of them run, and the real ones still do their jobs', async () => {
  const r = await runReview({ drafts: [CI_REPORTING_VERDICT, CLEAN_VERDICT] });
  assert.equal(r.skipped, false, 'the review job must run for a Dependabot PR');
  assert.deepEqual(r.ran, [], `a script the agent rewrote was run:\n${r.log}`);
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
