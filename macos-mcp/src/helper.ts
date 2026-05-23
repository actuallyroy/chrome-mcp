// Spawn + manage the Swift sidecar process. Speaks newline-delimited JSON-RPC
// over its stdin/stdout. One singleton helper per Node process.

import { ChildProcessByStdio, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Readable, Writable } from "node:stream";

const __dirname = dirname(fileURLToPath(import.meta.url));

function findHelperBinary(): string {
  if (process.env.MACOS_MCP_HELPER && existsSync(process.env.MACOS_MCP_HELPER)) {
    return process.env.MACOS_MCP_HELPER;
  }
  const candidates = [
    join(__dirname, "..", "vendor", "macos-mcp-helper"),       // dist/ → ../vendor
    join(__dirname, "..", "..", "vendor", "macos-mcp-helper"), // src/ during ts-node
  ];
  const found = candidates.find((p) => existsSync(p));
  if (found) return found;
  throw new Error(
    "macos-mcp-helper binary not found. Build it with: " +
      "`cd macos-mcp && bash scripts/build-helper.sh`, " +
      "or set $MACOS_MCP_HELPER to its absolute path.",
  );
}

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
};

class HelperClient {
  private proc: ChildProcessByStdio<Writable, Readable, Readable> | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private stdoutBuf = "";

  private ensureStarted(): void {
    if (this.proc && this.proc.exitCode === null) return;
    const bin = findHelperBinary();
    const proc = spawn(bin, [], {
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessByStdio<Writable, Readable, Readable>;

    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
      this.stdoutBuf += chunk;
      let nl: number;
      while ((nl = this.stdoutBuf.indexOf("\n")) >= 0) {
        const line = this.stdoutBuf.slice(0, nl);
        this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: { message: string } };
          if (typeof msg.id !== "number") continue;
          const p = this.pending.get(msg.id);
          if (!p) continue;
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message));
          else p.resolve(msg.result);
        } catch (e) {
          // Bad JSON from helper — log to stderr; nothing we can do here.
          console.error(`[macos-mcp] bad helper response: ${(e as Error).message}: ${line.slice(0, 200)}`);
        }
      }
    });

    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk: string) => {
      process.stderr.write(`[helper] ${chunk}`);
    });

    proc.on("exit", (code, signal) => {
      // Reject everything in flight; next call will re-spawn.
      for (const [, p] of this.pending) {
        p.reject(new Error(`helper process exited (code=${code} signal=${signal})`));
      }
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
      try { this.proc.kill("SIGTERM"); } catch { /* ignore */ }
    }
  }
}

const client = new HelperClient();

export function callHelper<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  return client.call<T>(method, params);
}

export function shutdownHelper(): void {
  client.shutdown();
}

process.on("exit", shutdownHelper);
process.on("SIGINT", () => { shutdownHelper(); process.exit(130); });
process.on("SIGTERM", () => { shutdownHelper(); process.exit(143); });
