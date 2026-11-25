# Changelog

Each release's notes, newest first. When a release PR merges and main's tests pass, CI tags the release and publishes its notes from here as the GitHub release. Earlier releases are on the [releases page](https://github.com/raphaelcm/dep-steward/releases).

## v0.18.2: The gate reads the newest CI run that was not cancelled, and a PR whose CI cannot finish reaches you

v0.18.1's gate could leave a Dependabot PR with green CI unmerged, and tell no one. When your CI starts several runs on one commit and cancels all but one (a CI that runs on `labeled` with `cancel-in-progress` does this when Dependabot opens and labels a PR in the same second), the gate read only the first run the API listed. That was often a cancelled duplicate, so the gate logged `ci_indeterminate` and stopped: no label, no assignee, no comment.

- **The gate reads every CI run on the PR's head.** The newest run that was not cancelled decides, and the head is pending while that run is still going. The head counts as cancelled only when every run on it was. Runs created in the same second are ordered by run id, so the result no longer depends on the order the API lists them in.
- **A PR whose CI cannot finish reaches you.** When nothing on the head is still running and nothing passed (every run was cancelled, or the newest one timed out or is waiting for approval), the gate adds `needs-human-review`, assigns your `assignee`, and comments once, saying to re-run CI or approve the waiting run. When that run goes green, the gate merges as usual.
- When the gate skips a PR, its log names the code and the reason, instead of saying "left for human review" on every wake-up.

The review workflow and the seal step are unchanged apart from the pinned version.

### Upgrading

Merge the Dependabot PR that moves your three workflow files to v0.18.2; the gate leaves it to you. No `with:` input changes, so there is nothing to reinstall.
