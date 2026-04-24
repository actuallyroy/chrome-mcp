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

// Cheap screen fingerprint — captures package + activity + structural shape
// (class names and bounds of every element). Changes when navigation, modal,
// or any meaningful re-render happens.
export async function fingerprint(): Promise<string> {
  const xml = await dumpSource().catch(() => "");
  if (!xml) return "";
  const root = parseXml(xml);
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
  const joined = parts.join("|");
  // Light hash: FNV-1a 32-bit is enough for equality testing.
  let h = 0x811c9dc5;
  for (let i = 0; i < joined.length; i++) {
    h ^= joined.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}
