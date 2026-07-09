import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Installer wiring — covers the cold-start GitHub side that the render tests
 * don't: with a stubbed `gh` on PATH (and real git), a full install must set
 * the CLAUDE_CODE_OAUTH_TOKEN secret in BOTH the Actions store AND the
 * Dependabot store (the marquee gotcha), create the needs-human-review label,
 * and enable auto-merge. We assert the exact `gh` command sequence the
 * installer emits, not GitHub's real response.
 */

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

const FAKE_GH = `#!/bin/sh
echo "$*" >> "$GH_LOG"
cmd="$1"; sub="\${2:-}"
case "$cmd" in
  auth) echo "Token scopes: 'repo', 'workflow'"; exit 0 ;;
  repo)
    case "$*" in
      *nameWithOwner*) echo "acme/widgets" ;;
      *defaultBranchRef*) echo "main" ;;
    esac
    exit 0 ;;
  label)
    case "$sub" in
      list) exit 0 ;;
      create) exit 0 ;;
    esac ;;
  secret) cat >/dev/null 2>&1 || true; exit 0 ;;
  api)
    case "$*" in
      *"-X PATCH"*) exit 0 ;;
      *protection*) echo '{}'; exit 0 ;;
    esac
    exit 0 ;;
esac
exit 0
`;

function runInstaller() {
  const bin = mkdtempSync(join(tmpdir(), 'ds-bin-'));
  const ghLog = join(bin, 'gh.log');
  writeFileSync(join(bin, 'gh'), FAKE_GH);
  chmodSync(join(bin, 'gh'), 0o755);

  const repoDir = mkdtempSync(join(tmpdir(), 'ds-target-'));
  writeFileSync(join(repoDir, 'package.json'), '{}\n');
  writeFileSync(join(repoDir, 'package-lock.json'), '{}\n');
  execFileSync('git', ['init', '-q'], { cwd: repoDir });

  execFileSync('sh', [join(REPO, 'install.sh'), '--ci-name', 'CI'], {
    cwd: repoDir,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GH_LOG: ghLog,
      DEP_STEWARD_SRC: REPO,
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-tok-xyz',
    },
    stdio: 'pipe',
  });

  return { log: readFileSync(ghLog, 'utf8'), repoDir };
}

const { log, repoDir } = runInstaller();
const lines = log.split('\n');

test('sets the secret in the Actions store (no --app)', () => {
  assert.ok(
    lines.some((l) => l === 'secret set CLAUDE_CODE_OAUTH_TOKEN --repo acme/widgets --body -'),
    `Actions-store secret set not found. gh log:\n${log}`,
  );
});

test('sets the secret in the Dependabot store (--app dependabot) — the marquee gotcha', () => {
  assert.ok(
    lines.some((l) => /^secret set CLAUDE_CODE_OAUTH_TOKEN .*--app dependabot/.test(l)),
    `Dependabot-store secret set not found. gh log:\n${log}`,
  );
});

test('creates the needs-human-review label', () => {
  assert.ok(
    lines.some((l) => /^label create needs-human-review/.test(l)),
    `label create not found. gh log:\n${log}`,
  );
});

test('enables auto-merge on the repo', () => {
  assert.ok(
    lines.some((l) => l === 'api -X PATCH repos/acme/widgets -F allow_auto_merge=true'),
    `allow_auto_merge PATCH not found. gh log:\n${log}`,
  );
});

test('writes the four automation files into the target repo', () => {
  for (const f of [
    '.github/dependabot.yml',
    '.github/dependabot-review-prompt.md',
    '.github/workflows/dependabot-review.yml',
    '.github/dependabot-automerge/gate.cjs',
  ]) {
    assert.ok(existsSync(join(repoDir, f)), `expected ${f} to be written`);
  }
});
