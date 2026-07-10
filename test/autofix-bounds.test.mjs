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

const BOUNDS = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'autofix-bounds.cjs');

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
