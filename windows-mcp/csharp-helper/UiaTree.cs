// UI Automation tree walker. Mirrors macos-mcp's AxTree.swift:
//   - outline: returns a UiaNode tree with stable integer refs
//   - describe: dumps all UIA properties + supported patterns for one ref
//
// We hold one global ref-store. It's reset at the start of every outline call
// so ref ids are predictable and don't accumulate unbounded.

using System.Collections.Concurrent;
using System.Windows.Automation;
using System.Windows.Automation.Text;

namespace WindowsMcpHelper;

internal sealed class UiaNode
{
    public int Ref { get; init; }
    public string Role { get; init; } = "Unknown";
    public string? RoleDescription { get; init; }
    public string? Title { get; init; }
    public string? Value { get; init; }
    public string? Label { get; init; }
    public string? Identifier { get; init; }
    public bool Enabled { get; init; }
    public double[]? Position { get; init; }
    public double[]? Size { get; init; }
    public List<UiaNode> Children { get; } = new();

    public Dictionary<string, object?> ToDict()
    {
        return new Dictionary<string, object?>
        {
            ["ref"] = Ref,
            ["role"] = Role,
            ["role_description"] = RoleDescription,
            ["title"] = Title,
            ["value"] = Value,
            ["label"] = Label,
            ["identifier"] = Identifier,
            ["enabled"] = Enabled,
            ["position"] = Position,
            ["size"] = Size,
            ["children"] = Children.Select(c => c.ToDict()).ToList(),
        };
    }
}

internal static class UiaTree
{
    internal static class RefStore
    {
        private static readonly ConcurrentDictionary<int, AutomationElement> _byRef = new();
        private static int _next = 1;

        public static int Assign(AutomationElement el)
        {
            var id = Interlocked.Increment(ref _next) - 1;
            _byRef[id] = el;
            return id;
        }

        public static AutomationElement? Resolve(int refId)
        {
            return _byRef.TryGetValue(refId, out var el) ? el : null;
        }

        public static void Reset()
        {
            _byRef.Clear();
            Interlocked.Exchange(ref _next, 1);
        }
    }

    // outline(pid) → synthetic Application root wrapping all windows of that pid.
    // matches macos-mcp's shape (Ax.appElement(pid) wraps the AppKit application
    // and exposes its windows as children).
    //
    // Why HWND-based enumeration rather than UIA's ProcessIdProperty filter:
    // UWP / packaged apps (Calculator, Settings, Photos, …) report a third
    // PID via UIA — the app-container PID — which matches neither the
    // package's app exe nor the ApplicationFrameHost host process. So
    // FindAll(ProcessIdProperty = visible-pid) returns nothing for any UWP.
    // EnumWindows + GetWindowThreadProcessId gives us the pid that owns each
    // visible HWND, which is what list_apps already reports — so the user's
    // mental model "pid I saw in list_apps = pid I outline" holds.
    public static Dictionary<string, object?> Outline(int pid, int maxDepth, int maxNodes)
    {
        var nodeCount = 0;

        // Collect all visible top-level HWNDs owned by `pid`.
        var hwnds = new List<IntPtr>();
        Native.EnumWindows((hWnd, _) =>
        {
            if (!Native.IsWindowVisible(hWnd)) return true;
            Native.GetWindowThreadProcessId(hWnd, out var wpid);
            if ((int)wpid == pid) hwnds.Add(hWnd);
            return true;
        }, IntPtr.Zero);

        // Build a synthetic root with the pid wired through.
        var rootRef = RefStore.Assign(AutomationElement.RootElement);
        var children = new List<UiaNode>();
        foreach (var hwnd in hwnds)
        {
            if (nodeCount >= maxNodes) break;
            AutomationElement? w = null;
            try { w = AutomationElement.FromHandle(hwnd); }
            catch { /* ElementNotAvailableException etc. — skip */ }
            if (w == null) continue;
            children.Add(Walk(w, 0, maxDepth, maxNodes, ref nodeCount));
        }
        var root = new UiaNode
        {
            Ref = rootRef,
            Role = "Application",
            Title = $"pid={pid}",
            Enabled = true,
        };
        root.Children.AddRange(children);
        return root.ToDict();
    }

    private static UiaNode Walk(AutomationElement el, int depth, int maxDepth, int maxNodes, ref int nodeCount)
    {
        nodeCount++;
        var role = ControlTypeName(el);
        string? title = TrySafe(() => GetCachedOrLive(el, AutomationElement.NameProperty) as string);
        string? autoId = TrySafe(() => GetCachedOrLive(el, AutomationElement.AutomationIdProperty) as string);
        string? help = TrySafe(() => GetCachedOrLive(el, AutomationElement.HelpTextProperty) as string);
        string? localized = TrySafe(() => GetCachedOrLive(el, AutomationElement.LocalizedControlTypeProperty) as string);
        bool enabled = TrySafe(() => GetCachedOrLive(el, AutomationElement.IsEnabledProperty) is bool b && b);
        string? value = ExtractValue(el);

        double[]? pos = null, size = null;
        try
        {
            var rect = el.Current.BoundingRectangle;
            if (!double.IsNaN(rect.Width) && !double.IsInfinity(rect.Width) && rect.Width > 0)
            {
                pos = new[] { rect.Left, rect.Top };
                size = new[] { rect.Width, rect.Height };
            }
        }
        catch { /* element gone / off-screen */ }

        var refId = RefStore.Assign(el);
        var node = new UiaNode
        {
            Ref = refId,
            Role = role,
            RoleDescription = localized,
            Title = NullIfEmpty(title),
            Value = NullIfEmpty(value),
            Label = NullIfEmpty(help),
            Identifier = NullIfEmpty(autoId),
            Enabled = enabled,
            Position = pos,
            Size = size,
        };

        if (depth >= maxDepth || nodeCount >= maxNodes) return node;

        // Walk children with ControlViewWalker — excludes raw structural noise
        // (anonymous containers etc).
        var walker = TreeWalker.ControlViewWalker;
        try
        {
            var child = walker.GetFirstChild(el);
            while (child != null && nodeCount < maxNodes)
            {
                node.Children.Add(Walk(child, depth + 1, maxDepth, maxNodes, ref nodeCount));
                try { child = walker.GetNextSibling(child); }
                catch { break; }
            }
        }
        catch { /* element became unavailable mid-walk */ }

        return node;
    }

    public static Dictionary<string, object?> Describe(int refId)
    {
        var el = RefStore.Resolve(refId)
            ?? throw new InvalidOperationException($"no element with ref={refId} — call outline again");

        var dict = new Dictionary<string, object?>
        {
            ["ref"] = refId,
        };

        // Pull a representative set of properties. AutomationElement.GetSupportedProperties()
        // can return 50+ entries — we cherry-pick the useful ones plus current
        // values for any registered property. ProgrammaticName is the canonical name.
        var props = new (AutomationProperty Prop, string Key)[]
        {
            (AutomationElement.NameProperty, "Name"),
            (AutomationElement.AutomationIdProperty, "AutomationId"),
            (AutomationElement.ClassNameProperty, "ClassName"),
            (AutomationElement.ControlTypeProperty, "ControlType"),
            (AutomationElement.LocalizedControlTypeProperty, "LocalizedControlType"),
            (AutomationElement.HelpTextProperty, "HelpText"),
            (AutomationElement.AcceleratorKeyProperty, "AcceleratorKey"),
            (AutomationElement.AccessKeyProperty, "AccessKey"),
            (AutomationElement.IsEnabledProperty, "IsEnabled"),
            (AutomationElement.IsKeyboardFocusableProperty, "IsKeyboardFocusable"),
            (AutomationElement.HasKeyboardFocusProperty, "HasKeyboardFocus"),
            (AutomationElement.IsOffscreenProperty, "IsOffscreen"),
            (AutomationElement.IsContentElementProperty, "IsContentElement"),
            (AutomationElement.IsControlElementProperty, "IsControlElement"),
            (AutomationElement.IsPasswordProperty, "IsPassword"),
            (AutomationElement.FrameworkIdProperty, "FrameworkId"),
            (AutomationElement.ProcessIdProperty, "ProcessId"),
            (AutomationElement.RuntimeIdProperty, "RuntimeId"),
        };
        foreach (var (prop, key) in props)
        {
            try
            {
                var raw = el.GetCurrentPropertyValue(prop, true);
                if (raw == AutomationElement.NotSupported) continue;
                dict[key] = NormalizePropertyValue(raw);
            }
            catch { /* not supported on this element */ }
        }

        // BoundingRectangle as a friendly object.
        try
        {
            var rect = el.Current.BoundingRectangle;
            if (!double.IsNaN(rect.Width))
            {
                dict["BoundingRectangle"] = new Dictionary<string, object?>
                {
                    ["x"] = rect.Left, ["y"] = rect.Top,
                    ["width"] = rect.Width, ["height"] = rect.Height,
                };
            }
        }
        catch { }

        // Value (ValuePattern / RangeValuePattern).
        var v = ExtractValue(el);
        if (v != null) dict["Value"] = v;

        // Supported patterns.
        var patterns = new List<string>();
        try
        {
            foreach (var pat in el.GetSupportedPatterns()) patterns.Add(pat.ProgrammaticName);
        }
        catch { }
        dict["patterns"] = patterns;

        // "Actions" — invokable verbs derived from supported patterns. Mirrors
        // the AX `actions` array on the macOS side so the LLM has a unified
        // mental model.
        var actions = new List<string>();
        if (patterns.Any(p => p.Contains("InvokePattern"))) actions.Add("Invoke");
        if (patterns.Any(p => p.Contains("TogglePattern"))) actions.Add("Toggle");
        if (patterns.Any(p => p.Contains("ExpandCollapsePattern"))) actions.Add("Expand", "Collapse");
        if (patterns.Any(p => p.Contains("SelectionItemPattern"))) actions.Add("Select");
        if (patterns.Any(p => p.Contains("ValuePattern"))) actions.Add("SetValue");
        if (patterns.Any(p => p.Contains("ScrollItemPattern"))) actions.Add("ScrollIntoView");
        dict["actions"] = actions;

        return dict;
    }

    // ---- helpers -----------------------------------------------------------

    private static string ControlTypeName(AutomationElement el)
    {
        try
        {
            var ct = el.Current.ControlType;
            // ProgrammaticName looks like "ControlType.Button" — strip the prefix.
            var name = ct.ProgrammaticName ?? "";
            const string prefix = "ControlType.";
            return name.StartsWith(prefix, StringComparison.Ordinal) ? name[prefix.Length..] : name;
        }
        catch { return "Unknown"; }
    }

    private static object? GetCachedOrLive(AutomationElement el, AutomationProperty prop)
    {
        var raw = el.GetCurrentPropertyValue(prop, true);
        return raw == AutomationElement.NotSupported ? null : raw;
    }

    private static string? ExtractValue(AutomationElement el)
    {
        try
        {
            if (el.TryGetCurrentPattern(ValuePattern.Pattern, out var p) && p is ValuePattern vp)
                return vp.Current.Value;
        }
        catch { }
        try
        {
            if (el.TryGetCurrentPattern(RangeValuePattern.Pattern, out var p) && p is RangeValuePattern rp)
                return rp.Current.Value.ToString("G");
        }
        catch { }
        try
        {
            if (el.TryGetCurrentPattern(TogglePattern.Pattern, out var p) && p is TogglePattern tp)
                return tp.Current.ToggleState.ToString();
        }
        catch { }
        try
        {
            if (el.TryGetCurrentPattern(SelectionItemPattern.Pattern, out var p) && p is SelectionItemPattern sip)
                return sip.Current.IsSelected ? "selected" : null;
        }
        catch { }
        return null;
    }

    private static object? NormalizePropertyValue(object? raw)
    {
        if (raw == null) return null;
        if (raw is ControlType ct) return ct.ProgrammaticName;
        if (raw is int[] arr) return arr;
        if (raw is System.Windows.Rect r)
        {
            return new Dictionary<string, object?>
            {
                ["x"] = r.Left, ["y"] = r.Top, ["width"] = r.Width, ["height"] = r.Height,
            };
        }
        if (raw is System.Windows.Point pt) return new Dictionary<string, object?> { ["x"] = pt.X, ["y"] = pt.Y };
        if (raw is bool or string or int or long or double) return raw;
        return raw.ToString();
    }

    private static T? TrySafe<T>(Func<T?> fn)
    {
        try { return fn(); } catch { return default; }
    }

    private static string? NullIfEmpty(string? s)
    {
        return string.IsNullOrEmpty(s) ? null : s;
    }
}

// Small ergonomics: List<T>.Add for two args.
internal static class ListExt
{
    public static void Add<T>(this List<T> list, T a, T b)
    {
        list.Add(a);
        list.Add(b);
    }
}
