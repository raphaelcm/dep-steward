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
 * A second kind of fix has rules of its own: the regeneration, which is the
 * repo's own code generator re-run for the bump, never an agent's writing. A
 * line budget measures how much an agent wrote and says nothing about whether
 * a generator's output is right, so that kind has none. It is confined instead
 * to the paths the installer was told the generator writes.
 *
 * Inputs (env):
 *   FIX_NAME_STATUS  `git diff --name-status` of the fixer's edits (status<TAB>path)
 *   FIX_NUMSTAT      `git diff --numstat` of the fixer's edits (added<TAB>deleted<TAB>path)
 *   BUMP_PATHS       paths Dependabot's own commits changed (one per line)
 *   MAX_LINES        line budget (default 10)
 *   FIX_KIND         `regenerate` for a regeneration; anything else is the agent's fix
 *   REGENERATE_PATHS the generator's declared paths, space-separated (regenerate only)
 *   FIX_RAW          `git diff --raw --no-renames` of the change (regenerate only)
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

// Regular files only: a symlink (120000) could point the next reader of the
// tree anywhere, and a submodule (160000) is another repository.
const REGULAR_MODES = new Set(['100644', '100755']);

function under(path, dir) {
  return path === dir || path.startsWith(`${dir}/`);
}

function decideRegeneration(env) {
  const declared = (env.REGENERATE_PATHS || '').split(/\s+/).filter(Boolean);
  const raw = lines(env.FIX_RAW);
  const bumpPaths = new Set(lines(env.BUMP_PATHS));
  if (declared.length === 0) {
    return { decision: 'escalate', reason: 'no generated paths are declared, so no regeneration can be pushed; escalate' };
  }
  if (raw.length === 0) {
    return { decision: 'escalate', reason: 'the regeneration changes nothing — nothing to push' };
  }
  for (const row of raw) {
    // :<old mode> <new mode> <old sha> <new sha> <status>\t<path>
    const [meta, ...rest] = row.split('\t');
    const path = rest.join('\t');
    const [, newMode, , , statusField] = meta.split(' ');
    const status = (statusField || '').charAt(0);
    // A generator writes, rewrites and removes files; with --no-renames a
    // rename arrives as a delete and an add, so R, C and T are not its shape.
    if (!['M', 'A', 'D'].includes(status) || rest.length !== 1) {
      return { decision: 'escalate', reason: `regeneration changes file status "${statusField}" (${path}) — only added, modified and deleted files are pushed; escalate` };
    }
    if (status !== 'D' && !REGULAR_MODES.has(newMode)) {
      return { decision: 'escalate', reason: `regeneration writes ${path} with mode ${newMode} — only regular files are pushed; escalate` };
    }
    if (path.startsWith('.github/')) {
      return { decision: 'escalate', reason: `regeneration touches ${path} under .github/ — out of scope for autofix; escalate` };
    }
    if (bumpPaths.has(path)) {
      return { decision: 'escalate', reason: `regeneration re-touches bumped dependency file ${path}; escalate` };
    }
    if (!declared.some((d) => under(path, d))) {
      return { decision: 'escalate', reason: `regeneration changes ${path}, outside the declared generated paths (${declared.join(', ')}); escalate` };
    }
  }
  const command = env.REGENERATE_COMMAND ? ` \`${env.REGENERATE_COMMAND}\`` : '';
  return {
    decision: 'push',
    reason: `regenerated with${command || ' the generator'}: ${raw.length} file(s), all under ${declared.join(', ')}`,
  };
}

function decide(env) {
  if (env.FIX_KIND === 'regenerate') return decideRegeneration(env);
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
