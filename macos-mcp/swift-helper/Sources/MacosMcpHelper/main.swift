// JSON-RPC dispatcher. Reads newline-delimited JSON from stdin, writes
// newline-delimited JSON to stdout. One message per line, no batching.
//
// Wire format (request):  { "id": 1, "method": "outline", "params": { ... } }
// Wire format (response): { "id": 1, "result": { ... } }
//                    or:  { "id": 1, "error": { "message": "..." } }
//
// stderr is reserved for logs that should bubble to the Node parent.

import Foundation
import AppKit
import ApplicationServices

// MARK: - Wire types

struct Request: Decodable {
    let id: Int
    let method: String
    let params: AnyDecodable?
}

struct Response: Encodable {
    let id: Int
    var result: AnyEncodable?
    var error: ErrorBody?
    struct ErrorBody: Encodable { let message: String }
}

// Type-erased JSON helpers. Swift's Codable is strict; we want params-as-bag
// and result-as-bag for an RPC layer.
struct AnyDecodable: Decodable {
    let value: Any
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let v = try? c.decode(Bool.self) { value = v }
        else if let v = try? c.decode(Int.self) { value = v }
        else if let v = try? c.decode(Double.self) { value = v }
        else if let v = try? c.decode(String.self) { value = v }
        else if let v = try? c.decode([AnyDecodable].self) { value = v.map { $0.value } }
        else if let v = try? c.decode([String: AnyDecodable].self) {
            value = v.mapValues { $0.value }
        }
        else if c.decodeNil() { value = NSNull() }
        else { throw DecodingError.dataCorruptedError(in: c, debugDescription: "AnyDecodable: unknown JSON type") }
    }
}

struct AnyEncodable: Encodable {
    let value: Any
    init(_ value: Any) { self.value = value }
    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch value {
        case let v as Bool: try c.encode(v)
        case let v as Int: try c.encode(v)
        case let v as Int32: try c.encode(Int(v))
        case let v as Int64: try c.encode(v)
        case let v as Double: try c.encode(v)
        case let v as String: try c.encode(v)
        case let v as [Any]: try c.encode(v.map { AnyEncodable($0) })
        case let v as [String: Any]: try c.encode(v.mapValues { AnyEncodable($0) })
        case is NSNull: try c.encodeNil()
        case let v as Encodable: try v.encode(to: encoder)  // structs like AppInfo
        default:
            try c.encodeNil()
        }
    }
}

// MARK: - Helpers

func log(_ s: String) {
    FileHandle.standardError.write(("[macos-mcp-helper] " + s + "\n").data(using: .utf8) ?? Data())
}

func writeResponse(_ r: Response) {
    let enc = JSONEncoder()
    enc.outputFormatting = []
    do {
        var data = try enc.encode(r)
        data.append(0x0A)  // newline
        FileHandle.standardOutput.write(data)
    } catch {
        log("encode error: \(error)")
    }
}

func paramsDict(_ req: Request) -> [String: Any] {
    if let v = req.params?.value as? [String: Any] { return v }
    return [:]
}

// JSON numbers come through as Int when whole, Double when fractional.
// Tools that take coordinates need either — coerce safely.
func numD(_ v: Any?) -> Double? {
    if let d = v as? Double { return d }
    if let i = v as? Int { return Double(i) }
    if let n = v as? NSNumber { return n.doubleValue }
    return nil
}
func numI(_ v: Any?) -> Int? {
    if let i = v as? Int { return i }
    if let d = v as? Double { return Int(d) }
    if let n = v as? NSNumber { return n.intValue }
    return nil
}

// MARK: - Dispatch

func dispatch(_ req: Request) async -> Response {
    let p = paramsDict(req)
    do {
        switch req.method {

        case "ping":
            return Response(id: req.id, result: AnyEncodable(["pong": true, "pid": Int(ProcessInfo.processInfo.processIdentifier)]))

        case "check_permissions":
            let ax = Permissions.checkAccessibility(prompt: false)
            let sr = await Permissions.checkScreenRecording()
            return Response(id: req.id, result: AnyEncodable([
                "accessibility": ax,
                "screen_recording": sr,
            ] as [String: Any]))

        case "open_settings":
            let svc = (p["service"] as? String) ?? "accessibility"
            Permissions.openSettings(service: svc)
            return Response(id: req.id, result: AnyEncodable(["opened": svc]))

        case "list_apps":
            return Response(id: req.id, result: AnyEncodable(Apps.list()))

        case "focus_app":
            guard let app = Apps.find(
                pid: (p["pid"] as? Int).map { Int32($0) },
                bundleId: p["bundle_id"] as? String,
                name: p["name"] as? String
            ) else {
                return Response(id: req.id, error: .init(message: "app not found"))
            }
            let ok = Apps.activate(app)
            return Response(id: req.id, result: AnyEncodable([
                "ok": ok, "pid": Int(app.processIdentifier),
                "name": app.localizedName ?? "",
            ] as [String: Any]))

        case "launch_app":
            guard let app = Apps.launch(
                name: p["name"] as? String,
                bundleId: p["bundle_id"] as? String
            ) else {
                return Response(id: req.id, error: .init(message: "could not launch app"))
            }
            return Response(id: req.id, result: AnyEncodable([
                "pid": Int(app.processIdentifier),
                "name": app.localizedName ?? "",
            ] as [String: Any]))

        case "outline":
            // pid required. Caller can pass enable_manual_accessibility=true
            // (default true) to wake Electron AX trees on first call.
            guard let pidInt = p["pid"] as? Int else {
                return Response(id: req.id, error: .init(message: "pid required"))
            }
            let pid = Int32(pidInt)
            // Reset the ref store so refs start at 1 for each outline call —
            // matches the chrome/android pattern.
            await AxRefStore.shared.reset()
            let app = Ax.appElement(pid: pid)
            let enableManual = (p["enable_manual_accessibility"] as? Bool) ?? true
            if enableManual { Ax.enableManualAccessibility(app) }
            let maxDepth = (p["max_depth"] as? Int) ?? 20
            let maxNodes = (p["max_nodes"] as? Int) ?? 1500
            let node = await Ax.outline(root: app, maxDepth: maxDepth, maxNodes: maxNodes, store: AxRefStore.shared)
            return Response(id: req.id, result: AnyEncodable(node))

        case "click":
            // Two flavors: ref (from a recent outline) or {x, y} raw coords.
            if let ref = p["ref"] as? Int {
                guard let el = await AxRefStore.shared.resolve(ref) else {
                    return Response(id: req.id, error: .init(message: "no element with ref=\(ref) — call outline again"))
                }
                // Prefer the AX press action — works for off-screen / collapsed
                // elements. Fall back to a synthesized mouse click at the
                // element's centre.
                if Input.axPress(el) {
                    return Response(id: req.id, result: AnyEncodable(["ok": true, "via": "ax_press"]))
                }
                guard let pos = Ax.attrPosition(el), let size = Ax.attrSize(el) else {
                    return Response(id: req.id, error: .init(message: "element has no AXPosition/AXSize and AXPress failed"))
                }
                let point = CGPoint(x: pos.x + size.width / 2, y: pos.y + size.height / 2)
                let count = (p["count"] as? Int) ?? 1
                Input.click(at: point, count: count)
                return Response(id: req.id, result: AnyEncodable(["ok": true, "via": "cgevent", "x": point.x, "y": point.y] as [String: Any]))
            }
            if let x = numD(p["x"]), let y = numD(p["y"]) {
                let count = (p["count"] as? Int) ?? 1
                let buttonStr = (p["button"] as? String) ?? "left"
                let btn: CGMouseButton = buttonStr == "right" ? .right : .left
                Input.click(at: CGPoint(x: x, y: y), button: btn, count: count)
                return Response(id: req.id, result: AnyEncodable(["ok": true, "via": "cgevent"]))
            }
            return Response(id: req.id, error: .init(message: "click: pass ref OR (x,y)"))

        case "fill":
            guard let ref = p["ref"] as? Int, let value = p["value"] as? String else {
                return Response(id: req.id, error: .init(message: "fill: ref + value required"))
            }
            guard let el = await AxRefStore.shared.resolve(ref) else {
                return Response(id: req.id, error: .init(message: "no element with ref=\(ref) — call outline again"))
            }
            Input.axFocus(el)
            if Input.axSetValue(el, value) {
                return Response(id: req.id, result: AnyEncodable(["ok": true, "via": "ax_set_value"]))
            }
            // Fallback: focus + click + type. Useful for custom-drawn inputs
            // that reject AXSetValue.
            if let pos = Ax.attrPosition(el), let size = Ax.attrSize(el) {
                Input.click(at: CGPoint(x: pos.x + size.width / 2, y: pos.y + size.height / 2))
            }
            // Tiny delay so the click registers before we start typing.
            try? await Task.sleep(nanoseconds: 50_000_000)
            Input.typeString(value)
            return Response(id: req.id, result: AnyEncodable(["ok": true, "via": "type"]))

        case "press_key":
            guard let key = p["key"] as? String else {
                return Response(id: req.id, error: .init(message: "press_key: key required"))
            }
            let mods = (p["modifiers"] as? [Any])?.compactMap { $0 as? String } ?? []
            if !Input.pressKey(key, modifiers: mods) {
                return Response(id: req.id, error: .init(message: "press_key: unknown key '\(key)'. Known: \(Input.KEYCODES.keys.sorted().joined(separator: ", "))"))
            }
            return Response(id: req.id, result: AnyEncodable(["ok": true]))

        case "type_text":
            guard let value = p["text"] as? String else {
                return Response(id: req.id, error: .init(message: "type_text: text required"))
            }
            Input.typeString(value)
            return Response(id: req.id, result: AnyEncodable(["ok": true]))

        case "hover":
            if let ref = p["ref"] as? Int {
                guard let el = await AxRefStore.shared.resolve(ref) else {
                    return Response(id: req.id, error: .init(message: "no element with ref=\(ref) — call outline again"))
                }
                guard let pos = Ax.attrPosition(el), let size = Ax.attrSize(el) else {
                    return Response(id: req.id, error: .init(message: "element has no AXPosition/AXSize"))
                }
                Input.moveMouse(to: CGPoint(x: pos.x + size.width / 2, y: pos.y + size.height / 2))
                return Response(id: req.id, result: AnyEncodable(["ok": true]))
            }
            if let x = numD(p["x"]), let y = numD(p["y"]) {
                Input.moveMouse(to: CGPoint(x: x, y: y))
                return Response(id: req.id, result: AnyEncodable(["ok": true]))
            }
            return Response(id: req.id, error: .init(message: "hover: pass ref OR (x,y)"))

        case "scroll":
            let dx = Int32(numI(p["dx"]) ?? 0)
            let dy = Int32(numI(p["dy"]) ?? -200)  // default scroll down
            // If a ref is given, move the cursor over it first so the scroll
            // lands on the right scrollable region.
            if let ref = p["ref"] as? Int, let el = await AxRefStore.shared.resolve(ref),
               let pos = Ax.attrPosition(el), let size = Ax.attrSize(el) {
                Input.moveMouse(to: CGPoint(x: pos.x + size.width / 2, y: pos.y + size.height / 2))
                try? await Task.sleep(nanoseconds: 30_000_000)
            }
            Input.scroll(dx: dx, dy: dy)
            return Response(id: req.id, result: AnyEncodable(["ok": true, "dx": Int(dx), "dy": Int(dy)] as [String: Any]))

        case "describe":
            guard let ref = p["ref"] as? Int else {
                return Response(id: req.id, error: .init(message: "describe: ref required"))
            }
            guard let el = await AxRefStore.shared.resolve(ref) else {
                return Response(id: req.id, error: .init(message: "no element with ref=\(ref) — call outline again"))
            }
            var attrs: CFArray?
            AXUIElementCopyAttributeNames(el, &attrs)
            let names = (attrs as? [String]) ?? []
            var out: [String: Any] = ["ref": ref]
            for name in names {
                var raw: CFTypeRef?
                guard AXUIElementCopyAttributeValue(el, name as CFString, &raw) == .success else { continue }
                // Skip children — they'd duplicate the outline.
                if name == kAXChildrenAttribute as String { continue }
                if let s = raw as? String { out[name] = s }
                else if let b = raw as? Bool { out[name] = b }
                else if let n = raw as? Int { out[name] = n }
                else if let v = raw as? Double { out[name] = v }
                else if AXValueGetType(raw as! AXValue) == .cgPoint {
                    var pt = CGPoint.zero
                    AXValueGetValue(raw as! AXValue, .cgPoint, &pt)
                    out[name] = ["x": pt.x, "y": pt.y]
                } else if AXValueGetType(raw as! AXValue) == .cgSize {
                    var sz = CGSize.zero
                    AXValueGetValue(raw as! AXValue, .cgSize, &sz)
                    out[name] = ["w": sz.width, "h": sz.height]
                } else {
                    out[name] = String(describing: raw)
                }
            }
            // Also fetch supported actions so the caller knows what they can do.
            var actions: CFArray?
            AXUIElementCopyActionNames(el, &actions)
            out["actions"] = (actions as? [String]) ?? []
            return Response(id: req.id, result: AnyEncodable(out))

        case "find_text":
            let pid = (p["pid"] as? Int).map { Int32($0) }
            let query = (p["text"] as? String) ?? ""
            let accurate = (p["accurate"] as? Bool) ?? true
            do {
                let (img, origin, size) = try await Capture.captureForOCR(pid: pid)
                let hits = try await OCR.recognize(cgImage: img, regionSize: size, regionOrigin: origin, accurate: accurate)
                // Filter by query if provided (substring, case-insensitive).
                let filtered: [OCR.TextHit] = query.isEmpty
                    ? hits
                    : hits.filter { $0.text.range(of: query, options: .caseInsensitive) != nil }
                return Response(id: req.id, result: AnyEncodable([
                    "hits": filtered,
                    "total_hits": hits.count,
                    "query": query,
                ] as [String: Any]))
            } catch {
                return Response(id: req.id, error: .init(message: "find_text failed: \(error)"))
            }

        case "click_text":
            guard let query = p["text"] as? String, !query.isEmpty else {
                return Response(id: req.id, error: .init(message: "click_text: text required"))
            }
            let pid = (p["pid"] as? Int).map { Int32($0) }
            let occ = (p["occurrence_index"] as? Int) ?? 0
            let exact = (p["exact"] as? Bool) ?? false
            do {
                let (img, origin, size) = try await Capture.captureForOCR(pid: pid)
                let hits = try await OCR.recognize(cgImage: img, regionSize: size, regionOrigin: origin)
                let matches = hits.filter {
                    exact ? $0.text == query : $0.text.range(of: query, options: .caseInsensitive) != nil
                }
                if matches.isEmpty {
                    // Include up to 10 nearest-looking strings to help the agent retarget.
                    let nearby = hits.prefix(20).map { ["text": $0.text, "x": $0.x, "y": $0.y] as [String: Any] }
                    return Response(id: req.id, error: .init(message: "click_text: '\(query)' not found in screen OCR. \(hits.count) text regions seen. Nearby: \(nearby)"))
                }
                if occ >= matches.count {
                    return Response(id: req.id, error: .init(message: "click_text: occurrence_index=\(occ) but only \(matches.count) matches"))
                }
                let hit = matches[occ]
                let cx = hit.x + hit.width / 2
                let cy = hit.y + hit.height / 2
                Input.click(at: CGPoint(x: cx, y: cy))
                return Response(id: req.id, result: AnyEncodable([
                    "ok": true,
                    "matched": hit.text,
                    "x": cx, "y": cy,
                    "total_matches": matches.count,
                ] as [String: Any]))
            } catch {
                return Response(id: req.id, error: .init(message: "click_text failed: \(error)"))
            }

        case "screenshot":
            let pid = (p["pid"] as? Int).map { Int32($0) }
            do {
                let png = try await Capture.screenshot(pid: pid)
                let b64 = png.base64EncodedString()
                return Response(id: req.id, result: AnyEncodable(["png_base64": b64, "bytes": png.count] as [String: Any]))
            } catch {
                return Response(id: req.id, error: .init(message: "screenshot failed: \(error)"))
            }

        default:
            return Response(id: req.id, error: .init(message: "unknown method: \(req.method)"))
        }
    }
}

// MARK: - Stdin loop

@main
struct HelperMain {
    static func main() async {
        log("started (pid=\(ProcessInfo.processInfo.processIdentifier))")
        // Kick off the persistent capture stream so the first screenshot /
        // find_text call hits a warm buffer. Fire-and-forget; failure is
        // tolerable (Capture falls back to one-shot SCK).
        CaptureStream.shared.warmup()
        let dec = JSONDecoder()
        while let line = readLine(strippingNewline: true) {
            if line.isEmpty { continue }
            guard let data = line.data(using: .utf8) else { continue }
            do {
                let req = try dec.decode(Request.self, from: data)
                let res = await dispatch(req)
                writeResponse(res)
            } catch {
                log("bad request: \(error.localizedDescription)")
                // Best-effort error response when we can't even read the id.
                let resp = Response(id: 0, error: .init(message: "bad request: \(error.localizedDescription)"))
                writeResponse(resp)
            }
        }
        log("stdin closed; exiting")
    }
}
