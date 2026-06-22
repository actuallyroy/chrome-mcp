import { dumpSource } from "./uiautomator2.js";

// UIAutomator2 returns the tree as XML. We parse it with a minimal
// regex-free-ish parser (fast-xml-parser would be better but adds a dep; the
// tree is simple and well-formed).

export type Node = {
  tag: string;
  attrs: Record<string, string>;
  children: Node[];
};

// --- XML parser ---------------------------------------------------------

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function parseXml(xml: string): Node | null {
  // Strip prolog, comments, CDATA.
  let s = xml.replace(/<\?xml[^?]*\?>/g, "").replace(/<!--[\s\S]*?-->/g, "");
  const stack: Node[] = [];
  let root: Node | null = null;
  let i = 0;
  const tagRe = /<\s*(\/?)([a-zA-Z_][\w.\-:]*)\s*((?:[^<>"']|"[^"]*"|'[^']*')*?)\s*(\/?)>/g;
  tagRe.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(s))) {
    const [, slash, name, attrStr, selfClose] = m;
    if (slash === "/") {
      stack.pop();
      continue;
    }
    const attrs: Record<string, string> = {};
    const attrRe = /([a-zA-Z_][\w.\-:]*)\s*=\s*"([^"]*)"/g;
    let a: RegExpExecArray | null;
    while ((a = attrRe.exec(attrStr))) attrs[a[1]] = decodeXmlEntities(a[2]);
    const node: Node = { tag: name, attrs, children: [] };
    if (!root) root = node;
    if (stack.length > 0) stack[stack.length - 1].children.push(node);
    if (selfClose !== "/") stack.push(node);
  }
  return root;
}

// --- Ref registry -------------------------------------------------------

// Maps ref number → a stable "path" (series of child indices) back to the node
// in a future outline. Refs are stable across outline calls within a session,
// same as chrome-mcp.
type RefRecord = { path: number[]; sig: string };
const refRegistry = new Map<number, RefRecord>();
let nextRef = 1;

function nodeSig(n: Node): string {
  // Identity hash: class + resource-id + bounds + text.
  return [n.attrs.class, n.attrs["resource-id"], n.attrs.bounds, n.attrs.text]
    .filter(Boolean)
    .join("|");
}

function buildRefs(root: Node) {
  // Re-resolve existing refs: walk tree, match by signature; assign new refs
  // to newly visible nodes.
  const byPath: { node: Node; path: number[] }[] = [];
  function walk(node: Node, path: number[]) {
    byPath.push({ node, path });
    node.children.forEach((c, i) => walk(c, [...path, i]));
  }
  walk(root, []);

  // First pass: keep existing refs whose sig still resolves.
  const assigned = new Map<Node, number>();
  for (const [ref, rec] of refRegistry) {
    const found = byPath.find((e) => nodeSig(e.node) === rec.sig);
    if (found && !assigned.has(found.node)) {
      assigned.set(found.node, ref);
      rec.path = found.path;
    }
  }
  // Second pass: assign refs to unreferenced interactive nodes.
  for (const { node, path } of byPath) {
    if (assigned.has(node)) continue;
    if (!isInteresting(node)) continue;
    const r = nextRef++;
    refRegistry.set(r, { path, sig: nodeSig(node) });
    assigned.set(node, r);
  }
  // Attach ref as attr for rendering.
  for (const [node, ref] of assigned) node.attrs.__mcp_ref = String(ref);
}

export function resetRefs() {
  refRegistry.clear();
  nextRef = 1;
}

export function resolveRef(ref: number, root: Node): Node | null {
  const rec = refRegistry.get(ref);
  if (!rec) return null;
  let n: Node | undefined = root;
  for (const i of rec.path) {
    if (!n) return null;
    n = n.children[i];
  }
  return n || null;
}

// --- Interesting-element filter ----------------------------------------

function isInteresting(n: Node): boolean {
  const a = n.attrs;
  if (a.clickable === "true") return true;
  if (a["long-clickable"] === "true") return true;
  if (a.focusable === "true") return true;
  if (a.checkable === "true") return true;
  if (a.scrollable === "true") return true;
  if (a.password === "true") return true;
  const cls = a.class || "";
  if (/Button|EditText|CheckBox|RadioButton|Switch|Spinner|SeekBar|ImageButton|ImageView/.test(cls))
    return true;
  // TextView with non-empty text is often meaningful
  if (cls.endsWith("TextView") && (a.text || a["content-desc"])) return true;
  return false;
}

// --- Render outline -----------------------------------------------------

function shortClass(c: string): string {
  const last = c.split(".").pop() || c;
  return last;
}

function describeNode(n: Node): string {
  const a = n.attrs;
  const ref = a.__mcp_ref;
  const kind = shortClass(a.class || "View").toLowerCase();
  const meta: string[] = [];
  if (a["resource-id"]) meta.push(`id=${a["resource-id"]}`);
  if (a["content-desc"]) meta.push(`desc="${a["content-desc"]}"`);
  if (a.bounds) meta.push(`bounds=${a.bounds}`);
  if (a.checked === "true") meta.push("checked");
  if (a.enabled === "false") meta.push("disabled");
  if (a.selected === "true") meta.push("selected");
  const text = a.text ? ` "${a.text.length > 80 ? a.text.slice(0, 80) + "…" : a.text}"` : "";
  const metaStr = meta.length ? ` (${meta.join(", ")})` : "";
  return `[${kind} #${ref}]${text}${metaStr}`;
}

export async function outline(): Promise<string> {
  const xml = await dumpSource();
  const root = parseXml(xml);
  if (!root) return "(empty UI tree)";
  buildRefs(root);

  const lines: string[] = [];
  const pkg = root.attrs.package || root.children[0]?.attrs.package;
  if (pkg) lines.push(`PACKAGE: ${pkg}`);
  lines.push("");

  function walk(n: Node, depth: number) {
    if (n.attrs.__mcp_ref) {
      lines.push("  ".repeat(depth) + describeNode(n));
    }
    // Keep depth flat; descend without increasing too much to avoid insane indents.
    const newDepth = n.attrs.__mcp_ref ? depth + 1 : depth;
    for (const c of n.children) walk(c, newDepth);
  }
  walk(root, 0);
  return lines.join("\n");
}

export function getTree(): Promise<Node | null> {
  return dumpSource().then(parseXml);
}

// --- Screen signature (page-map identity) -------------------------------

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16);
}

function shortId(id: string): string {
  const i = id.indexOf(":id/");
  return i >= 0 ? id.slice(i + 4) : id;
}

export type ScreenSig = {
  app: string;
  activity?: string;
  key: string;
  title?: string;
  landmarks: { list?: boolean; inputs?: number };
};

// A *stable* screen identity that survives dynamic content (list rows, data): we
// key on the deduped SET of structural identifiers (resource-ids, content-descs,
// classes), not their per-instance values — so a list with 3 vs 30 rows hashes
// the same, while a genuinely different screen (different ids/labels) differs.
export function signatureFromTree(root: Node | null): ScreenSig | null {
  if (!root) return null;
  const app = root.attrs.package || root.children[0]?.attrs.package || "";
  if (!app) return null;
  const ids = new Set<string>();
  const descs = new Set<string>();
  const classes = new Set<string>();
  let inputs = 0;
  let list = false;
  let title: string | undefined;
  let bestTitleY = Infinity;

  const yOf = (bounds?: string): number => {
    const m = bounds && bounds.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    return m ? Number(m[2]) : Infinity;
  };
  // Normalize volatile counts/ids so "Activities (18)" and "Activities (3)"
  // collapse to one stable token — otherwise a screen re-keys every time a
  // badge count changes and the same screen maps as many nodes.
  const norm = (s: string) => s.replace(/\d+/g, "#").trim();
  function walk(n: Node) {
    const a = n.attrs;
    if (a["resource-id"]) ids.add(norm(shortId(a["resource-id"])));
    if (a["content-desc"]) descs.add(norm(a["content-desc"]));
    if (a.class) classes.add(shortClass(a.class));
    const cls = a.class || "";
    if (/EditText/.test(cls)) inputs++;
    if (a.scrollable === "true" || /RecyclerView|ListView/.test(cls)) list = true;
    // Title heuristic: the topmost short TextView text.
    if (cls.endsWith("TextView") && a.text) {
      const t = a.text.trim();
      const y = yOf(a.bounds);
      if (t.length >= 2 && t.length <= 40 && y < bestTitleY) { bestTitleY = y; title = t; }
    }
    for (const c of n.children) walk(c);
  }
  walk(root);

  const sortedIds = [...ids].sort();
  const sortedDescs = [...descs].sort();
  const sortedClasses = [...classes].sort();
  // Screen identity should track the navigation destination, NOT in-screen
  // content state (a tab/filter/expander swap changes the data but stays the
  // same screen). The title is the best proxy for "which screen"; resource-ids
  // pin the screen's chrome. Content-descs are deliberately EXCLUDED from the
  // key — they carry the swappable content (tile labels, row data) and would
  // re-key the screen on every tab toggle. Descs are only a last-resort basis
  // when a screen exposes neither a title nor ids.
  const titlePart = title ? norm(title) : "";
  const basis = titlePart || sortedIds.length
    ? [titlePart, "::", ...sortedIds]
    : (sortedDescs.length ? sortedDescs : sortedClasses);
  const key = fnv1a(`${app}\n${basis.join("|")}`);
  return { app, activity: undefined, key, title, landmarks: { list, inputs } };
}

export async function screenSignature(): Promise<ScreenSig | null> {
  const xml = await dumpSource().catch(() => "");
  if (!xml) return null;
  return signatureFromTree(parseXml(xml));
}

// Does an element matching `locator` (by resource-id / content-desc / text)
// exist anywhere in the tree? Used for the persistence test: a tapped element
// that survives onto the destination screen is global chrome (bottom nav etc.).
export function locatorInTree(root: Node | null, locator: Record<string, unknown> | undefined): boolean {
  if (!root || !locator) return false;
  const wantId = typeof locator.id === "string" ? locator.id : undefined;
  const wantDesc = typeof locator.desc === "string" ? locator.desc : undefined;
  const wantText = typeof locator.text === "string" ? locator.text : undefined;
  let found = false;
  function walk(n: Node) {
    if (found) return;
    const a = n.attrs;
    if (wantId && a["resource-id"] && (a["resource-id"] === wantId || shortId(a["resource-id"]) === shortId(wantId))) found = true;
    else if (wantDesc && a["content-desc"] === wantDesc) found = true;
    else if (wantText && a.text === wantText) found = true;
    for (const c of n.children) if (!found) walk(c);
  }
  walk(root);
  return found;
}

// Cheap screen fingerprint — captures package + activity + structural shape
// (class names and bounds of every element). Changes when navigation, modal,
// or any meaningful re-render happens.
export function fingerprintFromTree(root: Node | null): string {
  if (!root) return "";
  const parts: string[] = [];
  const pkg = root.attrs.package || root.children[0]?.attrs.package || "";
  parts.push(pkg);
  function walk(n: Node) {
    if (n.attrs.bounds || n.attrs.class) {
      parts.push(`${n.attrs.class || ""}@${n.attrs.bounds || ""}`);
    }
    for (const c of n.children) walk(c);
  }
  walk(root);
  return fnv1a(parts.join("|"));
}

export async function fingerprint(): Promise<string> {
  const xml = await dumpSource().catch(() => "");
  if (!xml) return "";
  return fingerprintFromTree(parseXml(xml));
}

// One UI dump → the change-detection fingerprint, the stable page-map signature,
// and the parsed tree (for the persistence test). Avoids re-dumping per concern.
export async function screenState(): Promise<{ fp: string; sig: ScreenSig | null; root: Node | null }> {
  const xml = await dumpSource().catch(() => "");
  const root = xml ? parseXml(xml) : null;
  return { fp: fingerprintFromTree(root), sig: signatureFromTree(root), root };
}
