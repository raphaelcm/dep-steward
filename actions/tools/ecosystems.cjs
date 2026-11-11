'use strict';

/*
 * The package managers dep-steward manages, derived from the files at the
 * repo root. One function of one input, shared by every consumer, so the
 * gate's group prefixes, its path whitelist, and the prompt's ecosystem list
 * can never disagree:
 *
 *   - gate.cjs: ELIGIBLE_GROUP_PREFIXES, WHITELIST_EXACT, WHITELIST_REGEX
 *   - render-prompt.cjs: the human-readable ecosystem list
 *   - the install skill's table, which writes .github/dependabot.yml with the
 *     same group names (test/ecosystems.test.mjs holds the two together)
 *
 * Input: the names of the files at the root of the repo's DEFAULT branch
 * (never a PR's tree: a PR that adds a manifest must not widen the whitelist
 * that judges it). Branch slugs are dependabot-core's own: only
 * npm→npm_and_yarn, gomod→go_modules and github-actions→github_actions differ
 * from the config value. GitHub Actions is always managed. Non-root manifests
 * are out of scope.
 */

function ecosystemsFor(rootFiles) {
  const has = (name) => rootFiles.includes(name);
  const any = (re) => rootFiles.some((f) => re.test(f));
  const ecosystems = [];
  const exact = [];
  const regex = [];
  const add = (name, slug, group, paths, res = []) => {
    ecosystems.push({ name, slug, group });
    exact.push(...paths);
    regex.push(...res);
  };

  if (has('package.json')) add('npm', 'npm_and_yarn', 'npm-minor-patch', ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml']);
  if (has('uv.lock')) add('uv', 'uv', 'uv-minor-patch', ['pyproject.toml', 'uv.lock']);
  if (has('requirements.txt') || has('Pipfile') || has('poetry.lock') || has('setup.py') || (has('pyproject.toml') && !has('uv.lock'))) {
    add('pip', 'pip', 'pip-minor-patch',
      ['requirements.txt', 'requirements.in', 'Pipfile', 'Pipfile.lock', 'pyproject.toml', 'poetry.lock', 'setup.py', 'setup.cfg', 'pdm.lock'],
      [/^requirements.*\.txt$/]);
  }
  if (has('Cargo.toml')) add('cargo', 'cargo', 'cargo-minor-patch', ['Cargo.toml', 'Cargo.lock']);
  if (has('go.mod')) add('gomod', 'go_modules', 'gomod-minor-patch', ['go.mod', 'go.sum', 'go.work', 'go.work.sum']);
  if (has('Gemfile') || any(/\.gemspec$/)) {
    add('bundler', 'bundler', 'bundler-minor-patch', ['Gemfile', 'Gemfile.lock', 'gems.rb', 'gems.locked'], [/^[^/]+\.gemspec$/]);
  }
  if (has('composer.json')) add('composer', 'composer', 'composer-minor-patch', ['composer.json', 'composer.lock']);
  if (has('pom.xml')) add('maven', 'maven', 'maven-minor-patch', ['pom.xml']);
  if (has('build.gradle') || has('build.gradle.kts')) {
    add('gradle', 'gradle', 'gradle-minor-patch',
      ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'gradle.properties', 'gradle.lockfile', 'gradle/libs.versions.toml']);
  }
  if (any(/\.(csproj|fsproj|vbproj|sln)$/) || has('packages.config') || has('Directory.Packages.props')) {
    add('nuget', 'nuget', 'nuget-minor-patch',
      ['packages.config', 'packages.lock.json', 'global.json', 'Directory.Packages.props', 'Directory.Build.props', 'Directory.Build.targets'],
      [/^[^/]+\.(csproj|vbproj|fsproj|proj|sln|slnx)$/]);
  }
  if (has('Dockerfile') || has('Containerfile') || any(/\.dockerfile$/)) {
    add('docker', 'docker', 'docker-minor-patch', ['Dockerfile', 'Containerfile'], [/^Dockerfile\..+$/, /^[^/]+\.dockerfile$/]);
  }
  add('github-actions', 'github_actions', 'actions-minor-patch', [],
    [/^\.github\/workflows\/[^/]+\.ya?ml$/, /^\.github\/actions\//, /(^|\/)action\.ya?ml$/]);

  return {
    ecosystems,
    prefixes: ecosystems.map((e) => `dependabot/${e.slug}/${e.group}-`),
    whitelistExact: new Set(exact),
    whitelistRegex: regex,
    human: ecosystems.map((e) => e.name).join(', '),
  };
}

// ROOT_FILES: newline-separated names, as the workflow lists them from the
// default branch's tree. An empty or missing list is a wiring fault, not a
// repo with no manifests (every repo has GitHub Actions managed), so it throws.
function ecosystemsFromEnv(env = process.env) {
  const raw = env.ROOT_FILES;
  if (raw === undefined || raw.trim() === '') throw new Error('ROOT_FILES is empty: the workflow must list the default branch root');
  return ecosystemsFor(raw.split('\n').map((s) => s.trim()).filter(Boolean));
}

module.exports = { ecosystemsFor, ecosystemsFromEnv };
