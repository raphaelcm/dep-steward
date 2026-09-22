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
 * The rule reads the REVIEWER'S OWN VOICE only. Blockquotes, fenced blocks
 * and the decision block's `description` strings are upstream's words —
 * `breaking_changes_enumerated` is contractually verbatim — and a guard that
 * made the agent paraphrase them would corrupt the audit trail it protects.
 * Every tier also demands an inability to PERCEIVE (read, see, verify,
 * access, …), never a bare "cannot": "the CI-only reporter change cannot
 * reach our usage" is exactly the sentence the prompt asks for.
 *
 *   A  any mention of CI + a perception failure + the reviewer as the one
 *      who failed ("I", "this token", "from here"). Both production leaks.
 *   B  the PR's CI or check STATUS + a perception failure, whoever the
 *      subject is. The pre-v0.8 template line "CI status: could not read".
 *   C  a state claimed for this PR's CI ("CI is green on this head"). The
 *      reviewer cannot know it; a public repo's checks page is reachable
 *      through WebFetch and reads "pending" mid-review.
 *
 * Deliberately NOT flagged, each seen in real release notes for the
 * dependencies whose changelogs are about CI: "the build was failing on
 * Windows", "tests were failing in CI on Node 22", "cannot check out private
 * submodules", "could not detect CI on Buildkite", "cannot access the Actions
 * API without actions: read", "unable to read test results when the path has
 * spaces". A false positive here is not free: the post is blocked and the
 * agent must rewrite, and one that cannot find a passing phrasing burns its
 * turn budget and delivers no verdict at all.
 */

const fs = require('fs');
const path = require('path');

const V1_OPEN = '<!-- AUTOMERGE-DECISION-V1 -->';
const V1_CLOSE = '<!-- /AUTOMERGE-DECISION-V1 -->';
const PRESCRIBED_POST = 'gh pr comment <n> --body-file .dep-steward-review.md';

// ---- the rule -------------------------------------------------------------

// Any mention of CI (tier A only — it needs the reviewer as the subject too).
// `CI` is case-sensitive and on its own, so `ci.yml`, `--ci` and `CircleCI`
// in changelog text stay out.
const CI_ANY = new RegExp(
  [
    '\\bCI\\b',
    '\\bstatus[- ]checks?\\b',
    '\\bchecks?[- ](?:status|results?|runs?|suites?)\\b',
    '\\b(?:build|pipeline|workflow) (?:status|results?|outcome|conclusion)\\b',
    '\\bworkflow[- ]runs?\\b',
    '\\btest (?:results?|status|outcome)\\b',
    '\\b(?:checks|actions) API\\b',
    'statusCheckRollup',
    '\\bgh (?:pr checks|run (?:view|list))\\b',
    // A state phrase names CI without the noun ("whether the build is green").
    // Safe here only because tier A also demands the reviewer as the subject.
    '\\b(?:build|builds|tests|test suite|suite|checks)\\s+(?:is|are|was|were)\\s+(?:green|red|passing|failing)\\b',
  ].join('|'),
  'i',
);
function mentionsCI(clause) {
  return /\bCI\b/.test(clause) || CI_ANY.test(clause.replace(/\bCI\b/g, ''));
}

// The PR's CI or check STATUS, specifically (tier B). Narrower than CI_ANY on
// purpose: "workflow runs", "check runs", "test results" and "the Actions
// API" are ordinary nouns in the release notes of the Actions ecosystem, and
// tier B has no reviewer-as-subject requirement to keep them honest.
const CI_STATUS = new RegExp(
  [
    '\\bCI (?:status|results?|outcome|conclusion|state|checks?)\\b',
    '\\bstatus[- ]checks?\\b',
    '\\bcheck[- ](?:status|results?)\\b',
    '\\b(?:build|pipeline) (?:status|results?|outcome|conclusion)\\b',
    'statusCheckRollup',
    '\\bgh (?:pr checks|run (?:view|list))\\b',
    '\\b(?:confirm|verif)\\w*\\b[^.;!?\\n]{0,40}\\b(?:green|red|passing|failing)\\b',
  ].join('|'),
);
// CI itself as the thing that could not be perceived: "could not read CI",
// "CI was not readable". Bare CI is only status-shaped when it is the object.
const CI_AS_OBJECT =
  /\b(?:could(?:n'?t| not)|cannot|can'?t|unable to|not able to|failed to|no way to)\s+(?:read|see|view|access|inspect|fetch|query|retrieve|confirm|verify)\s+(?:the\s+)?(?:PR'?s\s+)?CI\b|\bCI\b\s+(?:(?:was|is|were|are)\s+)?(?:not\s+(?:readable|visible|accessible|verifiable)|unreadable|inaccessible)\b/;
function statusSignal(clause) {
  return CI_STATUS.test(clause) || CI_AS_OBJECT.test(clause);
}

// A failure to PERCEIVE. `check` excludes `check out` (actions/checkout's
// release notes are full of it). Tier A also accepts determine / tell / know,
// which are safe only with the reviewer as the subject ("could not determine
// CI vendor" is ci-info's changelog, not a confession).
const CANT = "(?:could(?:n'?t| not)|cannot|can'?t|unable to|not able to|was(?:n'?t| not) able to|failed to|no way to)";
const PERCEIVE = '(?:read|see|view|confirm|verify|check(?!\\s+out)|access|inspect|fetch|query|retrieve|observe)';
const BLIND_B = new RegExp(
  [
    `\\b${CANT}\\s+(?:be\\s+)?${PERCEIVE}\\b`,
    `\\b${CANT}\\s+be\\s+(?:read|seen|viewed|confirmed|verified|checked|accessed|inspected|fetched|queried|retrieved|observed)\\b`,
    "(?:\\bnot|n't|\\bun)[ -]?(?:readable|verifiable|confirmable|visible|accessible)\\b",
    '\\binaccessible\\b',
    "\\b(?:no|(?:do|does)(?: not|n't) have) (?:access|visibility|permission)\\b",
    '\\b403\\b',
    '\\b(?:denied|forbidden)\\b',
  ].join('|'),
  'i',
);
const BLIND_A = new RegExp(
  [BLIND_B.source, `\\b${CANT}\\s+(?:determine|tell|know)\\b`, '\\bblind(?:ly|ness)?\\b'].join('|'),
  'i',
);

// The reviewer as the one who failed to perceive. NOT "we" / "our": in a
// review those mean this repository ("we only call the pulls API", "our
// usage"), which the prompt asks the reviewer to talk about.
const SELF =
  /\b(?:I|I've|I'm|I'd|I'll)\b|\bme\b|\b(?:this|my) token\b|\bfrom (?:here|this (?:run|job|environment|context|sandbox|session))\b|\bin this (?:run|job|environment|context|sandbox|session)\b|\bmy (?:access|permissions?|tools?)\b/;

// A state claimed for THIS PR's CI (tier C). The scope marker is what keeps
// release notes out: "tests were failing in CI on Node 22" is history about
// the dependency, "CI is green on this head" is a claim about the PR.
const STATE_SUBJECT = /\bCI\b|\bstatus checks?\b|\bcheck runs?\b|\bchecks\b/;
const STATE_CLAIM =
  /\b(?:is|are|was|were|remains?|looks?|still)\s+(?:all\s+)?(?:green|red|passing|failing|passed|failed|successful|pending|queued|running|in progress)\b/i;
const PR_SCOPE =
  /\bthis (?:PR|pull request|head|branch|commit|bump|change)\b|\bthe PR'?s?\b|\bon (?:this|the) (?:PR|head|branch)\b|\b(?:right now|currently|at the moment|so far|as of now)\b/i;

function tierA(clause) {
  return mentionsCI(clause) && BLIND_A.test(clause) && SELF.test(clause);
}
function tierB(clause) {
  return statusSignal(clause) && BLIND_B.test(clause);
}
function tierC(clause) {
  return STATE_SUBJECT.test(clause) && STATE_CLAIM.test(clause) && (PR_SCOPE.test(clause) || SELF.test(clause));
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

// The reviewer's own prose: everything except blockquotes, fenced blocks,
// and the decision block's `description` strings. Inside the decision block,
// `reason` IS the reviewer's prose; when the block's JSON does not parse, the
// whole block is.
function ownVoice(body) {
  let text = String(body || '');
  const prose = [];
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
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (typeof parsed.reason === 'string') prose.push(parsed.reason);
    } else {
      prose.push(inner);
    }
    text = text.slice(0, openIdx) + '\n' + text.slice(end);
    openIdx = text.indexOf(V1_OPEN);
  }
  text = text.replace(/```[\s\S]*?(?:```|$)/g, '\n');
  for (const line of text.split('\n')) {
    if (!/^\s*>/.test(line)) prose.push(line);
  }
  return prose;
}

// Returns null when the body is clean, else { tier, clause }.
function lint(body) {
  for (const fragment of ownVoice(body)) {
    for (const clause of clauses(fragment)) {
      if (tierA(clause)) return { tier: 'A', clause };
      if (tierB(clause)) return { tier: 'B', clause };
      if (tierC(clause)) return { tier: 'C', clause };
    }
  }
  return null;
}

const TIER_TEXT = {
  A: "reports the reviewer's own inability to read the PR's CI or check status",
  B: "reports an inability to read the PR's CI or check status",
  C: "claims a state for this PR's CI or checks",
};

function explain(finding) {
  return `this clause ${TIER_TEXT[finding.tier]}: \u00ab${finding.clause}\u00bb`;
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

// The command as the shell would split it: one argv per simple command, with
// quotes honoured. A regex over the raw string gets both directions wrong — a
// `-F` belonging to an earlier `grep` in the same line is taken for the body
// file (and the real post goes through unlinted), and a ` -e ` inside a
// quoted body is taken for `--editor`. Expansions are left literal: an
// allow-listed command containing one is denied before it runs anyway.
function simpleCommands(command) {
  const out = [];
  let argv = [];
  let cur = '';
  let inToken = false;
  let quote = null;
  const s = String(command || '');
  const endToken = () => {
    if (inToken) argv.push(cur);
    cur = '';
    inToken = false;
  };
  const endCommand = () => {
    endToken();
    if (argv.length) out.push(argv);
    argv = [];
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      else cur += c;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === '\\' && i + 1 < s.length && '"\\$`\n'.includes(s[i + 1])) cur += s[++i];
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      inToken = true;
    } else if (c === '\\' && i + 1 < s.length) {
      cur += s[++i];
      inToken = true;
    } else if (';&|\n()`'.includes(c)) {
      endCommand();
    } else if (/\s/.test(c)) {
      endToken();
    } else {
      cur += c;
      inToken = true;
    }
  }
  endCommand();
  return out;
}

// Every `gh pr comment` in the command, with where its body comes from:
// { file } | { text } | { unlintable: <why> }. `--delete-last` posts
// nothing, so it is not a post.
function findPosts(command) {
  const posts = [];
  for (const argv of simpleCommands(command)) {
    let i = 0;
    while (i < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i])) i++;
    if (argv[i] !== 'gh' || argv[i + 1] !== 'pr' || argv[i + 2] !== 'comment') continue;
    const args = argv.slice(i + 3);
    let body = null;
    let unlintable = null;
    let deletes = false;
    for (let j = 0; j < args.length; j++) {
      const a = args[j];
      if (a === '--body-file' || a === '-F') body = { file: args[++j] };
      else if (a.startsWith('--body-file=')) body = { file: a.slice('--body-file='.length) };
      else if (/^-F./.test(a)) body = { file: a.slice(2).replace(/^=/, '') };
      else if (a === '--body' || a === '-b') body = { text: args[++j] ?? '' };
      else if (a.startsWith('--body=')) body = { text: a.slice('--body='.length) };
      else if (/^-b./.test(a)) body = { text: a.slice(2).replace(/^=/, '') };
      else if (a === '--editor' || a === '-e' || a === '--web' || a === '-w') unlintable = 'the comment body would come from an editor or a browser';
      else if (a === '--delete-last') deletes = true;
    }
    if (deletes && !body) continue;
    if (unlintable) posts.push({ unlintable });
    else if (!body || (body.file === undefined && body.text === undefined)) posts.push({ unlintable: 'the command names no comment body' });
    else if (body.file === '-') posts.push({ unlintable: 'the comment body would come from stdin' });
    else posts.push(body);
  }
  return posts;
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
  for (const post of findPosts(input.tool_input && input.tool_input.command)) {
    if (post.unlintable) {
      return refuse(`${post.unlintable}, so it cannot be read before it is posted. Write the body to .dep-steward-review.md and post it with: ${PRESCRIBED_POST}`);
    }
    let body;
    if (post.file !== undefined) {
      const base = (typeof input.cwd === 'string' && input.cwd) || process.env.CLAUDE_PROJECT_DIR || process.cwd();
      try {
        body = fs.readFileSync(path.resolve(base, post.file), 'utf8');
      } catch {
        continue; // gh reports a missing file itself
      }
    } else {
      body = post.text;
    }
    const finding = lint(body);
    if (finding) return refuse(explain(finding));
  }
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
