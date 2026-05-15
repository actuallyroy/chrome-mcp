import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import puppeteer, { Browser, Page } from "puppeteer-core";
import { INSTRUMENTATION_SCRIPT } from "./instrumentation.js";
import {
  SESSION_ID,
  acquireLock,
  formatOwner,
  installCleanup,
  releaseLock,
  setHeartbeatTarget,
  verifyLock,
} from "./tab-lock.js";

const DEFAULT_PORT = Number(process.env.CHROME_DEBUG_PORT ?? 9222);
const DEFAULT_HOST = process.env.CHROME_DEBUG_HOST ?? "127.0.0.1";

let browser: Browser | null = null;
let activePage: Page | null = null;
let activeTargetId: string | null = null;

export function getCdpPort(): number {
  return DEFAULT_PORT;
}

const targetIdCache = new WeakMap<Page, string>();

async function targetIdFor(page: Page): Promise<string> {
  const cached = targetIdCache.get(page);
  if (cached) return cached;
  // Prefer CDP query — `Target._targetId` is internal in puppeteer-core and
  // varies across versions. `Target.getTargetInfo` is part of the protocol.
  const cdp = await page.createCDPSession();
  try {
    const { targetInfo } = (await cdp.send("Target.getTargetInfo")) as {
      targetInfo: { targetId: string };
    };
    targetIdCache.set(page, targetInfo.targetId);
    return targetInfo.targetId;
  } finally {
    try { await cdp.detach(); } catch { /* ignore */ }
  }
}

async function claimPage(page: Page, force: boolean | "break_active" = false): Promise<void> {
  installCleanup();
  const targetId = await targetIdFor(page);
  const url = page.url();
  const result = acquireLock(DEFAULT_PORT, targetId, url, force);
  if (!result.ok) {
    if (result.reason === "active_protected") {
      throw new Error(
        `Tab is owned by an active chrome-mcp session (${formatOwner(result.owner)}). ` +
          `It's heartbeating right now — yanking it would break the other session's flow. ` +
          `If you've coordinated with the user, escalate to take_tab { force_break_active: true }. ` +
          `Otherwise wait for them to release it (~15s of inactivity), or use a different tab via select_tab.`,
      );
    }
    throw new Error(
      `Tab is locked by another chrome-mcp session (${formatOwner(result.owner)}). ` +
        `Two Claude Code sessions can't safely drive the same tab. ` +
        `Use a different tab via select_tab, or pass force=true to take_tab to override.`,
    );
  }
  // Release the previous tab's lock if we owned one, so it's free for others.
  if (activeTargetId && activeTargetId !== targetId) {
    releaseLock(DEFAULT_PORT, activeTargetId);
  }
  activeTargetId = targetId;
  setHeartbeatTarget({ port: DEFAULT_PORT, targetId });
}

export function getActiveTargetId(): string | null {
  return activeTargetId;
}

export function getSessionId(): string {
  return SESSION_ID;
}

function findChromeBinary(): string | null {
  if (process.env.CHROME_BIN && existsSync(process.env.CHROME_BIN)) {
    return process.env.CHROME_BIN;
  }
  const candidates: string[] =
    platform() === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
          "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
        ]
      : platform() === "win32"
        ? [
            join(process.env["ProgramFiles"] || "C:\\Program Files", "Google\\Chrome\\Application\\chrome.exe"),
            join(
              process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
              "Google\\Chrome\\Application\\chrome.exe",
            ),
            join(process.env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe"),
          ]
        : [
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/snap/bin/chromium",
          ];
  return candidates.find((p) => existsSync(p)) || null;
}

async function isDebugPortUp(): Promise<boolean> {
  try {
    const res = await fetch(`http://${DEFAULT_HOST}:${DEFAULT_PORT}/json/version`, {
      signal: AbortSignal.timeout(500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function launchChrome(opts: { headless?: boolean } = {}): Promise<{
  launched: boolean;
  port: number;
  profile: string;
  message: string;
}> {
  const profile =
    process.env.CHROME_USER_DATA_DIR || join(homedir(), "ChromeMCP-Profile");
  if (await isDebugPortUp()) {
    return {
      launched: false,
      port: DEFAULT_PORT,
      profile,
      message: `Chrome already listening on :${DEFAULT_PORT}`,
    };
  }
  const bin = findChromeBinary();
  if (!bin) {
    throw new Error(
      "Could not find Chrome. Set CHROME_BIN to the absolute path of your Chrome executable.",
    );
  }
  mkdirSync(profile, { recursive: true });
  const args = [
    `--remote-debugging-port=${DEFAULT_PORT}`,
    `--user-data-dir=${profile}`,
  ];
  if (opts.headless) args.push("--headless=new");
  const child = spawn(bin, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  // Wait up to ~10s for the debug port to respond.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await isDebugPortUp()) {
      return {
        launched: true,
        port: DEFAULT_PORT,
        profile,
        message: `Launched Chrome (pid ${child.pid}) with profile ${profile}`,
      };
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(
    `Spawned Chrome (pid ${child.pid}) but port ${DEFAULT_PORT} didn't come up within 10s.`,
  );
}

// Native JS dialogs (alert/confirm/prompt) block CDP — every click that triggers
// one would hang until protocolTimeout. Auto-accept by default (returns true for
// confirm, OK for alert, default-or-empty value for prompt) and record what we
// did so action tools can surface it to the agent.
type DialogEntry = {
  ts: number;
  type: string;       // alert | confirm | prompt | beforeunload
  message: string;
  action: "accepted" | "dismissed";
  returned?: string;  // for prompt
};
const dialogBuffers = new WeakMap<Page, DialogEntry[]>();
// One-shot override for the next dialog: { action: "dismiss" } makes the next
// dialog get cancelled instead of accepted. Cleared after the next dialog fires.
const nextDialogMode = new WeakMap<Page, { action: "accept" | "dismiss"; text?: string }>();

function attachDialogHandler(page: Page) {
  if (dialogBuffers.has(page)) return;
  dialogBuffers.set(page, []);
  page.on("dialog", async (dialog) => {
    const override = nextDialogMode.get(page);
    nextDialogMode.delete(page);
    const action = override?.action || "accept";
    const promptText = override?.text ?? dialog.defaultValue() ?? "";
    const entry: DialogEntry = {
      ts: Date.now(),
      type: dialog.type(),
      message: dialog.message(),
      action: action === "accept" ? "accepted" : "dismissed",
      returned: dialog.type() === "prompt" && action === "accept" ? promptText : undefined,
    };
    try {
      if (action === "accept") {
        if (dialog.type() === "prompt") await dialog.accept(promptText);
        else await dialog.accept();
      } else {
        await dialog.dismiss();
      }
    } catch { /* CDP closed, etc. */ }
    const buf = dialogBuffers.get(page) || [];
    buf.push(entry);
    if (buf.length > 200) buf.shift();
    dialogBuffers.set(page, buf);
  });
}

export function dialogsSince(page: Page, since: number): DialogEntry[] {
  return (dialogBuffers.get(page) || []).filter((d) => d.ts >= since);
}

export function armNextDialog(page: Page, action: "accept" | "dismiss", text?: string) {
  nextDialogMode.set(page, { action, text });
}

async function attachInstrumentation(page: Page) {
  // Re-install on every new document so refs/toast watcher survive navigations.
  try {
    await page.evaluateOnNewDocument(INSTRUMENTATION_SCRIPT);
  } catch {
    // some CDP targets don't support this; fall back to per-call injection
  }
  attachDialogHandler(page);
}

export async function ensureInstrumentation(page: Page) {
  const installed = await page
    .evaluate("typeof window.__mcp !== 'undefined' && window.__mcp.__installed === true")
    .catch(() => false);
  if (!installed) {
    await page.evaluate(INSTRUMENTATION_SCRIPT);
  }
}

export async function getBrowser(): Promise<Browser> {
  if (browser && browser.connected) return browser;

  const browserURL = `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;
  const autoSpawn = !/^(1|true|yes)$/i.test(process.env.CHROME_MCP_NO_AUTOSPAWN || "");
  try {
    browser = await puppeteer.connect({ browserURL, defaultViewport: null });
  } catch (firstErr) {
    if (!autoSpawn) {
      throw new Error(
        `Could not connect to Chrome at ${browserURL}. ` +
          `Launch it with --remote-debugging-port=${DEFAULT_PORT} or unset CHROME_MCP_NO_AUTOSPAWN.\n` +
          `Underlying error: ${(firstErr as Error).message}`,
      );
    }
    try {
      // eslint-disable-next-line no-console
      console.error("[chrome-mcp] debug port not up — spawning Chrome…");
      await launchChrome();
      browser = await puppeteer.connect({ browserURL, defaultViewport: null });
    } catch (err) {
      throw new Error(
        `Auto-launch failed. ${(err as Error).message}\n` +
          `You can launch Chrome manually and set CHROME_MCP_NO_AUTOSPAWN=1 to skip this path.`,
      );
    }
  }
  browser.on("disconnected", () => {
    browser = null;
    activePage = null;
    if (activeTargetId) {
      releaseLock(DEFAULT_PORT, activeTargetId);
      activeTargetId = null;
    }
    setHeartbeatTarget(null);
  });
  browser.on("targetcreated", async (target) => {
    try {
      const p = await target.page();
      if (p) await attachInstrumentation(p);
    } catch {
      // ignore
    }
  });
  for (const p of await browser.pages()) {
    await attachInstrumentation(p);
  }
  return browser;
}

export async function listPages(): Promise<Page[]> {
  const b = await getBrowser();
  const pages = await b.pages();
  return pages.filter((p) => {
    const url = p.url();
    return !url.startsWith("devtools://") && !url.startsWith("chrome-extension://");
  });
}

export async function getActivePage(): Promise<Page> {
  if (activePage && !activePage.isClosed()) {
    // Re-verify the lock — another session may have force-taken the tab.
    if (activeTargetId) {
      const v = verifyLock(DEFAULT_PORT, activeTargetId);
      if (!v.ok) {
        const ownerInfo = v.reason === "taken" && v.owner ? ` (now owned by ${formatOwner(v.owner)})` : "";
        throw new Error(
          `Lost lock on the active tab${ownerInfo}. Re-select a tab with select_tab, ` +
            `or take_tab { force: true } to reclaim it.`,
        );
      }
    }
    await ensureInstrumentation(activePage);
    return activePage;
  }
  const pages = await listPages();
  if (pages.length === 0) {
    const b = await getBrowser();
    activePage = await b.newPage();
    await attachInstrumentation(activePage);
    await ensureInstrumentation(activePage);
    await claimPage(activePage);
    return activePage;
  }
  // Prefer the focused tab, then the first un-locked tab, then page[0].
  let focused: Page | null = null;
  for (const p of pages) {
    try {
      if (await p.evaluate(() => document.hasFocus())) {
        focused = p;
        break;
      }
    } catch { /* page may have navigated/closed — skip */ }
  }
  const candidate = focused || pages[0];
  activePage = candidate;
  await ensureInstrumentation(activePage);
  await claimPage(activePage);
  return activePage;
}

export async function selectPageByIndex(index: number, force: boolean | "break_active" = false): Promise<Page> {
  const pages = await listPages();
  if (index < 0 || index >= pages.length) {
    throw new Error(`Tab index ${index} out of range (have ${pages.length} tabs)`);
  }
  activePage = pages[index];
  await activePage.bringToFront();
  await ensureInstrumentation(activePage);
  await claimPage(activePage, force);
  return activePage;
}

export async function selectPageByUrlSubstring(match: string, force: boolean | "break_active" = false): Promise<Page> {
  const pages = await listPages();
  const found = pages.find((p) => p.url().includes(match));
  if (!found) throw new Error(`No tab whose URL contains "${match}"`);
  activePage = found;
  await activePage.bringToFront();
  await ensureInstrumentation(activePage);
  await claimPage(activePage, force);
  return activePage;
}

export function setActivePage(page: Page) {
  activePage = page;
  // Caller is responsible for claimPage — kept here for back-compat.
}

export async function claimActivePage(force: boolean | "break_active" = false): Promise<void> {
  if (!activePage || activePage.isClosed()) {
    const pages = await listPages();
    if (pages.length === 0) throw new Error("No tab open to claim.");
    activePage = pages[0];
    await ensureInstrumentation(activePage);
  }
  await claimPage(activePage, force);
}
