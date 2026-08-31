import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Which token the agent actually holds, and what that token can read.
 *
 * claude-code-action gives the agent's `gh` the workflow's GITHUB_TOKEN ONLY
 * when the step passes the `github_token` input. Without it, the action mints
 * its own Claude-App installation token via OIDC ("Using GITHUB_TOKEN from
 * OIDC" in its log) and the agent runs on THAT — a token that cannot read the
 * Checks or Actions APIs, whatever the job's `permissions:` block says.
 *
 * The failure this locks: the review prompt ordered `gh pr checks` and
 * `gh run view --log-failed`, both were allow-listed, and the jobs granted
 * `checks: read` + `actions: read` on the theory that job grants cure agent
 * 403s. They never reach an agent without the passthrough. The review agent
 * 403'd on every CI read for weeks — reporting "CI status: could not read"
 * and escalating over missing evidence — while every job stayed green
 * (observed on Runsense-ai/runsense#2335, runs 31356783516/31356783466).
 *
 * So the invariant is conditional on the passthrough:
 *   - an agent step WITHOUT `github_token` must not allow-list any command
 *     whose scopes the App token lacks (it would 403 on every call);
 *   - an agent step WITH `github_token` must have every allow-listed
 *     command's scope granted by the job's `permissions:` block (a job-level
 *     block makes every unlisted scope `none`).
 *
 * And the passthrough itself is a contract, not a preference:
 *   - the REVIEW step must never take it. Its comment must be posted by the
 *     Claude App identity, because a comment created with GITHUB_TOKEN fires
 *     no workflow triggers (GitHub's recursion guard) and the auto-merge
 *     job's issue_comment wake-up would silently die — any review finishing
 *     after CI would strand its PR until the next push.
 *   - the AUTOFIX step must take it. Reading the failing run log is that
 *     job's entire first step, and its comments carry no decision block, so
 *     nothing needs to wake on them.
 *
 * And the no-passthrough half is FLAG-granular, not verb-granular: an
 * allow-list entry is a prefix wildcard, so it is judged by the worst flag
 * it admits. `Bash(gh pr view:*)` needs only pull-requests:read at verb
 * level — a scope the App token has — but the same wildcard admits
 * `--json statusCheckRollup`, a Checks read, and the review agent burned
 * turns 403ing through it ("GraphQL: Resource not accessible by
 * integration", 12 permission denials in one run — observed on
 * Runsense-ai/runsense#2561, run 33357967765). Verb-level scoping is how
 * that entry survived the assertion below.
 *
 * Byte-parity (render.test.mjs) cannot catch any of this: it would have
 * locked the original bug in. Everything below runs over the RENDERED tree,
 * which is what an adopter ships.
 */

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const REFERENCE_MANIFESTS = ['package.json', 'package-lock.json', 'requirements.txt', 'Cargo.toml', 'go.mod', 'Dockerfile'];

function renderReference() {
  const fakeRepo = mkdtempSync(join(tmpdir(), 'ds-perm-repo-'));
  for (const m of REFERENCE_MANIFESTS) writeFileSync(join(fakeRepo, m), '\n');
  const out = mkdtempSync(join(tmpdir(), 'ds-perm-out-'));
  execFileSync(
    'sh',
    [join(REPO, 'install.sh'), '--render-only', '--out', out, '--ci-name', 'CI', '--assignee', 'octocat'],
    { cwd: fakeRepo, env: { ...process.env, DEP_STEWARD_SRC: REPO }, stdio: 'pipe' },
  );
  return out;
}

const rendered = renderReference();
const WORKFLOW = readFileSync(join(rendered, '.github/workflows/dependabot-review.yml'), 'utf8');

// ---- the scope lattice ----------------------------------------------------
// `contents: write` satisfies a `contents: read` requirement, which the autofix
// job relies on (it holds write and its prompt only needs read).
const LEVEL = { none: 0, read: 1, write: 2 };

// ---- what each allow-listed command needs ---------------------------------
// An UNMAPPED command throws rather than being skipped: a silently-ignored
// entry makes every assertion here vacuous for it, which is precisely how the
// original defect survived.
//
// Judgment recorded deliberately: `gh pr checks` reads `statusCheckRollup`,
// which merges check runs (`checks`) AND legacy commit statuses (`statuses`).
// `statuses: read` is omitted — the installer requires an Actions workflow by
// construction, and the gate's authoritative CI signal is
// `gh run list --workflow`, so the fixer's check view is advisory. If a repo
// ever gates on a non-Actions commit status, this is the line to revisit.
const GH_SCOPES = {
  'pr view': { 'pull-requests': 'read' },
  'pr diff': { 'pull-requests': 'read' },
  'pr list': { 'pull-requests': 'read' },
  'pr comment': { 'pull-requests': 'write' },
  'pr edit': { 'pull-requests': 'write' },
  'pr merge': { contents: 'write', 'pull-requests': 'write' },
  'pr checks': { checks: 'read' },
  'run view': { actions: 'read' },
  'run list': { actions: 'read' },
  'release view': { contents: 'read' },
};

// Scopes a wildcard entry can REACH via flags, beyond what its bare verb
// needs. An allow-list entry is a PREFIX wildcard — `Bash(gh pr view:*)`
// admits every flag the verb takes and must be judged by the worst of them:
// `gh pr view N --json statusCheckRollup` walks into the Checks API (403
// observed live on the App token: Runsense-ai/runsense#2561, run
// 33357967765 — 12 permission denials that run). Verb-level GH_SCOPES
// cannot see this: `pr view` maps to pull-requests:read, a scope the App
// token HAS, which is exactly how the dead entry survived assertion #4.
// Judgment recorded deliberately, like the statuses omission above: an
// empty entry means "vetted — no flag crosses a scope boundary". Keys must
// mirror GH_SCOPES exactly (asserted below), so adding a verb forces this
// vetting instead of silently defaulting to no reach.
const GH_FLAG_REACH = {
  'pr view': { checks: 'read' },
  'pr diff': {},
  'pr list': { checks: 'read' }, // same --json field surface as pr view
  'pr comment': {},
  'pr edit': {},
  'pr merge': {},
  'pr checks': {},
  'run view': {},
  'run list': {},
  'release view': {},
};

// Non-`gh` allow-list entries. `grep` shells out locally and needs no GitHub
// scope. Unknown entries throw, same reason as above.
const NON_GH_SCOPES = {
  grep: {},
};

// Scopes the Claude App installation token cannot read, per the 403s observed
// live (GraphQL statusCheckRollup and REST /actions/runs both refused with
// "Resource not accessible by integration"). An agent WITHOUT the passthrough
// runs on that token, so an allow-listed command needing one of these is a
// dead tool that fails on every call.
const APP_TOKEN_LACKS = new Set(['checks', 'actions']);

// ---- a line-oriented parser for `jobs:` and their `permissions:` blocks ----
// No YAML dependency (the project is zero-dependency by charter), so this is
// deliberately narrow and LOUD: any 6-space line inside a permissions block
// that does not look like `scope: level` throws. Under-reporting would make
// every assertion below vacuously true.
function parseJobs(workflow) {
  const lines = workflow.split('\n');
  const jobs = {};
  let inJobs = false;
  let job = null;
  let inPerms = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inJobs) {
      if (/^jobs:\s*$/.test(line)) inJobs = true;
      continue;
    }
    if (inPerms) {
      if (line.trim() === '' || /^ {6}#/.test(line)) continue;
      const indent = line.length - line.replace(/^ */, '').length;
      if (indent >= 6) {
        const m = /^ {6}([a-z-]+):\s*(read|write|none)\s*$/.exec(line);
        if (!m) {
          throw new Error(
            `permissions parser: unrecognised line ${i + 1} in job "${job}": ${JSON.stringify(line)}`,
          );
        }
        jobs[job].permissions[m[1]] = m[2];
        continue;
      }
      inPerms = false; // fall through and RE-PROCESS this line below
    }
    const jobStart = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (jobStart) {
      job = jobStart[1];
      jobs[job] = { permissions: {}, start: i, end: lines.length };
      continue;
    }
    if (job && /^ {4}permissions:\s*$/.test(line)) {
      inPerms = true;
      continue;
    }
  }

  // Body ranges, so per-job allow-list / prompt discovery reads only that job.
  const names = Object.keys(jobs);
  for (let i = 0; i < names.length; i++) {
    jobs[names[i]].end = i + 1 < names.length ? jobs[names[i + 1]].start : lines.length;
    jobs[names[i]].body = lines.slice(jobs[names[i]].start, jobs[names[i]].end).join('\n');
  }
  return jobs;
}

const JOBS = parseJobs(WORKFLOW);

// ---- requirement discovery, derived from the rendered artifacts -----------
function allowlistedTools(jobBody) {
  const m = /--allowedTools "([^"]*)"/.exec(jobBody);
  if (!m) return null; // not an agent job
  const tools = [];
  for (const [, sub] of m[1].matchAll(/Bash\(gh ([a-z]+ [a-z]+):\*\)/g)) tools.push({ kind: 'gh', name: sub });
  for (const [, cmd] of m[1].matchAll(/Bash\((?!gh )([a-z-]+):\*\)/g)) tools.push({ kind: 'other', name: cmd });
  return tools;
}

// Does this job hand the agent the workflow's token? Matches the action INPUT
// key `github_token:` (10-space `with:` indentation), never the step-level
// `GH_TOKEN:` env — the env is set on both agent steps and reaches only the
// workflow's own shell, not the agent.
function hasTokenPassthrough(jobBody) {
  return /^\s{10}github_token:\s*\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}\s*$/m.test(jobBody);
}

// The prompt the job loads, discovered from the job body rather than mapped by
// hand — so the job→prompt pairing cannot drift out from under the assertions.
function promptFor(jobBody) {
  const names = new Set([...jobBody.matchAll(/\.github\/([a-z0-9-]+-prompt\.md)/g)].map((m) => m[1]));
  return [...names];
}

// Commands the PROMPT orders. Deliberately NOT scanned: `run: |` shell bodies.
// The workflow's own shell contains `gh workflow run dependabot-review.yml`
// inside an echo'd hint; scanning shell would demand `actions: write` on the
// review job, which is both wrong and dangerous. The agent surface is the drift
// in question here; hand-written shell is covered by byte-parity plus the
// hardcoded auto-merge case at the bottom.
function commandsOrderedBy(promptText) {
  const cmds = new Set();
  for (const [, a, b] of promptText.matchAll(/\bgh ([a-z]+) ([a-z]+)\b/g)) cmds.add(`${a} ${b}`);
  return [...cmds].filter((c) => c in GH_SCOPES);
}

function scopesNeededBy(tools) {
  const need = {};
  for (const t of tools) {
    const table = t.kind === 'gh' ? GH_SCOPES : NON_GH_SCOPES;
    const entry = table[t.name];
    if (!entry) {
      throw new Error(
        `no scope mapping for allow-listed tool "${t.kind === 'gh' ? `gh ${t.name}` : t.name}" — ` +
          'add it to GH_SCOPES/NON_GH_SCOPES rather than letting it go unchecked',
      );
    }
    for (const [scope, level] of Object.entries(entry)) {
      if (!need[scope] || LEVEL[level] > LEVEL[need[scope]]) need[scope] = level;
    }
  }
  return need;
}

// What an entry can REACH, not just what its bare verb needs: GH_SCOPES
// unioned with GH_FLAG_REACH. This is the measure for a no-passthrough job,
// where the only control over a wildcard's flag surface is subtraction.
function scopesReachableBy(tools) {
  const need = scopesNeededBy(tools);
  for (const t of tools) {
    if (t.kind !== 'gh') continue;
    for (const [scope, level] of Object.entries(GH_FLAG_REACH[t.name] ?? {})) {
      if (!need[scope] || LEVEL[level] > LEVEL[need[scope]]) need[scope] = level;
    }
  }
  return need;
}

const AGENT_JOBS = Object.entries(JOBS).filter(([, j]) => allowlistedTools(j.body) !== null);

// ---- 1. the parser actually found something -------------------------------

test('the parser finds every job with a non-empty permissions block', () => {
  // A parser that silently finds nothing would make every assertion below
  // vacuously true, so this is the load-bearing precondition for the file.
  const names = Object.keys(JOBS);
  assert.deepEqual(names.sort(), ['auto-merge', 'autofix', 'review']);
  for (const n of names) {
    assert.ok(
      Object.keys(JOBS[n].permissions).length > 0,
      `job "${n}" parsed with an empty permissions block — the parser is broken or the block is missing`,
    );
  }
});

// ---- 2. each agent job names exactly one prompt ---------------------------

test('each agent job loads exactly one prompt, so the job→prompt map is derived not guessed', () => {
  assert.equal(AGENT_JOBS.length, 2, 'expected exactly two agent jobs (review, autofix)');
  for (const [name, j] of AGENT_JOBS) {
    assert.deepEqual(promptFor(j.body).length, 1, `job "${name}" must reference exactly one *-prompt.md`);
  }
});

// ---- 3. every command the prompt orders is allow-listed -------------------

for (const [name, j] of AGENT_JOBS) {
  test(`${name}: every gh command its prompt orders is allow-listed (un-allowlisted = silently denied)`, () => {
    const promptText = readFileSync(join(rendered, '.github', promptFor(j.body)[0]), 'utf8');
    const allowed = new Set(allowlistedTools(j.body).filter((t) => t.kind === 'gh').map((t) => t.name));
    for (const cmd of commandsOrderedBy(promptText)) {
      assert.ok(allowed.has(cmd), `prompt orders "gh ${cmd}" but ${name} does not allow-list it`);
    }
  });
}

// ---- 4. the token the agent holds can serve every allow-listed command ----

for (const [name, j] of AGENT_JOBS) {
  if (hasTokenPassthrough(j.body)) {
    test(`${name}: passes github_token, so the job must grant every scope its allow-listed commands need`, () => {
      // Superset, deliberately: `id-token: write` maps to no command (it serves
      // the action's OIDC fallback), so demanding equality would fail on a
      // legitimate grant.
      // NEED, not reach: grants track what the prompts order; demanding
      // grants ⊇ flag-reach would inflate scopes past "neither missing nor
      // quietly over-granted". Reach matters where no lever exists — the
      // no-passthrough branch below.
      const need = scopesNeededBy(allowlistedTools(j.body));
      const got = j.permissions;
      for (const [scope, level] of Object.entries(need)) {
        assert.ok(
          LEVEL[got[scope] ?? 'none'] >= LEVEL[level],
          `${name} needs ${scope}: ${level} (a job-level permissions block makes every unlisted scope none) ` +
            `but grants ${got[scope] ?? 'none'}`,
        );
      }
    });
  } else {
    test(`${name}: no github_token, so no allow-listed command may REACH a scope the App token lacks`, () => {
      // Without the passthrough the agent's gh runs on the Claude App token,
      // and the job's permissions block is irrelevant to it. A command whose
      // wildcard reaches checks/actions here is the blind-review defect
      // coming back: it 403s and the model reports blindness as risk.
      // REACH, not need — the flags count: `gh pr view` needs only
      // pull-requests:read, and its `--json statusCheckRollup` still 403'd
      // straight through the needs-based version of this assertion
      // (Runsense-ai/runsense#2561, run 33357967765; cf. the verb-level
      // #2335 failure in the header).
      const reach = scopesReachableBy(allowlistedTools(j.body));
      for (const scope of Object.keys(reach)) {
        assert.ok(
          !APP_TOKEN_LACKS.has(scope),
          `${name} allow-lists a command that can reach "${scope}" via its flags, which the Claude App token cannot read — ` +
            'drop the tool (compute the fact in the workflow and inject it into the prompt) or pass github_token (and read the identity contract in the workflow header first)',
        );
      }
    });
  }
}

// ---- 5. every allow-listed tool is in the scope table ---------------------

test('every allow-listed tool has a scope mapping (an unmapped one fails loudly, never silently)', () => {
  for (const [, j] of AGENT_JOBS) scopesNeededBy(allowlistedTools(j.body)); // throws if unmapped
});

// ---- 6. the identity contract, hardcoded on purpose -----------------------

test('review does NOT pass github_token — its App-posted comment is what wakes the gate', () => {
  // A comment created with GITHUB_TOKEN fires no workflow triggers (GitHub's
  // recursion guard), so passing the token here would silently sever the
  // auto-merge job's issue_comment wake-up: any review finishing after CI
  // strands its PR until the next push. The two-trigger design depends on the
  // review comment coming from the Claude App identity.
  assert.equal(hasTokenPassthrough(JOBS.review.body), false);
});

test('autofix DOES pass github_token — reading the failing run log is its first step', () => {
  // The fixer fires only on a CI failure; `gh run view --log-failed` is its
  // whole diagnosis. The App token cannot read the Actions API, so without
  // the passthrough the fixer investigates blind and "found nothing it could
  // safely fix" every time. Its comments carry no decision block, so the
  // github-actions[bot] identity costs nothing here.
  assert.equal(hasTokenPassthrough(JOBS.autofix.body), true);
});

// ---- 7. the review job's grants, hardcoded on purpose ---------------------

test('review grants exactly contents:read + pull-requests:write + id-token:write', () => {
  // Hardcoded equality, unlike the derived superset above: the review agent
  // does not hold this token, so these grants exist for the job's own steps
  // (checkout, the diagnose/assert steps' gh calls, labelling) and should not
  // creep. checks:read + actions:read sat here for weeks on the wrong theory
  // that they cured the agent's 403s; their absence is part of what this file
  // locks.
  assert.deepEqual(JOBS.review.permissions, {
    contents: 'read',
    'pull-requests': 'write',
    'id-token': 'write',
  });
});

// ---- 8. the privileged job's grants, hardcoded on purpose -----------------

test('auto-merge keeps contents:write + actions:read (hardcoded — this job merges, so its scopes are reviewed by hand)', () => {
  // Deliberately NOT derived: auto-merge runs no agent and has no allow-list, so
  // there is nothing to derive from. It is the one job that can write to the
  // default branch, so a change to its scopes should have to edit this line.
  assert.equal(JOBS['auto-merge'].permissions.contents, 'write');
  assert.equal(JOBS['auto-merge'].permissions['pull-requests'], 'write');
  assert.equal(JOBS['auto-merge'].permissions.actions, 'read');
  assert.equal(JOBS['auto-merge'].permissions['id-token'], undefined, 'the gate needs no OIDC token');
});

// ---- 9. the flag-reach table mirrors the scope table ----------------------

test('every GH_SCOPES verb has a GH_FLAG_REACH entry (a silent "no reach" default is how the last gap survived)', () => {
  // GH_SCOPES throws on an unmapped verb; this gives GH_FLAG_REACH the same
  // loudness. A verb added to one table without the flag-vetting judgment in
  // the other would default to "no reach" — precisely the shape of gap that
  // let `pr view` sit in the review allow-list for months.
  assert.deepEqual(Object.keys(GH_FLAG_REACH).sort(), Object.keys(GH_SCOPES).sort());
});

// ---- 10. a token-less agent's allow-list holds only what its prompt orders --

for (const [name, j] of AGENT_JOBS) {
  if (hasTokenPassthrough(j.body)) continue;
  test(`${name}: every allow-listed gh command is ordered by its prompt (dead capability is an instruction nobody wrote)`, () => {
    // "The tools' presence in the allow-list was itself the instruction to
    // use them" (#19). For an agent on the App token, an entry the prompt
    // never orders is a standing invitation to improvise on a flag surface
    // the verb tables cannot fully see: `Bash(gh pr view:*)` sat here
    // ordered by nothing — the workflow injects the PR number and author as
    // text — while the agent burned turns 403ing through its --json flags
    // (Runsense-ai/runsense#2561, run 33357967765). The autofix job is
    // exempt by construction: it passes github_token, its surface is
    // governed by the grant assertions above, and its un-ordered entries
    // are legitimate diagnosis latitude. Local commands (grep) have no
    // token or scope surface and are not covered.
    const promptText = readFileSync(join(rendered, '.github', promptFor(j.body)[0]), 'utf8');
    const ordered = new Set(commandsOrderedBy(promptText));
    for (const t of allowlistedTools(j.body)) {
      if (t.kind !== 'gh') continue;
      assert.ok(
        ordered.has(t.name),
        `${name} allow-lists "gh ${t.name}" but its prompt never orders it — ` +
          'remove the entry, or order it from the prompt (and re-run the scope assertions)',
      );
    }
  });
}

// ---- 11. capability floors, hardcoded on purpose ---------------------------

// Anchored to the PARSED allow-list, not a regex over the job body: the job
// bodies also mention these entries in prose (the review job's env comment
// quotes `Bash(gh pr diff:*)` verbatim), and a body regex stays green on that
// comment after the real entry is deleted — caught by falsifying this very
// test.
function allowedGh(jobBody) {
  return new Set(allowlistedTools(jobBody).filter((t) => t.kind === 'gh').map((t) => t.name));
}

test('review keeps Bash(gh pr diff:*) — the diff is the thing under review', () => {
  // Over-narrowing is the opposite failure of everything above: a reviewer
  // denied the diff still posts an escalate-shaped V1 block, every job stays
  // green, and nobody learns the review was void (the diagnose step asserts
  // on a DENIED diff at runtime because exactly that happened in the 2.1.207
  // "Contains expansion" wave). Assertion #3 catches a lone allow-list
  // deletion but goes vacuous when the prompt line is deleted with it, so
  // the floor is pinned here independently of the prompt.
  assert.ok(allowedGh(JOBS.review.body).has('pr diff'));
});

test('autofix keeps Bash(gh pr checks:*) and Bash(gh run view:*) — reading the failing run is its whole first step', () => {
  // The review job's subtraction must never be copied to the job whose
  // contract is reading CI: without these two the fixer diagnoses blind and
  // "found nothing it could safely fix" every time (the #2335 era, runs
  // 31356783516/31356783466). It passes github_token and grants checks:read
  // + actions:read precisely so these entries work.
  assert.ok(allowedGh(JOBS.autofix.body).has('pr checks'));
  assert.ok(allowedGh(JOBS.autofix.body).has('run view'));
});
