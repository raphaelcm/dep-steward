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
  writeFileSync(join(fakeRepo, 'package.json'), '{}\n');
  writeFileSync(join(fakeRepo, 'package-lock.json'), '{}\n');
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
  return { decision, reason, raw };
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
