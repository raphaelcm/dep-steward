import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJobs, evaluate, conditionHolds, runJob } from './lib/actions-sim.mjs';

/**
 * Which wakes reach the gate, and for which PR.
 *
 * The gate runs when CI or the review workflow finishes. CI's runs and the
 * review's pull_request runs are on the PR's branch. A review replay
 * (`gh workflow run dependabot-review.yml -f pr_number=N`) runs on the default
 * branch, and a workflow_run payload carries no inputs, so the review names
 * the PR in its run name and the gate reads it back. A replay that woke
 * nothing would leave its fresh verdict unread until the PR's next CI run,
 * which for a green PR may never come.
 */

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const REFERENCE_MANIFESTS = ['package.json', 'package-lock.json', 'requirements.txt', 'Cargo.toml', 'go.mod', 'Dockerfile'];

function render() {
  const fakeRepo = mkdtempSync(join(tmpdir(), 'ds-wake-repo-'));
  for (const m of REFERENCE_MANIFESTS) writeFileSync(join(fakeRepo, m), '\n');
  const out = mkdtempSync(join(tmpdir(), 'ds-wake-out-'));
  execFileSync(
    'sh',
    [join(REPO, 'install.sh'), '--render-only', '--out', out, '--ci-name', 'CI', '--assignee', 'octocat'],
    { cwd: fakeRepo, env: { ...process.env, DEP_STEWARD_SRC: REPO }, stdio: 'pipe' },
  );
  return out;
}

const out = render();
const REVIEW = readFileSync(join(out, '.github/workflows/dependabot-review.yml'), 'utf8');
const AUTOMERGE = readFileSync(join(out, '.github/workflows/dependabot-automerge.yml'), 'utf8');
const AM_JOBS = parseJobs(AUTOMERGE);

const ctxWith = (over) => ({ github: {}, inputs: {}, secrets: {}, env: {}, steps: {}, vars: {}, job: {}, runner: {}, needs: {}, ...over });

// A one-line YAML scalar as YAML reads it: a quoted one unquoted, a plain one
// cut at its first ` #`, which starts a comment.
function yamlScalar(raw) {
  const v = raw.trim();
  if (v.startsWith('"')) return JSON.parse(v);
  if (v.startsWith("'")) return v.slice(1, -1).replaceAll("''", "'");
  const comment = v.search(/\s#/);
  return (comment < 0 ? v : v.slice(0, comment)).trim();
}

// The review's run name as GitHub computes it: an empty or blank name means
// GitHub's default for the event.
function reviewRunName(inputs) {
  const m = /^run-name:(.*)$/m.exec(REVIEW);
  assert.ok(m, 'the review workflow must name its runs');
  return evaluate(yamlScalar(m[1]), ctxWith({ inputs }));
}

// gh, answering for three PRs, through each call's own --jq run by real jq.
const PRS = [
  { number: 7, headRefName: 'dependabot/npm_and_yarn/ioredis-6.0.0', state: 'OPEN' },
  { number: 8, headRefName: 'dependabot/npm_and_yarn/left-pad-2.0.0', state: 'CLOSED' },
  { number: 9, headRefName: 'feature/not-a-bump', state: 'OPEN' },
];
const GH_STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GH_LOG"
flag() { local want="$1" prev='' a; shift; for a in "$@"; do if [ "$prev" = "$want" ]; then printf '%s' "$a"; return; fi; prev="$a"; done; }
jqx() { local e; e=$(flag --jq "$@"); jq -rc "\${e:-.}"; }
case "$1 $2" in
  "pr list")
    printf '%s' "$PRS" | jq -c --arg h "$(flag --head "$@")" --arg s "$(flag --state "$@")" \\
      '[.[] | select(.headRefName == $h and (.state | ascii_downcase) == $s) | {number}]' | jqx "$@" ;;
  "pr view")
    doc=$(printf '%s' "$PRS" | jq -c --argjson n "$3" '.[] | select(.number == $n)')
    if [ -z "$doc" ]; then echo "GraphQL: Could not resolve to a PullRequest with the number of $3. (repository.pullRequest)" >&2; exit 1; fi
    printf '%s' "$doc" | jqx "$@" ;;
  *) echo "gh stub: unexpected call: $*" >&2; exit 1 ;;
esac
`;

// Run the automerge workflow's resolve job for one wake.
async function resolveFor(workflowRun) {
  assert.ok(AM_JOBS.resolve, 'the automerge workflow must resolve the PR in a job of its own');
  const bin = mkdtempSync(join(tmpdir(), 'ds-wake-bin-'));
  writeFileSync(join(bin, 'gh'), GH_STUB, { mode: 0o755 });
  const log = join(bin, 'gh.log');
  writeFileSync(log, '');
  const r = await runJob(AM_JOBS, 'resolve', {
    github: { repository: 'octocat/repo', event: { workflow_run: workflowRun, repository: { default_branch: 'main' } } },
    secrets: { GITHUB_TOKEN: 'ghs_test' },
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_LOG: log, PRS: JSON.stringify(PRS) },
  });
  return { ...r, log: r.steps.map((s) => `--- ${s.name} [${s.status}]\n${s.output}`).join('\n') };
}

const BUMP = PRS[0].headRefName;

test('a replay names its PR in its run name; every other run keeps the default name', () => {
  assert.equal(reviewRunName({ pr_number: 7 }), 'Dependabot PR review of #7');
  assert.equal(String(reviewRunName({})).trim(), '');
});

test('CI finishing on a Dependabot PR wakes the gate for that PR', async () => {
  const r = await resolveFor({ event: 'pull_request', name: 'CI', head_branch: BUMP, display_title: 'Bump ioredis from 5.4.1 to 6.0.0' });
  assert.equal(r.skipped, false);
  assert.equal(r.failed, false, r.log);
  assert.deepEqual(r.outputs, { pr_number: '7', head_branch: BUMP });
});

test('the review finishing on a Dependabot PR wakes the gate for that PR', async () => {
  const r = await resolveFor({ event: 'pull_request', name: 'Dependabot PR review', head_branch: BUMP, display_title: 'Bump ioredis from 5.4.1 to 6.0.0' });
  assert.equal(r.failed, false, r.log);
  assert.deepEqual(r.outputs, { pr_number: '7', head_branch: BUMP });
});

test('a replayed review wakes the gate for the PR it replayed, though it ran on the default branch', async () => {
  const r = await resolveFor({ event: 'workflow_dispatch', name: 'Dependabot PR review', head_branch: 'main', display_title: reviewRunName({ pr_number: 7 }) });
  assert.equal(r.skipped, false, 'a replay must wake the gate');
  assert.equal(r.failed, false, r.log);
  assert.deepEqual(r.outputs, { pr_number: '7', head_branch: BUMP });
});

for (const [what, run] of [
  ['a replay of a closed PR', { event: 'workflow_dispatch', name: 'Dependabot PR review', head_branch: 'main', display_title: 'Dependabot PR review of #8' }],
  ['a replay of a PR that is not a Dependabot bump', { event: 'workflow_dispatch', name: 'Dependabot PR review', head_branch: 'main', display_title: 'Dependabot PR review of #9' }],
  ['a replay of a PR that does not exist', { event: 'workflow_dispatch', name: 'Dependabot PR review', head_branch: 'main', display_title: 'Dependabot PR review of #404' }],
  ['a replay whose run name names no PR', { event: 'workflow_dispatch', name: 'Dependabot PR review', head_branch: 'main', display_title: 'Dependabot PR review' }],
  ['a run name that only starts like a replay', { event: 'workflow_dispatch', name: 'Dependabot PR review', head_branch: 'main', display_title: 'Dependabot PR review of #7; and #9' }],
]) {
  test(`${what} resolves no PR, quietly`, async () => {
    const r = await resolveFor(run);
    assert.equal(r.failed, false, `nothing here is a malfunction:\n${r.log}`);
    assert.equal(r.outputs.pr_number ?? '', '', r.log);
  });
}

for (const [what, run] of [
  ['a dispatched CI run', { event: 'workflow_dispatch', name: 'CI', head_branch: 'main', display_title: 'CI' }],
  ["an autofix run (the review workflow's workflow_run event)", { event: 'workflow_run', name: 'Dependabot PR review', head_branch: 'main', display_title: 'Dependabot PR review' }],
  ['CI on a branch that is not a Dependabot bump', { event: 'pull_request', name: 'CI', head_branch: 'feature/not-a-bump', display_title: 'Some feature' }],
]) {
  test(`${what} does not wake the gate`, async () => {
    const r = await resolveFor(run);
    assert.equal(r.skipped, true, r.log);
  });
}

test('the gate runs only for a resolved PR, one run per PR at a time whatever woke it', () => {
  const gate = AM_JOBS['auto-merge'];
  assert.equal(gate.needs, 'resolve');
  const runsFor = (pr) => conditionHolds(gate.if, ctxWith({ needs: { resolve: { result: 'success', outputs: { pr_number: pr } } } }));
  assert.equal(runsFor('7'), true);
  assert.equal(runsFor(''), false);
  // Keyed on the PR, not on the branch of the run that woke it: a replay runs
  // on the default branch, so a branch key would queue every replay together,
  // and GitHub cancels a pending run when another joins its group.
  assert.equal(gate.concurrency.group, 'dependabot-automerge-${{ needs.resolve.outputs.pr_number }}');
  assert.equal(String(gate.concurrency['cancel-in-progress']), 'false');
  const gateText = AUTOMERGE.slice(AUTOMERGE.indexOf('\n  auto-merge:\n'));
  assert.ok(gateText.length > 100, 'the gate job must be the last job, after resolve');
  assert.doesNotMatch(gateText, /github\.event\.workflow_run/, 'the gate takes its PR from resolve, never from the payload');
});

test('resolving holds nothing but read access to pull requests', () => {
  assert.deepEqual(AM_JOBS.resolve.permissions, { 'pull-requests': 'read' });
});
