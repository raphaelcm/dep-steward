#!/bin/sh
# dep-steward installer — adds Claude-reviewed, injection-safe Dependabot
# automation to a GitHub repo in one command: auto-update your dependencies on a
# schedule, auto-review every PR with a Claude agent, and auto-merge only when safe.
#
#   sh -c "$(curl -fsSL https://raw.githubusercontent.com/raphaelcm/dep-steward/main/install.sh)"
#
# What it does (all idempotent — safe to re-run):
#   1. Preflight: gh authed with repo+workflow scopes; a GitHub repo in cwd.
#   2. Detect your package ecosystems, your CI workflow name, and the
#      claude-code-action pin your repo already runs (a reinstall keeps it
#      when it is newer than dep-steward's — never a downgrade).
#   3. Render the pipeline into .github/ (workflow, prompts, dependabot.yml,
#      gate, review lint, and the autofix bounds check unless --no-autofix).
#   4. Create the `needs-human-review` label.
#   5. Set CLAUDE_CODE_OAUTH_TOKEN in BOTH the Actions and Dependabot stores,
#      and, when given, dep-steward's GitHub App (client ID + private key) in
#      the Actions store, so autofix's fixes start CI by themselves.
#   6. Enable auto-merge on the repo.
#   7. Check branch protection and advise (never mutates protection rules).
#
# Flags:
#   --dry-run            show every change without making it
#   --ci-name NAME       the CI workflow whose green status gates merges
#   --model NAME         Claude model for the review job (default below)
#   --app-client-id ID --app-private-key-file FILE
#                        a GitHub App on this repo for autofix to push as
#   --render-only --out DIR   render those files to DIR and stop (no gh)
#
# It writes files and (label/secret/setting) via `gh`. It never touches your
# source, your existing CI workflow, branch-protection rules, or git history.

set -eu
CDPATH=''

# Frontier Opus by default. A prior build downgraded to claude-opus-4-7 on the theory
# that claude-opus-4-8 was "unreachable via OAuth" — that was a misdiagnosis. The
# $0-cost / is_error first-turn failure was an invalid/expired CLAUDE_CODE_OAUTH_TOKEN
# returning "401 Invalid bearer token", identical across every model; the token was
# the fault, not the model (which is why the installer now verifies the token below).
# Keep the frontier default.
DEFAULT_MODEL='claude-opus-4-8'

# The anthropics/claude-code-action pin a FIRST install gets. After that, the
# installed repo's own Dependabot owns it: the github-actions ecosystem in the
# rendered dependabot.yml bumps it every week, through the pipeline's own gate,
# and none of those bumps ever reach this file (Dependabot scans the repo's
# .github/workflows/, not dep-steward's templates/). So this is a floor for new
# installs, never a value to write over a repo's newer one — see
# resolve_action_pins. Raising it is a separate, deliberate change.
TEMPLATE_ACTION_REF='1623c36729ac1cd5895198cded705a287de7db79'
TEMPLATE_ACTION_VERSION='v1.0.187'
# The actions/create-github-app-token pin a first install gets, for the token
# the autofix job pushes with when the repo has dep-steward's App. Owned by the
# repo afterwards, exactly like the claude-code-action pin above.
TEMPLATE_APP_TOKEN_REF='bcd2ba49218906704ab6c1aa796996da409d3eb1'
TEMPLATE_APP_TOKEN_VERSION='v3.2.0'
REPO_URL='https://github.com/raphaelcm/dep-steward'
GATE_PATH='.github/dependabot-automerge/gate.cjs'
REVIEW_LINT_PATH='.github/dependabot-automerge/review-lint.cjs'
AUTOFIX_BOUNDS_PATH='.github/dependabot-automerge/autofix-bounds.cjs'
AUTOFIX_PROMPT_PATH='.github/dependabot-autofix-prompt.md'
LABEL='needs-human-review'
SECRET='CLAUDE_CODE_OAUTH_TOKEN'
APP_CLIENT_ID_SECRET='DEP_STEWARD_APP_CLIENT_ID'
APP_KEY_SECRET='DEP_STEWARD_APP_PRIVATE_KEY'

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
APP_CLIENT_ID=''
APP_KEY_FILE=''

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
  --app-client-id ID --app-private-key-file FILE
                       optional, autofix only: a GitHub App installed on this
                       repo (Contents: read and write). Autofix pushes its fixes
                       as the App, so CI runs on them by itself; without one, you
                       start CI on a fix by hand. Stored in the Actions store.
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
    --app-client-id) APP_CLIENT_ID="${2:-}"; shift ;;
    --app-client-id=*) APP_CLIENT_ID="${1#--app-client-id=}" ;;
    --app-private-key-file) APP_KEY_FILE="${2:-}"; shift ;;
    --app-private-key-file=*) APP_KEY_FILE="${1#--app-private-key-file=}" ;;
    -h|--help) usage ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
  shift
done

# Resolved now, while a relative path still means what the caller typed: a
# full install moves to the repo root before it reads the key.
case "$APP_KEY_FILE" in
  ''|/*) : ;;
  *) APP_KEY_FILE="$(pwd)/$APP_KEY_FILE" ;;
esac

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

# Which gate refusal codes escalate to a human. `ci_failed` belongs to exactly
# ONE owner, decided here rather than at runtime: when CI goes red, the autofix
# job and the auto-merge gate wake from the SAME workflow_run event and run in
# parallel, so if both could escalate you would be paged about a red build the
# fixer is already fixing. With autofix on, autofix owns it (and escalates
# deterministically when it declines, rather than relying on the agent to label
# itself). With autofix off, nothing else is watching CI, so the gate owns it.
# Only the taken branch is rendered — the workflow carries no conditional.
if [ "$AUTOFIX" -eq 1 ]; then
  ESCALATABLE_CODES='paths_not_whitelisted|verdict_malformed'
  ESCALATABLE_NOTE='ci_failed is absent: the autofix job owns it. It wakes on this same event and escalates itself when it cannot fix the build.'
else
  ESCALATABLE_CODES='paths_not_whitelisted|verdict_malformed|ci_failed'
  ESCALATABLE_NOTE='ci_failed IS here: autofix is off, so no other job is watching CI and a red build would otherwise strand silently.'
fi

# ---- action pins (the installed repo owns them) ----------------------------
# Two actions are pinned by SHA and reach the templates through placeholders:
# anthropics/claude-code-action in both agent jobs (__REVIEW_ACTION_PIN__,
# __AUTOFIX_ACTION_PIN__) and actions/create-github-app-token, which mints the
# autofix push token (__APP_TOKEN_ACTION_PIN__). After a first install the
# repo's own Dependabot moves both, so each is resolved per job from the
# workflow the repo already has:
#
#   no existing workflow, or no pin in it   the template's pin
#   an existing pin                          whichever is newer, compared on the
#                                            `# vX.Y.Z` comment Dependabot keeps
#                                            beside the SHA
#   a version that cannot be compared       the existing pin, and a warning
#
# Seen live: a repo on v1.0.230, merged through its own gate that day, would
# have been moved back to v1.0.187 — 43 releases — by a plain reinstall: an
# older action and Claude Code than it had vetted, the same bump reopened the
# next Monday on a PR the reviewer cannot review (it edits this workflow), and
# the review-lint hook on a runtime it was never tested against. A reinstall
# must never go backwards, so when in doubt the repo's pin wins.
EXISTING_WORKFLOW='.github/workflows/dependabot-review.yml'
REVIEW_ACTION_PIN="$TEMPLATE_ACTION_REF # $TEMPLATE_ACTION_VERSION"
AUTOFIX_ACTION_PIN="$REVIEW_ACTION_PIN"
APP_TOKEN_ACTION_PIN="$TEMPLATE_APP_TOKEN_REF # $TEMPLATE_APP_TOKEN_VERSION"
REVIEW_PIN_NOTE=''
AUTOFIX_PIN_NOTE=''
APP_TOKEN_PIN_NOTE=''

# The first pin of <owner/action> in each job of an existing workflow, as one
# "<job><TAB><ref><TAB><version comment>" line per job ("-" for a pin outside
# any job it can name). Line-oriented like the rest of this installer — no YAML
# parser: jobs are the two-space keys under `jobs:`, which is how every version
# of this workflow has been laid out. <owner/action> becomes part of a regex, so
# it must stay within [A-Za-z0-9/_-], as both callers' names do.
existing_action_pins() { # existing_action_pins <workflow> <owner/action>
  awk -v q="'" -v action="$2" '
    BEGIN { pat = "^[ \t]*(-[ \t]+)?uses:[ \t]*[\"" q "]?" action "@" }
    { sub(/\r$/, "") }
    /^jobs:[ \t]*(#.*)?$/ { injobs = 1; job = ""; next }
    injobs && /^[^ \t#]/ { injobs = 0 }
    injobs && /^  [A-Za-z0-9_-]+:[ \t]*(#.*)?$/ { job = $0; sub(/^  /, "", job); sub(/:.*$/, "", job); next }
    $0 ~ pat {
      label = (injobs && job != "") ? job : "-"
      if (label in seen) next
      seen[label] = 1
      rest = $0; sub(pat, "", rest)
      comment = ""
      h = index(rest, "#")
      if (h > 0) { comment = substr(rest, h + 1); rest = substr(rest, 1, h - 1) }
      gsub(/[ \t"]/, "", rest); gsub(q, "", rest)
      gsub(/\t/, " ", comment)   # the fields travel tab-separated
      sub(/^[ \t]+/, "", comment); sub(/[ \t]+$/, "", comment)
      printf "%s\t%s\t%s\n", label, rest, comment
    }
  ' "$1"
}

pin_for_job() { # pin_for_job <job> <existing_action_pins output>
  printf '%s\n' "$2" | awk -v j="$1" 'BEGIN { FS = "\t" } $1 == j { print; exit }'
}

# "X.Y.Z" from a "vX.Y.Z" or "X.Y.Z" version comment; nothing for anything else.
version_of() {
  printf '%s\n' "$1" | sed -n 's/^v\{0,1\}\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)$/\1/p'
}

# -1, 0 or 1 as the first X.Y.Z is older than, equal to, or newer than the second.
version_cmp() {
  awk -v a="$1" -v b="$2" 'BEGIN {
    split(a, x, "."); split(b, y, ".")
    for (i = 1; i <= 3; i++) {
      if (x[i] + 0 > y[i] + 0) { print 1; exit }
      if (x[i] + 0 < y[i] + 0) { print -1; exit }
    }
    print 0
  }'
}

# pick_action_pin <owner/action> <job> <template ref> <template version>
#                 <a pin line, or empty> <why there is no pin>
# Sets PICKED_PIN (the text after "<owner/action>@") and PICKED_NOTE (the line
# every run prints, naming the action by its last path segment).
pick_action_pin() {
  _action="$1"; _name="${1##*/}"; _job="$2"; _tref="$3"; _tver="$4"
  if [ -z "$5" ]; then
    PICKED_PIN="$_tref # $_tver"
    PICKED_NOTE="$_name ($_job job): using the template's $_tver ($6)"
    return 0
  fi
  _ref=$(printf '%s\n' "$5" | cut -f2)
  _comment=$(printf '%s\n' "$5" | cut -f3)
  PICKED_PIN="$_ref"
  if [ -n "$_comment" ]; then PICKED_PIN="$_ref # $_comment"; fi
  _have=$(version_of "$_comment")
  _tmpl=$(version_of "$_tver")
  if [ -z "$_have" ] || [ -z "$_tmpl" ]; then
    # Keep the repo's pin: it is the one its gate merged, and a guess in either
    # direction could be a downgrade.
    if [ -n "$_comment" ]; then _label="\"$_comment\""; else _label="@$_ref"; fi
    PICKED_NOTE="$_name ($_job job): keeping $_label from the existing workflow (not comparable with the template's $_tver)"
    warn "$_name ($_job job): the existing pin's version, $_label, cannot be compared with the template's $_tver (expected a '# vX.Y.Z' comment), so the existing pin is kept. Check it by hand: $_action@$PICKED_PIN"
    return 0
  fi
  if [ "$(version_cmp "$_have" "$_tmpl")" = "-1" ]; then
    PICKED_PIN="$_tref # $_tver"
    PICKED_NOTE="$_name ($_job job): upgrading $_comment to the template's $_tver"
  else
    PICKED_NOTE="$_name ($_job job): keeping $_comment from the existing workflow (template has $_tver)"
  fi
}

# Resolve every rendered occurrence: the review job always, the autofix job
# (its claude-code-action and its push-token action) when autofix is on. Reads
# the workflow relative to the current directory, so callers run it where the
# target repo is: before any emit, which may write over that same file.
resolve_action_pins() {
  _cca=''
  _tok=''
  _cca_none='no existing workflow'
  _tok_none='no existing workflow'
  if [ -f "$EXISTING_WORKFLOW" ]; then
    _cca=$(existing_action_pins "$EXISTING_WORKFLOW" anthropics/claude-code-action)
    _tok=$(existing_action_pins "$EXISTING_WORKFLOW" actions/create-github-app-token)
    _cca_none='the existing workflow has no claude-code-action pin'
    _tok_none='the existing workflow has no create-github-app-token pin'
  fi
  # A job's own pin first. A job this install adds — autofix turned on after a
  # --no-autofix install — has none of its own, and takes the pin the repo
  # already runs rather than the template's, so the two agent jobs never run
  # different action versions.
  _any=$(printf '%s\n' "$_cca" | awk 'NF { print; exit }')
  _line=$(pin_for_job review "$_cca")
  pick_action_pin anthropics/claude-code-action review "$TEMPLATE_ACTION_REF" "$TEMPLATE_ACTION_VERSION" "${_line:-$_any}" "$_cca_none"
  REVIEW_ACTION_PIN="$PICKED_PIN"
  REVIEW_PIN_NOTE="$PICKED_NOTE"
  if [ "$AUTOFIX" -eq 1 ]; then
    _line=$(pin_for_job autofix "$_cca")
    pick_action_pin anthropics/claude-code-action autofix "$TEMPLATE_ACTION_REF" "$TEMPLATE_ACTION_VERSION" "${_line:-$_any}" "$_cca_none"
    AUTOFIX_ACTION_PIN="$PICKED_PIN"
    AUTOFIX_PIN_NOTE="$PICKED_NOTE"
    # The push token's action lives in the autofix job alone.
    _line=$(pin_for_job autofix "$_tok")
    pick_action_pin actions/create-github-app-token autofix "$TEMPLATE_APP_TOKEN_REF" "$TEMPLATE_APP_TOKEN_VERSION" "$_line" "$_tok_none"
    APP_TOKEN_ACTION_PIN="$PICKED_PIN"
    APP_TOKEN_PIN_NOTE="$PICKED_NOTE"
  fi
}

# Printed on every run: --render-only, --dry-run and a real install alike.
report_action_pins() { # report_action_pins <say|info>
  "$1" "$REVIEW_PIN_NOTE"
  if [ "$AUTOFIX" -eq 1 ]; then
    "$1" "$AUTOFIX_PIN_NOTE"
    "$1" "$APP_TOKEN_PIN_NOTE"
  fi
}

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

# For a value substituted into a `s|…|…|` replacement that came from a file in
# the target repo rather than from this installer: `\`, `&` and the `|`
# delimiter must arrive as themselves.
sed_escape() { printf '%s\n' "$1" | sed 's/[\\&|]/\\&/g'; }

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
  # ESCALATABLE_CODES contains `|` (it renders a shell `case` pattern), so that
  # one substitution needs a delimiter the value cannot contain.
  inject '#__AUTOFIX_JOB__' "$frag" < "$SRC/templates/dependabot-review.yml" \
    | sed -e "s|__CI_NAME__|$CI_NAME|g" \
          -e "s|__CI_RUNLIST__|$crt|g" \
          -e "s|__MODEL__|$MODEL|g" \
          -e "s|__GATE_PATH__|$GATE_PATH|g" \
          -e "s|__REVIEW_LINT_PATH__|$REVIEW_LINT_PATH|g" \
          -e "s|__REVIEW_ACTION_PIN__|$(sed_escape "$REVIEW_ACTION_PIN")|g" \
          -e "s|__AUTOFIX_ACTION_PIN__|$(sed_escape "$AUTOFIX_ACTION_PIN")|g" \
          -e "s|__APP_TOKEN_ACTION_PIN__|$(sed_escape "$APP_TOKEN_ACTION_PIN")|g" \
          -e "s|__ESCALATABLE_NOTE__|$ESCALATABLE_NOTE|g" \
          -e "s,__ESCALATABLE_CODES__,$ESCALATABLE_CODES,g" \
          -e "s|__ASSIGN_FLAG__|$ASSIGN_FLAG|g"
}

render_gate() {
  inject '//__PREFIXES__' "$GROUP_PREFIXES" < "$SRC/templates/gate.cjs" \
    | inject '//__WL_EXACT__' "$WL_EXACT" \
    | inject '//__WL_REGEX__' "$WL_REGEX"
}

# The reviewer's prose lint: static, and NOT autofix-conditional — it is the
# review job's guard, wired as a PreToolUse hook through the review step's
# `settings` input and re-run over the posted comment by the deliverable
# assertion. Both callers name it by REVIEW_LINT_PATH, so the path has one
# source.
render_review_lint() { cat "$SRC/templates/review-lint.cjs"; }

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
  # Before any emit: --out may be the target repo itself, and the pin has to be
  # read from the workflow before the render replaces it.
  resolve_action_pins
  emit render_dependabot_yml "$OUT/.github/dependabot.yml"
  emit render_prompt          "$OUT/.github/dependabot-review-prompt.md"
  emit render_workflow        "$OUT/.github/workflows/dependabot-review.yml"
  emit render_gate            "$OUT/$GATE_PATH"
  emit render_review_lint     "$OUT/$REVIEW_LINT_PATH"
  if [ "$AUTOFIX" -eq 1 ]; then
    emit render_autofix_prompt "$OUT/$AUTOFIX_PROMPT_PATH"
    emit render_autofix_bounds "$OUT/$AUTOFIX_BOUNDS_PATH"
  fi
  report_action_pins say
  say "Rendered to $OUT (ecosystems: $ACTIVE; ci: $CI_NAME; model: $MODEL; assignee: ${ASSIGNEE:-none}; autofix: $([ "$AUTOFIX" -eq 1 ] && echo on || echo off))"
  if [ -n "$APP_CLIENT_ID$APP_KEY_FILE" ]; then
    warn "--render-only writes files only; the App's secrets are stored by a full install, so --app-client-id and --app-private-key-file were ignored."
  fi
  exit 0
fi

# ---- dep-steward's GitHub App: checked before anything is touched ----------
if [ -n "$APP_CLIENT_ID" ] || [ -n "$APP_KEY_FILE" ]; then
  { [ -n "$APP_CLIENT_ID" ] && [ -n "$APP_KEY_FILE" ]; } \
    || die "--app-client-id and --app-private-key-file go together: the App's Client ID, and the .pem its settings page generates"
  [ -r "$APP_KEY_FILE" ] || die "cannot read the App's private key: $APP_KEY_FILE"
  grep -q 'PRIVATE KEY-----' "$APP_KEY_FILE" \
    || die "$APP_KEY_FILE is not a PEM private key (the App's settings page -> Generate a private key)"
  if [ "$AUTOFIX" -eq 0 ]; then
    warn "not storing the App's secrets: only the autofix job uses them, and --no-autofix is set."
    APP_CLIENT_ID=''
    APP_KEY_FILE=''
  fi
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

# ---- resolve the claude-code-action pin (the repo's own, when newer) -------
# Here, at the repo root and before the render: the existing workflow is read
# from the same tree the new one is written into.
resolve_action_pins

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
if [ "$AUTOFIX" -eq 1 ]; then
  # Whether CI starts on a fix by itself depends on who pushes it.
  if [ -n "$APP_CLIENT_ID" ]; then
    APP_NOTE='as your GitHub App (CI runs on each fix by itself)'
  elif ! _secrets=$(gh secret list --repo "$NWO" --json name --jq '.[].name' 2>/dev/null); then
    # Listing needs admin; "no App" would be a guess.
    APP_NOTE="could not read this repo's secrets, so whether fixes are pushed as a GitHub App (and start CI by themselves) is unknown"
  elif printf '%s\n' "$_secrets" | grep -qxF "$APP_CLIENT_ID_SECRET" \
       && printf '%s\n' "$_secrets" | grep -qxF "$APP_KEY_SECRET"; then
    APP_NOTE='as your GitHub App (its secrets are already set)'
  else
    APP_NOTE='with GITHUB_TOKEN, so you start CI on each fix by hand (--app-client-id and --app-private-key-file change that)'
  fi
  info "autofix push: $APP_NOTE"
fi
report_action_pins info
say ""

# ---- render (to a temp tree first, for dry-run diffing) --------------------
STAGE=$(mktemp -d)
emit render_dependabot_yml "$STAGE/.github/dependabot.yml"
emit render_prompt          "$STAGE/.github/dependabot-review-prompt.md"
emit render_workflow        "$STAGE/.github/workflows/dependabot-review.yml"
emit render_gate            "$STAGE/$GATE_PATH"
emit render_review_lint     "$STAGE/$REVIEW_LINT_PATH"

FILES=".github/dependabot.yml .github/dependabot-review-prompt.md .github/workflows/dependabot-review.yml $GATE_PATH $REVIEW_LINT_PATH"
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
  if [ -n "$APP_CLIENT_ID" ]; then
    info "gh secret set $APP_CLIENT_ID_SECRET     (Actions store only)"
    info "gh secret set $APP_KEY_SECRET   (Actions store only)"
  fi
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
# The single worst install outcome is storing a token that does not work: the
# pipeline then fails three steps later, in CI, with an opaque "no verdict" — the
# real "401 Invalid bearer token" buried in a runner file that is never uploaded.
# (That exact rabbit hole cost hours to diagnose once.) So we VERIFY the token
# authenticates before storing it, so a bad one fails HERE, legibly, at install
# time. The check needs the `claude` CLI — the same tool that mints the token —
# so when it is absent we can only say we couldn't check.
# token_authenticates <token> -> 0 authenticates, 1 rejected (401), 2 cannot check.
token_authenticates() {
  command -v claude >/dev/null 2>&1 || return 2
  _probe=$(CLAUDE_CODE_OAUTH_TOKEN="$1" claude -p 'reply with the single word OK' </dev/null 2>&1 || true)
  case "$_probe" in
    *'Invalid bearer token'*|*authentication_error*) return 1 ;;
    *) return 0 ;;
  esac
}

TOKEN="${CLAUDE_CODE_OAUTH_TOKEN:-}"
# A token from the environment is verified too — a stale/expired paste is the most
# common trap, and looks identical to a good one until CI rejects it hours later.
if [ -n "$TOKEN" ]; then
  token_authenticates "$TOKEN" && _rc=0 || _rc=$?
  if [ "${_rc:-0}" -eq 1 ]; then
    warn "CLAUDE_CODE_OAUTH_TOKEN from the environment is invalid (401 Invalid bearer token) — ignoring it."
    TOKEN=''
  fi
fi

if [ -z "$TOKEN" ] && [ -t 0 ]; then
  # `claude setup-token` is interactive by design (browser OAuth) and prints the
  # token for manual copy, so we launch it inline and read the token back here.
  # Up to 3 attempts: mint or paste, then verify; a rejected token re-prompts
  # instead of being silently stored to fail opaquely in CI later.
  _tries=0
  while [ "$_tries" -lt 3 ]; do
    _tries=$((_tries + 1))
    if command -v claude >/dev/null 2>&1; then
      printf 'Mint a token now with claude setup-token? [Y/n] '
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
    [ -z "$TOKEN" ] && { warn "no token entered."; continue; }
    token_authenticates "$TOKEN" && _rc=0 || _rc=$?
    if [ "${_rc:-0}" -eq 0 ]; then
      info "token verified — it authenticates."
      break
    elif [ "${_rc:-0}" -eq 2 ]; then
      info "can't verify locally without the claude CLI — trusting the pasted token."
      break
    else
      warn "that token failed to authenticate (401 Invalid bearer token). Try again."
      TOKEN=''
    fi
  done
fi
if [ -n "$TOKEN" ]; then
  # Piped, with NO --body: gh reads the value from stdin only when --body is
  # absent, and stores a non-empty --body verbatim. `--body -` therefore stored
  # the one-character string "-" in both stores, never the token verified above.
  if printf '%s' "$TOKEN" | gh secret set "$SECRET" --repo "$NWO" >/dev/null; then
    info "set $SECRET (Actions store)"
  else
    warn "could not set $SECRET (Actions store)"
  fi
  if printf '%s' "$TOKEN" | gh secret set "$SECRET" --repo "$NWO" --app dependabot >/dev/null; then
    info "set $SECRET (Dependabot store)"
  else
    warn "could not set $SECRET (Dependabot store)"
  fi
else
  warn "no CLAUDE_CODE_OAUTH_TOKEN provided — set it in BOTH stores yourself:"
  info "gh secret set $SECRET --repo $NWO"
  info "gh secret set $SECRET --repo $NWO --app dependabot"
fi

# ---- dep-steward's GitHub App (optional; autofix only) ---------------------
# With it, autofix pushes its fix as the App and CI runs on the fix by itself;
# without it, the push uses GITHUB_TOKEN and the PR says how to start CI by
# hand. The ACTIONS store only: the one reader is the autofix job, which runs on
# workflow_run, and a workflow_run run reads the Actions store even when
# Dependabot started the CI run behind it (its "Set up job" log says "Secret
# source: Actions"). A copy in the Dependabot store would never be read.
if [ -n "$APP_CLIENT_ID" ]; then
  if printf '%s' "$APP_CLIENT_ID" | gh secret set "$APP_CLIENT_ID_SECRET" --repo "$NWO" >/dev/null; then
    info "set $APP_CLIENT_ID_SECRET (Actions store)"
  else
    warn "could not set $APP_CLIENT_ID_SECRET (Actions store)"
  fi
  if gh secret set "$APP_KEY_SECRET" --repo "$NWO" <"$APP_KEY_FILE" >/dev/null; then
    info "set $APP_KEY_SECRET (Actions store)"
  else
    warn "could not set $APP_KEY_SECRET (Actions store)"
  fi
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
