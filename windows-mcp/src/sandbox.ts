// Windows Sandbox orchestration. Drives the host-side lifecycle of an
// in-Sandbox helper process so the agent can target the sandbox via
// `target: "sandbox"` on existing tools.
//
// Flow (per session):
//   1. Resolve the sandbox payload directory (vendor-sandbox/) — env override,
//      or local checkout, or a future cache fetched from a release URL.
//   2. Create a session staging directory in %TEMP%\windows-mcp\<uuid>\
//      with a startup.cmd and a state\ subdir (becomes the ready.json sink).
//   3. Generate a .wsb that maps payload RO + staging RW + project RW/RO, and
//      whose LogonCommand runs startup.cmd.
//   4. Spawn WindowsSandbox.exe with the .wsb path. The process returns
//      immediately; the sandbox boots over ~8-15 s.
//   5. fs.watch the state\ dir for ready.json. When it appears, parse
//      {ip, port} and call setSandboxEndpoint(...) on helper.ts.
//   6. Tool calls with target: "sandbox" now flow over TCP to the in-sandbox
//      helper.
//
// Limits in v0.x:
//   - One sandbox per windows-mcp process. Re-call start_sandbox to re-spawn.
//   - Detection of "user closed the sandbox" is via TCP close on the next
//     tool call, not via process polling. Simpler; one-call latency on
//     stale detection.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, watch as fsWatch, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setSandboxEndpoint, clearSandboxEndpoint } from "./helper.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Sandboxes are adopted across MCP restarts by scanning the per-session dirs
// under %TEMP%\windows-mcp\<id>\: the in-sandbox helper writes state\ready.json
// ({ip,port}) itself, and startSandbox writes a sibling meta.json (project_dir
// etc.). A new MCP process pings each session's endpoint and adopts the live
// one — no dependency on a single global file that desyncs across reconnects.
const SESSIONS_ROOT = join(tmpdir(), "windows-mcp");

const ENDPOINT = (process.env.WINDOWS_MCP_ENDPOINT || "https://chrome-mcp.actuallyroy.com").replace(/\/$/, "");

export type SandboxOptions = {
  project_dir?: string;
  read_only?: boolean;
  helper_port?: number;
};

export type SandboxStatus = {
  active: boolean;
  session_id?: string;
  helper_endpoint?: string;
  workspace_dir?: string;
  workspace_sandbox_path?: string;
  project_dir?: string;
  project_read_only?: boolean;
  booted_at?: string;
  payload_source?: string;
};

type ActiveSandbox = {
  sessionId: string;
  sessionDir: string;
  stateDir: string;
  wsbPath: string;
  workspaceDir: string;
  projectDir?: string;
  projectReadOnly: boolean;
  helperPort: number;
  payloadSource: string;
  bootedAt: string;
  ip?: string;
  watcher?: ReturnType<typeof fsWatch>;
};

// Global writable workspace mounted at C:\work in every sandbox. Default is a
// discoverable top-level folder in the user's home; overridable via env.
function resolveWorkspaceDir(): string {
  const env = process.env.WINDOWS_MCP_SANDBOX_WORKSPACE;
  return env && env.trim() ? resolve(env) : join(homedir(), "windows-mcp-workspace");
}

// The host-side workspace folder, mounted live at C:\work inside the sandbox.
// Other modules (the install tool) drop files here so they appear in the
// running sandbox without a remount.
export function workspaceHostDir(): string {
  return resolveWorkspaceDir();
}
export const WORKSPACE_SANDBOX_PATH = "C:\\work";

let current: ActiveSandbox | null = null;
let bootInFlight: Promise<SandboxStatus> | null = null;

// ---- payload resolution --------------------------------------------------

// vendor-sandbox is the directory produced by `scripts/build-helper.ps1 -Sandbox`.
// At runtime, look in (preferred → fallback) order:
//   1. WINDOWS_MCP_SANDBOX_PAYLOAD (absolute path) — explicit override (local dev)
//   2. ~/.windows-mcp/sandbox-payload/<version>/    — previously downloaded
//   3. <repo>/windows-mcp/vendor-sandbox            — local checkout
//   4. download manifest.sandbox_bundle.url, verify SHA, extract → (2)
//   5. throw with an actionable error
const CACHE_ROOT = join(homedir(), ".windows-mcp", "sandbox-payload");

async function resolveSandboxPayload(): Promise<string> {
  const envOverride = process.env.WINDOWS_MCP_SANDBOX_PAYLOAD;
  if (envOverride && existsSync(join(envOverride, "windows-mcp-helper.exe"))) {
    return resolve(envOverride);
  }
  const cached = newestCachedPayload();
  if (cached) return cached;

  const localCheckouts = [
    join(__dirname, "..", "vendor-sandbox"),
    join(__dirname, "..", "..", "vendor-sandbox"),
  ];
  for (const p of localCheckouts) {
    if (existsSync(join(p, "windows-mcp-helper.exe"))) return resolve(p);
  }

  // Nothing local — download from the manifest's sandbox_bundle URL. This is
  // the path a pasted one-line install takes on first start_sandbox.
  return downloadSandboxPayload();
}

function newestCachedPayload(): string | null {
  if (!existsSync(CACHE_ROOT)) return null;
  try {
    const versions = readdirSync(CACHE_ROOT)
      .filter((v) => existsSync(join(CACHE_ROOT, v, "windows-mcp-helper.exe")))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    return versions[0] ? join(CACHE_ROOT, versions[0]) : null;
  } catch { return null; }
}

async function downloadSandboxPayload(): Promise<string> {
  let manifest: { version: string; sandbox_bundle?: { url: string; sha256: string; size_bytes: number } };
  try {
    const res = await fetch(`${ENDPOINT}/windows/bundle/manifest.json`, { headers: { "user-agent": "windows-mcp/sandbox" } });
    if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);
    manifest = await res.json() as typeof manifest;
  } catch (e) {
    throw new Error(
      `Sandbox payload not found locally and manifest fetch from ${ENDPOINT} failed (${(e as Error).message}). ` +
      "Set $env:WINDOWS_MCP_SANDBOX_PAYLOAD to a vendor-sandbox/ path, or check connectivity.",
    );
  }
  const sb = manifest.sandbox_bundle;
  if (!sb?.url) {
    throw new Error(`manifest has no sandbox_bundle — the deployed build didn't ship a sandbox payload.`);
  }
  const url = sb.url.startsWith("http") ? sb.url : `${ENDPOINT}${sb.url}`;
  log(`downloading sandbox payload v${manifest.version} from ${url} (${(sb.size_bytes / 1024 / 1024).toFixed(0)} MB)…`);

  const res = await fetch(url, { headers: { "user-agent": "windows-mcp/sandbox" } });
  if (!res.ok) throw new Error(`sandbox bundle HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== sb.sha256) {
    throw new Error(`sandbox bundle SHA-256 mismatch. Expected ${sb.sha256}, got ${actual}.`);
  }

  // Stage zip, extract via PowerShell Expand-Archive (no npm zip dep), then
  // atomically rename the extract dir into the version cache.
  mkdirSync(CACHE_ROOT, { recursive: true });
  const zipPath = join(CACHE_ROOT, `dl-${manifest.version}.zip`);
  const tmpExtract = join(CACHE_ROOT, `.extract-${Date.now()}`);
  const finalDir = join(CACHE_ROOT, manifest.version);
  writeFileSync(zipPath, bytes);
  if (existsSync(tmpExtract)) rmSync(tmpExtract, { recursive: true, force: true });
  const ps = spawnSync("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
    `Expand-Archive -Force -Path '${zipPath}' -DestinationPath '${tmpExtract}'`,
  ], { stdio: "ignore" });
  if (ps.status !== 0 || !existsSync(join(tmpExtract, "windows-mcp-helper.exe"))) {
    throw new Error(`Expand-Archive failed (exit ${ps.status}) — sandbox payload not extracted`);
  }
  if (existsSync(finalDir)) rmSync(finalDir, { recursive: true, force: true });
  renameSync(tmpExtract, finalDir);
  try { rmSync(zipPath, { force: true }); } catch { /* ignore */ }
  log(`sandbox payload cached at ${finalDir}`);
  return finalDir;
}

// ---- .wsb generation -----------------------------------------------------

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function generateWsb(args: {
  payloadDir: string;
  sessionDir: string;
  stateDir: string;
  workspaceDir: string;
  projectDir?: string;
  projectReadOnly: boolean;
  startupCmd: string;
}): string {
  const mapped: string[] = [
    // Payload (the helper exe + .NET runtime) — read-only.
    `  <MappedFolder>
    <HostFolder>${escapeXml(args.payloadDir)}</HostFolder>
    <SandboxFolder>C:\\windows-mcp</SandboxFolder>
    <ReadOnly>true</ReadOnly>
  </MappedFolder>`,
    // Per-session staging (startup.cmd lives here) — read-write so the helper
    // can also drop ready.json under state/.
    `  <MappedFolder>
    <HostFolder>${escapeXml(args.sessionDir)}</HostFolder>
    <SandboxFolder>C:\\session</SandboxFolder>
    <ReadOnly>false</ReadOnly>
  </MappedFolder>`,
    // Global writable workspace (C:\work). A stable RW drop-zone that's a live
    // bind-mount: anything the host drops into workspaceDir appears instantly
    // inside the running sandbox (build outputs, installers, copied assets).
    // This is where the dev loop lands — build on host, run from C:\work.
    `  <MappedFolder>
    <HostFolder>${escapeXml(args.workspaceDir)}</HostFolder>
    <SandboxFolder>C:\\work</SandboxFolder>
    <ReadOnly>false</ReadOnly>
  </MappedFolder>`,
  ];
  if (args.projectDir) {
    mapped.push(
      `  <MappedFolder>
    <HostFolder>${escapeXml(args.projectDir)}</HostFolder>
    <SandboxFolder>C:\\proj</SandboxFolder>
    <ReadOnly>${args.projectReadOnly ? "true" : "false"}</ReadOnly>
  </MappedFolder>`,
    );
  }

  return `<Configuration>
  <Networking>Enable</Networking>
  <ClipboardRedirection>Enable</ClipboardRedirection>
  <vGPU>Enable</vGPU>
  <MappedFolders>
${mapped.join("\n")}
  </MappedFolders>
  <LogonCommand>
    <Command>${escapeXml(args.startupCmd)}</Command>
  </LogonCommand>
</Configuration>
`;
}

// ---- session staging -----------------------------------------------------

function freshSessionId(): string {
  // Short opaque ID — enough to disambiguate, short enough for a folder name.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function buildStartupCmd(helperPort: number): string {
  // Runs inside the sandbox. Steps:
  //  1. Open the helper's TCP port in Windows Firewall. A fresh sandbox puts
  //     unknown networks on the Public profile, which blocks all unsolicited
  //     inbound TCP — so the host can't reach our helper without this rule.
  //     We allow specifically port `helperPort` rather than disable the
  //     firewall wholesale.
  //  2. `start "title"` backgrounds the helper process so LogonCommand can
  //     return. The first quoted arg is consumed by cmd.exe as the new
  //     console's title.
  //  3. Helper writes its ready file to C:\session\state\ready.json — a
  //     sandbox path that maps back to <sessionDir>/state on the host via
  //     the C:\session MappedFolder (RW).
  return [
    "@echo off",
    "if not exist C:\\session\\state mkdir C:\\session\\state",
    `netsh advfirewall firewall add rule name="windows-mcp-helper-${helperPort}" dir=in action=allow protocol=TCP localport=${helperPort} >NUL`,
    `start "wmcp-helper" "C:\\windows-mcp\\windows-mcp-helper.exe" --listen tcp:0.0.0.0:${helperPort} --ready-file C:\\session\\state\\ready.json`,
  ].join("\r\n");
}

// ---- public API ----------------------------------------------------------

export async function startSandbox(opts: SandboxOptions = {}): Promise<SandboxStatus> {
  if (process.platform !== "win32") {
    throw new Error(`startSandbox: Windows Sandbox only runs on Windows (current: ${process.platform})`);
  }
  if (bootInFlight) {
    // Caller raced another boot — return its eventual result.
    return bootInFlight;
  }

  // Non-destructive: a sandbox can only run one instance, and we never
  // force-close (that wedges the Sandbox service). So if one is already
  // running, prefer to ADOPT + reuse it rather than replace it. Adopt first
  // (populates `current` from a live session) so a fresh MCP process also
  // reuses instead of colliding.
  if (!current) { try { await adoptExistingSandbox(); } catch { /* fall through to spawn */ } }
  if (current) {
    const want = opts.project_dir ? resolve(opts.project_dir) : current.projectDir;
    const sameMount = !opts.project_dir
      || (current.projectDir != null && resolve(current.projectDir) === want);
    if (sameMount) {
      log(`start_sandbox: reusing the already-running sandbox ${current.sessionId}`);
      return status();
    }
    // A different project_dir was requested. We can't swap the mount without
    // closing the running sandbox, and we won't force-close it. Tell the user.
    throw new Error(
      `A sandbox is already running mounted at "${current.projectDir ?? "(default)"}" (C:\\proj). ` +
      `To remount "${want}", close the sandbox window first (X, confirm the discard prompt), then call start_sandbox again. ` +
      `I won't force-close it — force-killing Windows Sandbox wedges its service until the host reboots. ` +
      `(The C:\\work workspace is always mounted regardless, if you just need a writable drop-zone.)`,
    );
  }

  bootInFlight = (async () => {
    const helperPort = opts.helper_port ?? 9335;
    const payloadSource = await resolveSandboxPayload();

    const sessionId = freshSessionId();
    const sessionDir = join(SESSIONS_ROOT, sessionId);
    const stateDir = join(sessionDir, "state");
    mkdirSync(stateDir, { recursive: true });

    const startupCmdPath = join(sessionDir, "startup.cmd");
    writeFileSync(startupCmdPath, buildStartupCmd(helperPort), { encoding: "utf8" });

    // Always-present writable workspace, mounted at C:\work.
    const workspaceDir = resolveWorkspaceDir();
    mkdirSync(workspaceDir, { recursive: true });

    const projectDir = opts.project_dir ? resolve(opts.project_dir) : undefined;
    if (projectDir && !existsSync(projectDir)) {
      throw new Error(`project_dir does not exist: ${projectDir}`);
    }

    const wsbPath = join(sessionDir, "session.wsb");
    const wsb = generateWsb({
      payloadDir: payloadSource,
      sessionDir,
      stateDir, // tracked separately for ready.json watch
      workspaceDir,
      projectDir,
      projectReadOnly: opts.read_only ?? true,
      startupCmd: "cmd.exe /c C:\\session\\startup.cmd",
    });
    writeFileSync(wsbPath, wsb, { encoding: "utf8" });

    const bootedAt = new Date().toISOString();

    // Windows Sandbox allows only ONE running instance. If one is already up
    // (e.g. an orphan from a previous session that we couldn't adopt — no
    // active record, or it stopped responding), spawning a second pops a
    // blocking "Only one running instance of Windows Sandbox is allowed"
    // dialog. Pre-empt it: recycle any running sandbox before we spawn.
    // (The adopt path in index.ts already runs first, so reaching here means
    // there's nothing adoptable.)
    assertNoConflictingSandbox();

    log(`launching WindowsSandbox.exe with ${wsbPath} (payload: ${payloadSource})`);

    const child = spawn("WindowsSandbox.exe", [wsbPath], {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.on("error", (err) => {
      const msg = err.message.includes("ENOENT")
        ? "WindowsSandbox.exe not found. Windows Sandbox feature isn't installed — enable it via " +
          "'Turn Windows features on or off' (requires Win10/11 Pro / Enterprise / Education)."
        : `WindowsSandbox.exe spawn failed: ${err.message}`;
      log(`error: ${msg}`);
      // Don't throw — orchestration may still recover if the user fixes it.
    });
    child.unref();

    current = {
      sessionId,
      sessionDir,
      stateDir,
      wsbPath,
      workspaceDir,
      projectDir,
      projectReadOnly: opts.read_only ?? true,
      helperPort,
      payloadSource,
      bootedAt,
    };

    // Watch the state dir for ready.json. fs.watch fires on .tmp rename → real
    // name; filter by exact name. Timeout 60 s — cold start is 8-15 s normally
    // but first-ever boot loads Sandbox base image which can take longer.
    try {
      await watchForReadyFile(stateDir, "ready.json", 60_000).then((readyPath) => {
        const payload = JSON.parse(readFileSync(readyPath, "utf8")) as { ip: string; port: number };
        if (!current) return; // stopSandbox raced us
        current.ip = payload.ip;
        setSandboxEndpoint(payload.ip, payload.port);
        writeSessionMeta(current);
        log(`sandbox ready at tcp://${payload.ip}:${payload.port}`);
      });
    } catch (err) {
      log(`ready watch failed: ${(err as Error).message}`);
      try { await stopSandbox(); } catch { /* ignore */ }
      throw err;
    }

    return status();
  })();

  try { return await bootInFlight; }
  finally { bootInFlight = null; }
}

export async function stopSandbox(): Promise<{ stopped: boolean; note?: string }> {
  if (!current) return { stopped: false };
  const c = current;
  current = null;
  clearSandboxEndpoint();
  try { c.watcher?.close(); } catch { /* ignore */ }
  // Request a GRACEFUL close (WM_CLOSE, no /F). Force-killing corrupts the
  // Sandbox service until reboot, so we never do that. The sandbox shows a
  // discard-confirmation dialog; the user (or a follow-up UIA click) confirms
  // it. We only guarantee our own tracking is cleared.
  let note: string | undefined;
  if (sandboxProcessRunning()) {
    try { spawnSync("taskkill", ["/IM", "WindowsSandboxClient.exe"], { stdio: "ignore" }); } catch { /* ignore */ }
    note = "Requested the sandbox window to close — confirm the discard prompt if it appears. Tracking cleared.";
  }
  // Best-effort: remove staging dir. Skipped on failure (locked files).
  try { rmSync(c.sessionDir, { recursive: true, force: true }); } catch { /* ignore */ }
  log(`sandbox session ${c.sessionId} stopped (graceful)`);
  return { stopped: true, note };
}

// Adopt a sandbox left running by a previous MCP process (e.g. the user
// restarted Claude). Scans every session dir's state/ready.json (written by
// the in-sandbox helper itself), pings each endpoint newest-first, and adopts
// the first that answers. Prunes session dirs whose endpoint is dead. No
// dependency on a single global file — robust across reconnects.
export async function adoptExistingSandbox(): Promise<boolean> {
  if (process.platform !== "win32") return false;
  if (current) return true; // already have one
  if (!existsSync(SESSIONS_ROOT)) return false;

  // Newest session first — the live one is almost always the most recent.
  const candidates = listSessionDirs().sort((a, b) => b.mtime - a.mtime);
  for (const cand of candidates) {
    const ready = readReadyFile(cand.dir);
    if (!ready) continue;
    // A live in-Hyper-V helper answers in well under 100ms; keep the probe
    // short so scanning past several dead sessions stays fast.
    const alive = await pingEndpoint(ready.ip, ready.port, 1000);
    if (!alive) {
      // Dead session — prune its staging dir so they don't pile up.
      try { rmSync(cand.dir, { recursive: true, force: true }); } catch { /* locked? leave it */ }
      continue;
    }
    const meta = readSessionMeta(cand.dir);
    current = {
      sessionId: meta?.session_id ?? cand.id,
      sessionDir: cand.dir,
      stateDir: join(cand.dir, "state"),
      wsbPath: meta?.wsb_path ?? join(cand.dir, "session.wsb"),
      workspaceDir: meta?.workspace_dir ?? resolveWorkspaceDir(),
      projectDir: meta?.project_dir,
      projectReadOnly: meta?.project_read_only ?? true,
      helperPort: ready.port,
      payloadSource: meta?.payload_source ?? "(adopted)",
      bootedAt: meta?.booted_at ?? new Date(cand.mtime).toISOString(),
      ip: ready.ip,
    };
    setSandboxEndpoint(ready.ip, ready.port);
    log(`adopted running sandbox ${current.sessionId} at tcp://${ready.ip}:${ready.port}` +
        (current.projectDir ? ` (project=${current.projectDir})` : ""));
    return true;
  }
  return false;
}

export function status(): SandboxStatus {
  if (!current) return { active: false };
  const ep = current.ip ? `tcp://${current.ip}:${current.helperPort}` : undefined;
  return {
    active: true,
    session_id: current.sessionId,
    helper_endpoint: ep,
    workspace_dir: current.workspaceDir,
    workspace_sandbox_path: "C:\\work",
    project_dir: current.projectDir,
    project_read_only: current.projectReadOnly,
    booted_at: current.bootedAt,
    payload_source: current.payloadSource,
  };
}

// Liveness-verified status: ping the helper before reporting active, so a
// dead helper (sandbox closed, ECONNRESET) is reported as inactive instead of
// a stale "active". Clears our tracking + endpoint on a dead probe so the next
// sandbox-targeted call cleanly re-adopts or re-spawns. Also tries to adopt a
// running-but-untracked sandbox so status reflects reality after a reconnect.
export async function statusVerified(): Promise<SandboxStatus> {
  if (!current) {
    try { await adoptExistingSandbox(); } catch { /* ignore */ }
    if (!current) return { active: false };
  }
  if (current.ip) {
    const alive = await pingEndpoint(current.ip, current.helperPort, 1500);
    if (!alive) {
      log(`sandbox_status: helper at ${current.ip}:${current.helperPort} not responding — marking inactive`);
      const dir = current.sessionDir;
      current = null;
      clearSandboxEndpoint();
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* locked? leave */ }
      return { active: false };
    }
  }
  return status();
}

// ---- adoption / persistence helpers --------------------------------------

// Per-session metadata, written next to state/ready.json so adopt can recover
// the project mount etc. (ready.json itself only carries ip/port).
type SessionMeta = {
  session_id: string;
  session_dir: string;
  wsb_path: string;
  workspace_dir?: string;
  project_dir?: string;
  project_read_only: boolean;
  payload_source: string;
  booted_at: string;
};

function metaPath(sessionDir: string): string { return join(sessionDir, "meta.json"); }

function writeSessionMeta(c: ActiveSandbox): void {
  try {
    const rec: SessionMeta = {
      session_id: c.sessionId,
      session_dir: c.sessionDir,
      wsb_path: c.wsbPath,
      workspace_dir: c.workspaceDir,
      project_dir: c.projectDir,
      project_read_only: c.projectReadOnly,
      payload_source: c.payloadSource,
      booted_at: c.bootedAt,
    };
    const tmp = metaPath(c.sessionDir) + ".tmp";
    writeFileSync(tmp, JSON.stringify(rec, null, 2), "utf8");
    renameSync(tmp, metaPath(c.sessionDir));
  } catch (e) {
    log(`could not persist session meta: ${(e as Error).message}`);
  }
}

function readSessionMeta(sessionDir: string): SessionMeta | null {
  try { return JSON.parse(readFileSync(metaPath(sessionDir), "utf8")) as SessionMeta; } catch { return null; }
}

function readReadyFile(sessionDir: string): { ip: string; port: number } | null {
  try {
    const r = JSON.parse(readFileSync(join(sessionDir, "state", "ready.json"), "utf8")) as { ip?: string; port?: number };
    if (r.ip && typeof r.port === "number") return { ip: r.ip, port: r.port };
  } catch { /* ignore */ }
  return null;
}

function listSessionDirs(): { id: string; dir: string; mtime: number }[] {
  const out: { id: string; dir: string; mtime: number }[] = [];
  try {
    for (const id of readdirSync(SESSIONS_ROOT)) {
      const dir = join(SESSIONS_ROOT, id);
      try {
        const st = statSync(dir);
        if (st.isDirectory()) out.push({ id, dir, mtime: st.mtimeMs });
      } catch { /* vanished */ }
    }
  } catch { /* root gone */ }
  return out;
}

// True if a Windows Sandbox window is currently running anywhere on the host.
function sandboxProcessRunning(): boolean {
  try {
    const r = spawnSync("tasklist", ["/fi", "imagename eq WindowsSandboxClient.exe", "/nh"], { encoding: "utf8" });
    return (r.stdout || "").toLowerCase().includes("windowssandboxclient.exe");
  } catch { return false; }
}

// Refuse to spawn into a conflict. We must NEVER force-kill a running
// Windows Sandbox: `taskkill /F` on WindowsSandbox* wedges the Sandbox
// service so it won't launch again until the host reboots (or vmcompute is
// restarted). So if an un-adoptable sandbox is already open, surface clear
// guidance and let the *user* close it (the close confirmation triggers a
// clean dispose). The adopt path runs before this, so reaching here means
// the running sandbox isn't one we can talk to.
function assertNoConflictingSandbox(): void {
  if (!sandboxProcessRunning()) return;
  throw new Error(
    "A Windows Sandbox window is already open, but this server can't talk to it " +
    "(it was started elsewhere, or stopped responding). Close that sandbox window " +
    "(click X, confirm the discard prompt), then retry. " +
    "I won't force-close it — force-killing Windows Sandbox corrupts its service until the host reboots.",
  );
}

// Connect + send a single ping; resolve true iff we get any newline-terminated
// response within timeoutMs. Used to validate an adopted endpoint is live.
function pingEndpoint(ip: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (ok: boolean) => { if (settled) return; settled = true; try { s.destroy(); } catch { /* ignore */ } resolve(ok); };
    const s = createConnection({ host: ip, port });
    let buf = "";
    const timer = setTimeout(() => done(false), timeoutMs);
    s.on("connect", () => { try { s.write(JSON.stringify({ id: 1, method: "ping", params: {} }) + "\n"); } catch { done(false); } });
    s.on("data", (d) => { buf += d.toString(); if (buf.includes("\n")) { clearTimeout(timer); done(buf.includes('"pong"')); } });
    s.on("error", () => { clearTimeout(timer); done(false); });
  });
}

// ---- helpers -------------------------------------------------------------

function watchForReadyFile(dir: string, filename: string, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const target = join(dir, filename);
    // Cover the race where the file already exists by the time we get here.
    if (existsSync(target)) { resolve(target); return; }
    let settled = false;
    const w = fsWatch(dir, (event, name) => {
      if (settled) return;
      if (name === filename && existsSync(target)) {
        settled = true;
        try { w.close(); } catch { /* ignore */ }
        clearTimeout(timer);
        resolve(target);
      }
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { w.close(); } catch { /* ignore */ }
      reject(new Error(`ready file did not appear within ${timeoutMs}ms — sandbox may have failed to boot`));
    }, timeoutMs);
  });
}

function log(s: string): void {
  console.error(`[windows-mcp] sandbox: ${s}`);
}
