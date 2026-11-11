'use strict';

/*
 * The secret names a repo's CI reads: every workflow file whose top-level
 * `name:` is CI_NAME, plus the local reusable workflows those call
 * (`uses: ./.github/workflows/…`), followed transitively. Full-line comments
 * are skipped. GITHUB_TOKEN is each run's own token, never a stored secret,
 * so it is left out.
 *
 * Reads: the checkout's .github/workflows. Writes: the names, one per line,
 * sorted, to stdout. Touches nothing else.
 *
 * Why: GitHub runs a Dependabot PR's workflows with Dependabot's own secret
 * store, so a CI that reads an Actions secret fails on every Dependabot PR and
 * the gate, which merges only on green CI, never merges one.
 */

const fs = require('fs');
const path = require('path');

function topLevelName(text) {
  const m = text.match(/^name:[ \t]*(.*?)[ \t]*$/m);
  if (!m) return null;
  return m[1].replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
}

function ciWorkflowFiles(root, ciName) {
  const dir = path.join(root, '.github', 'workflows');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => path.join('.github', 'workflows', f))
    .filter((f) => topLevelName(fs.readFileSync(path.join(root, f), 'utf8')) === ciName)
    .sort();
}

function secretsReadBy(root, files) {
  const queue = [...files];
  const seen = new Set();
  const names = new Set();
  while (queue.length) {
    const f = queue.shift();
    if (seen.has(f)) continue;
    seen.add(f);
    const full = path.join(root, f);
    if (!fs.existsSync(full)) continue;
    const body = fs.readFileSync(full, 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    for (const m of body.matchAll(/secrets\.([A-Za-z_][A-Za-z0-9_]*)/g)) names.add(m[1]);
    for (const m of body.matchAll(/^[\s-]*uses:\s*\.\/(\.github\/workflows\/[^\s@]*)/gm)) queue.push(m[1]);
  }
  names.delete('GITHUB_TOKEN');
  return [...names].sort();
}

if (require.main === module) {
  const ciName = process.env.CI_NAME || '';
  if (!ciName) throw new Error('CI_NAME is empty');
  const root = process.argv[2] || '.';
  const names = secretsReadBy(root, ciWorkflowFiles(root, ciName));
  process.stdout.write(names.map((n) => `${n}\n`).join(''));
}

module.exports = { ciWorkflowFiles, secretsReadBy, topLevelName };
