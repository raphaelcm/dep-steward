import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

/**
 * The install skill writes .github/dependabot.yml from a table, and the gate
 * recognises a minor/patch group PR by the group names in that file. The
 * table is prose an agent follows, and ecosystems.cjs is the code the gate
 * runs, so this holds the two together: every row's package-ecosystem and
 * group must be one the gate derives, and every ecosystem the gate knows must
 * have a row.
 */

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const { ecosystemsFor } = require(join(REPO, 'actions/tools/ecosystems.cjs'));
const SKILL = readFileSync(join(REPO, 'plugin/skills/install/SKILL.md'), 'utf8');

function skillRows() {
  return [...SKILL.matchAll(/^\| .* \| `([a-z-]+)` \| `([a-z-]+-minor-patch)` \|$/gm)].map((m) => ({ name: m[1], group: m[2] }));
}

// Root files that turn on every ecosystem ecosystems.cjs knows.
const EVERYTHING = ['package.json', 'uv.lock', 'requirements.txt', 'Cargo.toml', 'go.mod', 'Gemfile', 'composer.json', 'pom.xml', 'build.gradle', 'app.csproj', 'Dockerfile'];

test("the install skill's dependabot.yml table and the gate's ecosystems agree", () => {
  const rows = skillRows();
  const code = ecosystemsFor(EVERYTHING).ecosystems.map(({ name, group }) => ({ name, group }));
  assert.deepEqual(
    rows.slice().sort((a, b) => a.name.localeCompare(b.name)),
    code.slice().sort((a, b) => a.name.localeCompare(b.name)),
  );
});

test('the example entry in the install skill uses a group name from the table', () => {
  const m = /package-ecosystem: (\S+)\n[\s\S]*?groups:\n\s+(\S+):/.exec(SKILL);
  assert.ok(m, 'the skill shows one dependabot.yml entry');
  assert.ok(skillRows().some((r) => r.name === m[1] && r.group === m[2]), `${m[1]} / ${m[2]}`);
});

test('github-actions is always managed, and a bare repo manages only it', () => {
  const e = ecosystemsFor(['README.md']);
  assert.deepEqual(e.ecosystems.map((x) => x.name), ['github-actions']);
  assert.deepEqual(e.prefixes, ['dependabot/github_actions/actions-minor-patch-']);
});
