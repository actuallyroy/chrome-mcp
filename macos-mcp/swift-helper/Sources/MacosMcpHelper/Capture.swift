// Single-frame screenshot via ScreenCaptureKit. Replaces CGWindowListCreateImage
// (obsoleted in macOS 15). Returns PNG bytes.

import AppKit
import CoreGraphics
import ScreenCaptureKit
import UniformTypeIdentifiers

enum Capture {
    enum CaptureError: Error { case noDisplay, encodingFailed, ckError(String) }

    // SCShareableContent is a heavy query (the WindowServer scans every window
    // and app). Cache it for a few seconds — that's plenty stable for the
    // sub-second cadence our tools call screenshot/OCR at.
    private static var cachedContent: (content: SCShareableContent, ts: Date)?
    private static let CACHE_TTL: TimeInterval = 5.0

    private static func freshContent() async throws -> SCShareableContent {
        if let cached = cachedContent, Date().timeIntervalSince(cached.ts) < CACHE_TTL {
            return cached.content
        }
        let c = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        cachedContent = (c, Date())
        return c
    }

    // Returns the raw CGImage AND the screen-point geometry of the captured
    // region. OCR uses this so its normalized bboxes can be mapped to actual
    // screen coordinates that CGEvent.post will land clicks on.
    //
    // When pid is given and a window for that app is found, we crop to that
    // window's frame. Otherwise we capture the main display in full.
    static func captureForOCR(pid: Int32? = nil) async throws -> (CGImage, CGPoint, CGSize) {
        let content = try await freshContent()
        guard let display = content.displays.first else { throw CaptureError.noDisplay }

        // Try for the foreground window of the target pid so OCR text positions
        // line up with where you'd actually want to click inside the app.
        var origin = CGPoint.zero
        var sizePts = CGSize(width: display.width, height: display.height)
        var filter: SCContentFilter

        if let pid = pid,
           let app = content.applications.first(where: { $0.processID == pid }),
           let win = content.windows.first(where: { $0.owningApplication?.processID == pid && $0.frame.width > 100 }) {
            filter = SCContentFilter(display: display, including: [app], exceptingWindows: [])
            origin = win.frame.origin
            sizePts = win.frame.size
            _ = filter
            // Capture the full display; we'll crop after.
            filter = SCContentFilter(display: display, excludingWindows: [])
        } else {
            filter = SCContentFilter(display: display, excludingWindows: [])
        }

        let cfg = SCStreamConfiguration()
        // Point-resolution capture: width/height in pixels == display points
        // for the OCR coord math to be 1:1. (We lose retina sharpness here,
        // but Vision OCR is plenty accurate at this scale.)
        cfg.width = display.width
        cfg.height = display.height
        cfg.showsCursor = false

        let full = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)

        // Crop to the target window if we have one (origin / sizePts non-default).
        if origin != .zero || sizePts != CGSize(width: display.width, height: display.height) {
            let cropRect = CGRect(x: origin.x, y: origin.y, width: sizePts.width, height: sizePts.height)
            if let cropped = full.cropping(to: cropRect) {
                return (cropped, origin, sizePts)
            }
        }
        return (full, .zero, CGSize(width: display.width, height: display.height))
    }

    static func screenshot(pid: Int32? = nil) async throws -> Data {
        let content = try await freshContent()
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
