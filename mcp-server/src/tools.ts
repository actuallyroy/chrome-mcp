import { PNG } from "pngjs";
import { z } from "zod";
import type { ElementHandle, Page } from "puppeteer-core";

function resizePngBase64(b64: string, maxDim: number): string {
  const src = PNG.sync.read(Buffer.from(b64, "base64"));
  const longest = Math.max(src.width, src.height);
  if (longest <= maxDim) return b64;
  const scale = maxDim / longest;
  const dw = Math.max(1, Math.round(src.width * scale));
  const dh = Math.max(1, Math.round(src.height * scale));
  const dst = new PNG({ width: dw, height: dh });
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(src.height - 1, Math.floor(y / scale));
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(src.width - 1, Math.floor(x / scale));
      const si = (sy * src.width + sx) << 2;
      const di = (y * dw + x) << 2;
      dst.data[di] = src.data[si];
      dst.data[di + 1] = src.data[si + 1];
      dst.data[di + 2] = src.data[si + 2];
      dst.data[di + 3] = src.data[si + 3];
    }
  }
  return PNG.sync.write(dst).toString("base64");
}
import {
  getActivePage,
  getBrowser,
  launchChrome,
  listPages,
  selectPageByIndex,
  selectPageByUrlSubstring,
  setActivePage,
} from "./browser.js";
import { readFileSync } from "node:fs";
import {
  getRecentCalls,
  recorderStatus,
  startRecording,
  stopRecording,
} from "./recorder.js";

export type ToolResult = {
  content: { type: "text" | "image"; text?: string; data?: string; mimeType?: string }[];
  isError?: boolean;
};

const text = (s: string): ToolResult => ({ content: [{ type: "text", text: s }] });
const json = (o: unknown): ToolResult => text(JSON.stringify(o, null, 2));

export type Tool = {
  name: string;
  description: string;
  schema: z.ZodObject<z.ZodRawShape>;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
};

async function withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
  const page = await getActivePage();
  return fn(page);
}

// Shared locator shape for click/fill. First populated wins.
const Locator = {
  ref: z.number().int().optional().describe("Ref number from the most recent outline() call"),
  text: z.string().optional().describe("Exact visible text of the element (button/link/menu item)"),
  label: z.string().optional().describe("The form-field label text (for inputs, comboboxes, switches)"),
  selector: z.string().optional().describe("CSS selector escape hatch"),
};

type LocatorArgs = {
  ref?: number;
  text?: string;
  label?: string;
  selector?: string;
};

async function resolveLocator(page: Page, loc: LocatorArgs): Promise<ElementHandle<Element>> {
  if (loc.ref != null) {
    const h = await page.$(`[data-mcp-ref="${loc.ref}"]`);
    if (h) return h;
    throw new Error(`No element with ref=${loc.ref} (outline may be stale — call outline again).`);
  }
  if (loc.selector) {
    const h = await page.$(loc.selector);
    if (h) return h;
    throw new Error(`No element matches selector: ${loc.selector}`);
  }
  if (loc.text) {
    const h = await page.evaluateHandle(
      (t: string) => (window as unknown as { __mcp: { findByText(s: string): Element | null } }).__mcp.findByText(t),
      loc.text,
    );
    const el = h.asElement();
    if (el) return el as ElementHandle<Element>;
    throw new Error(`No interactive element with text: "${loc.text}"`);
  }
  if (loc.label) {
    const h = await page.evaluateHandle(
      (t: string) => (window as unknown as { __mcp: { findByLabel(s: string): Element | null } }).__mcp.findByLabel(t),
      loc.label,
    );
    const el = h.asElement();
    if (el) return el as ElementHandle<Element>;
    throw new Error(`No form field with label: "${loc.label}"`);
  }
  throw new Error("Provide one of: ref, text, label, or selector.");
}

async function clickHandle(page: Page, h: ElementHandle<Element>) {
  await h.evaluate((el) => (el as HTMLElement).scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior }));
  // h.click() ends with a Runtime.callFunctionOn that resolves only after the
  // page's click handler returns. For form-submits / heavy SPA buttons that
  // start synchronous work, that round-trip can hit puppeteer's protocolTimeout
  // even though the click already fired. Instead, get the click point once,
  // then dispatch raw mouse events via CDP — those are fire-and-forget and
  // don't wait for handler completion.
  const box = await h.boundingBox();
  if (!box) {
    // Element has no layout (display:none, detached). Fall back to h.click().
    await h.click();
    return;
  }
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.click(x, y);
}

async function fillHandle(page: Page, h: ElementHandle<Element>, value: string) {
  await h.evaluate((el) => (el as HTMLElement).scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior }));
  // For native inputs: focus, select all, type. For React-controlled inputs, we
  // need the native setter so React sees the change.
  await h.evaluate((el, v) => {
    const e = el as HTMLInputElement | HTMLTextAreaElement;
    const proto = e instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(e, v);
    else e.value = v;
    e.dispatchEvent(new Event("input", { bubbles: true }));
    e.dispatchEvent(new Event("change", { bubbles: true }));
    e.blur();
  }, value);
}

export const tools: Tool[] = [
  // ---- Page inspection ---------------------------------------------------
  {
    name: "outline",
    description:
      "Return a compact text outline of the active page's interactive elements (inputs with labels & values, buttons, links, headings) plus any captured toasts. Each element gets a ref number you can pass to click/fill. Prefer this over screenshot for navigation.",
    schema: z.object({}),
    handler: async () =>
      withPage(async (p) => {
        const out = await p.evaluate(
          () => (window as unknown as { __mcp: { outline(): string } }).__mcp.outline(),
        );
        return text(out);
      }),
  },
  {
    name: "get_toasts",
    description:
      "Return toast / alert notifications captured since connection (includes messages that auto-dismiss). Set clear=true to empty the buffer after reading.",
    schema: z.object({ clear: z.boolean().default(false) }),
    handler: async (args) =>
      withPage(async (p) => {
        const { clear } = args as { clear: boolean };
        const toasts = await p.evaluate((shouldClear: boolean) => {
          const w = window as unknown as { __mcp: { toasts: { ts: number; text: string }[] } };
          const t = [...w.__mcp.toasts];
          if (shouldClear) w.__mcp.toasts.length = 0;
          return t;
        }, clear);
        return json(toasts);
      }),
  },
  {
    name: "wait_for_toast",
    description:
      "Block until a toast/alert containing the given text appears (case-insensitive substring). Useful for assertion-style waits after a submit.",
    schema: z.object({
      text: z.string().describe("Substring (case-insensitive) of the expected toast"),
      timeout_ms: z.number().int().min(0).default(10000),
    }),
    handler: async (args) =>
      withPage(async (p) => {
        const { text: t, timeout_ms } = args as { text: string; timeout_ms: number };
        const matched = await p.waitForFunction(
          (needle: string) => {
            const w = window as unknown as { __mcp: { toasts: { ts: number; text: string }[] } };
            const q = needle.toLowerCase();
            return w.__mcp.toasts.find((x) => x.text.toLowerCase().includes(q)) || null;
          },
          { timeout: timeout_ms, polling: 100 },
          t,
        );
        const val = await matched.jsonValue();
        return json(val);
      }),
  },
  {
    name: "get_console",
    description:
      "Return captured console messages (log/info/warn/error/debug + unhandled errors/rejections). Set clear=true to empty the buffer. Filter by level (comma-separated: 'error,warn').",
    schema: z.object({
      clear: z.boolean().default(false),
      level: z.string().optional(),
      limit: z.number().int().min(1).max(500).default(100),
    }),
    handler: async (args) =>
      withPage(async (p) => {
        const { clear, level, limit } = args as {
          clear: boolean;
          level?: string;
          limit: number;
        };
        const levels = level ? level.split(",").map((s) => s.trim()) : null;
        const entries = await p.evaluate(
          (shouldClear: boolean, allowed: string[] | null, lim: number) => {
            const w = window as unknown as {
              __mcp: { console: { ts: number; level: string; text: string }[] };
            };
            let list = [...w.__mcp.console];
            if (allowed) list = list.filter((e) => allowed.includes(e.level));
            list = list.slice(-lim);
            if (shouldClear) w.__mcp.console.length = 0;
            return list;
          },
          clear,
          levels,
          limit,
        );
        return json(entries);
      }),
  },
  {
    name: "get_network",
    description:
      "Return captured network requests (fetch + XHR) with url, method, status, duration. Set clear=true to empty the buffer. Use url_contains to filter.",
    schema: z.object({
      clear: z.boolean().default(false),
      url_contains: z.string().optional(),
      limit: z.number().int().min(1).max(500).default(50),
    }),
    handler: async (args) =>
      withPage(async (p) => {
        const { clear, url_contains, limit } = args as {
          clear: boolean;
          url_contains?: string;
          limit: number;
        };
        const entries = await p.evaluate(
          (shouldClear: boolean, filter: string | undefined, lim: number) => {
            const w = window as unknown as {
              __mcp: { network: { url: string; method: string; status: number | null; ms: number | null; kind: string }[] };
            };
            let list = [...w.__mcp.network];
            if (filter) list = list.filter((e) => e.url.includes(filter));
            list = list.slice(-lim);
            if (shouldClear) w.__mcp.network.length = 0;
            return list;
          },
          clear,
          url_contains,
          limit,
        );
        return json(entries);
      }),
  },
  {
    name: "describe",
    description:
      "Return detailed info about a single element: tag, role, label, text, bounding rect, attributes, and ancestor chain. Use after an outline when an element's role/value is unclear.",
    schema: z.object(Locator),
    handler: async (args) =>
      withPage(async (p) => {
        const h = await resolveLocator(p, args as LocatorArgs);
        const info = await h.evaluate((el) => {
          const w = window as unknown as {
            __mcp: { describeElement(e: Element): unknown };
          };
          return w.__mcp.describeElement(el);
        });
        return json(info);
      }),
  },

  // ---- Interaction -------------------------------------------------------
  {
    name: "click",
    description:
      "Click an element. Provide one of: ref (from outline), text (visible button/link text), label (form-field label), or selector (CSS fallback).",
    schema: z.object({
      ...Locator,
      button: z.enum(["left", "right", "middle"]).default("left"),
      click_count: z.number().int().min(1).max(3).default(1),
    }),
    handler: async (args) =>
      withPage(async (p) => {
        const { button, click_count, ...loc } = args as LocatorArgs & {
          button: "left" | "right" | "middle";
          click_count: number;
        };
        const h = await resolveLocator(p, loc);
        await h.evaluate((el) => (el as HTMLElement).scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior }));
        const box = await h.boundingBox();
        if (box) {
          const x = box.x + box.width / 2;
          const y = box.y + box.height / 2;
          // Raw mouse events via CDP are fire-and-forget; h.click() waits on
          // Runtime.callFunctionOn which times out on heavy form-submit handlers.
          await p.mouse.click(x, y, { button, count: click_count });
        } else {
          await h.click({ button, count: click_count });
        }
        return text(`clicked (${loc.ref ? `ref=${loc.ref}` : loc.text ? `text="${loc.text}"` : loc.label ? `label="${loc.label}"` : loc.selector})`);
      }),
  },
  {
    name: "fill",
    description:
      "Set the value of a form field. Provide one of: ref, label, or selector. Works with native inputs and React-controlled inputs.",
    schema: z.object({ ...Locator, value: z.string() }),
    handler: async (args) =>
      withPage(async (p) => {
        const { value, ...loc } = args as LocatorArgs & { value: string };
        const h = await resolveLocator(p, loc);
        await fillHandle(p, h, value);
        return text(`filled (${loc.ref ? `ref=${loc.ref}` : loc.label ? `label="${loc.label}"` : loc.selector})`);
      }),
  },
  {
    name: "fill_form",
    description:
      "Batch-fill multiple form fields. Pass an array of {label|ref|selector, value}. Faster than issuing one fill call per field.",
    schema: z.object({
      fields: z
        .array(
          z.object({
            ref: z.number().int().optional(),
            label: z.string().optional(),
            selector: z.string().optional(),
            value: z.string(),
          }),
        )
        .min(1),
    }),
    handler: async (args) =>
      withPage(async (p) => {
        const { fields } = args as {
          fields: { ref?: number; label?: string; selector?: string; value: string }[];
        };
        const filled: string[] = [];
        for (const f of fields) {
          const h = await resolveLocator(p, f);
          await fillHandle(p, h, f.value);
          filled.push(f.label || (f.ref ? `ref=${f.ref}` : f.selector || ""));
        }
        return text(`filled ${filled.length} field(s): ${filled.join(", ")}`);
      }),
  },
  {
    name: "select_option",
    description:
      "Pick an option in a custom (Radix/shadcn/etc.) combobox. Opens the trigger, waits for options, clicks the one whose text matches.",
    schema: z.object({
      ...Locator,
      option: z.string().describe("Text (or substring) of the option to pick"),
    }),
    handler: async (args) =>
      withPage(async (p) => {
        const { option, ...loc } = args as LocatorArgs & { option: string };
        const trigger = await resolveLocator(p, loc);
        await trigger.evaluate((el) => (el as HTMLElement).scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior }));
        await trigger.click();
        // Wait for an option to appear (Radix portal renders outside the trigger).
        await p.waitForFunction(
          () => document.querySelectorAll('[role="option"]').length > 0,
          { timeout: 5000 },
        );
        const picked = await p.evaluate((needle: string) => {
          const target = needle.trim().toLowerCase();
          const opts = [...document.querySelectorAll('[role="option"]')] as HTMLElement[];
          const hit =
            opts.find((o) => o.textContent?.trim().toLowerCase() === target) ||
            opts.find((o) => o.textContent?.toLowerCase().includes(target));
          if (!hit) return null;
          hit.scrollIntoView({ block: "center" });
          hit.click();
          return hit.textContent?.trim() || "";
        }, option);
        if (picked == null) {
          const visible = await p.evaluate(() =>
            [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent?.trim()),
          );
          throw new Error(
            `No option matching "${option}". Visible options: ${JSON.stringify(visible)}`,
          );
        }
        return text(`picked "${picked}"`);
      }),
  },
  {
    name: "press",
    description: "Press a keyboard key (e.g. 'Enter', 'Tab', 'Escape', 'ArrowDown').",
    schema: z.object({ key: z.string() }),
    handler: async (args) =>
      withPage(async (p) => {
        const { key } = args as { key: string };
        await p.keyboard.press(key as Parameters<typeof p.keyboard.press>[0]);
        return text(`Pressed ${key}`);
      }),
  },
  {
    name: "type",
    description: "Type text into whatever is currently focused.",
    schema: z.object({ text: z.string(), delay_ms: z.number().int().min(0).default(0) }),
    handler: async (args) =>
      withPage(async (p) => {
        const { text: t, delay_ms } = args as { text: string; delay_ms: number };
        await p.keyboard.type(t, { delay: delay_ms });
        return text(`Typed ${t.length} chars`);
      }),
  },
  {
    name: "hover",
    description: "Hover the mouse over an element (locator shape).",
    schema: z.object(Locator),
    handler: async (args) =>
      withPage(async (p) => {
        const h = await resolveLocator(p, args as LocatorArgs);
        await h.hover();
        return text(`hovered`);
      }),
  },
  {
    name: "scroll",
    description:
      "Scroll the page. Provide a locator (to scroll an element into view) or dx/dy (pixel delta).",
    schema: z.object({
      ...Locator,
      dx: z.number().default(0),
      dy: z.number().default(0),
    }),
    handler: async (args) =>
      withPage(async (p) => {
        const a = args as LocatorArgs & { dx: number; dy: number };
        if (a.ref != null || a.text || a.label || a.selector) {
          const h = await resolveLocator(p, a);
          await h.evaluate((el) => (el as HTMLElement).scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior }));
          return text("scrolled into view");
        }
        await p.evaluate((x, y) => window.scrollBy(x, y), a.dx, a.dy);
        return text(`scrolled by (${a.dx}, ${a.dy})`);
      }),
  },

  // ---- Navigation --------------------------------------------------------
  {
    name: "navigate",
    description: "Navigate the active tab to a URL.",
    schema: z.object({
      url: z.string().url(),
      wait_until: z
        .enum(["load", "domcontentloaded", "networkidle0", "networkidle2"])
        .default("domcontentloaded"),
    }),
    handler: async (args) =>
      withPage(async (p) => {
        const { url, wait_until } = args as {
          url: string;
          wait_until: "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
        };
        await p.goto(url, { waitUntil: wait_until });
        return text(`Navigated to ${p.url()}`);
      }),
  },
  {
    name: "go_back",
    description: "Go back in history on the active tab.",
    schema: z.object({}),
    handler: async () =>
      withPage(async (p) => {
        await p.goBack();
        return text(`At ${p.url()}`);
      }),
  },
  {
    name: "go_forward",
    description: "Go forward in history on the active tab.",
    schema: z.object({}),
    handler: async () =>
      withPage(async (p) => {
        await p.goForward();
        return text(`At ${p.url()}`);
      }),
  },
  {
    name: "reload",
    description: "Reload the active tab.",
    schema: z.object({}),
    handler: async () =>
      withPage(async (p) => {
        await p.reload();
        return text(`Reloaded ${p.url()}`);
      }),
  },
  {
    name: "wait_for_selector",
    description: "Wait until an element matching a selector appears (or becomes visible).",
    schema: z.object({
      selector: z.string(),
      visible: z.boolean().default(true),
      timeout_ms: z.number().int().min(0).default(15000),
    }),
    handler: async (args) =>
      withPage(async (p) => {
        const { selector, visible, timeout_ms } = args as {
          selector: string;
          visible: boolean;
          timeout_ms: number;
        };
        await p.waitForSelector(selector, { visible, timeout: timeout_ms });
        return text(`Found ${selector}`);
      }),
  },
  {
    name: "wait_for_navigation",
    description: "Wait for the next navigation on the active tab to finish.",
    schema: z.object({
      wait_until: z
        .enum(["load", "domcontentloaded", "networkidle0", "networkidle2"])
        .default("domcontentloaded"),
      timeout_ms: z.number().int().min(0).default(15000),
    }),
    handler: async (args) =>
      withPage(async (p) => {
        const { wait_until, timeout_ms } = args as {
          wait_until: "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
          timeout_ms: number;
        };
        await p.waitForNavigation({ waitUntil: wait_until, timeout: timeout_ms });
        return text(`At ${p.url()}`);
      }),
  },

  // ---- Chrome lifecycle --------------------------------------------------
  {
    name: "launch_chrome",
    description:
      "Explicitly launch Chrome with remote debugging enabled, using a dedicated profile at ~/ChromeMCP-Profile. Normally not needed — the first tool call auto-spawns Chrome if the debug port isn't up. First run creates an empty profile; sign into the sites you want to drive, and the session persists.",
    schema: z.object({ headless: z.boolean().default(false) }),
    handler: async (args) => {
      const { headless } = args as { headless: boolean };
      const r = await launchChrome({ headless });
      return json(r);
    },
  },

  // ---- Tab control -------------------------------------------------------
  {
    name: "list_tabs",
    description: "List open tabs. Returns index, url, title for each.",
    schema: z.object({}),
    handler: async () => {
      const pages = await listPages();
      const info = await Promise.all(
        pages.map(async (p, i) => ({
          index: i,
          url: p.url(),
          title: await p.title().catch(() => ""),
        })),
      );
      return json(info);
    },
  },
  {
    name: "select_tab",
    description: "Make a tab active. Provide index (from list_tabs) or url_contains (substring).",
    schema: z.object({
      index: z.number().int().optional(),
      url_contains: z.string().optional(),
    }),
    handler: async (args) => {
      const { index, url_contains } = args as { index?: number; url_contains?: string };
      let page: Page;
      if (typeof index === "number") page = await selectPageByIndex(index);
      else if (url_contains) page = await selectPageByUrlSubstring(url_contains);
      else throw new Error("Provide either 'index' or 'url_contains'");
      return text(`Active tab: ${page.url()}`);
    },
  },
  {
    name: "new_tab",
    description: "Open a new tab (optionally navigating to a URL). Becomes active.",
    schema: z.object({ url: z.string().url().optional() }),
    handler: async (args) => {
      const { url } = args as { url?: string };
      const b = await getBrowser();
      const page = await b.newPage();
      if (url) await page.goto(url, { waitUntil: "domcontentloaded" });
      setActivePage(page);
      await page.bringToFront();
      return text(`Opened ${page.url()}`);
    },
  },
  {
    name: "close_tab",
    description: "Close the active tab.",
    schema: z.object({}),
    handler: async () =>
      withPage(async (p) => {
        const url = p.url();
        await p.close();
        return text(`Closed ${url}`);
      }),
  },

  // ---- Inspection --------------------------------------------------------
  {
    name: "get_text",
    description: "Get visible text from the page, or a specific selector. Truncated to 20k chars.",
    schema: z.object({ selector: z.string().optional() }),
    handler: async (args) =>
      withPage(async (p) => {
        const { selector } = args as { selector?: string };
        const content = selector
          ? await p.$eval(selector, (el) => (el as HTMLElement).innerText)
          : await p.evaluate(() => document.body.innerText);
        return text(content.slice(0, 20_000));
      }),
  },
  {
    name: "get_html",
    description: "Get outer HTML of the page or a selector. Truncated to 50k chars.",
    schema: z.object({ selector: z.string().optional() }),
    handler: async (args) =>
      withPage(async (p) => {
        const { selector } = args as { selector?: string };
        const html = selector
          ? await p.$eval(selector, (el) => el.outerHTML)
          : await p.content();
        return text(html.slice(0, 50_000));
      }),
  },
  {
    name: "get_url",
    description: "Get the URL of the active tab.",
    schema: z.object({}),
    handler: async () => withPage(async (p) => text(p.url())),
  },
  {
    name: "get_title",
    description: "Get the title of the active tab.",
    schema: z.object({}),
    handler: async () => withPage(async (p) => text(await p.title())),
  },
  {
    name: "get_attribute",
    description: "Get an attribute value from the first element matching a selector.",
    schema: z.object({ selector: z.string(), name: z.string() }),
    handler: async (args) =>
      withPage(async (p) => {
        const { selector, name } = args as { selector: string; name: string };
        const v = await p.$eval(
          selector,
          (el, attr) => el.getAttribute(attr as string),
          name,
        );
        return text(v ?? "");
      }),
  },
  {
    name: "snapshot",
    description: "Full accessibility-tree snapshot (verbose — prefer `outline`).",
    schema: z.object({ interesting_only: z.boolean().default(true) }),
    handler: async (args) =>
      withPage(async (p) => {
        const { interesting_only } = args as { interesting_only: boolean };
        const snap = await p.accessibility.snapshot({ interestingOnly: interesting_only });
        return json(snap);
      }),
  },
  {
    name: "screenshot",
    description:
      "Take a PNG screenshot of the active tab, auto-downscaled to fit the MCP 2000px image limit. Set full_page=true for the full scrollable area. Prefer `outline` for navigation and element lookup — it's cheaper, faster, and returns stable refs. Use screenshot only for visual verification, layout bugs, or content the DOM can't describe (canvas, charts, rendered media).",
    schema: z.object({
      full_page: z.boolean().default(false),
      max_dim: z.number().int().min(256).max(2000).default(1600),
    }),
    handler: async (args) =>
      withPage(async (p) => {
        const { full_page, max_dim } = args as { full_page: boolean; max_dim: number };
        const buf = (await p.screenshot({ fullPage: full_page, type: "png" })) as Uint8Array;
        const b64 = resizePngBase64(Buffer.from(buf).toString("base64"), max_dim);
        return { content: [{ type: "image", data: b64, mimeType: "image/png" }] };
      }),
  },
  {
    name: "evaluate",
    description: "Run a JavaScript expression in the page context. Return value is JSON-serialized.",
    schema: z.object({ expression: z.string() }),
    handler: async (args) =>
      withPage(async (p) => {
        const { expression } = args as { expression: string };
        const result = await p.evaluate((expr) => {
          const fn = new Function(`return (${expr})`);
          return fn();
        }, expression);
        return json(result ?? null);
      }),
  },

  // ---- Cookies -----------------------------------------------------------
  {
    name: "get_cookies",
    description: "Get cookies for the active tab's URL.",
    schema: z.object({}),
    handler: async () =>
      withPage(async (p) => {
        const cookies = await p.cookies();
        return json(cookies);
      }),
  },
  {
    name: "set_cookies",
    description: "Set one or more cookies on the active tab.",
    schema: z.object({
      cookies: z
        .array(
          z.object({
            name: z.string(),
            value: z.string(),
            domain: z.string().optional(),
            path: z.string().optional(),
            expires: z.number().optional(),
            httpOnly: z.boolean().optional(),
            secure: z.boolean().optional(),
            sameSite: z.enum(["Strict", "Lax", "None"]).optional(),
          }),
        )
        .min(1),
    }),
    handler: async (args) =>
      withPage(async (p) => {
        const { cookies } = args as { cookies: Parameters<Page["setCookie"]>[0][] };
        await p.setCookie(...cookies);
        return text(`Set ${cookies.length} cookie(s)`);
      }),
  },

  // ---- Debugging ---------------------------------------------------------
  {
    name: "pause",
    description:
      "Pause the agent. Shows a 'Resume' overlay in the browser; blocks until the human clicks it (or timeout). Use when you want to inspect DOM state manually or intervene before the next step.",
    schema: z.object({
      message: z.string().optional().describe("Shown to the human in the overlay"),
      timeout_ms: z.number().int().min(0).default(300_000),
    }),
    handler: async (args) =>
      withPage(async (p) => {
        const { message, timeout_ms } = args as { message?: string; timeout_ms: number };
        await p.evaluate(
          (m: string | undefined) => {
            const w = window as unknown as { __mcp: { showPauseOverlay(msg?: string): void } };
            w.__mcp.showPauseOverlay(m);
          },
          message,
        );
        try {
          await p.waitForFunction(
            () => (window as unknown as { __mcp: { paused: boolean } }).__mcp.paused === false,
            { timeout: timeout_ms, polling: 250 },
          );
          return text("resumed");
        } catch {
          await p.evaluate(() => {
            const el = document.getElementById("__mcp_pause_overlay");
            if (el) el.remove();
            (window as unknown as { __mcp: { paused: boolean } }).__mcp.paused = false;
          });
          return text("pause timed out");
        }
      }),
  },
  {
    name: "resume",
    description:
      "Force-resume a pending pause (programmatic equivalent of clicking Resume). Usually unnecessary — click the overlay button in the browser instead.",
    schema: z.object({}),
    handler: async () =>
      withPage(async (p) => {
        await p.evaluate(() => {
          const el = document.getElementById("__mcp_pause_overlay");
          if (el) el.remove();
          (window as unknown as { __mcp: { paused: boolean } }).__mcp.paused = false;
        });
        return text("resumed");
      }),
  },
  {
    name: "inject_script",
    description:
      "Register a JS snippet that runs on every new document in this tab (via evaluateOnNewDocument) AND immediately on the current page. Use for persistent debug helpers, mocking window.fetch, injecting test hooks, etc. For one-shot execution use `evaluate`.",
    schema: z.object({
      code: z.string().describe("JS source. Runs in page context, not sandboxed."),
    }),
    handler: async (args) =>
      withPage(async (p) => {
        const { code } = args as { code: string };
        await p.evaluateOnNewDocument(code);
        const result = await p.evaluate((src: string) => {
          try {
            new Function(src)();
            return { ok: true };
          } catch (e) {
            return { ok: false, error: (e as Error).message };
          }
        }, code);
        if (!result.ok) throw new Error(`injected on future loads, but current-page run failed: ${result.error}`);
        return text("script injected (persists across navigations)");
      }),
  },

  // ---- Flow recording ----------------------------------------------------
  {
    name: "start_recording",
    description:
      "Start recording subsequent tool calls into a flow file. Pass an absolute `path` to write to when stop_recording is called; omit to buffer in-memory only.",
    schema: z.object({ path: z.string().optional() }),
    handler: async (args) => {
      const { path } = args as { path?: string };
      startRecording(path);
      return text(`recording started${path ? ` → ${path}` : " (in-memory)"}`);
    },
  },
  {
    name: "stop_recording",
    description:
      "Stop recording. Writes the flow to the path passed to start_recording (if any) and returns the recorded entries.",
    schema: z.object({}),
    handler: async () => {
      const result = stopRecording();
      return json(result);
    },
  },
  {
    name: "recording_status",
    description: "Return whether flow recording is active and how many entries have been captured.",
    schema: z.object({}),
    handler: async () => json(recorderStatus()),
  },

  // ---- Assertions --------------------------------------------------------
  {
    name: "assert",
    description:
      "Assert a condition on the current page. Throws on failure (useful as a script step). Provide one of: url_contains, text_visible, toast (substring), element (locator shape, passes if exists+visible).",
    schema: z.object({
      url_contains: z.string().optional(),
      text_visible: z.string().optional(),
      toast: z.string().optional(),
      element: z
        .object({
          ref: z.number().int().optional(),
          text: z.string().optional(),
          label: z.string().optional(),
          selector: z.string().optional(),
        })
        .optional(),
    }),
    handler: async (args) =>
      withPage(async (p) => {
        const a = args as {
          url_contains?: string;
          text_visible?: string;
          toast?: string;
          element?: LocatorArgs;
        };
        if (a.url_contains) {
          const url = p.url();
          if (!url.includes(a.url_contains))
            throw new Error(`assert.url_contains failed: "${a.url_contains}" not in ${url}`);
          return text(`ok (url contains "${a.url_contains}")`);
        }
        if (a.text_visible) {
          const ok = await p.evaluate((needle: string) => {
            return document.body.innerText.includes(needle);
          }, a.text_visible);
          if (!ok) throw new Error(`assert.text_visible failed: "${a.text_visible}" not on page`);
          return text(`ok (text visible)`);
        }
        if (a.toast) {
          const hit = await p.evaluate((needle: string) => {
            const w = window as unknown as { __mcp: { toasts: { text: string }[] } };
            const q = needle.toLowerCase();
            return w.__mcp.toasts.find((x) => x.text.toLowerCase().includes(q)) || null;
          }, a.toast);
          if (!hit) throw new Error(`assert.toast failed: no toast containing "${a.toast}"`);
          return text(`ok (toast seen)`);
        }
        if (a.element) {
          await resolveLocator(p, a.element); // throws if not found
          return text(`ok (element present)`);
        }
        throw new Error("assert: provide one of url_contains / text_visible / toast / element");
      }),
  },

  // ---- Script runner -----------------------------------------------------
  {
    name: "run_script",
    description:
      "Execute a JSON flow of MCP tool calls. Two modes:\n\n" +
      "(1) **Inline batching** — when you know the next 2-3 steps with confidence, pass them inline to save round-trips:\n" +
      `  run_script { script: { steps: [{ tool: "click", args: { ref: 7 } }, { tool: "fill", args: { ref: 9, value: "x" } }, { tool: "click", args: { text: "Submit" } }] } }\n` +
      "  By default it stops at the first failure and the report shows the failing index `i` so you can pivot.\n\n" +
      "(2) **Saved flow** — pass a `path` to a recorded JSON file. Use `start_at` / `end_at` / `only` to re-run from a checkpoint or hot-fix a single step.\n\n" +
      "Step shape: {tool, args?, skip?, on_error?}. Set `verbose: true` to get full per-step output instead of 200-char previews (useful when you batched in lieu of separate calls).",
    schema: z.object({
      path: z.string().optional(),
      script: z
        .object({
          steps: z.array(z.object({ tool: z.string(), args: z.record(z.any()).optional() })).optional(),
          entries: z.array(z.object({ tool: z.string(), args: z.record(z.any()).optional() })).optional(),
        })
        .optional(),
      continue_on_error: z.boolean().default(false),
      dry_run: z.boolean().default(false),
      start_at: z.number().int().min(0).optional().describe("Skip steps before this index."),
      end_at: z.number().int().min(0).optional().describe("Stop after this index (inclusive)."),
      only: z.number().int().min(0).optional().describe("Run just this single step. Shorthand for start_at == end_at == only."),
      verbose: z.boolean().default(false).describe("Return full per-step output instead of 200-char previews."),
    }),
    handler: async (args) => {
      const { path, script, continue_on_error, dry_run, start_at, end_at, only, verbose } = args as {
        path?: string;
        script?: { steps?: { tool: string; args?: Record<string, unknown> }[]; entries?: { tool: string; args?: Record<string, unknown> }[] };
        continue_on_error: boolean;
        dry_run: boolean;
        start_at?: number;
        end_at?: number;
        only?: number;
        verbose: boolean;
      };
      let parsed: { steps?: { tool: string; args?: Record<string, unknown> }[]; entries?: { tool: string; args?: Record<string, unknown> }[] };
      if (path) {
        const raw = readFileSync(path, "utf8");
        parsed = JSON.parse(raw);
      } else if (script) {
        parsed = script;
      } else {
        throw new Error("run_script: provide either `path` or `script`");
      }
      const steps = parsed.steps ?? parsed.entries ?? [];
      if (steps.length === 0) throw new Error("run_script: no steps/entries in script");

      const from = only != null ? only : (start_at ?? 0);
      const to = only != null ? only : (end_at != null ? end_at : steps.length - 1);
      if (from < 0 || from >= steps.length) throw new Error(`start index ${from} out of range (0..${steps.length - 1})`);
      if (to < from || to >= steps.length) throw new Error(`end index ${to} out of range (${from}..${steps.length - 1})`);

      const report: {
        i: number;
        tool: string;
        ok: boolean;
        ms: number;
        result_preview?: string;
        result?: string;
        error?: string;
      }[] = [];

      for (let i = from; i <= to; i++) {
        const step = steps[i] as {
          tool: string;
          args?: Record<string, unknown>;
          skip?: boolean;
          on_error?: "continue" | "stop";
          name?: string;
        };
        if (step.skip) {
          report.push({ i, tool: step.tool, ok: true, ms: 0, result_preview: "skipped" });
          continue;
        }
        if (dry_run) {
          report.push({ i, tool: step.tool, ok: true, ms: 0, result_preview: "(dry run)" });
          continue;
        }
        const tool = tools.find((t) => t.name === step.tool);
        if (!tool) {
          const entry = { i, tool: step.tool, ok: false, ms: 0, error: "unknown tool" };
          report.push(entry);
          if (continue_on_error || step.on_error === "continue") continue;
          return json({ ok: false, stopped_at: i, report });
        }
        const t0 = Date.now();
        try {
          const validated = tool.schema.parse(step.args ?? {});
          const r = await tool.handler(validated as Record<string, unknown>);
          const fullText = r.content.find((c) => c.type === "text")?.text;
          const preview = fullText?.slice(0, 200);
          if (r.isError) {
            const entry = { i, tool: step.tool, ok: false, ms: Date.now() - t0, error: preview };
            report.push(entry);
            if (continue_on_error || step.on_error === "continue") continue;
            return json({ ok: false, stopped_at: i, report });
          }
          const entry: { i: number; tool: string; ok: boolean; ms: number; result_preview?: string; result?: string } = {
            i, tool: step.tool, ok: true, ms: Date.now() - t0,
          };
          if (verbose) entry.result = fullText; else entry.result_preview = preview;
          report.push(entry);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          report.push({ i, tool: step.tool, ok: false, ms: Date.now() - t0, error: msg });
          if (continue_on_error || step.on_error === "continue") continue;
          return json({ ok: false, stopped_at: i, report });
        }
      }
      return json({ ok: true, steps_run: report.length, report });
    },
  },
  {
    name: "send_feedback",
    description:
      "Send feedback about chrome-mcp itself — bugs, missing tools, surprising behavior, or 'this would be easier if'. Opens a GitHub issue. Auto-attaches product+version and recent tool calls as context. Use when the MCP blocks you or forces a workaround. Do NOT use for bugs in the target web page.",
    schema: z.object({
      message: z.string().min(1).max(8000).describe("The feedback text. Be specific: what you tried, what happened, what you expected."),
      severity: z.enum(["bug", "missing", "idea", "praise"]).default("idea"),
      include_recent_calls: z.boolean().default(true).describe("Attach the last ~20 tool calls as context."),
    }),
    handler: async (args) => {
      const { message, severity, include_recent_calls } = args as {
        message: string;
        severity: "bug" | "missing" | "idea" | "praise";
        include_recent_calls: boolean;
      };
      const endpoint =
        process.env.CHROME_MCP_FEEDBACK_ENDPOINT ||
        process.env.CHROME_MCP_ENDPOINT ||
        "https://chrome-mcp.actuallyroy.com";
      const context: Record<string, unknown> = {};
      if (include_recent_calls) {
        context.recent_calls = getRecentCalls().map((c) => ({
          tool: c.tool,
          ok: c.ok,
          args: c.args,
          result_preview: c.result_preview,
          ts: new Date(c.ts).toISOString(),
        }));
      }
      const res = await fetch(`${endpoint.replace(/\/$/, "")}/api/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message,
          severity,
          product: "chrome",
          version: "0.2.6",
          context,
        }),
      });
      const bodyText = await res.text();
      if (!res.ok) {
        throw new Error(`feedback POST failed: ${res.status} ${bodyText.slice(0, 300)}`);
      }
      const parsed = JSON.parse(bodyText) as { url?: string; issue_number?: number };
      return { content: [{ type: "text", text: `filed issue #${parsed.issue_number} — ${parsed.url}` }] };
    },
  },
];
