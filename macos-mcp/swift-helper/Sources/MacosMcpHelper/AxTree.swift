// AXUIElement walker. Assigns stable integer refs to elements we hand back to
// the LLM and caches the underlying AXUIElementRef so a subsequent click(ref)
// can find the same element without re-walking. Refs survive across calls but
// invalidate when the underlying element is destroyed (window close, etc) —
// callers should tolerate "element gone" and call outline again.

import AppKit
import ApplicationServices

// Roles we expose by default in the outline. The Swift importer doesn't bridge
// every kAX*Role string constant (some live in private headers), so we just use
// the literal string values everywhere — they're the same on the wire.
private let INTERACTIVE_ROLES: Set<String> = [
    "AXButton", "AXMenuItem", "AXMenuBarItem",
    "AXCheckBox", "AXRadioButton", "AXPopUpButton",
    "AXTextField", "AXTextArea", "AXComboBox",
    "AXLink", "AXTabGroup", "AXRadioGroup",
    "AXSlider", "AXIncrementor", "AXOutline",
    "AXBrowser", "AXTable", "AXOutlineRow",
    "AXRow", "AXCell", "AXList",
    "AXDisclosureTriangle", "AXSwitch",
]

private let CONTAINER_ROLES: Set<String> = [
    "AXWindow", "AXGroup", "AXSplitGroup",
    "AXScrollArea", "AXToolbar", "AXTabGroup",
    "AXMenu", "AXMenuBar",
    "AXSheet", "AXDrawer",
    "AXLayoutArea", "AXLayoutItem",
]

struct AxNode: Codable {
    let ref: Int
    let role: String
    let role_description: String?
    let title: String?
    let value: String?
    let label: String?
    let identifier: String?
    let enabled: Bool
    let position: [Double]?
    let size: [Double]?
    let children: [AxNode]
}

actor AxRefStore {
    static let shared = AxRefStore()
    private var next = 1
    private var byRef: [Int: AXUIElement] = [:]

    func assign(_ el: AXUIElement) -> Int {
        let id = next
        next += 1
        byRef[id] = el
        return id
    }

    func resolve(_ ref: Int) -> AXUIElement? { byRef[ref] }

    func reset() {
        byRef.removeAll()
        next = 1
    }
}

enum Ax {
    // String attribute fetch with safe fallback.
    static func attrString(_ el: AXUIElement, _ name: String) -> String? {
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, name as CFString, &raw) == .success,
              let s = raw as? String else { return nil }
        return s.isEmpty ? nil : s
    }

    static func attrBool(_ el: AXUIElement, _ name: String) -> Bool {
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, name as CFString, &raw) == .success else { return false }
        return (raw as? Bool) ?? false
    }

    static func attrChildren(_ el: AXUIElement) -> [AXUIElement] {
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &raw) == .success,
              let arr = raw as? [AXUIElement] else { return [] }
        return arr
    }

    static func attrPosition(_ el: AXUIElement) -> CGPoint? {
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, kAXPositionAttribute as CFString, &raw) == .success else { return nil }
        var p = CGPoint.zero
        let v = raw as! AXValue
        guard AXValueGetType(v) == .cgPoint, AXValueGetValue(v, .cgPoint, &p) else { return nil }
        return p
    }

    static func attrSize(_ el: AXUIElement) -> CGSize? {
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, kAXSizeAttribute as CFString, &raw) == .success else { return nil }
        var s = CGSize.zero
        let v = raw as! AXValue
        guard AXValueGetType(v) == .cgSize, AXValueGetValue(v, .cgSize, &s) else { return nil }
        return s
    }

    // Some Electron apps need this poked before they expose their tree.
    // Slack, Discord, VS Code, Notion, Figma desktop, etc.
    static func enableManualAccessibility(_ app: AXUIElement) {
        AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    }

    static func appElement(pid: Int32) -> AXUIElement {
        return AXUIElementCreateApplication(pid)
    }

    // Recursive walk. Caps depth + total nodes so a runaway app tree doesn't
    // freeze the LLM. The LLM can opt into deeper walks per call.
    static func outline(
        root: AXUIElement,
        maxDepth: Int = 20,
        maxNodes: Int = 1500,
        store: AxRefStore
    ) async -> AxNode {
        var nodeCount = 0
        func walk(_ el: AXUIElement, depth: Int) async -> AxNode {
            nodeCount += 1
            let role = attrString(el, kAXRoleAttribute as String) ?? "AXUnknown"
            let title = attrString(el, kAXTitleAttribute as String)
            let value = attrString(el, kAXValueAttribute as String)
            let label = attrString(el, kAXDescriptionAttribute as String)
                ?? attrString(el, "AXLabel")
            let identifier = attrString(el, kAXIdentifierAttribute as String)
            let roleDesc = attrString(el, kAXRoleDescriptionAttribute as String)
            let enabled = attrBool(el, kAXEnabledAttribute as String)
            let pos = attrPosition(el).map { [Double($0.x), Double($0.y)] }
            let size = attrSize(el).map { [Double($0.width), Double($0.height)] }
            let ref = await store.assign(el)
            var children: [AxNode] = []
            if depth < maxDepth, nodeCount < maxNodes {
                for c in attrChildren(el) {
                    if nodeCount >= maxNodes { break }
                    children.append(await walk(c, depth: depth + 1))
                }
            }
            return AxNode(
                ref: ref, role: role, role_description: roleDesc,
                title: title, value: value, label: label, identifier: identifier,
                enabled: enabled, position: pos, size: size, children: children
            )
        }
        return await walk(root, depth: 0)
    }
}
