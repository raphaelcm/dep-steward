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
 * Every line after it parsed inside an unterminated string; `bash -n` reports it
 * in milliseconds.
 *
 * `bash -n` (parse, do not execute) is the whole mechanism — no YAML parser and
 * no dependency.
 *
 * BASH, not `sh`, because that is what actually runs these blocks: GitHub's
 * default shell for `run:` on Linux runners is `bash -e {0}`, and the workflow
 * uses bash herestrings (`<<<`) deliberately. Checking with `sh -n` looks
 * equivalent on macOS, where /bin/sh IS bash — and then fails on Ubuntu, where
 * /bin/sh is dash and rejects every `<<<`. The lint has to match the shell the
 * code runs under, or it reports on a language nobody is writing.
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
    execFileSync('bash', ['-n', f], { stdio: 'pipe' });
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
      assert.ok(ok, `\`${stepName}\` does not parse under bash:\n${err}`);
    });
  }
}

// ---- the merge-method fallback, EXECUTED ------------------------------------
//
// Parsing proves the block is syntactically whole; it says nothing about whether
// a refused method leads anywhere. And the behaviour cannot be observed on a
// real repo whose restrictions are readable — there the first ranked method just
// works, and the fallback never fires. So it is exercised here against a `gh`
// that refuses exactly the way GitHub did on Runsense-ai/runsense#2333, with the
// REAL rendered gate and the REAL generated shell in between.
//
// Without this, the fallback ships unproven.

function renderTo() {
  const fakeRepo = mkdtempSync(join(tmpdir(), 'ds-run-repo-'));
  for (const m of REFERENCE_MANIFESTS) writeFileSync(join(fakeRepo, m), '\n');
  const out = mkdtempSync(join(tmpdir(), 'ds-run-out-'));
  execFileSync(
    'sh',
    [join(REPO, 'install.sh'), '--render-only', '--out', out, '--ci-name', 'CI', '--assignee', 'octocat'],
    { cwd: fakeRepo, env: { ...process.env, DEP_STEWARD_SRC: REPO }, stdio: 'pipe' },
  );
  return out;
}

// A `gh` that accepts only the methods named in ACCEPT_METHODS, refusing every
// other `pr merge` with GitHub's real wording. Every call is appended to
// $GH_LOG so the assertions can read what the step actually did.
const GH_STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GH_LOG"
case "$1 $2" in
  "pr view")
    echo '{"state":"OPEN","author":{"login":"app/dependabot"},"comments":[],"labels":[]}' ;;
  "pr diff")
    echo ".github/workflows/ci.yml" ;;
  "pr merge")
    for a in "$@"; do
      case "$a" in
        --merge|--squash|--rebase)
          m="\${a#--}"
          case ",$ACCEPT_METHODS," in
            *",$m,"*) echo "armed with $m"; exit 0 ;;
            *) echo "GraphQL: Merge commits are not allowed on this repository. (mergePullRequest)" >&2; exit 1 ;;
          esac ;;
      esac
    done
    exit 0 ;;
  *) exit 0 ;;
esac
`;

function runGateStep({ acceptMethods, allowedMergeMethods }) {
  const out = renderTo();
  const workflow = readFileSync(join(out, '.github/workflows/dependabot-review.yml'), 'utf8');
  const block = runBlocks(workflow).find((b) => b.stepName === 'Deterministic auto-merge gate');
  assert.ok(block, 'the auto-merge gate step must exist — the rest of this test is vacuous without it');

  const bin = mkdtempSync(join(tmpdir(), 'ds-bin-'));
  writeFileSync(join(bin, 'gh'), GH_STUB, { mode: 0o755 });
  const ghLog = join(bin, 'gh.log');
  writeFileSync(ghLog, '');

  const script = join(bin, 'step.sh');
  writeFileSync(script, stripActionsExpressions(block.script));

  let status = 0;
  let stdout = '';
  try {
    stdout = execFileSync('bash', ['-e', script], {
      cwd: out,
      encoding: 'utf8',
      stdio: 'pipe',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        GH_LOG: ghLog,
        ACCEPT_METHODS: acceptMethods,
        GH_TOKEN: 'x',
        REPO: 'octocat/repo',
        PR_NUMBER: '1',
        HEAD_BRANCH: 'dependabot/github_actions/actions-minor-patch-a',
        CI_CONCLUSION: 'success',
        ALLOWED_MERGE_METHODS: allowedMergeMethods,
      },
    });
  } catch (e) {
    status = e.status ?? 1;
    stdout = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
  // A comment body spans lines, so the raw log is kept alongside the per-call
  // view: splitting it into "calls" would chop one `pr comment` into several.
  const ghLogText = readFileSync(ghLog, 'utf8');
  const ghCalls = ghLogText.split('\n').filter((l) => /^(pr|api|run|release) /.test(l));
  return { status, stdout, ghCalls, ghLogText };
}

test('a refused merge commit falls through to rebase, merges, and pages nobody', () => {
  // The exact Runsense shape: every readable layer reports all three methods,
  // and GitHub refuses the merge commit anyway. Before the fallback, this was a
  // red job and a `needs-human-review` label on a PR that was perfectly
  // mergeable two methods down the list.
  const { status, stdout, ghCalls } = runGateStep({
    acceptMethods: 'squash,rebase',
    allowedMergeMethods: 'merge,squash,rebase',
  });

  assert.equal(status, 0, `the step must succeed once a method lands:\n${stdout}`);
  const attempts = ghCalls.filter((c) => c.startsWith('pr merge'));
  assert.ok(attempts[0].includes('--merge'), `first attempt should be the ranked head, got: ${attempts[0]}`);
  assert.ok(attempts[1].includes('--rebase'), `second attempt should be the next rank, got: ${attempts[1]}`);
  assert.equal(attempts.length, 2, 'it must stop at the first method that works, not keep going');
  assert.match(stdout, /Auto-merge armed on PR #1 with --rebase\./);
  // The whole point: no human is involved in a merge that succeeded.
  assert.equal(ghCalls.filter((c) => c.startsWith('pr comment')).length, 0, 'a successful fallback must not comment');
  assert.ok(!ghCalls.some((c) => c.includes('needs-human-review')), 'a successful fallback must not label');
});

test('when every ranked method is refused, one escalation carries them all', () => {
  const { status, stdout, ghCalls, ghLogText } = runGateStep({
    acceptMethods: 'nothing',
    allowedMergeMethods: 'merge,squash,rebase',
  });

  assert.notEqual(status, 0, 'exhausting the list is a malfunction and must go red');
  assert.equal(ghCalls.filter((c) => c.startsWith('pr merge')).length, 3, 'every ranked method must be tried');
  // ONE comment, not one per attempt — a notifier that fires per retry is noise.
  assert.equal(ghCalls.filter((c) => c.startsWith('pr comment')).length, 1);
  // One method and one error is not enough for a human to act on: the comment
  // has to say what GitHub said to EACH candidate.
  const comment = ghLogText.slice(ghLogText.indexOf('pr comment'));
  for (const m of ['--merge', '--rebase', '--squash']) {
    assert.ok(comment.includes(`${m}: GraphQL:`), `the escalation must name ${m} and what GitHub said to it`);
  }
  assert.match(stdout, /every ranked merge method was refused/);
});
