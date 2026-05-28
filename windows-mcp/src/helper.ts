// JSON-RPC client for the C# sidecar helper. Two transports:
//   - SpawnHelperClient: spawn windows-mcp-helper.exe, talk over stdin/stdout
//   - TcpHelperClient:   connect to a remote helper over TCP (sandbox case)
//
// Both share the same `call<T>()` API and pending-map message correlation.
// Tools call `getHelperFor("host" | "sandbox")` to pick the right one.

import { ChildProcessByStdio, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createConnection, Socket } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Readable, Writable } from "node:stream";

const __dirname = dirname(fileURLToPath(import.meta.url));

export type HelperTarget = "host" | "sandbox";

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
};

// ---- shared protocol helpers ---------------------------------------------

function consumeLines(buf: string, onLine: (line: string) => void): string {
  let rest = buf;
  let nl: number;
  while ((nl = rest.indexOf("\n")) >= 0) {
    const line = rest.slice(0, nl).replace(/\r$/, "");
    rest = rest.slice(nl + 1);
    if (line) onLine(line);
  }
  return rest;
}

function dispatchResponseLine(pending: Map<number, Pending>, line: string): void {
  try {
    const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: { message: string } };
    if (typeof msg.id !== "number") return;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message));
    else p.resolve(msg.result);
  } catch (e) {
    console.error(`[windows-mcp] bad helper response: ${(e as Error).message}: ${line.slice(0, 200)}`);
  }
}

// ---- spawn (host) transport ----------------------------------------------

function findHelperBinary(): string {
  if (process.env.WINDOWS_MCP_HELPER && existsSync(process.env.WINDOWS_MCP_HELPER)) {
    return process.env.WINDOWS_MCP_HELPER;
  }
  const candidates = [
    join(__dirname, "..", "vendor", "windows-mcp-helper.exe"),       // dist/ → ../vendor
    join(__dirname, "..", "..", "vendor", "windows-mcp-helper.exe"), // src/ during ts-node
  ];
  const found = candidates.find((p) => existsSync(p));
  if (found) return found;
  throw new Error(
    "windows-mcp-helper.exe not found. Build it with: " +
      "`cd windows-mcp && powershell scripts/build-helper.ps1`, " +
      "or set $env:WINDOWS_MCP_HELPER to its absolute path.",
  );
}

class SpawnHelperClient {
  private proc: ChildProcessByStdio<Writable, Readable, Readable> | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private stdoutBuf = "";

  private ensureStarted(): void {
    if (this.proc && this.proc.exitCode === null) return;
    const bin = findHelperBinary();
    const proc = spawn(bin, [], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    }) as ChildProcessByStdio<Writable, Readable, Readable>;

    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
      this.stdoutBuf = consumeLines(this.stdoutBuf + chunk, (line) => dispatchResponseLine(this.pending, line));
    });

    let earlyStderr = "";
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk: string) => {
      if (earlyStderr.length < 4000) earlyStderr += chunk;
      process.stderr.write(`[helper] ${chunk}`);
    });

    proc.on("exit", (code, signal) => {
      const msg = translateExitToHumanError(code, signal, earlyStderr);
      for (const [, p] of this.pending) p.reject(new Error(msg));
      this.pending.clear();
      this.proc = null;
    });

    this.proc = proc;
  }

  async call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.ensureStarted();
    const proc = this.proc!;
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      const body = JSON.stringify({ id, method, params }) + "\n";
      proc.stdin.write(body, (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  shutdown(): void {
    if (this.proc && this.proc.exitCode === null) {
      try { this.proc.stdin.end(); } catch { /* ignore */ }
      try { this.proc.kill(); } catch { /* ignore */ }
    }
  }
}

// ---- TCP (sandbox) transport ---------------------------------------------

class TcpHelperClient {
  private socket: Socket | null = null;
  private connecting: Promise<void> | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buf = "";

  constructor(private readonly host: string, private readonly port: number) {}

  private connect(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<void>((resolve, reject) => {
      const s = createConnection({ host: this.host, port: this.port });
      s.setEncoding("utf8");
      s.on("connect", () => {
        this.socket = s;
        this.connecting = null;
        resolve();
      });
      s.on("data", (chunk: string | Buffer) => {
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        this.buf = consumeLines(this.buf + text, (line) => dispatchResponseLine(this.pending, line));
      });
      const fail = (err: Error) => {
        this.failAllPending(
          `sandbox helper disconnected (${err.message}) — close the Sandbox window and call start_sandbox to recover`,
        );
        this.socket = null;
        this.connecting = null;
        try { s.destroy(); } catch { /* ignore */ }
        reject(err);
      };
      s.on("error", fail);
      s.on("close", () => {
        if (!this.socket) return;
        this.failAllPending(
          "sandbox helper disconnected — close the Sandbox window and call start_sandbox to recover",
        );
        this.socket = null;
      });
    });
    return this.connecting;
  }

  private failAllPending(message: string): void {
    for (const [, p] of this.pending) p.reject(new Error(message));
    this.pending.clear();
  }

  async call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    await this.connect();
    const s = this.socket;
    if (!s) throw new Error("tcp helper not connected");
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      const body = JSON.stringify({ id, method, params }) + "\n";
      s.write(body, (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  shutdown(): void {
    if (this.socket) {
      try { this.socket.end(); } catch { /* ignore */ }
      try { this.socket.destroy(); } catch { /* ignore */ }
      this.socket = null;
    }
    this.failAllPending("helper shutting down");
  }
}

export interface HelperClient {
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  shutdown(): void;
}

// ---- error translation (.NET runtime missing) ----------------------------

function translateExitToHumanError(code: number | null, signal: NodeJS.Signals | null, stderr: string): string {
  const lower = stderr.toLowerCase();
  const looksLikeMissingRuntime =
    code === 150 ||
    lower.includes("you must install or update .net") ||
    lower.includes("framework: 'microsoft.windowsdesktop.app'") ||
    lower.includes("the framework 'microsoft.windowsdesktop.app'");
  if (looksLikeMissingRuntime) {
    return (
      "windows-mcp helper requires the .NET 8 Desktop Runtime, which isn't installed.\n" +
      "  Install (~55 MB, Microsoft-signed):\n" +
      "    https://aka.ms/dotnet/8.0/windowsdesktop-runtime-win-x64.exe\n" +
      "  Or via winget:\n" +
      "    winget install Microsoft.DotNet.DesktopRuntime.8\n" +
      "  Then restart whatever spawned this MCP server."
    );
  }
  const stderrTail = stderr.trim().split(/\r?\n/).slice(-4).join("\n");
  return `helper process exited (code=${code} signal=${signal})${stderrTail ? "\n" + stderrTail : ""}`;
}

// ---- routing -------------------------------------------------------------

const hostClient: HelperClient = new SpawnHelperClient();

// Sandbox endpoint is published by src/sandbox.ts once the in-sandbox helper's
// ready file has appeared. Until then, sandbox-targeted calls await readiness.
let sandboxEndpoint: { host: string; port: number } | null = null;
let sandboxClient: TcpHelperClient | null = null;
let sandboxReady: Promise<void> | null = null;
let sandboxReadyResolve: (() => void) | null = null;

export function setSandboxEndpoint(host: string, port: number): void {
  sandboxEndpoint = { host, port };
  // Tear down any previous TCP client so it reconnects to the new endpoint.
  if (sandboxClient) { try { sandboxClient.shutdown(); } catch { /* ignore */ } sandboxClient = null; }
  sandboxClient = new TcpHelperClient(host, port);
  if (sandboxReadyResolve) { sandboxReadyResolve(); sandboxReadyResolve = null; sandboxReady = null; }
}

export function clearSandboxEndpoint(): void {
  if (sandboxClient) { try { sandboxClient.shutdown(); } catch { /* ignore */ } sandboxClient = null; }
  sandboxEndpoint = null;
}

// Resolves when the sandbox endpoint is set (called by sandbox.ts after ready
// file appears). If a `target: "sandbox"` tool call lands while the sandbox
// is still booting, it awaits this promise — so the agent doesn't see a
// transient error during the 10-15 s cold start.
export function waitForSandboxEndpoint(timeoutMs: number): Promise<void> {
  if (sandboxEndpoint) return Promise.resolve();
  if (!sandboxReady) {
    sandboxReady = new Promise<void>((resolve) => { sandboxReadyResolve = resolve; });
  }
  if (timeoutMs <= 0) return sandboxReady;
  return Promise.race([
    sandboxReady,
    new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error(
        `sandbox helper did not come up within ${timeoutMs}ms — check stderr for boot progress`,
      )), timeoutMs),
    ),
  ]);
}

export async function getHelperFor(target: HelperTarget): Promise<HelperClient> {
  if (target === "host") return hostClient;
  // sandbox
  if (!sandboxEndpoint && !process.env.WINDOWS_MCP_SANDBOX) {
    throw new Error(
      "target='sandbox' but sandbox mode isn't configured. Set WINDOWS_MCP_SANDBOX=1 and " +
      "WINDOWS_MCP_SANDBOX_PROJECT=<absolute path> in your .mcp.json env block.",
    );
  }
  if (!sandboxEndpoint) {
    // Sandbox is booting (sandbox.ts kicked off startSandbox on MCP connect).
    // Wait up to 60 s for ready.json to appear and setSandboxEndpoint to fire.
    await waitForSandboxEndpoint(60_000);
  }
  if (!sandboxClient) throw new Error("sandbox endpoint set but client not initialized");
  return sandboxClient;
}

// Backwards-compatible: host-only callers.
export function callHelper<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  return hostClient.call<T>(method, params);
}

export function shutdownHelper(): void {
  try { hostClient.shutdown(); } catch { /* ignore */ }
  if (sandboxClient) { try { sandboxClient.shutdown(); } catch { /* ignore */ } sandboxClient = null; }
}

process.on("exit", shutdownHelper);
process.on("SIGINT", () => { shutdownHelper(); process.exit(130); });
process.on("SIGTERM", () => { shutdownHelper(); process.exit(143); });
