// Parameter-bag helpers. JsonElement params are awkward to consume directly;
// these read with type coercion (Int↔Double, etc.) to match what the Swift
// helper does.

using System.Text.Json;

namespace WindowsMcpHelper;

internal static class Rpc
{
    public static string? Str(JsonElement p, string key)
    {
        if (p.ValueKind != JsonValueKind.Object) return null;
        if (!p.TryGetProperty(key, out var el)) return null;
        return el.ValueKind == JsonValueKind.String ? el.GetString() : null;
    }

    public static int? Int(JsonElement p, string key)
    {
        if (p.ValueKind != JsonValueKind.Object) return null;
        if (!p.TryGetProperty(key, out var el)) return null;
        if (el.ValueKind == JsonValueKind.Number)
        {
            if (el.TryGetInt32(out var i)) return i;
            if (el.TryGetDouble(out var d)) return (int)d;
        }
        if (el.ValueKind == JsonValueKind.String && int.TryParse(el.GetString(), out var s)) return s;
        return null;
    }

    public static double? Num(JsonElement p, string key)
    {
        if (p.ValueKind != JsonValueKind.Object) return null;
        if (!p.TryGetProperty(key, out var el)) return null;
        if (el.ValueKind == JsonValueKind.Number && el.TryGetDouble(out var d)) return d;
        if (el.ValueKind == JsonValueKind.String && double.TryParse(el.GetString(), out var s)) return s;
        return null;
    }

    public static bool? Bool(JsonElement p, string key)
    {
        if (p.ValueKind != JsonValueKind.Object) return null;
        if (!p.TryGetProperty(key, out var el)) return null;
        return el.ValueKind switch
        {
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            _ => null,
        };
    }

    public static List<string> StrList(JsonElement p, string key)
    {
        var result = new List<string>();
        if (p.ValueKind != JsonValueKind.Object) return result;
        if (!p.TryGetProperty(key, out var el) || el.ValueKind != JsonValueKind.Array) return result;
        foreach (var item in el.EnumerateArray())
        {
            if (item.ValueKind == JsonValueKind.String)
            {
                var s = item.GetString();
                if (s != null) result.Add(s);
            }
        }
        return result;
    }
}
