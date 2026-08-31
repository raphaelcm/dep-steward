import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Render determinism.
 *
 * install.sh --render-only, given a fixed reference parameter set (CI workflow
 * "CI"; a multi-ecosystem repo — npm/pip/cargo/gomod/docker + Actions; default
 * model; assignee "octocat"), must reproduce the committed fixtures under
 * test/fixtures/expected/reference/ BYTE FOR BYTE.
 * This locks the rendering logic — any drift in a template or a substitution
 * fails here. The fixtures are a synthetic reference, not a mirror of any real
 * repo.
 */

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const GOLDEN = join(REPO, 'test', 'fixtures', 'expected', 'reference');

const FILES = [
  '.github/dependabot.yml',
  '.github/dependabot-review-prompt.md',
  '.github/workflows/dependabot-review.yml',
  '.github/dependabot-automerge/gate.cjs',
  // autofix is ON by default, so the reference render includes these too:
  '.github/dependabot-automerge/autofix-bounds.cjs',
  '.github/dependabot-autofix-prompt.md',
];

// A representative multi-ecosystem repo, so the fixture exercises the catalog
// broadly: exact-path ecosystems (cargo, gomod), a regex ecosystem (pip's
// requirements*.txt), the conservative docker whitelist, npm, and always Actions.
const REFERENCE_MANIFESTS = ['package.json', 'package-lock.json', 'requirements.txt', 'Cargo.toml', 'go.mod', 'Dockerfile'];

function renderReference() {
  const fakeRepo = mkdtempSync(join(tmpdir(), 'ds-ref-repo-'));
  for (const m of REFERENCE_MANIFESTS) writeFileSync(join(fakeRepo, m), '\n');
  const out = mkdtempSync(join(tmpdir(), 'ds-ref-out-'));
  execFileSync(
    'sh',
    [join(REPO, 'install.sh'), '--render-only', '--out', out, '--ci-name', 'CI', '--assignee', 'octocat'],
    { cwd: fakeRepo, env: { ...process.env, DEP_STEWARD_SRC: REPO }, stdio: 'pipe' },
  );
  return out;
}

const rendered = renderReference();

for (const f of FILES) {
  test(`renders ${f} byte-identical to the reference fixture`, () => {
    const got = readFileSync(join(rendered, f), 'utf8');
    const want = readFileSync(join(GOLDEN, f), 'utf8');
    assert.equal(got, want);
  });
}

test('the rendered workflow points at the relocated gate path', () => {
  const wf = readFileSync(join(rendered, '.github/workflows/dependabot-review.yml'), 'utf8');
  assert.match(wf, /node \.github\/dependabot-automerge\/gate\.cjs/);
  assert.doesNotMatch(wf, /scripts\/dev\/dependabot-automerge-gate\.cjs/);
});

test('the escalate path assigns the configured maintainer', () => {
  const prompt = readFileSync(join(rendered, '.github/dependabot-review-prompt.md'), 'utf8');
  const wf = readFileSync(join(rendered, '.github/workflows/dependabot-review.yml'), 'utf8');
  assert.match(prompt, /--add-label needs-human-review --add-assignee octocat/);
  assert.match(wf, /--add-label needs-human-review --add-assignee octocat/);
});

test('generates a dependabot.yml entry per detected ecosystem', () => {
  const yml = readFileSync(join(rendered, '.github/dependabot.yml'), 'utf8');
  for (const eco of ['npm', 'pip', 'cargo', 'gomod', 'docker', 'github-actions']) {
    assert.match(yml, new RegExp(`package-ecosystem: ${eco}\\b`), `missing ${eco} in dependabot.yml`);
  }
});

test("the gate keys off Dependabot's branch slugs, not the config names", () => {
  const gate = readFileSync(join(rendered, '.github/dependabot-automerge/gate.cjs'), 'utf8');
  // The three slugs that differ from the config value are the ones we most fear.
  assert.match(gate, /'dependabot\/npm_and_yarn\/npm-minor-patch-'/);
  assert.match(gate, /'dependabot\/go_modules\/gomod-minor-patch-'/);
  assert.match(gate, /'dependabot\/github_actions\/actions-minor-patch-'/);
  // And an identity one for good measure.
  assert.match(gate, /'dependabot\/cargo\/cargo-minor-patch-'/);
});

// ---- --autofix opt-in: the job and its files appear iff the flag is set ----

function renderWith(extraArgs) {
  const fakeRepo = mkdtempSync(join(tmpdir(), 'ds-af-repo-'));
  for (const m of REFERENCE_MANIFESTS) writeFileSync(join(fakeRepo, m), '\n');
  const out = mkdtempSync(join(tmpdir(), 'ds-af-out-'));
  execFileSync(
    'sh',
    [join(REPO, 'install.sh'), '--render-only', '--out', out, '--ci-name', 'CI', '--assignee', 'octocat', ...extraArgs],
    { cwd: fakeRepo, env: { ...process.env, DEP_STEWARD_SRC: REPO }, stdio: 'pipe' },
  );
  return out;
}

test('by default the autofix job and its two files render, all markers substituted', () => {
  const wf = readFileSync(join(rendered, '.github/workflows/dependabot-review.yml'), 'utf8');
  assert.match(wf, /^ {2}autofix:/m);
  assert.match(wf, /workflow_run\.conclusion == 'failure'/);
  assert.doesNotMatch(wf, /__AUTOFIX_JOB__|__MODEL__|__CI_NAME__|__ASSIGN_FLAG__/);
  assert.ok(existsSync(join(rendered, '.github/dependabot-automerge/autofix-bounds.cjs')));
  const prompt = readFileSync(join(rendered, '.github/dependabot-autofix-prompt.md'), 'utf8');
  assert.match(prompt, /--add-label needs-human-review --add-assignee octocat/);
});

test('--no-autofix removes the job, its files, and leaves no marker', () => {
  const out = renderWith(['--no-autofix']);
  const wf = readFileSync(join(out, '.github/workflows/dependabot-review.yml'), 'utf8');
  assert.doesNotMatch(wf, /^ {2}autofix:/m);
  assert.doesNotMatch(wf, /__AUTOFIX_JOB__/);
  assert.ok(!existsSync(join(out, '.github/dependabot-automerge/autofix-bounds.cjs')));
  assert.ok(!existsSync(join(out, '.github/dependabot-autofix-prompt.md')));
});

test('the rendered autofix job pushes for a human to merge — it never merges', () => {
  const wf = readFileSync(join(rendered, '.github/workflows/dependabot-review.yml'), 'utf8');
  const autofixJob = wf.slice(wf.indexOf('\n  autofix:'));
  assert.ok(autofixJob.length > 0);
  assert.doesNotMatch(autofixJob, /gh pr merge/);
  assert.match(autofixJob, /git push origin/);
});

// ---- diagnosability: the frontier model, and real errors surfaced ----------

test('both agent invocations run at the frontier Opus default', () => {
  const wf = readFileSync(join(rendered, '.github/workflows/dependabot-review.yml'), 'utf8');
  // A prior build downgraded to claude-opus-4-7 blaming the model for a $0/is_error
  // first turn that was actually an invalid-token 401. Lock the frontier default so
  // that misdiagnosis can't silently return.
  const models = [...wf.matchAll(/--model (claude-opus-[\d-]+)/g)].map((m) => m[1]);
  assert.deepEqual(models, ['claude-opus-4-8', 'claude-opus-4-8']);
});

test('a failed agent run surfaces its actual error, not a guess', () => {
  const wf = readFileSync(join(rendered, '.github/workflows/dependabot-review.yml'), 'utf8');
  // The review assertion and the autofix bounds-check both read claude-code-action's
  // execution_file and print the agent's real error (e.g. "401 Invalid bearer token"),
  // with a token-specific remedy. Without this the failure is opaque — the exact
  // multi-hour rabbit hole this wiring exists to end.
  assert.match(wf, /EXEC_FILE: \$\{\{ steps\.review\.outputs\.execution_file \}\}/);
  assert.match(wf, /EXEC_FILE: \$\{\{ steps\.fixer\.outputs\.execution_file \}\}/);
  assert.match(wf, /Invalid bearer token/);
  assert.match(wf, /claude setup-token/);
});

test('both agent jobs run the same SHA-pinned action version', () => {
  const wf = readFileSync(join(rendered, '.github/workflows/dependabot-review.yml'), 'utf8');
  // A moving @v1 tag once shipped a breaking bot-gate change silently, so the
  // action is SHA-pinned. The two jobs drifting apart would mean one of them
  // quietly runs a different agent runtime than the one we tested.
  const pins = [...wf.matchAll(/claude-code-action@([0-9a-f]{40}) # (v[\d.]+)/g)].map((m) => `${m[1]} ${m[2]}`);
  assert.equal(pins.length, 2, 'expected exactly two pinned action references');
  assert.equal(pins[0], pins[1], `review and autofix pin different versions: ${pins.join(' vs ')}`);
});

// ---- the gate arms auto-merge; it never merges imperatively ----------------

test('the auto-merge job ARMS GitHub auto-merge rather than merging synchronously', () => {
  const wf = readFileSync(join(rendered, '.github/workflows/dependabot-review.yml'), 'utf8');
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
  const wf = readFileSync(join(rendered, '.github/workflows/dependabot-review.yml'), 'utf8');
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
  const wf = readFileSync(join(rendered, '.github/workflows/dependabot-review.yml'), 'utf8');
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
  const wf = readFileSync(join(rendered, '.github/workflows/dependabot-review.yml'), 'utf8');
  // Past authorization, a failure is an EXECUTION failure, not a policy
  // decision. A merge that fails silently is indistinguishable from one that
  // never ran, which is how a green PR sits for days.
  const gateStep = wf.slice(wf.indexOf('Deterministic auto-merge gate'), wf.indexOf('\n  autofix:'));
  assert.match(gateStep, /escalate\(\) \{/);
  assert.match(gateStep, /--add-label needs-human-review --add-assignee octocat/);
  assert.match(gateStep, /escalate "\$\(printf 'every ranked merge method was refused/);
  assert.match(gateStep, /if \[ "\$METHODS" = "none" \] \|\| \[ -z "\$METHODS" \]/,
    'a repo permitting no merge method must escalate, not pass `--none` to gh');
});

test('the merge methods come from the repo, resolved across every layer the token can read', () => {
  const wf = readFileSync(join(rendered, '.github/workflows/dependabot-review.yml'), 'utf8');
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
  const wf = readFileSync(join(rendered, '.github/workflows/dependabot-review.yml'), 'utf8');
  const gateStep = wf.slice(wf.indexOf('Deterministic auto-merge gate'), wf.indexOf('\n  autofix:'));
  // The gate wakes on every CI completion and every bot comment, so most
  // refusals mean "not yet" and must stay quiet. These two mean "never": the
  // gate would refuse the PR forever and tell nobody.
  assert.match(gateStep, /CODE=\$\(echo "\$GATE_OUT" \| sed -n 's\/\^code=\/\/p'\)/,
    'the workflow must branch on the stable code, never on the prose reason');
  assert.match(gateStep, /case "\$CODE" in\s*\n\s*paths_not_whitelisted\|verdict_malformed\)/);
  // An allow-list, so a code added later defaults to silence. These must NOT
  // appear as escalation targets — each already has an owner, or is transient.
  const caseArm = /case "\$CODE" in\s*\n\s*([a-z_|]+)\)/.exec(gateStep)?.[1] ?? '';
  for (const silent of ['ci_pending', 'ci_indeterminate', 'verdict_missing', 'verdict_escalate',
    'usage_affected', 'author_not_dependabot', 'pr_not_open', 'no_changed_paths']) {
    assert.ok(!caseArm.split('|').includes(silent), `${silent} must not escalate — it is transient or already owned`);
  }
});

test('the stuck notice fires once per PR, not once per wake-up', () => {
  const wf = readFileSync(join(rendered, '.github/workflows/dependabot-review.yml'), 'utf8');
  const gateStep = wf.slice(wf.indexOf('Deterministic auto-merge gate'), wf.indexOf('\n  autofix:'));
  // Without the label check a stuck PR collects one comment per CI run forever,
  // which is how a notification channel gets muted.
  assert.match(gateStep, /--json state,author,comments,labels/, 'labels must ride along on the existing query');
  assert.match(gateStep, /grep -qxF 'needs-human-review' <<<"\$PR_LABELS"/);
});

test('a correct refusal notifies without reddening the job; a malfunction reddens', () => {
  const wf = readFileSync(join(rendered, '.github/workflows/dependabot-review.yml'), 'utf8');
  const gateStep = wf.slice(wf.indexOf('Deterministic auto-merge gate'), wf.indexOf('\n  autofix:'));
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
  const wf = readFileSync(join(rendered, '.github/workflows/dependabot-review.yml'), 'utf8');
  const caseArm = /case "\$CODE" in\s*\n\s*([a-z_|]+)\)/.exec(wf)?.[1] ?? '';
  assert.ok(!caseArm.split('|').includes('ci_failed'), 'with autofix on, autofix owns ci_failed');
  // ...and autofix must then actually escalate when it declines, deterministically.
  const autofixJob = wf.slice(wf.indexOf('\n  autofix:'));
  assert.match(autofixJob, /The fixer made no edits/);
  assert.match(autofixJob, /--add-label needs-human-review --add-assignee octocat/);
  assert.match(autofixJob, /::warning::CI is failing on PR #\$PR_NUMBER and autofix could not fix it/);
});

test('--no-autofix moves ci_failed ONTO the gate\'s list — nothing else is watching CI', () => {
  const out = renderWith(['--no-autofix']);
  const wf = readFileSync(join(out, '.github/workflows/dependabot-review.yml'), 'utf8');
  const caseArm = /case "\$CODE" in\s*\n\s*([a-z_|]+)\)/.exec(wf)?.[1] ?? '';
  assert.ok(caseArm.split('|').includes('ci_failed'),
    'with autofix off no job watches CI, so a red build would strand silently');
  assert.doesNotMatch(wf, /^ {2}autofix:/m);
});

test('both prompt-loads bake in the literal PR number, never cat the raw prompt', () => {
  const wf = readFileSync(join(rendered, '.github/workflows/dependabot-review.yml'), 'utf8');
  // Claude Code 2.1.207+ (bundled by recent claude-code-action releases) rejects an
  // allowlisted Bash command that contains a shell expansion ("Contains expansion").
  // So `gh pr diff $PR_NUMBER` must be substituted to `gh pr diff <n>` before the agent
  // sees it, or every gh call is denied and the review times out with no verdict. Both
  // the review and autofix prompt-loads substitute; neither cats the raw prompt.
  // The review load also bakes the PR author (hard rule 3 compares against it now
  // that the agent holds no `gh pr view`), on a `|` delimiter — the value is
  // `app/dependabot` on every routine run, and a `/` would end the s command.
  assert.ok(wf.includes('sed -e "s/\\$PR_NUMBER/$PR_NUMBER/g" -e "s|\\$PR_AUTHOR|$PR_AUTHOR|g" .github/dependabot-review-prompt.md'),
    'review prompt-load must substitute the literal PR number and the author');
  assert.ok(wf.includes('sed "s/\\$PR_NUMBER/$PR_NUMBER/g" .github/dependabot-autofix-prompt.md'),
    'autofix prompt-load must substitute the literal PR number');
  assert.doesNotMatch(wf, /cat \.github\/dependabot-(review|autofix)-prompt\.md/,
    'no prompt-load may cat the raw prompt — that leaves $PR_NUMBER unexpanded → denied');
});
