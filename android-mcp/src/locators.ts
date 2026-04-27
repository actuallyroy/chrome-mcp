import { findElement } from "./uiautomator2.js";
import { resolveRef, getTree, type Node } from "./outline.js";

export type LocatorArgs = {
  ref?: number;
  text?: string;
  desc?: string; // content-desc
  id?: string; // resource-id (accepts short form "submit_btn" or full "com.foo:id/submit_btn")
  xpath?: string;
  class?: string;
  selector?: string; // UiSelector string (advanced)
};

// Resolve a locator to an Appium element id.
export async function resolveElementId(loc: LocatorArgs): Promise<string> {
  if (loc.ref != null) {
    // We have the ref→path mapping; we need to translate that to a selector
    // the server can find. We use the node's `resource-id` / bounds / text.
    const root = await getTree();
    if (!root) throw new Error(`ref=${loc.ref}: view tree is empty`);
    const node = resolveRef(loc.ref, root);
    if (!node) throw new Error(`ref=${loc.ref} not found in the current tree`);
    return findElementFromNode(node);
  }
  if (loc.xpath) return findElement("xpath", loc.xpath);
  if (loc.id) {
    const value = loc.id.includes(":id/") ? loc.id : loc.id; // caller can pass either
    return findElement("id", value);
  }
  if (loc.desc) {
    try { return await findElement("accessibility id", loc.desc); } catch (e) {
      // Fall back to descContains so case mismatches and trailing whitespace
      // don't force the caller to guess the exact string.
      try {
        return await findElement(
          "-android uiautomator",
          `new UiSelector().descriptionContains("${escapeU(loc.desc)}")`,
        );
      } catch { throw e; }
    }
  }
  if (loc.text) {
    try {
      return await findElement(
        "-android uiautomator",
        `new UiSelector().text("${escapeU(loc.text)}")`,
      );
    } catch (e) {
      // Common miss: caller passed "Reload" but the actual label is "RELOAD"
      // (or vice-versa). Try a case-insensitive contains match before giving up.
      try {
        return await findElement(
          "-android uiautomator",
          `new UiSelector().textMatches("(?i).*${escapeRegexForUi(loc.text)}.*")`,
        );
      } catch { /* fall through to original error */ }
      throw e;
    }
  }
  if (loc.class) return findElement("class name", loc.class);
  if (loc.selector) return findElement("-android uiautomator", loc.selector);
  throw new Error("Provide one of: ref, text, desc, id, xpath, class, selector");
}

function escapeU(s: string) {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function escapeRegexForUi(s: string) {
  // Escape regex metas, then escape backslashes/quotes for the UiSelector string.
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/"/g, '\\"');
}

async function findElementFromNode(n: Node): Promise<string> {
  const a = n.attrs;
  // Prefer resource-id if unique; fall back to desc, text, then bounds.
  if (a["resource-id"]) {
    try { return await findElement("id", a["resource-id"]); } catch {}
  }
  if (a["content-desc"]) {
    try { return await findElement("accessibility id", a["content-desc"]); } catch {}
  }
  if (a.text) {
    try {
      return await findElement(
        "-android uiautomator",
        `new UiSelector().text("${escapeU(a.text)}")`,
      );
    } catch {}
  }
  // Last resort: bounds-based XPath (fragile but works).
  if (a.bounds) {
    return await findElement("xpath", `//*[@bounds='${a.bounds}']`);
  }
  throw new Error("Could not translate ref → a selector (no resource-id/desc/text/bounds)");
}
