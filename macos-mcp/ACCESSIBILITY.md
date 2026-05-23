# Making your macOS app drivable by macos-mcp

macos-mcp drives apps three ways, in order of preference. If you're the
developer of the app being driven (most AI-agent workflows are exactly this:
the agent writes the app AND tests it), making your app accessibility-aware
unlocks the fastest path. Five minutes of `accessibilityLabel` annotations
buys you semantic locators forever.

This doc covers what to add per framework so `outline` returns a useful tree
and `click { text: "Save" }` works reliably.

## The three driving modes (cheapest → most fragile)

| Mode | How | When it works | Cost per call |
|------|-----|---------------|---------------|
| **AX tree** | `outline`, `click { ref }`, `fill { ref }` | App exposes NSAccessibility | ~50 ms |
| **Keyboard** | `press_key { key, modifiers }`, `type_text` | App responds to Cocoa shortcuts | ~5 ms |
| **OCR** | `find_text`, `click_text` | Anything visible | ~80 ms (Vision) |

OCR is the universal fallback. AX is the goal — it gives the agent a
semantic outline of your app instead of a screenshot to parse.

## SwiftUI

Two attribute modifiers cover ~95% of usefulness:

```swift
Button("Save") { saveDocument() }
    .accessibilityLabel("Save")           // shows up as the `title` in outline
    .accessibilityIdentifier("save-btn")  // stable locator across renames
```

Pass `.accessibilityIdentifier()` on anything the agent might want to target
by a stable id (test-id pattern). They don't show to humans but are
first-class locators here.

For custom-drawn views (Canvas, GeometryReader-based layouts), wrap them:

```swift
Canvas { ctx, size in /* ... */ }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Document canvas")
    .accessibilityIdentifier("doc-canvas")
```

Stack-level groupings:

```swift
VStack { ... }
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Editor toolbar")
```

That's almost the entire SwiftUI accessibility API you need. Anything more
exotic (rotors, custom actions, AX notifications) is for VoiceOver
ergonomics, not automation.

## AppKit (NSView / NSControl)

NSAccessibility is a protocol you can implement directly:

```swift
class MyCustomView: NSView {
    override func accessibilityRole() -> NSAccessibility.Role? { .button }
    override func accessibilityLabel() -> String? { "Run" }
    override func accessibilityIdentifier() -> String { "run-btn" }
    override func isAccessibilityElement() -> Bool { true }

    override func accessibilityPerformPress() -> Bool {
        self.handleClick()
        return true
    }
}
```

For standard controls (NSButton, NSTextField, NSPopUpButton), AppKit already
exposes the accessibility tree. You usually only need to add:
- `setAccessibilityIdentifier("...")` for stable locators
- `setAccessibilityLabel("...")` when the visible text is empty/icon-only

## Catalyst / iOS-on-Mac

Same as UIKit — `accessibilityLabel`, `accessibilityIdentifier`,
`isAccessibilityElement`. Catalyst translates these into NSAccessibility
attributes automatically. Already works without changes.

## Electron / Chromium

Already works after macos-mcp pokes `AXManualAccessibility`. Renderer ARIA
attributes are what macos-mcp sees:

```html
<button aria-label="Save document" data-testid="save-btn">💾</button>
```

The `aria-label` becomes the AX `title` in `outline`. Stable test ids work
when you also set `id="save-btn"` because AX walks DOM ids into
`AXIdentifier`. Avoid relying on visible button text in tree-walked
locators — it changes with i18n.

## Tauri / wry (WebKit)

WKWebView's content is **not** in the AX tree by default. The wry crate has
an experimental accessibility branch but it's not stable. Realistic options:

1. **OCR + keyboard** today (`find_text` / `click_text` / `press_key`).
2. Build the renderer to expose accessibility info through your app's own
   AppKit shell — e.g. mirror the active panel/title into a hidden
   `NSAccessibilityElement` in your NSWindow.
3. Wait for wry to ship `WebView::set_accessible(true)`.

If you control the Tauri app, option 1 is fine for most testing.

## GPUI (Zed-style Metal apps)

GPUI doesn't implement NSAccessibility at all today. Same situation as
Tauri/wry but worse — there's no WKWebView fallback either. Options:

1. **OCR + keyboard** is the only practical path today.
2. If you maintain a GPUI app: add an `NSAccessibility`-conforming overlay
   view that mirrors the focus state. About a day of work; lets agents drive
   your app at AX speed instead of OCR speed.
3. Wait for GPUI to ship accessibility (Zed has an open issue tracking this).

## Quick checklist for app authors

- [ ] Every button has either visible text or an `accessibilityLabel`.
- [ ] Every interactive element with a generic label (e.g. "Delete" on 10
      rows) has a unique `accessibilityIdentifier`.
- [ ] Custom-drawn canvases declare themselves as accessibility elements
      with a label, even if their content isn't introspectable.
- [ ] Keyboard shortcuts are documented somewhere the agent can read them
      (your README, a `keybindings.json`, or comments). Cmd+P, Cmd+S,
      Cmd+W, Cmd+F are table stakes.

## Verifying

```jsonc
// Outline returns semantic tree:
{ "tool": "outline" }
// → look for the labels / identifiers you set

// Describe one element:
{ "tool": "describe", "args": { "ref": 42 } }
// → check AXLabel, AXIdentifier, AXRole, supported actions
```

If `outline` is empty for your app's main window and you control the source,
the first ~10 `accessibilityLabel` annotations are the highest-leverage
edits you'll ever make.
