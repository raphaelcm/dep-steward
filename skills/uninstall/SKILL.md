---
description: Remove the dep-steward pipeline from the current repository — delete its files, label, and secrets, leaving no footprint.
---

Remove **dep-steward** from the repository the user is working in. Its whole footprint is four files, one label, and one secret stored in two places. Nothing else was ever touched, so nothing else needs undoing.

The half-uninstall to avoid is leaving the token behind: `CLAUDE_CODE_OAUTH_TOKEN` lives in the Actions store **and** the Dependabot store, and deleting one leaves a live credential in the other.

## 1. Find what is actually installed

Report what exists before removing anything — the repo may have only some of it, or a hand-edited variant.

- Files: `.github/workflows/dependabot-review.yml`, `.github/dependabot-review-prompt.md`, `.github/dependabot.yml`, `.github/dependabot-automerge/` (the gate, plus `autofix-bounds.cjs` and `.github/dependabot-autofix-prompt.md` when autofix is on).
- Label: `gh label list --search needs-human-review`.
- Secrets: `gh secret list` and `gh secret list --app dependabot`.
- Open PRs still carrying the label: `gh pr list --label needs-human-review --state open`.

## 2. Confirm before acting

Show the user the exact list and get their go-ahead. Two things deserve a specific callout rather than a blanket "removing everything":

- **`.github/dependabot.yml` may predate dep-steward.** The installer writes it, but the user may have had Dependabot configured before. Deleting it stops dependency updates entirely. Ask whether to delete it or keep it, and say that keeping it means updates continue with no review and no gate.
- **Open PRs labelled `needs-human-review` are waiting on them.** Removing the label loses that queue. Offer to list those PRs so they can triage first.

## 3. Remove

```sh
rm -f .github/workflows/dependabot-review.yml \
      .github/dependabot-review-prompt.md \
      .github/dependabot-autofix-prompt.md
rm -rf .github/dependabot-automerge
# only if the user chose to remove it:
rm -f .github/dependabot.yml

gh label delete needs-human-review --yes
gh secret delete CLAUDE_CODE_OAUTH_TOKEN
gh secret delete CLAUDE_CODE_OAUTH_TOKEN --app dependabot
```

The file deletions are working-tree changes the user commits like any other change; the pipeline stops when that commit reaches the default branch.

## 4. Report what was deliberately left alone

- **Auto-merge stays enabled** on the repo (Settings → General). The installer turned it on, but other workflows may rely on it, so it is the user's call: Settings → General → Pull Requests.
- **Branch protection and required status checks are untouched** — the installer only ever advised on them.
- **Merged PRs, review comments, and history stay.** Nothing is rewritten.
- The plugin itself is separate from the pipeline: `/plugin uninstall dep-steward@dep-steward` removes these skills from Claude Code, and can be done independently of removing the pipeline from any repo.
