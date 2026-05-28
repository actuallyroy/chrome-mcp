# windows-mcp

MCP server that drives Windows desktop applications semantically — same pattern
as `chrome-mcp` (CDP), `android-mcp` (UIAutomator2), and `macos-mcp` (AX), but
for native Windows apps. Uses **UI Automation** (UIA) for inspection and
control, **SendInput** for synthesized keyboard/mouse, **GDI + PrintWindow**
for screenshots, and **Windows.Media.Ocr** for OCR fallbacks.

## Architecture

```
Claude Code ── stdio ── windows-mcp (Node)  ── stdin/stdout JSON-RPC ── windows-mcp-helper.exe (C# / .NET 8)
                                                                              ↓ System.Windows.Automation, SendInput, GDI, Windows.Media.Ocr
                                                                         Target Windows app
```

The Node MCP server spawns one C# sidecar (`vendor/windows-mcp-helper.exe`)
and forwards tool calls to it as newline-delimited JSON-RPC. The C# side
holds the UIA `AutomationElement` ref store so refs survive across calls
without shipping opaque handles through the LLM.

## Setup

### 1. Toolchain

- **.NET 8 SDK** (`dotnet --version` should print `8.x` or later). Windows
  10 May 2020 SDK (10.0.19041) is targeted for WinRT OCR — install the
  Windows desktop workload if `dotnet workload list` doesn't show it.
- **Node 18+** for the MCP server.
- **PowerShell 5.1 or 7+** for the build script.

### 2. Build the helper

```powershell
cd windows-mcp
pwsh scripts\build-helper.ps1                 # win-x64 — fast
$env:BUILD_ARM64 = "1"; pwsh scripts\build-helper.ps1   # also publishes win-arm64
```

Output: `vendor\windows-mcp-helper.exe` (self-contained, single-file,
~120 MB because WPF is bundled — there's no smaller-runtime path for
managed UIA on .NET 8).

### 3. Build the Node MCP

```powershell
npm install
npm run build           # → dist\index.js
```

### 4. Wire into `.mcp.json`

```jsonc
{
  "mcpServers": {
    "windows": {
      "command": "node",
      "args": ["C:\\absolute\\path\\to\\windows-mcp\\dist\\index.js"]
    }
  }
}
```

No system-level permission prompt: UIA inspection requires no special grant.
The catches are listed under **Known limitations** below.

## Driving an app — three modes

In order of preference:

1. **UIA tree** (`outline`, `click { ref }`, `fill { ref }`, `describe`,
   `try_click`, `wait_for_element`). Native Win32, WinUI 3 / WPF, UWP,
   WinForms, Electron with `--force-renderer-accessibility`, Edge / Chrome,
   modern Office. Cheapest + most reliable. Works on **background and
   minimized windows** when the click is dispatched through `InvokePattern`
   (or `Toggle` / `ExpandCollapse` / `SelectionItem` / `Value`).
2. **Keyboard** (`press_key { key, modifiers }`, `type_text`). Works on
   *every* app that takes keyboard input — but `SendInput` keystrokes go
   to the **currently focused window**. Call `focus_app` first.
3. **OCR** (`find_text { text }`, `click_text { text }`). Windows.Media.Ocr
   recognizes everything visible on screen and returns bounding boxes;
   `click_text` handles find + click in one call. Use this for DirectX
   games, custom-drawn canvases, anything without a UIA tree.

See [`ACCESSIBILITY.md`](./ACCESSIBILITY.md) for how to make your own Windows
app drivable — most apps already work, this doc covers the gaps.

## Tool surface (v0.1.0)

- **Diagnostics**: `check_permissions`, `open_permissions_settings`, `ping`
- **App lifecycle**: `list_apps`, `focus_app`, `launch_app`
- **UIA inspection**: `outline`, `describe`
- **UIA interaction**: `click`, `fill`, `type_text`, `press_key`, `hover`,
  `scroll`, `try_click`, `wait_for_element`, `wait_for_stable`
- **OCR**: `find_text`, `click_text`
- **Capture**: `screenshot` (whole desktop or one app's foreground window)
- **Timing**: `wait`, `pause`
- **Flows**: `start_recording`, `stop_recording`, `recording_status`,
  `run_script`, `save_flow`, `list_flows`, `delete_flow`
- **Feedback**: `send_feedback` (uses your `gh` CLI when authed)

## Known limitations

- **Elevated targets from a non-elevated helper.** Windows UIPI blocks input
  injection and most UIA writes from a low-integrity process into a
  high-integrity one. Symptom: `outline` returns an empty tree for an
  obviously-running elevated app, or clicks silently no-op. Workarounds:
  run the MCP host elevated, or sign this helper with `uiAccess="true"` in
  its manifest plus an Authenticode cert (not bundled; production-only).
  `check_permissions` reports your elevation state.
- **UAC consent / secure desktop.** You cannot drive UAC prompts from any
  app — Windows isolates the secure desktop.
- **Chromium native windows + `PrintWindow`.** Some Chrome / Edge / Electron
  builds return a black bitmap from `PrintWindow PW_RENDERFULLCONTENT`. We
  fall back to `BitBlt` of the window's bounding rect, which means
  occluded portions of the window become whatever was actually on screen.
- **DirectX / fullscreen exclusive mode.** OCR works on the captured frame;
  synthesized input often gets filtered by anti-cheat (Vanguard, EAC).
- **`SendInput` and the foreground.** Keyboard injection goes to whatever
  owns keyboard focus, not the target. Always `focus_app` then `wait` a
  little (100-200 ms) before `type_text` / `press_key`.

## Env vars

- `WINDOWS_MCP_HELPER` — absolute path to a pre-built helper.exe (skip the
  build).
- `WINDOWS_MCP_FLOWS_DIR` — where saved flows live (default
  `%USERPROFILE%\.windows-mcp\flows`).
- `WINDOWS_MCP_FEEDBACK_ENDPOINT` — override the feedback endpoint for
  `send_feedback`.

## License

GPLv3. See `LICENSE` at the repo root.
