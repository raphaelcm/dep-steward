import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { REPO } from './lib/dep-steward.mjs';
import { parseJobs, runJob } from './lib/actions-sim.mjs';
import { GIT_ISOLATION, git } from './lib/autofix-harness.mjs';
import { CALLERS } from '../scripts/pin.mjs';
import { releaseNotes } from '../scripts/release.mjs';

/**
 * Merging a release PR publishes the release: the tag Dependabot reads to
 * offer it to adopters, at the commit their caller files pin, and the GitHub
 * release that carries its notes. v0.18.2's PR merged and got neither,
 * because tagging was a step someone had to run after the merge, and nobody
 * did.
 *
 * These run CI's release job (.github/workflows/ci.yml) through the step
 * simulator, so its `node scripts/release.mjs` runs as it does on a runner:
 * in a clone whose origin is a local bare repo, with a `gh` that keeps
 * releases in a directory.
 */

const CI = parseJobs(readFileSync(join(REPO, '.github/workflows/ci.yml'), 'utf8'));
const PUSH_TO_MAIN = { event_name: 'push', ref: 'refs/heads/main', repository: 'raphaelcm/dep-steward', token: 'ghs_releaseJobToken' };
const ACTIONS_BOT = 'github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>';
const noop = async () => ({ exitCode: 0 });

// gh, as scripts/release.mjs calls it. `create --verify-tag` refuses a tag
// origin lacks, as gh does.
const GH_STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GH_STATE/calls"
[ "$1" = release ] || { echo "gh stub: unexpected: $*" >&2; exit 2; }
sub=$2 tag=$3
shift 3
case $sub in
  view)
    [ -f "$GH_STATE/$tag.json" ] && { cat "$GH_STATE/$tag.json"; exit 0; }
    echo "release not found" >&2; exit 1 ;;
  create)
    while [ $# -gt 0 ]; do
      case $1 in
        --verify-tag) git ls-remote --exit-code origin "refs/tags/$tag" >/dev/null || { echo "tag $tag doesn't exist in the repo" >&2; exit 1; } ;;
        --title) title=$2; shift ;;
        --notes-file) notes=$(cat "$2"); shift ;;
        *) echo "gh stub: unexpected flag $1" >&2; exit 2 ;;
      esac
      shift
    done
    [ -f "$GH_STATE/$tag.json" ] && { echo "a release with the same tag name already exists" >&2; exit 1; }
    jq -n --arg name "$title" --arg body "$notes" '{$name, $body}' > "$GH_STATE/$tag.json" ;;
  *) echo "gh stub: unexpected: release $sub" >&2; exit 2 ;;
esac
`;

// The line each caller template pins dep-steward with.
const CALLER_LINES = {
  'plugin/templates/dependabot-review.yml': (pin) => `    uses: raphaelcm/dep-steward/.github/workflows/review.yml@${pin}`,
  'plugin/templates/dependabot-automerge.yml': (pin) => `    uses: raphaelcm/dep-steward/.github/workflows/automerge.yml@${pin}`,
  'plugin/templates/dependabot-seal.yml': (pin) => `      - uses: raphaelcm/dep-steward/actions/seal@${pin}`,
};

const NOTES = '## v0.2.0: Merging a release publishes it\n\nThe notes, as adopters read them.\n\n### Upgrading\n\nMerge the Dependabot PR.\n';
const CHANGELOG = `# Changelog\n\nNewest first.\n\n${NOTES}\n## v0.1.0: The first release\n\nOlder notes.\n`;

function write(dir, file, text) {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), text);
}

// A clone of dep-steward as a release PR's merge leaves main: the release
// commit, then the commit that pins the callers to it as v0.2.0, with its
// notes. origin is a bare repo holding main. With `squashed`, the callers pin
// a commit main's history does not hold.
function releaseRepo({ changelog = CHANGELOG, squashed = false } = {}) {
  assert.deepEqual(Object.keys(CALLER_LINES).sort(), [...CALLERS].sort(), 'the fixture pins every caller template scripts/pin.mjs pins');
  const dir = mkdtempSync(join(tmpdir(), 'ds-release-'));
  const origin = join(dir, 'origin.git');
  const work = join(dir, 'work');
  git(['init', '-q', '--bare', '-b', 'main', origin], dir);
  git(['init', '-q', '-b', 'main', work], dir);
  git(['config', 'user.name', 'Release Author'], work);
  git(['config', 'user.email', 'author@example.test'], work);
  git(['remote', 'add', 'origin', origin], work);
  for (const f of ['pin.mjs', 'release.mjs']) write(work, `scripts/${f}`, readFileSync(join(REPO, 'scripts', f), 'utf8'));
  const declare = (pin, version) => {
    for (const [f, line] of Object.entries(CALLER_LINES)) write(work, f, `jobs:\n  steward:\n${line(pin)}\n`);
    write(work, 'plugin/.claude-plugin/plugin.json', `${JSON.stringify({ name: 'dep-steward', version }, null, 2)}\n`);
  };
  const commit = (message) => {
    git(['add', '-A'], work);
    git(['commit', '-q', '-m', message], work);
    return git(['rev-parse', 'HEAD'], work).trim();
  };
  declare(`${'1'.repeat(40)} # v0.1.0`, '0.1.0');
  commit('The code');
  if (squashed) git(['checkout', '-q', '-b', 'release-pr'], work);
  write(work, 'actions/tools/pinned.txt', 'the reusable workflows run the code above\n');
  const release = commit('Pin the tools for v0.2.0');
  if (squashed) {
    git(['checkout', '-q', 'main'], work);
    write(work, 'actions/tools/pinned.txt', 'the reusable workflows run the code above\n');
  }
  declare(`${release} # v0.2.0`, '0.2.0');
  if (changelog !== null) write(work, 'CHANGELOG.md', changelog);
  const head = commit('Pin the callers');
  git(['push', '-q', 'origin', 'main'], work);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), GH_STUB);
  chmodSync(join(bin, 'gh'), 0o755);
  const state = join(dir, 'gh-state');
  mkdirSync(state);
  return { origin, work, bin, state, release, head };
}

function releaseJob(repo, github = PUSH_TO_MAIN) {
  return runJob(CI, 'release', {
    github,
    uses: { 'actions/checkout': noop, 'actions/setup-node': noop },
    cwd: repo.work,
    env: { ...process.env, ...GIT_ISOLATION, PATH: `${repo.bin}:${process.env.PATH}`, GH_STATE: repo.state },
    needs: { test: { result: 'success', outputs: {} } },
  });
}

// origin's tags, by name: what each ref holds, the commit it names, its tagger and message.
function originTags(repo) {
  const out = git(['for-each-ref', 'refs/tags', '--format=%(refname:short)\t%(objecttype)\t%(objectname)\t%(*objectname)\t%(taggername) %(taggeremail)\t%(contents:subject)'], repo.origin);
  return Object.fromEntries(out.split('\n').filter(Boolean).map((l) => {
    const [name, type, object, peeled, tagger, subject] = l.split('\t');
    return [name, { type, object, commit: peeled || object, tagger: tagger.trim(), subject }];
  }));
}

const releases = (repo) => Object.fromEntries(readdirSync(repo.state).filter((f) => f.endsWith('.json'))
  .map((f) => [f.replace(/\.json$/, ''), JSON.parse(readFileSync(join(repo.state, f), 'utf8'))]));
const ghCalls = (repo) => (existsSync(join(repo.state, 'calls')) ? readFileSync(join(repo.state, 'calls'), 'utf8').trim().split('\n') : []);
const creates = (repo) => ghCalls(repo).filter((c) => c.startsWith('release create'));
const output = (job) => job.steps.map((s) => s.output).join('\n');

test("a release PR's merge tags the release commit and publishes its CHANGELOG notes", async () => {
  const repo = releaseRepo();
  const job = await releaseJob(repo);
  assert.equal(job.failed, false, output(job));
  assert.equal(job.steps.at(-1).env.GH_TOKEN, PUSH_TO_MAIN.token, "gh runs on the job's token");
  const tags = originTags(repo);
  assert.deepEqual(Object.keys(tags), ['v0.2.0']);
  const { object, ...tag } = tags['v0.2.0'];
  assert.deepEqual(tag, { type: 'tag', commit: repo.release, tagger: ACTIONS_BOT, subject: 'v0.2.0' }, "an annotated tag at the commit the callers pin, not at main's tip");
  assert.notEqual(object, repo.release);
  assert.deepEqual(releases(repo), {
    'v0.2.0': { name: 'v0.2.0: Merging a release publishes it', body: 'The notes, as adopters read them.\n\n### Upgrading\n\nMerge the Dependabot PR.' },
  });
  assert.equal(git(['rev-parse', 'main'], repo.origin).trim(), repo.head, 'no branch moved');
});

test('a push whose release is already published changes nothing', async () => {
  const repo = releaseRepo();
  await releaseJob(repo);
  const before = originTags(repo);
  const again = await releaseJob(repo);
  assert.equal(again.failed, false, output(again));
  assert.deepEqual(originTags(repo), before);
  assert.equal(creates(repo).length, 1, 'the release is created once');
});

test('a tag already at the release commit is kept, and only its missing release is published', async () => {
  const repo = releaseRepo();
  git(['push', '-q', 'origin', `${repo.release}:refs/tags/v0.2.0`], repo.work);
  const job = await releaseJob(repo);
  assert.equal(job.failed, false, output(job));
  assert.deepEqual(originTags(repo)['v0.2.0'], { type: 'commit', object: repo.release, commit: repo.release, tagger: '', subject: 'Pin the tools for v0.2.0' });
  assert.deepEqual(Object.keys(releases(repo)), ['v0.2.0']);
});

test('a tag naming another commit is never moved, and nothing is published', async () => {
  const repo = releaseRepo();
  git(['push', '-q', 'origin', `${repo.head}:refs/tags/v0.2.0`], repo.work);
  const job = await releaseJob(repo);
  assert.equal(job.failed, true);
  assert.match(output(job), new RegExp(`origin's v0\\.2\\.0 names ${repo.head}, not the release commit ${repo.release}\\. A published tag is never moved`));
  assert.equal(originTags(repo)['v0.2.0'].object, repo.head);
  assert.deepEqual(creates(repo), []);
});

test('a release with no notes in CHANGELOG.md is refused before anything is tagged', async () => {
  for (const changelog of [null, '# Changelog\n\n## v0.1.0: The first release\n\nOlder notes.\n', '# Changelog\n\n## v0.2.0: A headline over nothing\n\n## v0.1.0: The first release\n\nOlder notes.\n']) {
    const repo = releaseRepo({ changelog });
    const job = await releaseJob(repo);
    assert.equal(job.failed, true, `published with ${changelog === null ? 'no CHANGELOG.md' : JSON.stringify(changelog)}`);
    assert.match(output(job), /CHANGELOG\.md has no notes for v0\.2\.0/);
    assert.deepEqual(originTags(repo), {});
    assert.deepEqual(ghCalls(repo), []);
  }
});

test("a release commit outside main's history (a squash merge) is refused before anything is tagged", async () => {
  const repo = releaseRepo({ squashed: true });
  const job = await releaseJob(repo);
  assert.equal(job.failed, true);
  assert.match(output(job), new RegExp(`the release commit ${repo.release} is not in this branch's history`));
  assert.deepEqual(originTags(repo), {});
  assert.deepEqual(ghCalls(repo), []);
});

test('the release job runs for a push to main, after the tests, and for nothing else', async () => {
  assert.deepEqual([CI.release.needs].flat(), ['test']);
  assert.deepEqual(CI.release.permissions, { contents: 'write' });
  for (const github of [
    { ...PUSH_TO_MAIN, event_name: 'pull_request', ref: 'refs/pull/7/merge' },
    { ...PUSH_TO_MAIN, ref: 'refs/heads/release-pr' },
  ]) {
    const repo = releaseRepo();
    const job = await releaseJob(repo, github);
    assert.equal(job.skipped, true, `${github.event_name} ${github.ref}`);
    assert.deepEqual(originTags(repo), {});
  }
});

test("releaseNotes reads one version's heading and the notes under it, up to the next version's", () => {
  assert.deepEqual(releaseNotes(CHANGELOG, 'v0.2.0'), { title: 'v0.2.0: Merging a release publishes it', notes: 'The notes, as adopters read them.\n\n### Upgrading\n\nMerge the Dependabot PR.' });
  assert.deepEqual(releaseNotes(CHANGELOG, 'v0.1.0'), { title: 'v0.1.0: The first release', notes: 'Older notes.' });
  assert.equal(releaseNotes(CHANGELOG, 'v0.2'), null, 'a version is matched whole');
  assert.equal(releaseNotes(CHANGELOG, 'v0.3.0'), null);
  assert.equal(releaseNotes('## v0.3.0\n\nNo headline.\n', 'v0.3.0'), null, 'the heading carries a headline, which titles the release');
});
