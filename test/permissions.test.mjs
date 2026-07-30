import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Job permissions vs. what the agents are actually told to do.
 *
 * The failure this locks: a job-level `permissions:` block sets every UNLISTED
 * scope to `none`. The review and autofix prompts both order `gh pr checks`
 * (Checks API) and `gh run view --log-failed` (Actions API), and both commands
 * are allow-listed in `--allowedTools` — but neither job granted `checks: read`
 * or `actions: read`. The agent 403s on the CI it was ordered to read and
 * reviews the PR blind, while the job still reports success.
 *
 * Byte-parity (render.test.mjs) cannot catch this: it would have locked the bug
 * in. So this asserts a SEMANTIC invariant derived from two artifacts — the
 * workflow's allow-list and the prompt the job loads — rather than a hardcoded
 * list of scopes. Hardcoding "the review job grants checks: read" would pass
 * forever while a newly allow-listed command went un-scoped.
 *
 * Everything below runs over the RENDERED tree, which is what an adopter ships.
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
// entry makes the "every needed scope is granted" assertion vacuous for it,
// which is precisely how the original defect survived.
//
// Judgment recorded deliberately: `gh pr checks` reads `statusCheckRollup`,
// which merges check runs (`checks`) AND legacy commit statuses (`statuses`).
// `statuses: read` is omitted — the installer requires an Actions workflow by
// construction, and the gate's authoritative CI signal is
// `gh run list --workflow`, so the model's check view is advisory. If a repo
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

// Non-`gh` allow-list entries. `grep` shells out locally and needs no GitHub
// scope. Unknown entries throw, same reason as above.
const NON_GH_SCOPES = {
  grep: {},
};

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

// ---- 4. every scope an allow-listed command needs is granted --------------

for (const [name, j] of AGENT_JOBS) {
  test(`${name}: grants every scope its allow-listed commands need (superset, not equality)`, () => {
    // Superset, deliberately: `id-token: write` is required by the action's OIDC
    // flow and maps to no command, so demanding equality would fail on a
    // legitimate grant.
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
}

// ---- 5. every allow-listed tool is in the scope table ---------------------

test('every allow-listed tool has a scope mapping (an unmapped one fails loudly, never silently)', () => {
  for (const [, j] of AGENT_JOBS) scopesNeededBy(allowlistedTools(j.body)); // throws if unmapped
});

// ---- 6. the regression itself --------------------------------------------

for (const name of ['review', 'autofix']) {
  test(`${name} grants checks:read + actions:read — the agent was ordered to read CI it had no permission to see`, () => {
    assert.equal(JOBS[name].permissions.checks, 'read');
    assert.equal(JOBS[name].permissions.actions, 'read');
  });
}

// ---- 7. the privileged job's grants, hardcoded on purpose -----------------

test('auto-merge keeps contents:write + actions:read (hardcoded — this job merges, so its scopes are reviewed by hand)', () => {
  // Deliberately NOT derived: auto-merge runs no agent and has no allow-list, so
  // there is nothing to derive from. It is the one job that can write to the
  // default branch, so a change to its scopes should have to edit this line.
  assert.equal(JOBS['auto-merge'].permissions.contents, 'write');
  assert.equal(JOBS['auto-merge'].permissions['pull-requests'], 'write');
  assert.equal(JOBS['auto-merge'].permissions.actions, 'read');
  assert.equal(JOBS['auto-merge'].permissions['id-token'], undefined, 'the gate needs no OIDC token');
});
