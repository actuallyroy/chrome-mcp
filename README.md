# chrome-mcp

An MCP server that drives your **real** Chrome browser — your profile, your logins, your extensions, your tabs. It attaches over the Chrome DevTools Protocol (CDP); it does not launch Chromium or use a separate browser binary.

## How it works

1. You launch Chrome once with `--remote-debugging-port=9222`.
2. The MCP server connects to `http://127.0.0.1:9222` via `puppeteer-core`.
3. Tools drive whatever tab you choose — navigate, click, type, screenshot, evaluate JS, read the DOM, etc.

## Setup

```bash
npm install
npm run build
```

## Launch Chrome with debugging enabled

```bash
npm run launch-chrome
```

This uses a **dedicated profile** at `~/ChromeMCP-Profile`, so it runs alongside your normal Chrome — no need to quit anything. Modern Chrome refuses `--remote-debugging-port` on the default profile (security), so a separate profile is required.

First launch is an empty profile. Sign into the sites you want the MCP to drive (Gmail, GitHub, your internal tools, whatever); those logins persist for next time.

Override port or profile via env vars:

```bash
CHROME_DEBUG_PORT=9333 CHROME_USER_DATA_DIR="$HOME/AnotherProfile" npm run launch-chrome
```

Verify it's listening:

```bash
curl -s http://127.0.0.1:9222/json/version | head -c 200
```

## Register with Claude Code

```bash
claude mcp add chrome -- node "$(pwd)/dist/index.js"
```

Or add to `~/.claude/settings.json` under `mcpServers`:

```json
{
  "mcpServers": {
    "chrome": {
      "command": "node",
      "args": ["/absolute/path/to/chrome-mcp/dist/index.js"]
    }
  }
}
```

If you use a non-default debug port, pass it through:

```json
{
  "mcpServers": {
    "chrome": {
      "command": "node",
      "args": ["/absolute/path/to/chrome-mcp/dist/index.js"],
      "env": { "CHROME_DEBUG_PORT": "9333" }
    }
  }
}
```

## Tools

Tools that take a locator accept any of: `ref` (from `outline`), `text` (visible button/link text), `label` (form-field label), or `selector` (CSS escape hatch). Refs are **stable across outlines** — once assigned, an element keeps its ref for the rest of the page's lifetime.

**Page inspection**

- `outline` — condensed text snapshot of the page: interactive elements with refs, labels, current values, grouped by section. Includes captured toasts. Use this instead of screenshots for navigation.
- `describe` — detailed info for a single element (locator): tag, role, computed label, rect, attributes, ancestor chain.
- `screenshot` — PNG of the active tab (full-page optional). Reserve for visual questions.
- `snapshot` — raw accessibility tree (verbose; prefer `outline`).
- `get_text`, `get_html`, `get_url`, `get_title`, `get_attribute`

**Interaction (semantic locators)**

- `click { text | label | ref | selector }`
- `fill { label | ref | selector, value }`
- `fill_form { fields: [{label|ref|selector, value}, ...] }` — batch multiple fields in one call
- `select_option { label | ref, option }` — handles Radix/shadcn/custom comboboxes (open → wait → click)
- `press { key }`, `type { text }`, `hover { … }`, `scroll { … }`

**Capture (survives auto-dismiss)**

- `get_toasts { clear? }` — notifications captured by a MutationObserver (sonner, `role=alert`, etc.)
- `wait_for_toast { text, timeout_ms? }` — block until a toast with that substring appears
- `get_console { level?, limit?, clear? }` — console.log/warn/error + unhandled errors/rejections
- `get_network { url_contains?, limit?, clear? }` — fetch + XHR requests with method/status/duration

**Navigation**

- `navigate`, `go_back`, `go_forward`, `reload`, `wait_for_navigation`, `wait_for_selector`

**Tab control**

- `list_tabs`, `select_tab`, `new_tab`, `close_tab`

**Debugging**

- `pause { message?, timeout_ms? }` — shows a "Resume" overlay in the browser and blocks the agent until the human clicks it.
- `resume` — force-resume a pause (normally click the overlay).
- `inject_script { code }` — register JS that runs on **every** page load in this tab (via `evaluateOnNewDocument`) plus the current page. Good for persistent debug helpers, fetch mocks, test hooks. One-shot execution: use `evaluate`.

**Flow recording**

- `start_recording { path? }` — begin capturing every subsequent tool call.
- `stop_recording` — stop and write the flow JSON to `path` (if provided). Returns the recorded entries.
- `recording_status` — active? how many entries so far?

**Cookies**

- `get_cookies`, `set_cookies`

**Escape hatch**

- `evaluate { expression }` — run arbitrary JS in the page, return JSON.

## Environment variables

- `CHROME_DEBUG_PORT` — default `9222`
- `CHROME_DEBUG_HOST` — default `127.0.0.1`
- `CHROME_USER_DATA_DIR` (launch script only) — default `~/ChromeMCP-Profile`
- `CHROME_BIN` (launch script only) — default `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`

## Notes

- The MCP does not launch or own Chrome — you manage the browser lifecycle. If you quit Chrome, the server disconnects; it will auto-reconnect on the next tool call.
- Pages like `devtools://` and `chrome-extension://` are filtered out of `list_tabs`.
- `screenshot` returns a base64 PNG as an `image` content block.
- `evaluate` runs arbitrary JS in the page — treat it like a REPL against your logged-in sessions. Be careful on sites with real side effects.
