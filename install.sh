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

DEFAULT_MODEL='claude-opus-4-8'
REPO_URL='https://github.com/raphaelcm/dep-steward'
GATE_PATH='.github/dependabot-automerge/gate.cjs'
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

say()  { printf '%s\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

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

# ---- detect ecosystem (JS lockfiles) from the current directory ------------
LOCKFILES=''
for lf in package-lock.json pnpm-lock.yaml yarn.lock npm-shrinkwrap.json; do
  [ -f "./$lf" ] && LOCKFILES="$LOCKFILES $lf"
done
LOCKFILES=$(printf '%s' "$LOCKFILES" | sed 's/^ *//;s/ *$//')
if [ -z "$LOCKFILES" ]; then
  [ -f ./package.json ] || warn "no package.json / lockfile found — dep-steward v1 targets JS (npm/pnpm/yarn) + GitHub Actions. Installing anyway; review the generated whitelist."
  LOCKFILES='package-lock.json'
fi

# ---- assemble the ecosystem-driven render values ---------------------------
# gate.cjs whitelist terms (one JS expression per lockfile)
LOCKFILE_TERMS=''
for lf in $LOCKFILES; do
  line="    p === '$lf' ||"
  if [ -z "$LOCKFILE_TERMS" ]; then LOCKFILE_TERMS="$line"; else LOCKFILE_TERMS="$LOCKFILE_TERMS$NL$line"; fi
done
# prompt: human-readable whitelist + lockfile phrase
# shellcheck disable=SC2016  # backticks here are literal Markdown, not command substitution
WHITELIST_HUMAN='`package.json`'
for lf in $LOCKFILES; do WHITELIST_HUMAN="$WHITELIST_HUMAN / \`$lf\`"; done
WHITELIST_HUMAN="$WHITELIST_HUMAN / \`.github/workflows/*.yml\` / \`.github/actions/**\`"
LOCKFILE_HUMAN=''
for lf in $LOCKFILES; do
  if [ -z "$LOCKFILE_HUMAN" ]; then LOCKFILE_HUMAN="\`$lf\`"; else LOCKFILE_HUMAN="$LOCKFILE_HUMAN + \`$lf\`"; fi
done

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

render_dependabot_yml() { cat "$SRC/templates/dependabot.yml"; }

render_prompt() {
  sed -e "s|__WHITELIST_HUMAN__|$WHITELIST_HUMAN|g" \
      -e "s|__LOCKFILE_HUMAN__|$LOCKFILE_HUMAN|g" \
      -e "s|__ASSIGN_FLAG__|$ASSIGN_FLAG|g" \
      -e "s|__ASSIGN_NOTE__|$ASSIGN_NOTE|g" \
      "$SRC/templates/dependabot-review-prompt.md"
}

render_workflow() {
  crt=$(ci_runlist_token "$CI_NAME")
  sed -e "s|__CI_NAME__|$CI_NAME|g" \
      -e "s|__CI_RUNLIST__|$crt|g" \
      -e "s|__MODEL__|$MODEL|g" \
      -e "s|__GATE_PATH__|$GATE_PATH|g" \
      -e "s|__ASSIGN_FLAG__|$ASSIGN_FLAG|g" \
      "$SRC/templates/dependabot-review.yml"
}

render_command() { cat "$SRC/templates/dep-steward-summary.md"; }

render_gate() {
  bf=$(mktemp)
  printf '%s\n' "$LOCKFILE_TERMS" > "$bf"
  awk -v bf="$bf" '
    $0 == "//__LOCKFILE_TERMS__" { while ((getline line < bf) > 0) print line; close(bf); next }
    { print }
  ' "$SRC/templates/gate.cjs"
  rm -f "$bf"
}

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
  emit render_command         "$OUT/.claude/commands/dep-steward-summary.md"
  say "Rendered to $OUT (lockfiles: $LOCKFILES; ci: $CI_NAME; model: $MODEL; assignee: ${ASSIGNEE:-none})"
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
info "lockfile(s):  $LOCKFILES"
info "CI workflow:  $CI_NAME"
info "review model: $MODEL"
info "gate path:    $GATE_PATH"
info "escalations:  $([ -n "$ASSIGNEE" ] && echo "assign @$ASSIGNEE + label" || echo "label only (no assignee)")"
say ""

# ---- render (to a temp tree first, for dry-run diffing) --------------------
STAGE=$(mktemp -d)
emit render_dependabot_yml "$STAGE/.github/dependabot.yml"
emit render_prompt          "$STAGE/.github/dependabot-review-prompt.md"
emit render_workflow        "$STAGE/.github/workflows/dependabot-review.yml"
emit render_gate            "$STAGE/$GATE_PATH"
emit render_command         "$STAGE/.claude/commands/dep-steward-summary.md"

FILES=".github/dependabot.yml .github/dependabot-review-prompt.md .github/workflows/dependabot-review.yml $GATE_PATH .claude/commands/dep-steward-summary.md"

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

# ---- done ------------------------------------------------------------------
say ""
say "Done. Smoke-test against an existing Dependabot PR without waiting for Monday:"
info "gh workflow run dependabot-review.yml --repo $NWO -f pr_number=<PR>"
say ""
say "In Claude Code, run /dep-steward-summary any time to see what it's handled and the time it saved."
say "Commit the generated files (.github/ + .claude/commands/) to activate the pipeline."
