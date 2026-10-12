#!/bin/sh
# The dep-steward installer lives at plugin/install.sh. This file forwards there
# so install commands published before the move keep working.
set -eu
here=$(cd -- "$(dirname -- "$0")" 2>/dev/null && pwd) || here=''
if [ -n "$here" ] && [ -f "$here/plugin/install.sh" ]; then
  exec sh "$here/plugin/install.sh" "$@"
fi
exec sh -c "$(curl -fsSL https://raw.githubusercontent.com/raphaelcm/dep-steward/main/plugin/install.sh)" -- "$@"
