#!/usr/bin/env node
// Publishes the release this tree declares: tags its commit and creates its
// GitHub release. CI's release job runs it on every push to main once the
// tests pass, so merging a release PR publishes the release, and a push that
// declares one already published does nothing.
//
// Reads:  plugin.json's version; the commit the caller templates pin as
//         `<sha> # vX.Y.Z` (scripts/pin.mjs writes both); that version's notes
//         in CHANGELOG.md, under `## vX.Y.Z: <headline>`; origin's tag of that
//         name; the GitHub release of that name (gh).
// Writes: the annotated tag vX.Y.Z at the pinned commit, pushed to origin,
//         when origin has no tag of that name; the GitHub release, titled and
//         written from CHANGELOG.md, when there is none.
// Does NOT touch: a tag that exists (one naming another commit fails the run,
//         because a published tag is never moved), a release that exists, any
//         branch, or the pins (scripts/pin.mjs writes them, and
//         test/release-pin.test.mjs holds them to the tree).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CALLERS, CALLER_REF } from './pin.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// One version's notes in a changelog: the text of its `## vX.Y.Z: <headline>`
// heading, and everything under it up to the next version's heading.
export function releaseNotes(changelog, version) {
  const lines = changelog.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`## ${version}: `));
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^## v\d+\.\d+\.\d+\b/.test(l));
  return { title: lines[start].slice(3).trim(), notes: (end < 0 ? rest : rest.slice(0, end)).join('\n').trim() };
}

// The release a tree declares: the one commit and version every caller
// template pins, the version plugin.json names, and its notes.
export function declaredRelease(root = ROOT) {
  const read = (f) => readFileSync(path.join(root, f), 'utf8');
  const version = `v${JSON.parse(read('plugin/.claude-plugin/plugin.json')).version}`;
  const pins = [...new Set(CALLERS.flatMap((f) => [...read(f).matchAll(new RegExp(CALLER_REF.source, 'g'))].map((m) => `${m[2]}${m[3] ?? ''}`)))];
  const [, commit, label] = (pins.length === 1 && /^([0-9a-f]{40}) # (v\S+)$/.exec(pins[0])) || [];
  if (!commit || label !== version) {
    throw new Error(`the caller templates pin ${pins.join(', ') || 'nothing'}, not one <sha> # ${version} (plugin.json's version): run node scripts/pin.mjs callers ${version}`);
  }
  const changelog = path.join(root, 'CHANGELOG.md');
  const notes = existsSync(changelog) ? releaseNotes(readFileSync(changelog, 'utf8'), version) : null;
  if (!notes?.notes) throw new Error(`CHANGELOG.md has no notes for ${version}: write them under "## ${version}: <headline>"`);
  return { version, commit, ...notes };
}

const run = (cmd, ...args) => execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const git = (...args) => run('git', ...args);

// The commit origin's tag names (peeled), or null when origin has no such tag.
function originTag(version) {
  const refs = Object.fromEntries(git('ls-remote', 'origin', `refs/tags/${version}`, `refs/tags/${version}^{}`)
    .split('\n').filter(Boolean).map((l) => l.split('\t').reverse()));
  return refs[`refs/tags/${version}^{}`] ?? refs[`refs/tags/${version}`] ?? null;
}

function released(version) {
  try {
    run('gh', 'release', 'view', version, '--json', 'tagName');
    return true;
  } catch (e) {
    if (/release not found/i.test(String(e.stderr))) return false;
    throw e;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { version, commit, title, notes } = declaredRelease();
  try {
    git('merge-base', '--is-ancestor', commit, 'HEAD');
  } catch {
    throw new Error(`the release commit ${commit} is not in this branch's history: merge release PRs with a merge commit, not a squash`);
  }
  const tagged = originTag(version);
  if (tagged && tagged !== commit) {
    throw new Error(`origin's ${version} names ${tagged}, not the release commit ${commit}. A published tag is never moved: release this tree under a new version`);
  }
  if (tagged) {
    console.log(`${version} is tagged at ${commit}`);
  } else {
    let local = null;
    try { local = git('rev-parse', '-q', '--verify', `refs/tags/${version}^{commit}`); } catch { /* no local tag */ }
    if (local && local !== commit) throw new Error(`the local tag ${version} names ${local}, not ${commit}, and origin has none: delete the local tag, then run again`);
    if (!local) git('tag', '-a', version, '-m', version, commit);
    git('push', 'origin', `refs/tags/${version}`);
    console.log(`tagged ${version} at ${commit}`);
  }
  if (released(version)) {
    console.log(`${version} is released`);
  } else {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'release-')), 'notes.md');
    writeFileSync(file, `${notes}\n`);
    run('gh', 'release', 'create', version, '--verify-tag', '--title', title, '--notes-file', file);
    console.log(`released ${title}`);
  }
}
