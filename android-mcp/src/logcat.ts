import type { ChildProcess } from "node:child_process";
import { adbSpawn } from "./adb.js";

export type LogEntry = { ts: number; level: string; tag: string; text: string };

const MAX_BUFFER = 2000;
const buffer: LogEntry[] = [];
let proc: ChildProcess | null = null;

// Parse lines like: "04-24 15:01:23.456  1234  5678 I MyTag: hello"
const LINE_RE = /^\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d+\s+\d+\s+\d+\s+([VDIWEF])\s+([^:]+):\s(.*)$/;

export function startLogcat() {
  if (proc && !proc.killed) return;
  // -v threadtime: predictable format. Don't clear existing buffer — we keep ring.
  proc = adbSpawn(["logcat", "-v", "threadtime"]);
  let carry = "";
  proc.stdout?.on("data", (chunk: Buffer) => {
    const s = carry + chunk.toString("utf8");
    const lines = s.split("\n");
    carry = lines.pop() || "";
    for (const line of lines) {
      const m = line.match(LINE_RE);
      if (!m) continue;
      const entry: LogEntry = {
        ts: Date.now(),
        level: m[1],
        tag: m[2].trim(),
        text: m[3],
      };
      buffer.push(entry);
      if (buffer.length > MAX_BUFFER) buffer.shift();
    }
  });
  proc.on("exit", () => { proc = null; });
}

export function stopLogcat() {
  if (proc) proc.kill();
  proc = null;
}

export function readLogcat(opts: {
  filter?: string;
  level?: string;
  limit?: number;
  clear?: boolean;
}): LogEntry[] {
  startLogcat();
  const lvlSet = opts.level ? new Set(opts.level.toUpperCase().split(",")) : null;
  let list = buffer.slice();
  if (opts.filter) {
    const f = opts.filter;
    list = list.filter((e) => e.tag.includes(f) || e.text.includes(f));
  }
  if (lvlSet) list = list.filter((e) => lvlSet.has(e.level));
  list = list.slice(-(opts.limit ?? 200));
  if (opts.clear) buffer.length = 0;
  return list;
}
