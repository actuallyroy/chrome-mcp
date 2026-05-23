// Apple Vision OCR. Used by find_text / click_text to drive apps whose UI
// doesn't expose an AX tree at all — GPUI editors (Zed, SCE), Metal-rendered
// apps (Logic, Final Cut, games), custom-drawn canvases (Adobe).
//
// VNRecognizeTextRequest is on-device, free, ~80ms per screenshot on Apple
// Silicon, ships in macOS 10.15+. Bounding boxes come back normalized (0-1)
// with origin at bottom-left; we convert to screen points (origin top-left)
// so CGEvent clicks land where the text actually is.

import CoreGraphics
import Vision

enum OCR {
    struct TextHit: Codable {
        let text: String
        let x: Double        // screen-point x of bbox top-left
        let y: Double        // screen-point y of bbox top-left
        let width: Double
        let height: Double
        let confidence: Float
    }

    enum OCRError: Error { case failed(String) }

    static func recognize(
        cgImage: CGImage,
        regionSize: CGSize,            // size to map normalized bbox into (screen points)
        regionOrigin: CGPoint = .zero, // offset to add (when capturing a window crop)
        languages: [String] = ["en-US"],
        accurate: Bool = true,
    ) async throws -> [TextHit] {
        return try await withCheckedThrowingContinuation { cont in
            let req = VNRecognizeTextRequest { request, err in
                if let err = err { cont.resume(throwing: err); return }
                let observations = (request.results as? [VNRecognizedTextObservation]) ?? []
                let hits: [TextHit] = observations.compactMap { obs in
                    guard let top = obs.topCandidates(1).first else { return nil }
                    let bb = obs.boundingBox
                    // Vision: origin bottom-left, y grows up; screen points: origin top-left, y grows down.
                    let x = regionOrigin.x + bb.minX * regionSize.width
                    let y = regionOrigin.y + (1.0 - bb.maxY) * regionSize.height
                    let w = bb.width * regionSize.width
                    let h = bb.height * regionSize.height
                    return TextHit(text: top.string, x: x, y: y, width: w, height: h, confidence: top.confidence)
                }
                cont.resume(returning: hits)
            }
            req.recognitionLevel = accurate ? .accurate : .fast
            // Language correction "fixes" code-like strings (var names, filenames)
            // into English words. Always off for UI/code OCR.
            req.usesLanguageCorrection = false
            req.recognitionLanguages = languages
            do {
                let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
                try handler.perform([req])
            } catch {
                cont.resume(throwing: error)
            }
        }
    }
}
