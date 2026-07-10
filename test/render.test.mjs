import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
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
  // autofix is ON by default, so the reference render includes these too:
  '.github/dependabot-automerge/autofix-bounds.cjs',
  '.github/dependabot-autofix-prompt.md',
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

// ---- --autofix opt-in: the job and its files appear iff the flag is set ----

function renderWith(extraArgs) {
  const fakeRepo = mkdtempSync(join(tmpdir(), 'ds-af-repo-'));
  for (const m of REFERENCE_MANIFESTS) writeFileSync(join(fakeRepo, m), '\n');
  const out = mkdtempSync(join(tmpdir(), 'ds-af-out-'));
  execFileSync(
    'sh',
    [join(REPO, 'install.sh'), '--render-only', '--out', out, '--ci-name', 'CI', '--assignee', 'octocat', ...extraArgs],
    { cwd: fakeRepo, env: { ...process.env, DEP_STEWARD_SRC: REPO }, stdio: 'pipe' },
  );
  return out;
}

test('by default the autofix job and its two files render, all markers substituted', () => {
  const wf = readFileSync(join(rendered, '.github/workflows/dependabot-review.yml'), 'utf8');
  assert.match(wf, /^ {2}autofix:/m);
  assert.match(wf, /workflow_run\.conclusion == 'failure'/);
  assert.doesNotMatch(wf, /__AUTOFIX_JOB__|__MODEL__|__CI_NAME__|__ASSIGN_FLAG__/);
  assert.ok(existsSync(join(rendered, '.github/dependabot-automerge/autofix-bounds.cjs')));
  const prompt = readFileSync(join(rendered, '.github/dependabot-autofix-prompt.md'), 'utf8');
  assert.match(prompt, /--add-label needs-human-review --add-assignee octocat/);
});

test('--no-autofix removes the job, its files, and leaves no marker', () => {
  const out = renderWith(['--no-autofix']);
  const wf = readFileSync(join(out, '.github/workflows/dependabot-review.yml'), 'utf8');
  assert.doesNotMatch(wf, /^ {2}autofix:/m);
  assert.doesNotMatch(wf, /__AUTOFIX_JOB__/);
  assert.ok(!existsSync(join(out, '.github/dependabot-automerge/autofix-bounds.cjs')));
  assert.ok(!existsSync(join(out, '.github/dependabot-autofix-prompt.md')));
});

test('the rendered autofix job pushes for a human to merge — it never merges', () => {
  const wf = readFileSync(join(rendered, '.github/workflows/dependabot-review.yml'), 'utf8');
  const autofixJob = wf.slice(wf.indexOf('\n  autofix:'));
  assert.ok(autofixJob.length > 0);
  assert.doesNotMatch(autofixJob, /gh pr merge/);
  assert.match(autofixJob, /git push origin/);
});

// ---- diagnosability: the frontier model, and real errors surfaced ----------

test('both agent invocations run at the frontier Opus default', () => {
  const wf = readFileSync(join(rendered, '.github/workflows/dependabot-review.yml'), 'utf8');
  // A prior build downgraded to claude-opus-4-7 blaming the model for a $0/is_error
  // first turn that was actually an invalid-token 401. Lock the frontier default so
  // that misdiagnosis can't silently return.
  const models = [...wf.matchAll(/--model (claude-opus-[\d-]+)/g)].map((m) => m[1]);
  assert.deepEqual(models, ['claude-opus-4-8', 'claude-opus-4-8']);
});

test('a failed agent run surfaces its actual error, not a guess', () => {
  const wf = readFileSync(join(rendered, '.github/workflows/dependabot-review.yml'), 'utf8');
  // The review assertion and the autofix bounds-check both read claude-code-action's
  // execution_file and print the agent's real error (e.g. "401 Invalid bearer token"),
  // with a token-specific remedy. Without this the failure is opaque — the exact
  // multi-hour rabbit hole this wiring exists to end.
  assert.match(wf, /EXEC_FILE: \$\{\{ steps\.review\.outputs\.execution_file \}\}/);
  assert.match(wf, /EXEC_FILE: \$\{\{ steps\.fixer\.outputs\.execution_file \}\}/);
  assert.match(wf, /Invalid bearer token/);
  assert.match(wf, /claude setup-token/);
});
