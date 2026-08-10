import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Tests for the deterministic auto-merge gate (`templates/gate.cjs`, rendered
 * to `.github/dependabot-automerge/gate.cjs` by install.sh). We render the
 * gate fresh from the templates so the tests exercise exactly what an adopter
 * ships, not a hand-copied snapshot.
 *
 * Two branches:
 *   - Group PRs (minor/patch group, branch prefix matches an entry in
 *     ELIGIBLE_GROUP_PREFIXES): zero LLM input — dependabot.yml guarantees
 *     non-major by construction; the gate just verifies CI, author, PR state,
 *     and the path whitelist.
 *   - Singleton / major PRs: the review job posts a fenced
 *     <!-- AUTOMERGE-DECISION-V1 -->{...}<!-- /AUTOMERGE-DECISION-V1 --> block
 *     with recommendation: "merge"|"escalate" and our_usage_affected: boolean.
 *     The gate honours the latest such block from a trusted bot and merges
 *     only when recommendation is `merge` AND our_usage_affected === false AND
 *     every deterministic check ALSO passes. The whitelist + CI checks are
 *     load-bearing: even a maximally-injection-compromised LLM cannot cause a
 *     merge that touches `src/` or that breaks tests.
 *
 * `decision=skip` cases double as the counter-fixtures proving the gate can
 * actually refuse (it is not decoration).
 */

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

function renderGate() {
  const fakeRepo = mkdtempSync(join(tmpdir(), 'ds-repo-'));
  // Multi-ecosystem, so the gate's whitelist + group prefixes cover more than npm.
  for (const m of ['package.json', 'package-lock.json', 'requirements.txt', 'Cargo.toml', 'go.mod', 'Dockerfile']) {
    writeFileSync(join(fakeRepo, m), '\n');
  }
  const out = mkdtempSync(join(tmpdir(), 'ds-out-'));
  execFileSync('sh', [join(REPO, 'install.sh'), '--render-only', '--out', out, '--ci-name', 'CI'], {
    cwd: fakeRepo,
    env: { ...process.env, DEP_STEWARD_SRC: REPO },
    stdio: 'pipe',
  });
  return join(out, '.github', 'dependabot-automerge', 'gate.cjs');
}

const GATE = renderGate();

function runGate(env) {
  const raw = execFileSync('node', [GATE], { env: { ...process.env, ...env }, encoding: 'utf8' });
  const decision = /^decision=(\w+)$/m.exec(raw)?.[1] ?? '';
  const reason = /^reason=(.*)$/m.exec(raw)?.[1] ?? '';
  const code = /^code=(\w+)$/m.exec(raw)?.[1] ?? '';
  const methods = /^methods=([\w,]+)$/m.exec(raw)?.[1] ?? '';
  return { decision, reason, code, methods, raw };
}

// Classify mode (GATE_MODE=classify): the review workflow's deliverable-
// assertion asks the gate "is this branch a group?" so it escalates only the
// singletons/majors that actually need a verdict, never a group PR the gate
// merges on its own.
function classifyGate(headBranch) {
  const raw = execFileSync('node', [GATE], {
    env: { ...process.env, GATE_MODE: 'classify', HEAD_BRANCH: headBranch },
    encoding: 'utf8',
  });
  return raw.trim();
}

// `gh pr list --json author --jq '.[0].author.login'` returns `app/<slug>` for
// GitHub Apps, not the `<slug>[bot]` form event payloads use. OK_NPM matches
// what the workflow actually passes in production — `app/dependabot`.
const OK_NPM = {
  HEAD_BRANCH: 'dependabot/npm_and_yarn/npm-minor-patch-5475a7b965',
  CI_CONCLUSION: 'success',
  PR_AUTHOR: 'app/dependabot',
  PR_STATE: 'OPEN',
  CHANGED_PATHS: 'package.json\npackage-lock.json',
};

const VALID_DECISION = {
  recommendation: 'merge',
  our_usage_affected: false,
  reason: 'no usage of removed APIs in our codebase',
  breaking_changes_enumerated: [
    { description: 'Removed deprecated foo() API', source_url: 'https://example.com/changelog#v6' },
  ],
};

// Default author is `claude` — what anthropics/claude-code-action posts as in
// production. Other trusted forms are exercised in dedicated tests below.
function commentJson(opts = {}) {
  return {
    author: { login: opts.author ?? 'claude', is_bot: true },
    body: opts.body ?? '',
    createdAt: opts.createdAt ?? '2026-05-27T12:00:00Z',
  };
}

function decisionComment(decision, opts = {}) {
  const body = [
    opts.preamble ?? 'Some review prose about the dependency bump.',
    '',
    '<!-- AUTOMERGE-DECISION-V1 -->',
    JSON.stringify(decision, null, 2),
    '<!-- /AUTOMERGE-DECISION-V1 -->',
    '',
    'Additional notes after the decision block.',
  ].join('\n');
  return commentJson({ ...opts, body });
}

const OK_SINGLETON = {
  HEAD_BRANCH: 'dependabot/npm_and_yarn/twilio-6.0.2',
  CI_CONCLUSION: 'success',
  PR_AUTHOR: 'app/dependabot',
  PR_STATE: 'OPEN',
  CHANGED_PATHS: 'package.json\npackage-lock.json',
  PR_COMMENTS_JSON: JSON.stringify([decisionComment(VALID_DECISION)]),
};

test('merges a clean npm-minor-patch group PR (CI green, dependabot, open, whitelisted paths)', () => {
  assert.equal(runGate(OK_NPM).decision, 'merge');
});

test('also accepts the alternate `dependabot[bot]` author form', () => {
  assert.equal(runGate({ ...OK_NPM, PR_AUTHOR: 'dependabot[bot]' }).decision, 'merge');
});

test('merges a clean actions-minor-patch group PR changing only workflow files', () => {
  const { decision } = runGate({
    ...OK_NPM,
    HEAD_BRANCH: 'dependabot/github_actions/actions-minor-patch-9f1c2a',
    CHANGED_PATHS: '.github/workflows/ci.yml\n.github/workflows/release.yml',
  });
  assert.equal(decision, 'merge');
});

test('skips a singleton npm major bump (twilio) when no LLM decision comment is present', () => {
  const { decision, reason } = runGate({ ...OK_NPM, HEAD_BRANCH: 'dependabot/npm_and_yarn/twilio-6.0.2' });
  assert.equal(decision, 'skip');
  assert.match(reason, /automerge-decision|recommendation/i);
});

test('skips a singleton dev-dep major bump (jsdom) when no LLM decision comment is present', () => {
  assert.equal(runGate({ ...OK_NPM, HEAD_BRANCH: 'dependabot/npm_and_yarn/jsdom-29.1.1' }).decision, 'skip');
});

test('skips a singleton github-actions major bump (download-artifact) when no LLM decision comment is present', () => {
  const { decision } = runGate({
    ...OK_NPM,
    HEAD_BRANCH: 'dependabot/github_actions/actions/download-artifact-8',
    CHANGED_PATHS: '.github/workflows/ci.yml',
  });
  assert.equal(decision, 'skip');
});

test('skips when CI did not succeed', () => {
  const { decision, reason } = runGate({ ...OK_NPM, CI_CONCLUSION: 'failure' });
  assert.equal(decision, 'skip');
  assert.match(reason, /ci/i);
});

test('skips when a changed path is outside the whitelist (dependabot touching source)', () => {
  const { decision, reason } = runGate({ ...OK_NPM, CHANGED_PATHS: 'package.json\npackage-lock.json\nsrc/index.ts' });
  assert.equal(decision, 'skip');
  assert.match(reason, /path/i);
});

test('skips when the PR author is not dependabot', () => {
  assert.equal(runGate({ ...OK_NPM, PR_AUTHOR: 'mallory' }).decision, 'skip');
});

test('skips when the PR is not open', () => {
  assert.equal(runGate({ ...OK_NPM, PR_STATE: 'MERGED' }).decision, 'skip');
});

test('skips when there are no changed paths (anomalous group PR)', () => {
  assert.equal(runGate({ ...OK_NPM, CHANGED_PATHS: '' }).decision, 'skip');
});

// ---- Singleton / major-bump path: LLM-emit + deterministic-accept ----

test('merges a singleton when LLM recommends merge + no usage affected + CI green + whitelist holds', () => {
  assert.equal(runGate(OK_SINGLETON).decision, 'merge');
});

test('skips a singleton when the LLM recommendation is "escalate"', () => {
  const { decision, reason } = runGate({
    ...OK_SINGLETON,
    PR_COMMENTS_JSON: JSON.stringify([
      decisionComment({ ...VALID_DECISION, recommendation: 'escalate', reason: 'twilio v6 changes Message.body; we use it' }),
    ]),
  });
  assert.equal(decision, 'skip');
  assert.match(reason, /escalate|recommendation/i);
});

test('skips a singleton when LLM reports our_usage_affected=true (even if recommendation says merge)', () => {
  const { decision, reason } = runGate({
    ...OK_SINGLETON,
    PR_COMMENTS_JSON: JSON.stringify([decisionComment({ ...VALID_DECISION, our_usage_affected: true })]),
  });
  assert.equal(decision, 'skip');
  assert.match(reason, /usage|affected/i);
});

test('skips a singleton when the V1 block contains malformed JSON', () => {
  const malformedBody = ['Review prose.', '<!-- AUTOMERGE-DECISION-V1 -->', '{ this is not valid JSON', '<!-- /AUTOMERGE-DECISION-V1 -->'].join('\n');
  const { decision, reason } = runGate({
    ...OK_SINGLETON,
    PR_COMMENTS_JSON: JSON.stringify([commentJson({ body: malformedBody })]),
  });
  assert.equal(decision, 'skip');
  assert.match(reason, /malformed|invalid|parse/i);
});

test('skips a singleton when the V1 block is missing required fields', () => {
  const { decision, reason } = runGate({
    ...OK_SINGLETON,
    PR_COMMENTS_JSON: JSON.stringify([decisionComment({ recommendation: 'merge' })]), // missing our_usage_affected
  });
  assert.equal(decision, 'skip');
  assert.match(reason, /malformed|invalid|shape|field/i);
});

test('ignores a V1 block authored by an untrusted commenter (treats it as missing)', () => {
  const { decision, reason } = runGate({
    ...OK_SINGLETON,
    PR_COMMENTS_JSON: JSON.stringify([decisionComment(VALID_DECISION, { author: 'mallory' })]),
  });
  assert.equal(decision, 'skip');
  assert.match(reason, /automerge-decision|recommendation/i);
});

test('singleton merge respects whitelist — LLM cannot override path safety', () => {
  const { decision, reason } = runGate({ ...OK_SINGLETON, CHANGED_PATHS: 'package.json\npackage-lock.json\nsrc/sms.ts' });
  assert.equal(decision, 'skip');
  assert.match(reason, /path/i);
});

test('singleton merge respects CI — LLM cannot override CI status', () => {
  const { decision, reason } = runGate({ ...OK_SINGLETON, CI_CONCLUSION: 'failure' });
  assert.equal(decision, 'skip');
  assert.match(reason, /ci/i);
});

test('uses the latest V1 block when multiple comments contain one (LLM may post several)', () => {
  const older = decisionComment({ ...VALID_DECISION, recommendation: 'escalate' }, { createdAt: '2026-05-27T10:00:00Z' });
  const newer = decisionComment(VALID_DECISION, { createdAt: '2026-05-27T15:00:00Z' });
  assert.equal(runGate({ ...OK_SINGLETON, PR_COMMENTS_JSON: JSON.stringify([older, newer]) }).decision, 'merge');
});

for (const [author, note] of [
  ['claude', 'gh-CLI form, current production reality'],
  ['claude[bot]', 'event-payload form for the same Claude GitHub App'],
  ['github-actions[bot]', 'event-payload form if review job ever posts via GITHUB_TOKEN'],
  ['app/github-actions', 'gh-CLI form for the same'],
]) {
  test(`accepts trusted-author form ${author} (${note})`, () => {
    const { decision } = runGate({
      ...OK_SINGLETON,
      PR_COMMENTS_JSON: JSON.stringify([decisionComment(VALID_DECISION, { author })]),
    });
    assert.equal(decision, 'merge');
  });
}

// ---- Multi-ecosystem: the whitelist + group prefixes cover every configured ecosystem ----

const BASE = { CI_CONCLUSION: 'success', PR_AUTHOR: 'app/dependabot', PR_STATE: 'OPEN' };

for (const [eco, branch, paths] of [
  ['cargo', 'dependabot/cargo/cargo-minor-patch-a', 'Cargo.toml\nCargo.lock'],
  ['go modules (slug go_modules ≠ config gomod)', 'dependabot/go_modules/gomod-minor-patch-a', 'go.mod\ngo.sum'],
  ['pip', 'dependabot/pip/pip-minor-patch-a', 'requirements.txt'],
  ['docker', 'dependabot/docker/docker-minor-patch-a', 'Dockerfile'],
]) {
  test(`merges a clean ${eco} group PR`, () => {
    assert.equal(runGate({ ...BASE, HEAD_BRANCH: branch, CHANGED_PATHS: paths }).decision, 'merge');
  });
}

test('pip whitelist accepts requirements-*.txt via regex', () => {
  const { decision } = runGate({
    ...BASE,
    HEAD_BRANCH: 'dependabot/pip/pip-minor-patch-a',
    CHANGED_PATHS: 'requirements.txt\nrequirements-dev.txt',
  });
  assert.equal(decision, 'merge');
});

test('a group PR touching a source file outside the whitelist is skipped (cross-ecosystem)', () => {
  const { decision, reason } = runGate({
    ...BASE,
    HEAD_BRANCH: 'dependabot/cargo/cargo-minor-patch-a',
    CHANGED_PATHS: 'Cargo.toml\nsrc/main.rs',
  });
  assert.equal(decision, 'skip');
  assert.match(reason, /whitelist/);
});

test('docker whitelist is conservative: a k8s YAML image bump is NOT auto-merged (escalates)', () => {
  const { decision } = runGate({
    ...BASE,
    HEAD_BRANCH: 'dependabot/docker/docker-minor-patch-a',
    CHANGED_PATHS: 'k8s/deploy.yaml',
  });
  assert.equal(decision, 'skip');
});

// ---- Refusal codes: telling "not yet" from "never" ----
//
// `reason` is prose for a human reading the log; `code` is the stable identifier
// the workflow branches on to decide whether a refusal reaches a person. They are
// separate so the caller never re-parses prose to make that call.
//
// The distinction that matters: a refusal that will resolve on its own (CI still
// running, review not posted yet) MUST stay silent, because the gate wakes on
// every CI completion and every bot comment. One that never will has to reach
// someone, or the PR is refused forever with nobody told.

for (const [label, env, want] of [
  ['a clean group PR', OK_NPM, 'ok_group'],
  ['a clean singleton', OK_SINGLETON, 'ok_singleton'],
  ['CI still running', { ...OK_NPM, CI_CONCLUSION: 'pending' }, 'ci_pending'],
  ['CI not queried yet (empty)', { ...OK_NPM, CI_CONCLUSION: '' }, 'ci_pending'],
  ['CI in progress', { ...OK_NPM, CI_CONCLUSION: 'in_progress' }, 'ci_pending'],
  ['CI red', { ...OK_NPM, CI_CONCLUSION: 'failure' }, 'ci_failed'],
  ['CI cancelled', { ...OK_NPM, CI_CONCLUSION: 'cancelled' }, 'ci_indeterminate'],
  ['CI timed out', { ...OK_NPM, CI_CONCLUSION: 'timed_out' }, 'ci_indeterminate'],
  ['CI awaiting approval', { ...OK_NPM, CI_CONCLUSION: 'action_required' }, 'ci_indeterminate'],
  ['a source file in the diff', { ...OK_NPM, CHANGED_PATHS: 'package.json\nsrc/index.ts' }, 'paths_not_whitelisted'],
  ['not a Dependabot PR', { ...OK_NPM, PR_AUTHOR: 'mallory' }, 'author_not_dependabot'],
  ['the PR is closed', { ...OK_NPM, PR_STATE: 'MERGED' }, 'pr_not_open'],
  ['an empty diff', { ...OK_NPM, CHANGED_PATHS: '' }, 'no_changed_paths'],
  ['no verdict posted yet', { ...OK_NPM, HEAD_BRANCH: 'dependabot/npm_and_yarn/twilio-6.0.2' }, 'verdict_missing'],
  ['the reviewer said escalate', {
    ...OK_SINGLETON,
    PR_COMMENTS_JSON: JSON.stringify([decisionComment({ ...VALID_DECISION, recommendation: 'escalate' })]),
  }, 'verdict_escalate'],
  ['the reviewer found affected usage', {
    ...OK_SINGLETON,
    PR_COMMENTS_JSON: JSON.stringify([decisionComment({ ...VALID_DECISION, our_usage_affected: true })]),
  }, 'usage_affected'],
]) {
  test(`code: ${label} -> ${want}`, () => {
    assert.equal(runGate(env).code, want);
  });
}

// The three verdict-parsing failures all collapse to ONE code, because the
// caller's question is the same for all of them: a trusted commenter posted
// something the gate cannot read, and it never will be readable without a human.
for (const [label, body] of [
  ['malformed JSON inside the block', ['<!-- AUTOMERGE-DECISION-V1 -->', '{ not json', '<!-- /AUTOMERGE-DECISION-V1 -->'].join('\n')],
  ['an unclosed block (truncated comment)', ['<!-- AUTOMERGE-DECISION-V1 -->', '{"recommendation":"merge"'].join('\n')],
]) {
  test(`code: ${label} -> verdict_malformed`, () => {
    const { decision, code } = runGate({
      ...OK_SINGLETON,
      PR_COMMENTS_JSON: JSON.stringify([commentJson({ body })]),
    });
    assert.equal(decision, 'skip');
    assert.equal(code, 'verdict_malformed');
  });
}

test('code: a well-formed block missing a required field is verdict_malformed, not verdict_missing', () => {
  // These must not collapse. `verdict_missing` is transient (the review may still
  // be running) and is already owned by the review job's deliverable-assertion;
  // `verdict_malformed` is terminal and owned by nobody. Treating this as
  // "missing" would route a permanent failure into the silent branch.
  const { code } = runGate({
    ...OK_SINGLETON,
    PR_COMMENTS_JSON: JSON.stringify([decisionComment({ recommendation: 'merge' })]),
  });
  assert.equal(code, 'verdict_malformed');
});

test('code: every refusal carries one, and it is never empty', () => {
  // An empty code would fall through the workflow's `case` into silence, which
  // is the failure this whole mechanism exists to prevent — so a new refusal
  // path that forgets its code has to fail here rather than go quiet in prod.
  for (const env of [
    OK_NPM,
    { ...OK_NPM, CI_CONCLUSION: 'failure' },
    { ...OK_NPM, PR_AUTHOR: 'mallory' },
    { ...OK_NPM, PR_STATE: 'CLOSED' },
    { ...OK_NPM, CHANGED_PATHS: '' },
    { ...OK_NPM, CHANGED_PATHS: 'src/x.ts' },
    { ...OK_NPM, HEAD_BRANCH: 'dependabot/npm_and_yarn/twilio-6.0.2' },
    OK_SINGLETON,
  ]) {
    const { code } = runGate(env);
    assert.match(code, /^[a-z_]+$/, `empty or malformed code for ${JSON.stringify(env.HEAD_BRANCH)}`);
  }
});

// ---- Merge methods: a RANKED LIST over the changed paths and what this repo
// ---- appears to allow ------------------------------------------------------
//
// The list must survive to the caller intact. No pre-flight query can predict
// which method GitHub accepts: classic branch protection needs admin to read
// (no workflow `permissions:` key grants it) and the App-workflow-scope refusal
// is not a repo setting at all. Emitting only the head is how a repo whose
// readable layers all said "merge is fine" got one refusal and a paged human
// while two working methods went untried (Runsense-ai/runsense#2333).
//
// Ranking:
//   workflow-touching -> merge, rebase, squash. GITHUB_TOKEN can never hold the
//     `workflows` permission, so an App-authored NEW commit editing a workflow
//     file is refused. A merge commit authors none. A rebase keeps Dependabot as
//     the author and is demonstrated to work for workflow-file PRs under
//     GITHUB_TOKEN (Runsense-ai/runsense#2007), which is what makes it a real
//     second choice on any repo enforcing linear history. A squash always
//     produces an App-authored commit, so it is last.
//   everything else   -> squash, rebase, merge (squash is the repo default).

const ALL_METHODS = 'merge,squash,rebase';
const WF_PATHS = '.github/workflows/ci.yml';
const WF_BRANCH = 'dependabot/github_actions/actions-minor-patch-a';

for (const [label, changedPaths, headBranch, allowed, want] of [
  ['workflow-touching + everything allowed ranks the merge commit first', WF_PATHS, WF_BRANCH, ALL_METHODS, 'merge,rebase,squash'],
  ['workflow-touching without merge commits leads with rebase', WF_PATHS, WF_BRANCH, 'squash,rebase', 'rebase,squash'],
  ['workflow-touching with only squash left takes squash', WF_PATHS, WF_BRANCH, 'squash', 'squash'],
  ['a routine bump leads with squash', 'package.json', OK_NPM.HEAD_BRANCH, ALL_METHODS, 'squash,rebase,merge'],
  ['a routine bump without squash leads with rebase', 'package.json', OK_NPM.HEAD_BRANCH, 'merge,rebase', 'rebase,merge'],
  ['a routine bump with only merge commits takes merge', 'package.json', OK_NPM.HEAD_BRANCH, 'merge', 'merge'],
  ['a mixed PR touching any workflow file uses the workflow ranking', 'package.json\n.github/workflows/ci.yml', WF_BRANCH, ALL_METHODS, 'merge,rebase,squash'],
]) {
  test(`methods: ${label}`, () => {
    const { methods } = runGate({
      ...BASE, HEAD_BRANCH: headBranch, CHANGED_PATHS: changedPaths, ALLOWED_MERGE_METHODS: allowed,
    });
    assert.equal(methods, want);
  });
}

test('methods: every permitted method survives, in rank order — the caller needs the fallbacks, not just the winner', () => {
  // The whole defect this list exists to fix: the second and third choices are
  // what a repo with an unreadable restriction actually merges with. A single
  // name here is a regression no matter how well it is ranked.
  const { methods } = runGate({ ...BASE, HEAD_BRANCH: WF_BRANCH, CHANGED_PATHS: WF_PATHS, ALLOWED_MERGE_METHODS: ALL_METHODS });
  assert.equal(methods.split(',').length, 3);
});

test('methods: a repo that allows nothing yields "none", so the caller escalates instead of passing an invalid flag', () => {
  const { methods } = runGate({ ...OK_NPM, ALLOWED_MERGE_METHODS: 'none' });
  assert.equal(methods, 'none');
});

test('methods: an unreadable setting is NOT "nothing allowed" — it keeps the FULL ranked list', () => {
  // The empty string is reserved for "the workflow could not read the setting".
  // Collapsing that into "nothing is allowed" would strand every PR on a
  // transient API blip; collapsing it the other way would act on a setting we
  // never read. Both cases must stay distinguishable, so this asserts the
  // fallback while the test above asserts the real empty set.
  //
  // And the list must not NARROW here: a failed query is exactly when the first
  // choice is least trustworthy, so it is exactly when the fallbacks matter most.
  assert.equal(runGate({ ...OK_NPM, ALLOWED_MERGE_METHODS: '' }).methods, 'squash,rebase,merge');
  const { methods } = runGate({ ...BASE, HEAD_BRANCH: WF_BRANCH, CHANGED_PATHS: WF_PATHS, ALLOWED_MERGE_METHODS: '' });
  assert.equal(methods, 'merge,rebase,squash');
});

test('methods: unknown method names are ignored, not trusted', () => {
  const { methods } = runGate({ ...OK_NPM, ALLOWED_MERGE_METHODS: 'fast-forward,squash' });
  assert.equal(methods, 'squash');
});

test('methods= is emitted on a skip too, so the caller never computes it', () => {
  // The caller reads `methods=` unconditionally. If the gate only printed it
  // alongside `decision=merge`, the refusal path would silently parse an empty
  // METHODS and the disarm branch would run with it.
  const { decision, methods } = runGate({ ...OK_NPM, CI_CONCLUSION: 'failure', ALLOWED_MERGE_METHODS: ALL_METHODS });
  assert.equal(decision, 'skip');
  assert.equal(methods, 'squash,rebase,merge');
});

// ---- Classify mode: group-ness for the deliverable-assertion. Same
// ELIGIBLE_GROUP_PREFIXES as the merge path, so a group PR the gate can merge
// without a verdict is never escalated to a human, while a singleton/major whose
// review produced nothing still is. ----

test('classify: a minor/patch group branch is group=true (assertion skips it)', () => {
  assert.equal(classifyGate('dependabot/npm_and_yarn/npm-minor-patch-5475a7b965'), 'group=true');
});

test('classify: a singleton/major branch is group=false (missing verdict escalates)', () => {
  assert.equal(classifyGate('dependabot/npm_and_yarn/twilio-6.0.2'), 'group=false');
});

test('classify: an empty or non-dependabot branch is group=false (conservative — escalate)', () => {
  assert.equal(classifyGate(''), 'group=false');
  assert.equal(classifyGate('feature/whatever'), 'group=false');
});

for (const [eco, branch] of [
  ['npm', 'dependabot/npm_and_yarn/npm-minor-patch-a'],
  ['cargo', 'dependabot/cargo/cargo-minor-patch-a'],
  ['go modules (slug go_modules ≠ config gomod)', 'dependabot/go_modules/gomod-minor-patch-a'],
  ['pip', 'dependabot/pip/pip-minor-patch-a'],
  ['docker', 'dependabot/docker/docker-minor-patch-a'],
  ['github-actions', 'dependabot/github_actions/actions-minor-patch-a'],
]) {
  test(`classify: ${eco} group branch is group=true`, () => {
    assert.equal(classifyGate(branch), 'group=true');
  });
}
