# chrome-mcp

An MCP server that drives your **real** Chrome browser — your profile, your logins, your extensions. It attaches over the Chrome DevTools Protocol (CDP); it does not launch Chromium.

Distributed via [chrome-mcp.actuallyroy.com](https://chrome-mcp.actuallyroy.com). The site hosts the bundled server + a tiny loader that handles install, updates, and SHA-256 tamper detection.

## For users

**One step.** Paste into `~/.claude.json` (or `.mcp.json` in your project) and restart Claude Code. The exact block is on the [landing page](https://chrome-mcp.actuallyroy.com) with the correct bootstrap inlined. In shape:

```json
{
  "mcpServers": {
    "chrome": {
      "command": "node",
      "args": ["-e", "<short bootstrap that fetches loader.mjs on first run>"]
    }
  }
}
```

Requires Node ≥18.

**What happens:**
1. First launch: bootstrap downloads `~/.chrome-mcp/loader.mjs`, loader fetches the latest bundle, verifies its SHA-256, caches it, executes it.
2. First tool call: MCP tries to connect to `localhost:9222` — not there? It spawns Chrome with `--remote-debugging-port=9222` on a dedicated profile at `~/ChromeMCP-Profile`. A Chrome window pops up.
3. You sign into whatever sites once. The profile persists.
4. Subsequent runs: Chrome is already up, bundle is cached, tools just work.

The dedicated profile coexists with your normal Chrome — we never touch your main profile.

**Power-user install** (skips the bootstrap, writes the loader directly):
```bash
curl -fsSL https://chrome-mcp.actuallyroy.com/install.sh | sh      # macOS / Linux
irm https://chrome-mcp.actuallyroy.com/install.ps1 | iex           # Windows
```
This gives you `~/.chrome-mcp/bin/chrome-mcp` as a persistent binary you can reference directly in `.mcp.json` instead of the `node -e` form. Only reason to prefer this: faster cold start (skips the bootstrap's fetch check).

### Updates

The loader checks the endpoint on every launch, downloads a newer bundle if one exists, verifies its SHA-256, and uses the cached copy if the network is unreachable. Controls (env vars):

- `CHROME_MCP_PIN_VERSION=0.2.0` — pin to a specific version, skip update checks
- `CHROME_MCP_SKIP_UPDATE=1` — use cached bundle, skip network
- `CHROME_MCP_ENDPOINT=https://…` — override the origin (for self-hosting)
- `CHROME_MCP_CACHE_DIR=/path` — override the cache location

### Tools

Locator-taking tools accept `{ ref, text, label, selector }` — refs come from `outline` and stay stable across calls.

- **Inspection**: `outline`, `describe`, `screenshot`, `snapshot`, `get_text`, `get_html`, `get_url`, `get_title`, `get_attribute`
- **Interaction**: `click`, `fill`, `fill_form`, `select_option`, `press`, `type`, `hover`, `scroll`
- **Capture**: `get_toasts`, `wait_for_toast`, `get_console`, `get_network`
- **Navigation**: `navigate`, `go_back`, `go_forward`, `reload`, `wait_for_navigation`, `wait_for_selector`
- **Tabs**: `list_tabs`, `select_tab`, `new_tab`, `close_tab`
- **Debug**: `pause`, `resume`, `inject_script`, `evaluate`
- **Flows**: `start_recording`, `stop_recording`, `recording_status`, `run_script`, `assert`
- **Cookies**: `get_cookies`, `set_cookies`

See [`examples/demo.flow.json`](./examples/demo.flow.json) for a sample `run_script` flow.

---

## For contributors

### Repo layout

```
.
├── app/                   # Next.js landing page + /api/version
├── loader/loader.mjs      # zero-dep Node loader shipped to users
├── installer/             # install.sh, install.ps1
├── mcp-server/            # the actual MCP server (TypeScript)
│   ├── src/
│   └── package.json
├── scripts/
│   ├── build-mcp.mjs      # builds + bundles MCP, writes manifest, copies assets to public/
│   ├── launch-chrome.sh
│   └── launch-chrome.ps1
├── examples/
└── public/                # (gitignored; populated on build)
    ├── bundle/v<version>.mjs
    ├── bundle/manifest.json
    ├── loader.mjs
    ├── install.sh / install.ps1
    └── scripts/launch-chrome.{sh,ps1}
```

### Build

```
npm install             # root deps (Next.js + esbuild)
npm run build           # runs build:mcp (tsc + esbuild + manifest), then next build
npm run dev             # dev server only; run `npm run build:mcp` first
```

### Release a new version

1. Bump `mcp-server/package.json` → `version`.
2. Commit + push. Vercel rebuilds: the manifest now points to `v<new>.mjs`.
3. Existing installs auto-update on their next launch (unless they've set `CHROME_MCP_PIN_VERSION` or `CHROME_MCP_SKIP_UPDATE`).

### Develop the MCP server locally

```
cd mcp-server
npm install
npm run build
```

For iterating without going through Vercel, point a local install at a local server:

```
# Terminal 1: serve public/ on port 18888
npx http-server ./public -p 18888

# Terminal 2: run Claude Code with
CHROME_MCP_ENDPOINT=http://127.0.0.1:18888 ~/.chrome-mcp/bin/chrome-mcp
```
