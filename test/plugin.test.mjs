import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Claude Code plugin packaging.
 *
 * This repo is both a plugin and its own single-plugin marketplace, so users
 * install it with:
 *   /plugin marketplace add raphaelcm/dep-steward
 *   /plugin install dep-steward@dep-steward
 *
 * Every assertion here fails an install for every user, silently, at a moment
 * nothing else is watching: a manifest that does not parse, a marketplace entry
 * naming a plugin that is not this one, or a skill with no description (which
 * loads but never surfaces). `claude plugin validate` catches these locally but
 * needs the CLI, so the same invariants are pinned here where CI already runs.
 */

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const readJSON = (...p) => JSON.parse(readFileSync(join(REPO, ...p), 'utf8'));

test('plugin.json is valid and identifies the plugin', () => {
  const m = readJSON('.claude-plugin', 'plugin.json');

  assert.equal(m.name, 'dep-steward', 'name is the skill namespace: /dep-steward:<skill>');
  assert.match(m.name, /^[a-z0-9-]+$/, 'name must be kebab-case with no spaces');
  assert.ok(m.description?.length > 20, 'description is what users read when browsing plugins');

  // An explicit version, not SHA versioning: this repo already tags every
  // release, so the bump is part of a ritual that exists. Users only receive a
  // plugin update when this field moves, so it must move with the tag.
  assert.match(m.version, /^\d+\.\d+\.\d+$/, 'version must be semver, bumped with the release tag');
});

test('marketplace.json lists this repo as its own plugin', () => {
  const mk = readJSON('.claude-plugin', 'marketplace.json');
  const plugin = readJSON('.claude-plugin', 'plugin.json');

  assert.equal(mk.name, 'dep-steward', 'marketplace name — users type @dep-steward when installing');
  assert.ok(mk.owner?.name, 'owner is a required marketplace field');
  assert.ok(Array.isArray(mk.plugins) && mk.plugins.length === 1, 'exactly one plugin: this repo');

  const [entry] = mk.plugins;
  assert.equal(entry.name, plugin.name, 'entry name must match plugin.json, or the install resolves nothing');
  assert.equal(entry.source, './', 'the plugin IS the marketplace repo root');
  assert.ok(entry.description?.length > 20, 'description shows in the plugin browser');
});

test('every skill has frontmatter with a description', () => {
  const skillsDir = join(REPO, 'skills');
  const skills = readdirSync(skillsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  assert.deepEqual(skills.sort(), ['install', 'summary', 'uninstall'], 'the three skills the README documents');

  for (const skill of skills) {
    const path = join(skillsDir, skill, 'SKILL.md');
    assert.ok(existsSync(path), `skills/${skill}/ must contain SKILL.md — the directory name is the skill name`);

    const body = readFileSync(path, 'utf8');
    assert.ok(body.startsWith('---\n'), `skills/${skill}/SKILL.md must open with YAML frontmatter`);

    const frontmatter = body.slice(4, body.indexOf('\n---', 4));
    assert.match(
      frontmatter,
      /^description: \S.*/m,
      `skills/${skill}/SKILL.md needs a description — without one the skill loads but never surfaces`,
    );
  }
});

test('the README points at the summary skill where it actually lives', () => {
  // The summary command moved from templates/ into skills/summary/SKILL.md when
  // this became a plugin. The README offers a raw-URL curl as the no-plugin
  // fallback, so a stale path there 404s for anyone who takes that route.
  const readme = readFileSync(join(REPO, 'README.md'), 'utf8');
  const rawPaths = [...readme.matchAll(/raw\.githubusercontent\.com\/raphaelcm\/dep-steward\/main\/(\S+?)(?=[\s"'\\)]|$)/g)]
    .map((m) => m[1]);

  assert.ok(rawPaths.length > 0, 'the README cites raw file URLs; this test guards them');
  for (const p of rawPaths) {
    assert.ok(existsSync(join(REPO, p)), `README links raw .../main/${p}, which does not exist in the repo`);
  }
});
