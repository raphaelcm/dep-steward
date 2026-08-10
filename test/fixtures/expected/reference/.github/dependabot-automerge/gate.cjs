#!/usr/bin/env node
'use strict';

/*
 * Deterministic auto-merge gate for the Dependabot-review workflow. The gate
 * decides whether a Dependabot PR may auto-merge after running deterministic
 * checks. There are two paths through it:
 *
 *   1. **Group PRs** (branch prefix matches an entry in
 *      `ELIGIBLE_GROUP_PREFIXES`): `.github/dependabot.yml` guarantees the
 *      group contains only minor + patch bumps. No LLM input needed; the
 *      gate just verifies CI, author, PR state, and the path whitelist.
 *
 *   2. **Singleton / major PRs**: the LLM review job posts a fenced
 *      `<!-- AUTOMERGE-DECISION-V1 -->{...}<!-- /AUTOMERGE-DECISION-V1 -->`
 *      block in its PR comment. The gate parses the latest such block from a
 *      trusted commenter (github-actions) and merges only when the LLM
 *      recommendation is `merge` AND `our_usage_affected === false` AND the
 *      deterministic checks ALSO pass. The whitelist + CI checks are
 *      load-bearing: even a maximally-injection-compromised LLM cannot cause
 *      a merge that touches `src/` or that breaks tests, because those gates
 *      are applied independently of anything the LLM says.
 *
 * Inputs (env):
 *   - HEAD_BRANCH, CI_CONCLUSION, PR_AUTHOR, PR_STATE, CHANGED_PATHS
 *     (CHANGED_PATHS is newline-separated)
 *   - PR_COMMENTS_JSON (singleton path only): JSON array as produced by
 *     `gh pr view <n> --json comments --jq '.comments'`; empty / missing on
 *     group-PR runs.
 *   - ALLOWED_MERGE_METHODS: comma-separated subset of `merge,squash,rebase`
 *     that this repo appears to permit, resolved by the workflow from the two
 *     layers it can read (repo settings and the default branch's rules). A
 *     PRIOR, not an oracle — see the merge-methods section below.
 *
 * Output (stdout): `decision=merge|skip`, `reason=<text>`, `code=<stable-id>`,
 * and `methods=` (the RANKED candidate merge methods, best first, emitted on
 * every call so the caller never computes them). Exit is always 0 — the
 * decision is the contract, not the exit code (keeps `set -e` callers simple).
 *
 * `reason` is prose for a human reading the log; `code` is the stable
 * identifier the workflow branches on. They are separate because the caller
 * needs to distinguish "not yet" from "never" — a refusal that will resolve
 * itself must stay silent, and one that never will has to reach a person — and
 * re-parsing prose to decide that is how a notifier goes wrong.
 */

// One prefix per configured ecosystem: `dependabot/<branch-slug>/<group-name>-`.
// The installer renders these from the ecosystems it detected — the branch slug
// is Dependabot's own (npm→npm_and_yarn, gomod→go_modules, …), not the config
// value.
const ELIGIBLE_GROUP_PREFIXES = [
  'dependabot/npm_and_yarn/npm-minor-patch-',
  'dependabot/pip/pip-minor-patch-',
  'dependabot/cargo/cargo-minor-patch-',
  'dependabot/go_modules/gomod-minor-patch-',
  'dependabot/docker/docker-minor-patch-',
  'dependabot/github_actions/actions-minor-patch-',
];

// Two strings, one identity. The Dependabot GitHub App's login is normalized
// differently across GitHub surfaces: `github.event.pull_request.user.login`
// in workflow `on: pull_request` payloads returns `dependabot[bot]`, while
// `gh pr list --json author --jq '.[0].author.login'` (which the workflow
// uses to populate PR_AUTHOR) returns `app/dependabot`. The gate accepts
// either since both reference the same Dependabot App.
const DEPENDABOT_AUTHORS = new Set(['app/dependabot', 'dependabot[bot]']);

// Trusted commenters whose AUTOMERGE-DECISION-V1 blocks the gate will honor.
// Multiple normalizations of two underlying identities are accepted:
//
//   - github-actions: when the review job posts comments via `gh pr comment`
//     using the workflow's GITHUB_TOKEN. (Both `app/github-actions` from
//     gh-CLI JSON and `github-actions[bot]` from event payloads.)
//   - claude / claude[bot]: when the anthropics/claude-code-action posts
//     the LLM's comment via its own GitHub App identity. (`claude` from
//     gh-CLI JSON and `claude[bot]` from event payloads.) This is the
//     identity that posts in practice — the action does not use
//     GITHUB_TOKEN for comments.
//
// An external commenter (any human, any untrusted bot) including a V1 block
// has it ignored — this prevents "post a fake decision block to force a
// merge" attacks.
const TRUSTED_DECISION_AUTHORS = new Set([
  'app/github-actions',
  'github-actions[bot]',
  'claude',
  'claude[bot]',
]);

const V1_OPEN = '<!-- AUTOMERGE-DECISION-V1 -->';
const V1_CLOSE = '<!-- /AUTOMERGE-DECISION-V1 -->';

// The dependency surface a routine bump may touch, rendered from the detected
// ecosystems: exact manifest/lock filenames plus regexes for the variable ones
// (requirements*.txt, *.csproj, the GitHub Actions surface, …). A PR that
// changes anything NOT matched here is rejected regardless of the LLM.
const WHITELIST_EXACT = new Set([
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'requirements.txt',
  'requirements.in',
  'Pipfile',
  'Pipfile.lock',
  'pyproject.toml',
  'poetry.lock',
  'setup.py',
  'setup.cfg',
  'pdm.lock',
  'Cargo.toml',
  'Cargo.lock',
  'go.mod',
  'go.sum',
  'go.work',
  'go.work.sum',
  'Dockerfile',
  'Containerfile',
]);
const WHITELIST_REGEX = [
  /^requirements.*\.txt$/,
  /^Dockerfile\..+$/,
  /^[^/]+\.dockerfile$/,
  /^\.github\/workflows\/[^/]+\.ya?ml$/,
  /^\.github\/actions\//,
  /(^|\/)action\.ya?ml$/,
];

function isWhitelistedPath(p) {
  if (WHITELIST_EXACT.has(p)) return true;
  for (const re of WHITELIST_REGEX) {
    if (re.test(p)) return true;
  }
  return false;
}

// ---- merge methods --------------------------------------------------------
// A RANKED LIST, not a single choice. The ranking is a deterministic function
// of (changed paths, what this repo appears to allow), so it lives here with
// the rest of the deterministic logic rather than in the workflow's bash, where
// it could only be tested by grepping YAML. The workflow tries the list in
// order and stops at the first method GitHub accepts.
//
// The list has to reach the workflow intact, because NO PRE-FLIGHT QUERY CAN
// PREDICT THE ANSWER. Whether GitHub accepts a method has at least five
// independent inputs — repo settings, repo rulesets, org rulesets, classic
// branch protection, and the acting token's App scopes versus the PR's changed
// paths — and two of them are unreadable here by construction:
//
//   - classic branch protection (`branches/:branch/protection`, where
//     `required_linear_history` lives) requires ADMIN to read, and a workflow
//     `permissions:` block has no key that grants it.
//   - the App-workflow-scope refusal is not a repo setting at all, so no
//     endpoint reports it.
//
// So ALLOWED_MERGE_METHODS is a prior and a reporting surface, never an oracle.
// The only authority on "will GitHub accept method M" is asking GitHub to do M.
// Collapsing this list to its head is how a repo with a hidden restriction gets
// one refusal and a paged human instead of a merge (Runsense-ai/runsense#2333:
// both readable layers reported all three methods permitted, and GitHub refused
// the merge commit anyway).
//
// Ranking:
//
//   workflow-touching PRs -> merge, then rebase, then squash.
//     GITHUB_TOKEN can never hold the `workflows` permission, so an
//     App-authored NEW commit that edits a workflow file is refused. A merge
//     COMMIT authors no new commit — it preserves Dependabot's own — so it is
//     the safest bet when available. Rebase keeps Dependabot as the author and
//     is DEMONSTRATED to work for workflow-file PRs under GITHUB_TOKEN
//     (Runsense-ai/runsense#2007 landed one), so it is a real second choice,
//     not a forlorn hope — which matters on any repo enforcing linear history,
//     where merge commits are refused outright. A squash always produces an
//     App-authored commit, so it is last.
//
//   everything else -> squash, then rebase, then merge. Squash is the repo
//     default and the shape every other PR lands in.
const WORKFLOW_PATH_RE = /^\.github\/workflows\//;
const PREF_WORKFLOW = ['merge', 'rebase', 'squash'];
const PREF_DEFAULT = ['squash', 'rebase', 'merge'];
const KNOWN_METHODS = new Set(['merge', 'squash', 'rebase']);

// "We could not tell" and "nothing is allowed" are DIFFERENT answers and must
// not collapse into one, so the empty string is reserved for the first: absent
// or blank ALLOWED_MERGE_METHODS means the workflow's query failed. A repo that
// genuinely permits nothing sends a non-empty value naming no known method
// (the workflow sends `none`), which yields an empty list here.
// Returns null for "unknown", or an array (possibly empty) for a real answer.
function parseAllowedMethods(raw) {
  const text = (raw || '').trim();
  if (text === '') return null;
  return text
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => KNOWN_METHODS.has(s));
}

// Returns the ranked candidate methods, best first — possibly empty, which the
// caller renders as `none` and escalates on rather than passing an invalid flag
// to `gh`.
// On "unknown" the whole preference list survives: a failed query must not
// narrow the candidates, or an unreadable setting would cost us the fallbacks
// precisely when we are least sure of the first choice.
function mergeMethodsFor(changedPaths, allowedMethods) {
  const pref = changedPaths.some((p) => WORKFLOW_PATH_RE.test(p)) ? PREF_WORKFLOW : PREF_DEFAULT;
  if (allowedMethods === null) return [...pref];
  return pref.filter((m) => allowedMethods.includes(m));
}

function extractDecisionBlock(body) {
  if (typeof body !== 'string') return null;
  const openIdx = body.indexOf(V1_OPEN);
  if (openIdx === -1) return null;
  const closeIdx = body.indexOf(V1_CLOSE, openIdx + V1_OPEN.length);
  if (closeIdx === -1) return null;
  return body.substring(openIdx + V1_OPEN.length, closeIdx).trim();
}

function validateDecisionShape(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return false;
  if (d.recommendation !== 'merge' && d.recommendation !== 'escalate') return false;
  if (typeof d.our_usage_affected !== 'boolean') return false;
  return true;
}

// Returns { decision: <parsed-decision-object> } on success,
// { decision: null } when no trusted V1 block exists (legitimate "not yet"),
// or { error: <message> } when a V1 block exists but its content is malformed
// — surfaces the error rather than silently falling back to an older block,
// because the LLM may have posted a newer (intended-to-supersede) block.
function findLatestDecision(commentsJson) {
  const text = (commentsJson || '').trim();
  if (text === '') {
    return { decision: null };
  }
  let comments;
  try {
    comments = JSON.parse(text);
  } catch {
    return { error: 'PR_COMMENTS_JSON is not valid JSON' };
  }
  if (!Array.isArray(comments)) {
    return { error: 'PR_COMMENTS_JSON does not parse as a JSON array' };
  }
  const candidates = comments
    .filter((c) => c && c.author && typeof c.author.login === 'string')
    .filter((c) => TRUSTED_DECISION_AUTHORS.has(c.author.login))
    .filter((c) => typeof c.body === 'string' && c.body.includes(V1_OPEN))
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));

  if (candidates.length === 0) {
    return { decision: null };
  }
  const latest = candidates[0];
  const blockText = extractDecisionBlock(latest.body);
  if (!blockText) {
    return { error: 'AUTOMERGE-DECISION-V1 open marker found but no closing marker' };
  }
  let parsed;
  try {
    parsed = JSON.parse(blockText);
  } catch {
    return { error: 'AUTOMERGE-DECISION-V1 block contains malformed JSON' };
  }
  if (!validateDecisionShape(parsed)) {
    return {
      error: 'AUTOMERGE-DECISION-V1 block has invalid shape (missing/wrong-typed fields)',
    };
  }
  return { decision: parsed };
}

// CI conclusions, in three classes. The split exists because the caller must
// tell "not yet" from "never", and `gh run list` reports both plus a middle
// group that is neither.
//
//   PENDING       nothing has concluded yet. Always silent — the gate will be
//                 woken again when it does.
//   INDETERMINATE concluded, but not with a verdict about the code: a run
//                 someone cancelled, one that timed out, one awaiting manual
//                 approval. A new push re-runs CI and re-wakes the gate, so
//                 these resolve themselves more often than not. Deliberately
//                 NOT escalatable: a new code defaults to silence rather than
//                 noise, and a false ping teaches you to ignore the label.
//                 Documented as a known gap; revisit if one is seen stranding
//                 a PR in practice.
//   anything else is a real failure -> `ci_failed`.
const CI_PENDING = new Set(['', 'pending', 'queued', 'in_progress', 'waiting', 'requested']);
const CI_INDETERMINATE = new Set(['cancelled', 'timed_out', 'action_required', 'neutral', 'skipped', 'stale']);

function decide(env) {
  const headBranch = (env.HEAD_BRANCH || '').trim();
  const ciConclusion = (env.CI_CONCLUSION || '').trim();
  const prAuthor = (env.PR_AUTHOR || '').trim();
  const prState = (env.PR_STATE || '').trim().toUpperCase();
  const changedPaths = (env.CHANGED_PATHS || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  // Common preconditions — apply to every path, before any branch logic.
  // The first two and `no_changed_paths` are ANOMALIES, not stuck PRs: they
  // mean the gate is looking at something it has no business acting on. They
  // stay silent on purpose — paging a human about someone else's PR, or about
  // one already closed, is noise that trains you to ignore the label.
  if (!DEPENDABOT_AUTHORS.has(prAuthor)) {
    return { decision: 'skip', code: 'author_not_dependabot', reason: `author is "${prAuthor}", not dependabot` };
  }
  if (prState !== 'OPEN') {
    return { decision: 'skip', code: 'pr_not_open', reason: `PR state is ${prState || '(empty)'}, not OPEN` };
  }
  if (ciConclusion !== 'success') {
    const ciCode = CI_PENDING.has(ciConclusion)
      ? 'ci_pending'
      : CI_INDETERMINATE.has(ciConclusion)
        ? 'ci_indeterminate'
        : 'ci_failed';
    return {
      decision: 'skip',
      code: ciCode,
      reason: `CI conclusion is ${ciConclusion || '(empty)'}, not success`,
    };
  }
  if (changedPaths.length === 0) {
    return { decision: 'skip', code: 'no_changed_paths', reason: 'no changed paths reported (anomalous PR)' };
  }
  // Whitelist is the load-bearing injection-safety gate: it rejects any PR
  // that changes a file outside the dependency/workflow surface, regardless
  // of what the LLM says about it. This applies to both group and singleton
  // paths so that an injection-compromised LLM cannot smuggle source changes.
  const offending = changedPaths.filter((p) => !isWhitelistedPath(p));
  if (offending.length > 0) {
    // Terminal on sight: the paths cannot change without a new push, and if one
    // came the gate would be re-run anyway. Nothing else sees this — the review
    // job's deliverable-assertion SKIPS group PRs by design, and autofix needs a
    // CI failure, so a group PR with green CI touching a source file falls
    // between all three notifiers.
    return {
      decision: 'skip',
      code: 'paths_not_whitelisted',
      reason: `changed path(s) outside whitelist: ${offending.join(', ')}`,
    };
  }

  // Branch on group vs singleton.
  const matchedPrefix = ELIGIBLE_GROUP_PREFIXES.find((pfx) => headBranch.startsWith(pfx));
  if (matchedPrefix) {
    return {
      decision: 'merge',
      code: 'ok_group',
      reason: `minor/patch group "${matchedPrefix}", CI success, ${changedPaths.length} whitelisted path(s)`,
    };
  }

  // Singleton / major path: require a valid V1 decision from a trusted commenter.
  const decisionResult = findLatestDecision(env.PR_COMMENTS_JSON);
  if (decisionResult.error) {
    // Terminal, and NOTHING else catches it. The review job's assertion greps
    // only for the OPENING marker, so a comment carrying the marker with
    // truncated or malformed JSON inside passes that check green — review
    // SUCCESS, no label, no assignee — while the gate refuses that same comment
    // on every wake, forever. The PR looks reviewed and never merges.
    return {
      decision: 'skip',
      code: 'verdict_malformed',
      reason: `singleton/major: ${decisionResult.error}`,
    };
  }
  if (!decisionResult.decision) {
    // NOT terminal on sight: the review may still be running. When it truly
    // never posts, the review job's deliverable-assertion labels, assigns, and
    // goes red — so this one already has an owner and must not double-notify.
    return {
      decision: 'skip',
      code: 'verdict_missing',
      reason:
        'singleton/major: no AUTOMERGE-DECISION-V1 block found in trusted commenter comments (LLM review may still be running, or no recommendation was posted)',
    };
  }
  const llmDecision = decisionResult.decision;
  if (llmDecision.recommendation !== 'merge') {
    // The reviewer decided a human is needed and labels the PR itself.
    return {
      decision: 'skip',
      code: 'verdict_escalate',
      reason: `singleton/major: LLM recommendation is "${llmDecision.recommendation}", not "merge"`,
    };
  }
  if (llmDecision.our_usage_affected !== false) {
    return {
      decision: 'skip',
      code: 'usage_affected',
      reason: 'singleton/major: LLM reports our_usage_affected=true (escalate for human review)',
    };
  }
  return {
    decision: 'merge',
    code: 'ok_singleton',
    reason: `singleton/major "${headBranch}", LLM merge recommendation + our_usage_affected=false, CI success, ${changedPaths.length} whitelisted path(s)`,
  };
}

// Classification mode, used by the review workflow's deliverable-assertion —
// NOT the merge path. It answers only "is this branch a minor/patch group?"
// from the same ELIGIBLE_GROUP_PREFIXES the merge path uses, so the two can
// never disagree about which PRs the gate merges without a review verdict. It
// is a pure branch-name match with no privilege — it authorizes nothing — so
// running it from a PR checkout (as the review job does) is safe.
if ((process.env.GATE_MODE || '') === 'classify') {
  const headBranch = (process.env.HEAD_BRANCH || '').trim();
  const isGroup = ELIGIBLE_GROUP_PREFIXES.some((pfx) => headBranch.startsWith(pfx));
  process.stdout.write(`group=${isGroup}\n`);
  process.exit(0);
}

const { decision, reason, code } = decide(process.env);
// `methods=` is emitted on EVERY call, including `decision=skip`, so the caller
// never has to compute it and the two can never disagree.
const methods = mergeMethodsFor(
  (process.env.CHANGED_PATHS || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean),
  parseAllowedMethods(process.env.ALLOWED_MERGE_METHODS),
);
// An empty list is a real answer ("this repo permits nothing"), but an empty
// VALUE would be indistinguishable from a missing line to the caller's `sed`,
// so it goes out as the same `none` token the workflow uses on the way in.
// `code=` follows `reason=` so the existing `sed -n 's/^decision=//p'` parsing
// and gate.test.mjs's /^decision=(\w+)$/m both stay valid.
process.stdout.write(
  `decision=${decision}\nreason=${reason}\ncode=${code}\nmethods=${methods.join(',') || 'none'}\n`,
);
process.exit(0);
