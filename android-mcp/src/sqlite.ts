// SQLite-on-Android helpers. Pattern from amitwinit/SQLite-DevTools-Mobile-ReactNative:
// shell out via `adb shell run-as <pkg>` (or fall back to direct `cd <dataDir>` on
// envs where run-as is broken — emulators, WayDroid, some OEMs), and invoke a
// `sqlite3` binary that's already on the device (system path) or copied into
// the app sandbox.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { adb, adbShell } from "./adb.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Vendored sqlite3-arm64 (taken from amitwinit/SQLite-DevTools-Mobile-ReactNative
// because there's no canonical Android sqlite3 distribution). Shipped inside
// the package — search order is env override → npm-package vendor dir → src
// layout fallback for ts-node dev runs.
function findVendoredSqlite3(): string | null {
  if (process.env.ANDROID_MCP_SQLITE3 && existsSync(process.env.ANDROID_MCP_SQLITE3)) {
    return process.env.ANDROID_MCP_SQLITE3;
  }
  const candidates = [
    join(__dirname, "..", "vendor", "sqlite3-arm64"),
    join(__dirname, "..", "..", "vendor", "sqlite3-arm64"),
  ];
  return candidates.find((p) => existsSync(p)) || null;
}

// How we reach into the app sandbox, resolved once per package:
//  - 'run-as': app is debuggable, `run-as <pkg>` works (the normal path)
//  - 'root':   run-as refused (non-debuggable app) but the device has root,
//              so we shell in via `su 0` (issue #20)
//  - 'cd':     neither — best-effort `cd <dataDir>` (emulators where the dir
//              is world-accessible to the shell user)
type AccessMode = "run-as" | "root" | "cd";

type PkgState = {
  access: AccessMode | null;
  appDataDir: string;
  sqlite3Path: string; // resolved path to sqlite3 binary, runnable via runAs()
};

const cache = new Map<string, PkgState>();

function getState(pkg: string): PkgState {
  let s = cache.get(pkg);
  if (!s) {
    s = { access: null, appDataDir: "", sqlite3Path: "" };
    cache.set(pkg, s);
  }
  return s;
}

export function clearSqliteCache(pkg?: string) {
  if (pkg) cache.delete(pkg);
  else cache.clear();
}

// Is `su 0` (root) available on this device? Cached for the session.
let rootAvailable: boolean | null = null;
export async function hasRoot(): Promise<boolean> {
  if (rootAvailable !== null) return rootAvailable;
  try {
    const id = await adbShell("su 0 id 2>/dev/null");
    rootAvailable = /uid=0/.test(id);
  } catch {
    rootAvailable = false;
  }
  return rootAvailable;
}

// Escape a string so it survives one extra layer of double-quoted shell parsing
// (needed when wrapping an already-built command in `su 0 sh -c "..."`).
function reEscapeForDoubleQuote(s: string): string {
  return s.replace(/([\\"$`])/g, "\\$1");
}

async function resolveDataDir(pkg: string): Promise<string> {
  try {
    const info = await adbShell(`dumpsys package ${pkg} | grep dataDir | head -1`);
    const m = info.match(/dataDir=(.+)/);
    return m ? m[1].trim() : `/data/data/${pkg}`;
  } catch {
    return `/data/data/${pkg}`;
  }
}

async function probeAccess(pkg: string): Promise<void> {
  const s = getState(pkg);
  if (s.access !== null) return;
  try {
    await adbShell(`run-as ${pkg} id`);
    s.access = "run-as";
    return;
  } catch { /* run-as refused (non-debuggable app) — try root, then plain cd */ }
  s.appDataDir = await resolveDataDir(pkg);
  s.access = (await hasRoot()) ? "root" : "cd";
}

// Run a shell command as the app — uses run-as when available, falls back to
// `su 0` (root) for non-debuggable apps on rooted devices (issue #20), and
// finally to a plain `cd <dataDir>` for envs where the dir is world-accessible.
export async function runAs(pkg: string, command: string): Promise<string> {
  await probeAccess(pkg);
  const s = getState(pkg);
  let full: string;
  if (s.access === "run-as") {
    full = `run-as ${pkg} ${command}`;
  } else if (s.access === "root") {
    // Wrap in `su 0 sh -c "..."`. The inner command keeps its original
    // (single-level) quoting; we only re-escape so the outer device shell
    // hands `sh -c` the command verbatim.
    full = `su 0 sh -c "${reEscapeForDoubleQuote(`cd ${s.appDataDir} && ${command}`)}"`;
  } else {
    full = `cd ${s.appDataDir} && ${command}`;
  }
  return (await adbShell(full)).replace(/\r\n/g, "\n").trimEnd();
}

// Whether the resolved access path for this package is root (`su 0`). Callers
// use this to take the root-aware branch (e.g. pulling a DB via `su 0 cat`).
export async function accessModeFor(pkg: string): Promise<AccessMode> {
  await probeAccess(pkg);
  return getState(pkg).access || "cd";
}

// Parse the leading "3.x.y" from `sqlite3 -version` output. Returns null when
// it doesn't look like a sqlite3 version string.
function parseSqliteVersion(out: string): { major: number; minor: number } | null {
  const m = out.trim().match(/^(\d+)\.(\d+)/);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]) };
}

// `-json` output mode was added in SQLite 3.33.0 (2020-08-14). Older binaries
// (the system sqlite3 is frequently 3.32.2) error on `-json`, forcing the
// brittle `-header -separator` parse — so we prefer a binary that supports it.
function supportsJson(v: { major: number; minor: number } | null): boolean {
  if (!v) return false;
  return v.major > 3 || (v.major === 3 && v.minor >= 33);
}

// Copy a sqlite3 binary (already on the device at `srcPath`) into the app
// sandbox so run-as can exec it directly. Returns "./sqlite3" on success.
async function copyIntoAppDir(pkg: string, srcPath: string): Promise<string | null> {
  try {
    await runAs(pkg, `cp ${srcPath} ./sqlite3`);
    await runAs(pkg, "chmod 755 ./sqlite3");
    const verify = (await runAs(pkg, "./sqlite3 -version")).trim();
    if (parseSqliteVersion(verify)) return "./sqlite3";
  } catch { /* copy/verify failed */ }
  return null;
}

// Push the vendored modern arm64 sqlite3 to /data/local/tmp. Returns its
// on-device path, or null if unavailable / wrong ABI.
async function pushVendored(): Promise<string | null> {
  const vendored = findVendoredSqlite3();
  if (!vendored) return null;
  try {
    await adb(["push", vendored, "/data/local/tmp/sqlite3"], { timeout_ms: 30_000 });
    await adbShell("chmod 755 /data/local/tmp/sqlite3");
    const v = (await adbShell("/data/local/tmp/sqlite3 -version 2>&1")).trim();
    // An ABI mismatch (x86 emulator) prints "... exec format error" / no version.
    if (parseSqliteVersion(v)) return "/data/local/tmp/sqlite3";
  } catch { /* push/exec failed (likely wrong ABI) */ }
  return null;
}

// Find a usable sqlite3 binary and cache its path. Provisions one if the app
// sandbox doesn't have it yet (issue #47): a freshly (re)installed app has no
// `./sqlite3`, so we copy one in. We PREFER a binary that supports `-json` —
// the vendored modern build over an old system sqlite3 — so structured output
// keeps working instead of silently falling back to separator parsing.
export async function ensureSqlite3(pkg: string): Promise<string> {
  const s = getState(pkg);
  if (s.sqlite3Path) return s.sqlite3Path;

  // 1. App-local sqlite3 that already supports -json — use as-is.
  try {
    const v = parseSqliteVersion(await runAs(pkg, "./sqlite3 -version"));
    if (supportsJson(v)) { s.sqlite3Path = "./sqlite3"; return s.sqlite3Path; }
  } catch { /* not present yet */ }

  // 2. Survey the system binaries and their versions (don't commit yet — we may
  //    have a newer vendored build to prefer).
  const systemPaths = ["/system/bin/sqlite3", "/system/xbin/sqlite3", "/data/local/tmp/sqlite3"];
  let systemModern: string | null = null;   // a system binary that supports -json
  let systemAny: string | null = null;      // any usable system binary (maybe old)
  for (const p of systemPaths) {
    try {
      const v = parseSqliteVersion(await adbShell(`${p} -version 2>&1`));
      if (!v) continue;
      if (!systemAny) systemAny = p;
      if (supportsJson(v)) { systemModern = p; break; }
    } catch { /* not at this path */ }
  }

  // 3. Prefer a -json-capable binary: a modern system one, else the vendored
  //    modern build. Provision into the app dir (run-as exec); fall back to the
  //    on-device path when the in-sandbox copy isn't possible.
  if (systemModern) {
    s.sqlite3Path = (await copyIntoAppDir(pkg, systemModern)) || systemModern;
    return s.sqlite3Path;
  }
  const vendoredPath = await pushVendored();
  if (vendoredPath) {
    s.sqlite3Path = (await copyIntoAppDir(pkg, vendoredPath)) || vendoredPath;
    return s.sqlite3Path;
  }

  // 4. Last resort: a system binary that works but is too old for -json (queries
  //    fall back to -header -separator parsing automatically).
  if (systemAny) {
    s.sqlite3Path = (await copyIntoAppDir(pkg, systemAny)) || systemAny;
    return s.sqlite3Path;
  }
  // ...or an already-present app-local binary too old for -json.
  try {
    if (parseSqliteVersion(await runAs(pkg, "./sqlite3 -version"))) { s.sqlite3Path = "./sqlite3"; return s.sqlite3Path; }
  } catch { /* still nothing */ }

  throw new Error(
    "sqlite3 not found on device and no usable vendored binary (wrong ABI?). " +
      "Push one manually: adb push <sqlite3-binary> /data/local/tmp/sqlite3 && adb shell chmod 755 /data/local/tmp/sqlite3",
  );
}

// Get debuggable third-party packages (those run-as can attach to). Falls
// back to all third-party packages if the run-as probe finds none.
export async function listDebuggablePackages(): Promise<string[]> {
  // On a rooted device, `su 0` can reach every app's sandbox, so list all
  // third-party packages — not just the debuggable ones run-as can attach to
  // (issue #20: non-debuggable production apps were invisible before).
  if (await hasRoot()) {
    const all = await adbShell('pm list packages -3 2>/dev/null | tr -d "\\r" | sed "s/package://"');
    const pkgs = all.split("\n").map((l) => l.trim()).filter(Boolean);
    pkgs.sort();
    return pkgs;
  }
  const probe =
    'for p in $(pm list packages --user 0 -3 2>/dev/null | tr -d "\\r" | sed "s/package://"); do ' +
    "run-as $p id 2>/dev/null 1>/dev/null && echo $p; done";
  const out = (await adbShell(probe)).trim();
  let pkgs = out.split("\n").map((l) => l.trim()).filter(Boolean);
  if (pkgs.length === 0) {
    const fallback = await adbShell('pm list packages -3 2>/dev/null | tr -d "\\r" | sed "s/package://"');
    pkgs = fallback.split("\n").map((l) => l.trim()).filter(Boolean);
  }
  pkgs.sort();
  return pkgs;
}

const DB_LOCATIONS = ["databases", "files", "files/SQLite", "no_backup"];

export async function listDatabases(pkg: string): Promise<{ name: string; path: string }[]> {
  const seen = new Set<string>();
  const out: { name: string; path: string }[] = [];
  for (const loc of DB_LOCATIONS) {
    let entries: string[];
    try {
      const raw = await runAs(pkg, `ls ${loc} 2>/dev/null`);
      entries = raw.split("\n").map((l) => l.trim()).filter(Boolean);
    } catch { continue; }
    for (const f of entries) {
      if (!/\.(db|sqlite|sqlite3)$/i.test(f)) continue;
      if (seen.has(f)) continue;
      seen.add(f);
      out.push({ name: f, path: `${loc}/${f}` });
    }
  }
  return out;
}

export async function searchDatabases(pkg: string, query?: string): Promise<{ name: string; path: string }[]> {
  let raw: string;
  try {
    raw = await runAs(
      pkg,
      `find . -name "*.db" -o -name "*.sqlite" -o -name "*.sqlite3" 2>/dev/null`,
    );
  } catch (e) {
    throw new Error(`find failed: ${(e as Error).message}`);
  }
  const q = (query || "").toLowerCase();
  const out: { name: string; path: string }[] = [];
  for (const line of raw.split("\n")) {
    let p = line.trim();
    if (!p) continue;
    if (p.startsWith("./")) p = p.slice(2);
    const name = p.split("/").pop() || p;
    if (/-(journal|wal|shm)$/.test(name)) continue;
    if (!q || name.toLowerCase().includes(q) || p.toLowerCase().includes(q)) {
      out.push({ name, path: p });
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// Resolve a partial dbPath (just a name, or a relative path) to an actual
// path inside the app sandbox.
export async function resolveDbPath(pkg: string, dbPath: string): Promise<string> {
  // Already a full relative path inside one of the known locations? Try it directly.
  if (dbPath.includes("/")) {
    try {
      await runAs(pkg, `ls "${dbPath}"`);
      return dbPath;
    } catch { /* fall through to search */ }
  }
  for (const loc of DB_LOCATIONS) {
    const p = `${loc}/${dbPath}`;
    try {
      const ls = await runAs(pkg, `ls "${p}"`);
      if (ls.includes(dbPath)) return p;
    } catch { /* not here */ }
  }
  throw new Error(`Database "${dbPath}" not found in ${pkg}. Try sqlite_list_databases first.`);
}

// Escape SQL for embedding inside a double-quoted shell string.
function escapeSql(sql: string): string {
  return sql
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$")
    .replace(/`/g, "\\`");
}

const WRITE_OPS = ["INSERT", "UPDATE", "DELETE", "DROP", "CREATE", "ALTER", "REPLACE", "PRAGMA"];

export function isWriteQuery(sql: string): boolean {
  const upper = sql.trim().toUpperCase();
  // PRAGMA is technically read for table_info etc; caller decides. Default false here.
  return ["INSERT", "UPDATE", "DELETE", "DROP", "CREATE", "ALTER", "REPLACE"].some((op) => upper.startsWith(op));
}

// Run a SELECT-style query, returning parsed JSON rows.
export async function sqliteQuery(
  pkg: string,
  dbPath: string,
  sql: string,
): Promise<Record<string, unknown>[]> {
  const sqlite = await ensureSqlite3(pkg);
  const resolved = await resolveDbPath(pkg, dbPath);
  const escaped = escapeSql(sql);
  const cmd = `${sqlite} "${resolved}" -json "${escaped}"`;
  const out = (await runAs(pkg, cmd)).trim();
  if (!out) return [];
  try {
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // Fallback: header + pipe separator
    return parseFallback(await runAs(pkg, `${sqlite} "${resolved}" -header -separator "|" "${escaped}"`));
  }
}

function parseFallback(out: string): Record<string, unknown>[] {
  const lines = out.split("\n").filter(Boolean);
  if (!lines.length) return [];
  const headers = lines[0].split("|").map((h) => h.trim());
  const rows: Record<string, unknown>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split("|").map((v) => v.trim());
    if (vals.length !== headers.length) continue;
    const row: Record<string, unknown> = {};
    headers.forEach((h, idx) => { row[h] = vals[idx]; });
    rows.push(row);
  }
  return rows;
}

// Run a write command. Returns sqlite3 stdout (usually empty).
export async function sqliteExec(
  pkg: string,
  dbPath: string,
  sql: string,
): Promise<string> {
  const sqlite = await ensureSqlite3(pkg);
  const resolved = await resolveDbPath(pkg, dbPath);
  const escaped = escapeSql(sql);
  const cmd = `${sqlite} "${resolved}" "${escaped}"`;
  return runAs(pkg, cmd);
}

// Pull a database file out of the sandbox to the host.
export async function pullDatabase(
  pkg: string,
  dbPath: string,
  destPath: string,
): Promise<{ size: number }> {
  const resolved = await resolveDbPath(pkg, dbPath);
  // Stage in /data/local/tmp via run-as cat (works even when adb pull can't
  // see inside the app sandbox).
  const stage = `/data/local/tmp/_android_mcp_pull_${Date.now()}.db`;
  const mode = await accessModeFor(pkg);
  const s = getState(pkg);
  if (mode === "run-as") {
    await adbShell(`run-as ${pkg} cat "${resolved}" > ${stage}`).catch(async () => {
      await adbShell(`cp "${s.appDataDir}/${resolved}" ${stage}`);
    });
  } else if (mode === "root") {
    // Root: copy out via `su 0`, then make the staged file readable to adb pull.
    await adbShell(`su 0 cat "${s.appDataDir}/${resolved}" > ${stage}`);
    await adbShell(`su 0 chmod 666 ${stage}`).catch(() => { /* ignore */ });
  } else {
    await adbShell(`cp "${s.appDataDir}/${resolved}" ${stage}`);
  }
  try {
    await adb(["pull", stage, destPath], { timeout_ms: 60_000 });
    const sizeOut = await adbShell(`stat -c %s ${stage} 2>/dev/null || wc -c < ${stage}`);
    return { size: Number(sizeOut.trim()) || 0 };
  } finally {
    await adbShell(`rm -f ${stage}`).catch(() => { /* ignore */ });
  }
}

// Convenience: list tables.
export async function listTables(pkg: string, dbPath: string): Promise<string[]> {
  const rows = await sqliteQuery(
    pkg,
    dbPath,
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;",
  );
  return rows.map((r) => String(r.name));
}

// Schema for a table via PRAGMA table_info.
export async function tableSchema(
  pkg: string,
  dbPath: string,
  table: string,
): Promise<Record<string, unknown>[]> {
  // PRAGMA can be invoked through sqlite3's normal query path; the JSON output
  // mode handles it fine. Sanitize table name to identifier-safe chars.
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
    throw new Error(`Unsafe table name: ${table}`);
  }
  return sqliteQuery(pkg, dbPath, `PRAGMA table_info(${table});`);
}
