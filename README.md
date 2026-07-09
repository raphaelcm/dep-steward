# dep-steward

**Claude-reviewed, injection-safe Dependabot automation for GitHub — auto-update, auto-review, and auto-merge-when-safe, installed in one line.**

A steward is entrusted to manage something with care and judgment on your behalf. `dep-steward` does that for your dependency updates: a Claude cloud agent reviews every Dependabot PR — reading changelogs, enumerating breaking changes, and grepping *your* code for affected usage — and a **fully deterministic gate** decides the merge. The gate re-checks everything the model claims, so a prompt-injected dependency diff can never cause an unsafe merge.

This is not blind merging. `dep-steward` configures Dependabot to **auto-update** your dependencies on a schedule, **auto-reviews** every PR it opens with a Claude agent, and **auto-merges only when it's safe**: routine minor/patch bumps sail through once CI is green, while major bumps get a real, changelog-grounded review and are escalated to you the moment anything is uncertain.

## Install

Run this in the repo you want to protect:

```sh
sh -c "$(curl -fsSL https://raw.githubusercontent.com/raphaelcm/dep-steward/main/install.sh)"
```

It inspects your repo, shows what it will change, and does it. Re-running is safe (every step is idempotent). Preview without touching anything:

```sh
sh -c "$(curl -fsSL https://raw.githubusercontent.com/raphaelcm/dep-steward/main/install.sh)" -- --dry-run
```

### Prerequisites

- **[GitHub CLI](https://cli.github.com) (`gh`), authenticated** with `repo` + `workflow` scopes (`gh auth login`). The installer uses it to write the label, secrets, and repo settings.
- **A `CLAUDE_CODE_OAUTH_TOKEN`** — the OAuth token `anthropics/claude-code-action` uses, from a Claude Pro/Max subscription. If [Claude Code](https://claude.com/claude-code) is installed, the installer offers to mint one for you inline via `claude setup-token` and reads it from the prompt — no separate step; otherwise `export CLAUDE_CODE_OAUTH_TOKEN=…` beforehand. Minting is browser-interactive by design, so expect one paste — it can't be captured unattended.
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
```

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

GitHub settings it configures (via `gh`):

- Creates the `needs-human-review` label.
- Sets `CLAUDE_CODE_OAUTH_TOKEN` in **both** the Actions secret store **and** the Dependabot secret store (see FAQ — this is the #1 thing people get wrong).
- Enables "Allow auto-merge" on the repo.
- Checks branch protection and **advises** if CI isn't a required check (it never changes your protection rules).

It does not touch your source, your existing CI workflow, or your git history.

## Seeing what it's done: `/dep-steward-summary`

`/dep-steward-summary` is a Claude Code command that gives a read-only readout: what dep-steward auto-merged, what it escalated and why, any security updates it landed, and an honest time-saved estimate (counts exact; per-PR minutes an assumption you can adjust). Pass a window if you like: `/dep-steward-summary 90d`.

It's a **personal, install-once** tool — it summarizes whatever repo you're in, so it belongs in *your* Claude command library, not in any one repo. The per-repo installer deliberately does **not** write to your `~/.claude/` (a repo-setup tool has no business editing your personal config). Install it yourself, once:

```sh
mkdir -p ~/.claude/commands
curl -fsSL https://raw.githubusercontent.com/raphaelcm/dep-steward/main/templates/dep-steward-summary.md \
  > ~/.claude/commands/dep-steward-summary.md
```

Now it's in your `/` menu everywhere — Claude Desktop and the CLI both read that library. (Prefer a repo-shared copy for your team instead? Drop the same file at `.claude/commands/dep-steward-summary.md` in the repo; it'll show in the `/` menu for anyone working in that repo.) It's pull, not push — no standing noise.

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

Default assignee is you (the person who ran the installer). Set a different maintainer with `--assignee HANDLE`, or pass `--assignee ""` to disable assignment (then you triage by the label filter `is:open label:needs-human-review`).

**How do I stop major bumps from ever merging automatically?**
It's conservative by default: a major bump merges only if the model affirmatively recommends it *and* finds no affected usage. To make majors always wait for a human, tell the reviewer to always escalate majors (edit `.github/dependabot-review-prompt.md`), or require human review on those PRs via branch protection.

**How do I uninstall?**
Delete the four files above, remove the `needs-human-review` label, and delete the `CLAUDE_CODE_OAUTH_TOKEN` secret from both stores. No other footprint.

## Development

Zero runtime dependencies. The gate is one vanilla-Node file; the installer is POSIX `sh`; the tests use the Node built-in test runner.

```sh
shellcheck -s sh install.sh
node --test test/*.test.mjs
```

- `test/gate.test.mjs` — the gate's decision logic (rendered fresh from the templates, so it tests what actually ships).
- `test/render.test.mjs` — render parity: the installer reproduces a known-good reference pipeline byte-for-byte.
- `test/wiring.test.mjs` — the installer sets both secret stores, creates the label, and enables auto-merge (stubbed `gh`).

## License

[MIT](LICENSE).
