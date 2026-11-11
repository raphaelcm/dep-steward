---
description: Install the dep-steward Dependabot pipeline into the current repository — check the prerequisites, show what will change, write the workflow files, and set the secrets.
argument-hint: "[settings in plain words — e.g. no autofix, CI is called \"Build\", assign octocat]"
---

Set up **dep-steward** in the repository the user is working in: Dependabot auto-updates the dependencies, a Claude agent reviews each PR it opens, and a deterministic gate auto-merges only when it is safe.

The pipeline itself is code in `raphaelcm/dep-steward`, which GitHub runs as reusable workflows at a pinned commit. Installing writes three short workflow files that call it, plus `.github/dependabot.yml`, then sets a label, two secrets and one repo setting. Running this again is safe: it rewrites the same files and keeps their settings.

Apply what the user asked for in `$ARGUMENTS` to the settings in step 3.

## 1. Preflight

Run these and tell the user what you found. Each failure has a specific fix; name it.

- **In a GitHub repo:** `gh repo view --json nameWithOwner,defaultBranchRef`. A failure means the user is not in a GitHub repo, or `gh` cannot see it.
- **`gh` authenticated with the right scopes:** `gh auth status`. It needs `repo` and `workflow`. The fix: `gh auth refresh -h github.com -s repo,workflow`.
- **The CI workflow:** read the top-level `name:` of each file in `.github/workflows/`. The gate merges only when this workflow passes, so it needs its exact name. When more than one could be "the" CI, ask the user which one gates merges.
- **An earlier dep-steward install:** `.github/dependabot-automerge/` (a directory) or `.github/dependabot-review-prompt.md` means a version before 0.18. Step 2 covers it.
- **The token secret:** `gh secret list` and `gh secret list --app dependabot`. `CLAUDE_CODE_OAUTH_TOKEN` must be in **both**: a run Dependabot triggers sees only the Dependabot store.

## 2. Carry over an earlier install's settings

When an earlier install exists, read its settings from `.github/workflows/dependabot-review.yml` before replacing it, and use them in step 3:

- **model:** the value after `--model`.
- **assignee:** the login after `--add-assignee`, or none.
- **autofix:** on when the file has an `autofix:` job.
- **regeneration:** the `REGENERATE_COMMAND` and `REGENERATE_PATHS` values in the `regenerate:` job's `env:`, and its other `env:` entries as `NAME=VALUE` lines.

Those files are replaced in step 4, and these are removed:
- `.github/dependabot-automerge/`
- `.github/dependabot-review-prompt.md`
- `.github/dependabot-autofix-prompt.md`

## 3. Settings

| Setting | Default | Where it goes |
|---|---|---|
| CI name | from preflight | every `__CI_NAME__` in the three workflow files |
| Assignee | the login from `gh api user --jq .login` | every `__ASSIGNEE__`; an empty string assigns nobody |
| Model | `claude-opus-4-8` | `model:` in `dependabot-review.yml` |
| Autofix | on | `autofix:` in `dependabot-review.yml` and `dependabot-automerge.yml` (both the same) |
| Regeneration | off | `regenerate-command`, `regenerate-paths`, `regenerate-env` in `dependabot-review.yml` |

**Regeneration** is for a repo that commits code a generator writes from a dependency (a Prisma client, an API client) and whose CI checks it is in sync. After a bump, autofix can then push the regenerated code.
- If the repo has `prisma/schema.prisma`, `schema.prisma` or a `prisma.config.*` and an npm lockfile, ask whether to turn it on.
- For Prisma, the command is the `package.json` script that runs `prisma generate` (as `npm run <script>`), else `npx prisma generate`.
- The paths are the git-tracked `output` directories of its generators, space-separated.
- `regenerate-env` takes `NAME=VALUE` lines for the variables the generator reads (Prisma's `env()` calls). These values are committed in the workflow, so they must be placeholders, never secrets.

## 4. Show what will change, then write it

The three workflow files are `${CLAUDE_PLUGIN_ROOT}/templates/dependabot-review.yml`, `dependabot-automerge.yml` and `dependabot-seal.yml`. Copy each to `.github/workflows/` under the same name, changing only the values in the settings table. The pinned commit after `@` is the release this plugin installs; keep it as it is.

Write `.github/dependabot.yml` from `${CLAUDE_PLUGIN_ROOT}/templates/dependabot.yml`: one `updates:` entry per row below whose files exist at the repo root, plus `github-actions`, which is always included. Each entry has the form:

```yaml
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
      day: monday
    groups:
      npm-minor-patch:
        update-types:
          - minor
          - patch
```

| Files at the repo root | package-ecosystem | group |
|---|---|---|
| `package.json` | `npm` | `npm-minor-patch` |
| `uv.lock` | `uv` | `uv-minor-patch` |
| `requirements.txt`, `Pipfile`, `poetry.lock`, `setup.py`, or `pyproject.toml` without `uv.lock` | `pip` | `pip-minor-patch` |
| `Cargo.toml` | `cargo` | `cargo-minor-patch` |
| `go.mod` | `gomod` | `gomod-minor-patch` |
| `Gemfile` or a `*.gemspec` | `bundler` | `bundler-minor-patch` |
| `composer.json` | `composer` | `composer-minor-patch` |
| `pom.xml` | `maven` | `maven-minor-patch` |
| `build.gradle` or `build.gradle.kts` | `gradle` | `gradle-minor-patch` |
| a `*.csproj`, `*.fsproj`, `*.vbproj` or `*.sln`, `packages.config`, or `Directory.Packages.props` | `nuget` | `nuget-minor-patch` |
| `Dockerfile`, `Containerfile`, or a `*.dockerfile` | `docker` | `docker-minor-patch` |
| (always) | `github-actions` | `actions-minor-patch` |

The group names matter: the gate recognises a minor/patch group by them.

Before writing, show the user each file as it will be (and for a reinstall, the diff), then write them. If `.github/dependabot.yml` exists, say what it held: the new one replaces it.

## 5. Repo setup

- **Label:** `gh label create needs-human-review --color FBCA04 --description "Dependabot PR the reviewer escalated for a human"`. An existing label is fine.
- **Auto-merge:** `gh api -X PATCH repos/<NWO> -F allow_auto_merge=true`. The gate arms GitHub's auto-merge rather than merging directly.
- **Token:** when `CLAUDE_CODE_OAUTH_TOKEN` is missing from either store, hand off. Minting it needs `claude setup-token`, which opens a browser and prints the token. Give the user these lines to run in their own terminal, each of which asks for the token:

  ```sh
  claude setup-token
  gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo <NWO>
  gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo <NWO> --app dependabot
  ```

- **Push token (optional):** GitHub starts no CI for a commit a workflow pushes with its own token, so autofix's fixes wait for a person to start CI, and the PR comment says how. With a `DEP_STEWARD_PUSH_TOKEN` secret, CI starts on them by itself. It is a fine-grained token with Contents: read and write on this repo. The user creates it and sets it with `gh secret set DEP_STEWARD_PUSH_TOKEN --repo <NWO>`.
- **Branch protection:** `gh api repos/<NWO>/rules/branches/<default branch>`. If the CI workflow's checks are not required status checks, tell the user that requiring them is what stops a red build from merging by hand.

## 6. Report, and what happens once it is merged

Tell the user:

- The files are ordinary changes in their working tree. They review, commit and merge them like any other change, and the pipeline starts when they reach the default branch.
- **CI secrets for Dependabot.** Dependabot's PRs see only the Dependabot secret store. If the CI workflow reads secrets (look for `secrets.` in it), CI will fail on every Dependabot PR until they are copied there. Once the files are on the default branch, copy them without anyone handling a value:
  1. `gh api repos/<NWO>/dependabot/secrets/public-key` gives `key_id` and `key`.
  2. `gh workflow run dependabot-seal.yml --repo <NWO> -f public-key=<key>`. Wait for the run to finish (`gh run list --workflow dependabot-seal.yml`).
  3. Its log (`gh run view <id> --log`) has `DEP-STEWARD-SEALED <NAME> <value>` lines. For each NAME that `gh secret list --app dependabot` does not list, run `gh api -X PUT repos/<NWO>/dependabot/secrets/<NAME> -f encrypted_value=<value> -f key_id=<key_id>`. `DEP-STEWARD-UNSET <NAME>` means no Actions secret by that name exists.
  4. Delete the run: `gh api -X DELETE repos/<NWO>/actions/runs/<id>`.

  Offer to do this for them once the files are merged. Tell them the trade-off: a new dependency version's code can read these secrets while CI runs.
- What happens next: Dependabot opens grouped minor/patch PRs that merge on green CI with no model call, and individual major PRs that get a changelog-grounded Claude review. Anything uncertain gets the `needs-human-review` label and is assigned to the assignee.
- **Upgrades:** Dependabot proposes new dep-steward releases as a PR that changes these workflow files, and the gate always leaves that PR to a person.
- `/dep-steward:summary` reports what the pipeline has handled once it has been running.
