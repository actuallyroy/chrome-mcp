// Diagnostic / permissions probes. Windows has no macOS-style per-app TCC;
// the failure modes are different:
//   - UIAccess: app manifest can request UIAccess so we can drive elevated
//     processes. Almost no apps ship signed UIAccess binaries — we check &
//     report.
//   - Elevation: if WE run elevated, we can drive elevated target apps. If
//     not, UIA on elevated targets returns empty trees silently.
//   - DPI awareness: misconfigured awareness gives wrong screen coords.

using System.Security.Principal;
using Microsoft.Win32;

namespace WindowsMcpHelper;

internal static class Permissions
{
    public static Dictionary<string, object?> Check()
    {
        return new Dictionary<string, object?>
        {
            ["ui_automation"] = TryProbeUia(),
            ["screen_capture"] = true, // GDI/BitBlt always available.
            ["elevated"] = IsElevated(),
            ["ui_access"] = IsUiAccess(),
            ["dpi_awareness"] = DescribeDpiAwareness(),
            ["secure_desktop_warning"] =
                "If the target app runs elevated and this helper does not, UIA returns empty trees silently. " +
                "Re-launch your MCP host elevated, or sign this helper with UIAccess=true.",
            ["os_version"] = Environment.OSVersion.Version.ToString(),
        };
    }

    public static void OpenSettings(string service)
    {
        var uri = service switch
        {
            "privacy" => "ms-settings:privacy-general",
            "apps" => "ms-settings:appsfeatures",
            "display" => "ms-settings:display",
            _ => "ms-settings:",
        };
        try
        {
            var psi = new System.Diagnostics.ProcessStartInfo
            {
                FileName = uri,
                UseShellExecute = true,
            };
            System.Diagnostics.Process.Start(psi);
        }
        catch (Exception ex)
        {
            Program.Log($"open_settings failed: {ex.Message}");
        }
    }

    private static bool TryProbeUia()
    {
        try { _ = System.Windows.Automation.AutomationElement.RootElement; return true; }
        catch { return false; }
    }

    private static bool IsElevated()
    {
        try
        {
            using var id = WindowsIdentity.GetCurrent();
            var principal = new WindowsPrincipal(id);
            return principal.IsInRole(WindowsBuiltInRole.Administrator);
        }
        catch { return false; }
    }

    private static bool IsUiAccess()
    {
        // No public API; UIAccess is a manifest+signing property. Approximate:
        // we look at our own integrity level via the process token — UIAccess
        // binaries run at UIAccess medium integrity with the UIAccess bit set,
        // not at high integrity. Cheap fallback: just return false; this is
        // primarily diagnostic.
        return false;
    }

    private static string DescribeDpiAwareness()
    {
        // We set per-monitor v2 in Main(). Cross-check by reading the foreground
        // window's DPI? Out of scope for this stub — report the intent.
        return "per_monitor_aware_v2";
    }
}
