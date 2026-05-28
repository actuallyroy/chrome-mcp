// Built-in Windows OCR via Windows.Media.Ocr. Drives apps with no UIA tree:
// games, custom-rendered canvases, Electron without ARIA labels.
//
// We capture, hand the bitmap to OcrEngine, return per-line bounding boxes in
// screen-coordinate space (so click_text can SendInput at the centre).

using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.Versioning;
using Windows.Globalization;
using Windows.Graphics.Imaging;
using Windows.Media.Ocr;
using Windows.Storage.Streams;

namespace WindowsMcpHelper;

[SupportedOSPlatform("windows10.0.19041.0")]
internal static class Ocr
{
    private sealed class TextHit
    {
        public string Text { get; set; } = "";
        public double X { get; set; }
        public double Y { get; set; }
        public double Width { get; set; }
        public double Height { get; set; }
    }

    public static (List<Dictionary<string, object?>> hits, int totalHits) FindText(int? pid, string query, string lang)
    {
        var raw = Recognize(pid, lang);
        var filtered = string.IsNullOrEmpty(query)
            ? raw
            : raw.Where(h => h.Text.Contains(query, StringComparison.OrdinalIgnoreCase)).ToList();
        var hits = filtered.Select(h => new Dictionary<string, object?>
        {
            ["text"] = h.Text,
            ["x"] = h.X, ["y"] = h.Y,
            ["width"] = h.Width, ["height"] = h.Height,
        }).ToList();
        return (hits, raw.Count);
    }

    public static Dictionary<string, object?> ClickText(int? pid, string query, int occurrenceIndex, bool exact, string lang)
    {
        var hits = Recognize(pid, lang);
        var matches = hits.Where(h => exact
            ? string.Equals(h.Text, query, StringComparison.Ordinal)
            : h.Text.Contains(query, StringComparison.OrdinalIgnoreCase)).ToList();
        if (matches.Count == 0)
        {
            var nearby = hits.Take(20).Select(h => new Dictionary<string, object?>
            {
                ["text"] = h.Text, ["x"] = h.X, ["y"] = h.Y,
            }).ToList();
            throw new InvalidOperationException(
                $"click_text: '{query}' not found in screen OCR. {hits.Count} text regions seen. Nearby: " +
                System.Text.Json.JsonSerializer.Serialize(nearby, JsonOpts.Default));
        }
        if (occurrenceIndex >= matches.Count)
            throw new InvalidOperationException($"click_text: occurrence_index={occurrenceIndex} but only {matches.Count} matches");

        var hit = matches[occurrenceIndex];
        var cx = hit.X + hit.Width / 2;
        var cy = hit.Y + hit.Height / 2;
        Input.ClickAt(cx, cy, "left", 1);
        return new Dictionary<string, object?>
        {
            ["ok"] = true,
            ["matched"] = hit.Text,
            ["x"] = cx,
            ["y"] = cy,
            ["total_matches"] = matches.Count,
        };
    }

    [SupportedOSPlatform("windows")]
    private static List<TextHit> Recognize(int? pid, string lang)
    {
        var engine = ResolveEngine(lang)
            ?? throw new InvalidOperationException(
                $"Windows.Media.Ocr has no engine for language '{lang}'. Install the language pack in Settings → Time & Language → Language.");

        // Capture the image we'll OCR + remember its origin offset so we can map
        // OCR pixel-coords back to absolute screen-coords.
        var (pngBytes, originX, originY) = CaptureForOcr(pid);
        if (pngBytes.Length == 0) return new List<TextHit>();

        var sw = Stopwatch.StartNew();
        var result = RunOcrAsync(engine, pngBytes).GetAwaiter().GetResult();
        sw.Stop();
        Program.Log($"ocr: {result.Lines.Count} lines in {sw.ElapsedMilliseconds}ms (lang={lang})");

        var hits = new List<TextHit>();
        foreach (var line in result.Lines)
        {
            // Union of word bounding rects — close to Apple Vision's per-line box.
            if (line.Words.Count == 0) continue;
            double left = double.MaxValue, top = double.MaxValue, right = 0, bottom = 0;
            foreach (var w in line.Words)
            {
                var r = w.BoundingRect;
                if (r.Left < left) left = r.Left;
                if (r.Top < top) top = r.Top;
                if (r.Right > right) right = r.Right;
                if (r.Bottom > bottom) bottom = r.Bottom;
            }
            hits.Add(new TextHit
            {
                Text = line.Text,
                X = originX + left,
                Y = originY + top,
                Width = right - left,
                Height = bottom - top,
            });
        }
        return hits;
    }

    private static async Task<OcrResult> RunOcrAsync(OcrEngine engine, byte[] pngBytes)
    {
        using var ras = new InMemoryRandomAccessStream();
        using (var writer = new DataWriter(ras))
        {
            writer.WriteBytes(pngBytes);
            await writer.StoreAsync();
            await writer.FlushAsync();
            writer.DetachStream();
        }
        ras.Seek(0);
        var decoder = await BitmapDecoder.CreateAsync(ras);
        var bmp = await decoder.GetSoftwareBitmapAsync();
        return await engine.RecognizeAsync(bmp);
    }

    private static OcrEngine? ResolveEngine(string lang)
    {
        try
        {
            var byLang = OcrEngine.TryCreateFromLanguage(new Language(lang));
            if (byLang != null) return byLang;
        }
        catch { }
        try { return OcrEngine.TryCreateFromUserProfileLanguages(); }
        catch { return null; }
    }

    [SupportedOSPlatform("windows")]
    private static (byte[] png, double originX, double originY) CaptureForOcr(int? pid)
    {
        if (pid.HasValue)
        {
            var hWnd = FindTopWindowForPid(pid.Value);
            if (hWnd != IntPtr.Zero)
            {
                // CapturePrintWindow first; if it fails, BitBlt of bounding rect.
                if (Native.GetWindowRect(hWnd, out var r))
                {
                    int w = r.Width, h = r.Height;
                    if (w > 0 && h > 0)
                    {
                        // PrintWindow path.
                        try
                        {
                            using var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
                            using (var g = Graphics.FromImage(bmp))
                            {
                                var hdc = g.GetHdc();
                                try
                                {
                                    if (Native.PrintWindow(hWnd, hdc, Native.PW_RENDERFULLCONTENT))
                                    {
                                        g.ReleaseHdc(hdc);
                                        using var ms = new MemoryStream();
                                        bmp.Save(ms, ImageFormat.Png);
                                        return (ms.ToArray(), r.left, r.top);
                                    }
                                }
                                finally { try { g.ReleaseHdc(hdc); } catch { } }
                            }
                        }
                        catch { }
                        // Fall back to BitBlt.
                        return (BitBltRect(r.left, r.top, w, h), r.left, r.top);
                    }
                }
            }
        }
        // Full virtual screen.
        var vx = Native.GetSystemMetrics(Native.SM_XVIRTUALSCREEN);
        var vy = Native.GetSystemMetrics(Native.SM_YVIRTUALSCREEN);
        var vw = Native.GetSystemMetrics(Native.SM_CXVIRTUALSCREEN);
        var vh = Native.GetSystemMetrics(Native.SM_CYVIRTUALSCREEN);
        if (vw <= 0 || vh <= 0)
        {
            vw = Native.GetSystemMetrics(Native.SM_CXSCREEN);
            vh = Native.GetSystemMetrics(Native.SM_CYSCREEN);
            vx = vy = 0;
        }
        return (BitBltRect(vx, vy, vw, vh), vx, vy);
    }

    [SupportedOSPlatform("windows")]
    private static byte[] BitBltRect(int x, int y, int w, int h)
    {
        if (w <= 0 || h <= 0) return Array.Empty<byte>();
        using var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(bmp))
        {
            g.CopyFromScreen(x, y, 0, 0, new Size(w, h), CopyPixelOperation.SourceCopy);
        }
        using var ms = new MemoryStream();
        bmp.Save(ms, ImageFormat.Png);
        return ms.ToArray();
    }

    private static IntPtr FindTopWindowForPid(int pid)
    {
        var best = IntPtr.Zero;
        var bestArea = 0L;
        Native.EnumWindows((hWnd, _) =>
        {
            if (!Native.IsWindowVisible(hWnd)) return true;
            Native.GetWindowThreadProcessId(hWnd, out var wpid);
            if ((int)wpid != pid) return true;
            if (!Native.GetWindowRect(hWnd, out var r)) return true;
            var area = (long)r.Width * r.Height;
            if (area > bestArea)
            {
                bestArea = area;
                best = hWnd;
            }
            return true;
        }, IntPtr.Zero);
        return best;
    }
}
