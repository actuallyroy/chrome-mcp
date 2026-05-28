# Making your Windows app drivable by windows-mcp

windows-mcp drives apps three ways, in order of preference. If you're the
developer of the app being driven, making it accessibility-aware unlocks the
fastest, most reliable path. Most Windows UI frameworks already expose a
UIA tree out of the box — the gaps are usually around custom-drawn views,
icon-only buttons, and stable identifiers.

## The three driving modes (cheapest → most fragile)

| Mode | How | When it works | Cost per call |
|------|-----|---------------|---------------|
| **UIA tree** | `outline`, `click { ref }`, `fill { ref }` | App exposes UI Automation | ~30 ms |
| **Keyboard** | `press_key { key, modifiers }`, `type_text` | App responds to standard shortcuts | ~5 ms |
| **OCR** | `find_text`, `click_text` | Anything visible | ~150 ms |

OCR is the universal fallback. UIA is the goal — it gives the agent a
semantic outline of your app instead of a screenshot to parse, and it works
on background and minimized windows.

## WPF

WPF emits UIA automatically. The two properties that matter:

```xml
<Button Content="Save"
        AutomationProperties.Name="Save document"
        AutomationProperties.AutomationId="save-btn"
        Click="Save_Click" />
```

- `AutomationProperties.Name` → `title` in `outline`. Default is the
  control's `Content` for buttons. Set it explicitly when the visible
  text is an icon (e.g. `Content="💾"`).
- `AutomationProperties.AutomationId` → `identifier` — the most stable
  locator. Add to anything an agent might want to target by id.

For custom controls inheriting `Control`:

```csharp
protected override AutomationPeer OnCreateAutomationPeer()
    => new ButtonAutomationPeer(this);   // or a custom peer
```

That's almost the entire WPF accessibility API you need. Anything more
(custom patterns, AutomationEvents) is for screen-reader ergonomics, not
automation.

## WinForms

WinForms controls expose UIA via MSAA-to-UIA bridge. The properties you
care about live on `Control.AccessibleName` and `Control.AccessibleRole`:

```csharp
saveButton.AccessibleName = "Save document";
saveButton.AccessibleRole = AccessibleRole.PushButton;
saveButton.AccessibilityObject.Name = "Save document"; // fallback
```

Stable ids: there's no native `AutomationId` on WinForms controls — the
field name is what UIA reads. Name your controls meaningfully
(`btnSaveDocument`, not `button1`) and `windows-mcp` will pick them up as
`AutomationId`.

## WinUI 3 / UWP

Mirror of WPF, just with XAML namespace:

```xml
<Button x:Name="SaveButton"
        Content="Save"
        AutomationProperties.Name="Save document"
        AutomationProperties.AutomationId="save-btn"
        Click="Save_Click" />
```

UWP additionally exposes `Control.AccessibleName` and friends at runtime.

## Win32 (raw)

Standard Win32 controls (BUTTON, EDIT, LISTBOX, etc.) come with UIA support
free. The ergonomics are entirely in the dialog template — use
`WS_EX_CONTROLPARENT` so tab order works, give every control a meaningful
ID resource, and set window text on icon-only buttons.

For owner-drawn / custom HWNDs, you must implement the UIA provider
interfaces (`IRawElementProviderSimple`, `IRawElementProviderFragment`).
This is *significantly* more work than the managed equivalents — usually
not worth it; ship `accessibilityLabel` overlays via a wrapper instead, or
accept OCR as the access path.

## Electron

Two states:

1. **Default** — Electron does NOT expose ARIA to UIA. `outline` returns
   one giant `Document` node and that's it.
2. **With `--force-renderer-accessibility`** — Electron walks the ARIA
   tree and forwards it to UIA. `outline` becomes useful.

Recommendation: launch your Electron app with
`--force-renderer-accessibility=true` (or set
`accessibilitySupport: true` on the BrowserWindow). Then your renderer ARIA
attributes drive the agent:

```html
<button aria-label="Save document" data-automation-id="save-btn">💾</button>
```

`aria-label` → UIA `Name`; the agent's exact-text matcher picks it up.

## Chromium browsers (Chrome / Edge)

Same as Electron: pass `--force-renderer-accessibility` if you're spawning
a browser as a test target. Chrome and Edge expose every tab's full ARIA
tree via UIA once enabled. Otherwise you'll see Chrome's chrome (tabs,
omnibox, bookmark bar) but the web content is opaque.

## Qt

Qt for Windows ships UIA support but it's framework-version dependent.
Enable it via `QAccessible::installFactory`-based providers if your widgets
are custom; out-of-the-box `QPushButton` / `QLineEdit` / `QListWidget`
work. Set `accessibleName` + `accessibleDescription` on every interactive
widget.

## DirectX / custom-rendered games & GPU-rendered editors

There's no UIA tree at all for fullscreen DirectX or GPU-canvas apps
(Nova, Zed, anything Skia/Vello/WGPU-based without an explicit
accessibility provider). The HWND has one opaque canvas and the app
draws everything itself. Options:

1. **OCR + keyboard** — `focus_app` → `press_key Ctrl+P` (or whatever
   command-palette shortcut the editor has), then `type_text`. Works
   fine for menus, command palettes, inventories — anything with
   on-screen text.
2. **`find_text` / `click_text`** — pure OCR for in-canvas clicking when
   no keyboard path exists.
3. Add a UIA provider over your app's HWND that mirrors the focus state
   — the [AccessKit](https://accesskit.dev/) Rust crate exposes an
   `accesskit_windows` UIA bridge. Once integrated, the app drops out
   of this category entirely.
4. Many games block `SendInput` via anti-cheat. OCR for *reading* still
   works; *driving* may not.

## Quick checklist for app authors

- [ ] Every button has either visible text or `AutomationProperties.Name`.
- [ ] Every interactive element with a generic label (e.g. "Delete" on 10
      rows) has a unique `AutomationId`.
- [ ] Custom-drawn controls implement a `AutomationPeer` / UIA provider,
      even if it only exposes Name + InvokePattern.
- [ ] Keyboard shortcuts are documented somewhere the agent can read them
      (your README, a `keybindings.json`). Ctrl+S, Ctrl+W, Ctrl+F,
      Alt+F4 are table stakes.

## Verifying

```jsonc
// Outline returns a semantic tree:
{ "tool": "outline" }
// → look for the names / automation ids you set

// Describe one element:
{ "tool": "describe", "args": { "ref": 42 } }
// → check Name, AutomationId, ControlType, supported patterns
```

The Windows SDK tool **Inspect.exe** (ships in the SDK at
`%ProgramFiles(x86)%\Windows Kits\10\bin\<ver>\x64\inspect.exe`) is the
canonical UIA tree viewer. If `outline` doesn't match what Inspect shows,
that's a bug here — file via `send_feedback`.

If `outline` is empty for your app's main window and you control the
source, the first ~10 `AutomationProperties.Name` annotations are the
highest-leverage edits you'll ever make.
