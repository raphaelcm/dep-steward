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
      # 'gh api user --jq .login' → the default escalation assignee.
      "api user"*) echo "octomaintainer"; exit 0 ;;
      # The installer runs 'gh api .../rules/branches/<b> --jq <expr>'. The stub
      # ignores --jq, so it emits the POST-jq value directly: the comma-joined
      # required-check contexts (GH_REQUIRED_CONTEXTS), empty by default.
      *rules/branches*) printf '%s' "\${GH_REQUIRED_CONTEXTS:-}"; exit 0 ;;
    esac
    exit 0 ;;
esac
exit 0
`;

// Stub for `claude`. The installer now VERIFIES the token with `claude -p` before
// storing it, so the harness must supply a deterministic, offline claude (a real
// one would make a network call with a fake token). Emits "OK" (authenticates) by
// default, or the 401 signature when CLAUDE_STUB_FAIL is set — so we can test that
// a bad token is rejected, not stored.
const FAKE_CLAUDE = `#!/bin/sh
case "$1" in
  -p)
    if [ -n "\${CLAUDE_STUB_FAIL:-}" ]; then
      echo 'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid bearer token"}}'
    else
      echo 'OK'
    fi
    exit 0 ;;
esac
exit 0
`;

function runInstaller(extraEnv = {}) {
  const bin = mkdtempSync(join(tmpdir(), 'ds-bin-'));
  const ghLog = join(bin, 'gh.log');
  writeFileSync(join(bin, 'gh'), FAKE_GH);
  chmodSync(join(bin, 'gh'), 0o755);
  writeFileSync(join(bin, 'claude'), FAKE_CLAUDE);
  chmodSync(join(bin, 'claude'), 0o755);

  const repoDir = mkdtempSync(join(tmpdir(), 'ds-target-'));
  writeFileSync(join(repoDir, 'package.json'), '{}\n');
  writeFileSync(join(repoDir, 'package-lock.json'), '{}\n');
  execFileSync('git', ['init', '-q'], { cwd: repoDir });

  const stdout = execFileSync('sh', [join(REPO, 'install.sh'), '--ci-name', 'CI'], {
    cwd: repoDir,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GH_LOG: ghLog,
      DEP_STEWARD_SRC: REPO,
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-tok-xyz',
      ...extraEnv,
    },
    encoding: 'utf8',
    stdio: 'pipe',
  });

  return { log: readFileSync(ghLog, 'utf8'), repoDir, stdout };
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

test('writes the automation files into the target repo (repo scope only — no personal-config writes)', () => {
  for (const f of [
    '.github/dependabot.yml',
    '.github/dependabot-review-prompt.md',
    '.github/workflows/dependabot-review.yml',
    '.github/dependabot-automerge/gate.cjs',
  ]) {
    assert.ok(existsSync(join(repoDir, f)), `expected ${f} to be written`);
  }
  // The installer must NOT create a per-repo copy of the summary command — it is
  // a personal, install-once tool, not a repo artifact.
  assert.ok(!existsSync(join(repoDir, '.claude/commands/dep-steward-summary.md')),
    'installer should not write the summary command into the repo');
});

test('wires the default escalation assignee (from gh api user) into the escalate path', () => {
  const prompt = readFileSync(join(repoDir, '.github/dependabot-review-prompt.md'), 'utf8');
  const wf = readFileSync(join(repoDir, '.github/workflows/dependabot-review.yml'), 'utf8');
  assert.match(prompt, /--add-assignee octomaintainer/);
  assert.match(wf, /--add-label needs-human-review --add-assignee octomaintainer/);
});

test('reports required status checks from the effective-rules endpoint (regression: ruleset blind spot)', () => {
  // A ruleset that requires the "CI" context. The old code queried only the
  // classic /protection endpoint, which 404s on ruleset repos, so it would have
  // false-warned "CI is not required". The rules-aware check must report it.
  const { stdout } = runInstaller({ GH_REQUIRED_CONTEXTS: 'CI' });
  assert.match(stdout, /Required status checks on 'main': CI/);
  assert.doesNotMatch(stdout, /No status checks are required/);
});

test('a token that fails verification is never stored (no opaque bad-token installs)', () => {
  // With the `claude` probe returning 401, the env-provided token is invalid.
  // Non-interactively the installer must store NOTHING rather than poison both
  // secret stores with a token that fails three steps later, opaquely, in CI.
  const { log: badLog } = runInstaller({ CLAUDE_STUB_FAIL: '1' });
  assert.doesNotMatch(badLog, /secret set CLAUDE_CODE_OAUTH_TOKEN/,
    `a token rejected by the probe must not be written to either store. gh log:\n${badLog}`);
  // Contrast: the default run (probe returns OK) DOES set it in both stores —
  // proven by the 'sets the secret ...' tests above, which share this harness.
});
