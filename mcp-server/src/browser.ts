import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import puppeteer, { Browser, Page } from "puppeteer-core";
import { INSTRUMENTATION_SCRIPT } from "./instrumentation.js";

const DEFAULT_PORT = Number(process.env.CHROME_DEBUG_PORT ?? 9222);
const DEFAULT_HOST = process.env.CHROME_DEBUG_HOST ?? "127.0.0.1";

let browser: Browser | null = null;
let activePage: Page | null = null;

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

async function attachInstrumentation(page: Page) {
  // Re-install on every new document so refs/toast watcher survive navigations.
  try {
    await page.evaluateOnNewDocument(INSTRUMENTATION_SCRIPT);
  } catch {
    // some CDP targets don't support this; fall back to per-call injection
  }
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
    await ensureInstrumentation(activePage);
    return activePage;
  }
  const pages = await listPages();
  if (pages.length === 0) {
    const b = await getBrowser();
    activePage = await b.newPage();
    await attachInstrumentation(activePage);
    await ensureInstrumentation(activePage);
    return activePage;
  }
  for (const p of pages) {
    try {
      const focused = await p.evaluate(() => document.hasFocus());
      if (focused) {
        activePage = p;
        await ensureInstrumentation(activePage);
        return p;
      }
    } catch {
      // page may have navigated/closed — skip
    }
  }
  activePage = pages[0];
  await ensureInstrumentation(activePage);
  return activePage;
}

export async function selectPageByIndex(index: number): Promise<Page> {
  const pages = await listPages();
  if (index < 0 || index >= pages.length) {
    throw new Error(`Tab index ${index} out of range (have ${pages.length} tabs)`);
  }
  activePage = pages[index];
  await activePage.bringToFront();
  await ensureInstrumentation(activePage);
  return activePage;
}

export async function selectPageByUrlSubstring(match: string): Promise<Page> {
  const pages = await listPages();
  const found = pages.find((p) => p.url().includes(match));
  if (!found) throw new Error(`No tab whose URL contains "${match}"`);
  activePage = found;
  await activePage.bringToFront();
  await ensureInstrumentation(activePage);
  return activePage;
}

export function setActivePage(page: Page) {
  activePage = page;
}
