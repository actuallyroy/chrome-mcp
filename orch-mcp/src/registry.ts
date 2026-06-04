// Persistent name → session-id mapping for this project's workers.
//
// Lives at ~/.claude/projects/<encoded-cwd>/workers.json — the same directory
// Claude Code uses for its session transcripts and memory, so it's naturally
// scoped to one project and survives across master-session restarts.

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Worker = {
  session_id: string;
  topic: string;
  created_at: number;
  last_activity_at: number;
  // What initial prompt this worker was spun up with (when known). Useful
  // for `worker_status` so the master can tell at a glance what a worker
  // was originally tasked with.
  initial_prompt?: string;
};

export type RegistryShape = {
  workers: Record<string, Worker>;
};

// Encode a filesystem path the same way Claude Code does: replace `/` and
// spaces with `-`. Matches existing transcript dirs like
// `~/.claude/projects/-Users-mac-Desktop-Amit-Personal-chrome-mcp/`.
export function encodeProjectDir(absPath: string): string {
  return absPath.replace(/[ /]/g, "-");
}

export function projectRoot(): string {
  return process.env.ORCH_MCP_PROJECT_DIR || process.cwd();
}

export function registryPath(): string {
  return join(
    homedir(),
    ".claude",
    "projects",
    encodeProjectDir(projectRoot()),
    "workers.json",
  );
}

export async function readRegistry(): Promise<RegistryShape> {
  try {
    const raw = await fs.readFile(registryPath(), "utf8");
    return JSON.parse(raw) as RegistryShape;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { workers: {} };
    throw e;
  }
}

export async function writeRegistry(r: RegistryShape): Promise<void> {
  const path = registryPath();
  await fs.mkdir(join(path, ".."), { recursive: true });
  await fs.writeFile(path, JSON.stringify(r, null, 2));
}

export async function upsertWorker(name: string, w: Worker): Promise<void> {
  const r = await readRegistry();
  r.workers[name] = w;
  await writeRegistry(r);
}

export async function getWorker(name: string): Promise<Worker | null> {
  const r = await readRegistry();
  return r.workers[name] || null;
}

export async function removeWorker(name: string): Promise<boolean> {
  const r = await readRegistry();
  if (!(name in r.workers)) return false;
  delete r.workers[name];
  await writeRegistry(r);
  return true;
}

export async function touchWorker(name: string): Promise<void> {
  const r = await readRegistry();
  if (r.workers[name]) {
    r.workers[name].last_activity_at = Date.now();
    await writeRegistry(r);
  }
}
