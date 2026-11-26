// Chrome-extension support: load unpacked extensions, find and drive their
// background context (MV3 service worker or MV2 background page), capture
// their logs, open popup/options pages, and read/write chrome.storage.
//
// How loading works. Google Chrome (branded) dropped `--load-extension` in
// M137. The supported replacement is the CDP `Extensions.loadUnpacked`
// command, gated behind `--enable-unsafe-extension-debugging`, which
// launchChrome passes. Everything else here is plain CDP + the extension's own
// chrome.* APIs, evaluated inside its background context, so it works on any
// Chrome that exposes the extension targets over the debug port.
//
// Listing / reload / error reports go through chrome://extensions'
// `chrome.developerPrivate` WebUI API, which we drive from a background tab we
// open and close on each call. That is the same API the extensions page uses,
// so it sees disabled extensions, idle service workers, and manifest/runtime
// errors that no target enumeration would show.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, CDPSession, Page, Target } from "puppeteer-core";
import { claimActivePage, getActivePage, getBrowser, setActivePage, withTimeout } from "./browser.js";

type RawSession = { send(method: string, params?: unknown): Promise<unknown>; on(event: string, cb: (e: never) => void): unknown };
const raw = (s: CDPSession): RawSession => s as unknown as RawSession;

const ATTACH_MS = 5_000;
const LOG_CAP = 500;

// One browser-level CDP session, reused for the whole connection. Never
// detached: puppeteer evicts a target from browser.targets() when any of its
// sessions detaches, and for the browser target that would be fatal.
let browserSession: { browser: Browser; session: CDPSession } | null = null;
async function getBrowserSession(): Promise<CDPSession> {
  const b = await getBrowser();
  if (browserSession && browserSession.browser === b) return browserSession.session;
  const session = await b.target().createCDPSession();
  browserSession = { browser: b, session };
  return session;
}

export function extensionIdFromUrl(url: string): string | null {
  const m = /^chrome-extension:\/\/([a-p]{32})\//.exec(url);
  return m ? m[1] : null;
}

function isBackgroundTarget(t: Target): boolean {
  return (t.type() === "service_worker" || t.type() === "background_page") && !!extensionIdFromUrl(t.url());
}

// ---- Log capture --------------------------------------------------------------

export type ExtLog = {
  ts: number;
  level: string;
  text: string;
  // where the message came from
  source: "service_worker" | "background_page" | "content_script";
  url: string; // target url (background) or page url (content script)
};

const logBuffers = new Map<string, ExtLog[]>();
// Extension ids we've been asked about. We only attach log capture to these:
// attaching DevTools to a service worker pins it alive and spams the buffer
// with every store extension's chatter otherwise.
const watched = new Set<string>();
// Live background sessions by extension id.
const bgSessions = new Map<string, { session: CDPSession; target: Target }>();

function pushLog(id: string, entry: ExtLog) {
  const buf = logBuffers.get(id) || [];
  buf.push(entry);
  if (buf.length > LOG_CAP) buf.splice(0, buf.length - LOG_CAP);
  logBuffers.set(id, buf);
}

type RemoteObject = { type: string; value?: unknown; description?: string; unserializableValue?: string };
function fmtArg(a: RemoteObject): string {
  if (a.value !== undefined) return typeof a.value === "string" ? a.value : JSON.stringify(a.value);
  if (a.unserializableValue) return a.unserializableValue;
  return a.description ?? a.type;
}

type ExceptionDetails = { text: string; exception?: RemoteObject; url?: string; lineNumber?: number };
function fmtException(d: ExceptionDetails): string {
  const desc = d.exception?.description || d.exception?.value;
  const where = d.url ? ` (${d.url}:${d.lineNumber ?? 0})` : "";
  return `${desc ? String(desc) : d.text}${where}`;
}

// In-flight attaches per target, so the targetcreated watcher and an explicit
// caller racing on a fresh worker share one session (two sessions = every log
// line twice).
const attaching = new WeakMap<Target, Promise<CDPSession | null>>();

async function attachBackground(target: Target): Promise<CDPSession | null> {
  const id = extensionIdFromUrl(target.url());
  if (!id) return null;
  const existing = bgSessions.get(id);
  if (existing && existing.target === target) return existing.session;
  const inflight = attaching.get(target);
  if (inflight) return inflight;
  const p = attachBackgroundNow(target, id).finally(() => attaching.delete(target));
  attaching.set(target, p);
  return p;
}

async function attachBackgroundNow(target: Target, id: string): Promise<CDPSession | null> {
  const session = await withTimeout(target.createCDPSession(), ATTACH_MS, `attach ${target.url()}`);
  const source = target.type() === "service_worker" ? "service_worker" : "background_page";
  const r = raw(session);
  r.on("Runtime.consoleAPICalled", (e: { type: string; args: RemoteObject[]; timestamp: number }) => {
    pushLog(id, { ts: Math.round(e.timestamp), level: e.type, text: e.args.map(fmtArg).join(" "), source, url: target.url() });
  });
  r.on("Runtime.exceptionThrown", (e: { timestamp: number; exceptionDetails: ExceptionDetails }) => {
    pushLog(id, { ts: Math.round(e.timestamp), level: "exception", text: fmtException(e.exceptionDetails), source, url: target.url() });
  });
  await withTimeout(r.send("Runtime.enable"), ATTACH_MS, "Runtime.enable");
  bgSessions.set(id, { session, target });
  return session;
}

// Called from getBrowser() right after connecting: capture logs for watched
// extensions as their background targets (re)appear — a reload creates a fresh
// service-worker target, and boot-time errors are the ones you most want.
export function watchExtensionTargets(browser: Browser) {
  const consider = (t: Target) => {
    if (!isBackgroundTarget(t)) return;
    const id = extensionIdFromUrl(t.url())!;
    if (!watched.has(id)) return;
    attachBackground(t).catch(() => { /* idle/paused worker; retried on demand */ });
  };
  browser.on("targetcreated", consider);
  browser.on("targetdestroyed", (t) => {
    const id = extensionIdFromUrl(t.url());
    if (id && bgSessions.get(id)?.target === t) bgSessions.delete(id);
  });
  for (const t of browser.targets()) consider(t);
}

// Content-script console. Content scripts run in an isolated world whose
// execution context reports the extension's origin, so we can tag each message
// with the extension id. The page's own (main-world) logs are left to the
// regular get_console capture. Called from attachInstrumentation per page.
export async function attachContentScriptCapture(page: Page) {
  const session = await page.createCDPSession();
  const r = raw(session);
  const contexts = new Map<number, string>(); // executionContextId -> extension id
  r.on("Runtime.executionContextCreated", (e: { context: { id: number; origin: string; auxData?: { isDefault?: boolean } } }) => {
    const id = extensionIdFromUrl(e.context.origin + "/");
    if (id && e.context.auxData?.isDefault === false) contexts.set(e.context.id, id);
  });
  r.on("Runtime.executionContextDestroyed", (e: { executionContextId: number }) => contexts.delete(e.executionContextId));
  r.on("Runtime.executionContextsCleared", () => contexts.clear());
  r.on("Runtime.consoleAPICalled", (e: { type: string; args: RemoteObject[]; timestamp: number; executionContextId: number }) => {
    const id = contexts.get(e.executionContextId);
    if (!id || !watched.has(id)) return;
    pushLog(id, { ts: Math.round(e.timestamp), level: e.type, text: e.args.map(fmtArg).join(" "), source: "content_script", url: page.url() });
  });
  r.on("Runtime.exceptionThrown", (e: { timestamp: number; exceptionDetails: ExceptionDetails & { executionContextId?: number } }) => {
    const id = e.exceptionDetails.executionContextId ? contexts.get(e.exceptionDetails.executionContextId) : undefined;
    if (!id || !watched.has(id)) return;
    pushLog(id, { ts: Math.round(e.timestamp), level: "exception", text: fmtException(e.exceptionDetails), source: "content_script", url: page.url() });
  });
  await r.send("Runtime.enable");
}

export function getExtensionLogs(id: string, opts: { clear?: boolean; level?: string[]; limit: number; source?: string[] }): ExtLog[] {
  watched.add(id);
  let list = [...(logBuffers.get(id) || [])];
  if (opts.level) list = list.filter((l) => opts.level!.includes(l.level));
  if (opts.source) list = list.filter((l) => opts.source!.includes(l.source));
  list = list.slice(-opts.limit);
  if (opts.clear) logBuffers.set(id, []);
  return list;
}

// ---- Background context ---------------------------------------------------------

function findBackgroundTarget(b: Browser, id: string): Target | undefined {
  return b.targets().find((t) => isBackgroundTarget(t) && extensionIdFromUrl(t.url()) === id);
}

// An idle MV3 service worker has no target. Any extension page calling
// chrome.runtime.sendMessage starts it; manifest.json is a URL every extension
// has, and the JSON viewer page still gets the chrome.runtime binding.
async function wakeServiceWorker(b: Browser, id: string): Promise<Target | undefined> {
  const page = await b.newPage();
  try {
    await withTimeout(page.goto(`chrome-extension://${id}/manifest.json`, { waitUntil: "domcontentloaded" }), ATTACH_MS, "open manifest.json");
    await withTimeout(
      page.evaluate(() => {
        const c = (globalThis as unknown as { chrome?: { runtime?: { sendMessage?: (m: unknown) => Promise<unknown> } } }).chrome;
        return c?.runtime?.sendMessage?.({ __chrome_mcp_wake: true })?.catch(() => undefined);
      }),
      ATTACH_MS,
      "wake sendMessage",
    ).catch(() => undefined);
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline) {
      const t = findBackgroundTarget(b, id);
      if (t) return t;
      await new Promise((r) => setTimeout(r, 150));
    }
    return undefined;
  } finally {
    await page.close().catch(() => {});
  }
}

export async function getBackgroundSession(id: string): Promise<{ session: CDPSession; target: Target }> {
  watched.add(id);
  const b = await getBrowser();
  const cached = bgSessions.get(id);
  if (cached) return cached;
  let target = findBackgroundTarget(b, id);
  if (!target) target = await wakeServiceWorker(b, id).catch(() => undefined);
  if (!target) {
    // Say precisely why: disabled (a failed reload unloads it), not installed,
    // or simply no background context declared.
    const info = (await listExtensions().catch(() => []))?.find((e) => e.id === id);
    if (!info) throw new Error(`Extension ${id} is not installed (see list_extensions; load it with load_extension).`);
    if (info.state !== "ENABLED") {
      throw new Error(
        `Extension ${id} (${info.name}) is ${info.state}. A failed reload leaves it unloaded — fix the error and reload_extension again, ` +
          `or reload_extension { enabled: true }.`,
      );
    }
    throw new Error(`Extension ${id} (${info.name}) has no background service worker / background page to evaluate in.`);
  }
  const session = await attachBackground(target);
  if (!session) throw new Error(`Could not attach to ${target.url()}`);
  return { session, target };
}

// Evaluate an expression in the extension's background context (has chrome.*
// APIs). Promises are awaited; the value is returned by value where possible.
export async function evalInBackground(id: string, expression: string, timeoutMs = 30_000): Promise<unknown> {
  const { session } = await getBackgroundSession(id);
  return flexibleEvaluate(session, expression, timeoutMs, "extension evaluate");
}

// Runtime.evaluate that accepts an expression, an expression containing
// `await`, or statements (last one returned, or an explicit `return`).
async function flexibleEvaluate(session: CDPSession, expression: string, timeoutMs: number, label: string, extra: Record<string, unknown> = {}): Promise<unknown> {
  type EvalResult = { result: RemoteObject; exceptionDetails?: ExceptionDetails };
  const run = (expr: string) =>
    withTimeout(
      // No replMode: it makes awaited promise results come back as {} with
      // returnByValue. Top-level `await` is supported by the async wrappers.
      raw(session).send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, ...extra }),
      timeoutMs,
      label,
    ) as Promise<EvalResult>;
  const isSyntax = (r: EvalResult) => r.exceptionDetails && /SyntaxError/.test(r.exceptionDetails.exception?.description || r.exceptionDetails.text || "");
  // 1. expression form (allows `await`); 2. statements with the last one
  //    returned when the code has no `return` of its own; 3. statements
  //    verbatim; 4. the raw expression.
  let res = await run(`(async () => (${expression}\n))()`);
  if (isSyntax(res) && !/\breturn\b/.test(expression)) {
    const trimmed = expression.trim().replace(/;\s*$/, "");
    const cut = Math.max(trimmed.lastIndexOf(";"), trimmed.lastIndexOf("\n"));
    if (cut > 0) res = await run(`(async () => {${trimmed.slice(0, cut + 1)}\nreturn (${trimmed.slice(cut + 1)}\n)})()`);
  }
  if (isSyntax(res)) res = await run(`(async () => {${expression}\n})()`);
  if (isSyntax(res)) res = await run(expression);
  if (res.exceptionDetails) throw new Error(fmtException(res.exceptionDetails));
  const r = res.result;
  if (r.value !== undefined) return r.value;
  if (r.unserializableValue) return r.unserializableValue;
  return r.type === "undefined" ? undefined : r.description;
}

// ---- Manifest / load ---------------------------------------------------------------

type Manifest = {
  name?: string;
  version?: string;
  manifest_version?: number;
  action?: { default_popup?: string };
  browser_action?: { default_popup?: string };
  options_page?: string;
  options_ui?: { page?: string };
  side_panel?: { default_path?: string };
  background?: { service_worker?: string; page?: string; scripts?: string[] };
  content_scripts?: unknown[];
  permissions?: string[];
  host_permissions?: string[];
};

export async function getManifest(id: string): Promise<Manifest> {
  try {
    return (await evalInBackground(id, "chrome.runtime.getManifest()")) as Manifest;
  } catch {
    // No background context (e.g. popup-only extension): read it over a page.
    const b = await getBrowser();
    const page = await b.newPage();
    try {
      await page.goto(`chrome-extension://${id}/manifest.json`, { waitUntil: "domcontentloaded" });
      return (await page.evaluate(() => fetch("manifest.json").then((r) => r.json()))) as Manifest;
    } finally {
      await page.close().catch(() => {});
    }
  }
}

export function summarizeManifest(m: Manifest) {
  return {
    name: m.name,
    version: m.version,
    manifest_version: m.manifest_version,
    background: m.background?.service_worker ? `service_worker: ${m.background.service_worker}` : m.background?.page || m.background?.scripts ? "background_page" : "none",
    popup: m.action?.default_popup ?? m.browser_action?.default_popup ?? null,
    options: m.options_ui?.page ?? m.options_page ?? null,
    side_panel: m.side_panel?.default_path ?? null,
    content_scripts: m.content_scripts?.length ?? 0,
    permissions: m.permissions ?? [],
    host_permissions: m.host_permissions ?? [],
  };
}

export async function loadUnpacked(dir: string): Promise<{ id: string; path: string; manifest: ReturnType<typeof summarizeManifest> }> {
  const path = resolve(dir);
  if (!existsSync(path)) throw new Error(`No such directory: ${path}`);
  const manifestPath = resolve(path, "manifest.json");
  if (!existsSync(manifestPath)) throw new Error(`${path} has no manifest.json — pass the extension's root directory (for a bundled extension, its build output, e.g. dist/).`);
  let manifest: Manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
  } catch (err) {
    throw new Error(`manifest.json is not valid JSON: ${(err as Error).message}`);
  }
  const b = await getBrowser();
  const session = await getBrowserSession();
  let id: string;
  try {
    const r = (await withTimeout(raw(session).send("Extensions.loadUnpacked", { path }), 15_000, "Extensions.loadUnpacked")) as { id: string };
    id = r.id;
  } catch (err) {
    const msg = (err as Error).message;
    if (/wasn't found|not found|not supported|not enabled|unsafe/i.test(msg)) {
      throw new Error(
        `Chrome refused Extensions.loadUnpacked (${msg.trim()}). Loading unpacked extensions over CDP needs Chrome started with ` +
          `--enable-unsafe-extension-debugging. chrome-mcp passes that flag when it launches Chrome itself; this Chrome was started another way. ` +
          `Quit it, then call launch_chrome (or restart it with the flag) and try again.`,
      );
    }
    throw new Error(`Extensions.loadUnpacked failed: ${msg}`);
  }
  watched.add(id);
  // Give the background target a moment to appear so boot logs get captured
  // and the attach is warm for the next call.
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline && !findBackgroundTarget(b, id)) await new Promise((r) => setTimeout(r, 100));
  const t = findBackgroundTarget(b, id);
  if (t) await attachBackground(t).catch(() => {});
  return { id, path, manifest: summarizeManifest(manifest) };
}

// ---- chrome://extensions (developerPrivate) ------------------------------------------

type DevPrivateView = { url: string; type: string; isIframe: boolean; incognito: boolean; renderProcessId: number };
type DevPrivateError = {
  type: "MANIFEST" | "RUNTIME";
  message: string;
  source: string;
  severity?: string;
  occurrences?: number;
  manifestKey?: string;
  stackTrace?: { url: string; lineNumber: number; columnNumber: number; functionName: string }[];
  contextUrl?: string;
  renderViewId?: number;
};
export type DevPrivateInfo = {
  id: string;
  name: string;
  version: string;
  description: string;
  state: string; // ENABLED | DISABLED | ...
  location: string; // UNPACKED | FROM_STORE | THIRD_PARTY | ...
  path?: string;
  manifestErrors: DevPrivateError[];
  runtimeErrors: DevPrivateError[];
  views: DevPrivateView[];
  type: string; // EXTENSION | THEME | HOSTED_APP ...
  disableReasons?: Record<string, boolean>;
  mustRemainInstalled?: boolean;
};

// Run `fn` against a chrome://extensions tab opened in the background (not
// focused, never claimed as the active tab) and close it afterwards.
async function withExtensionsPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
  const b = await getBrowser();
  const bs = await getBrowserSession();
  let page: Page | undefined;
  try {
    const { targetId } = (await raw(bs).send("Target.createTarget", { url: "chrome://extensions/", background: true })) as { targetId: string };
    const target = await b.waitForTarget((t) => (t as unknown as { _targetId?: string })._targetId === targetId, { timeout: ATTACH_MS });
    page = (await withTimeout(target.page(), ATTACH_MS, "attach chrome://extensions")) ?? undefined;
    if (!page) throw new Error("could not attach to chrome://extensions");
    await withTimeout(
      page.waitForFunction(() => typeof (globalThis as unknown as { chrome?: { developerPrivate?: unknown } }).chrome?.developerPrivate !== "undefined"),
      ATTACH_MS,
      "chrome://extensions ready",
    );
    // Bounded: a developerPrivate callback that never fires must not sit for
    // the whole protocolTimeout.
    return await withTimeout(fn(page), 10_000, "chrome://extensions call");
  } finally {
    await page?.close().catch(() => {});
  }
}

export async function listExtensions(): Promise<DevPrivateInfo[]> {
  return withExtensionsPage((page) =>
    page.evaluate(
      () =>
        new Promise<DevPrivateInfo[]>((res) =>
          (globalThis as unknown as { chrome: { developerPrivate: { getExtensionsInfo(cb: (x: DevPrivateInfo[]) => void): void } } }).chrome.developerPrivate.getExtensionsInfo(res),
        ),
    ),
  );
}

export function summarizeExtension(e: DevPrivateInfo) {
  const bg = e.views.find((v) => v.type === "EXTENSION_SERVICE_WORKER_BACKGROUND" || v.type === "EXTENSION_BACKGROUND_PAGE");
  return {
    id: e.id,
    name: e.name,
    version: e.version,
    enabled: e.state === "ENABLED",
    state: e.state,
    location: e.location,
    ...(e.path ? { path: e.path } : {}),
    background: bg ? (bg.type === "EXTENSION_SERVICE_WORKER_BACKGROUND" ? "service_worker (running)" : "background_page") : "idle or none",
    open_views: e.views.filter((v) => v !== bg).map((v) => v.url),
    manifest_errors: e.manifestErrors.length,
    runtime_errors: e.runtimeErrors.length,
    log_capture: watched.has(e.id),
  };
}

export async function ensureDeveloperMode(): Promise<void> {
  await withExtensionsPage((page) =>
    page.evaluate(
      () =>
        new Promise<void>((res) =>
          (globalThis as unknown as { chrome: { developerPrivate: { updateProfileConfiguration(c: unknown, cb: () => void): void } } }).chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }, res),
        ),
    ),
  );
}

// Reload. For an unpacked extension we re-run Extensions.loadUnpacked on its
// directory: same id, picks up every changed file, and a broken manifest or
// missing script comes back as a clean error instead of a disabled extension
// whose developerPrivate.reload callback never fires. Store/other installs
// fall back to developerPrivate.reload.
export async function reloadExtension(id: string): Promise<{ ok: boolean; error?: string; path?: string }> {
  watched.add(id);
  const info = (await listExtensions()).find((e) => e.id === id);
  if (!info) throw new Error(`No extension with id ${id} (see list_extensions)`);
  // The old background target dies with the reload; drop the stale session so
  // the next call re-attaches to the new one.
  bgSessions.delete(id);
  if (info.location === "UNPACKED" && info.path) {
    try {
      await loadUnpacked(info.path);
      return { ok: true, path: info.path };
    } catch (err) {
      return { ok: false, error: (err as Error).message.replace(/^Extensions\.loadUnpacked failed: (Protocol error \(Extensions\.loadUnpacked\): )?/, ""), path: info.path };
    }
  }
  const err = await withExtensionsPage((page) =>
    page.evaluate(
      (extId: string) =>
        new Promise<string | undefined>((res) => {
          const c = (globalThis as unknown as {
            chrome: { developerPrivate: { reload(id: string, o: unknown, cb: () => void): void }; runtime: { lastError?: { message: string } } };
          }).chrome;
          c.developerPrivate.reload(extId, { failQuietly: true }, () => res(c.runtime.lastError?.message));
        }),
      id,
    ),
  );
  return err ? { ok: false, error: err } : { ok: true };
}

export async function setExtensionEnabled(id: string, enabled: boolean): Promise<string | undefined> {
  if (!enabled) bgSessions.delete(id);
  return withExtensionsPage((page) =>
    page.evaluate(
      (extId: string, on: boolean) =>
        new Promise<string | undefined>((res) => {
          const c = (globalThis as unknown as {
            chrome: { management: { setEnabled(id: string, on: boolean, cb: () => void): void }; runtime: { lastError?: { message: string } } };
          }).chrome;
          c.management.setEnabled(extId, on, () => res(c.runtime.lastError?.message));
        }),
      id,
      enabled,
    ),
  );
}

export async function getExtensionErrors(id: string, clear: boolean): Promise<{ manifest_errors: unknown[]; runtime_errors: unknown[] }> {
  const all = await listExtensions();
  const e = all.find((x) => x.id === id);
  if (!e) throw new Error(`No extension with id ${id} (see list_extensions)`);
  const out = {
    manifest_errors: e.manifestErrors.map((m) => ({ message: m.message, source: m.source, manifest_key: m.manifestKey })),
    runtime_errors: e.runtimeErrors.map((r) => ({
      message: r.message,
      source: r.source,
      severity: r.severity,
      occurrences: r.occurrences,
      context: r.contextUrl,
      stack: (r.stackTrace || []).slice(0, 8).map((f) => `${f.functionName || "<anonymous>"} (${f.url}:${f.lineNumber}:${f.columnNumber})`),
    })),
  };
  if (clear && (e.manifestErrors.length || e.runtimeErrors.length)) {
    await withExtensionsPage((page) =>
      page.evaluate(
        (extId: string) =>
          new Promise<void>((res) =>
            (globalThis as unknown as { chrome: { developerPrivate: { deleteExtensionErrors(o: unknown, cb: () => void): void } } }).chrome.developerPrivate.deleteExtensionErrors({ extensionId: extId }, res),
          ),
        id,
      ),
    );
  }
  return out;
}

// ---- Pages -----------------------------------------------------------------------

// Run `expression` inside an extension page context (any chrome-extension://
// page of the extension) with a synthetic user gesture. Some chrome.* calls
// (sidePanel.open, action.openPopup in places) insist on one, and CDP's
// Runtime.evaluate { userGesture: true } grants it for a page target — but
// not for a service worker. We use a throwaway tab on manifest.json.
async function evalInExtensionPageWithGesture(b: Browser, id: string, expression: string): Promise<unknown> {
  const page = await b.newPage();
  try {
    await withTimeout(page.goto(`chrome-extension://${id}/manifest.json`, { waitUntil: "domcontentloaded" }), ATTACH_MS, "open extension page");
    const session = await page.createCDPSession();
    const res = (await withTimeout(
      raw(session).send("Runtime.evaluate", { expression: `(async () => (${expression}\n))()`, awaitPromise: true, returnByValue: true, userGesture: true }),
      10_000,
      "gesture evaluate",
    )) as { result: RemoteObject; exceptionDetails?: ExceptionDetails };
    if (res.exceptionDetails) throw new Error(fmtException(res.exceptionDetails));
    return res.result.value;
  } finally {
    await page.close().catch(() => {});
  }
}

// The tab chrome-mcp is currently driving, as the extension sees it
// (chrome.tabs id). Works without the "tabs" permission: we focus our page and
// ask for the active tab of the focused window.
async function activeTabIdForExtension(id: string): Promise<{ tabId: number; url: string }> {
  const page = await getActivePage();
  await page.bringToFront();
  const tabId = (await evalInBackground(id, "(await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id")) as number | undefined;
  if (typeof tabId !== "number") throw new Error("Could not resolve the active tab's id through chrome.tabs.query.");
  return { tabId, url: page.url() };
}

type ViewReport = { url: string; mode: string; note?: string; text?: string; screenshot_png_base64?: string; evaluated?: unknown };

// Snapshot (and optionally drive) a real extension view — action popup or side
// panel. Chrome announces these as type "other" and only later flips them to a
// page; puppeteer keeps the class it picked at creation, so there's no Page to
// bind as the active tab. Raw CDP still works.
async function reportView(target: Target, mode: string, note: string, evaluate?: string): Promise<ViewReport> {
  const session = await withTimeout(target.createCDPSession(), ATTACH_MS, `attach ${mode}`);
  const r = raw(session);
  let evaluated: unknown;
  if (evaluate) {
    evaluated = await flexibleEvaluate(session, evaluate, 10_000, `${mode} evaluate`, { userGesture: true });
    await new Promise((x) => setTimeout(x, 150));
  }
  const text = (await r.send("Runtime.evaluate", { expression: "document.body ? document.body.innerText : ''", returnByValue: true })) as { result: RemoteObject };
  const shot = (await r.send("Page.captureScreenshot", { format: "png" })) as { data: string };
  // Session intentionally left attached (see getBrowserSession); it dies with the view.
  return { url: target.url(), mode, note, text: String(text.result.value ?? "").slice(0, 4000), screenshot_png_base64: shot.data, ...(evaluate ? { evaluated } : {}) };
}

async function waitForNewTarget(b: Browser, before: Set<Target>, id: string, pathHint?: string): Promise<Target | undefined> {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    const t = b.targets().find(
      (x) => !before.has(x) && x.url().startsWith(`chrome-extension://${id}/`) && x.type() !== "service_worker" && (!pathHint || x.url().includes(pathHint)),
    );
    if (t) return t;
    await new Promise((r) => setTimeout(r, 100));
  }
  return undefined;
}

export async function openExtensionPage(
  id: string,
  what: string,
  mode: "tab" | "popup" | "panel",
  evaluate?: string,
): Promise<ViewReport> {
  watched.add(id);
  const b = await getBrowser();
  let rel = what;
  if (what === "popup" || what === "options" || what === "side_panel") {
    const m = await getManifest(id);
    const target =
      what === "popup" ? m.action?.default_popup ?? m.browser_action?.default_popup
      : what === "options" ? m.options_ui?.page ?? m.options_page
      : m.side_panel?.default_path;
    if (!target) throw new Error(`Extension ${id} declares no ${what} page in its manifest.`);
    rel = target;
  }
  rel = rel.replace(/^\/+/, "");
  const url = `chrome-extension://${id}/${rel}`;

  if (mode === "popup") {
    if (what !== "popup") throw new Error(`mode:"popup" only applies to the action popup; use mode:"tab" for ${what}.`);
    const existing = b.targets().find((t) => t.url() === url && t.type() !== "service_worker" && !t.url().includes("?mcp-tab"));
    const before = new Set(b.targets());
    let popup = existing;
    if (!popup) {
      await evalInBackground(id, "chrome.action ? chrome.action.openPopup() : chrome.browserAction.openPopup()");
      popup = await waitForNewTarget(b, before, id, rel);
    }
    if (!popup) throw new Error("openPopup() ran but no popup target appeared — Chrome only opens the popup when a window is focused; try mode:\"tab\".");
    return reportView(
      popup,
      "popup",
      "Real action popup, left open. Not bound as the active tab (Chrome exposes it as a non-page target): pass `evaluate` to drive it, e.g. document.querySelector('button').click(). It closes when focus moves. For the full tool set, use mode:\"tab\".",
      evaluate,
    );
  }

  if (mode === "panel") {
    if (what !== "side_panel") throw new Error(`mode:"panel" only applies to the side panel; use mode:"tab" for ${what}.`);
    let panel = b.targets().find((t) => t.url().startsWith(url) && t.type() !== "service_worker");
    if (!panel) {
      const before = new Set(b.targets());
      const { tabId } = await activeTabIdForExtension(id);
      // sidePanel.open demands a user gesture, which only a page-context
      // evaluate can carry; the service worker can't.
      await evalInExtensionPageWithGesture(b, id, `chrome.sidePanel.open({ tabId: ${tabId} })`);
      panel = await waitForNewTarget(b, before, id, rel);
    }
    if (!panel) throw new Error("sidePanel.open() ran but no side panel target appeared. Check `side_panel.default_path` in the manifest, or use mode:\"tab\".");
    return reportView(
      panel,
      "panel",
      "Real side panel, open against the active tab. Not bound as the active tab (non-page target): pass `evaluate` to drive it. It stays open across focus changes. For the full tool set, use mode:\"tab\".",
      evaluate,
    );
  }

  const page = await b.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded" });
  setActivePage(page);
  await page.bringToFront();
  await claimActivePage();
  return { url: page.url(), mode: "tab" };
}

// "Click the extension's toolbar icon" for the tab chrome-mcp is driving:
// fires chrome.action.onClicked (or browserAction) with the real Tab object,
// which is what extensions without a popup react to. Optionally inject
// files/code into that tab via chrome.scripting, the way activeTab-style
// extensions do on click. Note: a dispatched click is not a real user gesture,
// so it does NOT grant the activeTab permission — injection works when the
// extension has host_permissions for the page (or the site is already granted).
export async function activateExtension(
  id: string,
  opts: { click: boolean; inject_files?: string[]; inject_code?: string; world?: "ISOLATED" | "MAIN" },
): Promise<{ tab_id: number; url: string; clicked: boolean; injected?: unknown; warning?: string }> {
  watched.add(id);
  const { tabId, url } = await activeTabIdForExtension(id);
  const out: { tab_id: number; url: string; clicked: boolean; injected?: unknown; warning?: string } = { tab_id: tabId, url, clicked: false };
  if (opts.click) {
    const fired = await evalInBackground(
      id,
      `(async () => { const tab = await chrome.tabs.get(${tabId}); const ev = (chrome.action || chrome.browserAction).onClicked;
         if (typeof ev.dispatch !== 'function') return 'no-dispatch'; ev.dispatch(tab); return ev.hasListeners() ? 'fired' : 'no-listeners'; })()`,
    );
    if (fired === "no-dispatch") throw new Error("This Chrome's extension bindings don't expose onClicked.dispatch; use extension_evaluate to call the handler directly.");
    out.clicked = fired === "fired";
    if (fired === "no-listeners") out.warning = "The extension has no chrome.action.onClicked listener (a popup-type action?). Use open_extension_page instead.";
  }
  if (opts.inject_files?.length || opts.inject_code) {
    const target = `{ tabId: ${tabId} }`;
    const world = opts.world ? `, world: ${JSON.stringify(opts.world)}` : "";
    const expr = opts.inject_files?.length
      ? `chrome.scripting.executeScript({ target: ${target}, files: ${JSON.stringify(opts.inject_files)}${world} })`
      : `chrome.scripting.executeScript({ target: ${target}, func: new Function(${JSON.stringify(opts.inject_code)})${world} })`;
    try {
      out.injected = await evalInBackground(id, expr);
    } catch (err) {
      const msg = (err as Error).message;
      if (/Cannot access contents|host permission|activeTab/i.test(msg)) {
        throw new Error(
          `${msg}\nThe extension can't inject into ${url}: a dispatched click doesn't grant activeTab. Add a matching host_permissions entry ` +
            `(for development), or inject with chrome-mcp's own inject_script tool instead.`,
        );
      }
      throw err;
    }
  }
  return out;
}

// ---- Storage -------------------------------------------------------------------------

export async function extensionStorage(
  id: string,
  area: "local" | "sync" | "session" | "managed",
  action: "get" | "set" | "remove" | "clear",
  keys?: string[],
  values?: Record<string, unknown>,
): Promise<unknown> {
  const areaExpr = `chrome.storage.${area}`;
  switch (action) {
    case "get":
      return evalInBackground(id, `${areaExpr}.get(${keys && keys.length ? JSON.stringify(keys) : "null"})`);
    case "set":
      if (!values) throw new Error("set requires `values`");
      await evalInBackground(id, `${areaExpr}.set(${JSON.stringify(values)})`);
      return { ok: true, set: Object.keys(values) };
    case "remove":
      if (!keys || !keys.length) throw new Error("remove requires `keys`");
      await evalInBackground(id, `${areaExpr}.remove(${JSON.stringify(keys)})`);
      return { ok: true, removed: keys };
    case "clear":
      await evalInBackground(id, `${areaExpr}.clear()`);
      return { ok: true, cleared: area };
  }
}
