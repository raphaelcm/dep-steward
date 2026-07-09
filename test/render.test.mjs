import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Render parity — the migration gate.
 *
 * install.sh --render-only, given the parameters Runsense actually runs (CI
 * workflow "CI"; npm + GitHub Actions; model claude-opus-4-7), must reproduce
 * the committed golden fixtures under test/fixtures/expected/runsense/ BYTE FOR
 * BYTE. Those goldens were verified once against Runsense's live production
 * files: identical for dependabot.yml, the prompt, and gate.cjs, and identical
 * for the workflow except the single intended delta — the gate's relocated
 * path (scripts/dev/... -> .github/dependabot-automerge/gate.cjs).
 *
 * So: if this test is green, the genericised installer still reproduces the
 * production pipeline, and the Runsense dogfood diff is exactly "relocate the
 * gate" and nothing else. This is the precondition for adopting dep-steward
 * anywhere, Runsense included.
 */

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const GOLDEN = join(REPO, 'test', 'fixtures', 'expected', 'runsense');

const FILES = [
  '.github/dependabot.yml',
  '.github/dependabot-review-prompt.md',
  '.github/workflows/dependabot-review.yml',
  '.github/dependabot-automerge/gate.cjs',
];

function renderWithRunsenseParams() {
  const fakeRepo = mkdtempSync(join(tmpdir(), 'ds-rs-repo-'));
  writeFileSync(join(fakeRepo, 'package.json'), '{}\n');
  writeFileSync(join(fakeRepo, 'package-lock.json'), '{}\n');
  const out = mkdtempSync(join(tmpdir(), 'ds-rs-out-'));
  execFileSync(
    'sh',
    [join(REPO, 'install.sh'), '--render-only', '--out', out, '--ci-name', 'CI', '--model', 'claude-opus-4-7'],
    { cwd: fakeRepo, env: { ...process.env, DEP_STEWARD_SRC: REPO }, stdio: 'pipe' },
  );
  return out;
}

const rendered = renderWithRunsenseParams();

for (const f of FILES) {
  test(`renders ${f} byte-identical to the golden fixture`, () => {
    const got = readFileSync(join(rendered, f), 'utf8');
    const want = readFileSync(join(GOLDEN, f), 'utf8');
    assert.equal(got, want);
  });
}

test('the rendered workflow points at the relocated gate path', () => {
  const wf = readFileSync(join(rendered, '.github/workflows/dependabot-review.yml'), 'utf8');
  assert.match(wf, /node \.github\/dependabot-automerge\/gate\.cjs/);
  assert.doesNotMatch(wf, /scripts\/dev\/dependabot-automerge-gate\.cjs/);
});
