# chrome-mcp + android-mcp

Two MCP servers that drive your **real** tooling from Claude Code — Chrome (via CDP) and Android devices (via UIAutomator2). Same architecture, same distribution: semantic locators, live pause/inject, flow record/replay, one-line install.

Distributed via [chrome-mcp.actuallyroy.com](https://chrome-mcp.actuallyroy.com). The site hosts both bundled servers + tiny zero-dep loaders that handle install, updates, and SHA-256 tamper detection.

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
├── app/                       # Next.js landing page + /api/version
├── loader/
│   ├── loader.mjs             # chrome-mcp loader (zero-dep)
│   ├── bootstrap.js           # chrome inline bootstrap for .mcp.json
│   ├── android-loader.mjs     # android-mcp loader (zero-dep)
│   └── android-bootstrap.js   # android inline bootstrap
├── installer/                 # install.sh / install.ps1 (chrome power-user)
├── mcp-server/                # chrome-mcp TypeScript source
│   ├── src/
│   └── package.json
├── android-mcp/               # android-mcp TypeScript source
│   ├── src/
│   │   ├── adb.ts             # adb subprocess wrapper
│   │   ├── devices.ts
│   │   ├── uiautomator2.ts    # JSON-RPC client + APK install
│   │   ├── outline.ts         # view-hierarchy → text outline + stable refs
│   │   ├── locators.ts        # text/desc/id/xpath/ref resolvers
│   │   ├── logcat.ts          # ring-buffered logcat capture
│   │   ├── tools.ts
│   │   ├── recorder.ts        # copied from mcp-server/
│   │   └── index.ts
│   └── package.json
├── scripts/
│   ├── build-mcp.mjs          # builds chrome bundle + manifest
│   ├── build-android-mcp.mjs  # builds android bundle + manifest + fetches UIAutomator2 APKs
│   ├── launch-chrome.sh
│   └── launch-chrome.ps1
├── examples/
└── public/                    # (gitignored; populated on build)
    ├── bundle/v<version>.mjs             # chrome
    ├── bundle/manifest.json
    ├── loader.mjs                        # chrome loader
    ├── bootstrap.min.js
    ├── android/bundle/v<version>.mjs
    ├── android/bundle/manifest.json
    ├── android/loader.mjs
    ├── android/bootstrap.min.js
    ├── android/vendor/uiautomator2-server.apk
    └── android/vendor/uiautomator2-server-test.apk
```

### android-mcp quick reference

Users must have `adb` on PATH or set `ANDROID_MCP_ADB` / `$ANDROID_SDK_ROOT`. Devices listed by `adb devices` are detected automatically; multiple devices require `select_device` first.

On first tool call, the MCP:
1. Ensures exactly one device is active (or throws).
2. Checks that `io.appium.uiautomator2.server` + its test APK are installed; if not, downloads from the Vercel endpoint and `adb install -r`s them.
3. `adb forward tcp:6790 tcp:6790`.
4. Starts the UIAutomator2 test runner (`am instrument …`), polls `/wd/hub/status` until ready.
5. Creates a session, caches the id for the process lifetime.

Set `ANDROID_MCP_APK_LOCAL=/abs/path/to.apk` to use a hand-placed APK instead of downloading.

### Known issue: "UiAutomation not connected"

On some emulator AVD configurations (especially Play Store images, or anything that blocks `AccessibilityService` by policy), the Appium UIAutomator2 server reports `IllegalStateException: UiAutomation not connected, UiAutomation@…[id=-1, ...]` on session creation. The APK installs, the HTTP server starts on :6790, but the AccessibilityService handshake never completes. Workarounds:

- Use a **Google APIs** (non-Play Store) system image for the AVD; accessibility service hookup is permissive on those.
- Or: enable the server as an accessibility service explicitly:
  ```bash
  adb shell settings put secure enabled_accessibility_services io.appium.uiautomator2.server.test/androidx.test.runner.AndroidJUnitRunner
  adb shell settings put secure accessibility_enabled 1
  ```
- Or: swap the driver to [openatx/uiautomator2-server](https://github.com/openatx/uiautomator2) — its init path doesn't require AccessibilityService and is generally more emulator-friendly. This requires changing the APK references in `android-mcp/src/uiautomator2.ts` (see issue #34 in project notes).

Everything up to the session handshake (ADB, APK install, instrumentation, HTTP ready) is validated; this is purely an Android-side accessibility-policy issue on certain devices.

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
