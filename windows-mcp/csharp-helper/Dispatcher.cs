// Central dispatch table. Mirrors the Swift helper's main.swift switch.

using System.Text.Json;

namespace WindowsMcpHelper;

internal static class Dispatcher
{
    public static object? Dispatch(string method, JsonElement p)
    {
        switch (method)
        {
            case "ping":
                return new Dictionary<string, object?> { ["pong"] = true, ["pid"] = Environment.ProcessId };

            case "check_permissions":
                return Permissions.Check();

            case "open_settings":
            {
                var svc = Rpc.Str(p, "service") ?? "privacy";
                Permissions.OpenSettings(svc);
                return new Dictionary<string, object?> { ["opened"] = svc };
            }

            case "list_apps":
                return Apps.List();

            case "focus_app":
            {
                var info = Apps.Find(Rpc.Int(p, "pid"), Rpc.Str(p, "exe_path") ?? Rpc.Str(p, "bundle_id"), Rpc.Str(p, "name"));
                if (info == null) throw new InvalidOperationException("app not found");
                var ok = Apps.Activate(info);
                return new Dictionary<string, object?>
                {
                    ["ok"] = ok,
                    ["pid"] = info.Pid,
                    ["name"] = info.Name,
                };
            }

            case "launch_app":
            {
                var info = Apps.Launch(
                    exePath: Rpc.Str(p, "exe_path") ?? Rpc.Str(p, "bundle_id"),
                    appid: Rpc.Str(p, "appid"),
                    name: Rpc.Str(p, "name"),
                    args: Rpc.Str(p, "args"));
                if (info == null) throw new InvalidOperationException("could not launch app");
                return new Dictionary<string, object?>
                {
                    ["pid"] = info.Pid,
                    ["name"] = info.Name,
                };
            }

            case "outline":
            {
                var pid = Rpc.Int(p, "pid") ?? throw new ArgumentException("pid required");
                UiaTree.RefStore.Reset();
                var maxDepth = Rpc.Int(p, "max_depth") ?? 20;
                var maxNodes = Rpc.Int(p, "max_nodes") ?? 1500;
                return UiaTree.Outline(pid, maxDepth, maxNodes);
            }

            case "describe":
            {
                var refId = Rpc.Int(p, "ref") ?? throw new ArgumentException("describe: ref required");
                return UiaTree.Describe(refId);
            }

            case "click":
            {
                var refId = Rpc.Int(p, "ref");
                if (refId.HasValue)
                {
                    var via = Input.ClickByRef(refId.Value, Rpc.Int(p, "count") ?? 1);
                    return new Dictionary<string, object?> { ["ok"] = true, ["via"] = via };
                }
                var x = Rpc.Num(p, "x");
                var y = Rpc.Num(p, "y");
                if (x.HasValue && y.HasValue)
                {
                    var button = Rpc.Str(p, "button") ?? "left";
                    var count = Rpc.Int(p, "count") ?? 1;
                    Input.ClickAt(x.Value, y.Value, button, count);
                    return new Dictionary<string, object?> { ["ok"] = true, ["via"] = "sendinput" };
                }
                throw new ArgumentException("click: pass ref OR (x,y)");
            }

            case "fill":
            {
                var refId = Rpc.Int(p, "ref") ?? throw new ArgumentException("fill: ref required");
                var value = Rpc.Str(p, "value") ?? throw new ArgumentException("fill: value required");
                var via = Input.FillByRef(refId, value);
                return new Dictionary<string, object?> { ["ok"] = true, ["via"] = via };
            }

            case "type_text":
            {
                var text = Rpc.Str(p, "text") ?? throw new ArgumentException("type_text: text required");
                var sent = Input.TypeString(text);
                var expected = (uint)text.Length * 2; // down+up per char
                var ok = sent > 0;
                var result = new Dictionary<string, object?>
                {
                    ["ok"] = ok,
                    ["events_sent"] = sent,
                };
                if (!ok)
                {
                    result["note"] = "SendInput injected 0 events — no window has keyboard focus, or input was blocked (UIPI). " +
                        "focus_app the target first; for an elevated target, run the MCP host elevated.";
                }
                return result;
            }

            case "press_key":
            {
                var key = Rpc.Str(p, "key") ?? throw new ArgumentException("press_key: key required");
                var mods = Rpc.StrList(p, "modifiers");
                var sent = Input.PressKey(key, mods);
                if (sent < 0)
                {
                    throw new ArgumentException(
                        $"press_key: unknown key '{key}'. Known: {string.Join(", ", Input.KnownKeys())}");
                }
                var ok = sent > 0;
                var result = new Dictionary<string, object?>
                {
                    ["ok"] = ok,
                    ["events_sent"] = sent,
                };
                if (!ok)
                {
                    result["note"] = "SendInput injected 0 events — no window has keyboard focus, or input was blocked (UIPI). " +
                        "focus_app the target first.";
                }
                return result;
            }

            case "hover":
            {
                var refId = Rpc.Int(p, "ref");
                if (refId.HasValue)
                {
                    if (!Input.HoverByRef(refId.Value, out var err))
                        throw new InvalidOperationException(err);
                    return new Dictionary<string, object?> { ["ok"] = true };
                }
                var x = Rpc.Num(p, "x");
                var y = Rpc.Num(p, "y");
                if (x.HasValue && y.HasValue)
                {
                    Input.MoveMouse(x.Value, y.Value);
                    return new Dictionary<string, object?> { ["ok"] = true };
                }
                throw new ArgumentException("hover: pass ref OR (x,y)");
            }

            case "scroll":
            {
                var dx = Rpc.Int(p, "dx") ?? 0;
                var dy = Rpc.Int(p, "dy") ?? -240;
                var refId = Rpc.Int(p, "ref");
                if (refId.HasValue)
                {
                    if (Input.HoverByRef(refId.Value, out _))
                    {
                        Thread.Sleep(30);
                    }
                }
                Input.Scroll(dx, dy);
                return new Dictionary<string, object?> { ["ok"] = true, ["dx"] = dx, ["dy"] = dy };
            }

            case "run_process":
            {
                var exe = Rpc.Str(p, "exe") ?? throw new ArgumentException("run_process: exe required");
                var procArgs = Rpc.Str(p, "args") ?? "";
                var wait = Rpc.Bool(p, "wait") ?? true;
                var timeoutMs = Rpc.Int(p, "timeout_ms") ?? 180_000;
                var cwd = Rpc.Str(p, "cwd");
                return Proc.Run(exe, procArgs, wait, timeoutMs, cwd);
            }

            case "screenshot":
            {
                var pid = Rpc.Int(p, "pid");
                var png = Capture.Screenshot(pid);
                return new Dictionary<string, object?>
                {
                    ["png_base64"] = Convert.ToBase64String(png),
                    ["bytes"] = png.Length,
                };
            }

            case "find_text":
            {
                var pid = Rpc.Int(p, "pid");
                var query = Rpc.Str(p, "text") ?? "";
                var lang = Rpc.Str(p, "language") ?? "en-US";
                var (hits, totalHits) = Ocr.FindText(pid, query, lang);
                return new Dictionary<string, object?>
                {
                    ["hits"] = hits,
                    ["total_hits"] = totalHits,
                    ["query"] = query,
                };
            }

            case "click_text":
            {
                var query = Rpc.Str(p, "text") ?? throw new ArgumentException("click_text: text required");
                if (string.IsNullOrEmpty(query)) throw new ArgumentException("click_text: text required");
                var pid = Rpc.Int(p, "pid");
                var occ = Rpc.Int(p, "occurrence_index") ?? 0;
                var exact = Rpc.Bool(p, "exact") ?? false;
                var lang = Rpc.Str(p, "language") ?? "en-US";
                return Ocr.ClickText(pid, query, occ, exact, lang);
            }

            default:
                throw new ArgumentException($"unknown method: {method}");
        }
    }
}
