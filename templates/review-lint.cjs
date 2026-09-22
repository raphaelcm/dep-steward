#!/usr/bin/env node
'use strict';

/*
 * review-lint.cjs — deterministic backstop for the review agent's evidence
 * contract.
 *
 * The reviewer judges the BUMP: the upstream changelog against our usage. Its
 * complete evidence is the PR diff, the changelog, and this repository's
 * source. It runs concurrently with CI, on a token that cannot read the
 * Checks/Actions APIs, so any sentence in its comment about the PR's CI or
 * check status — readable or not — is a sentence about evidence it never had.
 * Seen live (Runsense-ai/runsense#2762): "I could not read CI status from this
 * token to confirm green" reached the PR, in the Assessment line AND in the
 * decision block's `reason`, and inflated operator triage. The root cause (the
 * prompt listed CI as a merge condition) is fixed in the prompt; this file is
 * the guard that does not depend on the model.
 *
 * Two modes, ONE rule (`lint`), so they can never disagree:
 *
 *   hook  (default) — a Claude Code PreToolUse hook on the Bash tool; the hook
 *         JSON arrives on stdin. When the command is `gh pr comment`, the body
 *         (`--body-file <path>` read from disk, or the inline `--body` text) is
 *         linted BEFORE the post happens. A finding exits 2 with the reason on
 *         stderr, which blocks the call and hands the reason to the model; it
 *         rewrites and posts again. Every other command exits 0 untouched: this
 *         hook fires on EVERY Bash call, and one that blocked `gh pr diff`
 *         would void the review invisibly (the diagnose step's denied-diff
 *         detector reads the SDK's permission record, which a hook block never
 *         touches). An internal error also exits 0 — fail OPEN — and the
 *         workflow's post-hoc check below is the backstop for that. A comment
 *         form this file cannot read (`--body-file -`, `--editor`, `--web`, no
 *         body at all) fails CLOSED, naming the prescribed form, so that every
 *         body that gets posted is one this file has linted.
 *
 *   body  (REVIEW_LINT_MODE=body, body in REVIEW_BODY) — run by the review
 *         job's deliverable assertion AFTER the post, over the comment as
 *         GitHub stored it. Prints `decision=post|refuse` then `reason=<text>`;
 *         exit is always 0 — the decision is the contract, not the exit code
 *         (as in gate.cjs and autofix-bounds.cjs). A refusal there has one
 *         meaning: the hook did not fire, because a body that survived the
 *         hook passes this identical rule.
 *
 * The rule is tiered so that verbatim upstream text never forces a rewrite.
 * Fenced code, blockquote lines, and the decision block's `description`
 * strings are QUOTE contexts: the prose-only tiers skip them.
 *
 *   A (any context)  a CI signal + an inability + a self-marker ("I", "we",
 *                    "this token", "from here"). Both production leaks.
 *   B (prose only)   a CI signal + a narrow inability to READ it ("could not
 *                    read", "not readable", "403", "denied"). The pre-v0.8
 *                    template line "CI status: could not read".
 *   C (prose only)   a CI signal + a state claim ("is green", "still
 *                    pending"). The reviewer cannot know the state; a public
 *                    repo's checks page is reachable through WebFetch and
 *                    reads "pending" mid-review.
 *
 * Deliberately NOT flagged: changelog text that merely mentions CI ("watch
 * mode is disabled in CI", "Cannot use --watch in CI"), and inability that is
 * not about CI ("could not find release notes for 4.2").
 */

const fs = require('fs');
const path = require('path');

const V1_OPEN = '<!-- AUTOMERGE-DECISION-V1 -->';
const V1_CLOSE = '<!-- /AUTOMERGE-DECISION-V1 -->';
const PRESCRIBED_POST = 'gh pr comment <n> --body-file .dep-steward-review.md';

// ---- the rule -------------------------------------------------------------

// Talking about the PR's CI / check status. `CI` is matched case-sensitively
// and on its own, so `ci.yml`, `--ci` and `CircleCI` in changelog text stay out.
const CI_WORD = /\bCI\b/;
const CI_PHRASE = new RegExp(
  [
    '\\bstatus[- ]checks?\\b',
    '\\bcheck[- ](?:status|results?|runs?|suites?)\\b',
    '\\b(?:build|pipeline) (?:status|results?|outcome)\\b',
    '\\bworkflow[- ]runs?\\b',
    '\\btest (?:results?|status|outcome)\\b',
    '\\b(?:checks|actions) api\\b',
    'statusCheckRollup',
    '\\bgh (?:pr checks|run (?:view|list))\\b',
    '\\b(?:confirm|verif|check)\\w*[^.;!?\\n]{0,40}\\b(?:green|red|passing|failing)\\b',
  ].join('|'),
  'i',
);
function hasSignal(clause) {
  return CI_WORD.test(clause) || CI_PHRASE.test(clause);
}

// Tier A: any inability, attributed to the reviewer itself or its token.
const INABILITY_BROAD =
  /\b(?:could(?:n'?t| not)|cannot|can'?t|unable|not able|no (?:access|way|permission|visibility)|not (?:readable|visible|available|accessible|permitted|possible)|unreadable|inaccessible|403|forbidden|denied|blind(?:ly|ness)?)\b/i;
const SELF_I = /\b(?:I|I've|I'm|I'd|I'll)\b/; // case-sensitive: "(i)" in a list is not a confession
const SELF_OTHER =
  /\b(?:we|we've|we're|me|my|us|our)\b|\b(?:this|the|my|current|available|app) token\b|\bfrom (?:here|this (?:run|job|environment|context|sandbox))\b|\bavailable to (?:me|us)\b|\b(?:no|without) (?:access|permission|scope|visibility)\b/i;
function tierA(clause) {
  return hasSignal(clause) && INABILITY_BROAD.test(clause) && (SELF_I.test(clause) || SELF_OTHER.test(clause));
}

// Tier B: a narrow inability to READ the signal. `not available/accessible/
// visible` are left out on purpose — "watch mode is not available in CI" is
// real changelog prose.
const INABILITY_NARROW =
  /\b(?:could not|couldn'?t|cannot|can'?t|unable to|not able to|failed to|no way to)\s+(?:be\s+)?(?:read|see|view|confirm|verify|verified|check|checked|access|observe|inspect|fetch|query|retrieve|determine|tell|reach)\b|\b(?:not|un)[ -]?(?:readable|verifiable|confirmable)\b|\b403\b|\b(?:denied|forbidden)\b/i;
function tierB(clause) {
  return hasSignal(clause) && INABILITY_NARROW.test(clause);
}

// Tier C: a claim about the state of the signal.
const STATE_SUBJECT = /\b(?:status checks?|check runs?|build|pipeline)\b/i;
const STATE_CLAIM =
  /\b(?:is|are|was|were|remains?|looks?|still)\s+(?:all\s+)?(?:green|red|passing|failing|passed|failed|successful|pending|queued|running|in progress)\b/i;
function tierC(clause) {
  return (CI_WORD.test(clause) || STATE_SUBJECT.test(clause)) && STATE_CLAIM.test(clause);
}

// A clause ends at sentence punctuation followed by whitespace or the end, or
// at a newline. Splitting on every `.` would cut `4.1.11` into three clauses
// and hide a signal from the inability two "clauses" away.
function clauses(text) {
  return String(text || '')
    .split(/[.;!?]+(?=\s|$)|\n+/)
    .map((c) => c.trim())
    .filter(Boolean);
}

// Separate the body into prose and quote contexts. Returns { prose, quoted }
// as arrays of text fragments.
function contexts(body) {
  let text = String(body || '');
  const prose = [];
  const quoted = [];

  // The decision block: when its JSON parses, `reason` is the reviewer's own
  // prose and every `description` is a verbatim quote from upstream. When it
  // does not parse, the whole block is the reviewer's text.
  let openIdx = text.indexOf(V1_OPEN);
  while (openIdx !== -1) {
    const closeIdx = text.indexOf(V1_CLOSE, openIdx + V1_OPEN.length);
    const end = closeIdx === -1 ? text.length : closeIdx + V1_CLOSE.length;
    const inner = text.slice(openIdx + V1_OPEN.length, closeIdx === -1 ? text.length : closeIdx);
    let parsed = null;
    try {
      parsed = JSON.parse(inner);
    } catch {
      parsed = null;
    }
    if (parsed && typeof parsed === 'object') {
      if (typeof parsed.reason === 'string') prose.push(parsed.reason);
      const list = Array.isArray(parsed.breaking_changes_enumerated) ? parsed.breaking_changes_enumerated : [];
      for (const item of list) {
        if (item && typeof item.description === 'string') quoted.push(item.description);
      }
    } else {
      prose.push(inner);
    }
    text = text.slice(0, openIdx) + '\n' + text.slice(end);
    openIdx = text.indexOf(V1_OPEN);
  }

  // Fenced code blocks are quotes (the prompt's own output template is fenced
  // in the prompt, and reviewers fence upstream snippets).
  text = text.replace(/```[\s\S]*?(?:```|$)/g, (block) => {
    quoted.push(block.replace(/^```[^\n]*\n?/, '').replace(/```$/, ''));
    return '\n';
  });

  // Blockquote lines are quotes.
  for (const line of text.split('\n')) {
    if (/^\s*>/.test(line)) quoted.push(line.replace(/^\s*>+\s?/, ''));
    else prose.push(line);
  }
  return { prose, quoted };
}

// Returns null when the body is clean, else { tier, clause }.
function lint(body) {
  const { prose, quoted } = contexts(body);
  for (const fragment of prose) {
    for (const clause of clauses(fragment)) {
      if (tierA(clause)) return { tier: 'A', clause };
      if (tierB(clause)) return { tier: 'B', clause };
      if (tierC(clause)) return { tier: 'C', clause };
    }
  }
  for (const fragment of quoted) {
    for (const clause of clauses(fragment)) {
      if (tierA(clause)) return { tier: 'A', clause };
    }
  }
  return null;
}

const TIER_TEXT = {
  A: "reports the reviewer's own inability to read the PR's CI or check status",
  B: "reports an inability to read the PR's CI or check status",
  C: "claims a state for the PR's CI or check status",
};

function explain(finding) {
  return `this clause ${TIER_TEXT[finding.tier]}: «${finding.clause}»`;
}

// ---- body mode ------------------------------------------------------------

function bodyMode(env) {
  const finding = lint(env.REVIEW_BODY || '');
  if (finding) {
    process.stdout.write(`decision=refuse\nreason=${explain(finding).replace(/\s+/g, ' ')}\n`);
  } else {
    process.stdout.write('decision=post\nreason=no clause reports on evidence outside the review\'s set (diff, changelog, this repository)\n');
  }
  process.exit(0);
}

// ---- hook mode ------------------------------------------------------------

// Does this command post a PR comment, and from which body source? Returns
// null for any other command, else { file } | { text } | { unlintable }.
const POST_RE = /(?:^|[\s;&|(`])gh\s+pr\s+comment\b/;
const BODY_FILE_RE = /(?:--body-file|-F)(?:=|\s+)(?:"([^"]*)"|'([^']*)'|(\S+))/;
const BODY_TEXT_RE = /(?:--body(?!-file)|-b)(?:=|\s+)(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+))/;
const UNLINTABLE_RE = /(?:^|\s)(?:--editor|--web|-e|-w)(?:\s|$)/;
function findPost(command) {
  const cmd = String(command || '');
  if (!POST_RE.test(cmd)) return null;
  if (UNLINTABLE_RE.test(cmd)) return { unlintable: 'the comment body would come from an editor or a browser' };
  const file = BODY_FILE_RE.exec(cmd);
  if (file) {
    const value = file[1] ?? file[2] ?? file[3];
    if (value === '-') return { unlintable: 'the comment body would come from stdin' };
    return { file: value };
  }
  const text = BODY_TEXT_RE.exec(cmd);
  if (text) return { text: text[1] ?? text[2] ?? text[3] };
  return { unlintable: 'the command names no comment body' };
}

function refuse(reason) {
  process.stderr.write(
    `dep-steward review-lint refused this comment: ${reason}\n` +
      "The review's complete evidence is the PR diff, the upstream changelog, and this repository's source, and the verdict answers one question: does a documented change reach our usage? " +
      'Remove that clause (or blockquote it if it is a quotation from upstream) — from the decision block\'s "reason" too — then rewrite .dep-steward-review.md and post it again with: ' +
      `${PRESCRIBED_POST}\n`,
  );
  process.exit(2);
}

function hookMode() {
  let input;
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return process.exit(0); // not a hook payload; never block on our own account
  }
  if (!input || input.tool_name !== 'Bash') return process.exit(0);
  const post = findPost(input.tool_input && input.tool_input.command);
  if (!post) return process.exit(0);
  if (post.unlintable) {
    return refuse(`${post.unlintable}, so it cannot be read before it is posted. Write the body to .dep-steward-review.md and post it with: ${PRESCRIBED_POST}`);
  }
  let body;
  if (post.file !== undefined) {
    const base = (typeof input.cwd === 'string' && input.cwd) || process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const file = path.resolve(base, post.file);
    try {
      body = fs.readFileSync(file, 'utf8');
    } catch {
      return process.exit(0); // gh reports a missing file itself
    }
  } else {
    body = post.text;
  }
  const finding = lint(body);
  if (finding) return refuse(explain(finding));
  return process.exit(0);
}

if ((process.env.REVIEW_LINT_MODE || '') === 'body') {
  bodyMode(process.env);
} else {
  try {
    hookMode();
  } catch (err) {
    process.stderr.write(`review-lint: internal error, not blocking: ${err && err.message}\n`);
    process.exit(0);
  }
}
