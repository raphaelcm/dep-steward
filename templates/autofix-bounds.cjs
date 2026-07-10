#!/usr/bin/env node
'use strict';

/*
 * autofix-bounds.cjs — deterministic scope-limiter for the `--autofix` job
 * (Option B: Claude fixes a CI-breaking bump, the human merges). This is NOT a
 * security gate; the human reviews and merges every fix. It only keeps autofix
 * in its lane: a fix it will PUSH must be a SMALL, source-only edit to EXISTING
 * files that does not re-touch the bumped dependency files. Anything else
 * escalates to a human instead of being pushed.
 *
 * Inputs (env):
 *   FIX_NAME_STATUS  `git diff --name-status` of the fixer's edits (status<TAB>path)
 *   FIX_NUMSTAT      `git diff --numstat` of the fixer's edits (added<TAB>deleted<TAB>path)
 *   BUMP_PATHS       paths Dependabot's own commits changed (one per line)
 *   MAX_LINES        line budget (default 10)
 *
 * Output (stdout): `decision=push|escalate` then `reason=<text>`. Exit is always
 * 0 — the decision is the contract, not the exit code.
 */

const DEFAULT_MAX_LINES = 10;

function lines(s) {
  return (s || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

function decide(env) {
  const parsedMax = Number.parseInt(env.MAX_LINES, 10);
  const maxLines = parsedMax > 0 ? parsedMax : DEFAULT_MAX_LINES;
  const nameStatus = lines(env.FIX_NAME_STATUS);
  const numstat = lines(env.FIX_NUMSTAT);
  const bumpPaths = new Set(lines(env.BUMP_PATHS));

  if (nameStatus.length === 0) {
    return { decision: 'escalate', reason: 'the fixer produced no changes — nothing to push' };
  }

  for (const row of nameStatus) {
    const parts = row.split('\t');
    const status = (parts[0] || '').charAt(0).toUpperCase();
    const path = parts.slice(1).join('\t');
    // 1. Modifications only — a mechanical fix edits existing call sites; it
    //    never adds, deletes, renames, or copies files.
    if (status !== 'M') {
      return { decision: 'escalate', reason: `fix changes file status "${parts[0]}" (${path}) — only in-place edits are pushed; escalate` };
    }
    // 2. Never let autofix edit its own pipeline or CI config.
    if (path.startsWith('.github/')) {
      return { decision: 'escalate', reason: `fix touches ${path} under .github/ — out of scope for autofix; escalate` };
    }
    // 3. Source only — the fix must not re-touch a bumped dependency
    //    manifest/lockfile (that surface is the bump's, not the fix's).
    if (bumpPaths.has(path)) {
      return { decision: 'escalate', reason: `fix re-touches bumped dependency file ${path} — the fix must be source only; escalate` };
    }
  }

  // 4. Small — sum of added + deleted across the fix, within the budget.
  let total = 0;
  for (const row of numstat) {
    const [added, deleted] = row.split('\t');
    if (added === '-' || deleted === '-') {
      return { decision: 'escalate', reason: 'fix includes a binary change — not a mechanical source fix; escalate' };
    }
    total += (Number.parseInt(added, 10) || 0) + (Number.parseInt(deleted, 10) || 0);
  }
  if (total > maxLines) {
    return { decision: 'escalate', reason: `fix changes ${total} lines, over the ${maxLines}-line budget — too large for autofix; escalate` };
  }

  return {
    decision: 'push',
    reason: `source-only fix, ${nameStatus.length} file(s), ${total} line(s) within the ${maxLines}-line budget`,
  };
}

const { decision, reason } = decide(process.env);
process.stdout.write(`decision=${decision}\nreason=${reason}\n`);
process.exit(0);
