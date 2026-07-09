---
description: Summarize what dep-steward has done for this repo and estimate the time it saved.
argument-hint: "[window — e.g. 90d, or 'since 2026-01-01'; default: since install]"
---

Produce a read-only summary of the **dep-steward** pipeline's activity in THIS repository, and an honest estimate of the time it saved. dep-steward auto-reviews Dependabot PRs and merges the safe ones; its Claude review job leaves a comment carrying an `<!-- AUTOMERGE-DECISION-V1 -->` block on each non-trivial PR, and escalated PRs carry the `needs-human-review` label.

Read and report only — change nothing.

## Gather (prefer `gh`; if it reports an auth error, use the GitHub MCP tools instead)

Scope: use `$ARGUMENTS` if given (e.g. `90d`, or `since 2026-01-01`). Otherwise cover since the pipeline was installed — infer that from the first commit that added the workflow: `git log --diff-filter=A --format=%as -- .github/workflows/dependabot-review.yml | tail -1`. State the window you used.

- **Auto-merged:** `gh pr list --author app/dependabot --state merged --limit 200 --json number,title,mergedAt,headRefName`. Branches matching `dependabot/npm_and_yarn/npm-minor-patch-*` or `dependabot/github_actions/actions-minor-patch-*` are the routine group auto-merges; the rest are singleton/major.
- **Waiting on the human:** `gh pr list --author app/dependabot --label needs-human-review --state open --json number,title`.
- **What was investigated:** for the singleton/major PRs, read the review comment's decision and its `breaking_changes_enumerated` (changelogs read, usage grepped). Flag any comment that marks a CVE / security advisory (the reviewer tags those **PRIORITY**).

## Report — concise and skimmable

- One line: the window covered.
- **Handled for you:** the total, split into routine auto-merges vs majors reviewed (how many merged vs escalated). Call out any **security (CVE)** updates and how quickly they landed.
- **Waiting on you:** each open `needs-human-review` PR with a one-line reason drawn from its review comment.
- **Time back:** lead with the EXACT counts (these are facts). Then a transparent estimate — multiply the counts by a per-PR minutes assumption you state openly (suggest ~5 min per routine merge, ~30 min per major review), and show the arithmetic. Never present an hours figure as authoritative: the counts are exact, the minutes are an assumption the reader can change.

If there was no activity in the window, say so plainly rather than padding.
