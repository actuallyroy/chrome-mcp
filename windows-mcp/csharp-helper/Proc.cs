// Process launcher with optional wait + output capture. Used by the `install`
// tool to run installers inside the sandbox and report their result, and
// available as a general escape hatch for running commands in the target.
//
// Note: when wait=true this blocks the calling (STA worker) thread until the
// process exits or the timeout fires. That serializes other dispatches behind
// it — intentional for "run this installer and tell me how it went", but keep
// timeouts sane so a stuck GUI installer doesn't wedge the helper forever.

using System.Diagnostics;
using System.Text;

namespace WindowsMcpHelper;

internal static class Proc
{
    public static Dictionary<string, object?> Run(string exe, string args, bool wait, int timeoutMs, string? cwd)
    {
        var psi = new ProcessStartInfo
        {
            FileName = exe,
            Arguments = args ?? "",
            UseShellExecute = false,
            CreateNoWindow = false,
            WorkingDirectory = string.IsNullOrEmpty(cwd) ? "" : cwd,
        };
        if (wait)
        {
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
        }

        Process proc;
        try
        {
            proc = Process.Start(psi) ?? throw new InvalidOperationException($"Process.Start returned null for {exe}");
        }
        catch (Exception ex)
        {
            throw new InvalidOperationException($"could not start '{exe}': {ex.Message}");
        }

        if (!wait)
        {
            return new Dictionary<string, object?>
            {
                ["pid"] = proc.Id,
                ["waited"] = false,
            };
        }

        var outBuf = new StringBuilder();
        var errBuf = new StringBuilder();
        proc.OutputDataReceived += (_, e) => { if (e.Data != null) outBuf.AppendLine(e.Data); };
        proc.ErrorDataReceived += (_, e) => { if (e.Data != null) errBuf.AppendLine(e.Data); };
        proc.BeginOutputReadLine();
        proc.BeginErrorReadLine();

        if (!proc.WaitForExit(timeoutMs))
        {
            try { proc.Kill(entireProcessTree: true); } catch { /* best effort */ }
            return new Dictionary<string, object?>
            {
                ["pid"] = proc.Id,
                ["timed_out"] = true,
                ["timeout_ms"] = timeoutMs,
                ["stdout"] = Trunc(outBuf.ToString()),
                ["stderr"] = Trunc(errBuf.ToString()),
            };
        }

        return new Dictionary<string, object?>
        {
            ["pid"] = proc.Id,
            ["exit_code"] = proc.ExitCode,
            ["waited"] = true,
            ["stdout"] = Trunc(outBuf.ToString()),
            ["stderr"] = Trunc(errBuf.ToString()),
        };
    }

    private static string Trunc(string s)
    {
        s = s.TrimEnd();
        return s.Length > 8000 ? s.Substring(0, 8000) + "…[truncated]" : s;
    }
}
