#!/usr/bin/env node
// Release pinning. A pinned workflow must run the code it was released with,
// and a reusable workflow cannot learn its own commit (github.job_workflow_sha
// is empty in called workflows), so every dep-steward ref is a full SHA
// written here, in two steps:
//
//   node scripts/pin.mjs tools            # reusable workflows -> actions/tools at HEAD
//   git commit -am "Pin the tools"        # this commit is the release (tag it)
//   node scripts/pin.mjs callers v0.18.0  # caller templates -> that commit; plugin.json version
//   git commit -am "Pin the callers"
//
// Merge the PR with a merge commit (not squash), so every pinned SHA stays on
// main. test/release-pin.test.mjs checks both pins against the tree.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REUSABLE = ['.github/workflows/review.yml', '.github/workflows/automerge.yml'];
export const CALLERS = ['plugin/templates/dependabot-review.yml', 'plugin/templates/dependabot-automerge.yml', 'plugin/templates/dependabot-seal.yml'];
export const TOOLS_REF = /(uses: raphaelcm\/dep-steward\/actions\/tools@)(\S+)/g;
export const CALLER_REF = /(uses: raphaelcm\/dep-steward\/(?:\.github\/workflows\/[a-z-]+\.yml|actions\/seal)@)(\S+)( # v\S+)?/g;

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();

function rewrite(files, re, replacement) {
  for (const f of files) {
    const p = path.join(ROOT, f);
    const before = readFileSync(p, 'utf8');
    if (!new RegExp(re.source).test(before)) throw new Error(`${f}: no dep-steward ref to pin`);
    writeFileSync(p, before.replace(re, replacement));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [what, version] = process.argv.slice(2);
  if (git('status', '--porcelain')) throw new Error('commit first: the pin must name a commit that holds this tree');
  const head = git('rev-parse', 'HEAD');
  if (what === 'tools') {
    rewrite(REUSABLE, TOOLS_REF, `$1${head}`);
    console.log(`reusable workflows now run actions/tools@${head}`);
  } else if (what === 'callers' && /^v\d+\.\d+\.\d+$/.test(version || '')) {
    rewrite(CALLERS, CALLER_REF, `$1${head} # ${version}`);
    const manifest = path.join(ROOT, 'plugin/.claude-plugin/plugin.json');
    const json = JSON.parse(readFileSync(manifest, 'utf8'));
    json.version = version.slice(1);
    writeFileSync(manifest, `${JSON.stringify(json, null, 2)}\n`);
    console.log(`caller templates now pin ${head} (${version}); tag ${version} at ${head}`);
  } else {
    console.error('usage: node scripts/pin.mjs tools | callers vX.Y.Z');
    process.exit(2);
  }
}
