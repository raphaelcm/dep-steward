#!/bin/sh
# dep-steward installer — adds Claude-reviewed, injection-safe Dependabot
# automation to a GitHub repo in one command: auto-update your dependencies on a
# schedule, auto-review every PR with a Claude agent, and auto-merge only when safe.
#
#   sh -c "$(curl -fsSL https://raw.githubusercontent.com/raphaelcm/dep-steward/main/install.sh)"
#
# What it does (all idempotent — safe to re-run):
#   1. Preflight: gh authed with repo+workflow scopes; a GitHub repo in cwd.
#   2. Detect the JS lockfile(s) and your CI workflow name.
#   3. Render four files into .github/ (workflow, prompt, dependabot.yml, gate).
#   4. Create the `needs-human-review` label.
#   5. Set CLAUDE_CODE_OAUTH_TOKEN in BOTH the Actions and Dependabot stores.
#   6. Enable auto-merge on the repo.
#   7. Check branch protection and advise (never mutates protection rules).
#
# Flags:
#   --dry-run            show every change without making it
#   --ci-name NAME       the CI workflow whose green status gates merges
#   --model NAME         Claude model for the review job (default below)
#   --render-only --out DIR   render the four files to DIR and stop (no gh)
#
# It writes files and (label/secret/setting) via `gh`. It never touches your
# source, your existing CI workflow, branch-protection rules, or git history.

set -eu
CDPATH=''

# One Opus generation behind the newest on purpose: the very latest model is not
# reliably reachable through the OAuth subscription tokens `claude setup-token`
# mints. claude-opus-4-8 errored on the agent's first turn ($0 cost, is_error) for
# a fresh subscription token, while claude-opus-4-7 runs fine. Bump ONLY after
# confirming the new model is accessible via a subscription token, not just an API key.
DEFAULT_MODEL='claude-opus-4-7'
REPO_URL='https://github.com/raphaelcm/dep-steward'
GATE_PATH='.github/dependabot-automerge/gate.cjs'
AUTOFIX_BOUNDS_PATH='.github/dependabot-automerge/autofix-bounds.cjs'
AUTOFIX_PROMPT_PATH='.github/dependabot-autofix-prompt.md'
LABEL='needs-human-review'
SECRET='CLAUDE_CODE_OAUTH_TOKEN'

NL='
'

DRY_RUN=0
RENDER_ONLY=0
OUT=''
CI_NAME=''
MODEL="$DEFAULT_MODEL"
ASSIGNEE=''
ASSIGNEE_EXPLICIT=0
AUTOFIX=1

say()  { printf '%s\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
open_url() {
  if command -v open >/dev/null 2>&1; then open "$1" >/dev/null 2>&1
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$1" >/dev/null 2>&1
  fi
}

usage() {
  cat <<'USAGE'
dep-steward installer — Dependabot auto-updates your dependencies, a Claude agent
auto-reviews each PR, and the gate auto-merges only when it's safe.

Usage: run in the repo you want to protect:
  sh -c "$(curl -fsSL https://raw.githubusercontent.com/raphaelcm/dep-steward/main/install.sh)"

Flags:
  --dry-run            show every change without making it
  --ci-name NAME       the CI workflow whose green status gates merges
  --model NAME         Claude model for the review job (default: claude-opus-4-8)
  --assignee HANDLE    GitHub user assigned when a PR is escalated, so GitHub
                       notifies them (default: you; pass "" to disable)
  --no-autofix         turn OFF autofix (it's ON by default): don't let a Claude
                       agent push mechanical fixes for CI-breaking bumps; baseline
                       review + auto-merge only.
  --render-only --out DIR   render into DIR and stop (no gh calls)
  -h, --help           show this help

Docs: https://github.com/raphaelcm/dep-steward
USAGE
  exit 0
}

# ---- parse args ------------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --autofix) AUTOFIX=1 ;;
    --no-autofix) AUTOFIX=0 ;;
    --render-only) RENDER_ONLY=1 ;;
    --out) OUT="${2:-}"; shift ;;
    --out=*) OUT="${1#--out=}" ;;
    --ci-name) CI_NAME="${2:-}"; shift ;;
    --ci-name=*) CI_NAME="${1#--ci-name=}" ;;
    --model) MODEL="${2:-}"; shift ;;
    --model=*) MODEL="${1#--model=}" ;;
    --assignee) ASSIGNEE="${2:-}"; ASSIGNEE_EXPLICIT=1; shift ;;
    --assignee=*) ASSIGNEE="${1#--assignee=}"; ASSIGNEE_EXPLICIT=1 ;;
    -h|--help) usage ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
  shift
done

[ "$RENDER_ONLY" -eq 1 ] && [ -z "$OUT" ] && die "--render-only requires --out DIR"

# ---- locate the template source (local checkout or bootstrap clone) --------
CLEANUP_TMP=''
STAGE=''
cleanup() {
  [ -n "$CLEANUP_TMP" ] && rm -rf "$CLEANUP_TMP"
  [ -n "$STAGE" ] && rm -rf "$STAGE"
  return 0
}
trap cleanup EXIT INT TERM

SRC="${DEP_STEWARD_SRC:-}"
if [ -z "$SRC" ]; then
  sd=$(cd -- "$(dirname -- "$0")" 2>/dev/null && pwd) || sd=''
  if [ -n "$sd" ] && [ -f "$sd/templates/dependabot.yml" ]; then
    SRC="$sd"
  fi
fi
if [ -z "$SRC" ]; then
  command -v git >/dev/null 2>&1 || die "git is required to bootstrap; install git or clone $REPO_URL and run ./install.sh"
  CLEANUP_TMP=$(mktemp -d)
  say "Fetching dep-steward templates…"
  git clone --depth 1 "$REPO_URL" "$CLEANUP_TMP/dep-steward" >/dev/null 2>&1 \
    || die "could not clone $REPO_URL"
  SRC="$CLEANUP_TMP/dep-steward"
fi
[ -f "$SRC/templates/dependabot.yml" ] || die "templates not found under $SRC"

# ---- ecosystem catalog -----------------------------------------------------
# Detect the package managers present at the repo root and assemble every
# downstream value from that one set: the dependabot.yml `updates:` entries, the
# gate's group-branch prefixes, and the gate's path whitelist. Branch slugs and
# manifest paths are from dependabot-core (only npm→npm_and_yarn,
# gomod→go_modules, github-actions→github_actions differ from the config value).
# To add an ecosystem, add one clause to detect_ecosystems. GitHub Actions is
# always managed. Non-root manifests (directory: /) are out of scope for now.
ACTIVE=''          # package-ecosystem names, space-separated (for the summary)
LANG_COUNT=0       # count of non-actions ecosystems detected
DEP_UPDATES=''     # generated dependabot.yml `updates:` entries
GROUP_PREFIXES=''  # gate ELIGIBLE_GROUP_PREFIXES (JS-quoted, one per line)
WL_EXACT=''        # gate WHITELIST_EXACT (JS-quoted paths, one per line)
WL_REGEX=''        # gate WHITELIST_REGEX (JS regex literals, one per line)

reg_eco() { # $1=package-ecosystem  $2=branch-slug  $3=group-name
  ACTIVE="$ACTIVE $1"
  case "$1" in github-actions) : ;; *) LANG_COUNT=$((LANG_COUNT + 1)) ;; esac
  DEP_UPDATES="${DEP_UPDATES}  - package-ecosystem: $1${NL}    directory: /${NL}    schedule:${NL}      interval: weekly${NL}      day: monday${NL}    groups:${NL}      $3:${NL}        update-types:${NL}          - minor${NL}          - patch${NL}${NL}"
  GROUP_PREFIXES="${GROUP_PREFIXES}  'dependabot/$2/$3-',${NL}"
}
reg_exact() { for p in "$@"; do WL_EXACT="${WL_EXACT}  '$p',${NL}"; done; }
reg_regex() { for r in "$@"; do WL_REGEX="${WL_REGEX}  $r,${NL}"; done; }

detect_ecosystems() {
  [ -f ./package.json ] && { reg_eco npm npm_and_yarn npm-minor-patch; reg_exact package.json package-lock.json npm-shrinkwrap.json yarn.lock pnpm-lock.yaml; }
  [ -f ./uv.lock ] && { reg_eco uv uv uv-minor-patch; reg_exact pyproject.toml uv.lock; }
  if [ -f ./requirements.txt ] || [ -f ./Pipfile ] || [ -f ./poetry.lock ] || [ -f ./setup.py ] || { [ -f ./pyproject.toml ] && [ ! -f ./uv.lock ]; }; then
    reg_eco pip pip pip-minor-patch
    reg_exact requirements.txt requirements.in Pipfile Pipfile.lock pyproject.toml poetry.lock setup.py setup.cfg pdm.lock
    reg_regex '/^requirements.*\.txt$/'
  fi
  [ -f ./Cargo.toml ] && { reg_eco cargo cargo cargo-minor-patch; reg_exact Cargo.toml Cargo.lock; }
  [ -f ./go.mod ] && { reg_eco gomod go_modules gomod-minor-patch; reg_exact go.mod go.sum go.work go.work.sum; }
  if [ -f ./Gemfile ] || ls ./*.gemspec >/dev/null 2>&1; then
    reg_eco bundler bundler bundler-minor-patch
    reg_exact Gemfile Gemfile.lock gems.rb gems.locked
    reg_regex '/^[^/]+\.gemspec$/'
  fi
  [ -f ./composer.json ] && { reg_eco composer composer composer-minor-patch; reg_exact composer.json composer.lock; }
  [ -f ./pom.xml ] && { reg_eco maven maven maven-minor-patch; reg_exact pom.xml; }
  if [ -f ./build.gradle ] || [ -f ./build.gradle.kts ]; then
    reg_eco gradle gradle gradle-minor-patch
    reg_exact build.gradle build.gradle.kts settings.gradle settings.gradle.kts gradle.properties gradle.lockfile gradle/libs.versions.toml
  fi
  if ls ./*.csproj ./*.fsproj ./*.vbproj ./*.sln >/dev/null 2>&1 || [ -f ./packages.config ] || [ -f ./Directory.Packages.props ]; then
    reg_eco nuget nuget nuget-minor-patch
    reg_exact packages.config packages.lock.json global.json Directory.Packages.props Directory.Build.props Directory.Build.targets
    reg_regex '/^[^/]+\.(csproj|vbproj|fsproj|proj|sln|slnx)$/'
  fi
  if [ -f ./Dockerfile ] || [ -f ./Containerfile ] || ls ./*.dockerfile >/dev/null 2>&1; then
    reg_eco docker docker docker-minor-patch
    reg_exact Dockerfile Containerfile
    reg_regex '/^Dockerfile\..+$/' '/^[^/]+\.dockerfile$/'
  fi
  # GitHub Actions — always on (workflow + composite-action bumps).
  reg_eco github-actions github_actions actions-minor-patch
  reg_regex '/^\.github\/workflows\/[^/]+\.ya?ml$/' '/^\.github\/actions\//' '/(^|\/)action\.ya?ml$/'
}
detect_ecosystems
ACTIVE=$(printf '%s' "$ACTIVE" | sed 's/^ *//')
[ "$LANG_COUNT" -eq 0 ] && warn "no language package manager detected at the repo root — only GitHub Actions will be managed. (Run this at the repo root; non-root manifests aren't detected yet.)"

# prompt: the human-readable ecosystem list (e.g. "npm, cargo, github-actions")
WHITELIST_HUMAN=$(printf '%s' "$ACTIVE" | tr ' ' ',' | sed 's/,/, /g')

# Escalation assignee → the flag + note rendered into the prompt and workflow.
# Empty assignee renders nothing (opt-out). Computed here in code so only the
# taken branch reaches the templates.
compute_assign() {
  if [ -n "$ASSIGNEE" ]; then
    ASSIGN_FLAG=" --add-assignee $ASSIGNEE"
    ASSIGN_NOTE=", which also assigns \`$ASSIGNEE\` so GitHub notifies them"
  else
    ASSIGN_FLAG=''
    ASSIGN_NOTE=''
  fi
}
compute_assign

# ---- render helpers --------------------------------------------------------
# CI name token for `gh run list --workflow X`: bare when safe, else quoted.
ci_runlist_token() {
  case "$1" in
    *[!A-Za-z0-9._-]*) printf '"%s"' "$1" ;;
    *) printf '%s' "$1" ;;
  esac
}

# inject a multi-line block where a marker line appears in the piped template.
inject() { # inject <marker> <block> ; filters stdin -> stdout
  bf=$(mktemp); printf '%s' "$2" > "$bf"
  awk -v m="$1" -v bf="$bf" '$0==m{while((getline l<bf)>0)print l;close(bf);next}{print}'
  rm -f "$bf"
}

render_dependabot_yml() { inject '#__UPDATES__' "$DEP_UPDATES" < "$SRC/templates/dependabot.yml"; }

render_prompt() {
  sed -e "s|__WHITELIST_HUMAN__|$WHITELIST_HUMAN|g" \
      -e "s|__ASSIGN_FLAG__|$ASSIGN_FLAG|g" \
      -e "s|__ASSIGN_NOTE__|$ASSIGN_NOTE|g" \
      "$SRC/templates/dependabot-review-prompt.md"
}

render_workflow() {
  crt=$(ci_runlist_token "$CI_NAME")
  frag=''
  if [ "$AUTOFIX" -eq 1 ]; then frag=$(cat "$SRC/templates/dependabot-autofix-job.yml"); fi
  inject '#__AUTOFIX_JOB__' "$frag" < "$SRC/templates/dependabot-review.yml" \
    | sed -e "s|__CI_NAME__|$CI_NAME|g" \
          -e "s|__CI_RUNLIST__|$crt|g" \
          -e "s|__MODEL__|$MODEL|g" \
          -e "s|__GATE_PATH__|$GATE_PATH|g" \
          -e "s|__ASSIGN_FLAG__|$ASSIGN_FLAG|g"
}

render_gate() {
  inject '//__PREFIXES__' "$GROUP_PREFIXES" < "$SRC/templates/gate.cjs" \
    | inject '//__WL_EXACT__' "$WL_EXACT" \
    | inject '//__WL_REGEX__' "$WL_REGEX"
}

# autofix (--autofix only): the fixer prompt takes the same escalate flag as the
# review prompt; the bounds script is static (rendered verbatim).
render_autofix_prompt() { sed -e "s|__ASSIGN_FLAG__|$ASSIGN_FLAG|g" "$SRC/templates/dependabot-autofix-prompt.md"; }
render_autofix_bounds() { cat "$SRC/templates/autofix-bounds.cjs"; }

# write one rendered file to a destination path (creating parent dirs)
emit() { # emit <renderer-fn> <dest-path>
  d=$(dirname "$2")
  mkdir -p "$d"
  "$1" > "$2"
}

# ---- render-only mode (used by the parity test) ----------------------------
if [ "$RENDER_ONLY" -eq 1 ]; then
  [ -n "$CI_NAME" ] || CI_NAME='CI'
  emit render_dependabot_yml "$OUT/.github/dependabot.yml"
  emit render_prompt          "$OUT/.github/dependabot-review-prompt.md"
  emit render_workflow        "$OUT/.github/workflows/dependabot-review.yml"
  emit render_gate            "$OUT/$GATE_PATH"
  if [ "$AUTOFIX" -eq 1 ]; then
    emit render_autofix_prompt "$OUT/$AUTOFIX_PROMPT_PATH"
    emit render_autofix_bounds "$OUT/$AUTOFIX_BOUNDS_PATH"
  fi
  say "Rendered to $OUT (ecosystems: $ACTIVE; ci: $CI_NAME; model: $MODEL; assignee: ${ASSIGNEE:-none}; autofix: $([ "$AUTOFIX" -eq 1 ] && echo on || echo off))"
  exit 0
fi

# ---- preflight (full install) ----------------------------------------------
command -v gh >/dev/null 2>&1 || die "GitHub CLI (gh) is required: https://cli.github.com"
gh auth status >/dev/null 2>&1 || die "run 'gh auth login' first"
SCOPES=$(gh auth status 2>&1 | sed -n 's/.*Token scopes: //p' | head -1)
case "$SCOPES" in *repo*) : ;; *) warn "gh token may lack 'repo' scope; merges/secrets could fail. Scopes: $SCOPES" ;; esac
case "$SCOPES" in *workflow*) : ;; *) warn "gh token may lack 'workflow' scope; pushing the workflow file could fail. Scopes: $SCOPES" ;; esac

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || die "not inside a git repository"
cd "$REPO_ROOT"

NWO=$(gh repo view --json nameWithOwner --jq '.nameWithOwner' 2>/dev/null) || die "no GitHub repo for this directory (is 'origin' a GitHub remote?)"
DEFAULT_BRANCH=$(gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name' 2>/dev/null || echo main)

# ---- resolve the CI workflow name ------------------------------------------
if [ -z "$CI_NAME" ]; then
  cand=$(grep -hE '^[[:space:]]*name:' .github/workflows/*.yml .github/workflows/*.yaml 2>/dev/null \
         | sed -E 's/^[[:space:]]*name:[[:space:]]*//; s/^["'\'']//; s/["'\'']$//' \
         | grep -v '^Dependabot PR review$' || true)
  exact=$(printf '%s\n' "$cand" | grep -ixE 'ci' | head -1 || true)
  if [ -n "$exact" ]; then
    CI_NAME="$exact"
  else
    n=$(printf '%s\n' "$cand" | sed '/^$/d' | wc -l | tr -d ' ')
    if [ "$n" = "1" ]; then
      CI_NAME=$(printf '%s\n' "$cand" | sed '/^$/d' | head -1)
    fi
  fi
fi
if [ -z "$CI_NAME" ]; then
  if [ -t 0 ]; then
    say "Which workflow's green status should gate merges? Detected:"
    printf '%s\n' "$cand" | sed '/^$/d;s/^/  - /'
    printf 'CI workflow name: '
    read -r CI_NAME
  fi
fi
[ -n "$CI_NAME" ] || die "could not determine the CI workflow name — re-run with --ci-name \"<name>\" (the gate keys off this exact name; it cannot fire without it)"

# ---- resolve the escalation assignee (default: you) ------------------------
if [ "$ASSIGNEE_EXPLICIT" -eq 0 ]; then
  ASSIGNEE=$(gh api user --jq '.login' 2>/dev/null || echo '')
  compute_assign
fi

# ---- summary ---------------------------------------------------------------
say ""
say "dep-steward — installing into $NWO (default branch: $DEFAULT_BRANCH)"
info "ecosystems:   $ACTIVE"
info "CI workflow:  $CI_NAME"
info "review model: $MODEL"
info "gate path:    $GATE_PATH"
info "escalations:  $([ -n "$ASSIGNEE" ] && echo "assign @$ASSIGNEE + label" || echo "label only (no assignee)")"
info "autofix:      $([ "$AUTOFIX" -eq 1 ] && echo "on — Claude pushes small mechanical fixes for you to merge" || echo "off")"
say ""

# ---- render (to a temp tree first, for dry-run diffing) --------------------
STAGE=$(mktemp -d)
emit render_dependabot_yml "$STAGE/.github/dependabot.yml"
emit render_prompt          "$STAGE/.github/dependabot-review-prompt.md"
emit render_workflow        "$STAGE/.github/workflows/dependabot-review.yml"
emit render_gate            "$STAGE/$GATE_PATH"

FILES=".github/dependabot.yml .github/dependabot-review-prompt.md .github/workflows/dependabot-review.yml $GATE_PATH"
if [ "$AUTOFIX" -eq 1 ]; then
  emit render_autofix_prompt "$STAGE/$AUTOFIX_PROMPT_PATH"
  emit render_autofix_bounds "$STAGE/$AUTOFIX_BOUNDS_PATH"
  FILES="$FILES $AUTOFIX_PROMPT_PATH $AUTOFIX_BOUNDS_PATH"
fi

if [ "$DRY_RUN" -eq 1 ]; then
  say "[dry-run] files that would be written:"
  for f in $FILES; do
    if [ -f "./$f" ]; then
      if diff -q "./$f" "$STAGE/$f" >/dev/null 2>&1; then
        info "unchanged: $f"
      else
        say "  modified: $f"
        diff -u "./$f" "$STAGE/$f" 2>/dev/null | sed 's/^/    /' || true
      fi
    else
      info "new:       $f"
    fi
  done
  say ""
  say "[dry-run] GitHub changes that would be made:"
  info "REQUIRED (manual, web): install the Claude Code GitHub App on $NWO — https://github.com/apps/claude"
  info "gh label create $LABEL (if missing)"
  info "gh secret set $SECRET            (Actions store)"
  info "gh secret set $SECRET --app dependabot   (Dependabot store)"
  info "gh api -X PATCH repos/$NWO -F allow_auto_merge=true"
  info "inspect branch protection on '$DEFAULT_BRANCH' and advise"
  say ""
  say "[dry-run] no changes made."
  exit 0
fi

# ---- write files -----------------------------------------------------------
for f in $FILES; do
  mkdir -p "$(dirname "./$f")"
  cp "$STAGE/$f" "./$f"
done
say "Wrote:"
for f in $FILES; do info "$f"; done

# ---- label -----------------------------------------------------------------
if gh label list --repo "$NWO" --json name --jq '.[].name' 2>/dev/null | grep -qxF "$LABEL"; then
  info "label '$LABEL' already exists"
else
  if gh label create "$LABEL" --repo "$NWO" --color FBCA04 \
       --description "Dependabot PR the reviewer escalated for a human" >/dev/null; then
    info "created label '$LABEL'"
  else
    warn "could not create label '$LABEL'"
  fi
fi

# ---- Claude GitHub App (required; not automatable) -------------------------
# claude-code-action needs the Claude Code GitHub App installed on the repo, in
# addition to the token: the token authorizes the Claude side, the App the GitHub
# side. Installation is a web consent flow with no user-token API to perform or
# verify it, so we surface it as a required step and open it when we can. Without
# it, every review/autofix run fails with "Claude Code is not installed on this
# repository".
say ""
say "REQUIRED — install the Claude Code GitHub App on $NWO. The token alone is not"
say "enough; without the App, every review/autofix run fails with \"Claude Code is"
say "not installed on this repository\". Grant it access to this repo:"
info "https://github.com/apps/claude  ->  Configure  ->  add $NWO"
if [ -t 0 ]; then
  printf 'Open that page now? [Y/n] '
  read -r ans
  case "$ans" in ''|[Yy]*) open_url "https://github.com/apps/claude/installations/new" ;; esac
  printf 'Press Enter once the App has access to %s... ' "$NWO"
  read -r _
fi

# ---- secret in BOTH stores (the marquee gotcha) ----------------------------
TOKEN="${CLAUDE_CODE_OAUTH_TOKEN:-}"
if [ -z "$TOKEN" ] && [ -t 0 ]; then
  # Fold token generation into the flow when Claude Code is installed. `claude
  # setup-token` is interactive by design (browser OAuth) and prints the token
  # for manual copy — it can't be captured silently — so we launch it inline
  # and then read the token from the same prompt.
  if command -v claude >/dev/null 2>&1; then
    printf 'No CLAUDE_CODE_OAUTH_TOKEN set. Mint one now with claude setup-token? [Y/n] '
    read -r ans
    case "$ans" in
      ''|[Yy]*)
        say "Launching 'claude setup-token' — authorize in the browser, then copy the token it prints."
        claude setup-token || warn "claude setup-token did not complete; you can still paste a token below"
        printf 'Paste the token it printed (input hidden): '
        ;;
      *)
        printf 'Paste your CLAUDE_CODE_OAUTH_TOKEN (input hidden): '
        ;;
    esac
  else
    info "Tip: with Claude Code installed, 'claude setup-token' mints this token (needs a Claude subscription)."
    printf 'Paste your CLAUDE_CODE_OAUTH_TOKEN (input hidden): '
  fi
  stty -echo 2>/dev/null || true
  read -r TOKEN
  stty echo 2>/dev/null || true
  printf '\n'
fi
if [ -n "$TOKEN" ]; then
  if printf '%s' "$TOKEN" | gh secret set "$SECRET" --repo "$NWO" --body - >/dev/null; then
    info "set $SECRET (Actions store)"
  else
    warn "could not set $SECRET (Actions store)"
  fi
  if printf '%s' "$TOKEN" | gh secret set "$SECRET" --repo "$NWO" --app dependabot --body - >/dev/null; then
    info "set $SECRET (Dependabot store)"
  else
    warn "could not set $SECRET (Dependabot store)"
  fi
else
  warn "no CLAUDE_CODE_OAUTH_TOKEN provided — set it in BOTH stores yourself:"
  info "gh secret set $SECRET --repo $NWO"
  info "gh secret set $SECRET --repo $NWO --app dependabot"
fi

# ---- enable auto-merge -----------------------------------------------------
if gh api -X PATCH "repos/$NWO" -F allow_auto_merge=true >/dev/null 2>&1; then
  info "enabled auto-merge on $NWO"
else
  warn "could not enable auto-merge; turn it on in Settings → General → Pull Requests"
fi

# ---- required-status-check advice (detect only; rulesets + classic) --------
# GitHub requires status checks by *context* (a job / check-run name), not by
# workflow name, and reports them via the effective-rules endpoint — which
# covers BOTH rulesets and classic branch protection. (The classic
# /branches/<b>/protection endpoint alone 404s on ruleset-based repos, which
# would misreport.) We can't reliably map your CI workflow to its contexts, so
# we report what's required and let you confirm your CI checks are among them.
required=$(gh api "repos/$NWO/rules/branches/$DEFAULT_BRANCH" \
  --jq '[.[] | select(.type=="required_status_checks")
              | .parameters.required_status_checks[]?.context] | join(", ")' \
  2>/dev/null || true)
say ""
if [ -n "$required" ]; then
  info "Required status checks on '$DEFAULT_BRANCH': $required"
  info "Confirm your '$CI_NAME' checks are among them — the gate treats CI-green as authoritative."
else
  warn "No status checks are required on '$DEFAULT_BRANCH'."
  info "The gate re-checks CI itself before merging, so the bot is safe — but requiring your '$CI_NAME'"
  info "checks adds defense in depth (nobody merges around a red build). Set it in Settings → Rules."
fi

# ---- offer to commit + push (so "done" means live) -------------------------
# The installer stages the generated files but doesn't commit by default — some
# adopters want to review first. Offer to do it so "done" can actually mean live.
ACTIVATED=0
if [ -t 0 ] && [ -n "$FILES" ]; then
  say ""
  printf 'Commit and push these files now to activate the pipeline? [Y/n] '
  read -r ans
  case "$ans" in
    ''|[Yy]*)
      # Stage only the generated files, not unrelated working-tree changes.
      # shellcheck disable=SC2086
      git add $FILES 2>/dev/null || true
      if git commit -m "Add dep-steward: Claude-reviewed Dependabot automation" >/dev/null 2>&1; then
        if git push >/dev/null 2>&1; then
          ACTIVATED=1
          info "committed and pushed — the pipeline is live."
        else
          warn "committed, but 'git push' failed (no upstream, or rejected). Push it yourself: git push"
        fi
      else
        warn "nothing new to commit — if not yet pushed: git add -A && git commit -m 'Add dep-steward' && git push"
      fi
      ;;
    *) info "OK — commit + push when you're ready: git add -A && git commit -m 'Add dep-steward' && git push" ;;
  esac
fi

# ---- done ------------------------------------------------------------------
say ""
if [ "$ACTIVATED" -eq 1 ]; then
  say "Done — pushed and live. Dependabot scans on the new config and opens its first PRs shortly."
else
  say "Done. Commit + push the files under .github/ to activate the pipeline:"
  info "git add -A && git commit -m 'Add dep-steward' && git push"
fi
