// Single-frame screenshot via ScreenCaptureKit. Replaces CGWindowListCreateImage
// (obsoleted in macOS 15). Returns PNG bytes.

import AppKit
import CoreGraphics
import ScreenCaptureKit
import UniformTypeIdentifiers

enum Capture {
    enum CaptureError: Error { case noDisplay, encodingFailed, ckError(String) }

    static func screenshot(pid: Int32? = nil) async throws -> Data {
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        guard let display = content.displays.first else { throw CaptureError.noDisplay }

        // If a pid is specified, restrict to that app's windows; otherwise full display.
        let filter: SCContentFilter
        if let pid = pid,
           let app = content.applications.first(where: { $0.processID == pid }) {
            filter = SCContentFilter(display: display, including: [app], exceptingWindows: [])
        } else {
            filter = SCContentFilter(display: display, excludingWindows: [])
        }

        let cfg = SCStreamConfiguration()
        cfg.width = display.width * 2  // retina
        cfg.height = display.height * 2
        cfg.showsCursor = false

        let img = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
        guard let png = pngData(from: img) else { throw CaptureError.encodingFailed }
        return png
    }

    private static func pngData(from cg: CGImage) -> Data? {
        let rep = NSBitmapImageRep(cgImage: cg)
        return rep.representation(using: .png, properties: [:])
    }
}
