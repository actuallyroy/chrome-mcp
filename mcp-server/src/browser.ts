import puppeteer, { Browser, Page } from "puppeteer-core";
import { INSTRUMENTATION_SCRIPT } from "./instrumentation.js";

const DEFAULT_PORT = Number(process.env.CHROME_DEBUG_PORT ?? 9222);
const DEFAULT_HOST = process.env.CHROME_DEBUG_HOST ?? "127.0.0.1";

let browser: Browser | null = null;
let activePage: Page | null = null;

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
  try {
    browser = await puppeteer.connect({
      browserURL,
      defaultViewport: null,
    });
  } catch (err) {
    throw new Error(
      `Could not connect to Chrome at ${browserURL}. ` +
        `Make sure Chrome was launched with --remote-debugging-port=${DEFAULT_PORT}. ` +
        `Run: npm run launch-chrome\n` +
        `Underlying error: ${(err as Error).message}`,
    );
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
