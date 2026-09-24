# dep-steward

**Claude-reviewed, injection-safe Dependabot automation for GitHub — auto-update, auto-review, and auto-merge-when-safe, installed in one line.**

**[Website](https://raphaelcm.github.io/dep-steward/)** · **[Security model](SECURITY.md)** · Available as a [Claude Code plugin](#claude-code-plugin)

A steward is entrusted to manage something with care and judgment on your behalf. `dep-steward` does that for your dependency updates: a Claude cloud agent reviews every Dependabot PR — reading changelogs, enumerating breaking changes, and grepping *your* code for affected usage — and a **fully deterministic gate** decides the merge. The gate re-checks everything the model claims, so a prompt-injected dependency diff can never cause an unsafe merge.

This is not blind merging. `dep-steward` configures Dependabot to **auto-update** your dependencies on a schedule, **auto-reviews** every PR it opens with a Claude agent, and **auto-merges only when it's safe**: routine minor/patch bumps sail through once CI is green, while major bumps get a real, changelog-grounded review and are escalated to you the moment anything is uncertain.

## Install

Run this in the repo you want to protect:

```sh
sh -c "$(curl -fsSL https://raw.githubusercontent.com/raphaelcm/dep-steward/main/install.sh)"
```

It inspects your repo, shows what it will change, and does it. Re-running is safe (every step is idempotent), and it is how you upgrade. A re-run keeps the `anthropics/claude-code-action` version your repo's Dependabot has already moved to whenever that is newer than the one dep-steward ships, so an upgrade never downgrades the action; every run says which pin it kept. Preview without touching anything:

```sh
sh -c "$(curl -fsSL https://raw.githubusercontent.com/raphaelcm/dep-steward/main/install.sh)" -- --dry-run
```

### Prerequisites

- **The [Claude Code GitHub App](https://github.com/apps/claude) installed on your repo** (open it → Configure → add the repo). `anthropics/claude-code-action` can't act on GitHub without it — the token below is necessary but *not sufficient*, and without the App every review/autofix run fails with "Claude Code is not installed on this repository". The installer opens the page and waits; there's no API to install or verify it for you.
- **[GitHub CLI](https://cli.github.com) (`gh`), authenticated** with `repo` + `workflow` scopes (`gh auth login`). The installer uses it to write the label, secrets, and repo settings.
- **A `CLAUDE_CODE_OAUTH_TOKEN`** — the OAuth token `anthropics/claude-code-action` uses, from a Claude Pro/Max subscription. If [Claude Code](https://claude.com/claude-code) is installed, the installer offers to mint one for you inline via `claude setup-token` and reads it from the prompt — no separate step; otherwise `export CLAUDE_CODE_OAUTH_TOKEN=…` beforehand. Minting is browser-interactive by design, so expect one paste — it can't be captured unattended. The installer then **verifies the token authenticates before storing it** (a quick `claude -p` probe), so a wrong or expired token fails at install with a clear message rather than silently breaking the pipeline in CI later. Setup-token OAuth tokens are long-lived (a year); a copied keychain access token is short-lived and will expire.
- **A CI workflow** whose green status should gate merges. The installer detects it or asks; pass `--ci-name "<name>"` to be explicit.

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
③ AUTO-MERGE-WHEN-SAFE  —  auto-merge job  (deterministic gate; the only thing that merges)
      re-checks, independently of the model:
        • author is Dependabot        • PR is open
        • CI is green                 • every changed path is whitelisted
      then:
        • minor/patch GROUP PR  → merge with zero LLM input
        • singleton / MAJOR PR  → merge only if the model's block says
          recommendation=merge AND our_usage_affected=false
        • anything else / uncertain → leave it, label needs-human-review
      it ARMS GitHub's native auto-merge rather than merging on the spot,
      and DISARMS again if a later wake-up says no.
```

**Arming, not merging.** Once the gate authorizes, it turns on GitHub's own auto-merge instead of merging immediately. A synchronous merge is a race — the gate reads CI, asks GitHub to merge, and anything that changes mergeability in between becomes a refusal with no retry, because the job only wakes on a new commit or a new comment. Arming hands the timing to GitHub, which merges the moment every requirement is met. Because arming is a latch and the gate re-derives everything on every wake-up, a later refusal **disarms**: a PR whose CI goes red, or whose review posts a superseding `escalate`, cannot stay armed to merge itself. If a human armed it, dep-steward says so and leaves their decision alone. And once the gate has said yes, any failure to execute is escalated to you — labelled, assigned, commented, red — because a merge that fails silently is indistinguishable from one that never ran.

**If one merge method is refused, it takes another.** dep-steward ranks the three methods for each PR — a merge commit first for PRs touching `.github/workflows/` (a workflow edit needs a commit Dependabot authored, and a merge commit is the one that preserves it), a squash first for everything else — then **tries them in order** and stops at the first one GitHub accepts. It narrows the ranking by what your repo says it allows, reading your repository settings and your default branch's rules, including a `required_linear_history` rule that bans merge commits without appearing in any merge-method list.

Reading is not enough on its own, which is why it tries rather than predicts: whether GitHub accepts a method also depends on classic branch protection, which only repo admins can read and no Actions token ever can, and on your token's App scopes versus the PR's changed paths, which no API reports at all. A pipeline that asks, believes the answer, and gives up on the first refusal will strand a mergeable PR on a repo where the real restriction was somewhere it could not look. You are paged only when **every** ranked method has been refused — and the notice tells you what GitHub said to each one.

The whitelist + CI checks are **load-bearing**: even a maximally injection-compromised model cannot cause a merge that touches your `src/` or that breaks tests, because the gate applies those checks itself, ignoring anything the model says about them. See [SECURITY.md](SECURITY.md).

Minor/patch bumps arrive as one **grouped** Dependabot PR that is non-major *by construction* (guaranteed by the generated `.github/dependabot.yml`), so the gate can merge them with no model call at all. Only singletons and majors spend tokens on a review.

## What the installer changes

Files written into your repo (review and commit them like any change):

| File | Purpose |
|---|---|
| `.github/workflows/dependabot-review.yml` | the two-job pipeline |
| `.github/dependabot-review-prompt.md` | the reviewer's instructions |
| `.github/dependabot.yml` | groups minor/patch bumps; majors stay individual |
| `.github/dependabot-automerge/gate.cjs` | the deterministic gate (vanilla Node, zero deps) |
| `.github/dependabot-automerge/review-lint.cjs` | checks the reviewer's comment against its evidence before it posts |
| `.github/dependabot-autofix-prompt.md` | the fixer's instructions (autofix only) |
| `.github/dependabot-automerge/autofix-bounds.cjs` | the fixer's scope limiter (autofix only) |

GitHub settings it configures (via `gh`):

- Creates the `needs-human-review` label.
- Sets `CLAUDE_CODE_OAUTH_TOKEN` in **both** the Actions secret store **and** the Dependabot secret store (see FAQ — this is the #1 thing people get wrong).
- Enables "Allow auto-merge" on the repo.
- Checks branch protection and **advises** if CI isn't a required check (it never changes your protection rules).

It does not touch your source, your existing CI workflow, or your git history.

## Autofix (on by default)

When a dependency bump **breaks your CI** in a small, mechanical way — a renamed export, a changed signature, a moved default — a Claude agent makes the minimal fix, pushes it to the PR branch, and leaves it for **you** to review and merge. It turns "escalate, go diagnose and fix it yourself" into "here's an already-fixed PR, take a look." It needs **nothing beyond the install**: the fix is pushed as the Claude Code GitHub App you already installed, so CI runs on it by itself ([CI on the fix](#ci-on-the-fix)).

The fixer is also told the failing run's own timestamp and weekday rather than left to work them out, because a bump that breaks a time-dependent test is exactly where a guessed weekday turns into a confident, wrong diagnosis.

It's the one part of dep-steward that drafts changes to *your* source — always in a PR you review and merge, never on your default branch. If you'd rather no agent did that, turn it off at install:

```
sh -c "$(curl -fsSL https://raw.githubusercontent.com/raphaelcm/dep-steward/main/install.sh)" -- --no-autofix
```

**It never merges — you authorize every merge.** Three things keep that safe:

- **The agent's tools are allow-listed** (edit/read/`grep`/`gh`, no general shell), and nothing it writes is run: the steps after it run only copies of dep-steward's own files, taken before it started. So neither your PR's untrusted code nor the agent's output is *executed* while the job holds a writable token.
- **The fix is bounds-limited** — a handful of lines, existing source files only, never the bumped manifest/lockfile, never anything under `.github/`. A larger or out-of-scope change is discarded and escalated to you instead.
- **An autofixed PR can't be auto-merged.** Because the fix adds source changes, the gate's path whitelist refuses to auto-merge it — by construction it always waits for your review. So even a maximally prompt-injected "fix" can at most land a tiny, reviewed source edit on a PR branch, never on your default branch.

When autofix can't produce a clean, minimal fix — the break isn't clearly the bump's fault, it would need real code changes or a new dependency, or it's simply not confident — it escalates to you, exactly like the review job does.

**One attempt per PR.** If CI fails again on a PR that already carries dep-steward's fix, autofix does not try a second time: it labels, assigns and comments once, and the PR waits for you. That holds even after someone pushes on top of the fix, so autofix can never chase its own failures.

### CI on the fix

Who pushes the fix decides whether CI runs on it: GitHub starts no workflow for a commit a workflow pushes with its own `GITHUB_TOKEN`. So autofix pushes the fix **as the Claude Code GitHub App** — the one you installed for dep-steward anyway — and CI starts on it by itself. You're assigned when CI finishes: by the gate when it's green (an autofixed PR always waits for you), by the one-attempt rule when it's red.

The App token comes from the same exchange `claude-code-action` uses for every review: the job's OIDC identity traded at Anthropic's endpoint for an installation token on this repository. It is asked for only after the bounds check accepts a fix, scoped to `contents: write`, used for that one push, and revoked right after; the fixer never sees it.

If that token can't be had or the push is refused, the fix still goes out with `GITHUB_TOKEN`, the PR says to start CI by **closing and reopening it** (or pushing any commit to its branch) and why, and the job goes red so you notice. Nothing merges un-tested either way. Because CI on the fix is started by an App rather than by Dependabot, it runs with your Actions secrets, just as it would after a person's push — see [SECURITY.md](SECURITY.md).

## Claude Code plugin

This repo is also a [Claude Code plugin](https://code.claude.com/docs/en/plugins) **and its own marketplace**, so it installs in two commands, from here, with no third-party listing in the way:

```
/plugin marketplace add raphaelcm/dep-steward
/plugin install dep-steward@dep-steward
```

Its three commands — `/dep-steward:install`, `/dep-steward:summary`, `/dep-steward:uninstall` — then follow you into every repo you work in. (From a shell, the same two as `claude plugin marketplace add raphaelcm/dep-steward` and `claude plugin install dep-steward@dep-steward`.)

A listing in [Anthropic's community marketplace](https://github.com/anthropics/claude-plugins-community) is submitted and pending review. That would add a second install path — `@claude-community` — rather than replace this one, so nothing here depends on it.

| Command | What it does |
|---|---|
| `/dep-steward:install` | Preflights the prerequisites in whatever repo you're in, shows you the `--dry-run` plan, then installs. Hands off cleanly for the two steps that need a browser (minting the token, granting the GitHub App). |
| `/dep-steward:summary` | Read-only readout: what was auto-merged, what was escalated and why, any security updates it landed, and an honest time-saved estimate. Takes a window: `/dep-steward:summary 90d`. |
| `/dep-steward:uninstall` | Removes the pipeline from a repo — the files above, the label, and the token from **both** secret stores (forgetting the second one is the usual half-uninstall). |

These are **personal, install-once** tools: they act on whatever repo you're currently in. The per-repo installer deliberately does **not** write to your `~/.claude/` — a repo-setup tool has no business editing your personal config.

**Without the plugin?** The summary command is a plain file you can drop into any Claude command library:

```sh
mkdir -p ~/.claude/commands
curl -fsSL https://raw.githubusercontent.com/raphaelcm/dep-steward/main/skills/summary/SKILL.md \
  > ~/.claude/commands/dep-steward-summary.md
```

That puts `/dep-steward-summary` in your `/` menu everywhere. (Prefer a repo-shared copy for your team? Drop the same file at `.claude/commands/dep-steward-summary.md` in the repo; it'll show for anyone working there.) It's pull, not push — no standing noise.

## FAQ

**Why does the token need to be in two places?**
A Dependabot-triggered workflow run reads secrets from the *Dependabot* secret store, not the Actions store — the Actions store is invisible to it. If the token is only in Actions, the review job silently gets an empty token on real Dependabot PRs. The installer sets both so you never hit this. (It cost us weeks before we understood it.)

**Must my CI workflow be named `CI`?**
No. The installer detects your CI workflow's name and templates it into the pipeline. Pass `--ci-name "<name>"` to override. The gate keys off this exact name, so it does need *a* CI workflow to exist.

**Which ecosystems are supported?**
Any Dependabot ecosystem the installer detects at your repo root: **npm/yarn/pnpm, pip (incl. poetry/pipenv), uv, cargo, Go modules, Bundler, Composer, Maven, Gradle, NuGet, Docker, and GitHub Actions** (Actions is always managed). The installer detects which manifests you have and generates the matching `dependabot.yml` entries, group-branch prefixes, and safety whitelist from one catalog (`detect_ecosystems` in `install.sh`) — so a repo with, say, `Cargo.toml` + `go.mod` + a `Dockerfile` gets all three managed.

Two things worth knowing:
- **The whitelist is deliberately conservative.** Docker only auto-merges `Dockerfile`-style files, *not* arbitrary YAML — so a Dependabot bump to an image tag in a Kubernetes manifest is escalated to you rather than silently merged. Anything a routine bump touches that isn't a known manifest/lockfile → escalated, never auto-merged.
- **Manifests are detected at the repo root** (`directory: /`). Monorepo/subdirectory manifests aren't auto-detected yet — you'd add entries by hand.

Adding an ecosystem is genuinely a small change: one clause in `detect_ecosystems` (its `package-ecosystem`, Dependabot's branch slug, and its manifest paths). The branch slug is Dependabot's own — for most ecosystems it equals the config value, but three don't (`npm`→`npm_and_yarn`, `gomod`→`go_modules`, `github-actions`→`github_actions`), which is exactly the kind of thing this tool gets right for you.

**How much does it cost in tokens?**
Only singleton and major bumps trigger a model review; grouped minor/patch PRs merge with zero model calls. A major-bump review is one bounded agent run (≤60 turns).

**Can this merge something malicious?**
The gate merges only PRs whose every changed file is on the dependency/workflow whitelist and whose CI is green — both checked independently of the model. An injected diff can at most flip the model's recommendation, but it can't smuggle a source change past the whitelist or make broken tests pass. Details in [SECURITY.md](SECURITY.md).

**How will I know when a PR needs me? / What happens to an escalated PR?**
When the reviewer judges a PR unsafe or uncertain — a breaking change that affects you, a changelog it can't read, a CVE, files outside the whitelist, or plain uncertainty — dep-steward:

- **assigns you** (or whoever you set with `--assignee`) to the PR, so it lands in your GitHub notifications and your "Assigned" queue — the queue you already triage, no new surface, no chat or issue spam;
- adds the **`needs-human-review`** label; and
- posts a **comment** explaining exactly why, with its structured decision block. Security advisories (CVEs) are flagged **PRIORITY** at the top.

The PR is then left open and untouched — the gate never merges an escalated PR. (If the reviewer ever fails to produce a verdict at all, its job goes **red** and still assigns + labels, so a broken review can't pass silently.)

**The gate escalates too, when its own refusal can never resolve.** Most of the time it refuses because it's *not yet* time — CI is still running, the review hasn't posted — and it stays quiet, because it will be woken again. But some refusals are permanent: the PR changes a file outside the whitelist, or the reviewer posted a verdict block that can't be parsed. Nothing about those changes without a person, so the gate would otherwise refuse the same PR forever and tell nobody. It now assigns, labels and comments once, naming the reason. That notice fires **once per PR**, not once per wake-up.

This is deliberately an allow-list of permanent reasons, so anything new stays silent by default: being paged about a PR that fixes itself is what teaches you to ignore the label, and then you miss the real one.

**Who tells you about a red build?** Exactly one job, so you're never paged twice for the same failure. With autofix on (the default) it's the autofix job — it tries a fix first, and assigns + labels + comments when it can't. With `--no-autofix` nothing else is watching CI, so the gate takes that job over.

Default assignee is you (the person who ran the installer). Set a different maintainer with `--assignee HANDLE`, or pass `--assignee ""` to disable assignment (then you triage by the label filter `is:open label:needs-human-review`).

**A review job went red / a PR got no verdict — how do I tell why?**
The review job's final step prints the agent's *actual* error, read from `claude-code-action`'s execution log (the run log otherwise shows only that it failed, never why). Open the failed run and read that step. By far the most common cause is an **invalid or expired `CLAUDE_CODE_OAUTH_TOKEN`**, which shows as `401 Invalid bearer token` — re-mint it with `claude setup-token` and re-run the installer (which now verifies the token before storing it, so this fails at install instead). The next most common cause is the Claude Code GitHub App not being installed on the repo. The autofix job surfaces the same error the same way.

**How do I stop major bumps from ever merging automatically?**
It's conservative by default: a major bump merges only if the model affirmatively recommends it *and* finds no affected usage. To make majors always wait for a human, tell the reviewer to always escalate majors (edit `.github/dependabot-review-prompt.md`), or require human review on those PRs via branch protection.

**How do I uninstall?**
Delete the files above, remove the `needs-human-review` label, and delete the `CLAUDE_CODE_OAUTH_TOKEN` secret from both stores . No other footprint. `/dep-steward:uninstall` walks it for you, including the second secret store people forget.

## Development

Zero runtime dependencies. The gate is one vanilla-Node file; the installer is POSIX `sh`; the tests use the Node built-in test runner.

```sh
shellcheck -s sh install.sh
node --test test/*.test.mjs
```

- `test/gate.test.mjs` — the gate's decision logic (rendered fresh from the templates, so it tests what actually ships).
- `test/render.test.mjs` — render parity: the installer reproduces a known-good reference pipeline byte-for-byte.
- `test/wiring.test.mjs` — the installer stores the verified token itself in both secret stores (the value, not just the command), creates the label, and enables auto-merge (stubbed `gh`).
- `test/workflow-shell.test.mjs` — every `run:` block in the rendered workflow parses under `bash -n` (the shell GitHub actually runs `run:` blocks with). Nothing else parses the shell the templates generate.
- `test/autofix-push.test.mjs` — runs the rendered autofix job end to end (only the agent is simulated), pushing through real `git` to a local `git http-backend` that records who pushed: the fix lands as the Claude GitHub App, though the working tree still holds `GITHUB_TOKEN` where checkout and claude-code-action leave it, and falls back loudly when it cannot; the App token exists only for a fix that will be pushed, scoped to `contents: write`; a PR gets one autofix push; the review job starts only for pushers its action accepts.
- `test/actionlint.test.mjs` — the rendered workflow passes actionlint, which adopters' CI runs on it (skipped where actionlint is not installed; required in this repo's CI).
- `test/agent-writes.test.mjs` — runs the rendered review job with a reviewer that rewrites every pipeline script it can reach: none of the rewrites runs, and the real lint and gate still do their jobs (the autofix bounds check has the same test in `autofix-push.test.mjs`).
- `test/actions-sim.test.mjs` — the GitHub rules the step simulator (`test/lib/actions-sim.mjs`) copies: implicit `success()`, `continue-on-error`, unset outputs, case-insensitive comparison, loud refusal of anything it does not simulate.
- `test/permissions.test.mjs` — each agent job grants every GitHub scope the commands in its own prompt need, and an agent left on the Claude App token (no `github_token` passthrough) allow-lists nothing that could reach — even via a flag on a wildcard entry — a scope that token lacks, nor any `gh` command its prompt never orders. Derived from the rendered workflow and prompt rather than hardcoded.
- `test/plugin.test.mjs` — the plugin and marketplace manifests parse and agree, every skill carries a description, and the README's raw-file links resolve on disk.
- `test/action-pin.test.mjs` — a reinstall keeps the repo's own `claude-code-action` pin when it is newer than the template's, takes the template's when it is older, keeps the repo's and warns when the versions cannot be compared, and renders a fresh install byte-for-byte as before.
- `test/review-lint.test.mjs` — the reviewer's prose guard, in both of its modes: it refuses the comment that actually leaked and passes verbatim changelog text that merely mentions CI, and as a hook it blocks only the comment post and never blocks on its own failure.
- `test/prompt-hygiene.test.mjs` — the rendered review prompt never raises CI as something to consider, with a self-check that its patterns still catch what leaked (so it cannot go quietly vacuous).

Working on the plugin locally:

```sh
claude --plugin-dir .      # load it without installing
claude plugin validate .   # check both manifests
```

## License

[MIT](LICENSE).
