// Screen capture. Tiered fast paths:
//   1) CaptureStream.latest() — persistent SCStream buffer, sub-10ms after warm.
//   2) CGDisplayCreateImage via dlsym — Apple obsoleted it in the macOS 15 SDK
//      headers but the symbol is still exported by CoreGraphics at runtime on
//      macOS 15 + 16. Sub-50ms synchronous one-shot, no SCK setup cost.
//      Perfect for the cold-start case before the stream's first frame lands.
//   3) SCScreenshotManager.captureImage — last-resort if both above fail.
//
// SCShareableContent is fetched once at startup and refreshed only on display
// reconfiguration (monitor plug/unplug). It was previously TTL-cached at 5s,
// which made every 5s mark pay a synchronous WindowServer round-trip for no
// reason — that list never changes outside of display events.

import AppKit
import CoreGraphics
import Darwin
import ScreenCaptureKit
import UniformTypeIdentifiers

enum Capture {
    enum CaptureError: Error { case noDisplay, encodingFailed, ckError(String) }

    // MARK: - Shareable content cache (never expires; invalidated on display reconfig)

    private static var cachedContent: SCShareableContent?
    private static var displayReconfigInstalled = false
    private static let contentLock = NSLock()

    static func freshContent(forceRefresh: Bool = false) async throws -> SCShareableContent {
        installDisplayReconfigCallback()
        contentLock.lock()
        if !forceRefresh, let c = cachedContent { contentLock.unlock(); return c }
        contentLock.unlock()
        let c = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        contentLock.lock()
        cachedContent = c
        contentLock.unlock()
        return c
    }

    static func invalidateContentCache() {
        contentLock.lock()
        cachedContent = nil
        contentLock.unlock()
    }

    private static func installDisplayReconfigCallback() {
        contentLock.lock()
        let already = displayReconfigInstalled
        if !already { displayReconfigInstalled = true }
        contentLock.unlock()
        if already { return }
        CGDisplayRegisterReconfigurationCallback({ _, _, _ in
            // Display topology changed — drop our caches; stream will restart
            // on next .latest() call too.
            Capture.invalidateContentCache()
            CaptureStream.shared.restart()
        }, nil)
    }

    // MARK: - dlsym fallback: CGDisplayCreateImage

    private typealias CGDisplayCreateImageFn = @convention(c) (CGDirectDisplayID) -> Unmanaged<CGImage>?
    private static let cgDisplayCreateImageFn: CGDisplayCreateImageFn? = {
        // RTLD_DEFAULT == -2 cast to UnsafeMutableRawPointer
        guard let sym = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "CGDisplayCreateImage") else { return nil }
        return unsafeBitCast(sym, to: CGDisplayCreateImageFn.self)
    }()

    private static func cgDisplayCreateImageFallback(rect: CGRect? = nil) -> CGImage? {
        let displayID = CGMainDisplayID()
        guard let fn = cgDisplayCreateImageFn,
              let img = fn(displayID)?.takeRetainedValue() else { return nil }
        if let rect = rect, let cropped = img.cropping(to: rect) { return cropped }
        return img
    }

    // MARK: - Public capture API

    // Returns the raw CGImage AND the screen-point geometry of the captured
    // region. OCR uses this so its normalized bboxes can be mapped to actual
    // screen coordinates that CGEvent.post will land clicks on.
    //
    // When pid is given and a window for that app is found, we crop to that
    // window's frame. Otherwise we capture the main display in full.
    static func captureForOCR(pid: Int32? = nil) async throws -> (CGImage, CGPoint, CGSize) {
        // Resolve target window's frame (if any) from cached SCShareableContent.
        var origin = CGPoint.zero
        var sizePts: CGSize? = nil
        if let pid = pid {
            if let win = try? await firstFrontWindow(pid: pid) {
                origin = win.frame.origin
                sizePts = win.frame.size
            }
        }

        // Tier 1: persistent stream.
        if let (full, displaySz) = try? await CaptureStream.shared.latest() {
            if let s = sizePts {
                let cropRect = CGRect(x: origin.x, y: origin.y, width: s.width, height: s.height)
                if let cropped = full.cropping(to: cropRect) {
                    return (cropped, origin, s)
                }
            }
            return (full, .zero, displaySz)
        }

        // Tier 2: dlsym CGDisplayCreateImage — sub-50ms, no SCK setup.
        if let full = cgDisplayCreateImageFallback() {
            let displaySz = CGSize(width: full.width, height: full.height)
            // CGDisplayCreateImage returns pixel-resolution. We need point-res
            // for OCR coord math. Scale factor from main display:
            let scale = NSScreen.main?.backingScaleFactor ?? 2.0
            let ptSize = CGSize(width: displaySz.width / scale, height: displaySz.height / scale)
            if let s = sizePts {
                // Map point-rect to pixel-rect for the crop.
                let pxRect = CGRect(x: origin.x * scale, y: origin.y * scale,
                                    width: s.width * scale, height: s.height * scale)
                if let cropped = full.cropping(to: pxRect) {
                    return (cropped, origin, s)
                }
            }
            return (full, .zero, ptSize)
        }

        // Tier 3: SCScreenshotManager one-shot.
        return try await oneShotCaptureForOCR(pid: pid, origin: origin, sizePts: sizePts)
    }

    private static func oneShotCaptureForOCR(pid: Int32?, origin: CGPoint, sizePts: CGSize?) async throws -> (CGImage, CGPoint, CGSize) {
        let content = try await freshContent()
        guard let display = content.displays.first else { throw CaptureError.noDisplay }
        // Use a window-specific filter when we can — it's hardware-composited,
        // cheaper than full-display + crop.
        let filter: SCContentFilter
        if let pid = pid,
           let win = content.windows.first(where: { $0.owningApplication?.processID == pid && $0.frame.width > 100 }) {
            filter = SCContentFilter(desktopIndependentWindow: win)
        } else {
            filter = SCContentFilter(display: display, excludingWindows: [])
        }
        let cfg = SCStreamConfiguration()
        cfg.width = Int(filter.contentRect.width)
        cfg.height = Int(filter.contentRect.height)
        cfg.showsCursor = false
        let full = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
        if pid != nil, let s = sizePts {
            // Window filter returns content sized to the window; report origin as the window origin.
            return (full, origin, s)
        }
        return (full, .zero, CGSize(width: display.width, height: display.height))
    }

    private static func firstFrontWindow(pid: Int32) async throws -> SCWindow? {
        let content = try await freshContent()
        return content.windows.first { $0.owningApplication?.processID == pid && $0.frame.width > 100 }
    }

    static func screenshot(pid: Int32? = nil) async throws -> Data {
        // Tier 1: stream.
        if let (full, _) = try? await CaptureStream.shared.latest() {
            var img = full
            if let pid = pid, let win = try? await firstFrontWindow(pid: pid) {
                let cropRect = CGRect(x: win.frame.origin.x, y: win.frame.origin.y,
                                      width: win.frame.width, height: win.frame.height)
                if let cropped = full.cropping(to: cropRect) { img = cropped }
            }
            if let png = pngData(from: img) { return png }
        }

        // Tier 2: dlsym CGDisplayCreateImage.
        if let full = cgDisplayCreateImageFallback() {
            var img = full
            if let pid = pid, let win = try? await firstFrontWindow(pid: pid) {
                let scale = NSScreen.main?.backingScaleFactor ?? 2.0
                let pxRect = CGRect(x: win.frame.origin.x * scale, y: win.frame.origin.y * scale,
                                    width: win.frame.width * scale, height: win.frame.height * scale)
                if let cropped = full.cropping(to: pxRect) { img = cropped }
            }
            if let png = pngData(from: img) { return png }
        }

        // Tier 3: SCK one-shot.
        let content = try await freshContent()
        guard let display = content.displays.first else { throw CaptureError.noDisplay }
        let filter: SCContentFilter
        if let pid = pid,
           let win = content.windows.first(where: { $0.owningApplication?.processID == pid && $0.frame.width > 100 }) {
            filter = SCContentFilter(desktopIndependentWindow: win)
        } else {
            filter = SCContentFilter(display: display, excludingWindows: [])
        }
        let cfg = SCStreamConfiguration()
        cfg.width = Int(filter.contentRect.width) * 2
        cfg.height = Int(filter.contentRect.height) * 2
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
