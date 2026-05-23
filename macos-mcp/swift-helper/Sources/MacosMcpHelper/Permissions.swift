// Permission probes. macOS has three relevant TCC entries:
//   - Accessibility (kTCCServiceAccessibility) — required for AX* and CGEvent
//   - Screen Recording (kTCCServiceScreenCapture) — required for ScreenCaptureKit
//   - Input Monitoring (kTCCServiceListenEvent) — only for *tapping* events; we
//     only *post* events, so not required.

import ApplicationServices
import AppKit
import ScreenCaptureKit

enum Permissions {
    static func checkAccessibility(prompt: Bool = false) -> Bool {
        let opts: NSDictionary = [kAXTrustedCheckOptionPrompt.takeUnretainedValue(): prompt]
        return AXIsProcessTrustedWithOptions(opts)
    }

    // Screen Recording has no direct "is granted" API. Best-effort: try to
    // fetch shareable content and see if anything other than our own process
    // comes back. If the system has never prompted, this triggers the prompt
    // as a side effect.
    static func checkScreenRecording() async -> Bool {
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            // If we have NO windows at all we can't really tell; assume false.
            // If we see windows whose owningApplication isn't us, we have access.
            let ourPid = NSRunningApplication.current.processIdentifier
            for w in content.windows where w.owningApplication?.processID != ourPid {
                return true
            }
            return content.windows.isEmpty ? false : true
        } catch {
            return false
        }
    }

    // Open the System Settings pane to the right TCC service.
    static func openSettings(service: String) {
        let url: URL
        switch service {
        case "accessibility":
            url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!
        case "screen_recording":
            url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")!
        default:
            return
        }
        NSWorkspace.shared.open(url)
    }
}
