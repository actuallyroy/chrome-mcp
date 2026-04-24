#!/usr/bin/env bash
# Launches Chrome with remote debugging enabled so chrome-mcp can attach.
#
# Uses a DEDICATED profile at ~/ChromeMCP-Profile by default. This is required:
# modern Chrome refuses --remote-debugging-port on the default user profile
# ("DevTools remote debugging requires a non-default data directory").
#
# Because we use a dedicated profile, this can run alongside your normal Chrome.
# First launch creates an empty profile — sign into the sites you want to drive,
# and those logins persist.

set -euo pipefail

PORT="${CHROME_DEBUG_PORT:-9222}"
PROFILE="${CHROME_USER_DATA_DIR:-$HOME/ChromeMCP-Profile}"
CHROME_BIN="${CHROME_BIN:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"

# Abort only if a Chrome is already using THIS profile or THIS port — not if
# your normal Chrome is open on its own profile.
if lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port $PORT is already in use. Either another Chrome debug session is running," >&2
  echo "or you need to pick a different CHROME_DEBUG_PORT." >&2
  exit 1
fi
if pgrep -f "user-data-dir=$PROFILE" >/dev/null; then
  echo "A Chrome instance is already running against profile $PROFILE." >&2
  exit 1
fi

mkdir -p "$PROFILE"

echo "Launching Chrome with remote debugging on port $PORT..."
echo "Profile: $PROFILE"
exec "$CHROME_BIN" \
  --remote-debugging-port="$PORT" \
  --user-data-dir="$PROFILE"
