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

// ---- the deliverable assertion, EXECUTED -------------------------------------
//
// This step decides whether a review that produced nothing pages a human, and
// until now nothing exercised it — `bash -n` proves it parses, which is silent
// about policy. Both of its live failures were policy, not syntax:
//
//   1. It accepted ANY AUTOMERGE-DECISION-V1 comment on the PR. A replay whose
//      post was denied found the STALE comment from an earlier review, and the
//      step went green over a review that delivered nothing.
//   2. It then demanded a verdict for a CLOSED PR, which the gate refuses with
//      `pr_not_open` and deliberately never pages about — so a Dependabot PR
//      closed while its review was in flight ended in {red + label + assignee}
//      for a PR nobody can act on.
//
// The `gh` stub below pipes canned comment JSON through REAL `jq` using the
// step's own `--jq` expression, so the timestamp filter under test is the one
// that ships, not a re-implementation of it.

const ASSERT_GH_STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GH_LOG"
case "$1 $2" in
  "pr view")
    # The step asks twice: once for headRefName+state, once for comments with a
    # --jq filter. Dispatch on which fields were requested.
    for a in "$@"; do
      case "$a" in
        *headRefName*) echo "{\\"headRefName\\":\\"$HEAD_BRANCH\\",\\"state\\":\\"$PR_STATE\\"}"; exit 0 ;;
      esac
    done
    # Comments: run the step's own --jq expression over canned data with real jq.
    expr=""
    prev=""
    for a in "$@"; do
      [ "$prev" = "--jq" ] && expr="$a"
      prev="$a"
    done
    printf '%s' "$PR_COMMENTS_JSON" | jq -r "$expr"
    exit 0 ;;
  "pr diff") echo "package.json" ;;
  *) exit 0 ;;
esac
`;

function runAssertStep({ prState, headBranch, comments, since }) {
  const out = renderTo();
  const workflow = readFileSync(join(out, '.github/workflows/dependabot-review.yml'), 'utf8');
  const block = runBlocks(workflow).find((b) => b.stepName.startsWith('Assert the review deliverable exists'));
  assert.ok(block, 'the deliverable-assertion step must exist — the rest of this test is vacuous without it');

  const bin = mkdtempSync(join(tmpdir(), 'ds-abin-'));
  writeFileSync(join(bin, 'gh'), ASSERT_GH_STUB, { mode: 0o755 });
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
        GH_TOKEN: 'x',
        REPO: 'octocat/repo',
        PR_NUMBER: '1',
        PR_STATE: prState,
        HEAD_BRANCH: headBranch,
        PR_COMMENTS_JSON: JSON.stringify({ comments }),
        SINCE: since,
        EXEC_FILE: '',
      },
    });
  } catch (e) {
    status = e.status ?? 1;
    stdout = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
  const ghCalls = readFileSync(ghLog, 'utf8').split('\n').filter((l) => /^(pr|api|run) /.test(l));
  return { status, stdout, ghCalls };
}

const V1 = '<!-- AUTOMERGE-DECISION-V1 -->\n{"recommendation":"merge","our_usage_affected":false}\n<!-- /AUTOMERGE-DECISION-V1 -->';
const SINGLETON = 'dependabot/npm_and_yarn/ioredis-6.0.0';
const RUN_START = '2026-08-10T06:00:00Z';

test('assertion: a verdict posted by THIS run satisfies it', () => {
  const { status, stdout, ghCalls } = runAssertStep({
    prState: 'OPEN',
    headBranch: SINGLETON,
    comments: [{ createdAt: '2026-08-10T06:05:00Z', body: `## Review\n${V1}` }],
    since: RUN_START,
  });
  assert.equal(status, 0, `a fresh verdict must pass:\n${stdout}`);
  assert.ok(!ghCalls.some((c) => c.includes('needs-human-review')), 'a delivered review must not label');
});

test('assertion: a STALE verdict from an earlier review does NOT satisfy it', () => {
  // The exact live false green: the agent's post was denied, its self-check
  // found this older comment, and the job went green having delivered nothing.
  const { status, stdout, ghCalls } = runAssertStep({
    prState: 'OPEN',
    headBranch: SINGLETON,
    comments: [{ createdAt: '2026-08-10T04:53:52Z', body: `## Review\n${V1}` }],
    since: RUN_START,
  });
  assert.notEqual(status, 0, 'a review that delivered nothing must go red');
  assert.match(stdout, /No AUTOMERGE-DECISION-V1 comment posted during this run/);
  assert.ok(ghCalls.some((c) => c.includes('needs-human-review')), 'it must label so a human sees it');
});

test('assertion: a CLOSED PR is owed no verdict, and pages nobody', () => {
  // gate.cjs refuses a closed PR with `pr_not_open` and the auto-merge job keeps
  // that code out of its escalation allow-list on purpose. This step used to
  // hold the opposite policy and page about PRs nobody can act on.
  const { status, stdout, ghCalls } = runAssertStep({
    prState: 'CLOSED',
    headBranch: SINGLETON,
    comments: [],
    since: RUN_START,
  });
  assert.equal(status, 0, `a closed PR must not go red:\n${stdout}`);
  assert.match(stdout, /is CLOSED, not OPEN/);
  assert.ok(!ghCalls.some((c) => c.includes('needs-human-review')), 'a closed PR must never be labelled or assigned');
});

test('assertion: an OPEN singleton with no verdict at all still pages a human', () => {
  // The invariant the step exists for, unchanged by either scoping fix.
  const { status, ghCalls } = runAssertStep({
    prState: 'OPEN',
    headBranch: SINGLETON,
    comments: [],
    since: RUN_START,
  });
  assert.notEqual(status, 0, 'a missing verdict on a mergeable PR must go red');
  assert.ok(ghCalls.some((c) => c.includes('needs-human-review')), 'it must label so a human sees it');
});

test('assertion: a minor/patch GROUP PR is owed no verdict (the gate merges it verdict-free)', () => {
  const { status, stdout, ghCalls } = runAssertStep({
    prState: 'OPEN',
    headBranch: 'dependabot/npm_and_yarn/npm-minor-patch-abc123',
    comments: [],
    since: RUN_START,
  });
  assert.equal(status, 0, `a group PR must not go red:\n${stdout}`);
  assert.match(stdout, /is a minor\/patch group/);
  assert.ok(!ghCalls.some((c) => c.includes('needs-human-review')), 'a group PR must never be labelled');
});

// ---- the prompt load, EXECUTED ----------------------------------------------
//
// The Load agent prompt step went from pure text transformation to a step
// with a gh call and a two-expression sed, and its interesting failure modes
// are invisible to both `bash -n` and byte-parity:
//
//   1. The author sed's delimiter. `gh pr view --json author` renders
//      Dependabot as `app/dependabot` (gate.cjs documents the spelling
//      pair), so a `/`-delimited s command dies with a sed syntax error on
//      EVERY routine run — no review ever happens.
//   2. A $-token surviving into the agent's prompt. An unsubstituted
//      $PR_NUMBER is the 2.1.207 "Contains expansion" denial class; an
//      unsubstituted $PR_AUTHOR silently voids hard rule 3's comparison.
//
// The stub gh answers `pr view` with the login itself — the step's --jq runs
// inside real gh, so the stub emits the command's OUTPUT. `date` is stubbed
// because the step uses GNU `date -d`, which BSD/macOS date lacks: the
// timestamp is not what these tests lock, and the suite must pass on a dev
// Mac (CI is Ubuntu).

const PROMPT_GH_STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GH_LOG"
case "$1 $2" in
  "pr view") echo "$STUB_AUTHOR" ;;
  *) exit 0 ;;
esac
`;

const DATE_STUB = `#!/usr/bin/env bash
echo "2026-08-10T06:00:00Z"
`;

function runPromptLoadStep({ stubAuthor }) {
  const out = renderTo();
  const workflow = readFileSync(join(out, '.github/workflows/dependabot-review.yml'), 'utf8');
  const block = runBlocks(workflow).find((b) => b.stepName === 'Load agent prompt');
  assert.ok(block, 'the Load agent prompt step must exist — the rest of this test is vacuous without it');

  const bin = mkdtempSync(join(tmpdir(), 'ds-pbin-'));
  writeFileSync(join(bin, 'gh'), PROMPT_GH_STUB, { mode: 0o755 });
  writeFileSync(join(bin, 'date'), DATE_STUB, { mode: 0o755 });
  const ghLog = join(bin, 'gh.log');
  writeFileSync(ghLog, '');
  const githubOutput = join(bin, 'github_output');
  writeFileSync(githubOutput, '');
  const script = join(bin, 'step.sh');
  writeFileSync(script, stripActionsExpressions(block.script));

  let status = 0;
  let stderr = '';
  try {
    execFileSync('bash', ['-e', script], {
      cwd: out,
      encoding: 'utf8',
      stdio: 'pipe',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        GH_LOG: ghLog,
        STUB_AUTHOR: stubAuthor,
        GH_TOKEN: 'x',
        REPO: 'octocat/repo',
        PR_NUMBER: '123',
        GITHUB_OUTPUT: githubOutput,
      },
    });
  } catch (e) {
    status = e.status ?? 1;
    stderr = `${e.stderr ?? ''}`;
  }
  const output = readFileSync(githubOutput, 'utf8');
  const ghCalls = readFileSync(ghLog, 'utf8').split('\n').filter(Boolean);
  return { status, stderr, output, ghCalls };
}

test('prompt-load: a slash-bearing author (app/dependabot) survives substitution and no $-token reaches the agent', () => {
  const { status, stderr, output } = runPromptLoadStep({ stubAuthor: 'app/dependabot' });
  assert.equal(status, 0, `the step must succeed on the value every routine run produces:\n${stderr}`);
  assert.match(output, /^prompt<<PROMPT_EOF_8X2Y$/m, 'the rendered prompt must reach GITHUB_OUTPUT as a heredoc');
  assert.match(output, /^review_started=/m, 'the run-start timestamp must still be emitted');
  assert.ok(output.includes('gh pr diff 123'), 'the PR number must be baked into the ordered commands');
  assert.ok(output.includes('`app/dependabot`'), "the author must land in hard rule 3's fact line");
  assert.ok(!output.includes('$PR_NUMBER'), 'an unsubstituted $PR_NUMBER is the "Contains expansion" denial class');
  assert.ok(!output.includes('$PR_AUTHOR'), 'an unsubstituted $PR_AUTHOR silently voids the authorship rule');
});

test('prompt-load: a non-Dependabot author lands verbatim in the escalation rule', () => {
  const { status, stderr, output, ghCalls } = runPromptLoadStep({ stubAuthor: 'octocat' });
  assert.equal(status, 0, `the step must succeed:\n${stderr}`);
  assert.ok(output.includes('`octocat`'), 'the foreign author must be visible to the escalation rule');
  assert.ok(ghCalls.some((c) => c.startsWith('pr view 123')), 'the author must come from gh pr view on the workflow token');
});

// ---- the autofix identity guard, EXECUTED ------------------------------------
//
// This step is the autofix job's whole answer to "is this really Dependabot's
// PR?", and it decides that with a `case`. `case` patterns are GLOBS, which is
// the trap the auto-merge job already hit and documented for `$ARMED_BY`: an
// UNQUOTED `dependabot[bot]` is the literal `dependabot` followed by the
// character class `[bot]`, so it matches `dependabotb`/`dependaboto`/
// `dependabott` and never the login it is written to match.
//
// Both halves of that are wrong in a way reading cannot catch and `bash -n`
// cannot catch — it parses perfectly either way. Only executing the branch with
// each spelling shows which logins the guard actually admits, so that is what
// this does, against the REAL rendered shell.

const RESOLVE_GH_STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GH_LOG"
# Both calls in this step pass --jq, so the stub emits the POST-jq value: gh
# applies the filter itself and prints a bare number / a bare login.
case "$1 $2" in
  "pr list") echo "1" ;;
  "pr view") echo "$STUB_AUTHOR" ;;
  *) exit 0 ;;
esac
`;

function runResolveStep({ author }) {
  const out = renderTo();
  const workflow = readFileSync(join(out, '.github/workflows/dependabot-review.yml'), 'utf8');
  const block = runBlocks(workflow).find((b) => b.stepName.startsWith('Resolve the PR'));
  assert.ok(block, 'the autofix resolve step must exist — the rest of this test is vacuous without it');

  const bin = mkdtempSync(join(tmpdir(), 'ds-rbin-'));
  writeFileSync(join(bin, 'gh'), RESOLVE_GH_STUB, { mode: 0o755 });
  const ghLog = join(bin, 'gh.log');
  writeFileSync(ghLog, '');
  // The step's only durable effect is what it writes here; `set -u` also means
  // it must be set or the block dies before reaching the guard.
  const githubOutput = join(bin, 'github_output');
  writeFileSync(githubOutput, '');

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
        GH_TOKEN: 'x',
        REPO: 'octocat/repo',
        HEAD_BRANCH: 'dependabot/npm_and_yarn/ioredis-6.0.0',
        STUB_AUTHOR: author,
        GITHUB_OUTPUT: githubOutput,
      },
    });
  } catch (e) {
    status = e.status ?? 1;
    stdout = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
  const outputs = Object.fromEntries(
    readFileSync(githubOutput, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
  return { status, stdout, outputs };
}

test('autofix guard: the gh-CLI spelling of Dependabot proceeds', () => {
  // `gh pr view --json author --jq .author.login` normalizes the Dependabot App
  // to `app/dependabot`; this is the spelling the step sees in production, so
  // this case is the one that must never regress while the others are fixed.
  const { status, stdout, outputs } = runResolveStep({ author: 'app/dependabot' });
  assert.equal(status, 0, `the live path must succeed:\n${stdout}`);
  assert.equal(outputs.skip, undefined, 'the real Dependabot must not be skipped');
  assert.equal(outputs.pr_number, '1');
  assert.equal(outputs.head_branch, 'dependabot/npm_and_yarn/ioredis-6.0.0');
});

test('autofix guard: the event-payload spelling of Dependabot also proceeds', () => {
  // `dependabot[bot]` is the same App as seen from event payloads — the spelling
  // gate.cjs pairs with `app/dependabot` and the review job compares against.
  // UNQUOTED, the pattern is a character class and rejects this login outright,
  // so the arm written to accept it silently skips instead. Nothing today feeds
  // this spelling here, but the payload is already in scope for this job
  // (`github.event.workflow_run.actor.login` is `dependabot[bot]`), so the arm
  // is dead by wiring, not by construction — one refactor from being load-bearing.
  const { status, stdout, outputs } = runResolveStep({ author: 'dependabot[bot]' });
  assert.equal(status, 0, `the payload spelling must succeed:\n${stdout}`);
  assert.equal(outputs.skip, undefined, 'the bracket spelling names the same App and must not be skipped');
  assert.equal(outputs.pr_number, '1');
});

test('autofix guard: a login one character off Dependabot is REFUSED', () => {
  // The other half of the glob bug, and the one that matters without any
  // refactor: unquoted, `dependabot[bot]` matches `dependabot` + one of b/o/t,
  // so `dependabott` (unregistered on GitHub, therefore claimable) passes a
  // check whose entire purpose is confirming the PR is Dependabot's.
  const { status, stdout, outputs } = runResolveStep({ author: 'dependabott' });
  assert.equal(status, 0, `a refusal is a clean no-op, not a failure:\n${stdout}`);
  assert.equal(outputs.skip, 'true', 'a near-miss human login must never satisfy the Dependabot guard');
  assert.equal(outputs.pr_number, undefined, 'a skipped run must publish no PR for the fixer to edit');
  assert.match(stdout, /not Dependabot/);
});

test('autofix guard: an unrelated bot is refused', () => {
  const { outputs } = runResolveStep({ author: 'renovate[bot]' });
  assert.equal(outputs.skip, 'true');
  assert.equal(outputs.pr_number, undefined);
});
