# dep-steward

**Claude-reviewed, injection-safe Dependabot automation for GitHub — auto-review, auto-update, and auto-merge-when-safe, installed in one line.**

A steward is entrusted to manage something with care and judgment on your behalf. `dep-steward` does that for your dependency updates: a Claude cloud agent reviews every Dependabot PR — reading changelogs, enumerating breaking changes, and grepping *your* code for affected usage — and a **fully deterministic gate** decides the merge. The gate re-checks everything the model claims, so a prompt-injected dependency diff can never cause an unsafe merge.

This is not blind merging. It **auto-reviews** every Dependabot PR, **auto-updates** what's provably safe, and **merges only when safe**: routine minor/patch bumps sail through once CI is green, while major bumps get a real, changelog-grounded review and are escalated to you the moment anything is uncertain.

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
- **A `CLAUDE_CODE_OAUTH_TOKEN`** — a [Claude Code](https://claude.com/claude-code) OAuth token (Pro/Max subscription or Console billing). Generate one with `claude setup-token`. Export it before installing (`export CLAUDE_CODE_OAUTH_TOKEN=…`) or the installer will prompt.
- **A CI workflow** whose green status should gate merges. The installer detects it or asks; pass `--ci-name "<name>"` to be explicit.

## How it works

Two decoupled paths, split along an LLM-judgment-vs-deterministic line:

```
Dependabot opens a PR
        │
        ├─►  review job  (Claude cloud agent, never merges)
        │        reads the diff, classifies each bump, fetches changelogs,
        │        greps your code, posts ONE comment. For singleton/major PRs
        │        the comment carries a structured AUTOMERGE-DECISION-V1 block.
        │
        └─►  auto-merge job  (deterministic gate — the only thing that merges)
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

## FAQ

**Why does the token need to be in two places?**
A Dependabot-triggered workflow run reads secrets from the *Dependabot* secret store, not the Actions store — the Actions store is invisible to it. If the token is only in Actions, the review job silently gets an empty token on real Dependabot PRs. The installer sets both so you never hit this. (It cost us weeks before we understood it.)

**Must my CI workflow be named `CI`?**
No. The installer detects your CI workflow's name and templates it into the pipeline. Pass `--ci-name "<name>"` to override. The gate keys off this exact name, so it does need *a* CI workflow to exist.

**Which ecosystems are supported?**
v1 fully supports the **JavaScript family (npm / pnpm / yarn) + GitHub Actions** — it detects your lockfile and tailors the safety whitelist accordingly. Other ecosystems (pip, cargo, go, …) are a data-only addition; the whitelist and grouping live in one place and the structure is documented for contributions.

**How much does it cost in tokens?**
Only singleton and major bumps trigger a model review; grouped minor/patch PRs merge with zero model calls. A major-bump review is one bounded agent run (≤60 turns).

**Can this merge something malicious?**
The gate merges only PRs whose every changed file is on the dependency/workflow whitelist and whose CI is green — both checked independently of the model. An injected diff can at most flip the model's recommendation, but it can't smuggle a source change past the whitelist or make broken tests pass. Details in [SECURITY.md](SECURITY.md).

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
