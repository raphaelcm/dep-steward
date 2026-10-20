          # The PR's regeneration, as the regenerate jobs left it: an artifact of
          # the PR's own pull_request run, where the bump's code ran. Read here
          # as data, three named entries and nothing else: nothing in it is run,
          # unpacked to disk under its own names, or put in a comment.
          regeneration_run() { # $1 = commit; prints the PR's own review run for it, or nothing
            gh api "repos/$REPO/actions/workflows/dependabot-review.yml/runs?event=pull_request&head_sha=$1&per_page=20" \
              --jq '[.workflow_runs[] | select(.head_repository.full_name == env.REPO and any(.pull_requests[]; .number == (env.PR_NUMBER | tonumber)))] | sort_by(.created_at) | last | .id // empty'
          }
          regeneration_artifact() { # $1 = run; prints its verdict artifact's id, or nothing
            gh api "repos/$REPO/actions/runs/$1/artifacts?name=dep-steward-regenerate" \
              --jq '[.artifacts[] | select(.expired | not)] | sort_by(.created_at) | last | .id // empty'
          }
          regeneration_stopped() { # $1 = run; succeeds once no verdict can still come from it
            [ "$(gh api "repos/$REPO/actions/runs/$1" --jq .status)" = completed ] && return 0
            gh api "repos/$REPO/actions/runs/$1/jobs?per_page=100" \
              --jq '[.jobs[] | select(.name == "regenerate" or .name == "regenerate-verify") | select(.status == "completed" and .conclusion != "success")] | length > 0' \
              | grep -qx true
          }
          # take_regeneration <patch file> <commit> <seconds to wait>
          # Sets REGEN_VERDICT to verified, unreproducible, unchanged, or none
          # (no verdict for this commit), REGEN_WHY for none, REGEN_RUN, and for
          # verified writes the patch. Never fails: every lookup that does
          # counts as none.
          take_regeneration() {
            REGEN_VERDICT=none
            REGEN_WHY=''
            REGEN_RUN=''
            local zip verdict sha artifact='' waited=0
            if ! REGEN_RUN=$(regeneration_run "$2"); then
              REGEN_WHY='the review runs could not be read'
              return 0
            fi
            if [ -z "$REGEN_RUN" ]; then
              REGEN_WHY="no pull_request run of this PR exists for $2"
              return 0
            fi
            while :; do
              artifact=$(regeneration_artifact "$REGEN_RUN") || artifact=''
              [ -n "$artifact" ] && break
              if regeneration_stopped "$REGEN_RUN"; then
                REGEN_WHY="run $REGEN_RUN ended without a verdict"
                return 0
              fi
              if [ "$waited" -ge "$3" ]; then
                REGEN_WHY="run $REGEN_RUN had no verdict after ${3}s"
                return 0
              fi
              sleep 10
              waited=$((waited + 10))
            done
            zip="$RUNNER_TEMP/dep-steward-regenerate.zip"
            rm -f "$zip"
            if ! gh api "repos/$REPO/actions/artifacts/$artifact/zip" > "$zip"; then
              REGEN_WHY='its verdict could not be downloaded'
              return 0
            fi
            sha=$(unzip -p "$zip" head_sha 2>/dev/null | tr -d '\r\n') || sha=''
            if [ "$sha" != "$2" ]; then
              REGEN_WHY="its verdict is not for $2"
              return 0
            fi
            verdict=$(unzip -p "$zip" verdict 2>/dev/null | tr -d '\r\n') || verdict=''
            case "$verdict" in
              unchanged|unreproducible) REGEN_VERDICT=$verdict ;;
              verified)
                rm -f "$1"
                if unzip -p "$zip" regeneration.patch > "$1" 2>/dev/null && [ -s "$1" ]; then
                  REGEN_VERDICT=verified
                else
                  REGEN_WHY='its verdict carries no patch'
                fi ;;
              *) REGEN_WHY='its verdict is not one dep-steward writes' ;;
            esac
            return 0
          }
