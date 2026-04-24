import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { adb, adbShell, adbSpawn } from "./adb.js";
import { ensureDevice } from "./devices.js";

// Default Appium UIAutomator2 server port (on device).
const U2_PORT = Number(process.env.ANDROID_MCP_U2_PORT ?? 6790);
const SERVER_PKG = "io.appium.uiautomator2.server";
const SERVER_TEST_PKG = "io.appium.uiautomator2.server.test";
const CACHE_DIR = process.env.ANDROID_MCP_CACHE_DIR || join(homedir(), ".android-mcp");
const APK_URL =
  process.env.ANDROID_MCP_APK_URL ||
  `${process.env.ANDROID_MCP_ENDPOINT || "https://chrome-mcp.actuallyroy.com"}/android/vendor/uiautomator2-server.apk`;
const APK_TEST_URL =
  process.env.ANDROID_MCP_APK_TEST_URL ||
  `${process.env.ANDROID_MCP_ENDPOINT || "https://chrome-mcp.actuallyroy.com"}/android/vendor/uiautomator2-server-test.apk`;

let sessionId: string | null = null;
let localPort: number | null = null;
let serverProc: import("node:child_process").ChildProcess | null = null;

function log(...args: unknown[]) {
  // eslint-disable-next-line no-console
  console.error("[android-mcp]", ...args);
}

async function pickLocalPort(): Promise<number> {
  // Simple approach: use U2_PORT locally too. Configurable via env if conflict.
  return Number(process.env.ANDROID_MCP_LOCAL_PORT ?? U2_PORT);
}

async function adbForward(local: number, remote: number) {
  await adb(["forward", `tcp:${local}`, `tcp:${remote}`]);
}

async function isPackageInstalled(pkg: string): Promise<boolean> {
  const out = await adbShell(`pm list packages ${pkg}`);
  return out.split("\n").some((l) => l.trim() === `package:${pkg}`);
}

async function cachedApk(name: string, url: string): Promise<string> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const path = join(CACHE_DIR, name);
  if (existsSync(path)) return path;
  if (process.env.ANDROID_MCP_APK_LOCAL) {
    // Power-user: point at a manually downloaded APK.
    return process.env.ANDROID_MCP_APK_LOCAL;
  }
  log(`downloading ${name} from ${url}`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Could not download ${name} from ${url} (HTTP ${res.status}). ` +
        `Set ANDROID_MCP_APK_LOCAL to point at a manually downloaded APK.`,
    );
  }
  writeFileSync(path, Buffer.from(await res.arrayBuffer()));
  return path;
}

async function ensureServerInstalled() {
  const [hasMain, hasTest] = await Promise.all([
    isPackageInstalled(SERVER_PKG),
    isPackageInstalled(SERVER_TEST_PKG),
  ]);
  if (hasMain && hasTest) return;
  log("installing UIAutomator2 server APKs…");
  if (!hasMain) {
    const apk = await cachedApk("uiautomator2-server.apk", APK_URL);
    await adb(["install", "-r", "-g", apk], { timeout_ms: 120_000 });
  }
  if (!hasTest) {
    const apk = await cachedApk("uiautomator2-server-test.apk", APK_TEST_URL);
    await adb(["install", "-r", "-g", apk], { timeout_ms: 120_000 });
  }
}

async function startServer() {
  if (serverProc && !serverProc.killed) return;
  // Kill any stale server + instrumentation from prior sessions (common source of
  // "UiAutomation not connected" on next start).
  try {
    await adbShell(`am force-stop ${SERVER_PKG}`);
    await adbShell(`am force-stop ${SERVER_TEST_PKG}`);
  } catch { /* ignore */ }
  // am instrument blocks for the duration of the test run; keep it as a background process.
  serverProc = adbSpawn([
    "shell",
    "am", "instrument",
    "-w", "-r",
    "-e", "disableAnalytics", "true",
    `${SERVER_TEST_PKG}/androidx.test.runner.AndroidJUnitRunner`,
  ]);
  serverProc.on("exit", () => { serverProc = null; });
}

async function waitForServer(timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const url = `http://127.0.0.1:${localPort}/wd/hub/status`;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (r.ok) return;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(
    `UIAutomator2 server did not respond on :${localPort} within ${timeoutMs}ms` +
      (lastErr ? ` (${(lastErr as Error).message})` : ""),
  );
}

async function createSession(): Promise<string> {
  // The Appium UIAutomator2 server accepts several body shapes across versions.
  // Try a minimal W3C shape first, then fall back to legacy desiredCapabilities.
  const attempts: unknown[] = [
    { capabilities: { firstMatch: [{}], alwaysMatch: {} } },
    { desiredCapabilities: {} },
    {
      capabilities: { firstMatch: [{}], alwaysMatch: {} },
      desiredCapabilities: {},
    },
  ];
  let lastBody = "";
  for (const body of attempts) {
    const r = await fetch(`http://127.0.0.1:${localPort}/wd/hub/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    lastBody = text;
    if (!r.ok) continue;
    let j: { value?: { sessionId?: string }; sessionId?: string };
    try { j = JSON.parse(text); } catch { continue; }
    const id = j.value?.sessionId || j.sessionId;
    if (id) return id;
  }
  throw new Error(`createSession failed. Last response: ${lastBody.slice(0, 500)}`);
}

export async function ensureSession(): Promise<string> {
  if (sessionId) return sessionId;
  await ensureDevice();
  await ensureServerInstalled();
  localPort = await pickLocalPort();
  await adbForward(localPort, U2_PORT);
  await startServer();
  await waitForServer();
  // UiAutomation finishes wiring up a bit after HTTP is ready — retry session creation.
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      sessionId = await createSession();
      log(`UIAutomator2 session ${sessionId} on local :${localPort}`);
      return sessionId;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1000 + attempt * 500));
    }
  }
  throw new Error(`createSession giving up after 6 tries: ${(lastErr as Error).message}`);
}

// Small JSON-RPC-ish helper for session-scoped endpoints.
export async function u2(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<unknown> {
  const sid = await ensureSession();
  const r = await fetch(`http://127.0.0.1:${localPort}/wd/hub/session/${sid}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let parsed: unknown = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  if (!r.ok) {
    const msg = typeof parsed === "object" && parsed && "value" in parsed ? JSON.stringify((parsed as { value: unknown }).value) : text;
    throw new Error(`u2 ${method} ${path}: HTTP ${r.status} — ${msg}`);
  }
  if (parsed && typeof parsed === "object" && "value" in (parsed as object)) {
    return (parsed as { value: unknown }).value;
  }
  return parsed;
}

export async function dumpSource(): Promise<string> {
  // UIAutomator2 returns XML here.
  const v = await u2("GET", "/source");
  return typeof v === "string" ? v : JSON.stringify(v);
}

export async function findElement(strategy: string, selector: string): Promise<string> {
  // Appium UIAutomator2 server changed the body shape — older versions accept
  // `{using, value}` (W3C-ish), v9+ expects `{strategy, selector}`. Try both.
  const bodies: Record<string, string>[] = [
    { strategy, selector },
    { using: strategy, value: selector },
  ];
  let lastErr: unknown = null;
  for (const body of bodies) {
    try {
      const v = (await u2("POST", "/element", body)) as {
        ELEMENT?: string;
        "element-6066-11e4-a52e-4f735466cecf"?: string;
      };
      const id = v?.ELEMENT || v?.["element-6066-11e4-a52e-4f735466cecf"];
      if (id) return id;
    } catch (e) {
      lastErr = e;
      continue;
    }
  }
  throw new Error(`findElement failed: ${(lastErr as Error)?.message || "unknown"}`);
}

export async function clickElement(elId: string) {
  await u2("POST", `/element/${elId}/click`, {});
}

export async function setElementValue(elId: string, value: string) {
  // Some server versions want {text}, others {value:[...]}. Send both for compat.
  await u2("POST", `/element/${elId}/value`, { text: value, value: value.split("") });
}

export async function clearElement(elId: string) {
  await u2("POST", `/element/${elId}/clear`, {});
}

export async function screenshot(): Promise<string> {
  return (await u2("GET", "/screenshot")) as string; // base64 PNG
}

export async function pressKeyCode(keycode: number) {
  await u2("POST", "/appium/device/press_keycode", { keycode });
}
