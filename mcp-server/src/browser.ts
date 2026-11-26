import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import puppeteer, { Browser, Page } from "puppeteer-core";
import { INSTRUMENTATION_SCRIPT } from "./instrumentation.js";
import { attachContentScriptCapture, watchExtensionTargets } from "./extensions.js";
import {
  SESSION_ID,
  acquireLock,
  formatOwner,
  installCleanup,
  listFreshLocks,
  releaseLock,
  setHeartbeatTarget,
  verifyLock,
} from "./tab-lock.js";

const DEFAULT_PORT = Number(process.env.CHROME_DEBUG_PORT ?? 9222);
const DEFAULT_HOST = process.env.CHROME_DEBUG_HOST ?? "127.0.0.1";

// Issue #54: a single frozen renderer (page stuck in a `while(true)`, "Page
// Unresponsive") or a tab paused at a DevTools breakpoint used to wedge EVERY
// tool call. `browser.pages()` attaches to all page targets and the attach
// handshake (Network.enable etc.) never gets answered by a frozen/paused
// renderer; puppeteer's default protocolTimeout is 180s, longer than most MCP
// clients wait, so the agent saw an infinite hang. We now (a) bound every CDP
// command with a short protocolTimeout, (b) attach to targets in parallel with
// a per-target deadline and remember the ones that didn't answer so they're
// skipped instead of re-stalling every call, and (c) expose a page-free health
// probe (`ping`).
const PROTOCOL_TIMEOUT_MS = Number(process.env.CHROME_MCP_PROTOCOL_TIMEOUT_MS ?? 30_000);
const ATTACH_TIMEOUT_MS = Number(process.env.CHROME_MCP_ATTACH_TIMEOUT_MS ?? 5_000);
// How long an unresponsive target stays blacklisted before we try it again.
const UNRESPONSIVE_RETRY_MS = 60_000;

let browser: Browser | null = null;
let activePage: Page | null = null;
let activeTargetId: string | null = null;
const startedAt = Date.now();

export function getCdpPort(): number {
  return DEFAULT_PORT;
}

export function getBrowserURL(): string {
  return `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;
}

export function getProtocolTimeout(): number {
  return PROTOCOL_TIMEOUT_MS;
}

export class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} did not complete within ${ms}ms`);
    this.name = "TimeoutError";
  }
}

export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer)) as Promise<T>;
}

// Targets that failed to answer the attach handshake, keyed by target URL +
// the time we gave up. Surfaced by `ping` / `list_tabs` so the agent can tell
// "one tab is frozen" from "the server is wedged".
type Unresponsive = { url: string; since: number; reason: string };
const unresponsive = new Map<string, Unresponsive>();

export function getUnresponsiveTabs(): Unresponsive[] {
  return [...unresponsive.values()];
}

// DevTools frontends are never automatable. Extension pages (popup, options,
// any chrome-extension:// tab) are ordinary pages — see extensions.ts.
function isAutomatableUrl(url: string): boolean {
  return !url.startsWith("devtools://");
}

const targetIdCache = new WeakMap<Page, string>();

export async function targetIdFor(page: Page): Promise<string> {
  const cached = targetIdCache.get(page);
  if (cached) return cached;
  // puppeteer's Target carries the id; use it when present. The CDP fallback
  // deliberately does NOT detach its session: puppeteer's target manager drops
  // a target from browser.targets() when ANY session attached to it detaches
  // (ChromeTargetManager#onDetachedFromTarget), which made the tab we had just
  // claimed vanish from listPages() and the next call open a fresh about:blank.
  const internal = (page.target() as unknown as { _targetId?: string })._targetId;
  if (internal) {
    targetIdCache.set(page, internal);
    return internal;
  }
  const cdp = await page.createCDPSession();
  const { targetInfo } = (await cdp.send("Target.getTargetInfo")) as {
    targetInfo: { targetId: string };
  };
  targetIdCache.set(page, targetInfo.targetId);
  return targetInfo.targetId;
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
    // Suppress browser-native bubbles that the MCP can't see or dismiss and that
    // block the page until a human closes them. The big one: submitting a known-
    // leaked password (e.g. "password") triggers Chrome's "Change your password —
    // found in a data breach" warning, which steals focus and stalls automation.
    "--disable-features=PasswordLeakDetection,PasswordChangeInSettings,AutofillServerCommunication",
    "--disable-save-password-bubble",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-session-crashed-bubble",
    // Keep the automation tab running at full speed even when its window is
    // backgrounded/occluded behind the IDE. Without these, Chrome freezes
    // requestAnimationFrame (0 fps) and clamps timers to ~1 Hz in an unfocused
    // window, so a working smooth-scroll/rAF animation reads as "broken" and
    // timing-based logic stalls — a whole class of false-negative test reports
    // (issue #49). These disable that throttling so observations are faithful.
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    // Branded Chrome dropped --load-extension in M137; the supported path is
    // the CDP Extensions.loadUnpacked command, which this flag enables. The
    // debug port is already loopback-only full control, so nothing new is
    // exposed. Powers load_extension.
    "--enable-unsafe-extension-debugging",
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
  // Bounded: a renderer paused at a DevTools breakpoint never answers
  // Page.addScriptToEvaluateOnNewDocument (issue #54); ensureInstrumentation
  // re-injects per call anyway, so giving up here costs nothing.
  try {
    await withTimeout(page.evaluateOnNewDocument(INSTRUMENTATION_SCRIPT), ATTACH_TIMEOUT_MS, "evaluateOnNewDocument");
  } catch {
    // some CDP targets don't support this; fall back to per-call injection
  }
  attachDialogHandler(page);
  // Content-script console/exception capture for extension_logs (isolated
  // worlds are invisible to the in-page console hook).
  withTimeout(attachContentScriptCapture(page), ATTACH_TIMEOUT_MS, "content-script capture").catch(() => {});
}

export async function ensureInstrumentation(page: Page) {
  // Re-inject when __mcp is missing OR is an older build lacking a capability
  // we now depend on (here: the navigation log). Re-evaluating the script is
  // idempotent and lets already-open tabs pick up upgrades without a reload.
  // Both evaluates are bounded: a renderer paused at a DevTools breakpoint (or
  // spinning in a tight loop) never answers Runtime.evaluate, and without a
  // bound each one sat for the full protocolTimeout, back to back (issue #54).
  const url = page.url();
  const unresponsiveError = () => {
    unresponsive.set(url, { url, since: Date.now(), reason: `Runtime.evaluate did not answer within ${ATTACH_TIMEOUT_MS}ms` });
    return new Error(
      `Tab ${url} is not responding to CDP — the renderer is frozen ("Page Unresponsive") or paused at a DevTools breakpoint. ` +
        `Resume the debugger / reload or close that tab, or move to another with select_tab / new_tab. ` +
        `\`ping\` lists the tabs currently skipped as unresponsive.`,
    );
  };
  let ready = false;
  try {
    ready = (await withTimeout(
      page.evaluate(
        "typeof window.__mcp !== 'undefined' && window.__mcp.__installed === true && window.__mcp._navInstalled === true",
      ),
      ATTACH_TIMEOUT_MS,
      "instrumentation probe",
    )) as boolean;
  } catch (err) {
    if (err instanceof TimeoutError) throw unresponsiveError();
    ready = false;
  }
  if (!ready) {
    try {
      await withTimeout(page.evaluate(INSTRUMENTATION_SCRIPT), ATTACH_TIMEOUT_MS, "instrumentation inject");
    } catch (err) {
      if (err instanceof TimeoutError) throw unresponsiveError();
      throw err;
    }
  }
  unresponsive.delete(url);
}

export async function getBrowser(): Promise<Browser> {
  if (browser && browser.connected) return browser;

  const browserURL = `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;
  const autoSpawn = !/^(1|true|yes)$/i.test(process.env.CHROME_MCP_NO_AUTOSPAWN || "");
  // Skip DevTools frontends and extension pages at the connect layer so we
  // never attach to them, and bound every CDP command so a stuck renderer
  // surfaces as an error instead of an infinite hang (issue #54).
  const connectOpts = {
    browserURL,
    defaultViewport: null,
    protocolTimeout: PROTOCOL_TIMEOUT_MS,
    targetFilter: (t: { url(): string }) => isAutomatableUrl(t.url()),
  };
  try {
    browser = await puppeteer.connect(connectOpts);
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
      browser = await puppeteer.connect(connectOpts);
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
      const p = await withTimeout(target.page(), ATTACH_TIMEOUT_MS, "attach new target");
      if (p) await attachInstrumentation(p);
    } catch {
      // ignore
    }
  });
  watchExtensionTargets(browser);
  // Attach in parallel with a per-target deadline; one stuck tab must not
  // block connecting to the rest (issue #54).
  const pages = await collectPages(browser);
  await Promise.allSettled(pages.map((p) => attachInstrumentation(p)));
  return browser;
}

// `browser.pages()` is Promise.all over `target.page()` for every page target,
// so one frozen renderer stalls the whole list for protocolTimeout — on every
// call. This version races each attach against ATTACH_TIMEOUT_MS, drops the
// ones that don't answer, and remembers them so later calls skip them without
// paying the timeout again (re-probed after UNRESPONSIVE_RETRY_MS).
async function collectPages(b: Browser): Promise<Page[]> {
  const now = Date.now();
  const targets = b.targets().filter((t) => t.type() === "page" && isAutomatableUrl(t.url()));
  const results = await Promise.all(
    targets.map(async (t) => {
      const url = t.url();
      const bad = unresponsive.get(url);
      if (bad && now - bad.since < UNRESPONSIVE_RETRY_MS) return null;
      try {
        const p = await withTimeout(t.page(), ATTACH_TIMEOUT_MS, `attach ${url}`);
        unresponsive.delete(url);
        return p;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        unresponsive.set(url, { url, since: now, reason });
        // eslint-disable-next-line no-console
        console.error(`[chrome-mcp] skipping unresponsive tab ${url}: ${reason}`);
        return null;
      }
    }),
  );
  return results.filter((p): p is Page => !!p);
}

export async function listPages(): Promise<Page[]> {
  const b = await getBrowser();
  return collectPages(b);
}

// Page-free health probe for the `ping` tool: answers even when every tab is
// wedged, so an agent can tell "server/Chrome down" from "one tab is stuck".
export async function health(): Promise<{
  ok: boolean;
  session_id: string;
  debug_port: number;
  chrome: string | null;
  browser_connected: boolean;
  active_target_id: string | null;
  active_tab_url: string | null;
  unresponsive_tabs: Unresponsive[];
  uptime_ms: number;
  protocol_timeout_ms: number;
}> {
  let chrome: string | null = null;
  try {
    const res = await fetch(`http://${DEFAULT_HOST}:${DEFAULT_PORT}/json/version`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (res.ok) chrome = ((await res.json()) as { Browser?: string }).Browser ?? "unknown";
  } catch { /* port down */ }
  return {
    ok: chrome !== null,
    session_id: SESSION_ID,
    debug_port: DEFAULT_PORT,
    chrome,
    browser_connected: !!browser?.connected,
    active_target_id: activeTargetId,
    active_tab_url: activePage && !activePage.isClosed() ? activePage.url() : null,
    unresponsive_tabs: getUnresponsiveTabs(),
    uptime_ms: Date.now() - startedAt,
    protocol_timeout_ms: PROTOCOL_TIMEOUT_MS,
  };
}

// Non-launching accessor: returns the current active page only if one is
// already open. Used by passive observers (e.g. the page-map capture hook) that
// must never trigger a browser launch or tab claim as a side effect.
export function getActivePageIfReady(): Page | null {
  return activePage && !activePage.isClosed() ? activePage : null;
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
  // The previous active tab is gone and we must auto-rebind. The danger in a
  // shared profile: another session's `bringToFront` makes THEIR tab the
  // focused one, so blindly picking the focused tab would silently rebind us
  // onto someone else's tab and act on it (issue #44). So we classify every
  // candidate by lock owner and only auto-bind to a tab that's safe: one we
  // already own, or one nobody actively holds. We never silently take a tab
  // an OTHER active session holds — that requires an explicit select_tab/take_tab.
  const locks = listFreshLocks();
  const classified = await Promise.all(
    pages.map(async (p) => {
      let owner: ReturnType<typeof ownerSummary> = null;
      try {
        const tid = await targetIdFor(p);
        owner = ownerSummary(locks[`${DEFAULT_PORT}:${tid}`]);
      } catch { /* page closed mid-scan */ }
      let focused = false;
      let responsive = true;
      try {
        focused = await withTimeout(p.evaluate(() => document.hasFocus()), ATTACH_TIMEOUT_MS, "focus probe");
      } catch (err) {
        if (err instanceof TimeoutError) {
          responsive = false;
          unresponsive.set(p.url(), { url: p.url(), since: Date.now(), reason: "focus probe did not answer" });
        }
      }
      return { page: p, owner, focused, responsive };
    }),
  );
  // Never auto-bind to a tab that didn't answer the probe (issue #54).
  const mine = classified.filter((c) => c.responsive && c.owner?.mine);
  const free = classified.filter((c) => c.responsive && !c.owner);
  // Prefer a tab we already own (focused first), then a free tab (focused first).
  const pick =
    mine.find((c) => c.focused)?.page || mine[0]?.page ||
    free.find((c) => c.focused)?.page || free[0]?.page;
  if (!pick) {
    const owners = classified
      .map((c) => (c.owner && !c.owner.mine ? formatOwner(c.owner.lock) : null))
      .filter((v): v is string => !!v);
    const stuck = classified.filter((c) => !c.responsive).map((c) => c.page.url());
    throw new Error(
      `The active tab was lost and no open tab is usable: ` +
        (owners.length ? `${owners.length} owned by another chrome-mcp session (${owners.join("; ")})` : "") +
        (owners.length && stuck.length ? "; " : "") +
        (stuck.length ? `${stuck.length} not responding to CDP (frozen or paused in DevTools: ${stuck.join(", ")})` : "") +
        `. Pick one explicitly with select_tab (force/force_break_active if you've coordinated with the user), ` +
        `resume/reload the stuck tab, or open a fresh tab with new_tab.`,
    );
  }
  activePage = pick;
  await ensureInstrumentation(activePage);
  await claimPage(activePage);
  return activePage;
}

// Summarize a lock entry for ownership checks. Returns null when there's no
// (fresh) lock on the target.
function ownerSummary(lock: { session_id: string } | undefined):
  | { mine: boolean; lock: Parameters<typeof formatOwner>[0] }
  | null {
  if (!lock) return null;
  return { mine: lock.session_id === SESSION_ID, lock: lock as Parameters<typeof formatOwner>[0] };
}

// Who owns the currently-bound active tab? Powers the `get_active_tab` /
// whoami tool so an agent can assert before acting (issue #44). Read-only —
// never launches Chrome or claims a tab.
export async function whoamiActiveTab(): Promise<{
  session_id: string;
  has_active_tab: boolean;
  url?: string;
  title?: string;
  owner?: string | null;
  mine?: boolean;
}> {
  const page = getActivePageIfReady();
  if (!page || !activeTargetId) {
    return { session_id: SESSION_ID, has_active_tab: false };
  }
  const locks = listFreshLocks();
  const summary = ownerSummary(locks[`${DEFAULT_PORT}:${activeTargetId}`]);
  return {
    session_id: SESSION_ID,
    has_active_tab: true,
    url: page.url(),
    title: await page.title().catch(() => ""),
    owner: summary ? formatOwner(summary.lock) : null,
    mine: summary ? summary.mine : false,
  };
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
