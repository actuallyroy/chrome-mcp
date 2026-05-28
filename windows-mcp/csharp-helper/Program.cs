// JSON-RPC dispatcher for the windows-mcp-helper sidecar.
//
// Wire format (request):  { "id": 1, "method": "outline", "params": { ... } }
// Wire format (response): { "id": 1, "result": { ... } }
//                    or:  { "id": 1, "error": { "message": "..." } }
//
// One message per line, newline-delimited, UTF-8.
//
// Two transports:
//   default                           — read stdin, write stdout (host-side use)
//   --listen tcp:<host>:<port>        — TCP listener (sandbox-side use)
//   --ready-file <path>               — write {ip, port, ready: true} atomically
//                                       after the TCP listener is bound. Used by
//                                       the host-side sandbox orchestrator to
//                                       discover the sandbox's IP without poll.
//
// stderr is reserved for logs that bubble to the parent (Node or sandbox-host).
//
// COM/UIA threading: System.Windows.Automation prefers STA for event handlers
// and is brittle on MTA threads under load. The transport (stdin reader or TCP
// accept loop) runs on whatever thread it lands on, but every Dispatcher.Dispatch
// call is queued onto a single dedicated STA worker thread via UiaWorker so
// concurrent COM/UIA calls never race.

using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;

namespace WindowsMcpHelper;

internal static class Program
{
    [STAThread]
    public static int Main(string[] args)
    {
        // Force UTF-8 on stdio. Defaults on Windows are codepage-dependent and
        // mangle non-ASCII data in JSON.
        Console.InputEncoding = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false);
        Console.OutputEncoding = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false);

        // Per-monitor DPI awareness so screen coordinates and window bounds
        // aren't scaled by Windows for us.
        try { _ = Native.SetProcessDpiAwarenessContext(Native.DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2); } catch { }

        Log($"started (pid={Environment.ProcessId})");

        // Start the dedicated STA worker; everything downstream queues onto it.
        UiaWorker.Start();
        // (No UIA warmup: a blocking AutomationElement.RootElement access
        // on the worker can wedge the queue inside a freshly-booted sandbox,
        // starving every subsequent dispatch. First real outline / describe
        // call pays the cold-init cost itself — small and bounded.)

        // Parse argv. Recognized flags:
        //   --listen tcp:<host>:<port>
        //   --ready-file <path>
        // Everything else is ignored (forward-compat).
        string? listen = null;
        string? readyFile = null;
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--listen" && i + 1 < args.Length) { listen = args[++i]; continue; }
            if (args[i] == "--ready-file" && i + 1 < args.Length) { readyFile = args[++i]; continue; }
        }

        try
        {
            if (listen != null)
            {
                return RunTcpServer(listen, readyFile);
            }
            return RunStdioServer();
        }
        finally
        {
            UiaWorker.Stop();
        }
    }

    // ---- stdio transport ----

    private static int RunStdioServer()
    {
        var reader = Console.In;
        string? line;
        while ((line = reader.ReadLine()) != null)
        {
            line = StripBom(line);
            if (line.Length == 0) continue;
            HandleLine(line, WriteStdoutResponse);
        }
        Log("stdin closed; exiting");
        return 0;
    }

    private static void WriteStdoutResponse(string json)
    {
        try
        {
            var bytes = Encoding.UTF8.GetBytes(json);
            // Direct write to stdout stream — Console.WriteLine adds \r\n on Windows
            // which breaks the line-delimited contract.
            using var stdout = Console.OpenStandardOutput();
            stdout.Write(bytes, 0, bytes.Length);
            stdout.WriteByte(0x0A);
            stdout.Flush();
        }
        catch (Exception ex)
        {
            Log($"stdout write error: {ex.Message}");
        }
    }

    // ---- TCP transport ----

    // Single-connection-at-a-time. v0.x deferral: multiple concurrent clients
    // would have to share UiaTree.RefStore which is globally numbered, so refs
    // would alias across each other's outline() calls. Reject second connection
    // instead.

    private static int RunTcpServer(string listenSpec, string? readyFile)
    {
        // listenSpec: "tcp:0.0.0.0:9335" or "tcp:127.0.0.1:9335"
        if (!listenSpec.StartsWith("tcp:", StringComparison.OrdinalIgnoreCase))
        {
            Log($"--listen expects 'tcp:<host>:<port>', got '{listenSpec}'");
            return 2;
        }
        var spec = listenSpec.Substring(4);
        var lastColon = spec.LastIndexOf(':');
        if (lastColon <= 0 || lastColon == spec.Length - 1)
        {
            Log($"--listen: malformed 'tcp:<host>:<port>': '{listenSpec}'");
            return 2;
        }
        var host = spec.Substring(0, lastColon);
        if (!int.TryParse(spec.Substring(lastColon + 1), out var port) || port <= 0 || port > 65535)
        {
            Log($"--listen: bad port in '{listenSpec}'");
            return 2;
        }
        IPAddress bindAddr;
        try { bindAddr = IPAddress.Parse(host); }
        catch { Log($"--listen: bad host in '{listenSpec}' (must be IP, not hostname)"); return 2; }

        var listener = new TcpListener(bindAddr, port);
        try
        {
            listener.Start();
        }
        catch (Exception ex)
        {
            Log($"TcpListener.Start failed: {ex.Message}");
            return 3;
        }
        Log($"listening on tcp://{host}:{port}");

        // Bind succeeded → write the ready file now (before accepting), so the
        // host-side orchestrator only sees the file once we're truly accepting.
        // Atomic: write .tmp, rename onto the final name.
        if (readyFile != null)
        {
            WriteReadyFile(readyFile, ResolveAdvertiseIp(host), port);
        }

        // Latest-connection-wins. When the host MCP process is killed (e.g. a
        // /mcp reconnect), its TCP socket dies *ungracefully* — with no
        // keepalive the old handler's blocking ReadLine wouldn't notice for a
        // long time, so a single-serial accept loop would refuse the new
        // connection and the reconnect's adopt-ping would time out. Instead we
        // accept continuously: each new client forcibly closes the previous
        // one (unblocking its ReadLine), then is served on its own thread.
        // Dispatch still funnels through the single UIA worker, so the brief
        // handler overlap can't race the ref store.
        while (true)
        {
            TcpClient client;
            try { client = listener.AcceptTcpClient(); }
            catch (Exception ex) { Log($"accept failed: {ex.Message}"); break; }

            var remote = client.Client.RemoteEndPoint?.ToString() ?? "?";
            var prev = Interlocked.Exchange(ref _currentClient, client);
            if (prev != null)
            {
                Log("new client connected — closing previous connection");
                try { prev.Close(); } catch { /* ignore */ }
            }
            Log($"client connected: {remote}");
            var t = new Thread(() => HandleClient(client, remote)) { IsBackground = true, Name = "wmcp-tcp-client" };
            t.Start();
        }
        return 0;
    }

    private static TcpClient? _currentClient;

    private static void HandleClient(TcpClient client, string remote)
    {
        try
        {
            using (client)
            using (var stream = client.GetStream())
            using (var reader = new StreamReader(stream, new UTF8Encoding(false), false, 8192, leaveOpen: true))
            using (var writer = new StreamWriter(stream, new UTF8Encoding(false), 8192, leaveOpen: true))
            {
                writer.NewLine = "\n";
                writer.AutoFlush = true;

                Action<string> send = (json) =>
                {
                    try { writer.WriteLine(json); }
                    catch (Exception ex) { Log($"tcp write to {remote} failed: {ex.Message}"); }
                };

                string? line;
                while ((line = reader.ReadLine()) != null)
                {
                    line = StripBom(line);
                    if (line.Length == 0) continue;
                    HandleLine(line, send);
                }
            }
        }
        catch (IOException ex) { Log($"tcp i/o {remote}: {ex.Message}"); }
        catch (Exception ex) { Log($"tcp handler {remote}: {ex.Message}"); }
    }

    private static void WriteReadyFile(string path, string ip, int port)
    {
        try
        {
            var dir = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            var payload = JsonSerializer.Serialize(new Dictionary<string, object?>
            {
                ["ip"] = ip,
                ["port"] = port,
                ["ready"] = true,
                ["pid"] = Environment.ProcessId,
                ["at"] = DateTimeOffset.UtcNow.ToString("o"),
            }, JsonOpts.Default);
            var tmp = path + ".tmp";
            File.WriteAllText(tmp, payload, new UTF8Encoding(false));
            // Atomic on NTFS (replace existing if needed).
            File.Move(tmp, path, overwrite: true);
            Log($"ready file: {path} -> {ip}:{port}");
        }
        catch (Exception ex)
        {
            Log($"ready file write failed: {ex.Message}");
        }
    }

    // When we bound to 0.0.0.0, pick a sensible IP to advertise back to the
    // host: prefer the first non-loopback IPv4 address that's part of an
    // interface in the Up state. Falls back to whatever the operator passed.
    private static string ResolveAdvertiseIp(string bindHost)
    {
        if (bindHost != "0.0.0.0") return bindHost;
        try
        {
            foreach (var ni in System.Net.NetworkInformation.NetworkInterface.GetAllNetworkInterfaces())
            {
                if (ni.OperationalStatus != System.Net.NetworkInformation.OperationalStatus.Up) continue;
                if (ni.NetworkInterfaceType == System.Net.NetworkInformation.NetworkInterfaceType.Loopback) continue;
                foreach (var ua in ni.GetIPProperties().UnicastAddresses)
                {
                    if (ua.Address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork)
                    {
                        return ua.Address.ToString();
                    }
                }
            }
        }
        catch { /* fall through */ }
        return bindHost;
    }

    // ---- shared per-line handler ----

    private static void HandleLine(string line, Action<string> send)
    {
        int id = 0;
        try
        {
            using var doc = JsonDocument.Parse(line);
            var root = doc.RootElement;
            id = root.TryGetProperty("id", out var idEl) && idEl.ValueKind == JsonValueKind.Number ? idEl.GetInt32() : 0;
            var method = root.TryGetProperty("method", out var methEl) ? methEl.GetString() ?? "" : "";
            var prms = root.TryGetProperty("params", out var pEl) && pEl.ValueKind == JsonValueKind.Object
                ? pEl.Clone()
                : default;
            // Dispatch on the STA worker so all UIA / COM calls happen on one
            // dedicated STA thread.
            var task = UiaWorker.RunAsync(() => Dispatcher.Dispatch(method, prms));
            var result = task.GetAwaiter().GetResult();
            send(SerializeResponse(id, result, null));
        }
        catch (Exception ex)
        {
            Log($"dispatch error: {ex.Message}");
            send(SerializeResponse(id, null, ex.Message));
        }
    }

    private static string SerializeResponse(int id, object? result, string? error)
    {
        var resp = new Dictionary<string, object?> { ["id"] = id };
        if (error != null) resp["error"] = new Dictionary<string, object?> { ["message"] = error };
        else resp["result"] = result;
        return JsonSerializer.Serialize(resp, JsonOpts.Default);
    }

    private static string StripBom(string line)
    {
        // Some hosts (PowerShell's StandardInput.WriteLine) prepend a UTF-8
        // BOM to the first line. Strip leading BOMs / zero-width chars so
        // the JSON parser doesn't choke on them.
        return line.Length > 0 && line[0] == '﻿' ? line.Substring(1) : line;
    }

    internal static void Log(string s)
    {
        try { Console.Error.WriteLine("[windows-mcp-helper] " + s); } catch { /* ignore */ }
    }
}

internal static class JsonOpts
{
    public static readonly JsonSerializerOptions Default = new()
    {
        WriteIndented = false,
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.Never,
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };
}
