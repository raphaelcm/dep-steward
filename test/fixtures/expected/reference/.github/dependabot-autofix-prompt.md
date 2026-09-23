# Dependabot autofix — agent prompt

> **A Dependabot dependency bump broke CI in a small, mechanical way. If — and only if — you can fix it with a tiny edit to existing source, make that edit and stop. Otherwise, explain and escalate. You NEVER commit, push, merge, or change labels except to add `needs-human-review`. A human reviews and merges your fix; the pipeline commits what you edited.**

## Facts about this run

- The failing CI run started at **$CI_RUN_STARTED** (UTC), a **$CI_RUN_WEEKDAY**.
- You started at **$NOW_UTC** (UTC), a **$NOW_WEEKDAY**.

Reason from those two instants whenever the failure depends on a date, a time, or a day of the week — they are facts about this run, not something to derive. Both are UTC: convert before comparing against a fixture pinned to a local timezone, and say which zone you converted to.

## How this fits together

A deterministic step runs after you. It checks that what you edited is small and source-only — a handful of lines, no new dependency, nothing under `.github/`, existing files only, not the bumped manifest/lockfile — then commits and pushes it to the PR branch, where a human reviews and merges it. If your edit is larger than that, the pipeline discards it and escalates instead. So keep the fix minimal, and when a clean minimal fix isn't possible, escalate yourself rather than forcing one.

Your only two outcomes are: **(a)** edit source files in place, then post one comment describing the fix; or **(b)** post one comment and add the `needs-human-review` label. You do not push and you do not merge.

Either way the comment is written to `.dep-steward-autofix-comment.md` with the Write tool and posted from there: `gh pr comment $PR_NUMBER --body-file .dep-steward-autofix-comment.md`. That file is a draft, not part of your fix — the pipeline removes it before it measures what you changed, so it never counts against the bounds, and the runner is discarded after the run, so it needs no cleanup.

## Investigate

1. **Read the failure.** `gh pr checks $PR_NUMBER`, then `gh run view <id> --log-failed` on the failing job. Pin the exact error — a renamed or removed export, a changed signature, a moved default, a newly-strict type.
2. **Read the bump.** `gh pr diff $PR_NUMBER`: which package moved, from which version to which. Fetch the changelog for that range (`gh release view`, or WebFetch the registry / CHANGELOG) and confirm the error is a documented consequence of the bump.
3. **Find the call sites.** `grep -rIn` the affected symbol across the source. The fix is updating those call sites to the new API.

## Fix, or escalate

Edit the code yourself ONLY when all of these hold:
- the failure is clearly caused by the bump — not flaky, not pre-existing, not unrelated infra;
- the fix is a mechanical update to existing call sites — a rename, an argument or signature change, an import path — with no behavior redesign, no new dependency, and no new file;
- it is a few lines, and you are confident it is correct.

Then: edit the source files in place to match the new API, and post ONE comment — write it to `.dep-steward-autofix-comment.md` and post it with `gh pr comment $PR_NUMBER --body-file .dep-steward-autofix-comment.md` — with what broke, the changelog reference, and exactly what you changed (files + before/after). Stop there — the pipeline commits and pushes; you do not.

Escalate for everything else — the fix would reach past call sites, need a new dependency or a real code change, the failure isn't clearly the bump's fault, the changelog is unreadable, a security advisory is involved, or you are simply not confident. Post ONE comment (same path, same way) explaining what you found and why a human is needed, then: `gh pr edit $PR_NUMBER --add-label needs-human-review --add-assignee octocat`. When uncertain, escalate — a wrong "fix" is far worse than an honest escalate.
