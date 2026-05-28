// Screen capture. Two paths:
//   1) pid given + visible top-level window — PrintWindow with PW_RENDERFULLCONTENT
//      (works for occluded windows; DWM composes the bitmap for us).
//   2) Full screen — BitBlt from the virtual desktop DC.
//
// Output is always a PNG byte[] returned as base64 to the Node side.

using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.Versioning;

namespace WindowsMcpHelper;

[SupportedOSPlatform("windows")]
internal static class Capture
{
    public static byte[] Screenshot(int? pid)
    {
        if (pid.HasValue)
        {
            var hWnd = FindTopWindow(pid.Value);
            if (hWnd != IntPtr.Zero)
            {
                var bytes = CaptureWindowPrint(hWnd);
                if (bytes.Length > 0) return bytes;
                // PrintWindow failed (Chromium, some games). Fall through to BitBlt of its bounding rect.
                if (Native.GetWindowRect(hWnd, out var r))
                    return CaptureRect(r.left, r.top, r.Width, r.Height);
            }
        }
        return CaptureVirtualScreen();
    }

    private static IntPtr FindTopWindow(int pid)
    {
        // Pick the largest visible top-level window for that pid.
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

    private static byte[] CaptureWindowPrint(IntPtr hWnd)
    {
        if (!Native.GetWindowRect(hWnd, out var r)) return Array.Empty<byte>();
        int w = r.Width, h = r.Height;
        if (w <= 0 || h <= 0) return Array.Empty<byte>();

        using var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(bmp))
        {
            var hdc = g.GetHdc();
            try
            {
                var ok = Native.PrintWindow(hWnd, hdc, Native.PW_RENDERFULLCONTENT);
                if (!ok) return Array.Empty<byte>();
            }
            finally { g.ReleaseHdc(hdc); }
        }
        using var ms = new MemoryStream();
        bmp.Save(ms, ImageFormat.Png);
        return ms.ToArray();
    }

    private static byte[] CaptureRect(int x, int y, int w, int h)
    {
        if (w <= 0 || h <= 0) return Array.Empty<byte>();
        // CopyFromScreen grabs a fresh screen DC each call. Right after a
        // sandbox session initializes (and intermittently afterwards) the
        // screen DC can be transiently unavailable — Win32 surfaces this as
        // "The handle is invalid". Retry a couple times with a short backoff
        // before giving up; this turns the reported ~50% post-boot failures
        // into reliable captures.
        Exception? last = null;
        for (int attempt = 0; attempt < 3; attempt++)
        {
            try
            {
                using var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
                using (var g = Graphics.FromImage(bmp))
                {
                    g.CopyFromScreen(x, y, 0, 0, new Size(w, h), CopyPixelOperation.SourceCopy);
                }
                using var ms = new MemoryStream();
                bmp.Save(ms, ImageFormat.Png);
                return ms.ToArray();
            }
            catch (Exception ex)
            {
                last = ex;
                Thread.Sleep(150 * (attempt + 1));
            }
        }
        throw new InvalidOperationException(
            $"screen capture failed after retries: {last?.Message}. " +
            "If this is a sandbox full-desktop capture right after boot, retry, or pass a pid to capture just that window (more reliable).");
    }

    private static byte[] CaptureVirtualScreen()
    {
        var x = Native.GetSystemMetrics(Native.SM_XVIRTUALSCREEN);
        var y = Native.GetSystemMetrics(Native.SM_YVIRTUALSCREEN);
        var w = Native.GetSystemMetrics(Native.SM_CXVIRTUALSCREEN);
        var h = Native.GetSystemMetrics(Native.SM_CYVIRTUALSCREEN);
        if (w <= 0 || h <= 0)
        {
            w = Native.GetSystemMetrics(Native.SM_CXSCREEN);
            h = Native.GetSystemMetrics(Native.SM_CYSCREEN);
            x = y = 0;
        }
        return CaptureRect(x, y, w, h);
    }
}
