// Cross-session tab ownership. Two Claude Code sessions running chrome-mcp
// against the same Chrome instance would both happily drive the same tab
// without noticing — collisions silently corrupt each other's state. We claim
// the active tab in a shared lockfile keyed by `<cdp-port>:<target-id>` and
// heartbeat the entry; another session that tries to claim a fresh-locked
// tab gets a clear error and an explicit `take_tab` override.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const LOCK_DIR = process.env.CHROME_MCP_LOCK_DIR || join(homedir(), ".chrome-mcp");
const LOCK_FILE = join(LOCK_DIR, "tab-locks.json");
const STALE_MS = 30_000;
const HEARTBEAT_MS = 5_000;

export const SESSION_ID = randomUUID();

type Lock = {
  session_id: string;
  pid: number;
  claimed_at: number;
  heartbeat: number;
  url?: string;
};

type LockFile = Record<string, Lock>;

function readLocks(): LockFile {
  if (!existsSync(LOCK_FILE)) return {};
  try {
    return JSON.parse(readFileSync(LOCK_FILE, "utf8")) as LockFile;
  } catch {
    return {};
  }
}

function writeLocks(locks: LockFile) {
  mkdirSync(LOCK_DIR, { recursive: true });
  const tmp = LOCK_FILE + ".tmp." + process.pid;
  writeFileSync(tmp, JSON.stringify(locks, null, 2));
  renameSync(tmp, LOCK_FILE);
}

function isStale(lock: Lock): boolean {
  return Date.now() - lock.heartbeat > STALE_MS;
}

function key(port: number, targetId: string): string {
  return `${port}:${targetId}`;
}

export type AcquireResult =
  | { ok: true }
  | { ok: false; owner: Lock };

export function acquireLock(
  port: number,
  targetId: string,
  url: string,
  force = false,
): AcquireResult {
  const locks = readLocks();
  const k = key(port, targetId);
  const existing = locks[k];
  if (
    existing &&
    existing.session_id !== SESSION_ID &&
    !isStale(existing) &&
    !force
  ) {
    return { ok: false, owner: existing };
  }
  locks[k] = {
    session_id: SESSION_ID,
    pid: process.pid,
    claimed_at: existing?.session_id === SESSION_ID ? existing.claimed_at : Date.now(),
    heartbeat: Date.now(),
    url,
  };
  writeLocks(locks);
  return { ok: true };
}

export function releaseLock(port: number, targetId: string) {
  const locks = readLocks();
  const k = key(port, targetId);
  if (locks[k]?.session_id === SESSION_ID) {
    delete locks[k];
    writeLocks(locks);
  }
}

export function releaseAllOwnedLocks() {
  const locks = readLocks();
  let changed = false;
  for (const [k, v] of Object.entries(locks)) {
    if (v.session_id === SESSION_ID) {
      delete locks[k];
      changed = true;
    }
  }
  if (changed) writeLocks(locks);
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: "missing" | "taken"; owner?: Lock };

export function verifyLock(port: number, targetId: string): VerifyResult {
  const locks = readLocks();
  const k = key(port, targetId);
  const existing = locks[k];
  if (!existing) return { ok: false, reason: "missing" };
  if (existing.session_id !== SESSION_ID) {
    return { ok: false, reason: "taken", owner: existing };
  }
  return { ok: true };
}

export function heartbeat(port: number, targetId: string) {
  const locks = readLocks();
  const k = key(port, targetId);
  if (locks[k]?.session_id === SESSION_ID) {
    locks[k].heartbeat = Date.now();
    writeLocks(locks);
  }
}

export function listFreshLocks(): LockFile {
  const locks = readLocks();
  const fresh: LockFile = {};
  for (const [k, v] of Object.entries(locks)) {
    if (!isStale(v)) fresh[k] = v;
  }
  return fresh;
}

// Heartbeat loop: refresh whichever target the caller currently owns.
let heartbeatTimer: NodeJS.Timeout | null = null;
let heartbeatTarget: { port: number; targetId: string } | null = null;

export function setHeartbeatTarget(target: { port: number; targetId: string } | null) {
  heartbeatTarget = target;
  if (target && !heartbeatTimer) {
    heartbeatTimer = setInterval(() => {
      if (heartbeatTarget) heartbeat(heartbeatTarget.port, heartbeatTarget.targetId);
    }, HEARTBEAT_MS);
    heartbeatTimer.unref();
  }
}

// Cleanup on shutdown so a clean exit doesn't leave stale locks behind.
let cleanupInstalled = false;
export function installCleanup() {
  if (cleanupInstalled) return;
  cleanupInstalled = true;
  const cleanup = () => {
    try { releaseAllOwnedLocks(); } catch { /* ignore */ }
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(130); });
  process.on("SIGTERM", () => { cleanup(); process.exit(143); });
}

export function formatOwner(o: Lock): string {
  const ageSec = Math.round((Date.now() - o.claimed_at) / 1000);
  return `session=${o.session_id.slice(0, 8)} pid=${o.pid} claimed ${ageSec}s ago${o.url ? ` url=${o.url}` : ""}`;
}
