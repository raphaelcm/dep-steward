import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO } from './lib/dep-steward.mjs';
import { REUSABLE, CALLERS, TOOLS_REF, CALLER_REF } from '../scripts/pin.mjs';

/**
 * A pinned workflow must run the code it was released with.
 *
 * An adopter's caller files pin dep-steward's reusable workflows to a commit
 * R. Those workflows use actions/tools at a commit T, because a called
 * workflow cannot learn its own commit (github.job_workflow_sha is empty), so
 * T is written into them by scripts/pin.mjs. Both pins are full SHAs, since a
 * tag can be moved. This checks the chain against this tree:
 *
 *   - T's actions/ is this tree's actions/, so the tools every workflow here
 *     runs are the tools in this commit;
 *   - R's actions/ and reusable workflows are this tree's, so an install made
 *     from these templates runs exactly this code;
 *   - the version comment on R is plugin.json's version, which is the release
 *     tag Dependabot reads to propose the next one.
 *
 * It fails between a code change and its pin commits, by design: the release
 * is the commit that passes it.
 */

const git = (...args) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8' }).trim();
const read = (f) => readFileSync(join(REPO, f), 'utf8');

function refsIn(files, re) {
  return files.flatMap((f) => [...read(f).matchAll(re)].map((m) => ({ file: f, sha: m[2], version: m[3]?.replace(/^ # /, '') })));
}

function sameTree(sha, paths) {
  try {
    execFileSync('git', ['diff', '--quiet', sha, 'HEAD', '--', ...paths], { cwd: REPO, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

test('every reusable workflow runs the tools in this tree', () => {
  const refs = refsIn(REUSABLE, new RegExp(TOOLS_REF.source, 'g'));
  assert.ok(refs.length >= REUSABLE.length, 'each reusable workflow uses the tools action');
  const shas = new Set(refs.map((r) => r.sha));
  assert.equal(shas.size, 1, `one tools commit for all: ${[...shas].join(', ')}`);
  const [sha] = shas;
  assert.match(sha, /^[0-9a-f]{40}$/, `the tools ref is a full commit SHA, not ${sha} (run node scripts/pin.mjs tools)`);
  assert.equal(git('cat-file', '-t', sha), 'commit');
  assert.ok(sameTree(sha, ['actions/']), `actions/ at ${sha} differs from this tree: commit the code, then run node scripts/pin.mjs tools`);
});

test('the caller templates pin a commit whose pipeline is this tree, labelled with this version', () => {
  const refs = refsIn(CALLERS, new RegExp(CALLER_REF.source, 'g'));
  assert.equal(refs.length, CALLERS.length, 'each caller template uses one dep-steward reusable workflow');
  const shas = new Set(refs.map((r) => r.sha));
  assert.equal(shas.size, 1, `one release commit for all: ${[...shas].join(', ')}`);
  const [sha] = shas;
  assert.match(sha, /^[0-9a-f]{40}$/, `the caller ref is a full commit SHA, not ${sha} (run node scripts/pin.mjs callers vX.Y.Z)`);
  assert.equal(git('cat-file', '-t', sha), 'commit');
  assert.ok(sameTree(sha, ['actions/', ...REUSABLE]), `the pipeline at ${sha} differs from this tree: pin the tools, commit, then pin the callers`);
  const { version } = JSON.parse(read('plugin/.claude-plugin/plugin.json'));
  for (const r of refs) assert.equal(r.version, `v${version}`, `${r.file}: the version comment matches plugin.json`);
});
