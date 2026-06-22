import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Page map (Android): a per-app directed graph of the app's screens, captured
// automatically as the agent drives the device. Mirrors the chrome-mcp page map
// but identity is a *screen key* (a stable signature of the visible UI) rather
// than a URL, since Android apps — especially single-activity / React Native
// ones — have no URL. Nodes are screens; edges record how a screen was reached
// (the tap + locator). A tapped element that survives the navigation is
// persistent chrome (bottom nav / drawer) => a global, reachable-from-anywhere
// affordance; others are screen-specific. Capture is code-driven.
// ---------------------------------------------------------------------------

export type ScreenNode = {
  key: string;            // stable screen signature (node identity within an app)
  title?: string;         // human-readable label (header/title text)
  activity?: string;
  role?: string;          // list | form | detail | home | other
  landmarks?: { list?: boolean; inputs?: number };
  visits: number;
  first_seen: string;
  last_seen: string;
  note?: string;
};

export type ScreenEdge = {
  from: string;           // source screen key, or "*" for a global (reachable-from-anywhere) affordance
  to: string;
  via: { tool: string; locator?: Record<string, unknown> };
  scope: "global" | "local";
  source: "observed" | "manual";
  count: number;
  first_seen: string;
  last_used: string;
  note?: string;
};

export type AppMap = {
  version: 1;
  app: string;            // package name
  updated_at: string;
  nodes: Record<string, ScreenNode>;
  edges: Record<string, ScreenEdge>;
};

const ENABLED = process.env.ANDROID_MCP_PAGEMAP !== "0";
const BASE_DIR = process.env.ANDROID_MCP_PAGEMAP_DIR || join(process.cwd(), "pagemaps");

const cache = new Map<string, AppMap>();
const dirty = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function sanitize(app: string): string {
  return app.replace(/[^a-zA-Z0-9._-]/g, "_");
}
function fileFor(app: string): string {
  return join(BASE_DIR, `${sanitize(app)}.json`);
}

function load(app: string): AppMap {
  const cached = cache.get(app);
  if (cached) return cached;
  const path = fileFor(app);
  if (existsSync(path)) {
    try {
      const doc = JSON.parse(readFileSync(path, "utf8")) as AppMap;
      if (doc && doc.nodes && doc.edges) {
        for (const e of Object.values(doc.edges)) {
          if (!e.scope) e.scope = "local";
          if (!e.source) e.source = "observed";
        }
        cache.set(app, doc);
        return doc;
      }
    } catch { /* corrupt — start fresh */ }
  }
  const fresh: AppMap = { version: 1, app, updated_at: new Date().toISOString(), nodes: {}, edges: {} };
  cache.set(app, fresh);
  return fresh;
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(flush, 600);
  if (typeof flushTimer.unref === "function") flushTimer.unref();
}

export function flush() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (!dirty.size) return;
  try { mkdirSync(BASE_DIR, { recursive: true }); } catch { /* ignore */ }
  for (const app of dirty) {
    const map = cache.get(app);
    if (!map) continue;
    map.updated_at = new Date().toISOString();
    try { writeFileSync(fileFor(app), JSON.stringify(map, null, 2), "utf8"); } catch { /* best-effort */ }
  }
  dirty.clear();
}

function viaSig(tool: string, locator?: Record<string, unknown>): string {
  if (!locator) return tool;
  return `${tool}${locator.text ?? ""}${locator.desc ?? ""}${locator.id ?? ""}`;
}
function edgeKey(from: string, to: string, via: { tool: string; locator?: Record<string, unknown> }): string {
  return `${from} ${to} ${viaSig(via.tool, via.locator)}`;
}

// Keep only the replayable parts of a locator (refs are unstable across dumps).
export function cleanLocator(args: unknown): Record<string, unknown> | undefined {
  if (!args || typeof args !== "object") return undefined;
  const a = args as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of ["text", "desc", "id", "xpath", "class", "selector"]) {
    if (typeof a[k] === "string" && a[k]) out[k] = a[k];
  }
  return Object.keys(out).length ? out : undefined;
}

function guessRole(node: Partial<ScreenNode>): string {
  const t = (node.title || "").toLowerCase();
  if (node.landmarks?.inputs && node.landmarks.inputs >= 2) return "form";
  if (/login|sign in|sign up/.test(t)) return "auth";
  if (/home|dashboard/.test(t)) return "home";
  if (node.landmarks?.list) return "list";
  return "other";
}

function upsertNode(map: AppMap, key: string, now: string, meta?: Partial<ScreenNode>): void {
  const existing = map.nodes[key];
  const node: ScreenNode = existing ?? { key, visits: 0, first_seen: now, last_seen: now };
  node.last_seen = now;
  node.visits += 1;
  if (meta?.title) node.title = meta.title;
  if (meta?.activity) node.activity = meta.activity;
  if (meta?.landmarks) node.landmarks = meta.landmarks;
  node.role = guessRole(node);
  map.nodes[key] = node;
}

function addEdge(
  map: AppMap,
  from: string,
  to: string,
  via: { tool: string; locator?: Record<string, unknown> },
  now: string,
  scope: "global" | "local",
  source: "observed" | "manual" = "observed",
  note?: string,
): void {
  const ekey = edgeKey(from, to, via);
  const edge = map.edges[ekey];
  if (edge) {
    edge.count += 1;
    edge.last_used = now;
    if (source === "manual") edge.source = "manual";
    if (scope === "global") edge.scope = "global";
    if (note) edge.note = note;
  } else {
    map.edges[ekey] = { from, to, via, scope, source, count: 1, first_seen: now, last_used: now, ...(note ? { note } : {}) };
  }
}

// The screen the agent is currently on (for route()'s "from").
let lastApp: string | null = null;
let lastKey: string | null = null;

export type Signature = {
  app: string;
  activity?: string;
  key: string;
  title?: string;
  landmarks?: { list?: boolean; inputs?: number };
};

function seedNode(map: AppMap, sig: Signature, now: string): void {
  upsertNode(map, sig.key, now, { title: sig.title, activity: sig.activity, landmarks: sig.landmarks });
}

// Called from the central tool dispatch after an interactive tool runs, with the
// screen signatures captured just before and just after the action. If the
// screen changed, record the source/destination nodes and the connecting edge.
export function recordTransition(opts: {
  tool: string;
  args: unknown;
  ok: boolean;
  before: Signature | null;
  after: Signature | null;
  persisted: boolean; // did the tapped element survive onto the new screen?
}): void {
  if (!ENABLED || !opts.ok || !opts.after || !opts.after.key) return;
  const after = opts.after;
  const app = after.app;
  const now = new Date().toISOString();
  const map = load(app);

  // Always learn the destination screen.
  seedNode(map, after, now);
  lastApp = app;
  lastKey = after.key;

  const before = opts.before;
  if (before && before.app === app && before.key && before.key !== after.key) {
    seedNode(map, before, now); // make sure the source screen exists too
    const locator = cleanLocator(opts.args);
    // A tapped element that persists onto the new screen is global chrome
    // (bottom nav / drawer / tab): reachable from anywhere => "* -> to".
    const scope: "global" | "local" = opts.persisted ? "global" : "local";
    const from = opts.persisted ? "*" : before.key;
    addEdge(map, from, after.key, { tool: opts.tool, ...(locator ? { locator } : {}) }, now, scope);
  }

  dirty.add(app);
  scheduleFlush();
}

// ---------------------------------------------------------------------------
// Read side
// ---------------------------------------------------------------------------

export function listApps(): string[] {
  const apps = new Set<string>(cache.keys());
  try {
    for (const f of readdirSync(BASE_DIR)) {
      if (f.endsWith(".json")) {
        try {
          const doc = JSON.parse(readFileSync(join(BASE_DIR, f), "utf8")) as AppMap;
          if (doc?.app) apps.add(doc.app);
        } catch { /* skip */ }
      }
    }
  } catch { /* no dir yet */ }
  return Array.from(apps);
}

export function getMap(app: string): AppMap {
  return load(app);
}

export function currentScreenKey(): string | null {
  return lastKey;
}

export function findNode(app: string, target: string): ScreenNode | null {
  const map = load(app);
  const t = target.toLowerCase();
  return Object.values(map.nodes).find(
    (n) => n.key.toLowerCase().includes(t) || (n.title || "").toLowerCase().includes(t),
  ) ?? null;
}

// BFS shortest route. Global edges (from "*") are reachable from any screen.
export function findRoute(app: string, fromKey: string, target: string): ScreenEdge[] | null {
  const map = load(app);
  const t = target.toLowerCase();
  const matches = (key: string): boolean => {
    if (key.toLowerCase().includes(t)) return true;
    const n = map.nodes[key];
    return !!n && (n.title || "").toLowerCase().includes(t);
  };
  const globals = Object.values(map.edges).filter((e) => e.scope === "global");
  const rank = (e: ScreenEdge) => (e.via.locator ? 0 : 1);
  const neighbors = (cur: string): ScreenEdge[] =>
    [...Object.values(map.edges).filter((e) => e.from === cur), ...globals].sort((x, y) => rank(x) - rank(y));
  const queue: string[] = [fromKey];
  const prev = new Map<string, { edge: ScreenEdge; parent: string }>();
  const seen = new Set<string>([fromKey]);
  while (queue.length) {
    const cur = queue.shift()!;
    if (cur !== fromKey && matches(cur)) {
      const path: ScreenEdge[] = [];
      let k = cur;
      while (prev.has(k)) { const { edge, parent } = prev.get(k)!; path.unshift(edge); k = parent; }
      return path;
    }
    for (const e of neighbors(cur)) {
      if (e.to !== cur && !seen.has(e.to)) { seen.add(e.to); prev.set(e.to, { edge: e, parent: cur }); queue.push(e.to); }
    }
  }
  return null;
}

export function renderMap(app: string): string {
  const map = load(app);
  const nodes = Object.values(map.nodes);
  const edges = Object.values(map.edges);
  if (!nodes.length) return `(no screens mapped yet for ${app})`;

  const label = (key: string): string => {
    const n = map.nodes[key];
    const title = n?.title ? `"${n.title}"` : key.slice(0, 10);
    const role = n?.role ? ` (${n.role})` : "";
    return `${title}${role}`;
  };
  const lab = (loc?: Record<string, unknown>): string => {
    if (!loc) return "";
    const v = loc.text ?? loc.desc ?? loc.id;
    return v ? ` ["${v}"]` : "";
  };
  const tag = (e: ScreenEdge): string => (e.source === "manual" ? " ✎" : "");

  const lines: string[] = [];
  lines.push(`APP MAP  ${app}`);
  lines.push(`${nodes.length} screens · ${edges.length} links · updated ${map.updated_at}`);
  lines.push("");

  const globals = edges.filter((e) => e.scope === "global");
  if (globals.length) {
    lines.push(`GLOBAL NAV (reachable from ANY screen):`);
    for (const e of globals) lines.push(`  ✱ ──${e.via.tool}${lab(e.via.locator)}──▶ ${label(e.to)}${tag(e)}`);
    lines.push("");
  }
  const locals = edges.filter((e) => e.scope === "local");
  if (locals.length) {
    lines.push(`LOCAL LINKS (screen-specific):`);
    const byFrom = new Map<string, ScreenEdge[]>();
    for (const e of locals) (byFrom.get(e.from) ?? byFrom.set(e.from, []).get(e.from)!).push(e);
    for (const [from, es] of byFrom) {
      lines.push(`  ${label(from)}`);
      for (const e of es) lines.push(`    └─${e.via.tool}${lab(e.via.locator)}──▶ ${label(e.to)}${tag(e)}`);
    }
    lines.push("");
  }
  const linked = new Set(edges.map((e) => e.to));
  const orphans = nodes.filter((n) => !linked.has(n.key) && !edges.some((e) => e.from === n.key));
  if (orphans.length) {
    lines.push(`SCREENS WITH NO LINKS YET:`);
    for (const n of orphans) lines.push(`  • ${label(n.key)}`);
    lines.push("");
  }
  const noted = nodes.filter((n) => n.note);
  if (noted.length) {
    lines.push(`NOTES:`);
    for (const n of noted) lines.push(`  ${n.title || n.key.slice(0, 10)}: ${n.note}`);
  }
  lines.push("");
  lines.push(`legend: ✱ = any screen · ✎ = manually asserted · role auto-detected`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Write side — manual curation by the agent.
// ---------------------------------------------------------------------------

export function setEdgeManual(opts: {
  app: string; to: string; from?: string; locator?: Record<string, unknown>;
  tool?: string; scope?: "global" | "local"; note?: string;
}): ScreenEdge {
  const map = load(opts.app);
  const from = opts.from ?? "*";
  const scope = opts.scope ?? (from === "*" ? "global" : "local");
  const via = { tool: opts.tool ?? "click", ...(opts.locator ? { locator: opts.locator } : {}) };
  const now = new Date().toISOString();
  addEdge(map, from, opts.to, via, now, scope, "manual", opts.note);
  dirty.add(opts.app);
  scheduleFlush();
  return map.edges[edgeKey(from, opts.to, via)];
}

export function removeEdgesManual(opts: { app: string; to: string; from?: string }): number {
  const map = load(opts.app);
  let removed = 0;
  for (const [k, e] of Object.entries(map.edges)) {
    if (e.to !== opts.to) continue;
    if (opts.from !== undefined && e.from !== opts.from) continue;
    delete map.edges[k];
    removed++;
  }
  if (removed) { dirty.add(opts.app); scheduleFlush(); }
  return removed;
}

export function setNodeManual(opts: { app: string; key: string; role?: string; note?: string }): ScreenNode | null {
  const map = load(opts.app);
  const node = map.nodes[opts.key];
  if (!node) return null;
  if (opts.role) node.role = opts.role;
  if (opts.note !== undefined) node.note = opts.note;
  dirty.add(opts.app);
  scheduleFlush();
  return node;
}
