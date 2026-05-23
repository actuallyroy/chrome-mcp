# macos-mcp

MCP server that drives macOS desktop applications semantically — same pattern
as `chrome-mcp` (CDP) and `android-mcp` (UIAutomator2), but for native Mac
apps. Uses the OS Accessibility (AX) tree for inspection, `CGEvent` for input,
and `ScreenCaptureKit` for screenshots.

## Architecture

```
Claude Code ── stdio ── macos-mcp (Node)  ── stdin/stdout JSON-RPC ── macos-mcp-helper (Swift)
                                                                            ↓ AXUIElement, CGEvent, ScreenCaptureKit
                                                                       Target macOS app
```

The Node MCP server spawns a single Swift sidecar (`vendor/macos-mcp-helper`)
and forwards tool calls to it as newline-delimited JSON-RPC. The Swift side
holds the `AXUIElementRef` cache so refs survive across calls without
shipping opaque handles through the LLM.

## Setup

### 1. Toolchain

The Swift helper needs the Command Line Tools' `swiftc` to be **at least as new
as your installed macOS SDK**. On macOS 26 Tahoe with stock CLT, you may see:

```
error: failed to build module 'Swift'; this SDK is not supported by the compiler
```

Fix:

```bash
softwareupdate --list                                       # find the latest CLT
sudo softwareupdate -i "Command Line Tools for Xcode 26.5-26.5"   # or whatever it shows
```

Or install Xcode from the App Store (~ 12 GB) — that ships its own toolchain.

### 2. Build the Swift helper

```bash
cd macos-mcp
bash scripts/build-helper.sh           # arm64 only — fast
BUILD_UNIVERSAL=1 bash scripts/build-helper.sh   # arm64 + x86_64 lipo'd
```

Output: `vendor/macos-mcp-helper` (statically linked, no runtime deps).

### 3. Build the Node MCP

```bash
npm install
npm run build           # → dist/index.js
```

### 4. Grant TCC permissions

The Swift helper needs **two** macOS privacy grants. Both are per-binary —
moving or re-building the helper will require re-granting.

- **Accessibility** — required for AX inspection + input.
- **Screen Recording** — required for `screenshot`. macOS 15 Sequoia and
  later re-prompts weekly; can't be avoided.

The MCP can show you the right Settings pane:

```jsonc
// Once the MCP is wired up:
{ "tool": "check_permissions" }
{ "tool": "open_permissions_settings", "args": { "service": "accessibility" } }
{ "tool": "open_permissions_settings", "args": { "service": "screen_recording" } }
```

After flipping the toggle, restart whatever spawned the MCP (so the Swift
helper re-spawns and re-checks its TCC grant).

### 5. Wire into `.mcp.json`

```jsonc
{
  "mcpServers": {
    "macos": {
      "command": "node",
      "args": ["/absolute/path/to/macos-mcp/dist/index.js"]
    }
  }
}
```

## Current tool surface (v0.1.0)

Minimum viable: ping, check_permissions, open_permissions_settings,
list_apps, focus_app, launch_app, outline, click, screenshot.

Next pass (planned, mirroring android-mcp): fill, hover, scroll, press_key,
try_click, wait_for_element, wait_for_stable, describe, pause, run_script,
save_flow / list_flows / delete_flow, send_feedback, recorder.

## Known limitations

- **Adobe CC, Logic Pro, Final Cut, games / Metal apps** — these have
  near-zero AX coverage. You'll see one opaque element for the canvas.
  Realistic fallback is coordinate clicks + screenshots.
- **AXIsProcessTrusted cache bug** — Apple's TCC cache occasionally goes
  stale after OS updates or signature changes. Symptom: `check_permissions`
  says granted but AX calls return `kAXErrorAPIDisabled`. Fix: toggle the
  Accessibility permission off + on in Settings.
- **Sandboxed apps can't post CGEvents.** If you bundle this inside a
  sandboxed app, the helper's input layer will silently fail. Distribute
  unsandboxed.

## License

GPLv3. See `LICENSE` at the repo root.
