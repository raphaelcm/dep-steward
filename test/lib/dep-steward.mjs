// What the tests run: dep-steward's shipped reusable workflows, the caller
// templates the plugin installs, and the tools action they share, exactly as
// they are in this tree. Nothing here renders or rewrites them.
//
// Reads: .github/workflows/{review,automerge}.yml, actions/seal/action.yml,
// plugin/templates/*.yml, actions/tools/*. Writes: only temp directories a
// test asks for. Touches nothing in the tree.

import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJobs, runJob } from './actions-sim.mjs';

export const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const TOOLS_DIR = join(REPO, 'actions', 'tools');
export const TOOLS_ACTION = 'raphaelcm/dep-steward/actions/tools';

export const WORKFLOW_PATHS = {
  review: join(REPO, '.github/workflows/review.yml'),
  automerge: join(REPO, '.github/workflows/automerge.yml'),
};
export const CALLER_PATHS = {
  review: join(REPO, 'plugin/templates/dependabot-review.yml'),
  automerge: join(REPO, 'plugin/templates/dependabot-automerge.yml'),
  seal: join(REPO, 'plugin/templates/dependabot-seal.yml'),
};
export const workflowText = (name) => readFileSync(WORKFLOW_PATHS[name], 'utf8');
export const SEAL_ACTION = 'raphaelcm/dep-steward/actions/seal';
export const SEAL_ACTION_DIR = join(REPO, 'actions', 'seal');
export const sealActionText = () => readFileSync(join(SEAL_ACTION_DIR, 'action.yml'), 'utf8');
export const callerText = (name) => readFileSync(CALLER_PATHS[name], 'utf8');
export const toolText = (file) => readFileSync(join(TOOLS_DIR, file), 'utf8');

// The multi-ecosystem reference repo the suite has always used.
export const REFERENCE_ROOT_FILES = ['package.json', 'package-lock.json', 'requirements.txt', 'Cargo.toml', 'go.mod', 'Dockerfile'];

// `env:` at the top level of a workflow: two-space keys, one-line values.
export function topLevelEnv(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^env:\s*$/.test(l));
  const env = {};
  if (start < 0) return env;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^\S/.test(l)) break;
    const m = /^ {2}([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(l);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

// The `workflow_call` inputs' defaults, so a test passes only what it varies.
export function inputDefaults(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^ {4}inputs:\s*$/.test(l));
  const out = {};
  if (start < 0) return out;
  let name = null;
  let type = 'string';
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^ {0,4}\S/.test(l)) break;
    const n = /^ {6}([a-z_-]+):\s*$/.exec(l);
    if (n) { name = n[1]; type = 'string'; out[name] = ''; continue; }
    const t = /^ {8}type:\s*(\S+)/.exec(l);
    if (t && name) { type = t[1]; if (type === 'boolean') out[name] = false; }
    const d = /^ {8}default:\s*(.*)$/.exec(l);
    if (d && name) {
      const raw = d[1].trim();
      out[name] = type === 'boolean' ? raw === 'true' : raw.replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1');
    }
  }
  return out;
}

// The tools action, as its composite step does it: read-only copies of the
// scripts and the filled prompts in $RUNNER_TEMP/dep-steward, and ROOT_FILES
// for later steps. The root listing comes from the test (on a runner, from
// the default branch's tree through the API).
export function toolsHandler({ rootFiles = REFERENCE_ROOT_FILES } = {}) {
  return async ({ with: w, env }) => {
    const d = join(env.RUNNER_TEMP, 'dep-steward');
    try { execFileSync('chmod', ['-R', 'u+w', d], { stdio: 'ignore' }); } catch { /* absent */ }
    rmSync(d, { recursive: true, force: true });
    mkdirSync(d, { recursive: true });
    for (const f of ['ecosystems.cjs', 'gate.cjs', 'review-lint.cjs', 'autofix-bounds.cjs', 'regenerate-take.sh', 'ci-secrets.cjs']) {
      copyFileSync(join(TOOLS_DIR, f), join(d, f));
    }
    const ROOT_FILES = rootFiles.join('\n');
    for (const [src, dst] of [['review-prompt.md', 'review-prompt.md'], ['autofix-prompt.md', 'autofix-prompt.md']]) {
      const filled = execFileSync('node', [join(TOOLS_DIR, 'render-prompt.cjs'), join(TOOLS_DIR, src)], {
        env: { ...process.env, ROOT_FILES, ASSIGNEE: w.assignee ?? '' },
        encoding: 'utf8',
      });
      writeFileSync(join(d, dst), filled);
    }
    for (const f of readdirSync(d)) chmodSync(join(d, f), 0o444);
    chmodSync(d, 0o555);
    return { exitCode: 0, env: { ROOT_FILES } };
  };
}

// One job of a shipped reusable workflow, through the step simulator, with
// the workflow's input defaults overridden by `inputs`.
export function runShippedJob(workflow, jobName, { inputs = {}, uses = {}, rootFiles, ...rest }) {
  const text = workflowText(workflow);
  return runJob(parseJobs(text), jobName, {
    ...rest,
    inputs: { ...inputDefaults(text), ...inputs },
    workflowEnv: topLevelEnv(text),
    uses: { [TOOLS_ACTION]: toolsHandler({ rootFiles }), ...uses },
  });
}

export const jobsOf = (workflow) => parseJobs(workflowText(workflow));

// A composite action's `runs.steps`, as one job the step simulator can run.
export function compositeJobs(actionText, jobName = 'action') {
  const lines = actionText.split('\n');
  const at = lines.findIndex((l) => /^ {2}steps:\s*$/.test(l));
  if (at < 0) throw new Error('composite action: no runs.steps');
  const steps = lines.slice(at + 1).map((l) => (l.trim() === '' ? '' : `  ${l}`));
  return parseJobs(['jobs:', `  ${jobName}:`, '    steps:', ...steps].join('\n'));
}

// The handler a workflow step `uses:` for a composite action in this tree:
// its steps run through the simulator with the step's `with:` as `inputs`
// and GITHUB_ACTION_PATH at the action's directory.
export function compositeHandler(actionDir, { github = {} } = {}) {
  return async ({ with: w, env, cwd }) => {
    const r = await runJob(compositeJobs(readFileSync(join(actionDir, 'action.yml'), 'utf8')), 'action', {
      github, inputs: w, cwd, env: { ...env, GITHUB_ACTION_PATH: actionDir },
    });
    return { exitCode: r.failed ? 1 : 0, output: r.steps.map((s) => s.output).join('\n'), steps: r.steps };
  };
}
