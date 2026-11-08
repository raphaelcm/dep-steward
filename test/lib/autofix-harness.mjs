import { execFileSync } from 'node:child_process';

/**
 * Pieces the tests that RUN the rendered autofix jobs share: the tokens, a
 * curl that records any request a step makes (none should), and git kept away
 * from the developer's own configuration.
 */

export const WORKFLOW_TOKEN = 'ghs_workflowTokenOfThisRun0000001';
// The repo's DEP_STEWARD_PUSH_TOKEN secret: a fine-grained token its owner set.
export const PUSH_TOKEN = 'github_pat_ownersPushToken0000002';
export const GITHUB_API_URL = 'https://api.github.test';

// Every call is logged with the step that made it ($GITHUB_ACTION) and the
// credential it carried, then refused: no step of these jobs needs curl.
export const CURL_STUB = `#!/usr/bin/env bash
[ "\${1:-}" = -q ] && shift
method=GET; url=''; auth=''
while [ $# -gt 0 ]; do
  case "$1" in
    -X) method="$2"; shift ;;
    -H) case "$2" in [Aa]uthorization:*) auth="\${2#*: }" ;; esac; shift ;;
    -d|--data|--data-raw|-o) shift ;;
    -*) ;;
    *) url="$1" ;;
  esac
  shift
done
printf '%s\\t%s\\t%s\\t%s\\n' "\${GITHUB_ACTION:-}" "$method" "$url" "$auth" >> "$CURL_LOG"
echo "curl stub: unexpected request to $url" >&2
exit 2
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

