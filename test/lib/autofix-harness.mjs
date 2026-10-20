import { execFileSync } from 'node:child_process';

/**
 * Pieces the tests that RUN the rendered autofix jobs share: the stub that
 * answers the two token endpoints the push job calls, and git kept away from
 * the developer's own configuration.
 */

export const WORKFLOW_TOKEN = 'ghs_workflowTokenOfThisRun0000001';
export const CLAUDE_APP_TOKEN = 'ghs_claudeAppInstallationToken02';
export const OIDC_REQUEST_URL = 'https://pipelines.actions.test/idtoken/1?api-version=2.0';
export const OIDC_REQUEST_TOKEN = 'oidc-request-token-3';
export const OIDC_JWT = 'eyJoidcJwtOfThisJob4';
export const GITHUB_API_URL = 'https://api.github.test';

// The two token endpoints, as GitHub and Anthropic answer them, plus the
// revoke. Every call is logged with the step that made it ($GITHUB_ACTION),
// so a test can say which step asked for a token, and when.
export const CURL_STUB = `#!/usr/bin/env bash
# curl reads ~/.curlrc (or $CURL_HOME/.curlrc) unless -q is its FIRST argument.
# One that names a proxy sends the request, credentials and all, there.
if [ "\${1:-}" != -q ] && grep -qs '^proxy' "\${CURL_HOME:-$HOME}/.curlrc"; then
  printf '%s\\tDIVERTED\\t%s\\t\\t\\n' "\${GITHUB_ACTION:-}" "$*" >> "$CURL_LOG"
  exit 7
fi
[ "\${1:-}" = -q ] && shift
method=GET; url=''; auth=''; ctype=''; body=''
while [ $# -gt 0 ]; do
  case "$1" in
    -X) method="$2"; shift ;;
    -H) case "$2" in [Aa]uthorization:*) auth="\${2#*: }" ;; [Cc]ontent-[Tt]ype:*) ctype="\${2#*: }" ;; esac; shift ;;
    -d|--data|--data-raw) body="$2"; shift ;;
    -o) shift ;;
    -*) ;;
    *) url="$1" ;;
  esac
  shift
done
printf '%s\\t%s\\t%s\\t%s\\t%s\\n' "\${GITHUB_ACTION:-}" "$method" "$url" "$auth" "$body" >> "$CURL_LOG"
case "$url" in
  "$ACTIONS_ID_TOKEN_REQUEST_URL"*)
    [ "$auth" = "Bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" ] || { echo '{"message":"Bad credentials"}'; exit 22; }
    printf '{"count":1,"value":"%s"}' "$OIDC_JWT" ;;
  https://api.anthropic.com/api/github/github-app-token-exchange)
    if [ "$EXCHANGE" = fails ]; then printf '{"error":{"message":"Claude Code is not installed on this repository"}}'; exit 22; fi
    { [ "$method" = POST ] && [ "$auth" = "Bearer $OIDC_JWT" ]; } || { printf '{"error":{"message":"invalid OIDC token"}}'; exit 22; }
    # A scope is asked for the way claude-code-action asks for one: a JSON
    # \`permissions\` body. EXCHANGE=narrow-refused is an endpoint that grants
    # only its default scope.
    if [ -n "$body" ]; then
      [ "$ctype" = application/json ] || { printf '{"error":{"message":"expected a JSON body"}}'; exit 22; }
      [ "$EXCHANGE" = narrow-refused ] && { printf '{"error":{"message":"Invalid permissions requested"}}'; exit 22; }
    fi
    printf '{"token":"%s"}' "$CLAUDE_APP_TOKEN" ;;
  "$GITHUB_API_URL/installation/token")
    [ "$method" = DELETE ] || exit 22 ;;
  *) echo "curl stub: unexpected URL $url" >&2; exit 2 ;;
esac
`;

// Keep the developer's own git config (credential helpers, above all) out of it.
export const GIT_ISOLATION = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never',
};

export const git = (args, cwd) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, ...GIT_ISOLATION } });

