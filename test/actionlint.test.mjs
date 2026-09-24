import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The workflow this repo renders passes actionlint.
 *
 * Adopters lint their workflows, and a render that fails there blocks their
 * push: Runsense-ai/runsense's pre-push gate refused 0.11.1's workflow on one
 * shellcheck finding inside a `run:` block, which `bash -n` (all that
 * workflow-shell.test.mjs asks of those blocks) accepts. So the render is
 * linted here with the tool adopters run.
 *
 * actionlint is a dev dependency only this test uses. Without it the test is
 * skipped; CI installs it and sets REQUIRE_ACTIONLINT=1, so there it cannot be.
 */

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const REFERENCE_MANIFESTS = ['package.json', 'package-lock.json', 'requirements.txt', 'Cargo.toml', 'go.mod', 'Dockerfile'];

function render(extraArgs = []) {
  const fakeRepo = mkdtempSync(join(tmpdir(), 'ds-al-repo-'));
  for (const m of REFERENCE_MANIFESTS) writeFileSync(join(fakeRepo, m), '\n');
  const out = mkdtempSync(join(tmpdir(), 'ds-al-out-'));
  execFileSync(
    'sh',
    [join(REPO, 'install.sh'), '--render-only', '--out', out, '--ci-name', 'CI', '--assignee', 'octocat', ...extraArgs],
    { cwd: fakeRepo, env: { ...process.env, DEP_STEWARD_SRC: REPO }, stdio: 'pipe' },
  );
  return join(out, '.github/workflows/dependabot-review.yml');
}

const available = spawnSync('actionlint', ['-version'], { stdio: 'pipe' }).status === 0;
const skip = !available && process.env.REQUIRE_ACTIONLINT !== '1' && 'actionlint is not installed';

for (const [variant, args] of [['default', []], ['--no-autofix', ['--no-autofix']]]) {
  test(`${variant}: the rendered workflow passes actionlint`, { skip }, () => {
    assert.ok(available, 'REQUIRE_ACTIONLINT=1 but actionlint is not on PATH');
    const r = spawnSync('actionlint', ['-no-color', render(args)], { encoding: 'utf8' });
    assert.equal(r.status, 0, `actionlint refused the render:\n${r.stdout}${r.stderr}`);
  });
}
