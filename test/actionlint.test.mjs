import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WORKFLOW_PATHS, CALLER_PATHS, callerText } from './lib/dep-steward.mjs';

/**
 * The workflows dep-steward ships, and the files it installs, pass actionlint.
 *
 * Adopters lint their workflows, and a file that fails there blocks their
 * push: Runsense-ai/runsense's pre-push gate refused 0.11.1's workflow on one
 * shellcheck finding inside a `run:` block, which `bash -n` (all that
 * workflow-shell.test.mjs asks of those blocks) accepts. The installed caller
 * files are linted as an install leaves them, with the settings filled in.
 *
 * actionlint is a dev dependency only this test uses. Without it the test is
 * skipped; CI installs it and sets REQUIRE_ACTIONLINT=1, so there it cannot be.
 */

const available = spawnSync('actionlint', ['-version'], { stdio: 'pipe' }).status === 0;
const skip = !available && process.env.REQUIRE_ACTIONLINT !== '1' && 'actionlint is not installed';

function lint(files) {
  assert.ok(available, 'REQUIRE_ACTIONLINT=1 but actionlint is not on PATH');
  const r = spawnSync('actionlint', ['-no-color', ...files], { encoding: 'utf8' });
  assert.equal(r.status, 0, `actionlint refused:\n${r.stdout}${r.stderr}`);
}

test("dep-steward's reusable workflows pass actionlint", { skip }, () => {
  lint(Object.values(WORKFLOW_PATHS));
});

test('the caller files, as an install writes them, pass actionlint', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-al-'));
  mkdirSync(join(dir, '.github/workflows'), { recursive: true });
  const files = Object.keys(CALLER_PATHS).map((name) => {
    const f = join(dir, '.github/workflows', `dependabot-${name}.yml`);
    writeFileSync(f, callerText(name).replaceAll('__CI_NAME__', 'CI').replaceAll('__ASSIGNEE__', 'octocat'));
    return f;
  });
  lint(files);
});
