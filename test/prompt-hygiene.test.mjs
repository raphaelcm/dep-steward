import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * What the reviewer is given to think about.
 *
 * The reviewer's evidence is the PR diff, the upstream changelog, and this
 * repository's source. It runs concurrently with CI on a token with no Checks
 * scope, so CI is not evidence it has — and v0.8.0 removed the CI *tools* and
 * the CI *question* on exactly that reasoning.
 *
 * It came back anyway. On Runsense-ai/runsense#2762 the agent probed
 * `gh pr checks` (correctly denied), then wrote into its Assessment and into
 * the decision block's machine-readable `reason` that it could not read CI
 * status from its token and was escalating partly for that. On #2763 it probed
 * and said nothing; on #2761 and #2764 it never probed. Probabilistic, which
 * means the denial was not the cause — something still made CI a live thing to
 * reason about.
 *
 * It was this file. The prompt described the gate's merge conditions and
 * listed CI among them ("merges when CI is green", "tests pass (CI)"), so a
 * reviewer composing a verdict about mergeability had CI in scope by
 * construction, and on a test-framework bump went looking for it. The leaked
 * sentence is even built from this prompt's own vocabulary ("a human glance",
 * "auto-merge").
 *
 * So the rule this file locks is not a prohibition — a prohibition is a
 * mention, and naming the behaviour is what invites it. The prompt simply does
 * not talk about CI, in any form, and the gate's conditions are described as
 * the gate's own. The assertion below is over the RENDERED prompt, which is
 * what an adopter ships.
 *
 * Note the complementary guard already in permissions.test.mjs: assertion #3
 * fails on any `gh <verb>` the prompt names that the allow-list lacks, and #10
 * on any allow-listed command the prompt never orders. Together they make
 * "don't name `gh pr checks`, even to forbid it" mechanical rather than a
 * matter of care.
 */

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const REFERENCE_MANIFESTS = ['package.json', 'package-lock.json', 'requirements.txt', 'Cargo.toml', 'go.mod', 'Dockerfile'];

function renderReference() {
  const fakeRepo = mkdtempSync(join(tmpdir(), 'ds-hyg-repo-'));
  for (const m of REFERENCE_MANIFESTS) writeFileSync(join(fakeRepo, m), '\n');
  const out = mkdtempSync(join(tmpdir(), 'ds-hyg-out-'));
  execFileSync(
    'sh',
    [join(REPO, 'install.sh'), '--render-only', '--out', out, '--ci-name', 'CI', '--assignee', 'octocat'],
    { cwd: fakeRepo, env: { ...process.env, DEP_STEWARD_SRC: REPO }, stdio: 'pipe' },
  );
  return out;
}

const rendered = renderReference();
const PROMPT = readFileSync(join(rendered, '.github/dependabot-review-prompt.md'), 'utf8');

// Every way the old prompt (and the leaked comments) talked about CI. A bare
// /\bchecks?\b/ is deliberately absent: the output template's "**Usage
// check**:" line uses the word in its ordinary sense, and a rule that cannot
// be satisfied gets deleted rather than obeyed.
const CI_VOCABULARY = [
  /\bCI\b/,
  /\bstatus checks?\b/i,
  /\bcheck (runs?|suites?|status)\b/i,
  /\bworkflow_run\b/,
  /\bworkflow runs?\b/i,
  /\btests? (pass|passes|passing|passed|fail|fails|failing|failed)\b/i,
  /\btest suite\b/i,
  /\bbuild (status|passes|fails)\b/i,
  /\b(green|red)\b/i,
  /\bgh pr checks\b/,
  /\bgh run\b/,
  /\bstatusCheckRollup\b/,
  /\b(checks|actions) api\b/i,
  /\bpipeline\b/i,
];

test('the rendered review prompt never raises CI as something to consider', () => {
  const hits = CI_VOCABULARY.filter((re) => re.test(PROMPT)).map((re) => {
    const m = re.exec(PROMPT);
    const at = PROMPT.slice(Math.max(0, m.index - 60), m.index + 60).replace(/\n/g, ' ');
    return `${re} → …${at}…`;
  });
  assert.deepEqual(hits, [], `the review prompt mentions CI:\n${hits.join('\n')}`);
});

test('the vocabulary list catches what actually leaked (so this file cannot go vacuous)', () => {
  // A hygiene test whose patterns match nothing is indistinguishable from a
  // clean prompt. These are the two verbatim sentences from PR #2762, the
  // pre-v0.8 template line, and the four lines the old prompt carried.
  const known = [
    'I could not read CI status from this token to confirm green',
    'and CI status was not readable from this token',
    '**CI status**: could not read',
    'A separate, fully deterministic gate runs in the `workflow_run` / `issue_comment` job of the same workflow.',
    'the gate merges with **zero LLM input** when CI is green, author is Dependabot',
    'your `our_usage_affected` is `false`, CI is green, author is Dependabot',
    'A merge can only happen if the PR touches only dependency files (whitelist) AND tests pass (CI).',
  ];
  for (const sentence of known) {
    assert.ok(
      CI_VOCABULARY.some((re) => re.test(sentence)),
      `no pattern catches a known CI mention: ${sentence}`,
    );
  }
});

test('the prompt still names the gate as the thing that decides, and its own conditions', () => {
  // The opposite failure of over-deletion: a reviewer that does not know a
  // deterministic gate re-checks everything may think its own verdict is the
  // merge, which is what the injection fail-safe section exists to prevent.
  assert.match(PROMPT, /deterministic gate/);
  assert.match(PROMPT, /author is Dependabot/);
  assert.match(PROMPT, /every changed path is a dependency manifest\/lockfile/);
  assert.match(PROMPT, /injection/i, 'the fail-safe reasoning must survive the rewrite');
});

test('the prompt states the evidence set the lint enforces', () => {
  // The hook refuses a comment that reports on anything else; the prompt is
  // where the agent learns what "anything else" means. If these drift apart,
  // the agent is refused without being told the rule.
  assert.match(PROMPT, /Your evidence/);
  assert.match(PROMPT, /the PR diff, the upstream changelog \/ release notes for the bumped range, and this repository's source/);
});
