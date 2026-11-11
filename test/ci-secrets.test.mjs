import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseJobs, runJob } from './lib/actions-sim.mjs';
import { REPO, TOOLS_DIR, SEAL_ACTION, SEAL_ACTION_DIR, callerText, compositeHandler } from './lib/dep-steward.mjs';

/**
 * The secrets CI needs on a Dependabot pull request.
 *
 * GitHub runs a Dependabot PR's workflows with Dependabot's own secret store,
 * not the Actions one. A CI that reads an Actions secret therefore fails on
 * every Dependabot PR, and the gate, which merges only on green CI, never
 * merges anything. The seal step (actions/seal) finds the secrets CI reads and
 * seals each with the Dependabot store's public key; the install skill uploads
 * only the sealed copy, so no person and no log ever holds a value.
 *
 * It runs as a step of the adopter's own job, handed that job's secrets, because
 * `secrets: inherit` reaches only a reusable workflow in the caller's own
 * organization or enterprise: v0.18.0's reusable seal workflow saw none of
 * Runsense-ai/runsense's secrets.
 *
 * Here the caller's seal job, as installed, runs through the actions simulator
 * with the real seal action and a stand-in `nacl`
 * whose "sealed box" records which key sealed which value. The cipher itself
 * is libsodium's.
 */

const PUBLIC_KEY = Buffer.from('k'.repeat(32)).toString('base64');
const ACTIONS_SECRETS = {
  OPENAI_API_KEY: 'sk-test-openai',
  FROM_REUSABLE: 'reusable-value',
  NOT_CI_SECRET: 'not-for-ci',
  ALREADY_THERE: 'actions-copy',
  CLAUDE_CODE_OAUTH_TOKEN: 'not-for-ci-either',
};

// The CI the gate keys on reads OPENAI_API_KEY itself and FROM_REUSABLE through
// a local reusable workflow. GITHUB_TOKEN is the run's own; NEVER_SET is set
// nowhere. Another workflow reads NOT_CI_SECRET, which CI does not need.
const CI_YML = `name: CI
on: pull_request
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
        env:
          OPENAI_API_KEY: \${{ secrets.OPENAI_API_KEY }}
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          ALREADY_THERE: \${{ secrets.ALREADY_THERE }}
          NEVER_SET: \${{ secrets.NEVER_SET }}
          # COMMENTED_OUT: \${{ secrets.COMMENTED_OUT }}
  more:
    uses: ./.github/workflows/reusable.yml
    secrets: inherit
`;
const REUSABLE_YML = `name: Reusable
on: workflow_call
jobs:
  x:
    runs-on: ubuntu-latest
    steps:
      - run: echo
        env:
          FROM_REUSABLE: \${{ secrets.FROM_REUSABLE }}
`;
const OTHER_YML = `name: Deploy
on: push
jobs:
  d:
    runs-on: ubuntu-latest
    steps:
      - run: echo
        env:
          NOT_CI_SECRET: \${{ secrets.NOT_CI_SECRET }}
`;

// A sealed box that says what it sealed: SEALED:<first 4 key bytes>:<value>.
const STUB_NACL_PUBLIC = `class PublicKey:
    def __init__(self, raw):
        assert isinstance(raw, bytes) and len(raw) == 32, 'a Curve25519 public key is 32 bytes'
        self.raw = raw

class SealedBox:
    def __init__(self, recipient):
        self.recipient = recipient

    def encrypt(self, plaintext):
        assert isinstance(plaintext, bytes)
        return b'SEALED:' + self.recipient.raw[:4] + b':' + plaintext
`;

function checkout() {
  const dir = mkdtempSync(join(tmpdir(), 'ds-seal-repo-'));
  mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(dir, '.github/workflows/ci.yml'), CI_YML);
  writeFileSync(join(dir, '.github/workflows/reusable.yml'), REUSABLE_YML);
  writeFileSync(join(dir, '.github/workflows/deploy.yml'), OTHER_YML);
  return dir;
}

test('the secrets CI reads: its own, its local reusable workflows\', never GITHUB_TOKEN, comments or other workflows\'', () => {
  const out = execFileSync('node', [join(TOOLS_DIR, 'ci-secrets.cjs'), checkout()], { env: { ...process.env, CI_NAME: 'CI' }, encoding: 'utf8' });
  assert.deepEqual(out.trim().split('\n'), ['ALREADY_THERE', 'FROM_REUSABLE', 'NEVER_SET', 'OPENAI_API_KEY']);
});

async function runSeal() {
  const root = mkdtempSync(join(tmpdir(), 'ds-seal-'));
  const runnerBin = join(root, 'runner-bin');
  const stub = join(root, 'stub-python');
  mkdirSync(runnerBin);
  mkdirSync(join(stub, 'nacl'), { recursive: true });
  const aptLog = join(root, 'apt.log');
  writeFileSync(aptLog, '');
  writeFileSync(join(runnerBin, 'sudo'), '#!/bin/sh\n"$@"\n', { mode: 0o755 });
  writeFileSync(join(runnerBin, 'apt-get'), '#!/bin/sh\necho "apt-get $*" >> "$APT_LOG"\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(stub, 'nacl', '__init__.py'), '');
  writeFileSync(join(stub, 'nacl', 'public.py'), STUB_NACL_PUBLIC);
  const caller = callerText('seal').replaceAll('__CI_NAME__', 'CI');
  const r = await runJob(parseJobs(caller), 'seal', {
    // The job's secrets, as GitHub hands them to a workflow_dispatch run in
    // the adopter's repo: every Actions secret, whoever owns the repo.
    github: { event_name: 'workflow_dispatch', repository: 'acme/widgets', event: { inputs: {} } },
    inputs: { 'public-key': PUBLIC_KEY },
    secrets: { GITHUB_TOKEN: 'ghs_run', ...ACTIONS_SECRETS },
    uses: { 'actions/checkout': async () => ({ exitCode: 0 }), [SEAL_ACTION]: compositeHandler(SEAL_ACTION_DIR) },
    cwd: checkout(),
    env: { ...process.env, PATH: `${runnerBin}:${process.env.PATH}`, PYTHONPATH: stub, APT_LOG: aptLog },
  });
  const log = r.steps.map((s) => s.output).join('\n');
  return { r, log, aptLog: readFileSync(aptLog, 'utf8') };
}

test('each secret CI reads is sealed with the Dependabot store\'s key; one set nowhere is reported, not sealed', async () => {
  const { r, log } = await runSeal();
  assert.equal(r.failed, false, log);
  const keyPrefix = Buffer.from('kkkk').toString();
  const sealed = Object.fromEntries([...log.matchAll(/^DEP-STEWARD-SEALED (\S+) (\S+)$/gm)]
    .map((m) => [m[1], Buffer.from(m[2], 'base64').toString()]));
  assert.deepEqual(Object.keys(sealed).sort(), ['ALREADY_THERE', 'FROM_REUSABLE', 'OPENAI_API_KEY']);
  for (const [name, box] of Object.entries(sealed)) assert.equal(box, `SEALED:${keyPrefix}:${ACTIONS_SECRETS[name]}`);
  assert.match(log, /^DEP-STEWARD-UNSET NEVER_SET$/m);
  for (const v of Object.values(ACTIONS_SECRETS)) assert.ok(!log.includes(v), 'no value appears in the log');
});

test('the seal job reads contents only, keeps no credential, and installs only Ubuntu\'s signed NaCl package', async () => {
  const caller = callerText('seal');
  assert.match(caller, /^permissions:\n {2}contents: read\n/m);
  const job = parseJobs(caller).seal;
  const co = job.steps.find((s) => String(s.uses).startsWith('actions/checkout@'));
  assert.equal(String(co.with['persist-credentials']), 'false');
  assert.ok(job.steps.indexOf(co) < job.steps.findIndex((s) => String(s.uses).startsWith(`${SEAL_ACTION}@`)), 'the checkout comes first: the seal step reads the CI workflow files');
  const { aptLog } = await runSeal();
  assert.match(aptLog, /install .*python3-nacl/);
});

test('the seal caller only dispatches by hand, and hands its own job\'s secrets to the seal step (no reusable workflow, no inherit)', () => {
  const caller = callerText('seal');
  assert.match(caller, /^on:\n {2}workflow_dispatch:/m);
  assert.doesNotMatch(caller, /^ {2}(push|pull_request|workflow_run|schedule):/m);
  assert.doesNotMatch(caller, /secrets: inherit/, 'inherit reaches only the caller\'s own organization');
  assert.doesNotMatch(caller, /\.github\/workflows\/[a-z-]+\.yml@/, 'the seal is a step of this job, not a reusable workflow');
  assert.match(caller, /^ {10}secrets: \$\{\{ toJSON\(secrets\) \}\}$/m);
});

test('the install skill uploads only what Dependabot\'s store lacks, and deletes the run', () => {
  const skill = readFileSync(join(REPO, 'plugin/skills/install/SKILL.md'), 'utf8');
  assert.match(skill, /does not list, run `gh api -X PUT repos\/<NWO>\/dependabot\/secrets\/<NAME>/);
  assert.match(skill, /gh api -X DELETE repos\/<NWO>\/actions\/runs\/<id>/);
});
