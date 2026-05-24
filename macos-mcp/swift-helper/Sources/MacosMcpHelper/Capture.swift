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
    //
    // Prefers the persistent CaptureStream (sub-10ms per call after the first)
    // and falls back to one-shot SCScreenshotManager only if the stream fails.
    static func captureForOCR(pid: Int32? = nil) async throws -> (CGImage, CGPoint, CGSize) {
        // Resolve crop rect (if any) from cached SCShareableContent so we can
        // hand the caller the right origin/size for OCR coord math.
        var origin = CGPoint.zero
        var sizePts: CGSize? = nil
        if let pid = pid {
            do {
                let content = try await freshContent()
                if let win = content.windows.first(where: { $0.owningApplication?.processID == pid && $0.frame.width > 100 }) {
                    origin = win.frame.origin
                    sizePts = win.frame.size
                }
            } catch { /* fall through to full-display capture */ }
        }

        // Fast path: persistent stream.
        do {
            let (full, displaySz) = try await CaptureStream.shared.latest()
            if let s = sizePts {
                let cropRect = CGRect(x: origin.x, y: origin.y, width: s.width, height: s.height)
                if let cropped = full.cropping(to: cropRect) {
                    return (cropped, origin, s)
                }
            }
            return (full, .zero, displaySz)
        } catch { /* fall back to one-shot */ }

        return try await oneShotCaptureForOCR(pid: pid, origin: origin, sizePts: sizePts)
    }

    private static func oneShotCaptureForOCR(pid: Int32?, origin: CGPoint, sizePts: CGSize?) async throws -> (CGImage, CGPoint, CGSize) {
        let content = try await freshContent()
        guard let display = content.displays.first else { throw CaptureError.noDisplay }
        let filter = SCContentFilter(display: display, excludingWindows: [])
        let cfg = SCStreamConfiguration()
        cfg.width = display.width
        cfg.height = display.height
        cfg.showsCursor = false
        let full = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
        if let s = sizePts {
            let cropRect = CGRect(x: origin.x, y: origin.y, width: s.width, height: s.height)
            if let cropped = full.cropping(to: cropRect) { return (cropped, origin, s) }
        }
        return (full, .zero, CGSize(width: display.width, height: display.height))
    }

    static func screenshot(pid: Int32? = nil) async throws -> Data {
        // Fast path: persistent stream, crop if needed.
        do {
            let (full, displaySz) = try await CaptureStream.shared.latest()
            var img = full
            if let pid = pid {
                let content = try await freshContent()
                if let win = content.windows.first(where: { $0.owningApplication?.processID == pid && $0.frame.width > 100 }) {
                    let cropRect = CGRect(x: win.frame.origin.x, y: win.frame.origin.y, width: win.frame.width, height: win.frame.height)
                    if let cropped = full.cropping(to: cropRect) { img = cropped }
                }
            }
            _ = displaySz
            guard let png = pngData(from: img) else { throw CaptureError.encodingFailed }
            return png
        } catch { /* fall through */ }

        // Fallback: one-shot SCK with retina dimensions.
        let content = try await freshContent()
        guard let display = content.displays.first else { throw CaptureError.noDisplay }
        let filter: SCContentFilter
        if let pid = pid,
           let app = content.applications.first(where: { $0.processID == pid }) {
            filter = SCContentFilter(display: display, including: [app], exceptingWindows: [])
        } else {
            filter = SCContentFilter(display: display, excludingWindows: [])
        }
        let cfg = SCStreamConfiguration()
        cfg.width = display.width * 2
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
