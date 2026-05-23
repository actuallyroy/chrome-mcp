// Mouse + keyboard event posting via CGEvent. Not deprecated on Apple
// Silicon; requires Accessibility TCC grant for our binary.

import CoreGraphics
import ApplicationServices

enum Input {
    static func click(at point: CGPoint, button: CGMouseButton = .left, count: Int = 1) {
        let down = CGEvent(mouseEventSource: nil, mouseType: button == .right ? .rightMouseDown : .leftMouseDown,
                           mouseCursorPosition: point, mouseButton: button)
        let up = CGEvent(mouseEventSource: nil, mouseType: button == .right ? .rightMouseUp : .leftMouseUp,
                         mouseCursorPosition: point, mouseButton: button)
        for i in 1...count {
            down?.setIntegerValueField(.mouseEventClickState, value: Int64(i))
            up?.setIntegerValueField(.mouseEventClickState, value: Int64(i))
            down?.post(tap: .cghidEventTap)
            up?.post(tap: .cghidEventTap)
        }
    }

    // Click by asking the AX element to perform its press action — preferred
    // when available because it goes through the app's own action handlers
    // (works for hidden / off-screen / out-of-window-z-order elements).
    @discardableResult
    static func axPress(_ el: AXUIElement) -> Bool {
        return AXUIElementPerformAction(el, kAXPressAction as CFString) == .success
    }

    // Move the mouse without clicking (hover).
    static func moveMouse(to point: CGPoint) {
        CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left)?
            .post(tap: .cghidEventTap)
    }

    // Scroll wheel. dx/dy are in line units (negative dy = scroll down content).
    static func scroll(dx: Int32, dy: Int32) {
        guard let evt = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2,
                                wheel1: dy, wheel2: dx, wheel3: 0) else { return }
        evt.post(tap: .cghidEventTap)
    }

    // Type a string by synthesizing key events.
    static func typeString(_ s: String) {
        let src = CGEventSource(stateID: .hidSystemState)
        for scalar in s.unicodeScalars {
            var ch = UniChar(scalar.value & 0xFFFF)
            guard let down = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true),
                  let up = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: false) else { continue }
            down.keyboardSetUnicodeString(stringLength: 1, unicodeString: &ch)
            up.keyboardSetUnicodeString(stringLength: 1, unicodeString: &ch)
            down.post(tap: .cghidEventTap)
            up.post(tap: .cghidEventTap)
        }
    }

    // Common virtual key codes (HID). Names match the chrome/android API.
    static let KEYCODES: [String: CGKeyCode] = [
        "RETURN": 0x24, "ENTER": 0x24, "TAB": 0x30, "SPACE": 0x31,
        "DELETE": 0x33, "BACKSPACE": 0x33, "ESCAPE": 0x35, "ESC": 0x35,
        "LEFT": 0x7B, "RIGHT": 0x7C, "DOWN": 0x7D, "UP": 0x7E,
        "HOME": 0x73, "END": 0x77, "PAGEUP": 0x74, "PAGEDOWN": 0x79,
        "F1": 0x7A, "F2": 0x78, "F3": 0x63, "F4": 0x76,
        "F5": 0x60, "F6": 0x61, "F7": 0x62, "F8": 0x64,
        "F9": 0x65, "F10": 0x6D, "F11": 0x67, "F12": 0x6F,
        "CAPS_LOCK": 0x39,
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
    static func pressKey(_ name: String, modifiers: [String] = []) -> Bool {
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
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
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
