import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Anthropic's plugin directory refuses a plugin from an organization it has
 * not verified when the plugin holds anything but Markdown, text, JSON, YAML
 * or a PNG, JPEG, GIF, WebP or ICO image, or a file that starts with `#!`, or
 * a package manager's configuration file, or text that is not UTF-8 or holds
 * a NUL byte. It judges a file by its content, whatever its name. v0.17.0 was
 * refused for install.sh and the .cjs templates. This is that rule, applied
 * to every file under plugin/, so a refusal shows up in CI instead of days
 * later on the submission page.
 */

const PLUGIN = join(dirname(dirname(fileURLToPath(import.meta.url))), 'plugin');
const TEXT = /\.(md|txt|json|ya?ml)$/i;
const IMAGE = /\.(png|jpe?g|gif|webp|ico)$/i;
const PACKAGE_CONFIG = /(^|\/)(package\.json|package-lock\.json|pnpm-workspace\.yaml|pnpm-lock\.yaml|yarn\.lock|\.npmrc|\.yarnrc(\.yml)?|requirements\.txt|pyproject\.toml|Gemfile|Cargo\.toml|go\.mod)$/;

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

const MAGIC = {
  png: [0x89, 0x50, 0x4e, 0x47],
  jpg: [0xff, 0xd8, 0xff],
  jpeg: [0xff, 0xd8, 0xff],
  gif: [0x47, 0x49, 0x46, 0x38],
  webp: [0x52, 0x49, 0x46, 0x46],
  ico: [0x00, 0x00, 0x01, 0x00],
};

test('every file in plugin/ is a type the directory accepts from an unverified organization', () => {
  const all = files(PLUGIN);
  assert.ok(all.length > 0);
  for (const f of all) {
    const rel = relative(PLUGIN, f);
    const bytes = readFileSync(f);
    if (IMAGE.test(rel)) {
      const ext = rel.split('.').pop().toLowerCase();
      assert.deepEqual([...bytes.subarray(0, MAGIC[ext].length)], MAGIC[ext], `${rel} is named an image but is not one`);
      continue;
    }
    assert.match(rel, TEXT, `${rel}: only Markdown, text, JSON, YAML and images are accepted`);
    assert.doesNotMatch(rel, PACKAGE_CONFIG, `${rel}: package manager configuration is refused`);
    assert.ok(!bytes.includes(0), `${rel} holds a NUL byte`);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    assert.ok(!text.startsWith('#!'), `${rel} starts with #!`);
  }
});

test('no file in plugin/ is a script under an allowed name', () => {
  // The directory reads content, not names: a YAML or Markdown file that is a
  // program is still a program. The caller templates hold no `run:` step, and
  // no Markdown file is a script body.
  for (const f of files(PLUGIN)) {
    const rel = relative(PLUGIN, f);
    if (!/\.(ya?ml)$/.test(rel)) continue;
    assert.doesNotMatch(readFileSync(f, 'utf8'), /^\s*run:/m, `${rel} runs shell; the pipeline's code belongs in dep-steward's reusable workflows`);
  }
});
