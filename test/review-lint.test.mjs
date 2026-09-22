import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * review-lint.cjs — the deterministic backstop for the reviewer's evidence
 * contract, in both of its modes.
 *
 * The failure this locks reached a real PR. On Runsense-ai/runsense#2762 the
 * review comment said, in its Assessment line AND in the machine-readable
 * decision block's `reason`, that it could not read CI status from its token —
 * the exact class of statement v0.8.0–v0.8.2 removed from the prompt and which
 * came back anyway. The reviewer runs concurrently with CI on a token with no
 * Checks scope; a sentence about CI is a sentence about evidence it never had,
 * and it inflates operator triage.
 *
 * The prompt is where that was legitimized and the prompt is fixed (see
 * prompt-hygiene.test.mjs). This file covers the part that does not depend on
 * the model: the lint runs as a PreToolUse hook before `gh pr comment`
 * executes, and again over the posted comment in the review job's assertion.
 *
 * The hard half is NOT flagging legitimate text. A reviewer quoting a test
 * framework's release notes writes "Cannot use --watch in CI" verbatim, and a
 * guard that made it paraphrase would corrupt `breaking_changes_enumerated`,
 * whose contract is "verbatim from changelog". So only the reviewer's own
 * voice is linted, every finding needs a failure to PERCEIVE (not a bare
 * "cannot"), and the negative fixtures here are real upstream phrasings and
 * the impact sentences the prompt itself asks for.
 */

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const LINT = join(REPO, 'templates', 'review-lint.cjs');

// ---- body mode ------------------------------------------------------------

function runBody(body) {
  const raw = execFileSync('node', [LINT], {
    env: { ...process.env, REVIEW_LINT_MODE: 'body', REVIEW_BODY: body },
    encoding: 'utf8',
  });
  return {
    decision: /^decision=(\w+)$/m.exec(raw)?.[1] ?? '',
    reason: /^reason=(.*)$/m.exec(raw)?.[1] ?? '',
  };
}

// The two clauses that actually reached PR #2762, verbatim.
const LEAKED_ASSESSMENT =
  '**Assessment**: ESCALATE — a major bump of the repo\'s core test framework with multiple breaking changes (clear-mocks default flip, config-resolution and reporter-output-path changes, async-assertion failure semantics) that plausibly alter behavior across the whole suite; I could not read CI status from this token to confirm green, and per this repo\'s own laws the test suite is the product\'s quality signal, so this warrants a human glance rather than an auto-merge.';
const LEAKED_REASON =
  'Major vitest 4->5 bump of the repo\'s core test framework; the clear-mocks-by-default flip plus config-resolution and reporter-output-path changes plausibly alter behavior across 741 specs and the pre-push/eval log-capture evidence system, and CI status was not readable from this token.';

function v1Block(fields) {
  return `<!-- AUTOMERGE-DECISION-V1 -->\n${JSON.stringify(
    { recommendation: 'escalate', our_usage_affected: true, breaking_changes_enumerated: [], ...fields },
    null,
    2,
  )}\n<!-- /AUTOMERGE-DECISION-V1 -->`;
}

const CLEAN_MERGE = `## Dependabot review — MERGE

**Packages**: lodash 4.17.20 → 4.17.21
**Bump type**: patch
**Changelog scan**: the 4.17.21 notes list one prototype-pollution fix and no API change.
**Usage check**: src/util/group.ts imports \`lodash/groupBy\`; unaffected.

**Assessment**: MERGE — a security patch with no API change, and our only import is unaffected.

${v1Block({ recommendation: 'merge', our_usage_affected: false, reason: 'Patch release fixes prototype pollution; the only import is lodash/groupBy, which is unchanged.' })}`;

// The #2763 shape: the agent probed CI, was denied, and said nothing about it.
const CLEAN_ESCALATE = `## Dependabot review — ESCALATE

**Packages**: vitest 4.1.11 → 5.0.1
**Bump type**: major
**Changelog scan**: v5.0.0 flips \`clearMocks\` to true by default and moves the reporter output path.
**Usage check**: 741 spec files import vitest; 12 call \`vi.fn()\` and rely on state across cases.

### Breaking changes enumerated
- \`clearMocks\` now defaults to true
  - Our usage: test/pad.spec.ts:44 relies on mock state persisting across cases
  - Affected: yes — those cases would start from a cleared mock

**Assessment**: ESCALATE — the clear-mocks default flip reaches 12 specs that rely on mock state persisting.

${v1Block({ reason: 'vitest 5 flips clearMocks to true by default, which reaches 12 specs relying on persisted mock state.' })}`;

test('body: refuses the Assessment sentence that reached PR #2762', () => {
  const { decision, reason } = runBody(LEAKED_ASSESSMENT);
  assert.equal(decision, 'refuse');
  assert.match(reason, /could not read CI status from this token/);
});

test('body: refuses the decision block\'s reason that reached PR #2762', () => {
  // The machine-readable field matters more than the prose: the operator reads
  // the JSON to triage, so a false premise there is the expensive one.
  const { decision, reason } = runBody(`## Dependabot review — ESCALATE\n\n${v1Block({ reason: LEAKED_REASON })}`);
  assert.equal(decision, 'refuse');
  assert.match(reason, /CI status was not readable from this token/);
});

test('body: refuses the pre-v0.8 template line "CI status: could not read"', () => {
  // The original form of this failure, which v0.8.0 deleted from the prompt.
  assert.equal(runBody('**CI status**: could not read').decision, 'refuse');
});

test('body: refuses a first-person confession anywhere in the comment', () => {
  assert.equal(runBody('I have no visibility into the checks API from this run.').decision, 'refuse');
  assert.equal(runBody('We were unable to verify the build status here.').decision, 'refuse');
});

test('body: refuses a claim about this PR\'s CI state — the reviewer cannot know it', () => {
  // It runs concurrently with CI. "CI is green" is a guess even when true, and
  // a public repo's checks page is reachable through the WebFetch allow.
  assert.equal(runBody('CI is green on this head, so this is safe to merge.').decision, 'refuse');
  assert.equal(runBody('CI is still pending on this PR, but the bump looks routine.').decision, 'refuse');
});

test('body: refuses every phrasing of the confession, not just the one that leaked', () => {
  for (const body of [
    'Could not verify CI results for this head.',
    'Unable to confirm the checks are passing from this run.',
    'I cannot tell whether the build is green, so escalating.',
    'The checks API returned 403 on this token.',
    'I could not read CI.',
    "I don't have access to the PR's check results.",
  ]) {
    assert.equal(runBody(body).decision, 'refuse', `must refuse: ${body}`);
  }
});

test('body: a version number does not split a clause and hide the leak', () => {
  // Splitting on every "." would cut 4.1.11 into three clauses and separate the
  // signal from the inability, which is how a naive rule goes quietly vacuous.
  assert.equal(runBody('CI status for vitest 4.1.11 could not be read from this job.').decision, 'refuse');
});

test('body: posts a clean MERGE comment', () => {
  const { decision, reason } = runBody(CLEAN_MERGE);
  assert.equal(decision, 'post', reason);
});

test('body: posts a clean ESCALATE comment (the reviewer that said nothing about CI)', () => {
  const { decision, reason } = runBody(CLEAN_ESCALATE);
  assert.equal(decision, 'post', reason);
});

test('body: posts the impact sentence the prompt itself asks for', () => {
  // The prompt's one question is whether a change REACHES our usage, so a
  // reviewer writes exactly this. A rule keyed on bare "cannot" refused it,
  // and on a bump whose changelog is about CI it would keep refusing until the
  // agent ran out of turns and posted nothing — worse than the leak itself.
  for (const body of [
    'Affected: no — the CI-only reporter change cannot reach our usage; we configure no reporters.',
    'Our usage cannot be affected by the CI reporter change.',
    'I checked the changelog; the CI reporter output path moved, and we do not read it.',
  ]) {
    assert.equal(runBody(body).decision, 'post', `must not refuse the reviewer's own impact analysis: ${body}`);
  }
});

test('body: posts release-note paraphrases from the dependencies whose changelogs are about CI', () => {
  // Build tools, actions/checkout, ci-info, octokit, the artifact actions and
  // the test-reporter actions all describe CI in their release notes, and a
  // reviewer summarises them in its own words on the "Changelog scan" line.
  // "we" and "our" mean this repository in a review, never the reviewer.
  for (const body of [
    '**Changelog scan**: 5.0.1 fixes a bug where the build was failing on Windows.',
    '**Changelog scan**: tests were failing in CI on Node 22 with the new resolver; fixed in 5.0.1.',
    '**Changelog scan**: the CI job cannot check out private submodules without a token.',
    '**Changelog scan**: ci-info 4.1 fixes "could not detect CI" on Buildkite, and could not determine CI vendor before.',
    '**Changelog scan**: octokit v21 cannot access the Actions API without actions: read — we only call the pulls API.',
    "**Changelog scan**: v4 can't view artifacts from other workflow runs; we never download artifacts.",
    '**Changelog scan**: 2.3 fixes being unable to read test results when the path contains spaces.',
  ]) {
    assert.equal(runBody(body).decision, 'post', `must not refuse a changelog summary: ${body}`);
  }
});

test('body: a first-person line inside a blockquote is upstream\'s voice', () => {
  // Maintainers write release notes in the first person too. Only the
  // reviewer's own prose is linted.
  assert.equal(runBody('> I could not reproduce the CI failure on macOS, so this release pins the runner.').decision, 'post');
});

test('body: posts changelog prose that merely mentions CI', () => {
  // Real release-note text for test frameworks and actions. A guard that
  // refused these would make the agent paraphrase upstream, and
  // `breaking_changes_enumerated` is contractually verbatim.
  for (const body of [
    '**Changelog scan**: v5 disables watch mode in CI; `--watch` now errors there.',
    '**Changelog scan**: the reporter prints GitHub annotations in CI and the junit output path moved.',
    '**Changelog scan**: 4.2.0 fixed a bug where status checks could not be required on wildcard branches.',
    '**Changelog scan**: tests were failing on Node 22 with the new resolver; fixed in 5.0.1.',
  ]) {
    assert.equal(runBody(body).decision, 'post', `must not refuse upstream prose: ${body}`);
  }
});

test('body: posts an upstream line quoted in a blockquote or a fence', () => {
  assert.equal(runBody('> Check status could not be verified on forked PRs (fixed in 4.2).').decision, 'post');
  assert.equal(runBody('```\nCheck status could not be verified on forked PRs\n```').decision, 'post');
});

test('body: posts a V1 description quoting upstream, and still reads `reason`', () => {
  // Inside the decision block, `description` is a verbatim quote and `reason`
  // is the reviewer's own sentence — they are judged differently.
  const quoted = v1Block({
    reason: 'v5 renames the reporter option; no usage in this repo.',
    breaking_changes_enumerated: [
      { description: 'Fixed: unable to read test results when the path contains spaces', source_url: 'https://example.test/notes' },
    ],
  });
  assert.equal(runBody(quoted).decision, 'post');
  const leakedReason = v1Block({
    reason: 'Escalating because I could not confirm the check runs from this token.',
    breaking_changes_enumerated: [],
  });
  assert.equal(runBody(leakedReason).decision, 'refuse');
});

test('body: a leak inside a MALFORMED decision block is still caught', () => {
  // gate.cjs refuses a malformed block with `verdict_malformed`, but the lint
  // must not go silent on it — a truncated block is exactly where prose spills.
  const raw = `<!-- AUTOMERGE-DECISION-V1 -->\n{"recommendation": "escalate", "reason": "I could not read the check status from this token"\n<!-- /AUTOMERGE-DECISION-V1 -->`;
  assert.equal(runBody(raw).decision, 'refuse');
});

test('body: an inability unrelated to CI is not a finding', () => {
  // "Changelog unreadable" is a hard-rule ESCALATE reason the prompt ASKS for.
  assert.equal(runBody('ESCALATE — I could not find release notes for 4.2 anywhere.').decision, 'post');
});

test('body: exit is always 0 — the decision is the contract, not the code', () => {
  for (const body of [LEAKED_ASSESSMENT, CLEAN_MERGE, '']) {
    execFileSync('node', [LINT], {
      env: { ...process.env, REVIEW_LINT_MODE: 'body', REVIEW_BODY: body },
      encoding: 'utf8',
    });
  }
});

// ---- hook mode ------------------------------------------------------------
//
// The hook receives Claude Code's PreToolUse JSON on stdin and blocks with
// exit 2, which hands its stderr back to the model as the reason. It fires on
// EVERY Bash call, so the cases that must exit 0 matter as much as the ones
// that must block: a hook that blocked `gh pr diff` would void the review
// while every job stayed green (the diagnose step's denied-diff detector reads
// the SDK's permission record, which a hook block never touches).

function runHook(payload, { cwd } = {}) {
  try {
    const stdout = execFileSync('node', [LINT], {
      input: typeof payload === 'string' ? payload : JSON.stringify(payload),
      encoding: 'utf8',
      stdio: 'pipe',
      cwd: cwd ?? REPO,
    });
    return { status: 0, stdout, stderr: '' };
  } catch (e) {
    return { status: e.status ?? 1, stdout: `${e.stdout ?? ''}`, stderr: `${e.stderr ?? ''}` };
  }
}

function withBodyFile(contents) {
  const dir = mkdtempSync(join(tmpdir(), 'ds-lint-'));
  writeFileSync(join(dir, '.dep-steward-review.md'), contents);
  return dir;
}

const bash = (command, cwd) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd, tool_input: { command } });

test('hook: blocks the post when the body file carries the leak', () => {
  const dir = withBodyFile(`## Dependabot review — ESCALATE\n\n${LEAKED_ASSESSMENT}`);
  const { status, stderr } = runHook(bash('gh pr comment 2762 --body-file .dep-steward-review.md', dir));
  assert.equal(status, 2, 'exit 2 is what blocks the tool call');
  assert.match(stderr, /review-lint refused this comment/);
  assert.match(stderr, /could not read CI status from this token/, 'the model needs the offending clause, not a category');
  assert.match(stderr, /\.dep-steward-review\.md/, 'and the path to rewrite');
});

test('hook: passes a clean body silently', () => {
  const dir = withBodyFile(CLEAN_ESCALATE);
  const { status, stderr } = runHook(bash('gh pr comment 2763 --body-file .dep-steward-review.md', dir));
  assert.equal(status, 0);
  assert.equal(stderr, '');
});

test('hook: the body file resolves against the hook payload\'s cwd', () => {
  // The hook process inherits no working directory from the agent, so a
  // relative --body-file would otherwise be read from the wrong place — and a
  // missing file exits 0, which would make this guard silently vacuous.
  const dir = withBodyFile(LEAKED_ASSESSMENT);
  assert.equal(runHook(bash('gh pr comment 1 --body-file .dep-steward-review.md', dir)).status, 2);
  assert.equal(runHook(bash('gh pr comment 1 --body-file .dep-steward-review.md', REPO)).status, 0,
    'a body file that does not exist is gh\'s error to report, not a block');
});

test('hook: never blocks anything but a comment post', () => {
  const dir = withBodyFile(LEAKED_ASSESSMENT);
  for (const command of [
    'gh pr diff 2762',
    'gh release view v5.0.1 --repo vitest-dev/vitest',
    'gh pr edit 2762 --add-label needs-human-review',
    'grep -rIn vitest src',
  ]) {
    assert.equal(runHook(bash(command, dir)).status, 0, `must not block: ${command}`);
  }
});

test('hook: ignores tools other than Bash', () => {
  assert.equal(
    runHook({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: '.dep-steward-review.md', content: LEAKED_ASSESSMENT } }).status,
    0,
    'the draft may be written freely — only the POST is the deliverable',
  );
});

test('hook: lints an inline --body too', () => {
  assert.equal(runHook(bash(`gh pr comment 2762 --body "${LEAKED_ASSESSMENT.replace(/"/g, '')}"`)).status, 2);
  assert.equal(runHook(bash('gh pr comment 2762 --body "MERGE — patch bump, no usage affected."')).status, 0);
});

test('hook: finds the post inside a compound command', () => {
  const dir = withBodyFile(LEAKED_ASSESSMENT);
  assert.equal(runHook(bash('cd /w && gh pr comment 2762 --body-file .dep-steward-review.md', dir)).status, 2);
});

test('hook: refuses a comment it cannot read before it is posted', () => {
  // Fail CLOSED here, unlike the internal-error path: the workflow's post-hoc
  // check infers "the hook did not fire" from a refusal, and that inference
  // only holds if every form that can post was one the hook could lint.
  for (const command of [
    'gh pr comment 2762 --body-file -',
    'gh pr comment 2762 --editor',
    'gh pr comment 2762',
  ]) {
    const { status, stderr } = runHook(bash(command));
    assert.equal(status, 2, `must refuse an unlintable form: ${command}`);
    assert.match(stderr, /--body-file \.dep-steward-review\.md/, 'and name the form that works');
  }
});

test('hook: a -F that belongs to an earlier command is not the body file', () => {
  // Read as one string, `grep -F x y && gh pr comment …` offered grep's `x`
  // as the body file; it did not exist, the hook exited 0, and the real post
  // went through unlinted. The command is split the way the shell splits it.
  assert.equal(runHook(bash('grep -F x y && gh pr comment 1 --body "I could not read CI status from this token"')).status, 2);
});

test('hook: text inside a quoted body is not a flag or a separator', () => {
  // " -e " is not --editor, and "; |" inside quotes does not end the command.
  assert.equal(runHook(bash('gh pr comment 1 --body "MERGE — pass -e to enable"')).status, 0);
  assert.equal(runHook(bash("gh pr comment 1 --body 'MERGE; patch bump | no usage'")).status, 0);
});

test('hook: every spelling of the body-file flag is read', () => {
  const dir = withBodyFile(LEAKED_ASSESSMENT);
  for (const command of [
    'gh pr comment 1 -F .dep-steward-review.md',
    'gh pr comment 1 -F.dep-steward-review.md',
    'gh pr comment 1 --body-file=.dep-steward-review.md',
  ]) {
    assert.equal(runHook(bash(command, dir)).status, 2, `must read the body from: ${command}`);
  }
});

test('hook: what is not a post is not blocked', () => {
  // Deleting a comment posts nothing, and naming the command is not running it.
  assert.equal(runHook(bash('gh pr comment 1 --delete-last --yes')).status, 0);
  assert.equal(runHook(bash('echo "gh pr comment 1"')).status, 0);
  assert.equal(runHook(bash('gh pr diff 1 | grep -F comment')).status, 0);
});

test('hook: malformed input never blocks (it fails open, the assertion backstops it)', () => {
  // A hook that dies on its own bug must not take the review with it. The
  // review job re-runs this rule over the posted comment, so a silently
  // non-firing hook is caught there instead of stranding every PR here.
  assert.equal(runHook('not json at all').status, 0);
  assert.equal(runHook({ tool_name: 'Bash' }).status, 0);
  assert.equal(runHook({}).status, 0);
});
