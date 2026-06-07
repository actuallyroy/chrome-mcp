// Mouse + keyboard event posting via CGEvent. Not deprecated on Apple
// Silicon; requires Accessibility TCC grant for our binary.
//
// Every method takes an optional `targetPid`. When non-nil, events are
// delivered via `CGEvent.postToPid(_:)` — the target app receives them as if
// it were frontmost, but the user's actual frontmost app is NOT demoted and
// the on-screen cursor doesn't move. That's the foundation for running the
// agent without disturbing whatever the user is doing.
//
// When `targetPid` is nil, events go through `.cghidEventTap` (the system HID
// tap) and behave like real human input — moves the cursor, goes to the
// frontmost app. Use that path only when we don't know which app should
// receive the event (raw {x,y} clicks with no active-app context).

import CoreGraphics
import ApplicationServices

enum Input {
    private static func deliver(_ evt: CGEvent?, to pid: pid_t?) {
        guard let evt = evt else { return }
        if let pid = pid {
            evt.postToPid(pid)
        } else {
            evt.post(tap: .cghidEventTap)
        }
    }

    static func click(at point: CGPoint, button: CGMouseButton = .left, count: Int = 1, targetPid: pid_t? = nil) {
        let down = CGEvent(mouseEventSource: nil, mouseType: button == .right ? .rightMouseDown : .leftMouseDown,
                           mouseCursorPosition: point, mouseButton: button)
        let up = CGEvent(mouseEventSource: nil, mouseType: button == .right ? .rightMouseUp : .leftMouseUp,
                         mouseCursorPosition: point, mouseButton: button)
        for i in 1...count {
            down?.setIntegerValueField(.mouseEventClickState, value: Int64(i))
            up?.setIntegerValueField(.mouseEventClickState, value: Int64(i))
            deliver(down, to: targetPid)
            deliver(up, to: targetPid)
        }
    }

    // Click by asking the AX element to perform its press action — preferred
    // when available because it goes through the app's own action handlers
    // (works for hidden / off-screen / out-of-window-z-order elements). AX
    // actions are inherently focus-free.
    @discardableResult
    static func axPress(_ el: AXUIElement) -> Bool {
        return AXUIElementPerformAction(el, kAXPressAction as CFString) == .success
    }

    // Move the mouse without clicking (hover).
    static func moveMouse(to point: CGPoint, targetPid: pid_t? = nil) {
        let evt = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left)
        deliver(evt, to: targetPid)
    }

    // Scroll wheel. dx/dy are in line units (negative dy = scroll down content).
    static func scroll(dx: Int32, dy: Int32, targetPid: pid_t? = nil) {
        let evt = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2,
                          wheel1: dy, wheel2: dx, wheel3: 0)
        deliver(evt, to: targetPid)
    }

    // Type a string by synthesizing key events.
    static func typeString(_ s: String, targetPid: pid_t? = nil) {
        let src = CGEventSource(stateID: .hidSystemState)
        for scalar in s.unicodeScalars {
            var ch = UniChar(scalar.value & 0xFFFF)
            guard let down = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true),
                  let up = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: false) else { continue }
            down.keyboardSetUnicodeString(stringLength: 1, unicodeString: &ch)
            up.keyboardSetUnicodeString(stringLength: 1, unicodeString: &ch)
            deliver(down, to: targetPid)
            deliver(up, to: targetPid)
        }
    }

    // Common virtual key codes (HID). Names match the chrome/android API.
    // Use names like "P", "1", "F12" — case-insensitive on lookup. Modifiers
    // (cmd/shift/opt/ctrl/fn) are passed separately as a list of strings.
    static let KEYCODES: [String: CGKeyCode] = [
        // Letters
        "A": 0x00, "B": 0x0B, "C": 0x08, "D": 0x02, "E": 0x0E, "F": 0x03,
        "G": 0x05, "H": 0x04, "I": 0x22, "J": 0x26, "K": 0x28, "L": 0x25,
        "M": 0x2E, "N": 0x2D, "O": 0x1F, "P": 0x23, "Q": 0x0C, "R": 0x0F,
        "S": 0x01, "T": 0x11, "U": 0x20, "V": 0x09, "W": 0x0D, "X": 0x07,
        "Y": 0x10, "Z": 0x06,
        // Digits (top row, not numpad)
        "0": 0x1D, "1": 0x12, "2": 0x13, "3": 0x14, "4": 0x15,
        "5": 0x17, "6": 0x16, "7": 0x1A, "8": 0x1C, "9": 0x19,
        // Punctuation / common symbols
        "GRAVE": 0x32, "MINUS": 0x1B, "EQUAL": 0x18,
        "LEFT_BRACKET": 0x21, "RIGHT_BRACKET": 0x1E, "BACKSLASH": 0x2A,
        "SEMICOLON": 0x29, "QUOTE": 0x27, "COMMA": 0x2B, "PERIOD": 0x2F, "SLASH": 0x2C,
        // Editing keys
        "RETURN": 0x24, "ENTER": 0x24, "TAB": 0x30, "SPACE": 0x31,
        "DELETE": 0x33, "BACKSPACE": 0x33, "ESCAPE": 0x35, "ESC": 0x35,
        "FORWARD_DELETE": 0x75,
        // Arrows + navigation
        "LEFT": 0x7B, "RIGHT": 0x7C, "DOWN": 0x7D, "UP": 0x7E,
        "HOME": 0x73, "END": 0x77, "PAGEUP": 0x74, "PAGEDOWN": 0x79,
        // Function keys
        "F1": 0x7A, "F2": 0x78, "F3": 0x63, "F4": 0x76,
        "F5": 0x60, "F6": 0x61, "F7": 0x62, "F8": 0x64,
        "F9": 0x65, "F10": 0x6D, "F11": 0x67, "F12": 0x6F,
        // Misc
        "CAPS_LOCK": 0x39, "HELP": 0x72,
    ]

    // Modifier flags by name.
    static let MOD_FLAGS: [String: CGEventFlags] = [
        "cmd": .maskCommand, "command": .maskCommand, "meta": .maskCommand,
        "shift": .maskShift,
        "opt": .maskAlternate, "option": .maskAlternate, "alt": .maskAlternate,
        "ctrl": .maskControl, "control": .maskControl,
        "fn": .maskSecondaryFn,
    ]

    @discardableResult
    static func pressKey(_ name: String, modifiers: [String] = [], targetPid: pid_t? = nil) -> Bool {
        let upper = name.uppercased()
        guard let code = KEYCODES[upper] else { return false }
        let src = CGEventSource(stateID: .hidSystemState)
        var flags: CGEventFlags = []
        for m in modifiers {
            if let f = MOD_FLAGS[m.lowercased()] { flags.insert(f) }
        }
        guard let down = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: true),
              let up = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: false) else { return false }
        down.flags = flags
        up.flags = flags
        deliver(down, to: targetPid)
        deliver(up, to: targetPid)
        return true
    }

    // Set AXValue on a text field / text area. React-style controlled inputs in
    // Electron honor this; native AppKit fields always do.
    @discardableResult
    static func axSetValue(_ el: AXUIElement, _ value: String) -> Bool {
        return AXUIElementSetAttributeValue(el, kAXValueAttribute as CFString, value as CFString) == .success
    }

    // Focus an AX element (set as keyboard focus).
    @discardableResult
    static func axFocus(_ el: AXUIElement) -> Bool {
        return AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, kCFBooleanTrue) == .success
    }
}
