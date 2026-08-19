import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The homepage (docs/index.html, served by GitHub Pages from main:/docs).
 *
 * Everything here rots silently: a renamed asset 404s on the live site, the
 * page's install one-liner drifts from the README's, a command card advertises
 * a skill that no longer exists. Nothing else watches any of it — the page has
 * no build step, so this suite is its only check.
 */

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const html = readFileSync(join(REPO, 'docs', 'index.html'), 'utf8');
const text = html.replace(/<[^>]+>/g, ''); // tag-stripped, for strings markup may split

test('the Pages tree is complete: page, .nojekyll, favicon, og-image', () => {
  // .nojekyll makes Pages serve /docs verbatim instead of running Jekyll.
  for (const p of ['docs/.nojekyll', 'docs/index.html', 'docs/favicon.svg', 'docs/og-image.png']) {
    assert.ok(existsSync(join(REPO, p)), `${p} must exist — Pages serves exactly what is on disk`);
  }
});

test('every asset the page references resolves on disk', () => {
  // Relative href/src (favicon), plus og/twitter images cited by absolute URL —
  // the URL's basename must be a real file in docs/ or the preview 404s.
  const rel = [...html.matchAll(/(?:href|src)="(?!https?:|#|mailto:|data:)([^"]+)"/g)].map((m) => m[1]);
  assert.ok(rel.length > 0, 'expected at least one relative asset (the favicon)');
  for (const p of rel) {
    assert.ok(existsSync(join(REPO, 'docs', p)), `page references "${p}", which is not in docs/`);
  }
  const og = [...html.matchAll(/content="https:\/\/raphaelcm\.github\.io\/dep-steward\/([^"]+\.(?:png|svg))"/g)].map((m) => m[1]);
  assert.ok(og.length >= 1, 'og:image/twitter:image must cite the live site URL');
  for (const p of og) {
    assert.ok(existsSync(join(REPO, 'docs', p)), `social meta cites "${p}", which is not in docs/`);
  }
});

test('the install one-liner is byte-identical to the README’s', () => {
  const readme = readFileSync(join(REPO, 'README.md'), 'utf8');
  const cmd = readme.match(/^sh -c "\$\(curl -fsSL [^\n]*install\.sh\)"$/m)?.[0];
  assert.ok(cmd, 'README must contain the canonical curl install line');
  assert.ok(html.includes(cmd), 'the page must carry the README’s install command verbatim — one canonical line, not two drifting copies');
  const copies = [...html.matchAll(/data-copy='([^']+)'/g)].map((m) => m[1]).filter((c) => c.includes('install.sh'));
  assert.ok(copies.length >= 1 && copies.every((c) => c === cmd), 'every copy button for the installer must copy exactly the README’s command');
});

test('the commands the page advertises are the skills that exist', () => {
  const skills = readdirSync(join(REPO, 'skills'), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  assert.ok(skills.length > 0, 'skills/ must contain the plugin’s skills');
  for (const s of skills) {
    assert.ok(text.includes(`/dep-steward:${s}`), `the page must document /dep-steward:${s} — it exists in skills/`);
  }
  const advertised = [...text.matchAll(/\/dep-steward:([a-z-]+)/g)].map((m) => m[1]);
  for (const a of new Set(advertised)) {
    assert.ok(skills.includes(a), `the page advertises /dep-steward:${a}, which is not a skill on disk`);
  }
});

test('the plugin install lines are byte-identical to the README’s', () => {
  // Two copies of a two-command sequence is two things to drift. The page is
  // the surface a stranger runs the commands from, so it must carry the
  // README’s exactly — a wrong marketplace id or plugin id resolves nothing
  // and reads to them as a broken product, not a typo.
  const readme = readFileSync(join(REPO, 'README.md'), 'utf8');
  const cmds = [...readme.matchAll(/^\/plugin (?:marketplace add|install) \S+$/gm)].map((m) => m[0]);
  assert.deepEqual(
    cmds,
    ['/plugin marketplace add raphaelcm/dep-steward', '/plugin install dep-steward@dep-steward'],
    'the README must document both plugin commands, add before install',
  );
  for (const cmd of cmds) {
    assert.ok(text.includes(cmd), `the page must carry the README’s "${cmd}" verbatim`);
  }
  const copies = [...html.matchAll(/data-copy='([^']+)'/g)].map((m) => m[1]).filter((c) => c.startsWith('/plugin'));
  assert.ok(copies.length >= 1, 'the plugin slip needs a copy button');
  assert.ok(copies.every((c) => cmds.includes(c)), 'every plugin copy button must copy one of the README’s commands');
});

test('the page is self-contained: no external stylesheets, scripts, or images', () => {
  // The product’s story is a trustworthy supply chain; the page keeps it.
  assert.ok(!/<link[^>]+rel="stylesheet"[^>]+href="https?:/i.test(html), 'no external stylesheets');
  assert.ok(!/<script[^>]+src=/i.test(html), 'no external scripts');
  assert.ok(!/<img[^>]+src="https?:/i.test(html), 'no external images');
  assert.ok(html.includes('data:font/woff2;base64,'), 'fonts are embedded, not fetched');
});
