import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { interpolate } from './lib/actions-sim.mjs';
import { workflowText, callerText, toolText, jobsOf, runShippedJob, inputDefaults } from './lib/dep-steward.mjs';

/**
 * The shipped workflows' structure.
 *
 * What an adopter runs is dep-steward's reusable workflows
 * (.github/workflows/{review,automerge,seal-ci-secrets}.yml) at a pinned
 * commit, called by the three short files the plugin installs
 * (plugin/templates/dependabot-{review,automerge,seal}.yml), with the scripts
 * and prompts of actions/tools. Nothing is rendered: these tests read those
 * files as they ship. Behaviour is executed elsewhere (workflow-shell,
 * autofix-push, regenerate, gate-wake); this file pins the structure each
 * of those relies on.
 */

const REVIEW = workflowText('review');
const AUTOMERGE = workflowText('automerge');
const AUTOFIX_PROMPT = toolText('autofix-prompt.md');
const REVIEW_PROMPT = toolText('review-prompt.md');
const CALLER_REVIEW = callerText('review');
const CALLER_AUTOMERGE = callerText('automerge');
const CALLER_SEAL = callerText('seal');

// One job's text, from its header to the next job's.
function jobText(text, name) {
  const at = text.indexOf(`\n  ${name}:\n`);
  assert.ok(at >= 0, `no job ${name}`);
  const rest = text.slice(at + 1);
  const next = rest.slice(3).search(/\n {2}[a-z-]+:\n/);
  return next < 0 ? rest : rest.slice(0, next + 3);
}

test('every escalation in the shipped workflows assigns the configured maintainer, when there is one', () => {
  // The assignee is an input; each `--add-label needs-human-review` carries it
  // only when it is set, quoted, so an empty input assigns nobody.
  for (const [name, text] of [['review', REVIEW], ['automerge', AUTOMERGE]]) {
    const labels = [...text.matchAll(/--add-label needs-human-review(.*)$/gm)];
    assert.ok(labels.length > 0, name);
    for (const m of labels) assert.match(m[1], /^ \$\{ASSIGNEE:\+--add-assignee "\$ASSIGNEE"\}/, `${name}: ${m[0]}`);
  }
  // The prompts get theirs filled by render-prompt.cjs, in code.
  assert.match(REVIEW_PROMPT, /--add-label needs-human-review__ASSIGN_FLAG__/);
  assert.match(AUTOFIX_PROMPT, /--add-label needs-human-review__ASSIGN_FLAG__/);
});

test('the gate runs its own copy from the pinned release, never a checkout', () => {
  const am = jobText(AUTOMERGE, 'auto-merge');
  assert.match(am, /uses: raphaelcm\/dep-steward\/actions\/tools@/);
  assert.match(am, /GATE_OUT=\$\(node "\$RUNNER_TEMP\/dep-steward\/gate\.cjs"\)/);
  assert.doesNotMatch(am, /actions\/checkout@/, 'the merge job checks out nothing: no repo or PR code runs where merging is possible');
});

// ---- autofix is on by default, and the input switches it ------------------

test('autofix is on by default, its job present, and the input turns it off', () => {
  assert.equal(inputDefaults(REVIEW).autofix, true);
  assert.equal(inputDefaults(AUTOMERGE).autofix, true);
  const af = jobText(REVIEW, 'autofix');
  assert.match(af, /inputs\.autofix &&/, 'the autofix job runs only when the input is on');
  assert.match(af, /workflow_run\.conclusion == 'failure'/);
  assert.match(CALLER_REVIEW, /^ {6}autofix: true$/m);
  assert.match(CALLER_AUTOMERGE, /^ {6}autofix: true$/m);
  // The reviewer's lint is the review job's guard, so it ships whether or not
  // the fixer does: the tools action copies it unconditionally.
  assert.match(toolText('action.yml'), /review-lint\.cjs/);
});


// The codes that page a person, as GitHub computes ESCALATABLE_CODES from the
// `autofix` input: evaluated, not read as text, so the list the gate step
// sees is the one checked.
function escalatable(autofix) {
  const m = /^ {6}ESCALATABLE_CODES: (.*)$/m.exec(AUTOMERGE);
  assert.ok(m, 'the auto-merge job computes ESCALATABLE_CODES from the autofix input');
  return interpolate(m[1], { inputs: { autofix }, github: {}, env: {}, steps: {}, secrets: {}, vars: {}, job: {}, runner: {}, needs: {} }).split('|');
}

// ---- the reviewer's prose guard is wired where it can refuse --------------

test('the review step wires the prose lint as a PreToolUse hook, run from the copy the agent cannot write', () => {
  const wf = REVIEW;
  // The action writes this input to ~/.claude/settings.json and Claude Code
  // loads it. If it is not valid JSON the action treats it as a FILE PATH,
  // fails to read it, and throws — every review red, every singleton labelled.
  // So the JSON is parsed here rather than pattern-matched.
  const block = /^\s*settings: \|\n((?:\s{12}.*\n)+)/m.exec(wf);
  assert.ok(block, 'the review step must carry a settings block');
  const hook = JSON.parse(block[1].split('\n').map((l) => l.slice(12)).join('\n').trim());
  const entry = hook.hooks.PreToolUse[0];
  assert.equal(entry.matcher, 'Bash', 'the comment is posted through Bash; any other matcher never fires');
  assert.equal(entry.hooks[0].type, 'command');
  // Never the checkout's lint, which the agent can rewrite: the read-only copy
  // the tools step takes from the pinned release, before the agent starts.
  assert.equal(entry.hooks[0].command, 'node "$RUNNER_TEMP/dep-steward/review-lint.cjs"');
  const review = wf.slice(wf.indexOf('\n  review:'), wf.indexOf('- name: Run Claude review'));
  assert.match(review, /uses: raphaelcm\/dep-steward\/actions\/tools@/,
    'the copy is taken by the tools action, in a step before the review step');
  const action = toolText('action.yml');
  assert.match(action, /\n\s+cp (?:[^\n]*\\\n)*[^\n]*"\$GITHUB_ACTION_PATH"\/review-lint\.cjs(?:[^\n]*\\\n)*[^\n]*"\$D"\//,
    'the tools action copies the lint into the job\'s read-only directory');
  assert.match(action, /chmod -R a-w "\$D"/, 'and made read-only');
  // `$CLAUDE_PROJECT_DIR` is the hook's own shell expanding it; a `${{ }}`
  // here would be GitHub substituting at render time, which is a different
  // (and wrong) thing.
  assert.ok(!entry.hooks[0].command.includes('${{'), 'the path must not be a GitHub expression');
});

test('the fixer\'s hook refuses only a vote: the lint in its fixer role, from the copy taken before it starts', () => {
  const wf = REVIEW;
  const autofixJob = jobText(wf, 'autofix');
  // Reading CI is the fixer's contract, so the reviewer's evidence rule must not
  // apply; but it posts as the identity the gate trusts for verdicts.
  const block = /^\s*settings: \|\n((?:\s{12}.*\n)+)/m.exec(autofixJob);
  assert.ok(block, 'the fixer step must carry a settings block');
  const hook = JSON.parse(block[1].split('\n').map((l) => l.slice(12)).join('\n').trim());
  const [entry] = hook.hooks.PreToolUse;
  assert.equal(entry.matcher, 'Bash');
  assert.equal(entry.hooks[0].command, 'REVIEW_LINT_ROLE=fixer node "$RUNNER_TEMP/dep-steward/review-lint.cjs"');
  const snapshot = autofixJob.slice(0, autofixJob.indexOf('- name: Run the Claude fixer'));
  assert.match(snapshot, /uses: raphaelcm\/dep-steward\/actions\/tools@/,
    'the copy is taken from the pinned release by the tools action, before the fixer starts');
});

// ---- no agent holds a token that can push or merge --------------------------

test('the review agent runs on its job\'s token, which can comment but cannot push or merge', () => {
  const wf = REVIEW;
  const reviewJob = jobText(wf, 'review');
  assert.match(reviewJob, /^\s{10}github_token: \$\{\{ secrets\.GITHUB_TOKEN \}\}$/m,
    'without it the action mints the Claude App token and hands it to the agent');
  assert.doesNotMatch(reviewJob, /id-token:/, 'nothing in this job may mint a token that can push');
});

test('the gate wakes when CI or the review finishes, never on a comment', () => {
  // The triggers belong to the caller files the plugin installs.
  assert.match(CALLER_AUTOMERGE, /on:\n  workflow_run:\n    workflows: \["__CI_NAME__", "Dependabot PR review"\]\n    types: \[completed\]\n/);
  assert.match(CALLER_REVIEW, /^name: Dependabot PR review$/m, 'the name the gate wakes on');
  for (const text of [AUTOMERGE, REVIEW, CALLER_AUTOMERGE, CALLER_REVIEW]) assert.doesNotMatch(text, /issue_comment/);
  assert.match(AUTOMERGE, /^on:\n  workflow_call:/m);
  assert.match(REVIEW, /^on:\n  workflow_call:/m);
  assert.doesNotMatch(REVIEW, /^ {2}auto-merge:/m, 'no job that runs an agent shares a workflow with the merge');
});

test('the deliverable assertion re-runs the same lint over what was posted', () => {
  const wf = REVIEW;
  // One rule, two callers: the hook refuses before the post, this catches a
  // hook that silently stopped firing. A refusal here is red WITHOUT a label —
  // the verdict is valid; dep-steward's own guard is what broke.
  assert.match(wf, /REVIEW_LINT_MODE=body REVIEW_BODY="\$V1_BODIES" node "\$RUNNER_TEMP\/dep-steward\/review-lint\.cjs"/);
  assert.match(wf, /V1_BODIES=\$\(PR_COMMENTS_JSON="\$PR_COMMENTS_JSON" GATE_MODE=verdicts node "\$RUNNER_TEMP\/dep-steward\/gate\.cjs"\)/,
    'the gate says which comments are the deliverable, so the two agree on whose verdict counts');
  const assertStep = wf.slice(wf.indexOf('Assert the review deliverable exists'), wf.indexOf('\n  regenerate:'));
  assert.match(assertStep, /::error::The review comment on PR #\$PR_NUMBER reports on evidence outside/);
  assert.doesNotMatch(assertStep.slice(assertStep.indexOf('passes the prose lint') - 1200, assertStep.indexOf('passes the prose lint')), /add-label/,
    'a lint failure must not page a human — the review delivered a valid verdict');
});

// ---- the autofix draft has ONE prescribed path ---------------------------

test('the path the autofix prompt names is the path the bounds step removes', () => {
  const wf = REVIEW;
  const prompt = AUTOFIX_PROMPT;
  // The agent used to invent this filename (`.autofix-comment.md`,
  // `autofix_comment.md`), the bounds check saw an ADDED file, and three PRs
  // in one batch had their fix discarded for it. Prompt and workflow must name
  // the same path or the removal misses and the discard comes back.
  const named = /gh pr comment \$PR_NUMBER --body-file ([^\s`]+)/.exec(prompt);
  assert.ok(named, 'the autofix prompt must name a body file');
  const removed = /rm -f (\S+)\n(?:(?!\s*git add)[^\n]*\n)*\s*git add -A/.exec(jobText(wf, 'autofix'));
  assert.ok(removed, 'the bounds step must remove the draft before it stages anything');
  assert.equal(named[1], removed[1]);
});

test('neither checkout persists its credential where an agent can write', () => {
  // actions/checkout keeps a persisted credential in a RUNNER_TEMP file the
  // repo's git config includes, and an agent's Write reaches RUNNER_TEMP.
  const wf = REVIEW;
  // Every checkout in the agents' workflow: the review's, the two regenerate
  // jobs' (which ship in every install now, switched by an input), autofix's,
  // and the push job's (which brings its own credential to the push).
  const checkouts = wf.split(/\n(?=\s+- name: )/).filter((step) => /uses: actions\/checkout@/.test(step));
  assert.equal(checkouts.length, 5, 'the review, regenerate, regenerate-verify, autofix and autofix-push checkouts');
  for (const step of checkouts) assert.match(step, /\n\s+persist-credentials: false(\n|$)/, step);
});

test('the shipped autofix job never merges', () => {
  // What it pushes, and as whom, is executed in autofix-push.test.mjs.
  const wf = REVIEW;
  const autofixJob = jobText(wf, 'autofix');
  assert.ok(autofixJob.length > 0);
  assert.doesNotMatch(autofixJob, /gh pr merge/);
});

test('the autofix identity guard matches Dependabot literally, not as a glob', () => {
  const wf = REVIEW;
  const autofixJob = jobText(wf, 'autofix');
  // Same trap as the disarm case above: `case` patterns are globs, so an
  // UNQUOTED dependabot[bot] is a character class matching `dependabotb`, which
  // both admits a near-miss human login and rejects the App's own payload
  // spelling. workflow-shell.test.mjs executes both halves; this locks the
  // spelling in the shipped workflow.
  assert.match(autofixJob, /case "\$AUTHOR" in\s*\n\s*'app\/dependabot'\|'dependabot\[bot\]'\)/);
});

// ---- diagnosability: the frontier model, and real errors surfaced ----------

test('both agent invocations run at the frontier Opus default', () => {
  const wf = REVIEW;
  // A prior build downgraded to claude-opus-4-7 blaming the model for a $0/is_error
  // first turn that was actually an invalid-token 401. Lock the frontier default so
  // that misdiagnosis can't silently return.
  // Both invocations take the model input, whose default is the frontier
  // Opus, and the caller the plugin installs passes the same.
  const models = [...wf.matchAll(/--model (\S+)/g)].map((m) => m[1]);
  assert.deepEqual(models, ['${{', '${{']);
  assert.equal((wf.match(/--model \$\{\{ inputs\.model \}\}/g) || []).length, 2);
  assert.equal(inputDefaults(wf).model, 'claude-opus-4-8');
  assert.match(CALLER_REVIEW, /^ {6}model: claude-opus-4-8$/m);
});

test('a failed agent run surfaces its actual error, not a guess', () => {
  const wf = REVIEW;
  // The review assertion and the autofix bounds-check both read claude-code-action's
  // execution_file and print the agent's real error (e.g. "401 Invalid bearer token"),
  // with a token-specific remedy. Without this the failure is opaque — the exact
  // multi-hour rabbit hole this wiring exists to end.
  assert.match(wf, /EXEC_FILE: \$\{\{ steps\.review\.outputs\.execution_file \}\}/);
  assert.match(wf, /EXEC_FILE: \$\{\{ steps\.fixer\.outputs\.execution_file \}\}/);
  assert.match(wf, /Invalid bearer token/);
  assert.match(wf, /claude setup-token/);
});

test('the action pin lives in dep-steward, never in the files an adopter holds', () => {
  // dep-steward owns the claude-code-action pin now: its own Dependabot moves
  // it, and a release carries it to adopters. A pin in a caller file would be
  // a second copy that drifts.
  for (const [name, text] of [['review', CALLER_REVIEW], ['automerge', CALLER_AUTOMERGE], ['seal', CALLER_SEAL]]) {
    assert.doesNotMatch(text, /claude-code-action/, `the ${name} caller names claude-code-action`);
  }
  assert.doesNotMatch(REVIEW, /claude-code-action@__/, 'no placeholder survives in the shipped workflow');
});

test('both agent jobs run the same SHA-pinned action version', () => {
  const wf = REVIEW;
  // A moving @v1 tag once shipped a breaking bot-gate change silently, so the
  // action is SHA-pinned. The two jobs drifting apart would mean one of them
  // quietly runs a different agent runtime than the one we tested.
  const pins = [...wf.matchAll(/claude-code-action@([0-9a-f]{40}) # (v[\d.]+)/g)].map((m) => `${m[1]} ${m[2]}`);
  assert.equal(pins.length, 2, 'expected exactly two pinned action references');
  assert.equal(pins[0], pins[1], `review and autofix pin different versions: ${pins.join(' vs ')}`);
});

// ---- the gate arms auto-merge; it never merges imperatively ----------------

test('the auto-merge job ARMS GitHub auto-merge rather than merging synchronously', () => {
  const wf = AUTOMERGE;
  // A synchronous merge is a time-of-check/time-of-use race, and this job only
  // wakes on a head change or a comment, so a refusal is never retried. Arming
  // hands the timing to GitHub. Regression guard: no bare imperative merge.
  assert.match(wf, /gh pr merge "\$PR_NUMBER" --repo "\$REPO" --auto "--\$METHOD" --delete-branch/);
  assert.doesNotMatch(wf, /gh pr merge "\$PR_NUMBER" --repo "\$REPO" "\$MERGE_METHOD"/,
    'the imperative merge is the race this design replaced');
  assert.doesNotMatch(wf, /MERGE_METHOD=/,
    'the merge method is gate.cjs output now — computing it in shell puts it where no test can see it');
});

test('a refused merge method falls through to the next ranked one instead of paging a human', () => {
  const wf = AUTOMERGE;
  // No pre-flight query can predict which method GitHub accepts — classic
  // branch protection needs admin to read, and the App-workflow-scope refusal
  // is not a repo setting at all. So the gate's RANKED list must be tried in
  // order; stopping at the first refusal is the defect (Runsense-ai/runsense#2333:
  // every readable layer said merge commits were fine, GitHub refused anyway,
  // and two working methods went untried).
  assert.match(wf, /METHODS=\$\(echo "\$GATE_OUT" \| sed -n 's\/\^methods=\/\/p'\)/);
  assert.match(wf, /for METHOD in "\$@"; do/);
  assert.match(wf, /MERGED_WITH="\$METHOD"\s*\n\s*break/);
  assert.doesNotMatch(wf, /escalate "enabling auto-merge \(--\$METHOD\) failed/,
    'escalating on the FIRST refusal is exactly the behaviour the loop replaces');
  // The refusal is not classified by matching GitHub's error prose — this step
  // already refuses to parse prose to decide whether to page someone.
  assert.doesNotMatch(wf, /Merge commits are not allowed/,
    'pattern-matching GitHub error text is the fragile classifier this design avoids');
  // Escalation carries EVERY method and what GitHub said to each; one method
  // and one error is not enough for a human to act on.
  assert.match(wf, /TRAIL=\$\(printf '%s--%s: %s\\n'/);
  assert.match(wf, /escalate "\$\(printf 'every ranked merge method was refused/);
});

test('a later refusal DISARMS an earlier arm, and fails closed when it cannot tell', () => {
  const wf = AUTOMERGE;
  // Arming is a latch and the gate re-derives on every wake, so a later `skip`
  // must revoke an earlier `merge` — otherwise a PR whose CI went red stays
  // armed to merge itself while the gate says no.
  assert.match(wf, /--disable-auto/);
  assert.match(wf, /ARMED_BY=\$\(gh pr view .*--json autoMergeRequest/s);
  // An unreadable answer must disarm, not skip the disarm.
  assert.match(wf, /\|\| echo "unknown"/);
  assert.match(wf, /\[ -n "\$ARMED_BY" \] \|\| ARMED_BY="unknown"/);
  // `case` patterns are globs: an UNQUOTED github-actions[bot] is a character
  // class matching `github-actionsb`, not the literal login, so the disarm
  // would silently never fire for the identity that does the arming.
  assert.match(wf, /'app\/github-actions'\|'github-actions\[bot\]'\|unknown\)/);
});

test('every failure after the gate authorizes escalates to a human, never a silent red job', () => {
  const wf = AUTOMERGE;
  // Past authorization, a failure is an EXECUTION failure, not a policy
  // decision. A merge that fails silently is indistinguishable from one that
  // never ran, which is how a green PR sits for days.
  const gateStep = wf.slice(wf.indexOf('Deterministic auto-merge gate'));
  assert.match(gateStep, /escalate\(\) \{/);
  assert.match(gateStep, /--add-label needs-human-review \$\{ASSIGNEE:\+--add-assignee "\$ASSIGNEE"\}/);
  assert.match(gateStep, /escalate "\$\(printf 'every ranked merge method was refused/);
  assert.match(gateStep, /if \[ "\$METHODS" = "none" \] \|\| \[ -z "\$METHODS" \]/,
    'a repo permitting no merge method must escalate, not pass `--none` to gh');
});

test('the merge methods come from the repo, resolved across every layer the token can read', () => {
  const wf = AUTOMERGE;
  // Three readable layers, all independent: repo settings, the `pull_request`
  // rule's allowed_merge_methods, and a `required_linear_history` rule — which
  // bans merge commits while saying nothing about allowed_merge_methods, so a
  // repo can advertise all three methods and still refuse one.
  assert.match(wf, /mergeCommitAllowed,rebaseMergeAllowed,squashMergeAllowed/);
  assert.match(wf, /allowed_merge_methods/);
  assert.match(wf, /rules\/branches\/\$DEFAULT_BRANCH/);
  assert.match(wf, /any\(\.\[\]; \.type=="required_linear_history"\)/);
  assert.match(wf, /ALLOWED_MERGE_METHODS: \$\{\{ steps\.methods\.outputs\.allowed_merge_methods \}\}/);
  assert.match(wf, /METHODS=\$\(echo "\$GATE_OUT" \| sed -n 's\/\^methods=\/\/p'\)/);
  // "could not read it" must stay distinguishable from "nothing is allowed".
  assert.match(wf, /"ok:" \+/);
  // One request, two readings — the two restrictions ride in the same response.
  assert.equal((wf.match(/gh api "repos\/\$REPO\/rules\/branches\/\$DEFAULT_BRANCH"/g) || []).length, 1,
    'the rules endpoint is fetched once and read twice, not called per restriction');
});

// ---- a refusal that can never resolve reaches a human ----------------------

test('a terminal refusal escalates; a transient one stays silent', () => {
  const wf = AUTOMERGE;
  const gateStep = wf.slice(wf.indexOf('Deterministic auto-merge gate'));
  // The gate wakes on every CI completion and every bot comment, so most
  // refusals mean "not yet" and must stay quiet. These three mean "never": the
  // gate would refuse the PR forever and tell nobody. (Dependabot does not
  // touch a branch someone else pushed to until a person asks it to rebase.)
  assert.match(gateStep, /CODE=\$\(echo "\$GATE_OUT" \| sed -n 's\/\^code=\/\/p'\)/,
    'the workflow must branch on the stable code, never on the prose reason');
  assert.match(gateStep, /case "\|\$ESCALATABLE_CODES\|" in\s*\n\s*\*"\|\$CODE\|"\*\)/,
    'an exact, delimited match: a code that is a prefix of another must not match it');
  for (const autofix of [true, false]) {
    const codes = escalatable(autofix);
    for (const terminal of ['paths_not_whitelisted', 'verdict_malformed', 'head_pushed_by_other', 'dep_steward_upgrade']) {
      assert.ok(codes.includes(terminal), `${terminal} must escalate (autofix ${autofix})`);
    }
  }
  // An allow-list, so a code added later defaults to silence. These must NOT
  // appear as escalation targets — each already has an owner, or is transient.
  const caseArm = escalatable(true).join('|');
  for (const silent of ['ci_pending', 'ci_indeterminate', 'verdict_missing', 'verdict_escalate',
    'usage_affected', 'author_not_dependabot', 'pr_not_open', 'no_changed_paths', 'head_moved', 'head_pusher_unknown']) {
    for (const autofix of [true, false]) {
      assert.ok(!escalatable(autofix).includes(silent), `${silent} must not escalate — it is transient or already owned`);
    }
  }
  assert.ok(caseArm.length > 0);
});

test('the stuck notice fires once per PR, not once per wake-up', () => {
  const wf = AUTOMERGE;
  const gateStep = wf.slice(wf.indexOf('Deterministic auto-merge gate'));
  // Without the label check a stuck PR collects one comment per CI run forever,
  // which is how a notification channel gets muted.
  assert.match(gateStep, /--json state,headRefOid,author,labels/, 'labels must ride along on the existing query');
  assert.match(gateStep, /grep -qxF 'needs-human-review' <<<"\$PR_LABELS"/);
});

test('a correct refusal notifies without reddening the job; a malfunction reddens', () => {
  const wf = AUTOMERGE;
  const gateStep = wf.slice(wf.indexOf('Deterministic auto-merge gate'));
  // The gate refusing is dep-steward working correctly, so it warns. Failing
  // AFTER authorizing is dep-steward malfunctioning, so it errors and exits 1.
  assert.match(gateStep, /::warning::PR #\$PR_NUMBER cannot merge without a human/);
  assert.match(gateStep, /::error::dep-steward could not merge PR/);
  assert.match(gateStep, /notify_human\(\) \{/, 'both paths share one label+assign+comment helper');
});

test('autofix ON keeps ci_failed off the gate\'s list — one owner, no double-page', () => {
  // When CI goes red the autofix job and the gate wake from the SAME
  // workflow_run event and run in parallel. If both escalated you would be paged
  // about a build the fixer is already fixing.
  assert.ok(!escalatable(true).includes('ci_failed'), 'with autofix on, autofix owns ci_failed');
  // ...and autofix must then actually escalate when it declines, deterministically.
  const autofixJob = jobText(REVIEW, 'autofix');
  assert.match(autofixJob, /The fixer made no edits/);
  assert.match(autofixJob, /--add-label needs-human-review \$\{ASSIGNEE:\+--add-assignee "\$ASSIGNEE"\}/);
  assert.match(autofixJob, /::warning::CI is failing on PR #\$PR_NUMBER and autofix could not fix it/);
});

test('autofix OFF moves ci_failed ONTO the gate\'s list — nothing else is watching CI', () => {
  assert.ok(escalatable(false).includes('ci_failed'),
    'with autofix off no job watches CI, so a red build would strand silently');
  // And the autofix job does not run then: its condition starts with the input.
  const jobs = jobsOf('review');
  assert.match(String(jobs.autofix.if), /^\s*inputs\.autofix &&/);
});

test('both prompt-loads bake in the literal PR number, never cat the raw prompt', () => {
  const wf = REVIEW;
  // Claude Code 2.1.207+ (bundled by recent claude-code-action releases) rejects an
  // allowlisted Bash command that contains a shell expansion ("Contains expansion").
  // So `gh pr diff $PR_NUMBER` must be substituted to `gh pr diff <n>` before the agent
  // sees it, or every gh call is denied and the review times out with no verdict. Both
  // the review and autofix prompt-loads substitute; neither cats the raw prompt.
  // The review load also bakes the PR author (hard rule 3 compares against it now
  // that the agent holds no `gh pr view`), on a `|` delimiter — the value is
  // `app/dependabot` on every routine run, and a `/` would end the s command.
  assert.ok(wf.includes('sed -e "s/\\$PR_NUMBER/$PR_NUMBER/g" -e "s|\\$PR_AUTHOR|$PR_AUTHOR|g" "$RUNNER_TEMP/dep-steward/review-prompt.md"'),
    'review prompt-load must substitute the literal PR number and the author');
  assert.ok(wf.includes('sed -e "s/\\$PR_NUMBER/$PR_NUMBER/g" \\'),
    'autofix prompt-load must substitute the literal PR number');
  // The fixer is also GIVEN the clock rather than left to derive it: three
  // fixers in one batch produced three date rationales for the same failure,
  // one of them naming the wrong weekday in an escalation comment.
  for (const fact of ['CI_RUN_STARTED', 'CI_RUN_WEEKDAY', 'NOW_UTC', 'NOW_WEEKDAY']) {
    assert.ok(wf.includes(`-e "s|\\$${fact}|$${fact}|g" \\`), `autofix prompt-load must bake $${fact}`);
  }
  assert.doesNotMatch(wf, /cat [^\n]*(review|autofix)-prompt\.md/,
    'no prompt-load may cat the raw prompt — that leaves $PR_NUMBER unexpanded → denied');
});

// ---- the regeneration's settings ---------------------------------------------
//
// The command that regenerates committed output, the paths it writes and the
// environment it needs are inputs of the review workflow, set in the caller.
// Both regenerate jobs check them first, before any of the bump's code runs.
// Runsense-ai/runsense#3034's values throughout.

const DEPENDABOT_PR = {
  event_name: 'pull_request',
  actor: 'dependabot[bot]',
  repository: 'o/r',
  event: { pull_request: { number: 7, user: { login: 'dependabot[bot]' }, head: { sha: 'a'.repeat(40) } }, sender: { type: 'Bot' } },
};

async function checkSettings(job, inputs) {
  const temp = mkdtempSync(join(tmpdir(), 'ds-rg-'));
  const res = await runShippedJob('review', job, {
    github: DEPENDABOT_PR,
    inputs,
    cwd: temp,
    env: { ...process.env, RUNNER_TEMP: temp },
    // The check only runs after a regeneration changed something.
    needs: { regenerate: { outputs: { changed: 'true' }, result: 'success' } },
    uses: { 'actions/checkout': async () => ({ exitCode: 1, output: 'checkout is not simulated here' }) },
  });
  assert.equal(res.skipped, false, `${job} must run for a Dependabot PR when a command is set`);
  const [step] = res.steps;
  assert.match(step.name, /^Check the regenerate settings/);
  return { step, jobEnv: res.jobEnv };
}

const GOOD = {
  'regenerate-command': 'npm run db:generate',
  'regenerate-paths': 'src/generated/prisma',
  'regenerate-env': 'DATABASE_URL=postgresql://runsense:runsense@localhost:5432/runsense',
};

for (const job of ['regenerate', 'regenerate-verify']) {
  test(`${job}: good settings pass, and the command's environment reaches the later steps`, async () => {
    const { step, jobEnv } = await checkSettings(job, GOOD);
    assert.equal(step.status, 'success', step.output);
    assert.equal(jobEnv.DATABASE_URL, 'postgresql://runsense:runsense@localhost:5432/runsense');
  });
}

test('with no regenerate command the regenerate jobs do not run', () => {
  const jobs = jobsOf('review');
  for (const job of ['regenerate']) assert.match(String(jobs[job].if), /inputs\.regenerate-command != ''/);
  assert.equal(inputDefaults(REVIEW)['regenerate-command'], '');
  assert.match(CALLER_REVIEW, /^ {6}regenerate-command: ""$/m);
});

for (const [why, inputs, message] of [
  ['a path outside the repository', { 'regenerate-command': 'make gen', 'regenerate-paths': '../elsewhere' }, /inside the repository/],
  ['a path under .github/', { 'regenerate-command': 'make gen', 'regenerate-paths': '.github/generated' }, /never pushes under \.github/],
  ['no path at all', { 'regenerate-command': 'make gen', 'regenerate-paths': '' }, /at least one path/],
  ['a path with an unsupported character', { 'regenerate-command': 'make gen', 'regenerate-paths': 'gen$out' }, /only letters/],
  ['a command over two lines', { 'regenerate-command': 'make gen\nrm -rf /', 'regenerate-paths': 'gen' }, /must be one line/],
  ['an env name the runner owns', { 'regenerate-command': 'make gen', 'regenerate-paths': 'gen', 'regenerate-env': 'GITHUB_TOKEN=x' }, /belongs to the runner/],
  ['an env without a value', { 'regenerate-command': 'make gen', 'regenerate-paths': 'gen', 'regenerate-env': 'DATABASE_URL' }, /NAME=VALUE/],
  ['an env that is not a variable name', { 'regenerate-command': 'make gen', 'regenerate-paths': 'gen', 'regenerate-env': '1X=y' }, /not a variable name/],
  ['an env given twice', { 'regenerate-command': 'make gen', 'regenerate-paths': 'gen', 'regenerate-env': 'A=1\nA=2' }, /given twice/],
]) {
  test(`the regenerate settings refuse ${why}`, async () => {
    for (const job of ['regenerate', 'regenerate-verify']) {
      const { step } = await checkSettings(job, inputs);
      assert.equal(step.status, 'failure', `${job} ran with ${why}:\n${step.output}`);
      assert.match(step.output, message, job);
    }
  });
}

// ---- the caller files the plugin installs -----------------------------------

// `with:` keys under a caller's one job, and the reusable workflow it uses.
function callerCall(text) {
  const uses = /^ {4}uses: raphaelcm\/dep-steward\/\.github\/workflows\/([a-z-]+)\.yml@\S+/m.exec(text);
  assert.ok(uses, 'the caller uses a dep-steward reusable workflow');
  const withBlock = /^ {4}with:\n((?: {6}.*\n)+)/m.exec(text);
  const keys = withBlock ? [...withBlock[1].matchAll(/^ {6}([a-z_-]+):/gm)].map((m) => m[1]) : [];
  return { workflow: uses[1], keys };
}

// Declared workflow_call inputs, and which are required.
function declaredInputs(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^ {4}inputs:\s*$/.test(l));
  const out = {};
  let name = null;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^ {0,4}\S/.test(l)) break;
    const n = /^ {6}([a-z_-]+):\s*$/.exec(l);
    if (n) { name = n[1]; out[name] = false; continue; }
    if (name && /^ {8}required: true/.test(l)) out[name] = true;
  }
  return out;
}

const WORKFLOW_FILE = { review: 'review', automerge: 'automerge', 'seal-ci-secrets': 'seal' };

test('each caller passes only inputs its reusable workflow declares, and every required one', () => {
  for (const [name, text] of [['review', CALLER_REVIEW], ['automerge', CALLER_AUTOMERGE], ['seal', CALLER_SEAL]]) {
    const { workflow, keys } = callerCall(text);
    const declared = declaredInputs(workflowText(WORKFLOW_FILE[workflow]));
    for (const k of keys) assert.ok(k in declared, `${name} caller passes ${k}, which ${workflow}.yml does not declare`);
    for (const [k, required] of Object.entries(declared)) {
      if (required) assert.ok(keys.includes(k), `${name} caller omits required input ${k}`);
    }
  }
});

test('the review caller names a replay in the exact form the auto-merge resolve step parses', () => {
  const m = /^run-name: "(.*)"$/m.exec(CALLER_REVIEW);
  assert.ok(m, 'the review caller carries the run name');
  const name = interpolate(m[1], { inputs: { pr_number: 42 }, github: {}, env: {}, steps: {}, secrets: {}, vars: {}, job: {}, runner: {}, needs: {} });
  assert.equal(name, 'Dependabot PR review of #42');
  assert.match(AUTOMERGE, /sed -n 's\/\^Dependabot PR review of #\\\(\[0-9\]\[0-9\]\*\\\)\$\/\\1\/p'/);
  const plain = interpolate(m[1], { inputs: {}, github: {}, env: {}, steps: {}, secrets: {}, vars: {}, job: {}, runner: {}, needs: {} });
  assert.equal(plain, '', 'a pull_request run keeps GitHub\'s default name');
});

test('every caller names CI through the one placeholder the install skill fills', () => {
  assert.match(CALLER_REVIEW, /^ {4}workflows: \["__CI_NAME__"\]$/m);
  assert.match(CALLER_AUTOMERGE, /^ {4}workflows: \["__CI_NAME__", "Dependabot PR review"\]$/m);
  assert.match(CALLER_AUTOMERGE, /^ {6}ci-name: "__CI_NAME__"$/m);
  assert.match(CALLER_SEAL, /^ {6}ci-name: "__CI_NAME__"$/m);
});

test('the auto-merge caller listens to the review caller by its name', () => {
  const name = /^name: (.*)$/m.exec(CALLER_REVIEW)[1];
  assert.equal(name, 'Dependabot PR review');
  assert.ok(CALLER_AUTOMERGE.includes(`"${name}"`));
});
