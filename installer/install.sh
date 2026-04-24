#!/usr/bin/env sh
# chrome-mcp installer for macOS and Linux.
# Usage: curl -fsSL https://chrome-mcp.actuallyroy.com/install.sh | sh

set -eu

ENDPOINT="${CHROME_MCP_ENDPOINT:-https://chrome-mcp.actuallyroy.com}"
INSTALL_DIR="${CHROME_MCP_CACHE_DIR:-$HOME/.chrome-mcp}"
BIN_DIR="$INSTALL_DIR/bin"
SCRIPTS_DIR="$INSTALL_DIR/scripts"

have() { command -v "$1" >/dev/null 2>&1; }

if ! have node; then
  echo "chrome-mcp: node is required (≥18). Install via https://nodejs.org or brew/apt." >&2
  exit 1
fi

NODE_MAJOR="$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "chrome-mcp: node $NODE_MAJOR is too old. Need ≥18 (for global fetch)." >&2
  exit 1
fi

mkdir -p "$BIN_DIR" "$SCRIPTS_DIR"

echo "chrome-mcp: downloading loader → $INSTALL_DIR/loader.mjs"
curl -fsSL "$ENDPOINT/loader.mjs" -o "$INSTALL_DIR/loader.mjs"

echo "chrome-mcp: downloading launch-chrome.sh → $SCRIPTS_DIR/launch-chrome.sh"
curl -fsSL "$ENDPOINT/scripts/launch-chrome.sh" -o "$SCRIPTS_DIR/launch-chrome.sh"
chmod +x "$SCRIPTS_DIR/launch-chrome.sh"

# Bin shim.
cat > "$BIN_DIR/chrome-mcp" <<'EOF'
#!/usr/bin/env sh
exec node "$(dirname "$0")/../loader.mjs" "$@"
EOF
chmod +x "$BIN_DIR/chrome-mcp"

# Convenience alias for launching Chrome.
cat > "$BIN_DIR/chrome-mcp-launch-chrome" <<EOF
#!/usr/bin/env sh
exec "$SCRIPTS_DIR/launch-chrome.sh" "\$@"
EOF
chmod +x "$BIN_DIR/chrome-mcp-launch-chrome"

# Primary health check — fetch manifest so we fail loudly if the endpoint is wrong.
MANIFEST="$(curl -fsSL "$ENDPOINT/bundle/manifest.json" || true)"
if [ -z "$MANIFEST" ]; then
  echo "chrome-mcp: warning — could not fetch $ENDPOINT/bundle/manifest.json. Loader will retry at runtime." >&2
fi

cat <<EOF

================================================================
 chrome-mcp installed at $INSTALL_DIR
 Binary:          $BIN_DIR/chrome-mcp
 Chrome launcher: $BIN_DIR/chrome-mcp-launch-chrome
================================================================

Next steps:

1) Launch Chrome with remote debugging (in a separate terminal):

   $BIN_DIR/chrome-mcp-launch-chrome

2) Add this to ~/.claude.json (or your project's .mcp.json):

   {
     "mcpServers": {
       "chrome": {
         "command": "$BIN_DIR/chrome-mcp"
       }
     }
   }

3) Restart Claude Code.

Pin a version:     export CHROME_MCP_PIN_VERSION=0.2.0
Disable updates:   export CHROME_MCP_SKIP_UPDATE=1

EOF
