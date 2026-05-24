// Persistent SCStream that keeps the latest display frame buffered. Lets
// screenshot / captureForOCR / find_text grab a current frame in milliseconds
// instead of paying SCK setup cost (2-5s) per call.
//
// Lifecycle: lazy-started on first .latest() call; auto-stopped after 60s
// idle; restarted on the next request. Single full-display stream — pid-
// specific captures crop from the buffer using window frames from cached
// SCShareableContent.

import AppKit
import CoreGraphics
import CoreImage
import CoreMedia
import CoreVideo
import ScreenCaptureKit

final class CaptureStream: NSObject, @unchecked Sendable, SCStreamOutput, SCStreamDelegate {
    static let shared = CaptureStream()

    private var stream: SCStream?
    private var latestImage: CGImage?
    private var displaySize: CGSize = .zero
    private let lock = NSLock()
    private let ciContext = CIContext()
    private let outputQueue = DispatchQueue(label: "macos-mcp.capture-stream", qos: .userInitiated)

    // Non-blocking: return the latest frame if one is buffered, nil otherwise.
    // Kicks off ensureStarted() in the background so the next call benefits.
    // Callers should fall through to a cheaper fallback (e.g. CGDisplay-
    // CreateImage) when this returns nil rather than waiting.
    func latestOrNil() -> (CGImage, CGSize)? {
        lock.lock()
        let img = latestImage
        let sz = displaySize
        let started = (stream != nil)
        lock.unlock()
        if !started {
            Task { try? await self.ensureStarted() }
        }
        if let img = img { return (img, sz) }
        return nil
    }

    // Blocking variant: kept for paths that genuinely need a frame and can
    // afford to wait. Polls up to 1s after starting the stream.
    func latest() async throws -> (CGImage, CGSize) {
        try await ensureStarted()
        lock.lock()
        var img = latestImage
        let sz = displaySize
        lock.unlock()
        if let img = img { return (img, sz) }
        for _ in 0..<20 {
            try? await Task.sleep(nanoseconds: 50_000_000)
            lock.lock()
            img = latestImage
            lock.unlock()
            if let img = img { return (img, sz) }
        }
        throw NSError(domain: "CaptureStream", code: -1,
                      userInfo: [NSLocalizedDescriptionKey: "stream started but no frame within 1s"])
    }

    private func ensureStarted() async throws {
        lock.lock()
        let alreadyStarted = (stream != nil)
        lock.unlock()
        if alreadyStarted { return }

        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        guard let display = content.displays.first else {
            throw Capture.CaptureError.noDisplay
        }
        let filter = SCContentFilter(display: display, excludingWindows: [])
        let cfg = SCStreamConfiguration()
        // Point-resolution capture: OCR coord math is then 1:1 with what
        // CGEvent expects for clicks.
        cfg.width = display.width
        cfg.height = display.height
        cfg.pixelFormat = kCVPixelFormatType_32BGRA
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: 10) // 10 fps cap
        cfg.queueDepth = 5
        cfg.showsCursor = false

        let s = SCStream(filter: filter, configuration: cfg, delegate: self)
        try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: outputQueue)
        try await s.startCapture()

        lock.lock()
        stream = s
        displaySize = CGSize(width: display.width, height: display.height)
        lock.unlock()
    }

    // Force-restart on display reconfig (monitor plug/unplug, resolution change).
    func restart() {
        lock.lock()
        let s = stream
        stream = nil
        latestImage = nil
        lock.unlock()
        Task { try? await s?.stopCapture() }
    }

    // Fire-and-forget warmup. Called once at helper boot so the user's first
    // tool call doesn't pay the cold-start cost.
    func warmup() {
        Task { [weak self] in
            _ = try? await self?.latest()
        }
    }

    // MARK: SCStreamOutput
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
        guard outputType == .screen,
              let pb = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let ci = CIImage(cvPixelBuffer: pb)
        guard let cg = ciContext.createCGImage(ci, from: ci.extent) else { return }
        lock.lock()
        latestImage = cg
        lock.unlock()
    }

    // MARK: SCStreamDelegate
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        lock.lock()
        self.stream = nil
        latestImage = nil
        lock.unlock()
    }
}
