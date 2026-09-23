import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseJobs, evaluate, runJob } from './lib/actions-sim.mjs';

/**
 * The step simulator (test/lib/actions-sim.mjs) is only as honest as the
 * GitHub rules it copies. Each test here pins one rule the autofix tests rely
 * on, stated in GitHub's docs ("Expressions" and "Workflow syntax": status
 * check functions, `continue-on-error`, operators). If one of these drifts,
 * an autofix test could go green on a workflow GitHub would run differently.
 */

const cwd = mkdtempSync(join(tmpdir(), 'ds-simtest-'));
const github = { event_name: 'workflow_run', repository: 'octocat/repo', event: {} };

function workflow(steps, jobEnv = '') {
  return `name: t\non: push\njobs:\n  j:\n    runs-on: ubuntu-latest\n${jobEnv}    steps:\n${steps}`;
}

test('an if: that names no status function is skipped once a step has failed (implicit success())', async () => {
  const jobs = parseJobs(workflow(`      - name: fails
        run: exit 3
      - name: plain condition
        if: steps.none.outputs.x != 'true'
        run: echo ran
      - name: not cancelled
        if: \${{ !cancelled() }}
        run: echo ran
`));
  const { steps, failed } = await runJob(jobs, 'j', { github, cwd });
  assert.equal(failed, true);
  assert.deepEqual(steps.map((s) => s.status), ['failure', 'skipped', 'success']);
});

test('an unset output is not "true" and not "push" (it compares as null)', () => {
  const ctx = { steps: {}, env: {}, jobFailed: false };
  assert.equal(evaluate("steps.pr.outputs.skip != 'true'", ctx), true);
  assert.equal(evaluate("steps.bounds.outputs.decision == 'push'", ctx), false);
});

test('string equality ignores case, as GitHub documents', () => {
  assert.equal(evaluate("'Push' == 'push'", { jobFailed: false }), true);
});

test('continue-on-error: a failed step does not fail the job, and a default step after it still runs', async () => {
  const jobs = parseJobs(workflow(`      - name: mint
        id: mint
        continue-on-error: true
        run: exit 1
      - name: after
        env:
          TOKEN: \${{ steps.mint.outputs.token }}
          OUTCOME: \${{ steps.mint.outcome }}
          CONCLUSION: \${{ steps.mint.conclusion }}
        run: echo "token=[$TOKEN] outcome=$OUTCOME conclusion=$CONCLUSION"
`));
  const { steps, failed } = await runJob(jobs, 'j', { github, cwd });
  assert.equal(failed, false);
  assert.equal(steps[1].status, 'success');
  assert.match(steps[1].output, /token=\[\] outcome=failure conclusion=success/);
});

test('a job-level env expression over secrets arrives as the text "true" or "false"; a plain value arrives as itself', async () => {
  const jobs = parseJobs(workflow(`      - name: show
        run: echo "configured=$CONFIGURED author=$AUTHOR"
`, `    env:\n      CONFIGURED: \${{ secrets.A != '' || secrets.B != '' }}\n      AUTHOR: dep-steward[bot]\n`));
  const on = await runJob(jobs, 'j', { github, cwd, secrets: { A: 'x', B: '' } });
  const off = await runJob(jobs, 'j', { github, cwd, secrets: { A: '', B: '' } });
  assert.match(on.steps[0].output, /configured=true author=dep-steward\[bot\]/);
  assert.match(off.steps[0].output, /configured=false/);
});

test('the parser refuses a step key it does not simulate, rather than ignoring it', () => {
  const jobs = parseJobs(workflow(`      - name: odd
        shell: pwsh
        run: echo hi
`));
  return assert.rejects(runJob(jobs, 'j', { github, cwd }), /key "shell" is not simulated/);
});
