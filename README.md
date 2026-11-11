# dep-steward

**Claude-reviewed, injection-safe Dependabot automation for GitHub — auto-update, auto-review, and auto-merge-when-safe, installed from Claude Code.**

**[Website](https://raphaelcm.github.io/dep-steward/)** · **[Security model](SECURITY.md)** · A [Claude Code plugin](#install)

A steward is entrusted to manage something with care and judgment on your behalf. `dep-steward` does that for your dependency updates: a Claude cloud agent reviews every Dependabot PR — reading changelogs, enumerating breaking changes, and grepping *your* code for affected usage — and a **fully deterministic gate** decides the merge. The gate re-checks everything the model claims, so a prompt-injected dependency diff can never cause an unsafe merge.

This is not blind merging. `dep-steward` configures Dependabot to **auto-update** your dependencies on a schedule, **auto-reviews** every PR it opens with a Claude agent, and **auto-merges only when it's safe**: routine minor/patch bumps sail through once CI is green, while major bumps get a real, changelog-grounded review and are escalated to you the moment anything is uncertain.

## Install

dep-steward is a [Claude Code plugin](https://code.claude.com/docs/en/plugins), and this repo is its own marketplace. Add it once:

```
/plugin marketplace add raphaelcm/dep-steward
/plugin install dep-steward@dep-steward
```

Then, in the repo you want to protect:

```
/dep-steward:install
```

It checks the prerequisites, shows you each file it will write, writes them, and sets up the label, secrets and repo setting. Running it again is safe. (From a shell, the first two are `claude plugin marketplace add raphaelcm/dep-steward` and `claude plugin install dep-steward@dep-steward`.)

### What gets installed

The pipeline's code lives in this repository, and GitHub runs it as [reusable workflows](https://docs.github.com/en/actions/sharing-automations/reusing-workflows) at a commit your repo pins. Your repo gets three short workflow files that call it, plus your Dependabot config. Each file's settings are its `with:` values.

### Prerequisites

- **[GitHub CLI](https://cli.github.com) (`gh`), authenticated** with `repo` + `workflow` scopes (`gh auth login`). The install uses it to write the label, secrets, and repo setting.
- **A `CLAUDE_CODE_OAUTH_TOKEN`**: the OAuth token `anthropics/claude-code-action` uses, from a Claude Pro or Max subscription. `claude setup-token` mints one in your browser, and you store it yourself with `gh secret set`, in both secret stores (see FAQ). `/dep-steward:install` gives you the exact lines; it never handles the token. Setup-token OAuth tokens last a year; a copied keychain access token is short-lived and will expire.
- **Optional: a `DEP_STEWARD_PUSH_TOKEN` secret**, for CI to start on autofix's fixes by itself (see [CI on the fix](#ci-on-the-fix)). It's a [fine-grained token](https://github.com/settings/personal-access-tokens/new) with Contents: read and write on the repo, set with `gh secret set DEP_STEWARD_PUSH_TOKEN`.
- **A CI workflow** whose green status should gate merges. The install reads your workflows' names and asks when more than one could be it.

### Upgrades

Your repo pins dep-steward to a commit, so a new release reaches you only when you accept it. Dependabot proposes each release as a PR that changes the three workflow files, and the gate always leaves that PR to you: a pipeline never approves its own upgrade.

## How it works

`dep-steward` installs three stages that run in sequence — the Dependabot config that **auto-updates**, then a two-job pipeline that **auto-reviews** and **auto-merges only when safe**. The two jobs split along an LLM-judgment-vs-deterministic line:

```
① AUTO-UPDATE  —  Dependabot, configured by .github/dependabot.yml
      opens dependency-update PRs on a schedule; minor/patch bumps are
      grouped into one PR, majors arrive individually.
        │
        ▼
② AUTO-REVIEW  —  review job  (Claude cloud agent, never merges)
      reads the diff, classifies each bump, fetches changelogs, greps your
      code, posts ONE comment. For singleton/major PRs the comment carries
      a structured AUTOMERGE-DECISION-V1 block.
        │
        ▼
③ AUTO-MERGE-WHEN-SAFE  —  auto-merge workflow  (deterministic gate; the only thing that merges; no agent)
      re-checks, independently of the model:
        • author is Dependabot        • PR is open
        • CI is green                 • every changed path is whitelisted
        • Dependabot itself pushed the commit, and the merge is tied to it
      then:
        • minor/patch GROUP PR  → merge with zero LLM input
        • singleton / MAJOR PR  → merge only if the model's block says
          recommendation=merge AND our_usage_affected=false
        • anything else / uncertain → leave it, label needs-human-review
      it wakes when CI or the review finishes, ARMS GitHub's native
      auto-merge rather than merging on the spot, and DISARMS again if a
      later wake-up says no.
```

**Arming, not merging.** Once the gate authorizes, it turns on GitHub's own auto-merge instead of merging immediately. A synchronous merge is a race — the gate reads CI, asks GitHub to merge, and anything that changes mergeability in between becomes a refusal with no retry, because the gate only wakes when CI or the review finishes. Arming hands the timing to GitHub, which merges the moment every requirement is met. Because arming is a latch and the gate re-derives everything on every wake-up, a later refusal **disarms**: a PR whose CI goes red, or whose review posts a superseding `escalate`, cannot stay armed to merge itself. If a human armed it, dep-steward says so and leaves their decision alone. And once the gate has said yes, any failure to execute is escalated to you — labelled, assigned, commented, red — because a merge that fails silently is indistinguishable from one that never ran.

**If one merge method is refused, it takes another.** dep-steward ranks the three methods for each PR — a merge commit first for PRs touching `.github/workflows/` (a workflow edit needs a commit Dependabot authored, and a merge commit is the one that preserves it), a squash first for everything else — then **tries them in order** and stops at the first one GitHub accepts. It narrows the ranking by what your repo says it allows, reading your repository settings and your default branch's rules, including a `required_linear_history` rule that bans merge commits without appearing in any merge-method list.

Reading is not enough on its own, which is why it tries rather than predicts: whether GitHub accepts a method also depends on classic branch protection, which only repo admins can read and no Actions token ever can, and on your token's App scopes versus the PR's changed paths, which no API reports at all. A pipeline that asks, believes the answer, and gives up on the first refusal will strand a mergeable PR on a repo where the real restriction was somewhere it could not look. You are paged only when **every** ranked method has been refused — and the notice tells you what GitHub said to each one.

The whitelist + CI checks are **load-bearing**: even a maximally injection-compromised model cannot cause a merge that touches your `src/` or that breaks tests, because the gate applies those checks itself, ignoring anything the model says about them. See [SECURITY.md](SECURITY.md).

Minor/patch bumps arrive as one **grouped** Dependabot PR that is non-major *by construction* (guaranteed by the generated `.github/dependabot.yml`), so the gate can merge them with no model call at all. Only singletons and majors spend tokens on a review.

## What the install changes

Files written into your repo (review and commit them like any change):

| File | Purpose |
|---|---|
| `.github/workflows/dependabot-review.yml` | calls dep-steward's review workflow: the review, and autofix's fixer and its push |
| `.github/workflows/dependabot-automerge.yml` | calls dep-steward's auto-merge workflow: the gate, the only thing that merges, and it runs no agent |
| `.github/workflows/dependabot-seal.yml` | calls dep-steward's seal workflow, which copies CI's secrets for Dependabot; it runs only when started by hand |
| `.github/dependabot.yml` | groups minor/patch bumps; majors stay individual |

GitHub settings it configures (via `gh`):

- Creates the `needs-human-review` label.
- Checks that `CLAUDE_CODE_OAUTH_TOKEN` is in **both** the Actions secret store **and** the Dependabot secret store, and gives you the commands when it isn't (see FAQ: this is the #1 thing people get wrong).
- Once the files are merged, offers to copy the secrets your CI reads into the Dependabot secret store, so CI can pass on Dependabot's PRs at all (see FAQ). Nobody handles a value: the seal workflow seals each one for that store and the install uploads only the sealed copy.
- Enables "Allow auto-merge" on the repo.
- Checks branch protection and **advises** if CI isn't a required check (it never changes your protection rules).

It does not touch your source, your existing CI workflow, or your git history.

## Autofix (on by default)

When a dependency bump **breaks your CI** in a small, mechanical way — a renamed export, a changed signature, a moved default — a Claude agent makes the minimal fix, pushes it to the PR branch, and leaves it for **you** to review and merge. It turns "escalate, go diagnose and fix it yourself" into "here's an already-fixed PR, take a look." With a `DEP_STEWARD_PUSH_TOKEN` secret, CI starts on the fix by itself; without one, the PR says how to start it ([CI on the fix](#ci-on-the-fix)).

The fixer is also told the failing run's own timestamp and weekday rather than left to work them out, because a bump that breaks a time-dependent test is exactly where a guessed weekday turns into a confident, wrong diagnosis.

It's the one part of dep-steward that drafts changes to *your* source — always in a PR you review and merge, never on your default branch. If you'd rather no agent did that, ask `/dep-steward:install` for no autofix, or set `autofix: false` in both `dependabot-review.yml` and `dependabot-automerge.yml`.

**It never merges — you authorize every merge.** Three things keep that safe:

- **The agent's tools are allow-listed** (edit/read/`grep`/`gh`, no general shell), and nothing it writes is run: the steps after it run only copies of dep-steward's own files, taken before it started. So neither your PR's untrusted code nor the agent's output is *executed* while the job holds a writable token.
- **The fix is bounds-limited** — a handful of lines, existing source files only, never the bumped manifest/lockfile, never anything under `.github/`. A larger or out-of-scope change is discarded and escalated to you instead.
- **An autofixed PR can't be auto-merged.** Because the fix adds source changes, the gate's path whitelist refuses to auto-merge it — by construction it always waits for your review. So even a maximally prompt-injected "fix" can at most land a tiny, reviewed source edit on a PR branch, never on your default branch.

When autofix can't produce a clean, minimal fix — the evidence doesn't show the bump caused the failure, it would need real code changes or a new dependency, or it's simply not confident — it escalates to you, exactly like the review job does. Its comment names each failure's cause with the evidence for it, and calls a failure with no evidence either way unexplained. The fixer is told how often CI passed on that exact commit, so a test that "sometimes fails" is a claim it can only make with a passing run to point to.

**One attempt per PR.** If CI fails again on a PR that already carries dep-steward's fix, autofix does not try a second time: it labels, assigns and comments once, and the PR waits for you. That holds even after someone pushes on top of the fix, so autofix can never chase its own failures.

### Regenerated output

Some repos commit code a generator writes from a dependency: a Prisma client, an OpenAPI client. A bump that changes what the generator writes leaves that output stale, and a CI check that regenerates and diffs it goes red. The fix is to run the generator, which is mechanical, so no agent does it. Give `dependabot-review.yml` the command, the paths it writes, and any environment it needs (`/dep-steward:install` asks when it sees a Prisma schema):

```yaml
      regenerate-command: npm run db:generate
      regenerate-paths: src/generated/prisma
      regenerate-env: |
        DATABASE_URL=postgresql://user:pass@localhost:5432/db
```

On every Dependabot PR, two jobs in the review workflow run the install and the command on the PR head, then run the command again on a fresh runner over the result: the output must not change, which is what your CI's sync check asks of it. When CI then fails, autofix pushes that regeneration instead of running its fixer, and you review and merge it. A regeneration has no line budget, since a correct one can be thousands of lines, but it may change only the paths you declared: never anything under `.github/` or a bumped manifest or lockfile. When regenerating changes nothing, autofix runs its fixer as usual; when the output changes from one run to the next, it tells you instead of pushing.

The install and the generator are the bump's own code, so those jobs run where your CI runs on the PR: on `pull_request`, with a token that can only read and no secrets. The `regenerate-env` values are committed in the workflow file, so give placeholders, never secrets (`prisma generate` needs `DATABASE_URL` set but never connects to it).

### CI on the fix

Who pushes the fix decides whether CI runs on it: GitHub starts no workflow for a commit a workflow pushes with its own `GITHUB_TOKEN`.

- **With a `DEP_STEWARD_PUSH_TOKEN` secret** (a fine-grained token with Contents: read and write on the repo), autofix pushes the fix with it and CI starts on it by itself. You're assigned when CI finishes: by the gate when it's green (an autofixed PR always waits for you), by the one-attempt rule when it's red. The push counts as the token owner's, so the review runs again on it, as it does after any person's push.
- **Without one**, autofix pushes the fix with `GITHUB_TOKEN`, and the PR says to start CI by **closing and reopening it** (or pushing any commit to its branch).

The token is read only by the push step, used only to push to your repository, and only after the bounds check accepts a fix; the fixer never sees it. If GitHub refuses it, the fix still goes out with `GITHUB_TOKEN`, the PR says why CI didn't start, and the job goes red so you notice. Nothing merges un-tested either way. CI started by the token's push runs with your Actions secrets, just as it would after a person's push — see [SECURITY.md](SECURITY.md).

## The plugin's commands

| Command | What it does |
|---|---|
| `/dep-steward:install` | Checks the prerequisites in whatever repo you're in, shows you each file it will write, then installs. Hands you the commands for the step that needs a browser (minting the token). |
| `/dep-steward:summary` | Read-only readout: what was auto-merged, what was escalated and why, any security updates it landed, and an honest time-saved estimate. Takes a window: `/dep-steward:summary 90d`. |
| `/dep-steward:uninstall` | Removes the pipeline from a repo: the files above, the label, and the token from **both** secret stores (forgetting the second one is the usual half-uninstall). |

They act on whatever repo you're currently in, and never write to your `~/.claude/`.

The plugin is the [`plugin/`](plugin) folder: its manifest, its three skills, and the workflow files the install writes. The pipeline's code is in [`actions/`](actions) and [`.github/workflows/`](.github/workflows), which is what your repo's workflow files call.

**Without the plugin?** Copy the three files in [`plugin/templates/`](plugin/templates) into `.github/workflows/`, replace `__CI_NAME__` with your CI workflow's `name:` and `__ASSIGNEE__` with your GitHub login, and write `.github/dependabot.yml` with the entries the [install skill's table](plugin/skills/install/SKILL.md) lists. Then create the label, set the secrets, and enable auto-merge, as [What the install changes](#what-the-install-changes) lists. The summary command is a plain file you can drop into any Claude command library:

```sh
mkdir -p ~/.claude/commands
curl -fsSL https://raw.githubusercontent.com/raphaelcm/dep-steward/main/plugin/skills/summary/SKILL.md \
  > ~/.claude/commands/dep-steward-summary.md
```

## FAQ

**Why does the token need to be in two places?**
A Dependabot-triggered workflow run reads secrets from the *Dependabot* secret store, not the Actions store — the Actions store is invisible to it. If the token is only in Actions, the review job silently gets an empty token on real Dependabot PRs. `/dep-steward:install` checks both so you never hit this. (It cost us weeks before we understood it.)

**My CI needs a secret (an API key, say). Will it pass on Dependabot's PRs?**
Yes, once it's in the Dependabot secret store, and `/dep-steward:install` offers to put it there once its files are merged. GitHub runs a Dependabot PR's workflows with that store only, so a CI that reads an Actions secret fails on every Dependabot PR, and the gate, which merges only on green CI, never merges one. The seal workflow finds the secrets your CI workflow reads (and the local reusable workflows it calls), and the install copies any the Dependabot store lacks. It asks first, because a new dependency version's code can then read them while CI runs. It never overwrites a secret already in the Dependabot store.

**Must my CI workflow be named `CI`?**
No. The install reads your CI workflow's name and writes it into the workflow files (`ci-name` and the `workflows:` triggers). The gate keys off this exact name, so it does need *a* CI workflow to exist.

**Which ecosystems are supported?**
Any Dependabot ecosystem with a manifest at your repo root: **npm/yarn/pnpm, pip (incl. poetry/pipenv), uv, cargo, Go modules, Bundler, Composer, Maven, Gradle, NuGet, Docker, and GitHub Actions** (Actions is always managed). The gate derives its group-branch prefixes and safety whitelist from the files at your default branch's root, each time it runs ([`ecosystems.cjs`](actions/tools/ecosystems.cjs)), and the install writes the matching `dependabot.yml` entries from the same catalog, so a repo with, say, `Cargo.toml` + `go.mod` + a `Dockerfile` gets all three managed.

Two things worth knowing:
- **The whitelist is deliberately conservative.** Docker only auto-merges `Dockerfile`-style files, *not* arbitrary YAML — so a Dependabot bump to an image tag in a Kubernetes manifest is escalated to you rather than silently merged. Anything a routine bump touches that isn't a known manifest/lockfile → escalated, never auto-merged.
- **Manifests are detected at the repo root** (`directory: /`). Monorepo/subdirectory manifests aren't auto-detected yet — you'd add entries by hand.

Adding an ecosystem is one clause in `ecosystems.cjs` (its `package-ecosystem`, Dependabot's branch slug, and its manifest paths) and one row in the install skill's table; a test holds the two together. The branch slug is Dependabot's own — for most ecosystems it equals the config value, but three don't (`npm`→`npm_and_yarn`, `gomod`→`go_modules`, `github-actions`→`github_actions`), which is exactly the kind of thing this tool gets right for you.

**How much does it cost in tokens?**
Only singleton and major bumps trigger a model review; grouped minor/patch PRs merge with zero model calls. A major-bump review is one bounded agent run (≤60 turns).

**Can this merge something malicious?**
The gate merges only PRs whose every changed file is on the dependency/workflow whitelist and whose CI is green — both checked independently of the model. An injected diff can at most flip the model's recommendation, but it can't smuggle a source change past the whitelist or make broken tests pass. Details in [SECURITY.md](SECURITY.md).

**How will I know when a PR needs me? / What happens to an escalated PR?**
When the reviewer judges a PR unsafe or uncertain — a breaking change that affects you, a changelog it can't read, a CVE, files outside the whitelist, or plain uncertainty — dep-steward:

- **assigns you** (or whoever you set as `assignee`) to the PR, so it lands in your GitHub notifications and your "Assigned" queue — the queue you already triage, no new surface, no chat or issue spam;
- adds the **`needs-human-review`** label; and
- posts a **comment** explaining exactly why, with its structured decision block. Security advisories (CVEs) are flagged **PRIORITY** at the top.

The PR is then left open and untouched — the gate never merges an escalated PR. (If the reviewer ever fails to produce a verdict at all, its job goes **red** and still assigns + labels, so a broken review can't pass silently.)

**The gate escalates too, when its own refusal can never resolve.** Most of the time it refuses because it's *not yet* time — CI is still running, the review hasn't posted — and it stays quiet, because it will be woken again. But some refusals are permanent: the PR changes a file outside the whitelist, or the reviewer posted a verdict block that can't be parsed. Nothing about those changes without a person, so the gate would otherwise refuse the same PR forever and tell nobody. It now assigns, labels and comments once, naming the reason. That notice fires **once per PR**, not once per wake-up.

This is deliberately an allow-list of permanent reasons, so anything new stays silent by default: being paged about a PR that fixes itself is what teaches you to ignore the label, and then you miss the real one.

**Who tells you about a red build?** Exactly one job, so you're never paged twice for the same failure. With autofix on (the default) it's the autofix job — it tries a fix first, and assigns + labels + comments when it can't. With `autofix: false` nothing else is watching CI, so the gate takes that job over.

The default assignee is you (the person who ran the install). Set a different maintainer as `assignee` in both workflow files, or `assignee: ""` to assign nobody (then you triage by the label filter `is:open label:needs-human-review`).

**A review job went red / a PR got no verdict — how do I tell why?**
The review job's final step prints the agent's *actual* error, read from `claude-code-action`'s execution log (the run log otherwise shows only that it failed, never why). Open the failed run and read that step. By far the most common cause is an **invalid or expired `CLAUDE_CODE_OAUTH_TOKEN`**, which shows as `401 Invalid bearer token` — re-mint it with `claude setup-token` and store it in both secret stores again. If there is no agent error but the PR does carry a decision block from that run, the block was posted under an identity the gate ignores: the review step must give its agent the job's `GITHUB_TOKEN` (its `github_token` input). The autofix job surfaces agent errors the same way. Once the cause is fixed, review the PR again with `gh workflow run dependabot-review.yml -f pr_number=<n>`; the gate wakes when that review finishes.

**How do I stop major bumps from ever merging automatically?**
It's conservative by default: a major bump merges only if the model affirmatively recommends it *and* finds no affected usage. To make majors always wait for a human, require a human review on those PRs via branch protection. (The reviewer's instructions ship with each dep-steward release, so they are the same in every repo.)

**How do I uninstall?**
Delete the files above, remove the `needs-human-review` label, and delete the `CLAUDE_CODE_OAUTH_TOKEN` secret from both stores and `DEP_STEWARD_PUSH_TOKEN` if you set it, plus any CI secrets the install copied into the Dependabot store. No other footprint. `/dep-steward:uninstall` walks it for you, including the second secret store people forget.

## Development

Zero runtime dependencies. The gate and its helpers are vanilla Node in [`actions/tools/`](actions/tools); the pipeline is the reusable workflows in [`.github/workflows/`](.github/workflows); the tests use the Node built-in test runner.

```sh
node --test test/*.test.mjs
```

The tests run the shipped files themselves, through a step simulator (`test/lib/actions-sim.mjs`) that runs each `run:` block with bash and stubs only GitHub and the agents:

- `test/gate.test.mjs`: the gate's decision logic, including that a change to dep-steward's own workflow files is always left to a person.
- `test/ecosystems.test.mjs`: the install skill's `dependabot.yml` table and the gate's ecosystems agree.
- `test/workflows.test.mjs`: the structure of the reusable workflows and the caller files: hook wiring, token scopes, wake-ups, arming and disarming, escalation, and that each caller passes only inputs its workflow declares.
- `test/workflow-shell.test.mjs`: every `run:` block parses under `bash -n`.
- `test/autofix-push.test.mjs` and `test/regenerate.test.mjs`: the autofix and regeneration jobs end to end (only the agent is simulated), pushing through real `git` to a local server that records who pushed.
- `test/autofix-bounds.test.mjs`, `test/review-lint.test.mjs`: the bounds check and the reviewer's prose guard, in each of their modes.
- `test/agent-writes.test.mjs`, `test/review-diagnose.test.mjs`, `test/prompt-hygiene.test.mjs`, `test/gate-wake.test.mjs`: the review job against a reviewer that rewrites what it can reach, a denied diff, prompt leaks, and which runs wake the gate.
- `test/permissions.test.mjs`: no job that runs an agent can push, merge, or mint a token that could; each caller grants at least what its workflow's jobs need.
- `test/ci-secrets.test.mjs`: the seal workflow seals exactly the secrets CI reads, with the Dependabot store's key.
- `test/actionlint.test.mjs`: the reusable workflows and the installed caller files pass actionlint (required in this repo's CI).
- `test/plugin.test.mjs`, `test/plugin-policy.test.mjs`: the manifests agree, and every file in `plugin/` is a type Anthropic's plugin directory accepts (Markdown, text, JSON, YAML, images; nothing that starts with `#!`).
- `test/release-pin.test.mjs`: the pinned commits run the code in this tree.
- `test/actions-sim.test.mjs`: the GitHub rules the simulator copies.

### Releasing

A pinned workflow must run the code it was released with, and a called workflow cannot learn its own commit, so every dep-steward ref is a full SHA that [`scripts/pin.mjs`](scripts/pin.mjs) writes:

```sh
node scripts/pin.mjs tools            # the reusable workflows use actions/tools at HEAD
git commit -am "Pin the tools"        # the release commit: tag vX.Y.Z here
node scripts/pin.mjs callers vX.Y.Z   # the caller templates pin that commit; plugin.json version
git commit -am "Pin the callers"
```

Merge the release PR with a merge commit, not a squash, so every pinned commit stays on `main`.

Working on the plugin locally:

```sh
claude --plugin-dir .      # load it without installing
claude plugin validate .   # check both manifests
```

## License

[MIT](LICENSE).
