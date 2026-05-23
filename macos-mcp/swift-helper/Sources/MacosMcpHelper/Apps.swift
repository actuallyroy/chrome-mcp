// Application enumeration + activation. Uses NSRunningApplication for the
// list and LaunchServices for `open -a`-style launching.

import AppKit
import ApplicationServices

struct AppInfo: Codable {
    let pid: Int32
    let bundle_id: String?
    let name: String
    let active: Bool
    let hidden: Bool
}

enum Apps {
    static func list() -> [AppInfo] {
        NSWorkspace.shared.runningApplications.compactMap { a in
            // Filter out faceless background helpers — they have no AX tree
            // worth talking to, and showing them clutters the LLM's view.
            guard a.activationPolicy == .regular else { return nil }
            return AppInfo(
                pid: a.processIdentifier,
                bundle_id: a.bundleIdentifier,
                name: a.localizedName ?? "(unknown)",
                active: a.isActive,
                hidden: a.isHidden
            )
        }
    }

    // Resolve a pid (preferred), then bundle_id, then name (case-insensitive).
    static func find(pid: Int32? = nil, bundleId: String? = nil, name: String? = nil) -> NSRunningApplication? {
        if let pid = pid { return NSRunningApplication(processIdentifier: pid) }
        let all = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
        if let b = bundleId, let hit = all.first(where: { $0.bundleIdentifier == b }) { return hit }
        if let n = name?.lowercased(), let hit = all.first(where: { ($0.localizedName ?? "").lowercased() == n }) { return hit }
        return nil
    }

    // Bring an app to the front. macOS 14+ "cooperative activation" silently
    // ignores NSRunningApplication.activate() when called from a process the
    // user didn't just click — our helper has no foreground status, so this
    // always-no-ops. The reliable fallback is AppleScript via NSAppleScript,
    // which routes through Apple Events daemon and isn't subject to the rule.
    static func activate(_ app: NSRunningApplication) -> Bool {
        // First try the modern API (works on the rare path where we ARE the
        // frontmost app — e.g. user just allowed accessibility prompt).
        _ = app.activate(options: [.activateAllWindows])

        // Always also fire AppleScript activation. Identify by bundle id when
        // available (more robust), otherwise by localized name.
        let target: String
        if let bid = app.bundleIdentifier, !bid.isEmpty {
            target = "id \"\(bid)\""
        } else if let name = app.localizedName, !name.isEmpty {
            target = "\"\(name.replacingOccurrences(of: "\"", with: "\\\""))\""
        } else {
            return app.isActive
        }
        let script = "tell application \(target) to activate"
        if let s = NSAppleScript(source: script) {
            var err: NSDictionary?
            _ = s.executeAndReturnError(&err)
            if let err = err {
                FileHandle.standardError.write(("[macos-mcp-helper] activate AppleScript error: \(err)\n").data(using: .utf8) ?? Data())
            }
        }

        // Small settle delay so subsequent key events land on the new frontmost.
        Thread.sleep(forTimeInterval: 0.12)
        // Re-query to see if it actually became active.
        return NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier
    }

    // `open -a "App Name"` style launch, returns the running app once it appears.
    static func launch(name: String?, bundleId: String?, timeoutSec: Double = 8.0) -> NSRunningApplication? {
        let cfg = NSWorkspace.OpenConfiguration()
        cfg.activates = true
        let group = DispatchGroup()
        var result: NSRunningApplication?
        group.enter()
        let onDone: (NSRunningApplication?, Error?) -> Void = { app, _ in result = app; group.leave() }
        if let b = bundleId, let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: b) {
            NSWorkspace.shared.openApplication(at: url, configuration: cfg, completionHandler: onDone)
        } else if let n = name {
            // Use absolute /Applications path lookup as a fallback.
            let candidates = ["/Applications/\(n).app", "/System/Applications/\(n).app",
                              "\(NSHomeDirectory())/Applications/\(n).app"]
            if let path = candidates.first(where: { FileManager.default.fileExists(atPath: $0) }) {
                NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: path), configuration: cfg, completionHandler: onDone)
            } else {
                return nil
            }
        } else {
            return nil
        }
        _ = group.wait(timeout: .now() + timeoutSec)
        return result
    }
}
