import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Render determinism.
 *
 * install.sh --render-only, given a fixed reference parameter set (CI workflow
 * "CI"; a multi-ecosystem repo — npm/pip/cargo/gomod/docker + Actions; default
 * model; assignee "octocat"), must reproduce the committed fixtures under
 * test/fixtures/expected/reference/ BYTE FOR BYTE.
 * This locks the rendering logic — any drift in a template or a substitution
 * fails here. The fixtures are a synthetic reference, not a mirror of any real
 * repo.
 */

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const GOLDEN = join(REPO, 'test', 'fixtures', 'expected', 'reference');

const FILES = [
  '.github/dependabot.yml',
  '.github/dependabot-review-prompt.md',
  '.github/workflows/dependabot-review.yml',
  '.github/dependabot-automerge/gate.cjs',
];

// A representative multi-ecosystem repo, so the fixture exercises the catalog
// broadly: exact-path ecosystems (cargo, gomod), a regex ecosystem (pip's
// requirements*.txt), the conservative docker whitelist, npm, and always Actions.
const REFERENCE_MANIFESTS = ['package.json', 'package-lock.json', 'requirements.txt', 'Cargo.toml', 'go.mod', 'Dockerfile'];

function renderReference() {
  const fakeRepo = mkdtempSync(join(tmpdir(), 'ds-ref-repo-'));
  for (const m of REFERENCE_MANIFESTS) writeFileSync(join(fakeRepo, m), '\n');
  const out = mkdtempSync(join(tmpdir(), 'ds-ref-out-'));
  execFileSync(
    'sh',
    [join(REPO, 'install.sh'), '--render-only', '--out', out, '--ci-name', 'CI', '--assignee', 'octocat'],
    { cwd: fakeRepo, env: { ...process.env, DEP_STEWARD_SRC: REPO }, stdio: 'pipe' },
  );
  return out;
}

const rendered = renderReference();

for (const f of FILES) {
  test(`renders ${f} byte-identical to the reference fixture`, () => {
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

test('the escalate path assigns the configured maintainer', () => {
  const prompt = readFileSync(join(rendered, '.github/dependabot-review-prompt.md'), 'utf8');
  const wf = readFileSync(join(rendered, '.github/workflows/dependabot-review.yml'), 'utf8');
  assert.match(prompt, /--add-label needs-human-review --add-assignee octocat/);
  assert.match(wf, /--add-label needs-human-review --add-assignee octocat/);
});

test('generates a dependabot.yml entry per detected ecosystem', () => {
  const yml = readFileSync(join(rendered, '.github/dependabot.yml'), 'utf8');
  for (const eco of ['npm', 'pip', 'cargo', 'gomod', 'docker', 'github-actions']) {
    assert.match(yml, new RegExp(`package-ecosystem: ${eco}\\b`), `missing ${eco} in dependabot.yml`);
  }
});

test("the gate keys off Dependabot's branch slugs, not the config names", () => {
  const gate = readFileSync(join(rendered, '.github/dependabot-automerge/gate.cjs'), 'utf8');
  // The three slugs that differ from the config value are the ones we most fear.
  assert.match(gate, /'dependabot\/npm_and_yarn\/npm-minor-patch-'/);
  assert.match(gate, /'dependabot\/go_modules\/gomod-minor-patch-'/);
  assert.match(gate, /'dependabot\/github_actions\/actions-minor-patch-'/);
  // And an identity one for good measure.
  assert.match(gate, /'dependabot\/cargo\/cargo-minor-patch-'/);
});
