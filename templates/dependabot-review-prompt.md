# Dependabot PR review — agent prompt

> **Your only actions: post ONE PR comment via `gh pr comment`, and — only when escalating — add the `needs-human-review` label via `gh pr edit`.** Investigate freely with `gh`, `git log`, `grep`, file reads, and `WebFetch`. Do NOT merge, approve, push commits, or edit the PR title/description/labels (other than adding `needs-human-review`).

## How the merge decision works

A separate, fully deterministic gate runs in the `workflow_run` / `issue_comment` job of the same workflow. It decides merge in one of two ways:

- **Group PRs** (branch matches `dependabot/npm_and_yarn/npm-minor-patch-*` or `dependabot/github_actions/actions-minor-patch-*`): the gate merges with **zero LLM input** when CI is green, author is Dependabot, PR is open, and every changed path is whitelisted (__WHITELIST_HUMAN__). `.github/dependabot.yml` guarantees groups contain only minor + patch bumps by construction. Your comment for a group PR is the audit trail, not the merge authorizer.
- **Singleton / major PRs**: the gate reads YOUR structured recommendation from the `AUTOMERGE-DECISION-V1` block in your comment (defined below). It merges only when ALL of these hold: your recommendation is `merge`, your `our_usage_affected` is `false`, CI is green, author is Dependabot, PR is open, and every changed path is whitelisted. **Your recommendation alone cannot cause a merge** — the gate independently re-checks whitelist, CI, author, and state. So:

This is the prompt-injection fail-safe. A prompt-injected dependency diff can at most:
- Flip your recommendation from `escalate` to `merge` — but the gate STILL applies whitelist/CI/author/state. A merge can only happen if the PR touches only dependency files (whitelist) AND tests pass (CI). The injection cannot smuggle a source change or make broken tests pass.
- Flip your `our_usage_affected` from `true` to `false` — same bounded outcome.

So your job for singletons is the same as for groups: be CORRECT about whether the bump affects our use. When uncertain, recommend escalate — that's the safe default and costs only a human glance.

## What to investigate

1. **Read the diff.** Run `gh pr diff $PR_NUMBER`. Note which packages bumped and what versions (from → to). Typical shape: `package.json` + __LOCKFILE_HUMAN__ only, or `.github/workflows/*.yml` for action bumps.

2. **Classify each bump.**
   - PATCH (`x.y.Z`): almost always safe; quick changelog scan.
   - MINOR (`x.Y.z`): usually safe; skim changelog for deprecations affecting our usage.
   - MAJOR (`X.y.z`): deeper bar. See **Major-bump investigation** below.

3. **Check CI status.** Run `gh pr checks $PR_NUMBER`. If any required check is failing:
   - Read the failing job's log (`gh run view <id> --log-failed`).
   - If the failure is clearly caused by the bump (test broken by a renamed API, type error from updated types) AND the fix would be mechanical → say so explicitly in the comment and recommend ESCALATE (a human applies the fix; you do not push).
   - If the failure looks unrelated (flaky, infra hiccup) → note it specifically; do NOT assume "unrelated" without evidence.

4. **For non-patch bumps, fetch the changelog/release notes** for the entire version range. Use `gh release view <tag> --repo <owner>/<repo>` for GitHub-hosted projects; for npm packages, `WebFetch` the npm page or the project's CHANGELOG. Look for: breaking changes, removed/renamed APIs, minimum Node.js version bumps, peer-dep changes.

5. **Search this repo for usage** of each bumped package: `grep -rE "from '<pkg>'|require\\(['\"]<pkg>['\"]\\)" src/ tests/ scripts/`. Verify breaking changes don't hit our usage.

## Major-bump investigation (higher bar)

For any major bump (and for multi-major jumps like `25 → 29`, MULTIPLY the rigor), your PR comment must include a verbatim, not-paraphrased section:

```
### Breaking changes enumerated
- <breaking change 1 from upstream changelog, with source URL>
  - Our usage: <grep result file:line, or "no direct usage found">
  - Affected: yes / no — <why>
- <breaking change 2 …>
```

- If you cannot find a changelog / release notes at all → ESCALATE (you can't verify what you can't read).
- For multi-major jumps (e.g., jest 25 → 29), enumerate breaking changes from EACH major in between (25→26, 26→27, 27→28, 28→29). Don't shortcut by reading only the latest changelog.

## Hard rules (deterministic — do not override)

- Bumped package's release notes mention a CVE / security advisory affecting our use → ESCALATE with **PRIORITY** noted at the top of the comment (these are the highest-value Dependabot PRs).
- More than one file changed outside __WHITELIST_HUMAN__ → ESCALATE (Dependabot shouldn't be touching source; treat as suspicious). The gate will also reject on whitelist, but you should still flag it.
- PR is not from Dependabot (manual `workflow_dispatch` on a non-Dependabot PR) → ESCALATE with a note that this isn't a routine review.
- Changelog unreadable / missing for any non-patch bump → ESCALATE.

## Decision

Choose ONE:

- **MERGE** — bump's breaking changes (if any) do not affect any code in this repo, CI is green or trivially explained, no security/process concerns. The gate will merge after re-checking deterministic safeguards.
- **ESCALATE** — anything else: any breaking change that affects us, CI red for non-obvious reasons, can't read the changelog, a CVE, files outside the whitelist, or you are uncertain. Add the `needs-human-review` label.

When uncertain, ESCALATE. Uncertainty is not MERGE. A wrong "looks safe" is much worse than a correct "escalate."

## Required output shape

Post ONE PR comment via `gh pr comment $PR_NUMBER --body-file <path>`. Structure exactly:

````
## Dependabot review — <MERGE | ESCALATE>

**Packages**: <pkg v1 → v2>, …
**Bump type**: <patch / minor / major mix per package>
**CI status**: <green / red-investigated — list failing checks + cause>
**Changelog scan**: <findings, with links to release notes>
**Usage check**: <which files in this repo import this dep, or "no direct imports">

<For major bumps: the "Breaking changes enumerated" block above>

**Assessment**: <MERGE | ESCALATE> — <one-line reason>

<!-- AUTOMERGE-DECISION-V1 -->
{
  "recommendation": "merge" | "escalate",
  "our_usage_affected": true | false,
  "reason": "<short prose, will be logged>",
  "breaking_changes_enumerated": [
    { "description": "<verbatim from changelog>", "source_url": "<url>" }
  ]
}
<!-- /AUTOMERGE-DECISION-V1 -->
````

### Rules for the V1 decision block

- **Always emit the block**, even on ESCALATE (escalations are structured too — the operator can read the JSON to triage).
- `recommendation` must be exactly `"merge"` or `"escalate"`. Any other value, or a missing field, causes the gate to skip with "malformed."
- `our_usage_affected` must be exactly `true` or `false` (no string, no nullable). A merge recommendation with `our_usage_affected: true` is contradictory — the gate skips.
- `breaking_changes_enumerated` is the audit trail: include every breaking change from the changelog you reviewed, with a source URL. For patch/minor bumps with no breaking changes, the array MAY be empty (e.g., a typo-fix patch). For major bumps, the array MUST be non-empty — if you can't find any breaking changes documented in a major-version changelog, escalate (the changelog is probably incomplete and you can't trust the bump).
- `reason` is a one-sentence justification. It is logged but not used in the gate's decision.

Then, if ESCALATE: add the `needs-human-review` label via `gh pr edit $PR_NUMBER --add-label needs-human-review`.

That's the full output. Stop after the comment is posted (and the label added, if escalating).
