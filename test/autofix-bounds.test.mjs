import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * autofix-bounds.cjs — the deterministic scope-limiter for the `--autofix` job
 * (Option B: Claude fixes a CI-breaking bump, the human merges). It is NOT a
 * security gate — the human reviews and merges every fix. It only keeps autofix
 * in its lane: a fix it will PUSH must be a small, source-only edit to existing
 * files that does not re-touch the bumped dependency files. Anything else
 * escalates to a human instead of being pushed.
 *
 * Inputs (env): FIX_NAME_STATUS (`git diff --name-status`), FIX_NUMSTAT
 * (`git diff --numstat`), BUMP_PATHS (Dependabot's own changed paths),
 * MAX_LINES (default 10). Output (stdout): decision=push|escalate, reason=…
 */

const BOUNDS = join(dirname(fileURLToPath(import.meta.url)), '..', 'plugin', 'templates', 'autofix-bounds.cjs');

function runBounds(env) {
  const raw = execFileSync('node', [BOUNDS], { env: { ...process.env, ...env }, encoding: 'utf8' });
  return {
    decision: /^decision=(\w+)$/m.exec(raw)?.[1] ?? '',
    reason: /^reason=(.*)$/m.exec(raw)?.[1] ?? '',
  };
}

// A clean, small, source-only fix disjoint from the bump.
const OK = {
  FIX_NAME_STATUS: 'M\tsrc/client.ts\nM\tsrc/index.ts',
  FIX_NUMSTAT: '2\t1\tsrc/client.ts\n1\t0\tsrc/index.ts',
  BUMP_PATHS: 'package.json\npackage-lock.json',
  MAX_LINES: '10',
};

test('pushes a small, source-only, modification-only fix disjoint from the bump', () => {
  assert.equal(runBounds(OK).decision, 'push');
});

test('escalates when the fixer produced no changes', () => {
  const { decision, reason } = runBounds({ ...OK, FIX_NAME_STATUS: '', FIX_NUMSTAT: '' });
  assert.equal(decision, 'escalate');
  assert.match(reason, /no fix|no changes|nothing/i);
});

test('escalates when the fix adds a new file (mechanical fixes edit existing call sites)', () => {
  const { decision, reason } = runBounds({
    ...OK,
    FIX_NAME_STATUS: 'M\tsrc/client.ts\nA\tsrc/new-helper.ts',
    FIX_NUMSTAT: '2\t1\tsrc/client.ts\n5\t0\tsrc/new-helper.ts',
  });
  assert.equal(decision, 'escalate');
  assert.match(reason, /status|add|new file/i);
});

test('escalates when the fix deletes a file', () => {
  assert.equal(
    runBounds({ ...OK, FIX_NAME_STATUS: 'D\tsrc/old.ts', FIX_NUMSTAT: '0\t9\tsrc/old.ts' }).decision,
    'escalate',
  );
});

test('escalates when the fix touches .github/ (never let autofix edit its own pipeline)', () => {
  const { decision, reason } = runBounds({
    ...OK,
    FIX_NAME_STATUS: 'M\t.github/workflows/ci.yml',
    FIX_NUMSTAT: '1\t1\t.github/workflows/ci.yml',
  });
  assert.equal(decision, 'escalate');
  assert.match(reason, /\.github/i);
});

test('escalates when the fix re-touches a bumped dependency file (fix must be source only)', () => {
  const { decision, reason } = runBounds({
    ...OK,
    FIX_NAME_STATUS: 'M\tpackage.json',
    FIX_NUMSTAT: '1\t1\tpackage.json',
  });
  assert.equal(decision, 'escalate');
  assert.match(reason, /bump|dependency|package\.json/i);
});

test('escalates when the fix exceeds the line budget', () => {
  const { decision, reason } = runBounds({ ...OK, FIX_NUMSTAT: '9\t7\tsrc/client.ts' }); // 16 lines
  assert.equal(decision, 'escalate');
  assert.match(reason, /line|budget|exceed|16/i);
});

test('pushes exactly at the line budget (boundary)', () => {
  assert.equal(
    runBounds({ ...OK, FIX_NAME_STATUS: 'M\tsrc/client.ts', FIX_NUMSTAT: '6\t4\tsrc/client.ts' }).decision, // 10
    'push',
  );
});

test('respects a custom MAX_LINES', () => {
  assert.equal(
    runBounds({ ...OK, FIX_NAME_STATUS: 'M\tsrc/client.ts', FIX_NUMSTAT: '3\t0\tsrc/client.ts', MAX_LINES: '2' }).decision,
    'escalate',
  );
});

test('escalates a binary change (not a mechanical source fix)', () => {
  const { decision, reason } = runBounds({
    ...OK,
    FIX_NAME_STATUS: 'M\tsrc/logo.png',
    FIX_NUMSTAT: '-\t-\tsrc/logo.png',
  });
  assert.equal(decision, 'escalate');
  assert.match(reason, /binary/i);
});

// ---- regenerate mode -------------------------------------------------------
//
// The output of the repo's own code generator, re-run for the bump (#3034: a
// prisma 7.10.0 -> 7.10.1 bump left the committed client stale, and the fix was
// `npm run db:generate`: 2 files, 12 lines, every one a version string). A line
// budget measures how much an agent wrote; it says nothing about whether a
// generator's output is right, so this mode has none. What it does keep: only
// the paths the installer was told the generator writes, nothing under
// .github/, never a bumped manifest, and only regular files.

const REGEN = {
  FIX_KIND: 'regenerate',
  REGENERATE_PATHS: 'src/generated/prisma',
  FIX_NAME_STATUS: 'M\tsrc/generated/prisma/internal/class.ts\nM\tsrc/generated/prisma/internal/prismaNamespace.ts',
  FIX_NUMSTAT: '3\t3\tsrc/generated/prisma/internal/class.ts\n3\t3\tsrc/generated/prisma/internal/prismaNamespace.ts',
  FIX_RAW: ':100644 100644 1111111 2222222 M\tsrc/generated/prisma/internal/class.ts\n:100644 100644 3333333 4444444 M\tsrc/generated/prisma/internal/prismaNamespace.ts',
  BUMP_PATHS: 'package.json\npackage-lock.json',
};

test('regenerate: the #3034 regeneration (2 files, 12 lines under the declared path) is pushed', () => {
  const { decision, reason } = runBounds(REGEN);
  assert.equal(decision, 'push', reason);
  assert.match(reason, /2 file\(s\)/);
  assert.match(reason, /src\/generated\/prisma/);
});

test('regenerate: thousands of lines are still the generator\'s output, not a reason to escalate', () => {
  assert.equal(runBounds({ ...REGEN, FIX_NUMSTAT: '4000\t3900\tsrc/generated/prisma/internal/class.ts' }).decision, 'push');
});

test('regenerate: a generator may add and delete files under its paths, and write binaries there', () => {
  const r = runBounds({
    ...REGEN,
    FIX_NAME_STATUS: 'A\tsrc/generated/prisma/models/Race.ts\nD\tsrc/generated/prisma/models/Old.ts\nM\tsrc/generated/prisma/engine.node',
    FIX_NUMSTAT: '40\t0\tsrc/generated/prisma/models/Race.ts\n0\t30\tsrc/generated/prisma/models/Old.ts\n-\t-\tsrc/generated/prisma/engine.node',
    FIX_RAW: ':000000 100644 0000000 1111111 A\tsrc/generated/prisma/models/Race.ts\n:100644 000000 2222222 0000000 D\tsrc/generated/prisma/models/Old.ts\n:100755 100755 3333333 4444444 M\tsrc/generated/prisma/engine.node',
  });
  assert.equal(r.decision, 'push', r.reason);
});

test('regenerate: a file outside the declared paths escalates, and the reason names it', () => {
  const r = runBounds({
    ...REGEN,
    FIX_NAME_STATUS: `${REGEN.FIX_NAME_STATUS}\nM\tsrc/client.ts`,
    FIX_NUMSTAT: `${REGEN.FIX_NUMSTAT}\n1\t1\tsrc/client.ts`,
    FIX_RAW: `${REGEN.FIX_RAW}\n:100644 100644 5555555 6666666 M\tsrc/client.ts`,
  });
  assert.equal(r.decision, 'escalate');
  assert.match(r.reason, /src\/client\.ts/);
});

test('regenerate: a declared path matches whole path segments only', () => {
  const r = runBounds({
    ...REGEN,
    FIX_NAME_STATUS: 'M\tsrc/generated/prisma-extra/x.ts',
    FIX_NUMSTAT: '1\t1\tsrc/generated/prisma-extra/x.ts',
    FIX_RAW: ':100644 100644 1111111 2222222 M\tsrc/generated/prisma-extra/x.ts',
  });
  assert.equal(r.decision, 'escalate');
});

test('regenerate: .github/ and the bumped manifests stay out, even when declared', () => {
  for (const path of ['.github/workflows/ci.yml', 'package-lock.json']) {
    const r = runBounds({
      ...REGEN,
      REGENERATE_PATHS: `src/generated/prisma ${path}`,
      FIX_NAME_STATUS: `M\t${path}`,
      FIX_NUMSTAT: `1\t1\t${path}`,
      FIX_RAW: `:100644 100644 1111111 2222222 M\t${path}`,
    });
    assert.equal(r.decision, 'escalate', `${path}: ${r.reason}`);
  }
});

test('regenerate: a symlink, a submodule or a rename escalates', () => {
  for (const [raw, ns] of [
    [':000000 120000 0000000 1111111 A\tsrc/generated/prisma/link', 'A\tsrc/generated/prisma/link'],
    [':000000 160000 0000000 1111111 A\tsrc/generated/prisma/sub', 'A\tsrc/generated/prisma/sub'],
    [':100644 100644 1111111 1111111 R100\tsrc/generated/prisma/a.ts\tsrc/generated/prisma/b.ts', 'R100\tsrc/generated/prisma/a.ts\tsrc/generated/prisma/b.ts'],
  ]) {
    const r = runBounds({ ...REGEN, FIX_NAME_STATUS: ns, FIX_NUMSTAT: '0\t0\tx', FIX_RAW: raw });
    assert.equal(r.decision, 'escalate', `${raw}: ${r.reason}`);
  }
});

test('regenerate: with no declared paths nothing is pushed', () => {
  assert.equal(runBounds({ ...REGEN, REGENERATE_PATHS: '' }).decision, 'escalate');
});

test('regenerate mode is never the default: the same 12 lines with no FIX_KIND keep the agent\'s budget', () => {
  const { FIX_KIND, ...agent } = REGEN;
  assert.equal(runBounds(agent).decision, 'escalate');
});
