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
 *
 * Output (stdout): `decision=merge|skip` then `reason=<text>`. Exit is always
 * 0 — the decision is the contract, not the exit code (keeps `set -e`
 * callers simple).
 */

// One prefix per configured ecosystem: `dependabot/<branch-slug>/<group-name>-`.
// The installer renders these from the ecosystems it detected — the branch slug
// is Dependabot's own (npm→npm_and_yarn, gomod→go_modules, …), not the config
// value.
const ELIGIBLE_GROUP_PREFIXES = [
//__PREFIXES__
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
//__WL_EXACT__
]);
const WHITELIST_REGEX = [
//__WL_REGEX__
];

function isWhitelistedPath(p) {
  if (WHITELIST_EXACT.has(p)) return true;
  for (const re of WHITELIST_REGEX) {
    if (re.test(p)) return true;
  }
  return false;
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
  if (!DEPENDABOT_AUTHORS.has(prAuthor)) {
    return { decision: 'skip', reason: `author is "${prAuthor}", not dependabot` };
  }
  if (prState !== 'OPEN') {
    return { decision: 'skip', reason: `PR state is ${prState || '(empty)'}, not OPEN` };
  }
  if (ciConclusion !== 'success') {
    return { decision: 'skip', reason: `CI conclusion is ${ciConclusion || '(empty)'}, not success` };
  }
  if (changedPaths.length === 0) {
    return { decision: 'skip', reason: 'no changed paths reported (anomalous PR)' };
  }
  // Whitelist is the load-bearing injection-safety gate: it rejects any PR
  // that changes a file outside the dependency/workflow surface, regardless
  // of what the LLM says about it. This applies to both group and singleton
  // paths so that an injection-compromised LLM cannot smuggle source changes.
  const offending = changedPaths.filter((p) => !isWhitelistedPath(p));
  if (offending.length > 0) {
    return {
      decision: 'skip',
      reason: `changed path(s) outside whitelist: ${offending.join(', ')}`,
    };
  }

  // Branch on group vs singleton.
  const matchedPrefix = ELIGIBLE_GROUP_PREFIXES.find((pfx) => headBranch.startsWith(pfx));
  if (matchedPrefix) {
    return {
      decision: 'merge',
      reason: `minor/patch group "${matchedPrefix}", CI success, ${changedPaths.length} whitelisted path(s)`,
    };
  }

  // Singleton / major path: require a valid V1 decision from a trusted commenter.
  const decisionResult = findLatestDecision(env.PR_COMMENTS_JSON);
  if (decisionResult.error) {
    return {
      decision: 'skip',
      reason: `singleton/major: ${decisionResult.error}`,
    };
  }
  if (!decisionResult.decision) {
    return {
      decision: 'skip',
      reason:
        'singleton/major: no AUTOMERGE-DECISION-V1 block found in trusted commenter comments (LLM review may still be running, or no recommendation was posted)',
    };
  }
  const llmDecision = decisionResult.decision;
  if (llmDecision.recommendation !== 'merge') {
    return {
      decision: 'skip',
      reason: `singleton/major: LLM recommendation is "${llmDecision.recommendation}", not "merge"`,
    };
  }
  if (llmDecision.our_usage_affected !== false) {
    return {
      decision: 'skip',
      reason: 'singleton/major: LLM reports our_usage_affected=true (escalate for human review)',
    };
  }
  return {
    decision: 'merge',
    reason: `singleton/major "${headBranch}", LLM merge recommendation + our_usage_affected=false, CI success, ${changedPaths.length} whitelisted path(s)`,
  };
}

const { decision, reason } = decide(process.env);
process.stdout.write(`decision=${decision}\nreason=${reason}\n`);
process.exit(0);
