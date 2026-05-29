// Mouse + keyboard input via SendInput, plus UIA-pattern-based interactions
// that go through the app's own action handlers (more reliable than synthesized
// clicks for off-screen / collapsed elements).

using System.Windows.Automation;

namespace WindowsMcpHelper;

internal static class Input
{
    // ---- mouse --------------------------------------------------------------

    public static void MoveMouse(double x, double y)
    {
        Native.SetCursorPos((int)Math.Round(x), (int)Math.Round(y));
    }

    public static void ClickAt(double x, double y, string button, int count)
    {
        var ix = (int)Math.Round(x);
        var iy = (int)Math.Round(y);
        // SetCursorPos moves the OS cursor (so hit-testing on the button-down is
        // correct), but on its own it does NOT reliably deliver a WM_MOUSEMOVE to
        // the target window. Many UI toolkits (winit/wgpu, SDL, GLFW) derive a
        // click's location from the last cursor-move event, not from the button
        // event — so a button-down with no preceding move lands at the toolkit's
        // stale position and silently no-ops, while keyboard input still lands.
        // Inject an explicit absolute move first, then let the app process it, so
        // the click registers at the intended point.
        Native.SetCursorPos(ix, iy);
        SendAbsoluteMove(ix, iy);
        Thread.Sleep(16);
        uint down, up;
        if (string.Equals(button, "right", StringComparison.OrdinalIgnoreCase))
        {
            down = Native.MOUSEEVENTF_RIGHTDOWN;
            up = Native.MOUSEEVENTF_RIGHTUP;
        }
        else
        {
            down = Native.MOUSEEVENTF_LEFTDOWN;
            up = Native.MOUSEEVENTF_LEFTUP;
        }
        for (int i = 0; i < count; i++)
        {
            var inputs = new Native.INPUT[]
            {
                new() { type = Native.INPUT_MOUSE, U = new() { mi = new() { dwFlags = down } } },
                new() { type = Native.INPUT_MOUSE, U = new() { mi = new() { dwFlags = up } } },
            };
            Native.SendInput((uint)inputs.Length, inputs, System.Runtime.InteropServices.Marshal.SizeOf<Native.INPUT>());
            if (i + 1 < count) Thread.Sleep(20);
        }
    }

    // Deliver a real WM_MOUSEMOVE to whatever window is under (x,y) by injecting
    // an absolute move. MOUSEEVENTF_ABSOLUTE coordinates are normalized to
    // 0..65535 across the virtual desktop, so map physical screen pixels onto
    // that range (matching the virtual-screen metrics used by capture/OCR).
    private static void SendAbsoluteMove(int x, int y)
    {
        var vx = Native.GetSystemMetrics(Native.SM_XVIRTUALSCREEN);
        var vy = Native.GetSystemMetrics(Native.SM_YVIRTUALSCREEN);
        var vw = Native.GetSystemMetrics(Native.SM_CXVIRTUALSCREEN);
        var vh = Native.GetSystemMetrics(Native.SM_CYVIRTUALSCREEN);
        if (vw <= 1 || vh <= 1) return;
        var nx = (int)Math.Round((double)(x - vx) * 65535 / (vw - 1));
        var ny = (int)Math.Round((double)(y - vy) * 65535 / (vh - 1));
        var input = new Native.INPUT
        {
            type = Native.INPUT_MOUSE,
            U = new() { mi = new() { dx = nx, dy = ny, dwFlags = Native.MOUSEEVENTF_MOVE | Native.MOUSEEVENTF_ABSOLUTE | Native.MOUSEEVENTF_VIRTUALDESK } },
        };
        Native.SendInput(1, new[] { input }, System.Runtime.InteropServices.Marshal.SizeOf<Native.INPUT>());
    }

    public static void Scroll(int dx, int dy)
    {
        var inputs = new List<Native.INPUT>();
        if (dy != 0)
        {
            inputs.Add(new Native.INPUT
            {
                type = Native.INPUT_MOUSE,
                U = new() { mi = new() { dwFlags = Native.MOUSEEVENTF_WHEEL, mouseData = unchecked((uint)dy) } },
            });
        }
        if (dx != 0)
        {
            inputs.Add(new Native.INPUT
            {
                type = Native.INPUT_MOUSE,
                U = new() { mi = new() { dwFlags = Native.MOUSEEVENTF_HWHEEL, mouseData = unchecked((uint)dx) } },
            });
        }
        if (inputs.Count > 0)
        {
            Native.SendInput((uint)inputs.Count, inputs.ToArray(), System.Runtime.InteropServices.Marshal.SizeOf<Native.INPUT>());
        }
    }

    // ---- click / hover by UIA ref ------------------------------------------

    public static string ClickByRef(int refId, int count)
    {
        var el = UiaTree.RefStore.Resolve(refId)
            ?? throw new InvalidOperationException($"no element with ref={refId} — call outline again");

        // Multi-click (double / triple) is only meaningful for the mouse path.
        if (count <= 1)
        {
            if (TryInvokePattern(el)) return "invoke_pattern";
            if (TryTogglePattern(el)) return "toggle_pattern";
            if (TryExpandCollapsePattern(el)) return "expand_collapse_pattern";
            if (TrySelectionItemPattern(el)) return "selection_item_pattern";
        }
        // Mouse fallback: synthesize a click at the element's centre.
        try
        {
            var rect = el.Current.BoundingRectangle;
            if (double.IsNaN(rect.Width) || rect.Width <= 0)
                throw new InvalidOperationException("element has no BoundingRectangle and UIA patterns rejected the click");
            var cx = rect.Left + rect.Width / 2;
            var cy = rect.Top + rect.Height / 2;
            try { el.SetFocus(); } catch { /* not focusable */ }
            ClickAt(cx, cy, "left", Math.Max(1, count));
            return "sendinput";
        }
        catch (ElementNotAvailableException)
        {
            throw new InvalidOperationException("element disappeared — call outline again");
        }
    }

    private static bool TryInvokePattern(AutomationElement el)
    {
        try
        {
            if (el.TryGetCurrentPattern(InvokePattern.Pattern, out var p) && p is InvokePattern ip)
            {
                ip.Invoke();
                return true;
            }
        }
        catch { }
        return false;
    }

    private static bool TryTogglePattern(AutomationElement el)
    {
        try
        {
            if (el.TryGetCurrentPattern(TogglePattern.Pattern, out var p) && p is TogglePattern tp)
            {
                tp.Toggle();
                return true;
            }
        }
        catch { }
        return false;
    }

    private static bool TryExpandCollapsePattern(AutomationElement el)
    {
        try
        {
            if (el.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out var p) && p is ExpandCollapsePattern ec)
            {
                var state = ec.Current.ExpandCollapseState;
                if (state == ExpandCollapseState.Collapsed) ec.Expand();
                else if (state == ExpandCollapseState.Expanded) ec.Collapse();
                else ec.Expand();
                return true;
            }
        }
        catch { }
        return false;
    }

    private static bool TrySelectionItemPattern(AutomationElement el)
    {
        try
        {
            if (el.TryGetCurrentPattern(SelectionItemPattern.Pattern, out var p) && p is SelectionItemPattern sp)
            {
                sp.Select();
                return true;
            }
        }
        catch { }
        return false;
    }

    public static bool HoverByRef(int refId, out string? err)
    {
        err = null;
        var el = UiaTree.RefStore.Resolve(refId);
        if (el == null) { err = $"no element with ref={refId} — call outline again"; return false; }
        try
        {
            var rect = el.Current.BoundingRectangle;
            if (double.IsNaN(rect.Width) || rect.Width <= 0)
            {
                err = "element has no BoundingRectangle (off-screen?)";
                return false;
            }
            MoveMouse(rect.Left + rect.Width / 2, rect.Top + rect.Height / 2);
            return true;
        }
        catch (ElementNotAvailableException) { err = "element disappeared — call outline again"; return false; }
    }

    // ---- fill ---------------------------------------------------------------

    public static string FillByRef(int refId, string value)
    {
        var el = UiaTree.RefStore.Resolve(refId)
            ?? throw new InvalidOperationException($"no element with ref={refId} — call outline again");
        try { el.SetFocus(); } catch { }

        // 1) ValuePattern.SetValue.
        try
        {
            if (el.TryGetCurrentPattern(ValuePattern.Pattern, out var p) && p is ValuePattern vp && !vp.Current.IsReadOnly)
            {
                vp.SetValue(value);
                return "value_pattern";
            }
        }
        catch { /* fallthrough */ }

        // 2) Focus + Ctrl+A + Delete + type.
        try
        {
            var rect = el.Current.BoundingRectangle;
            if (!double.IsNaN(rect.Width) && rect.Width > 0)
            {
                ClickAt(rect.Left + rect.Width / 2, rect.Top + rect.Height / 2, "left", 1);
                Thread.Sleep(40);
            }
        }
        catch { }
        // Select-all + delete to clear, then type the new value.
        PressKey("A", new List<string> { "ctrl" });
        PressKey("DELETE", new List<string>());
        TypeString(value);
        return "type";
    }

    // ---- typing -------------------------------------------------------------

    // Returns the number of input events the OS actually injected. 0 means the
    // injection was blocked (no focused window, or UIPI denied us) — callers
    // surface this so a silent no-op is visible.
    public static uint TypeString(string s)
    {
        if (string.IsNullOrEmpty(s)) return 0;
        // For Unicode chars we send KEYEVENTF_UNICODE: wVk=0, wScan=codepoint.
        // This delivers WM_CHAR directly, which is the text-input path winit /
        // SDL / GLFW / most editors read.
        var inputs = new List<Native.INPUT>(s.Length * 2);
        foreach (var ch in s)
        {
            ushort scan = ch;
            inputs.Add(new Native.INPUT
            {
                type = Native.INPUT_KEYBOARD,
                U = new() { ki = new() { wVk = 0, wScan = scan, dwFlags = Native.KEYEVENTF_UNICODE } },
            });
            inputs.Add(new Native.INPUT
            {
                type = Native.INPUT_KEYBOARD,
                U = new() { ki = new() { wVk = 0, wScan = scan, dwFlags = Native.KEYEVENTF_UNICODE | Native.KEYEVENTF_KEYUP } },
            });
        }
        // SendInput is limited per-call to ~5000 events; split for safety.
        uint sent = 0;
        const int chunk = 200;
        for (int i = 0; i < inputs.Count; i += chunk)
        {
            var slice = inputs.GetRange(i, Math.Min(chunk, inputs.Count - i)).ToArray();
            sent += Native.SendInput((uint)slice.Length, slice, System.Runtime.InteropServices.Marshal.SizeOf<Native.INPUT>());
        }
        return sent;
    }

    // ---- press_key ----------------------------------------------------------

    // Virtual-key codes for named keys. Names match the chrome/android/macos API
    // surface; values are Win32 VK_*.
    public static readonly Dictionary<string, ushort> KEYCODES = new(StringComparer.OrdinalIgnoreCase)
    {
        // letters
        ["A"] = 0x41, ["B"] = 0x42, ["C"] = 0x43, ["D"] = 0x44, ["E"] = 0x45, ["F"] = 0x46,
        ["G"] = 0x47, ["H"] = 0x48, ["I"] = 0x49, ["J"] = 0x4A, ["K"] = 0x4B, ["L"] = 0x4C,
        ["M"] = 0x4D, ["N"] = 0x4E, ["O"] = 0x4F, ["P"] = 0x50, ["Q"] = 0x51, ["R"] = 0x52,
        ["S"] = 0x53, ["T"] = 0x54, ["U"] = 0x55, ["V"] = 0x56, ["W"] = 0x57, ["X"] = 0x58,
        ["Y"] = 0x59, ["Z"] = 0x5A,
        // digits
        ["0"] = 0x30, ["1"] = 0x31, ["2"] = 0x32, ["3"] = 0x33, ["4"] = 0x34,
        ["5"] = 0x35, ["6"] = 0x36, ["7"] = 0x37, ["8"] = 0x38, ["9"] = 0x39,
        // punctuation / OEM
        ["GRAVE"] = 0xC0, ["MINUS"] = 0xBD, ["EQUAL"] = 0xBB,
        ["LEFT_BRACKET"] = 0xDB, ["RIGHT_BRACKET"] = 0xDD, ["BACKSLASH"] = 0xDC,
        ["SEMICOLON"] = 0xBA, ["QUOTE"] = 0xDE,
        ["COMMA"] = 0xBC, ["PERIOD"] = 0xBE, ["SLASH"] = 0xBF,
        // editing keys
        ["RETURN"] = 0x0D, ["ENTER"] = 0x0D,
        ["TAB"] = 0x09, ["SPACE"] = 0x20,
        ["BACKSPACE"] = 0x08, ["DELETE"] = 0x2E, ["FORWARD_DELETE"] = 0x2E,
        ["ESCAPE"] = 0x1B, ["ESC"] = 0x1B,
        ["INSERT"] = 0x2D,
        // navigation
        ["LEFT"] = 0x25, ["UP"] = 0x26, ["RIGHT"] = 0x27, ["DOWN"] = 0x28,
        ["HOME"] = 0x24, ["END"] = 0x23,
        ["PAGEUP"] = 0x21, ["PAGEDOWN"] = 0x22,
        // function keys (F1-F24)
        ["F1"] = 0x70, ["F2"] = 0x71, ["F3"] = 0x72, ["F4"] = 0x73,
        ["F5"] = 0x74, ["F6"] = 0x75, ["F7"] = 0x76, ["F8"] = 0x77,
        ["F9"] = 0x78, ["F10"] = 0x79, ["F11"] = 0x7A, ["F12"] = 0x7B,
        ["F13"] = 0x7C, ["F14"] = 0x7D, ["F15"] = 0x7E, ["F16"] = 0x7F,
        ["F17"] = 0x80, ["F18"] = 0x81, ["F19"] = 0x82, ["F20"] = 0x83,
        ["F21"] = 0x84, ["F22"] = 0x85, ["F23"] = 0x86, ["F24"] = 0x87,
        // numpad
        ["NUMPAD0"] = 0x60, ["NUMPAD1"] = 0x61, ["NUMPAD2"] = 0x62, ["NUMPAD3"] = 0x63,
        ["NUMPAD4"] = 0x64, ["NUMPAD5"] = 0x65, ["NUMPAD6"] = 0x66, ["NUMPAD7"] = 0x67,
        ["NUMPAD8"] = 0x68, ["NUMPAD9"] = 0x69,
        ["NUMPAD_ADD"] = 0x6B, ["NUMPAD_SUBTRACT"] = 0x6D,
        ["NUMPAD_MULTIPLY"] = 0x6A, ["NUMPAD_DIVIDE"] = 0x6F,
        ["NUMPAD_DECIMAL"] = 0x6E,
        // locks / system
        ["CAPS_LOCK"] = 0x14, ["NUM_LOCK"] = 0x90, ["SCROLL_LOCK"] = 0x91,
        ["PRINT_SCREEN"] = 0x2C, ["PAUSE"] = 0x13,
        ["APPS"] = 0x5D, // Context-menu key.
    };

    private static readonly Dictionary<string, ushort> MODIFIERS = new(StringComparer.OrdinalIgnoreCase)
    {
        ["ctrl"] = 0x11, ["control"] = 0x11,
        ["shift"] = 0x10,
        ["alt"] = 0x12, ["menu"] = 0x12, ["option"] = 0x12, ["opt"] = 0x12,
        ["win"] = 0x5B, ["super"] = 0x5B, ["meta"] = 0x5B, ["cmd"] = 0x5B, ["command"] = 0x5B,
    };

    // Keys that need KEYEVENTF_EXTENDEDKEY for correct behavior with some apps.
    private static readonly HashSet<ushort> EXTENDED_KEYS = new()
    {
        0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, // PgUp, PgDn, End, Home, arrows
        0x2D, 0x2E,                                    // Insert, Delete
        0x5B, 0x5C,                                    // Left/Right Win
        0x6F,                                          // Numpad Divide
        0x90,                                          // Num Lock
    };

    public static IEnumerable<string> KnownKeys() => KEYCODES.Keys.OrderBy(s => s);

    // Returns -1 if the key name is unknown; otherwise the number of input
    // events the OS injected (0 = blocked: no focus / UIPI).
    public static int PressKey(string name, List<string> modifiers)
    {
        if (!KEYCODES.TryGetValue(name.ToUpperInvariant(), out var vk)) return -1;

        var modVks = new List<ushort>();
        foreach (var m in modifiers)
        {
            if (MODIFIERS.TryGetValue(m, out var mv)) modVks.Add(mv);
        }

        var inputs = new List<Native.INPUT>();
        // Press modifiers down (in order).
        foreach (var mv in modVks)
            inputs.Add(KeyDown(mv));
        // Press main key.
        inputs.Add(KeyDown(vk));
        inputs.Add(KeyUp(vk));
        // Release modifiers in reverse order.
        for (int i = modVks.Count - 1; i >= 0; i--)
            inputs.Add(KeyUp(modVks[i]));

        var sent = Native.SendInput((uint)inputs.Count, inputs.ToArray(), System.Runtime.InteropServices.Marshal.SizeOf<Native.INPUT>());
        return (int)sent;
    }

    // Scan code matters: TranslateMessage / ToUnicode derive the WM_CHAR (and
    // winit/SDL/GLFW's text-input event) from the scan code. Without it, named
    // keys still navigate (read off WM_KEYDOWN) but printable letters produce
    // no character. So always populate wScan = VK→VSC.
    private static Native.INPUT KeyDown(ushort vk)
    {
        ushort scan = (ushort)Native.MapVirtualKey(vk, 0 /* MAPVK_VK_TO_VSC */);
        uint flags = 0;
        if (EXTENDED_KEYS.Contains(vk)) flags |= Native.KEYEVENTF_EXTENDEDKEY;
        return new Native.INPUT
        {
            type = Native.INPUT_KEYBOARD,
            U = new() { ki = new() { wVk = vk, wScan = scan, dwFlags = flags } },
        };
    }

    private static Native.INPUT KeyUp(ushort vk)
    {
        ushort scan = (ushort)Native.MapVirtualKey(vk, 0 /* MAPVK_VK_TO_VSC */);
        uint flags = Native.KEYEVENTF_KEYUP;
        if (EXTENDED_KEYS.Contains(vk)) flags |= Native.KEYEVENTF_EXTENDEDKEY;
        return new Native.INPUT
        {
            type = Native.INPUT_KEYBOARD,
            U = new() { ki = new() { wVk = vk, wScan = scan, dwFlags = flags } },
        };
    }
}
