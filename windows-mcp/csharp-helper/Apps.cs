// Application enumeration + activation + launch.
//
// macos-mcp uses NSWorkspace.runningApplications which returns one row per app.
// On Windows the same shape doesn't exist — a "running app" is just a process
// with one or more top-level windows. We enumerate top-level windows and
// dedupe by pid, keyed on the first visible window we encounter.

using System.Diagnostics;
using System.IO;
using System.Text;

namespace WindowsMcpHelper;

internal sealed class AppInfo
{
    public int Pid { get; init; }
    public string? ExePath { get; init; }   // serialized as bundle_id for chrome-mcp shape symmetry
    public string Name { get; init; } = "";
    public bool Active { get; init; }
    public bool Hidden { get; init; }       // minimized / no visible top-level window
    public IntPtr WindowHandle { get; init; }
}

internal static class Apps
{
    public static List<Dictionary<string, object?>> List()
    {
        var foreground = Native.GetForegroundWindow();
        var byPid = new Dictionary<int, AppInfo>();

        Native.EnumWindows((hWnd, _) =>
        {
            if (!Native.IsWindowVisible(hWnd)) return true;
            var len = Native.GetWindowTextLength(hWnd);
            if (len <= 0) return true;
            var sb = new StringBuilder(len + 1);
            Native.GetWindowText(hWnd, sb, sb.Capacity);
            var title = sb.ToString();
            if (string.IsNullOrWhiteSpace(title)) return true;

            Native.GetWindowThreadProcessId(hWnd, out var pidU);
            var pid = (int)pidU;
            if (byPid.ContainsKey(pid)) return true;

            string? exe = null;
            try { exe = Process.GetProcessById(pid).MainModule?.FileName; } catch { /* access denied (elevated proc), system, etc. */ }

            byPid[pid] = new AppInfo
            {
                Pid = pid,
                ExePath = exe,
                Name = title,
                Active = hWnd == foreground,
                Hidden = Native.IsIconic(hWnd),
                WindowHandle = hWnd,
            };
            return true;
        }, IntPtr.Zero);

        var rows = new List<Dictionary<string, object?>>();
        foreach (var a in byPid.Values.OrderBy(a => a.Name, StringComparer.OrdinalIgnoreCase))
        {
            rows.Add(new Dictionary<string, object?>
            {
                ["pid"] = a.Pid,
                ["exe_path"] = a.ExePath,
                ["bundle_id"] = a.ExePath, // legacy alias for chrome-mcp shape symmetry
                ["name"] = a.Name,
                ["active"] = a.Active,
                ["hidden"] = a.Hidden,
            });
        }
        return rows;
    }

    public static AppInfo? Find(int? pid, string? exePath, string? name)
    {
        var all = ListInfos();
        if (pid.HasValue)
        {
            var hit = all.FirstOrDefault(a => a.Pid == pid.Value);
            if (hit != null) return hit;
            // Even if the process has no visible window, allow focusing by pid —
            // we'll synthesize a minimal AppInfo so the caller's activePid is set.
            try
            {
                var proc = Process.GetProcessById(pid.Value);
                return new AppInfo
                {
                    Pid = pid.Value,
                    ExePath = SafeMainModule(proc),
                    Name = proc.ProcessName,
                    Active = false,
                    Hidden = true,
                    WindowHandle = proc.MainWindowHandle,
                };
            }
            catch { return null; }
        }
        if (!string.IsNullOrEmpty(exePath))
        {
            var hit = all.FirstOrDefault(a =>
                !string.IsNullOrEmpty(a.ExePath)
                && a.ExePath.Equals(exePath, StringComparison.OrdinalIgnoreCase));
            if (hit != null) return hit;
            // Match by filename if the user passed just the leaf.
            var leaf = Path.GetFileName(exePath);
            hit = all.FirstOrDefault(a =>
                !string.IsNullOrEmpty(a.ExePath)
                && Path.GetFileName(a.ExePath!).Equals(leaf, StringComparison.OrdinalIgnoreCase));
            if (hit != null) return hit;
        }
        if (!string.IsNullOrEmpty(name))
        {
            var hit = all.FirstOrDefault(a => a.Name.IndexOf(name, StringComparison.OrdinalIgnoreCase) >= 0);
            if (hit != null) return hit;
        }
        return null;
    }

    private static List<AppInfo> ListInfos()
    {
        var foreground = Native.GetForegroundWindow();
        var byPid = new Dictionary<int, AppInfo>();
        Native.EnumWindows((hWnd, _) =>
        {
            if (!Native.IsWindowVisible(hWnd)) return true;
            var len = Native.GetWindowTextLength(hWnd);
            if (len <= 0) return true;
            var sb = new StringBuilder(len + 1);
            Native.GetWindowText(hWnd, sb, sb.Capacity);
            var title = sb.ToString();
            if (string.IsNullOrWhiteSpace(title)) return true;
            Native.GetWindowThreadProcessId(hWnd, out var pidU);
            var pid = (int)pidU;
            if (byPid.ContainsKey(pid)) return true;
            string? exe = null;
            try { exe = Process.GetProcessById(pid).MainModule?.FileName; } catch { }
            byPid[pid] = new AppInfo
            {
                Pid = pid,
                ExePath = exe,
                Name = title,
                Active = hWnd == foreground,
                Hidden = Native.IsIconic(hWnd),
                WindowHandle = hWnd,
            };
            return true;
        }, IntPtr.Zero);
        return byPid.Values.ToList();
    }

    private static string? SafeMainModule(Process p)
    {
        try { return p.MainModule?.FileName; } catch { return null; }
    }

    public static bool Activate(AppInfo a)
    {
        var hWnd = a.WindowHandle;
        if (hWnd == IntPtr.Zero)
        {
            try { hWnd = Process.GetProcessById(a.Pid).MainWindowHandle; } catch { }
        }
        if (hWnd == IntPtr.Zero) return false;
        if (Native.IsIconic(hWnd)) Native.ShowWindow(hWnd, Native.SW_RESTORE);
        // Win10/11 silently ignores SetForegroundWindow when the calling thread
        // isn't the foreground thread. AttachThreadInput trick is the standard
        // workaround: temporarily make our thread look like the foreground
        // thread for SetForegroundWindow's locking check.
        var fg = Native.GetForegroundWindow();
        var fgThread = Native.GetWindowThreadProcessId(fg, out _);
        var ourThread = Native.GetCurrentThreadId();
        if (fgThread != ourThread)
        {
            Native.AttachThreadInput(ourThread, fgThread, true);
            try
            {
                Native.BringWindowToTop(hWnd);
                Native.SetForegroundWindow(hWnd);
            }
            finally { Native.AttachThreadInput(ourThread, fgThread, false); }
        }
        else
        {
            Native.SetForegroundWindow(hWnd);
        }
        Thread.Sleep(80);
        return Native.GetForegroundWindow() == hWnd;
    }

    public static AppInfo? Launch(string? exePath, string? appid, string? name, string? args)
    {
        // 1. AppUserModelID (UWP / packaged): use "shell:AppsFolder\<aumid>".
        if (!string.IsNullOrEmpty(appid))
        {
            try
            {
                var psi = new ProcessStartInfo
                {
                    FileName = "explorer.exe",
                    Arguments = $"shell:AppsFolder\\{appid}",
                    UseShellExecute = false,
                };
                Process.Start(psi);
                return WaitForFirstWindowByName(name ?? appid, 8000);
            }
            catch (Exception ex) { Program.Log($"launch appid failed: {ex.Message}"); }
        }
        // 2. Direct exe path.
        if (!string.IsNullOrEmpty(exePath))
        {
            try
            {
                var psi = new ProcessStartInfo
                {
                    FileName = exePath,
                    Arguments = args ?? "",
                    UseShellExecute = true,
                };
                var proc = Process.Start(psi);
                if (proc != null)
                {
                    // Best-effort settle. WaitForInputIdle throws for processes
                    // without a message loop yet (winit/wgpu apps create their
                    // window a beat later, after adapter/device init) — that is
                    // NOT a launch failure, so swallow it and still return the
                    // pid. Gating success on this caused false "could not launch
                    // app" for GPU apps that had actually started fine.
                    try { proc.WaitForInputIdle(2000); } catch { /* no UI yet — fine */ }
                    string? title = null;
                    try { proc.Refresh(); title = SafeMainWindowTitle(proc); } catch { }
                    return new AppInfo
                    {
                        Pid = proc.Id,
                        ExePath = SafeMainModule(proc),
                        Name = !string.IsNullOrEmpty(title) ? title : proc.ProcessName,
                        Active = true,
                        WindowHandle = TryMainWindowHandle(proc),
                    };
                }
            }
            catch (Exception ex) { Program.Log($"launch exe failed: {ex.Message}"); }
        }
        // 3. Start Menu shortcut lookup by name — fall back to `start "" "<name>"`.
        if (!string.IsNullOrEmpty(name))
        {
            try
            {
                var psi = new ProcessStartInfo
                {
                    FileName = "cmd.exe",
                    Arguments = $"/c start \"\" \"{name}\"",
                    UseShellExecute = false,
                    CreateNoWindow = true,
                };
                Process.Start(psi);
                return WaitForFirstWindowByName(name, 8000);
            }
            catch (Exception ex) { Program.Log($"launch shortcut failed: {ex.Message}"); }
        }
        return null;
    }

    private static AppInfo? WaitForFirstWindowByName(string nameFragment, int timeoutMs)
    {
        var deadline = Environment.TickCount + timeoutMs;
        while (Environment.TickCount < deadline)
        {
            var info = Find(null, null, nameFragment);
            if (info != null) return info;
            Thread.Sleep(150);
        }
        return Find(null, null, nameFragment);
    }

    private static string? SafeMainWindowTitle(Process p)
    {
        try { return p.MainWindowTitle; } catch { return null; }
    }

    private static IntPtr TryMainWindowHandle(Process p)
    {
        try { return p.MainWindowHandle; } catch { return IntPtr.Zero; }
    }
}
