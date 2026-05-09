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

type PkgState = {
  runAsWorks: boolean | null;
  appDataDir: string;
  sqlite3Path: string; // resolved path to sqlite3 binary, runnable via runAs()
};

const cache = new Map<string, PkgState>();

function getState(pkg: string): PkgState {
  let s = cache.get(pkg);
  if (!s) {
    s = { runAsWorks: null, appDataDir: "", sqlite3Path: "" };
    cache.set(pkg, s);
  }
  return s;
}

export function clearSqliteCache(pkg?: string) {
  if (pkg) cache.delete(pkg);
  else cache.clear();
}

async function probeRunAs(pkg: string): Promise<void> {
  const s = getState(pkg);
  if (s.runAsWorks !== null) return;
  try {
    await adbShell(`run-as ${pkg} id`);
    s.runAsWorks = true;
    return;
  } catch { /* fall back */ }
  s.runAsWorks = false;
  try {
    const info = await adbShell(`dumpsys package ${pkg} | grep dataDir | head -1`);
    const m = info.match(/dataDir=(.+)/);
    s.appDataDir = m ? m[1].trim() : `/data/data/${pkg}`;
  } catch {
    s.appDataDir = `/data/data/${pkg}`;
  }
}

// Run a shell command as the app — uses run-as when available, otherwise
// shells into the app's data dir directly (works on rooted/emulator envs
// where /data/data/<pkg> is world-readable to shell).
export async function runAs(pkg: string, command: string): Promise<string> {
  await probeRunAs(pkg);
  const s = getState(pkg);
  if (s.runAsWorks) {
    return (await adbShell(`run-as ${pkg} ${command}`)).replace(/\r\n/g, "\n").trimEnd();
  }
  return (await adbShell(`cd ${s.appDataDir} && ${command}`)).replace(/\r\n/g, "\n").trimEnd();
}

// Find a usable sqlite3 binary. Prefers an app-local copy (so run-as can exec
// it directly), falling back to system paths.
export async function ensureSqlite3(pkg: string): Promise<string> {
  const s = getState(pkg);
  if (s.sqlite3Path) return s.sqlite3Path;

  // 1. App-local sqlite3
  try {
    const v = await runAs(pkg, "./sqlite3 -version");
    if (/^3\.\d+/.test(v.trim())) {
      s.sqlite3Path = "./sqlite3";
      return s.sqlite3Path;
    }
  } catch { /* not present */ }

  // 2. System paths — try to copy into app dir for run-as access; otherwise
  //    use the system path directly (some run-as envs reject absolute exec).
  const systemPaths = [
    "/system/bin/sqlite3",
    "/system/xbin/sqlite3",
    "/data/local/tmp/sqlite3",
  ];
  for (const p of systemPaths) {
    try {
      const v = (await adbShell(`${p} -version 2>&1`)).trim();
      if (!/^3\.\d+/.test(v)) continue;
      // Try to copy into app dir
      try {
        await runAs(pkg, `cp ${p} ./sqlite3`);
        await runAs(pkg, "chmod 755 ./sqlite3");
        const verify = (await runAs(pkg, "./sqlite3 -version")).trim();
        if (/^3\.\d+/.test(verify)) {
          s.sqlite3Path = "./sqlite3";
          return s.sqlite3Path;
        }
      } catch { /* copy failed */ }
      s.sqlite3Path = p;
      return s.sqlite3Path;
    } catch { /* not at this path */ }
  }

  // 3. Push vendored arm64 binary to /data/local/tmp and use it from there.
  const vendored = findVendoredSqlite3();
  if (vendored) {
    try {
      await adb(["push", vendored, "/data/local/tmp/sqlite3"], { timeout_ms: 30_000 });
      await adbShell("chmod 755 /data/local/tmp/sqlite3");
      const v = (await adbShell("/data/local/tmp/sqlite3 -version 2>&1")).trim();
      if (/^3\.\d+/.test(v)) {
        // Try to copy into the app dir for run-as access; otherwise use tmp directly.
        try {
          await runAs(pkg, "cp /data/local/tmp/sqlite3 ./sqlite3");
          await runAs(pkg, "chmod 755 ./sqlite3");
          const verify = (await runAs(pkg, "./sqlite3 -version")).trim();
          if (/^3\.\d+/.test(verify)) {
            s.sqlite3Path = "./sqlite3";
            return s.sqlite3Path;
          }
        } catch { /* run-as cp failed */ }
        s.sqlite3Path = "/data/local/tmp/sqlite3";
        return s.sqlite3Path;
      }
    } catch (e) {
      const msg = (e as Error).message;
      // Wrong arch (e.g. x86 emulator) — surface a clearer hint than "exec format error".
      if (/exec format|Exec format/.test(msg)) {
        throw new Error(
          "Vendored sqlite3 is arm64; this device looks like a different ABI. " +
            "Push a matching sqlite3 binary to /data/local/tmp/sqlite3 manually.",
        );
      }
    }
  }

  throw new Error(
    "sqlite3 not found on device and no vendored binary available. " +
      "Push one manually: adb push <sqlite3-binary> /data/local/tmp/sqlite3 && adb shell chmod 755 /data/local/tmp/sqlite3",
  );
}

// Get debuggable third-party packages (those run-as can attach to). Falls
// back to all third-party packages if the run-as probe finds none.
export async function listDebuggablePackages(): Promise<string[]> {
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
  await adbShell(`run-as ${pkg} cat "${resolved}" > ${stage}`).catch(async () => {
    // Non-run-as fallback: try direct cp via shell user.
    const s = getState(pkg);
    await adbShell(`cp "${s.appDataDir}/${resolved}" ${stage}`);
  });
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
