import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The shell dep-steward GENERATES must parse.
 *
 * The failure this locks: a `run:` block in the rendered workflow with a shell
 * syntax error. CI shellchecks `install.sh` and the unit tests exercise
 * `gate.cjs`, but nothing ever parsed the shell those two conspire to produce —
 * so an unbalanced quote in a template was invisible to a fully green suite and
 * would only surface as a dead pipeline in an adopter's repo.
 *
 * It is not a subtle failure mode. The auto-merge step is one `run:` block; a
 * syntax error anywhere in it kills the whole step, so NO PR merges, ever. That
 * is a total outage of the thing this project exists to do, and it was one
 * missing `"` away.
 *
 * Caught for real: refactoring `BODY=$(printf …)` into
 * `notify_human "$(printf …)"` added the opening quote and not the closing one.
 * Every line after it parsed inside an unterminated string; `sh -n` reports it
 * in milliseconds.
 *
 * `sh -n` (parse, do not execute) is the whole mechanism — no YAML parser, no
 * dependency, and it runs the same POSIX shell the runner does.
 */

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const REFERENCE_MANIFESTS = ['package.json', 'package-lock.json', 'requirements.txt', 'Cargo.toml', 'go.mod', 'Dockerfile'];

function render(extraArgs = []) {
  const fakeRepo = mkdtempSync(join(tmpdir(), 'ds-sh-repo-'));
  for (const m of REFERENCE_MANIFESTS) writeFileSync(join(fakeRepo, m), '\n');
  const out = mkdtempSync(join(tmpdir(), 'ds-sh-out-'));
  execFileSync(
    'sh',
    [join(REPO, 'install.sh'), '--render-only', '--out', out, '--ci-name', 'CI', '--assignee', 'octocat', ...extraArgs],
    { cwd: fakeRepo, env: { ...process.env, DEP_STEWARD_SRC: REPO }, stdio: 'pipe' },
  );
  return readFileSync(join(out, '.github/workflows/dependabot-review.yml'), 'utf8');
}

// Pull every `run: |` block out of the workflow, with the step name that owns it
// so a failure says WHICH step is broken. Line-oriented on purpose: the project
// ships no YAML parser, and a block scalar ends at the first line indented less
// than its body, which is a rule this can apply directly.
function runBlocks(workflow) {
  const lines = workflow.split('\n');
  const blocks = [];
  let stepName = '(unnamed step)';
  for (let i = 0; i < lines.length; i++) {
    const named = /^\s*- name:\s*(.+)$/.exec(lines[i]);
    if (named) stepName = named[1].trim();
    const runStart = /^(\s*)run:\s*\|\s*$/.exec(lines[i]);
    if (!runStart) continue;
    const bodyIndent = runStart[1].length + 2;
    const body = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() === '') { body.push(''); continue; }
      const indent = line.length - line.replace(/^ */, '').length;
      if (indent < bodyIndent) break;
      body.push(line.slice(bodyIndent));
    }
    blocks.push({ stepName, script: body.join('\n') });
    i = j - 1;
  }
  return blocks;
}

// `${{ … }}` is GitHub's templating, substituted before the shell ever sees it.
// Left in place `${{` is an invalid parameter expansion, so swap each for an
// inert literal — the point is to parse the SHELL, not GitHub's syntax.
function stripActionsExpressions(script) {
  return script.replace(/\$\{\{[^}]*\}\}/g, 'GH_EXPR');
}

function parses(script) {
  const f = join(mkdtempSync(join(tmpdir(), 'ds-shcheck-')), 'step.sh');
  writeFileSync(f, stripActionsExpressions(script));
  try {
    execFileSync('sh', ['-n', f], { stdio: 'pipe' });
    return { ok: true };
  } catch (e) {
    return { ok: false, err: `${e.stderr ?? ''}`.trim() };
  }
}

for (const [variant, args] of [['default', []], ['--no-autofix', ['--no-autofix']]]) {
  const workflow = render(args);
  const blocks = runBlocks(workflow);

  test(`${variant}: the extractor finds every run block (a silent zero makes the rest vacuous)`, () => {
    // If this ever finds nothing, every assertion below passes for free — which
    // is precisely the shape of test that lets a real defect through.
    assert.ok(blocks.length >= 5, `expected several run blocks, found ${blocks.length}`);
    assert.ok(blocks.every((b) => b.script.trim().length > 0), 'an empty block means the extractor is broken');
  });

  for (const { stepName, script } of blocks) {
    test(`${variant}: shell parses — ${stepName}`, () => {
      const { ok, err } = parses(script);
      assert.ok(ok, `\`${stepName}\` does not parse as POSIX shell:\n${err}`);
    });
  }
}
