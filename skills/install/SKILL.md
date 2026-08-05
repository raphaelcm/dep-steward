---
description: Install the dep-steward Dependabot pipeline into the current repository — preflight the prerequisites, show what will change, then run the installer.
argument-hint: "[extra installer flags — e.g. --no-autofix, --ci-name \"Build\", --assignee HANDLE]"
---

Set up **dep-steward** in the repository the user is working in: Dependabot auto-updates the dependencies, a Claude agent auto-reviews each PR it opens, and a deterministic gate auto-merges only when it is safe.

The installer is `install.sh` from `raphaelcm/dep-steward`. It is idempotent, so re-running it is safe. Everything below runs it non-interactively (its interactive prompts are all TTY-guarded, so it never hangs when a tool runs it — it either uses a flag you passed or stops with a clear message).

Pass `$ARGUMENTS` through to the installer if the user gave any.

## 1. Preflight — check, report, don't guess

Run these and tell the user what you found. Each failure has a specific fix, so name the fix rather than a generic error.

- **In a GitHub repo:** `gh repo view --json nameWithOwner,defaultBranchRef` — if this fails, the user is not in a GitHub repo or `gh` cannot see it.
- **`gh` authenticated with the right scopes:** `gh auth status`. It needs `repo` and `workflow`. Missing scopes are fixed with `gh auth refresh -h github.com -s repo,workflow`.
- **A CI workflow exists:** `gh workflow list --json name,state`. The gate keys off one workflow's exact name and cannot fire without it. If there are several and none is obviously "the" CI, ask the user which one gates merges, then pass `--ci-name "<name>"`.
- **The token secret:** `gh secret list --repo <NWO>` and `gh secret list --repo <NWO> --app dependabot`. `CLAUDE_CODE_OAUTH_TOKEN` must be in **both** stores. A Dependabot-triggered run reads only the Dependabot store, so a token that is only in Actions leaves the review job with an empty token on exactly the PRs it exists to review.
- **The Claude Code GitHub App:** there is no API that reports this reliably. Treat it as required and tell the user to confirm it at <https://github.com/apps/claude> → Configure → add this repo. Without it, every review and autofix run fails with "Claude Code is not installed on this repository".

## 2. Show what will change, before changing it

```sh
sh -c "$(curl -fsSL https://raw.githubusercontent.com/raphaelcm/dep-steward/main/install.sh)" -- --dry-run
```

Add `--ci-name "<name>"` when you determined it in preflight, plus anything from `$ARGUMENTS`. Summarize the output for the user: the four files it writes into `.github/`, the label it creates, the secrets it sets, and the repo settings it touches. It never touches their source, their existing CI workflow, branch-protection rules, or git history.

## 3. Install

Run the same command without `--dry-run` when both of these hold:

- `CLAUDE_CODE_OAUTH_TOKEN` is already set in the environment, **or** already present in both secret stores; and
- the user has confirmed the Claude Code GitHub App has access to the repo.

Otherwise **stop and hand off**, because the two missing pieces are browser-interactive and cannot be completed by a tool:

- Minting a token needs `claude setup-token`, which opens a browser and prints a token to paste.
- Installing the GitHub App needs the user to grant access on github.com.

Give the user the exact line to run in their own terminal, and say plainly which step needs them:

```sh
sh -c "$(curl -fsSL https://raw.githubusercontent.com/raphaelcm/dep-steward/main/install.sh)"
```

Run interactively, the installer mints the token for them, verifies it authenticates before storing it, and opens the App page.

## 4. Report

Tell the user what landed and what is left:

- The files now in `.github/` are ordinary changes in their working tree — they review and commit them like any other change.
- Anything the installer warned about (auto-merge not enabled, CI not a required status check, a secret it could not set) with the one command that fixes each.
- What happens next: Dependabot opens grouped minor/patch PRs that merge on CI-green with no model call, and individual major PRs that get a changelog-grounded Claude review. Anything uncertain is escalated with the `needs-human-review` label and assigned to them.
- `/dep-steward:summary` reports what the pipeline has handled once it has been running.
