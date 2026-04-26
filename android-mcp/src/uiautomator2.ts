import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { adb, adbShell, adbSpawn, getActiveSerial } from "./adb.js";
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
let sessionSerial: string | null = null;

export async function teardownSession(): Promise<void> {
  // Best-effort: release HTTP session, kill instrumentation, drop port forward.
  if (sessionId && localPort) {
    try {
      await fetch(`http://127.0.0.1:${localPort}/wd/hub/session/${sessionId}`, {
        method: "DELETE",
        signal: AbortSignal.timeout(1000),
      });
    } catch { /* ignore */ }
  }
  if (serverProc && !serverProc.killed) {
    try { serverProc.kill("SIGKILL"); } catch { /* ignore */ }
  }
  if (sessionSerial && localPort) {
    try {
      await adb(["-s", sessionSerial, "forward", "--remove", `tcp:${localPort}`]);
    } catch { /* ignore */ }
  }
  sessionId = null;
  localPort = null;
  serverProc = null;
  sessionSerial = null;
}

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
  const dev = await ensureDevice();
  // If the active device changed since the session was created, the session,
  // port forward, and instrumentation are bound to the OLD device. Tear down
  // and rebuild against the new one — otherwise u2() silently talks to the
  // wrong phone.
  if (sessionId && sessionSerial && sessionSerial !== dev.serial) {
    log(`active device changed (${sessionSerial} → ${dev.serial}), rebuilding session`);
    await teardownSession();
  }
  if (sessionId) return sessionId;
  await ensureServerInstalled();
  localPort = await pickLocalPort();
  await adbForward(localPort, U2_PORT);
  await startServer();
  await waitForServer();
  sessionSerial = dev.serial;
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
  // Appium UIAutomator2 v9+ expects { strategy, selector }. Earlier versions
  // expect { using, value }. Try v9 first, log the actual response when we
  // don't find ELEMENT so we can adapt to quirks.
  const v9Body = { strategy, selector };
  try {
    const v = (await u2("POST", "/element", v9Body)) as unknown;
    const id = extractElementId(v);
    if (id) return id;
    // If the server returns a non-id shape, log it so we can debug.
    // eslint-disable-next-line no-console
    console.error("[android-mcp] findElement v9 body returned unexpected shape:", JSON.stringify(v).slice(0, 400));
  } catch (e) {
    // Fall through to legacy
    const msg = (e as Error).message || String(e);
    if (!/selector|strategy|not present/i.test(msg)) {
      // Not a field-shape error — actual "not found" or server issue. Re-throw.
      throw e;
    }
  }
  // Legacy body for older servers.
  const v = (await u2("POST", "/element", { using: strategy, value: selector })) as unknown;
  const id = extractElementId(v);
  if (id) return id;
  throw new Error(`findElement failed: ${JSON.stringify(v).slice(0, 300)}`);
}

function extractElementId(v: unknown): string | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  // Standard W3C: { "element-6066-11e4-a52e-4f735466cecf": "..." }
  const w3c = o["element-6066-11e4-a52e-4f735466cecf"];
  if (typeof w3c === "string") return w3c;
  // JSONWP: { ELEMENT: "..." }
  if (typeof o.ELEMENT === "string") return o.ELEMENT;
  // Some servers nest the element id inside a wrapper
  if (typeof o.value === "object" && o.value != null) return extractElementId(o.value);
  return null;
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

/**
 * Detects and dismisses React Native LogBox dev overlays — both the full-screen
 * stack-trace view (has "Dismiss" + "Minimize" buttons) and the minimized badges
 * that stack at the bottom of the screen. Called automatically before every
 * interactive tool so dev warnings can't block automation.
 *
 * Returns the number of overlays dismissed (0 if none).
 */
// Signatures that indicate a React Native LogBox badge (we want to dismiss these).
const DEV_BADGE_SIGNALS = [
  "[MIXPANEL",
  "[NOTIFICATION",
  "[StartDay]",
  "[StoreDetailsScreen]",
  "StoreService",
  "getProductsUnified",
  "Encountered two children",
  "Warning:",
  "unhandled promise rejection",
  "Possible unhandled",
  "Failed to send",
  "Failed to fetch",
  "AxiosError",
  "Network Error",
  "Non-serializable values",
  "❌",
  "⚠️",
];

// A content-desc starting with "!," or a digit+comma followed by a space is a
// strong structural signal of a LogBox-style badge regardless of the message body.
function looksLikeBadgeDesc(desc: string): boolean {
  return /^(?:!|⚠️|❌|\d+)\s*,\s/.test(desc);
}

type XmlNode = {
  attrs: Record<string, string>;
  children: XmlNode[];
};

function parseXmlLite(xml: string): XmlNode | null {
  let s = xml.replace(/<\?xml[^?]*\?>/g, "").replace(/<!--[\s\S]*?-->/g, "");
  const stack: XmlNode[] = [];
  let root: XmlNode | null = null;
  const tagRe = /<\s*(\/?)([a-zA-Z_][\w.\-:]*)\s*((?:[^<>"']|"[^"]*"|'[^']*')*?)\s*(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(s))) {
    const [, slash, , attrStr, selfClose] = m;
    if (slash === "/") {
      stack.pop();
      continue;
    }
    const attrs: Record<string, string> = {};
    const attrRe = /([a-zA-Z_][\w.\-:]*)\s*=\s*"([^"]*)"/g;
    let a: RegExpExecArray | null;
    while ((a = attrRe.exec(attrStr))) attrs[a[1]] = a[2];
    const node: XmlNode = { attrs, children: [] };
    if (!root) root = node;
    if (stack.length > 0) stack[stack.length - 1].children.push(node);
    if (selfClose !== "/") stack.push(node);
  }
  return root;
}

function parseBounds(s: string): { l: number; t: number; r: number; b: number } | null {
  const m = s?.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  return m ? { l: +m[1], t: +m[2], r: +m[3], b: +m[4] } : null;
}

async function tap(x: number, y: number) {
  try {
    await u2("POST", "/actions", {
      actions: [
        {
          type: "pointer",
          id: "finger1",
          parameters: { pointerType: "touch" },
          actions: [
            { type: "pointerMove", duration: 0, x, y },
            { type: "pointerDown", button: 0 },
            { type: "pause", duration: 50 },
            { type: "pointerUp", button: 0 },
          ],
        },
      ],
    });
  } catch {
    // Fallback to adb input tap.
    await adbShell(`input tap ${x} ${y}`).catch(() => {});
  }
}

/**
 * Detects and dismisses React Native LogBox dev overlays — both the full-screen
 * stack-trace view (has "Dismiss" + "Minimize" buttons) and the minimized badges
 * that stack at the bottom of the screen. Called automatically before every
 * interactive tool so dev warnings can't block automation.
 */
export async function dismissDevOverlay(): Promise<{
  full_screen: boolean;
  badges_dismissed: number;
  anr_dismissed?: boolean;
}> {
  try {
    // First: if we're staring at an Android ANR dialog ("X isn't responding"),
    // tap Wait. This is a `package="android"` system dialog, so we detect it
    // by its characteristic button ids via XPath on the /source XML.
    const xmlInitial = await dumpSource();
    if (/id\/aerr_wait/.test(xmlInitial)) {
      try {
        const elId = await findElement("id", "android:id/aerr_wait");
        await clickElement(elId);
        await new Promise((r) => setTimeout(r, 500));
      } catch { /* noop */ }
      // Re-dump since dialog dismissed; continue to process any other overlays
      // on the now-visible screen.
      return { ...(await dismissDevOverlay()), anr_dismissed: true };
    }

    const xml = xmlInitial;
    const root = parseXmlLite(xml);
    if (!root) return { full_screen: false, badges_dismissed: 0 };

    // Collect all nodes with their bounds and content-desc.
    type Match = { desc: string; bounds: { l: number; t: number; r: number; b: number } };
    const matches: Match[] = [];
    let hasMinimize = false;
    let hasDismiss = false;
    (function walk(n: XmlNode) {
      const desc = n.attrs["content-desc"] || "";
      if (desc === "Minimize") hasMinimize = true;
      if (desc === "Dismiss") hasDismiss = true;
      const b = parseBounds(n.attrs.bounds || "");
      if (
        b &&
        desc &&
        b.t >= 1800 && // Badges are pinned near the bottom; avoid false positives mid-screen.
        (DEV_BADGE_SIGNALS.some((sig) => desc.includes(sig)) || looksLikeBadgeDesc(desc))
      ) {
        matches.push({ desc, bounds: b });
      }
      for (const c of n.children) walk(c);
    })(root);

    // Full-screen LogBox: Dismiss + Minimize both present.
    if (hasMinimize && hasDismiss) {
      try {
        const elId = await findElement("accessibility id", "Minimize");
        await clickElement(elId);
      } catch {
        try {
          const elId = await findElement("accessibility id", "Dismiss");
          await clickElement(elId);
        } catch { /* noop */ }
      }
      await new Promise((r) => setTimeout(r, 300));
      const recurse = await dismissDevOverlay();
      return { full_screen: true, badges_dismissed: recurse.badges_dismissed };
    }

    // Deduplicate by bounds (same badge can appear multiple times in the tree
    // because content-desc is set on both the outer ViewGroup and inner children).
    const uniqueByTop = new Map<string, Match>();
    for (const m2 of matches) {
      const key = `${m2.bounds.t}:${m2.bounds.b}`;
      const existing = uniqueByTop.get(key);
      if (!existing || m2.bounds.r - m2.bounds.l > existing.bounds.r - existing.bounds.l) {
        uniqueByTop.set(key, m2);
      }
    }

    let badges = 0;
    // Tap each badge's close icon in reverse order (topmost first) so
    // shifting doesn't throw coords off.
    const sorted = [...uniqueByTop.values()].sort((a, b) => b.bounds.t - a.bounds.t);
    for (const m2 of sorted) {
      // Close icon is always in the right ~60px, vertically centered on the badge.
      const x = m2.bounds.r - 60;
      const y = Math.round((m2.bounds.t + m2.bounds.b) / 2);
      await tap(x, y);
      badges++;
      await new Promise((r) => setTimeout(r, 200));
    }

    return { full_screen: false, badges_dismissed: badges };
  } catch {
    return { full_screen: false, badges_dismissed: 0 };
  }
}
