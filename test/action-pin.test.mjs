import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A reinstall never moves claude-code-action backwards.
 *
 * Once the pipeline is installed, the repo's OWN Dependabot owns the
 * `anthropics/claude-code-action` pin: the `github-actions` ecosystem in the
 * rendered dependabot.yml bumps it every week, through the pipeline's own gate.
 * dep-steward's template never sees those bumps — Dependabot scans the
 * adopter's `.github/workflows/`, not this repo's `templates/` — so the
 * template's pin is only ever as new as the last hand edit.
 *
 * The installer used to write that frozen pin over the repo's. Seen live:
 * Runsense-ai/runsense ran v1.0.230, merged through its gate that day, and a
 * plain v0.9.0 reinstall would have moved both agent jobs back to v1.0.187 —
 * 43 releases older — with no warning. It only didn't because the pins were
 * restored by hand after `--render-only`. The cost of the silent downgrade:
 *   - an older action, and an older bundled Claude Code, than the repo vetted;
 *   - the same bump reopened the next Monday, on a PR that edits
 *     dependabot-review.yml itself, which claude-code-action's workflow
 *     validation refuses to review;
 *   - v0.9.0's review lint rides a PreToolUse hook passed through the action's
 *     `settings` input, and older Claude Code builds can ignore parts of hook
 *     config — so a downgrade can run the new guard on an untested runtime.
 *
 * So the template's pin is a FIRST-INSTALL default. On a reinstall the pin in
 * the existing workflow is read per job and the newer one wins, compared on the
 * `# vX.Y.Z` comment Dependabot maintains; when a version cannot be compared,
 * the repo's pin is kept and the installer warns.
 */

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const GOLDEN = join(REPO, 'test', 'fixtures', 'expected', 'reference');
const REFERENCE_MANIFESTS = ['package.json', 'package-lock.json', 'requirements.txt', 'Cargo.toml', 'go.mod', 'Dockerfile'];
const WORKFLOW = '.github/workflows/dependabot-review.yml';
const FILES = [
  '.github/dependabot.yml',
  '.github/dependabot-review-prompt.md',
  WORKFLOW,
  '.github/dependabot-automerge/gate.cjs',
  '.github/dependabot-automerge/review-lint.cjs',
  '.github/dependabot-automerge/autofix-bounds.cjs',
  '.github/dependabot-autofix-prompt.md',
];

// dep-steward's own pin: what a first install gets.
const TEMPLATE_PIN = '1623c36729ac1cd5895198cded705a287de7db79 # v1.0.187';
// Runsense-ai/runsense's pin the day v0.9.0 shipped, merged through its own gate.
const RUNSENSE_PIN = '4036a180cf690f49529f5d8c79c998855287f590 # v1.0.230';
// Older than the template.
const OLDER_PIN = '0f9a0c4f3c4f5e8d7b6a5c4d3e2f1a0b9c8d7e6f # v1.0.150';

const GOLDEN_WORKFLOW = readFileSync(join(GOLDEN, WORKFLOW), 'utf8');

// A repo whose Dependabot has moved the pin: the golden workflow with the pin
// swapped and nothing else, which is exactly the diff Dependabot's PR makes.
function pinnedAt(pin, base = GOLDEN_WORKFLOW) {
  const text = base.split(TEMPLATE_PIN).join(pin);
  assert.notEqual(text, base, 'the base workflow must carry the template pin, or this helper changed nothing');
  return text;
}

function pinsIn(workflow) {
  return [...workflow.matchAll(/^\s*uses: anthropics\/claude-code-action@(.+)$/gm)].map((m) => m[1].trim());
}

// Render over a target repo that may already have the pipeline installed.
// spawnSync, not execFileSync: the warning case needs stderr from a run that
// succeeds.
function render({ existing = null, args = [] } = {}) {
  const fakeRepo = mkdtempSync(join(tmpdir(), 'ds-pin-repo-'));
  for (const m of REFERENCE_MANIFESTS) writeFileSync(join(fakeRepo, m), '\n');
  if (existing !== null) {
    mkdirSync(join(fakeRepo, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(fakeRepo, WORKFLOW), existing);
  }
  const out = mkdtempSync(join(tmpdir(), 'ds-pin-out-'));
  const r = spawnSync(
    'sh',
    [join(REPO, 'install.sh'), '--render-only', '--out', out, '--ci-name', 'CI', '--assignee', 'octocat', ...args],
    { cwd: fakeRepo, env: { ...process.env, DEP_STEWARD_SRC: REPO }, encoding: 'utf8' },
  );
  assert.equal(r.status, 0, `render failed:\n${r.stderr}`);
  const workflow = readFileSync(join(out, WORKFLOW), 'utf8');
  return { out, workflow, pins: pinsIn(workflow), stdout: r.stdout, stderr: r.stderr };
}

// ---- the five cases the defect report asks for ------------------------------

test('carry-forward: a reinstall over v1.0.230 keeps v1.0.230 in both jobs', () => {
  const existing = pinnedAt(RUNSENSE_PIN);
  const { workflow, pins, stdout } = render({ existing });
  assert.deepEqual(pins, [RUNSENSE_PIN, RUNSENSE_PIN], 'both agent jobs must keep the pin the repo already vetted');
  // The pin is the ONLY thing a carry-forward may change: everything else is
  // exactly what a fresh install renders.
  assert.equal(workflow, existing);
  assert.match(stdout, /claude-code-action \(review job\): keeping v1\.0\.230 from the existing workflow \(template has v1\.0\.187\)/);
  assert.match(stdout, /claude-code-action \(autofix job\): keeping v1\.0\.230 from the existing workflow \(template has v1\.0\.187\)/);
});

test('fresh install: with no existing workflow the render is byte-identical to the goldens, on the template pin', () => {
  const { out, pins, stdout } = render();
  for (const f of FILES) {
    assert.equal(readFileSync(join(out, f), 'utf8'), readFileSync(join(GOLDEN, f), 'utf8'), `${f} drifted from the golden`);
  }
  assert.deepEqual(pins, [TEMPLATE_PIN, TEMPLATE_PIN]);
  // Said on every run, not only when something unusual happens.
  assert.match(stdout, /claude-code-action \(review job\): using the template's v1\.0\.187 \(no existing workflow\)/);
  assert.match(stdout, /claude-code-action \(autofix job\): using the template's v1\.0\.187 \(no existing workflow\)/);
});

test('template is newer: an older existing pin is replaced by the template\'s', () => {
  const { pins, stdout } = render({ existing: pinnedAt(OLDER_PIN) });
  assert.deepEqual(pins, [TEMPLATE_PIN, TEMPLATE_PIN]);
  assert.match(stdout, /claude-code-action \(review job\): upgrading v1\.0\.150 to the template's v1\.0\.187/);
  assert.match(stdout, /claude-code-action \(autofix job\): upgrading v1\.0\.150 to the template's v1\.0\.187/);
});

test('unparseable version: the existing pin is kept, and the installer warns', () => {
  for (const pin of [
    '4036a180cf690f49529f5d8c79c998855287f590 # nightly', // a comment that is not vX.Y.Z
    '4036a180cf690f49529f5d8c79c998855287f590', //            no version comment at all
    'v1', //                                                  the moving tag from before SHA pinning
  ]) {
    const { pins, stdout, stderr } = render({ existing: pinnedAt(pin) });
    assert.deepEqual(pins, [pin, pin], `a pin that cannot be compared must be kept, never replaced: ${pin}`);
    assert.match(stderr, /WARN: claude-code-action \(review job\): .*cannot be compared/, `no warning for: ${pin}`);
    assert.match(stdout, /claude-code-action \(review job\): keeping .* from the existing workflow/);
  }
});

test('--no-autofix: only the review job\'s pin is resolved', () => {
  const { pins, stdout } = render({ existing: pinnedAt(RUNSENSE_PIN), args: ['--no-autofix'] });
  assert.deepEqual(pins, [RUNSENSE_PIN], 'one agent job, one pin: the review job\'s, carried forward');
  assert.match(stdout, /claude-code-action \(review job\): keeping v1\.0\.230 from the existing workflow/);
  assert.doesNotMatch(stdout, /autofix job/, 'with autofix off there is no autofix pin to choose or to report');
});

// ---- the edges around them ----------------------------------------------------

test('autofix turned on at reinstall: the new job adopts the pin the repo already runs', () => {
  // The repo was installed with --no-autofix, so only the review job carried a
  // pin. The job being added has no pin of its own; taking the template's would
  // run it 43 releases behind the job next to it.
  const existing = pinnedAt(RUNSENSE_PIN, render({ args: ['--no-autofix'] }).workflow);
  const { pins, stdout } = render({ existing });
  assert.deepEqual(pins, [RUNSENSE_PIN, RUNSENSE_PIN]);
  assert.match(stdout, /claude-code-action \(autofix job\): keeping v1\.0\.230 from the existing workflow/);
});

test('equal versions keep the repo\'s own pin, SHA included', () => {
  // Neither is newer, and the repo's is the one its gate merged.
  const sameVersion = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa # v1.0.187';
  assert.deepEqual(render({ existing: pinnedAt(sameVersion) }).pins, [sameVersion, sameVersion]);
});

test('an existing workflow with no claude-code-action pin gets the template\'s', () => {
  const existing = 'name: Dependabot PR review\non: pull_request\njobs:\n  review:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n';
  const { pins, stdout } = render({ existing });
  assert.deepEqual(pins, [TEMPLATE_PIN, TEMPLATE_PIN]);
  assert.match(stdout, /claude-code-action \(review job\): using the template's v1\.0\.187 \(the existing workflow has no claude-code-action pin\)/);
});

test('a pin carrying sed-special characters is carried verbatim, not interpreted', () => {
  // The value comes from a file in the target repo and is substituted during
  // the render; `&`, `|` and `\` must arrive as themselves.
  const odd = '4036a180cf690f49529f5d8c79c998855287f590 # held & reviewed | see \\ notes';
  assert.deepEqual(render({ existing: pinnedAt(odd) }).pins, [odd, odd]);
});

// ---- the push token's action is owned the same way ---------------------------
//
// The autofix job mints its push token with actions/create-github-app-token,
// pinned by SHA. The repo's Dependabot moves that pin after the first install
// exactly as it moves claude-code-action's, so a reinstall must not write the
// template's pin over a newer one either.

const TEMPLATE_APP_PIN = 'bcd2ba49218906704ab6c1aa796996da409d3eb1 # v3.2.0';

function appPinnedAt(pin, base = GOLDEN_WORKFLOW) {
  const text = base.split(TEMPLATE_APP_PIN).join(pin);
  assert.notEqual(text, base, 'the base workflow must carry the template app-token pin, or this helper changed nothing');
  return text;
}

const appPinsIn = (workflow) =>
  [...workflow.matchAll(/^\s*uses: actions\/create-github-app-token@(.+)$/gm)].map((m) => m[1].trim());

test('app token: a fresh install gets the template\'s pin, and says so', () => {
  const { pins, workflow, stdout } = render();
  assert.deepEqual(appPinsIn(workflow), [TEMPLATE_APP_PIN]);
  assert.deepEqual(pins, [TEMPLATE_PIN, TEMPLATE_PIN], 'the claude-code-action pins are untouched by it');
  assert.match(stdout, /create-github-app-token \(autofix job\): using the template's v3\.2\.0 \(no existing workflow\)/);
});

test('app token: a reinstall keeps a newer pin the repo\'s Dependabot merged', () => {
  const newer = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa # v3.9.0';
  const existing = appPinnedAt(newer);
  const { workflow, stdout } = render({ existing });
  assert.deepEqual(appPinsIn(workflow), [newer]);
  assert.equal(workflow, existing, 'the pin is the only thing a carry-forward may change');
  assert.match(stdout, /create-github-app-token \(autofix job\): keeping v3\.9\.0 from the existing workflow \(template has v3\.2\.0\)/);
});

test('app token: an older pin is upgraded to the template\'s', () => {
  const { workflow, stdout } = render({ existing: appPinnedAt('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb # v3.1.0') });
  assert.deepEqual(appPinsIn(workflow), [TEMPLATE_APP_PIN]);
  assert.match(stdout, /create-github-app-token \(autofix job\): upgrading v3\.1\.0 to the template's v3\.2\.0/);
});

test('app token: a workflow installed before the push token existed gets the template\'s pin and keeps its own claude-code-action pin', () => {
  // Every install today, Runsense-ai/runsense included: claude-code-action
  // pinned newer than the template, and no create-github-app-token at all.
  const before = pinnedAt(RUNSENSE_PIN).split('\n').filter((l) => !l.includes('actions/create-github-app-token@')).join('\n');
  const { workflow, pins, stdout } = render({ existing: before });
  assert.deepEqual(appPinsIn(workflow), [TEMPLATE_APP_PIN]);
  assert.deepEqual(pins, [RUNSENSE_PIN, RUNSENSE_PIN]);
  assert.match(stdout, /create-github-app-token \(autofix job\): using the template's v3\.2\.0 \(the existing workflow has no create-github-app-token pin\)/);
});

test('app token: --no-autofix resolves and reports no push-token pin', () => {
  const { workflow, stdout } = render({ args: ['--no-autofix'] });
  assert.deepEqual(appPinsIn(workflow), []);
  assert.doesNotMatch(stdout, /create-github-app-token/);
});

test('app token: a pin carrying sed-special characters is carried verbatim', () => {
  const odd = 'bcd2ba49218906704ab6c1aa796996da409d3eb1 # held & reviewed | see \\ notes';
  assert.deepEqual(appPinsIn(render({ existing: appPinnedAt(odd) }).workflow), [odd]);
});
