import { readFileSync, unlinkSync } from "node:fs";
import { PNG } from "pngjs";
import { z } from "zod";
import { fileFeedback } from "./feedback.js";
import {
  FLOW_NAME_RE,
  deleteFlowFile,
  flowAsTool,
  listFlowDocs,
  writeFlow,
} from "./flows.js";
import { callHelper } from "./helper.js";
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

// Hook the dispatcher uses to notify the MCP client when the tool list
// changes (e.g., after save_flow / delete_flow). Set from index.ts.
let notifyToolsChanged: (() => void) | null = null;
export function setNotifyToolsChanged(fn: () => void) { notifyToolsChanged = fn; }
function emitToolsChanged() { if (notifyToolsChanged) notifyToolsChanged(); }

const FLOW_CAP = 20;
const VERSION = "0.2.0";

// ---- AX outline renderer ----------------------------------------------------

type AxNode = {
  ref: number;
  role: string;
  role_description?: string | null;
  title?: string | null;
  value?: string | null;
  label?: string | null;
  identifier?: string | null;
  enabled: boolean;
  position?: [number, number] | null;
  size?: [number, number] | null;
  children: AxNode[];
};

const NOISY_ROLES = new Set(["AXUnknown", "AXLayoutItem"]);

function nodeIsInteresting(n: AxNode): boolean {
  if (NOISY_ROLES.has(n.role)) return false;
  if (n.title || n.value || n.label || n.identifier) return true;
  if (n.children.length > 0) return true;
  if (n.role === "AXGroup" || n.role === "AXStaticText") return false;
  return true;
}

function renderOutline(root: AxNode): string {
  const lines: string[] = [];
  function walk(n: AxNode, depth: number) {
    if (!nodeIsInteresting(n)) {
      for (const c of n.children) walk(c, depth);
      return;
    }
    const indent = "  ".repeat(depth);
    const role = n.role.replace(/^AX/, "").toLowerCase();
    const id = n.identifier ? ` id=${n.identifier}` : "";
    const label = (n.title || n.label || "").replace(/\s+/g, " ").slice(0, 100);
    const value = n.value ? ` = "${n.value.replace(/\s+/g, " ").slice(0, 80)}"` : "";
    const disabled = n.enabled ? "" : " disabled";
    const ltext = label ? ` "${label}"` : "";
    lines.push(`${indent}[${role} #${n.ref}${disabled}${id}]${ltext}${value}`);
    for (const c of n.children) walk(c, depth + 1);
  }
  walk(root, 0);
  return lines.join("\n");
}

// Active app context.
let activePid: number | null = null;
function requireActivePid(): number {
  if (activePid == null) throw new Error("No active app. Call focus_app (by name or pid) or launch_app first.");
  return activePid;
}

// Hash an AxNode for wait_for_stable structural comparison.
function nodeStructureHash(n: AxNode): string {
  return `${n.role}|${n.identifier || ""}|${(n.children || []).map(nodeStructureHash).join(",")}`;
}
function nodeFullHash(n: AxNode): string {
  return `${n.role}|${n.identifier || ""}|${n.title || ""}|${n.value || ""}|${(n.children || []).map(nodeFullHash).join(",")}`;
}

// Locate an element ref by selector criteria on a freshly fetched outline.
type LocatorArgs = {
  ref?: number;
  text?: string;
  role?: string;
  identifier?: string;
};

function flatten(n: AxNode): AxNode[] {
  const out: AxNode[] = [n];
  for (const c of n.children) out.push(...flatten(c));
  return out;
}

async function resolveRef(loc: LocatorArgs): Promise<{ ref: number; node: AxNode } | null> {
  if (loc.ref != null) {
    // Ref-only — no need to walk, just return placeholder; the Swift side
    // already has it in the store.
    return { ref: loc.ref, node: { ref: loc.ref, role: "", enabled: true, children: [] } };
  }
  const pid = requireActivePid();
  const root = await callHelper<AxNode>("outline", { pid, max_depth: 25, max_nodes: 4000 });
  const all = flatten(root);
  for (const n of all) {
    if (loc.identifier && n.identifier === loc.identifier) return { ref: n.ref, node: n };
    if (loc.text) {
      const t = (n.title || n.label || n.value || "").trim();
      if (t === loc.text) {
        if (!loc.role || n.role.toLowerCase().includes(loc.role.toLowerCase())) {
          return { ref: n.ref, node: n };
        }
      }
    }
  }
  // Fallback: substring match.
  if (loc.text) {
    for (const n of all) {
      const t = (n.title || n.label || n.value || "").trim();
      if (t.includes(loc.text)) {
        if (!loc.role || n.role.toLowerCase().includes(loc.role.toLowerCase())) {
          return { ref: n.ref, node: n };
        }
      }
    }
  }
  return null;
}

// Nearest-neighbor PNG downscale.
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

const Locator = {
  ref: z.number().int().optional().describe("Ref from the most recent outline()"),
  text: z.string().optional().describe("Exact text (title, label, or value)"),
  role: z.string().optional().describe("Filter by role substring (e.g. 'button', 'textfield')"),
  identifier: z.string().optional().describe("AXIdentifier — when the app sets one this is the most stable locator"),
};

// Shared step-loop (mirrors android-mcp).
export async function runSteps(
  steps: { tool: string; args?: Record<string, unknown>; skip?: boolean; on_error?: "continue" | "stop" }[],
  opts: { continue_on_error?: boolean; dry_run?: boolean; verbose?: boolean; start_at?: number; end_at?: number; only?: number } = {},
): Promise<ToolResult> {
  const { continue_on_error = false, dry_run = false, verbose = false, start_at, end_at, only } = opts;
  if (!steps.length) throw new Error("runSteps: no steps");
  const from = only != null ? only : (start_at ?? 0);
  const to = only != null ? only : (end_at != null ? end_at : steps.length - 1);
  if (from < 0 || from >= steps.length) throw new Error(`start index ${from} out of range (0..${steps.length - 1})`);
  if (to < from || to >= steps.length) throw new Error(`end index ${to} out of range (${from}..${steps.length - 1})`);
  const report: { i: number; tool: string; ok: boolean; ms: number; result_preview?: string; result?: string; error?: string }[] = [];
  for (let i = from; i <= to; i++) {
    const step = steps[i];
    if (step.skip) { report.push({ i, tool: step.tool, ok: true, ms: 0, result_preview: "skipped" }); continue; }
    if (dry_run) { report.push({ i, tool: step.tool, ok: true, ms: 0, result_preview: "(dry run)" }); continue; }
    const tool = tools.find((t) => t.name === step.tool);
    if (!tool) {
      report.push({ i, tool: step.tool, ok: false, ms: 0, error: "unknown tool" });
      if (!continue_on_error && step.on_error !== "continue") return json({ ok: false, stopped_at: i, report });
      continue;
    }
    const t0 = Date.now();
    try {
      const validated = tool.schema.parse(step.args ?? {});
      const r = await tool.handler(validated as Record<string, unknown>);
      const fullText = r.content.find((c) => c.type === "text")?.text;
      const preview = fullText?.slice(0, 200);
      if (r.isError) {
        report.push({ i, tool: step.tool, ok: false, ms: Date.now() - t0, error: preview });
        if (!continue_on_error && step.on_error !== "continue") return json({ ok: false, stopped_at: i, report });
        continue;
      }
      const entry: { i: number; tool: string; ok: boolean; ms: number; result_preview?: string; result?: string } = {
        i, tool: step.tool, ok: true, ms: Date.now() - t0,
      };
      if (verbose) entry.result = fullText; else entry.result_preview = preview;
      report.push(entry);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      report.push({ i, tool: step.tool, ok: false, ms: Date.now() - t0, error: msg });
      if (!continue_on_error && step.on_error !== "continue") return json({ ok: false, stopped_at: i, report });
    }
  }
  return json({ ok: true, steps_run: report.length, report });
}

export const tools: Tool[] = [
  // ---- Permissions ----
  {
    name: "check_permissions",
    description: "Report whether the helper binary has Accessibility + Screen Recording TCC grants. Call this first when AX returns empty trees or screenshots fail.",
    schema: z.object({}),
    handler: async () => json(await callHelper("check_permissions")),
  },
  {
    name: "open_permissions_settings",
    description: "Open System Settings to the Privacy pane you need. After flipping the toggle, restart whatever spawned the MCP — TCC is checked at process start.",
    schema: z.object({ service: z.enum(["accessibility", "screen_recording"]).default("accessibility") }),
    handler: async (args) => json(await callHelper("open_settings", args)),
  },
  {
    name: "ping",
    description: "Round-trip the Swift helper. Returns {pong:true, pid}.",
    schema: z.object({}),
    handler: async () => json(await callHelper("ping")),
  },

  // ---- App lifecycle ----
  {
    name: "list_apps",
    description: "List visible (non-background) running applications: pid, bundle_id, name, active, hidden.",
    schema: z.object({}),
    handler: async () => json(await callHelper("list_apps")),
  },
  {
    name: "focus_app",
    description: "Make an already-running app the active one. Provide pid, bundle_id, or name.",
    schema: z.object({
      pid: z.number().int().optional(),
      bundle_id: z.string().optional(),
      name: z.string().optional(),
    }),
    handler: async (args) => {
      const r = await callHelper<{ ok: boolean; pid: number; name: string }>("focus_app", args);
      activePid = r.pid;
      return text(`active app: ${r.name} (pid=${r.pid})`);
    },
  },
  {
    name: "launch_app",
    description: "Launch an app (or focus if already running). Provide bundle_id (preferred, e.g. 'com.apple.TextEdit') or name.",
    schema: z.object({ bundle_id: z.string().optional(), name: z.string().optional() }),
    handler: async (args) => {
      const r = await callHelper<{ pid: number; name: string }>("launch_app", args);
      activePid = r.pid;
      return text(`launched ${r.name} (pid=${r.pid})`);
    },
  },

  // ---- AX inspection ----
  {
    name: "outline",
    description:
      "Compact text outline of the active app's AX tree with stable refs. Refs reset each call (NOT stable across calls). " +
      "For Electron apps (Slack, Discord, VS Code, Notion, Figma desktop) the helper auto-pokes AXManualAccessibility so the tree wakes up.",
    schema: z.object({
      pid: z.number().int().optional(),
      max_depth: z.number().int().min(1).max(50).default(20),
      max_nodes: z.number().int().min(50).max(10_000).default(1500),
      raw: z.boolean().default(false),
    }),
    handler: async (args) => {
      const { pid, max_depth, max_nodes, raw } = args as { pid?: number; max_depth: number; max_nodes: number; raw: boolean };
      const usePid = pid ?? requireActivePid();
      const root = await callHelper<AxNode>("outline", { pid: usePid, max_depth, max_nodes });
      if (raw) return json(root);
      return text(renderOutline(root));
    },
  },
  {
    name: "describe",
    description: "Return all AX attributes of one element (by ref from the most recent outline). Includes supported actions.",
    schema: z.object({ ref: z.number().int() }),
    handler: async (args) => json(await callHelper("describe", args)),
  },

  // ---- Interaction ----
  {
    name: "click",
    description:
      "Click an element by ref or raw screen coordinates {x,y}. With ref the helper first tries the AX press action (works for off-screen / collapsed elements); falls back to a synthesized mouse click.",
    schema: z.object({
      ...Locator,
      x: z.number().optional(),
      y: z.number().optional(),
      button: z.enum(["left", "right"]).default("left"),
      count: z.number().int().min(1).max(3).default(1),
    }),
    handler: async (args) => {
      const a = args as LocatorArgs & { x?: number; y?: number; button: "left" | "right"; count: number };
      if (a.ref == null && (a.text || a.identifier)) {
        const hit = await resolveRef({ text: a.text, identifier: a.identifier, role: a.role });
        if (!hit) throw new Error(`click: no element matches ${JSON.stringify({ text: a.text, identifier: a.identifier, role: a.role })}`);
        a.ref = hit.ref;
      }
      const r = await callHelper("click", a as unknown as Record<string, unknown>);
      return json(r);
    },
  },
  {
    name: "fill",
    description: "Set the value of a text field / text area. Tries AXSetValue first; falls back to focus + click + synthesized typing for controls that reject it.",
    schema: z.object({
      ...Locator,
      value: z.string(),
    }),
    handler: async (args) => {
      const a = args as LocatorArgs & { value: string };
      if (a.ref == null) {
        const hit = await resolveRef({ text: a.text, identifier: a.identifier, role: a.role });
        if (!hit) throw new Error("fill: locator did not resolve");
        a.ref = hit.ref;
      }
      const r = await callHelper("fill", { ref: a.ref, value: a.value });
      return json(r);
    },
  },
  {
    name: "type_text",
    description: "Type a literal string via synthesized key events. No locator — types into whatever has keyboard focus.",
    schema: z.object({ text: z.string() }),
    handler: async (args) => json(await callHelper("type_text", args)),
  },
  {
    name: "press_key",
    description:
      "Synthesize a keypress with optional modifiers. " +
      "Letters A-Z, digits 0-9, RETURN/ENTER, TAB, SPACE, DELETE/BACKSPACE, FORWARD_DELETE, ESC/ESCAPE, " +
      "LEFT, RIGHT, UP, DOWN, HOME, END, PAGEUP, PAGEDOWN, F1..F12, " +
      "GRAVE, MINUS, EQUAL, LEFT_BRACKET, RIGHT_BRACKET, BACKSLASH, SEMICOLON, QUOTE, COMMA, PERIOD, SLASH, " +
      "CAPS_LOCK, HELP. " +
      "Modifiers: cmd/command/meta, shift, opt/option/alt, ctrl/control, fn. Examples: " +
      `press_key { key: "P", modifiers: ["cmd"] } for Cmd+P, press_key { key: "S", modifiers: ["cmd", "shift"] } for Cmd+Shift+S.`,
    schema: z.object({
      key: z.string(),
      modifiers: z.array(z.string()).default([]),
    }),
    handler: async (args) => json(await callHelper("press_key", args)),
  },
  {
    name: "hover",
    description: "Move the mouse over an element (by ref) or to raw {x,y} coordinates. No click.",
    schema: z.object({
      ref: z.number().int().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
    }),
    handler: async (args) => json(await callHelper("hover", args)),
  },
  {
    name: "scroll",
    description:
      "Scroll wheel in pixels. Negative dy = scroll content down (reveal lower content). If ref is given, the mouse is first moved over the element so the scroll lands on the right scrollable region.",
    schema: z.object({
      ref: z.number().int().optional(),
      dx: z.number().int().default(0),
      dy: z.number().int().default(-200),
    }),
    handler: async (args) => json(await callHelper("scroll", args)),
  },
  {
    name: "try_click",
    description:
      "Click if the element exists; no-op if not. For conditional UI in saved flows (permission prompts, onboarding sheets). Returns {clicked: true|false}.",
    schema: z.object(Locator),
    handler: async (args) => {
      const a = args as LocatorArgs;
      const hit = a.ref != null ? { ref: a.ref } : await resolveRef(a);
      if (!hit) return json({ clicked: false, reason: "no match" });
      try {
        await callHelper("click", { ref: hit.ref });
        return json({ clicked: true, ref: hit.ref });
      } catch (e) {
        return json({ clicked: false, reason: (e as Error).message });
      }
    },
  },
  {
    name: "wait_for_element",
    description: "Poll outline until an element matching the locator appears; return its ref. Throws on timeout.",
    schema: z.object({
      ...Locator,
      timeout_ms: z.number().int().min(100).default(10_000),
      poll_ms: z.number().int().min(50).default(500),
    }),
    handler: async (args) => {
      const { timeout_ms, poll_ms, ...loc } = args as LocatorArgs & { timeout_ms: number; poll_ms: number };
      const start = Date.now();
      const deadline = start + timeout_ms;
      let attempts = 0;
      while (Date.now() < deadline) {
        attempts++;
        const hit = await resolveRef(loc);
        if (hit) return json({ ok: true, ref: hit.ref, ms: Date.now() - start, attempts });
        await new Promise((r) => setTimeout(r, poll_ms));
      }
      throw new Error(`wait_for_element: timed out after ${timeout_ms}ms / ${attempts} attempts.`);
    },
  },
  {
    name: "wait_for_stable",
    description:
      "Poll the AX tree until it stops changing. mode='structure' compares tree shape only (use for apps with ticking timers/progress text); 'full' (default) compares titles + values too. Returns diff_hint on timeout.",
    schema: z.object({
      timeout_ms: z.number().int().min(100).default(5000),
      poll_ms: z.number().int().min(50).default(300),
      stable_polls: z.number().int().min(1).default(3),
      mode: z.enum(["full", "structure"]).default("full"),
    }),
    handler: async (args) => {
      const { timeout_ms, poll_ms, stable_polls: required, mode } = args as {
        timeout_ms: number; poll_ms: number; stable_polls: number; mode: "full" | "structure";
      };
      const pid = requireActivePid();
      const start = Date.now();
      const deadline = start + timeout_ms;
      const hashOf = mode === "structure" ? nodeStructureHash : nodeFullHash;
      let prev = "";
      let consecutive = 0;
      let polls = 0;
      let errors = 0;
      while (Date.now() < deadline) {
        polls++;
        let cur = "";
        try { cur = hashOf(await callHelper<AxNode>("outline", { pid, max_depth: 20, max_nodes: 1500 })); }
        catch { errors++; }
        if (cur && cur === prev) {
          consecutive++;
          if (consecutive >= required - 1) {
            return json({ ok: true, status: "stable", ms: Date.now() - start, polls, mode });
          }
        } else { consecutive = 0; }
        prev = cur;
        await new Promise((r) => setTimeout(r, poll_ms));
      }
      return json({ ok: false, status: "timeout", ms: Date.now() - start, polls, errors, mode, diff_hint: "tree kept changing — try mode='structure' or widen ignored attributes" });
    },
  },

  // ---- OCR-based locators (for apps with no AX tree: Zed/GPUI editors, Logic, Final Cut, Adobe, games) ----
  {
    name: "find_text",
    description:
      "OCR the current screen (or one app's foreground window when pid is set) via Apple Vision and return text hits with screen-point bounding boxes. " +
      "Use when outline returns nothing useful — most commonly for Metal-rendered editors (Zed, SuperCodeEditor), Logic Pro, Final Cut, Adobe canvases, games. " +
      "Filter by `text` (case-insensitive substring) or pass empty to get every recognized string.",
    schema: z.object({
      pid: z.number().int().optional().describe("Restrict capture to this app's foreground window. Falls back to full display if not found."),
      text: z.string().default("").describe("Substring to filter for (case-insensitive). Empty = return all hits."),
      accurate: z.boolean().default(true).describe("true = Vision's accurate recognizer (~80ms, better for code/UI). false = fast recognizer."),
    }),
    handler: async (args) => json(await callHelper("find_text", args)),
  },
  {
    name: "click_text",
    description:
      "OCR the screen, find a text match, click its centre. " +
      "Companion to `find_text`. When more than one match exists, pass `occurrence_index` (0-based, top-to-bottom-ish — depends on Vision's ordering). " +
      "Returns the matched string + coordinates clicked, plus a list of nearby OCR hits on miss so the agent can retarget without another round-trip.",
    schema: z.object({
      text: z.string().min(1),
      pid: z.number().int().optional(),
      occurrence_index: z.number().int().min(0).default(0),
      exact: z.boolean().default(false).describe("true = exact string equality (case-sensitive). false = case-insensitive substring."),
    }),
    handler: async (args) => json(await callHelper("click_text", args)),
  },

  // ---- Capture ----
  {
    name: "screenshot",
    description: "PNG screenshot via ScreenCaptureKit. Captures the active display; pass pid to capture one app's windows. Auto-downscales to fit the 2000px MCP cap.",
    schema: z.object({
      pid: z.number().int().optional(),
      max_dim: z.number().int().min(256).max(2000).default(1600),
    }),
    handler: async (args) => {
      const { pid, max_dim } = args as { pid?: number; max_dim: number };
      const r = await callHelper<{ png_base64: string }>("screenshot", pid ? { pid } : {});
      const resized = resizePngBase64(r.png_base64, max_dim);
      return { content: [{ type: "image", data: resized, mimeType: "image/png" }] };
    },
  },

  // ---- Debug pause ----
  {
    name: "pause",
    description: "Pause the agent. Prints a message to stderr; blocks until the user touches the resume_file (default /tmp/macos-mcp.resume). Times out after timeout_ms.",
    schema: z.object({
      message: z.string().optional(),
      resume_file: z.string().default("/tmp/macos-mcp.resume"),
      timeout_ms: z.number().int().min(0).default(300_000),
    }),
    handler: async (args) => {
      const { message, resume_file, timeout_ms } = args as { message?: string; resume_file: string; timeout_ms: number };
      // eslint-disable-next-line no-console
      console.error(`[macos-mcp] PAUSE${message ? ": " + message : ""}. Resume: touch ${resume_file}`);
      const deadline = Date.now() + timeout_ms;
      while (Date.now() < deadline) {
        try { readFileSync(resume_file); unlinkSync(resume_file); return text("resumed"); } catch { /* not yet */ }
        await new Promise((r) => setTimeout(r, 400));
      }
      return text("pause timed out");
    },
  },

  // ---- Flow recording ----
  {
    name: "start_recording",
    description: "Begin recording tool calls to a flow file.",
    schema: z.object({ path: z.string().optional() }),
    handler: async (args) => { startRecording((args as { path?: string }).path); return text("recording started"); },
  },
  {
    name: "stop_recording",
    description: "Stop recording and return the captured entries.",
    schema: z.object({}),
    handler: async () => json(stopRecording()),
  },
  {
    name: "recording_status",
    description: "Is recording active?",
    schema: z.object({}),
    handler: async () => json(recorderStatus()),
  },

  // ---- run_script + save_flow + list/delete ----
  {
    name: "run_script",
    description:
      "Execute a JSON flow of MCP tool calls inline, or from a saved file. Step shape: {tool, args?, skip?, on_error?}. Stops on first failure by default; set continue_on_error to keep going.",
    schema: z.object({
      path: z.string().optional(),
      script: z.object({
        steps: z.array(z.object({ tool: z.string(), args: z.record(z.any()).optional(), skip: z.boolean().optional(), on_error: z.enum(["continue", "stop"]).optional() })).optional(),
        entries: z.array(z.object({ tool: z.string(), args: z.record(z.any()).optional() })).optional(),
      }).optional(),
      continue_on_error: z.boolean().default(false),
      dry_run: z.boolean().default(false),
      start_at: z.number().int().min(0).optional(),
      end_at: z.number().int().min(0).optional(),
      only: z.number().int().min(0).optional(),
      verbose: z.boolean().default(false),
    }),
    handler: async (args) => {
      const { path, script, continue_on_error, dry_run, start_at, end_at, only, verbose } = args as {
        path?: string; script?: { steps?: { tool: string; args?: Record<string, unknown>; skip?: boolean; on_error?: "continue" | "stop" }[]; entries?: { tool: string; args?: Record<string, unknown> }[] };
        continue_on_error: boolean; dry_run: boolean; start_at?: number; end_at?: number; only?: number; verbose: boolean;
      };
      const parsed = path ? JSON.parse(readFileSync(path, "utf8")) : script;
      if (!parsed) throw new Error("run_script: provide path or script");
      const steps = parsed.steps ?? parsed.entries ?? [];
      return runSteps(steps, { continue_on_error, dry_run, verbose, start_at, end_at, only });
    },
  },
  {
    name: "save_flow",
    description: `Persist a sequence of steps as a named MCP tool. Lowercase [a-z0-9_], 3-50 chars. Cap: ${FLOW_CAP} saved flows total. Steps may use {{param}} placeholders.`,
    schema: z.object({
      name: z.string(),
      description: z.string().min(1).max(500),
      params: z.array(z.object({
        name: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/),
        type: z.enum(["string", "number", "boolean"]).default("string"),
        description: z.string().optional(),
        required: z.boolean().optional(),
      })).max(20).optional(),
      steps: z.array(z.object({
        tool: z.string(),
        args: z.record(z.any()).optional(),
        skip: z.boolean().optional(),
        on_error: z.enum(["continue", "stop"]).optional(),
      }).strict()).min(1).max(200),
      overwrite: z.boolean().default(false),
    }),
    handler: async (args) => {
      const a = args as {
        name: string; description: string;
        params?: { name: string; type: "string" | "number" | "boolean"; description?: string; required?: boolean }[];
        steps: { tool: string; args?: Record<string, unknown>; skip?: boolean; on_error?: "continue" | "stop" }[];
        overwrite: boolean;
      };
      if (!FLOW_NAME_RE.test(a.name)) throw new Error(`Invalid flow name "${a.name}" — must match ${FLOW_NAME_RE.source}`);
      if (RESERVED_TOOL_NAMES.has(a.name)) throw new Error(`Name "${a.name}" collides with a built-in tool.`);
      const existingIdx = tools.findIndex((t) => t.name === a.name);
      const existingIsFlow = existingIdx >= 0 && savedFlowNames.has(a.name);
      if (existingIdx >= 0 && !existingIsFlow) throw new Error(`Tool "${a.name}" already exists.`);
      if (existingIsFlow && !a.overwrite) throw new Error(`Flow "${a.name}" already exists. Pass overwrite: true.`);
      if (!existingIsFlow && savedFlowNames.size >= FLOW_CAP) throw new Error(`At ${FLOW_CAP} saved flows already — delete one first.`);
      for (const s of a.steps) {
        if (!tools.find((t) => t.name === s.tool) && s.tool !== a.name) {
          throw new Error(`Step references unknown tool "${s.tool}".`);
        }
      }
      writeFlow({ name: a.name, description: a.description, params: a.params, steps: a.steps });
      const tool = flowAsTool({ name: a.name, description: a.description, params: a.params, steps: a.steps });
      if (existingIdx >= 0) tools[existingIdx] = tool; else tools.push(tool);
      savedFlowNames.add(a.name);
      emitToolsChanged();
      return text(`saved flow "${a.name}" (${a.steps.length} steps).`);
    },
  },
  {
    name: "list_flows",
    description: "List saved flows.",
    schema: z.object({}),
    handler: async () => {
      const docs = listFlowDocs();
      return json(docs.map((d) => ({
        name: d.name, description: d.description, steps: d.steps.length,
        params: d.params?.map((p) => p.name) ?? [], saved_at: d.saved_at,
      })));
    },
  },
  {
    name: "delete_flow",
    description: "Delete a saved flow.",
    schema: z.object({ name: z.string() }),
    handler: async (args) => {
      const { name } = args as { name: string };
      if (!savedFlowNames.has(name)) throw new Error(`No saved flow named "${name}".`);
      deleteFlowFile(name);
      const idx = tools.findIndex((t) => t.name === name);
      if (idx >= 0) tools.splice(idx, 1);
      savedFlowNames.delete(name);
      emitToolsChanged();
      return text(`deleted flow "${name}"`);
    },
  },

  // ---- Feedback ----
  {
    name: "send_feedback",
    description:
      "Send feedback about macos-mcp itself — bugs, missing tools, surprising behavior, or 'this would be easier if'. Opens a GitHub issue. " +
      "Filed via the user's local `gh` CLI when authenticated (so the issue is authored under their account); falls back to a shared bot otherwise. " +
      "Auto-attaches product+version and recent tool calls as context. Do NOT use for app-level bugs in the target app.",
    schema: z.object({
      message: z.string().min(1).max(8000),
      severity: z.enum(["bug", "missing", "idea", "praise"]).default("idea"),
      include_recent_calls: z.boolean().default(true),
    }),
    handler: async (args) => {
      const { message, severity, include_recent_calls } = args as { message: string; severity: "bug" | "missing" | "idea" | "praise"; include_recent_calls: boolean };
      const endpoint = process.env.MACOS_MCP_FEEDBACK_ENDPOINT || process.env.MACOS_MCP_ENDPOINT || "https://chrome-mcp.actuallyroy.com";
      const context: Record<string, unknown> = {};
      if (include_recent_calls) {
        context.recent_calls = getRecentCalls().map((c) => ({ tool: c.tool, ok: c.ok, args: c.args, result_preview: c.result_preview, ts: new Date(c.ts).toISOString() }));
      }
      const r = await fileFeedback({ message, severity, product: "macos", version: VERSION, context, endpoint });
      const via = r.authored_by === "user" ? "via your gh CLI" : "via shared bot (install gh + auth to file as yourself)";
      return text(`filed issue #${r.issue_number} ${via} — ${r.url}`);
    },
  },
];

const savedFlowNames = new Set<string>();
let RESERVED_TOOL_NAMES: Set<string> = new Set();

export function loadSavedFlows(): { loaded: number; skipped: number } {
  RESERVED_TOOL_NAMES = new Set(tools.map((t) => t.name));
  let loaded = 0;
  let skipped = 0;
  for (const doc of listFlowDocs()) {
    if (!FLOW_NAME_RE.test(doc.name) || RESERVED_TOOL_NAMES.has(doc.name)) { skipped++; continue; }
    if (savedFlowNames.size >= FLOW_CAP) { skipped++; continue; }
    tools.push(flowAsTool(doc));
    savedFlowNames.add(doc.name);
    loaded++;
  }
  return { loaded, skipped };
}
