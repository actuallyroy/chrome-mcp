import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
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
import { callHelper, getHelperFor, HelperTarget } from "./helper.js";
import {
  getRecentCalls,
  recorderStatus,
  startRecording,
  stopRecording,
} from "./recorder.js";
import { startSandbox, stopSandbox, statusVerified as sandboxStatus, workspaceHostDir, WORKSPACE_SANDBOX_PATH } from "./sandbox.js";
import { copyFileSync, mkdirSync } from "node:fs";
import { basename, isAbsolute } from "node:path";

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
export const VERSION = "0.1.0";

const DEFAULT_RESUME_FILE = joinPath(tmpdir(), "windows-mcp.resume");

// Every tool that talks to the helper accepts an optional `target` arg.
// "host" (default) drives the user's main desktop; "sandbox" drives the
// auto-spawned Windows Sandbox (only available when WINDOWS_MCP_SANDBOX=1
// is set in the .mcp.json env block). Per-call rather than global so a
// transcript is unambiguous about which desktop each call ran against.
const Target = {
  target: z.enum(["host", "sandbox"]).default("host").describe(
    "Where to dispatch this call: 'host' (default, your normal desktop) or 'sandbox' " +
    "(in-Windows-Sandbox helper, requires WINDOWS_MCP_SANDBOX=1 in .mcp.json env).",
  ),
};

function getTarget(args: Record<string, unknown>): HelperTarget {
  const t = args.target;
  return t === "sandbox" ? "sandbox" : "host";
}

// Helper-call shorthand that respects per-call target.
async function rpc<T = unknown>(args: Record<string, unknown>, method: string, params: Record<string, unknown> = {}): Promise<T> {
  const helper = await getHelperFor(getTarget(args));
  return helper.call<T>(method, params);
}

// ---- UIA outline renderer ---------------------------------------------------

type UiaNode = {
  ref: number;
  role: string;             // UIA control type, e.g. "Button", "Edit", "Document"
  role_description?: string | null;
  title?: string | null;    // AutomationProperties.Name
  value?: string | null;    // ValuePattern.Value / RangeValuePattern.Value
  label?: string | null;    // HelpText / LabeledBy text
  identifier?: string | null; // AutomationId
  enabled: boolean;
  position?: [number, number] | null;
  size?: [number, number] | null;
  children: UiaNode[];
};

// Control types that are almost always pure structure with no semantic value.
const NOISY_ROLES = new Set(["Unknown", "Custom"]);

function nodeIsInteresting(n: UiaNode): boolean {
  if (NOISY_ROLES.has(n.role)) return false;
  if (n.title || n.value || n.label || n.identifier) return true;
  if (n.children.length > 0) return true;
  // Containers / pure-text leaves with no labels add noise — skip.
  if (n.role === "Group" || n.role === "Pane" || n.role === "Text") return false;
  return true;
}

function renderOutline(root: UiaNode): string {
  const lines: string[] = [];
  function walk(n: UiaNode, depth: number) {
    if (!nodeIsInteresting(n)) {
      for (const c of n.children) walk(c, depth);
      return;
    }
    const indent = "  ".repeat(depth);
    const role = n.role.toLowerCase();
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

// Active app context — tracked per target since the user may have focus_app'd
// different apps on host vs in the sandbox.
const activePidByTarget: Record<HelperTarget, number | null> = { host: null, sandbox: null };
function requireActivePid(target: HelperTarget): number {
  const pid = activePidByTarget[target];
  if (pid == null) throw new Error(`No active app on target='${target}'. Call focus_app (by name, exe_path, or pid) or launch_app first.`);
  return pid;
}

// Hash a UiaNode for wait_for_stable structural comparison.
function nodeStructureHash(n: UiaNode): string {
  return `${n.role}|${n.identifier || ""}|${(n.children || []).map(nodeStructureHash).join(",")}`;
}
function nodeFullHash(n: UiaNode): string {
  return `${n.role}|${n.identifier || ""}|${n.title || ""}|${n.value || ""}|${(n.children || []).map(nodeFullHash).join(",")}`;
}

// Locate an element ref by selector criteria on a freshly fetched outline.
type LocatorArgs = {
  ref?: number;
  text?: string;
  role?: string;
  identifier?: string;
};

function flatten(n: UiaNode): UiaNode[] {
  const out: UiaNode[] = [n];
  for (const c of n.children) out.push(...flatten(c));
  return out;
}

async function resolveRef(target: HelperTarget, loc: LocatorArgs): Promise<{ ref: number; node: UiaNode } | null> {
  if (loc.ref != null) {
    return { ref: loc.ref, node: { ref: loc.ref, role: "", enabled: true, children: [] } };
  }
  const pid = requireActivePid(target);
  const helper = await getHelperFor(target);
  const root = await helper.call<UiaNode>("outline", { pid, max_depth: 25, max_nodes: 4000 });
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

// Nearest-neighbor PNG downscale. Returns the (possibly resized) base64 plus
// the native + shown dimensions so callers can map screenshot pixels back to
// real screen coordinates for clicking (clicks use native pixels; the image
// may be downscaled to fit the MCP size cap).
type ResizedPng = { b64: string; nativeW: number; nativeH: number; shownW: number; shownH: number; scale: number };
function resizePngBase64(b64: string, maxDim: number): ResizedPng {
  const src = PNG.sync.read(Buffer.from(b64, "base64"));
  const longest = Math.max(src.width, src.height);
  if (longest <= maxDim) {
    return { b64, nativeW: src.width, nativeH: src.height, shownW: src.width, shownH: src.height, scale: 1 };
  }
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
  return { b64: PNG.sync.write(dst).toString("base64"), nativeW: src.width, nativeH: src.height, shownW: dw, shownH: dh, scale };
}

const Locator = {
  ref: z.number().int().optional().describe("Ref from the most recent outline()"),
  text: z.string().optional().describe("Exact text (Name, HelpText, or value)"),
  role: z.string().optional().describe("Filter by UIA control type substring (e.g. 'button', 'edit', 'listitem')"),
  identifier: z.string().optional().describe("AutomationId — when the app sets one this is the most stable locator"),
};

// Accept both the bare tool name ("press_key") and the fully-qualified
// MCP form ("mcp__windows__press_key") in flow steps — every other surface
// of this MCP is addressed with the prefixed form, so requiring the short
// name only in run_script/save_flow was a surprising inconsistency.
function normalizeToolName(name: string): string {
  return name.replace(/^mcp__[a-z0-9_]+__/i, "");
}

// Shared step-loop (mirrors android-mcp / macos-mcp).
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
    const tool = tools.find((t) => t.name === normalizeToolName(step.tool));
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
  // ---- Permissions / diagnostics ----
  {
    name: "check_permissions",
    description:
      "Report whether the helper has what it needs: UIA reachable, screen capture working, current DPI awareness, elevation status, UIAccess manifest flag. " +
      "Windows has no per-app TCC like macOS, but if the *target* app runs elevated and we don't, we'll be denied UIA inspection of it — call this when outline returns empty for an obviously-running app.",
    schema: z.object({ ...Target }),
    handler: async (args) => json(await rpc(args, "check_permissions")),
  },
  {
    name: "open_permissions_settings",
    description: "Open the relevant Settings pane. 'privacy' opens Privacy → General; 'apps' opens Apps & features (useful for uninstalling/repairing a flaky target).",
    schema: z.object({ ...Target, service: z.enum(["privacy", "apps", "display"]).default("privacy") }),
    handler: async (args) => {
      const { service } = args as { service: string };
      return json(await rpc(args, "open_settings", { service }));
    },
  },
  {
    name: "ping",
    description: "Round-trip the C# helper. Returns {pong:true, pid}.",
    schema: z.object({ ...Target }),
    handler: async (args) => json(await rpc(args, "ping")),
  },
  {
    name: "version",
    description: "Return the running windows-mcp server version. Takes no arguments. Useful for confirming you're not on a stale bundle.",
    schema: z.object({}),
    handler: async () => json({ version: VERSION }),
  },

  // ---- App lifecycle ----
  {
    name: "list_apps",
    description: "List visible top-level windows with their owning process: pid, exe_path, name (window title), active, hidden (minimized).",
    schema: z.object({ ...Target }),
    handler: async (args) => json(await rpc(args, "list_apps")),
  },
  {
    name: "focus_app",
    description: "Make an already-running app the foreground one. Provide pid, exe_path, or name (window title substring, case-insensitive).",
    schema: z.object({
      ...Target,
      pid: z.number().int().optional(),
      exe_path: z.string().optional(),
      name: z.string().optional(),
    }),
    handler: async (args) => {
      const target = getTarget(args);
      const { pid, exe_path, name } = args as { pid?: number; exe_path?: string; name?: string };
      const r = await rpc<{ ok: boolean; pid: number; name: string }>(args, "focus_app", { pid, exe_path, name });
      activePidByTarget[target] = r.pid;
      return text(`active app on ${target}: ${r.name} (pid=${r.pid})`);
    },
  },
  {
    name: "launch_app",
    description:
      "Start an app (or focus if already running). Provide exe_path (absolute or anything on PATH, e.g. 'notepad.exe', 'C:\\Program Files\\…\\App.exe'), " +
      "shell URI ('ms-settings:'), or AppUserModelID ('Microsoft.WindowsNotepad_8wekyb3d8bbwe!App') via the appid field. " +
      "name fallback resolves via Start Menu shortcut lookup. " +
      "When target='sandbox', exe_path must be a sandbox path — typically inside C:\\proj\\ which is mapped from your project dir.",
    schema: z.object({
      ...Target,
      exe_path: z.string().optional(),
      appid: z.string().optional().describe("AppUserModelID for UWP/packaged apps"),
      name: z.string().optional(),
      args: z.string().optional().describe("Command-line args appended after the exe"),
    }),
    handler: async (args) => {
      const target = getTarget(args);
      const { exe_path, appid, name, args: cmdArgs } = args as { exe_path?: string; appid?: string; name?: string; args?: string };
      const r = await rpc<{ pid: number; name: string }>(args, "launch_app", { exe_path, appid, name, args: cmdArgs });
      activePidByTarget[target] = r.pid;
      return text(`launched on ${target}: ${r.name} (pid=${r.pid})`);
    },
  },

  // ---- UIA inspection ----
  {
    name: "outline",
    description:
      "Compact text outline of the active app's UI Automation tree with stable refs. Refs reset each call (NOT stable across calls). " +
      "Returns the same tree shape as Inspect.exe / Accessibility Insights but flattened to a one-line-per-element format.",
    schema: z.object({
      ...Target,
      pid: z.number().int().optional(),
      max_depth: z.number().int().min(1).max(50).default(20),
      max_nodes: z.number().int().min(50).max(10_000).default(1500),
      raw: z.boolean().default(false),
    }),
    handler: async (args) => {
      const target = getTarget(args);
      const { pid, max_depth, max_nodes, raw } = args as { pid?: number; max_depth: number; max_nodes: number; raw: boolean };
      const usePid = pid ?? requireActivePid(target);
      const root = await rpc<UiaNode>(args, "outline", { pid: usePid, max_depth, max_nodes });
      if (raw) return json(root);
      return text(renderOutline(root));
    },
  },
  {
    name: "describe",
    description: "Return every UIA property of one element (by ref from the most recent outline). Includes supported control patterns + invokable actions.",
    schema: z.object({ ...Target, ref: z.number().int() }),
    handler: async (args) => {
      const { ref } = args as { ref: number };
      return json(await rpc(args, "describe", { ref }));
    },
  },

  // ---- Interaction ----
  {
    name: "click",
    description:
      "Click an element by ref or raw screen coordinates {x,y}. With ref the helper first tries the UIA InvokePattern (works for off-screen / collapsed elements); falls back to SelectionItemPattern / ExpandCollapsePattern / TogglePattern, then to a synthesized mouse click.",
    schema: z.object({
      ...Target,
      ...Locator,
      x: z.number().optional(),
      y: z.number().optional(),
      button: z.enum(["left", "right"]).default("left"),
      count: z.number().int().min(1).max(3).default(1),
    }),
    handler: async (args) => {
      const target = getTarget(args);
      const a = args as LocatorArgs & { x?: number; y?: number; button: "left" | "right"; count: number };
      if (a.ref == null && (a.text || a.identifier)) {
        const hit = await resolveRef(target, { text: a.text, identifier: a.identifier, role: a.role });
        if (!hit) throw new Error(`click: no element matches ${JSON.stringify({ text: a.text, identifier: a.identifier, role: a.role })}`);
        a.ref = hit.ref;
      }
      const r = await rpc(args, "click", { ref: a.ref, x: a.x, y: a.y, button: a.button, count: a.count });
      return json(r);
    },
  },
  {
    name: "fill",
    description: "Set the value of a text field / text area. Tries ValuePattern.SetValue first; falls back to focus + select-all + type for controls that reject it.",
    schema: z.object({
      ...Target,
      ...Locator,
      value: z.string(),
    }),
    handler: async (args) => {
      const target = getTarget(args);
      const a = args as LocatorArgs & { value: string };
      if (a.ref == null) {
        const hit = await resolveRef(target, { text: a.text, identifier: a.identifier, role: a.role });
        if (!hit) throw new Error("fill: locator did not resolve");
        a.ref = hit.ref;
      }
      return json(await rpc(args, "fill", { ref: a.ref, value: a.value }));
    },
  },
  {
    name: "type_text",
    description: "Type a literal string via synthesized key events. No locator — types into whatever has keyboard focus.",
    schema: z.object({ ...Target, text: z.string() }),
    handler: async (args) => {
      const { text: t } = args as { text: string };
      return json(await rpc(args, "type_text", { text: t }));
    },
  },
  {
    name: "press_key",
    description:
      "Synthesize a keypress with optional modifiers. " +
      "Letters A-Z, digits 0-9, ENTER/RETURN, TAB, SPACE, BACKSPACE, DELETE, ESC/ESCAPE, " +
      "LEFT, RIGHT, UP, DOWN, HOME, END, PAGEUP, PAGEDOWN, INSERT, F1..F24, " +
      "GRAVE, MINUS, EQUAL, LEFT_BRACKET, RIGHT_BRACKET, BACKSLASH, SEMICOLON, QUOTE, COMMA, PERIOD, SLASH, " +
      "NUMPAD0..NUMPAD9, NUMPAD_ADD, NUMPAD_SUBTRACT, NUMPAD_MULTIPLY, NUMPAD_DIVIDE, NUMPAD_DECIMAL, " +
      "CAPS_LOCK, NUM_LOCK, SCROLL_LOCK, PRINT_SCREEN, PAUSE, APPS (context menu key). " +
      "Modifiers: ctrl/control, shift, alt/menu, win/super/meta. Examples: " +
      `press_key { key: "S", modifiers: ["ctrl"] } for Ctrl+S, press_key { key: "TAB", modifiers: ["alt"] } for Alt+Tab, press_key { key: "D", modifiers: ["win"] } to show desktop.`,
    schema: z.object({
      ...Target,
      key: z.string(),
      modifiers: z.array(z.string()).default([]),
    }),
    handler: async (args) => {
      const { key, modifiers } = args as { key: string; modifiers: string[] };
      return json(await rpc(args, "press_key", { key, modifiers }));
    },
  },
  {
    name: "hover",
    description: "Move the mouse over an element (by ref) or to raw {x,y} coordinates. No click.",
    schema: z.object({
      ...Target,
      ref: z.number().int().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
    }),
    handler: async (args) => {
      const { ref, x, y } = args as { ref?: number; x?: number; y?: number };
      return json(await rpc(args, "hover", { ref, x, y }));
    },
  },
  {
    name: "scroll",
    description:
      "Scroll wheel. Negative dy = scroll content down (reveal lower content). One wheel notch = 120 units (WHEEL_DELTA). " +
      "If ref is given, the mouse is first moved over the element so the scroll lands on the right scrollable region.",
    schema: z.object({
      ...Target,
      ref: z.number().int().optional(),
      dx: z.number().int().default(0),
      dy: z.number().int().default(-240),
    }),
    handler: async (args) => {
      const { ref, dx, dy } = args as { ref?: number; dx: number; dy: number };
      return json(await rpc(args, "scroll", { ref, dx, dy }));
    },
  },
  {
    name: "try_click",
    description:
      "Click if the element exists; no-op if not. For conditional UI in saved flows (UAC prompts may need elevation, onboarding sheets, update banners). Returns {clicked: true|false}.",
    schema: z.object({ ...Target, ...Locator }),
    handler: async (args) => {
      const target = getTarget(args);
      const a = args as LocatorArgs;
      const hit = a.ref != null ? { ref: a.ref } : await resolveRef(target, a);
      if (!hit) return json({ clicked: false, reason: "no match" });
      try {
        await rpc(args, "click", { ref: hit.ref });
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
      ...Target,
      ...Locator,
      timeout_ms: z.number().int().min(100).default(10_000),
      poll_ms: z.number().int().min(50).default(500),
    }),
    handler: async (args) => {
      const target = getTarget(args);
      const { timeout_ms, poll_ms, ...loc } = args as LocatorArgs & { timeout_ms: number; poll_ms: number };
      const start = Date.now();
      const deadline = start + timeout_ms;
      let attempts = 0;
      while (Date.now() < deadline) {
        attempts++;
        const hit = await resolveRef(target, loc);
        if (hit) return json({ ok: true, ref: hit.ref, ms: Date.now() - start, attempts });
        await new Promise((r) => setTimeout(r, poll_ms));
      }
      throw new Error(`wait_for_element: timed out after ${timeout_ms}ms / ${attempts} attempts.`);
    },
  },
  {
    name: "wait_for_stable",
    description:
      "Poll the UIA tree until it stops changing. mode='structure' compares tree shape only (use for apps with ticking timers/progress text); 'full' (default) compares names + values too. Returns diff_hint on timeout.",
    schema: z.object({
      ...Target,
      timeout_ms: z.number().int().min(100).default(5000),
      poll_ms: z.number().int().min(50).default(300),
      stable_polls: z.number().int().min(1).default(3),
      mode: z.enum(["full", "structure"]).default("full"),
    }),
    handler: async (args) => {
      const target = getTarget(args);
      const { timeout_ms, poll_ms, stable_polls: required, mode } = args as {
        timeout_ms: number; poll_ms: number; stable_polls: number; mode: "full" | "structure";
      };
      const pid = requireActivePid(target);
      const helper = await getHelperFor(target);
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
        try { cur = hashOf(await helper.call<UiaNode>("outline", { pid, max_depth: 20, max_nodes: 1500 })); }
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

  // ---- OCR-based locators (for apps with no UIA tree: Electron without ARIA, custom-drawn canvases, games) ----
  {
    name: "find_text",
    description:
      "OCR the current screen (or one app's foreground window when pid is set) via Windows.Media.Ocr and return text hits with screen-point bounding boxes. " +
      "Use when outline returns nothing useful — most commonly for games, Adobe canvases, custom-drawn editors, and any DirectX/Metal-style render surface. " +
      "Filter by `text` (case-insensitive substring) or pass empty to get every recognized string.",
    schema: z.object({
      ...Target,
      pid: z.number().int().optional().describe("Restrict capture to this app's foreground window. Falls back to full display if not found."),
      text: z.string().default("").describe("Substring to filter for (case-insensitive). Empty = return all hits."),
      language: z.string().default("en-US").describe("BCP-47 language tag. Windows.Media.Ocr ships with a Languages list; en-US is always available."),
    }),
    handler: async (args) => {
      const { pid, text: t, language } = args as { pid?: number; text: string; language: string };
      return json(await rpc(args, "find_text", { pid, text: t, language }));
    },
  },
  {
    name: "click_text",
    description:
      "OCR the screen, find a text match, click its centre. " +
      "Companion to `find_text`. When more than one match exists, pass `occurrence_index` (0-based, top-to-bottom-ish). " +
      "Returns the matched string + coordinates clicked, plus a list of nearby OCR hits on miss so the agent can retarget without another round-trip.",
    schema: z.object({
      ...Target,
      text: z.string().min(1),
      pid: z.number().int().optional(),
      occurrence_index: z.number().int().min(0).default(0),
      exact: z.boolean().default(false).describe("true = exact string equality (case-sensitive). false = case-insensitive substring."),
      language: z.string().default("en-US"),
    }),
    handler: async (args) => {
      const { text: t, pid, occurrence_index, exact, language } = args as { text: string; pid?: number; occurrence_index: number; exact: boolean; language: string };
      return json(await rpc(args, "click_text", { text: t, pid, occurrence_index, exact, language }));
    },
  },

  // ---- Capture ----
  {
    name: "screenshot",
    description: "PNG screenshot via the Desktop Duplication / GDI path. Captures the primary display; pass pid to capture one app's foreground window. Auto-downscales to fit the 2000px MCP cap.",
    schema: z.object({
      ...Target,
      pid: z.number().int().optional(),
      max_dim: z.number().int().min(256).max(2000).default(1600),
    }),
    handler: async (args) => {
      const { pid, max_dim } = args as { pid?: number; max_dim: number };
      const r = await rpc<{ png_base64: string }>(args, "screenshot", pid ? { pid } : {});
      const out = resizePngBase64(r.png_base64, max_dim);
      const content: ToolResult["content"] = [
        { type: "image", data: out.b64, mimeType: "image/png" },
      ];
      // When the image was downscaled, tell the agent how to map image pixels
      // to real screen coords for click {x,y}: screen = image / scale.
      if (out.scale !== 1) {
        content.push({
          type: "text",
          text:
            `image ${out.shownW}x${out.shownH}, native ${out.nativeW}x${out.nativeH}, scale ${out.scale.toFixed(4)}. ` +
            `To click something seen at image pixel (ix,iy): click x=round(ix/${out.scale.toFixed(4)}), y=round(iy/${out.scale.toFixed(4)}).`,
        });
      }
      return { content };
    },
  },

  // ---- Sandbox lifecycle ----
  {
    name: "start_sandbox",
    description:
      "(Re)spawn the Windows Sandbox. The sandbox is auto-spawned on MCP connect when WINDOWS_MCP_SANDBOX=1 is set in your .mcp.json env block, so this tool is primarily for **restarting** after the user manually closed the sandbox window. Returns the helper's TCP endpoint inside the sandbox. " +
      "project_dir overrides WINDOWS_MCP_SANDBOX_PROJECT for this session. read_only defaults to true; pass false to let the in-sandbox helper write build artifacts back to your host project tree.",
    schema: z.object({
      project_dir: z.string().optional().describe("Absolute host path to mount as C:\\proj inside the sandbox."),
      read_only: z.boolean().default(true).describe("Mount project_dir read-only. Set false to let the sandbox write back to host — confirms you trust your own build output."),
    }),
    handler: async (args) => {
      const { project_dir, read_only } = args as { project_dir?: string; read_only: boolean };
      const s = await startSandbox({ project_dir, read_only });
      return json(s);
    },
  },
  {
    name: "install",
    description:
      "Install (or just run) an application INSIDE the sandbox — never touches your host. " +
      "Give `installer` as a host path (it's copied into the live-mounted workspace, then run in the sandbox) or a sandbox-side path (C:\\work\\… or C:\\proj\\…, run in place). " +
      ".msi files are auto-wrapped with `msiexec /i … /qn`. For setup.exe installers pass the silent flag in `args` (e.g. '/S', '/VERYSILENT'); without it the installer runs with a GUI you can then drive via outline/click. " +
      "Returns the process exit code + captured output. NOTE: the sandbox is disposable — an install lasts only for this sandbox's lifetime, and an installer that requires a reboot to finish won't complete on Windows 10.",
    schema: z.object({
      installer: z.string().describe("Host path to an .exe/.msi (copied into the sandbox workspace) OR an existing sandbox path."),
      args: z.string().optional().describe("Silent-install flags. .msi defaults to /qn; .exe has no default (pass /S etc. or omit to drive the GUI)."),
      wait: z.boolean().default(true).describe("Wait for the installer to exit and capture its result. Set false to fire-and-forget (e.g. to drive a GUI installer yourself)."),
      timeout_ms: z.number().int().min(1000).max(1_800_000).default(180_000),
    }),
    handler: async (args) => {
      const a = args as { installer: string; args?: string; wait: boolean; timeout_ms: number };
      // Resolve a sandbox-visible path. A host path that exists on disk gets
      // copied into the workspace (live-mounted at C:\work); anything else is
      // assumed to already be a sandbox path.
      let sandboxPath: string;
      if (isAbsolute(a.installer) && existsSync(a.installer)) {
        const ws = workspaceHostDir();
        mkdirSync(ws, { recursive: true });
        const name = basename(a.installer);
        copyFileSync(a.installer, joinPath(ws, name));
        sandboxPath = `${WORKSPACE_SANDBOX_PATH}\\${name}`;
      } else {
        sandboxPath = a.installer;
      }
      // Build the run command: .msi → msiexec; otherwise run the exe directly.
      let exe: string;
      let runArgs: string;
      if (sandboxPath.toLowerCase().endsWith(".msi")) {
        exe = "msiexec.exe";
        runArgs = `/i "${sandboxPath}" ${a.args ?? "/qn"}`.trim();
      } else {
        exe = sandboxPath;
        runArgs = a.args ?? "";
      }
      const helper = await getHelperFor("sandbox");
      const result = await helper.call("run_process", { exe, args: runArgs, wait: a.wait, timeout_ms: a.timeout_ms });
      return json({ ran: { exe, args: runArgs }, sandbox_path: sandboxPath, result });
    },
  },
  {
    name: "stop_sandbox",
    description: "Close the active sandbox and tear down its TCP transport. Idempotent.",
    schema: z.object({}),
    handler: async () => json(await stopSandbox()),
  },
  {
    name: "sandbox_status",
    description: "Report whether a sandbox is currently active, its helper TCP endpoint, the mounted project_dir, and when it booted. Pings the helper to verify liveness — won't report a dead/closed sandbox as active.",
    schema: z.object({}),
    handler: async () => json(await sandboxStatus()),
  },

  // ---- Timing primitive ----
  {
    name: "wait",
    description:
      "Sleep for ms milliseconds. Use to give the UI time to settle after a focus / open / navigation step before the next click or type — most app responses are async, so back-to-back interaction calls often race. " +
      "Most flows need 100-400 ms. Tools that touch the screen state (click, focus_app, press_key opening a panel) typically need a `wait` before the follow-up type_text / click.",
    schema: z.object({ ms: z.number().int().min(1).max(60_000) }),
    handler: async (args) => {
      const { ms } = args as { ms: number };
      await new Promise((r) => setTimeout(r, ms));
      return text(`waited ${ms}ms`);
    },
  },

  // ---- Debug pause ----
  {
    name: "pause",
    description:
      "Pause the agent. Prints a message to stderr; blocks until the user creates the resume_file (default %TEMP%\\windows-mcp.resume). " +
      "Times out after timeout_ms.",
    schema: z.object({
      message: z.string().optional(),
      resume_file: z.string().default(DEFAULT_RESUME_FILE),
      timeout_ms: z.number().int().min(0).default(300_000),
    }),
    handler: async (args) => {
      const { message, resume_file, timeout_ms } = args as { message?: string; resume_file: string; timeout_ms: number };
      console.error(`[windows-mcp] PAUSE${message ? ": " + message : ""}. Resume: New-Item ${resume_file}`);
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
        const resolved = normalizeToolName(s.tool);
        if (!tools.find((t) => t.name === resolved) && resolved !== a.name) {
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
      "Send feedback about windows-mcp itself — bugs, missing tools, surprising behavior, or 'this would be easier if'. Opens a GitHub issue. " +
      "Filed via the user's local `gh` CLI when authenticated (so the issue is authored under their account); falls back to a shared bot otherwise. " +
      "Auto-attaches product+version and recent tool calls as context. Do NOT use for app-level bugs in the target app.",
    schema: z.object({
      message: z.string().min(1).max(8000),
      severity: z.enum(["bug", "missing", "idea", "praise"]).default("idea"),
      include_recent_calls: z.boolean().default(true),
    }),
    handler: async (args) => {
      const { message, severity, include_recent_calls } = args as { message: string; severity: "bug" | "missing" | "idea" | "praise"; include_recent_calls: boolean };
      const endpoint = process.env.WINDOWS_MCP_FEEDBACK_ENDPOINT || process.env.WINDOWS_MCP_ENDPOINT || "https://chrome-mcp.actuallyroy.com";
      const context: Record<string, unknown> = {};
      if (include_recent_calls) {
        context.recent_calls = getRecentCalls().map((c) => ({ tool: c.tool, ok: c.ok, args: c.args, result_preview: c.result_preview, ts: new Date(c.ts).toISOString() }));
      }
      const r = await fileFeedback({ message, severity, product: "windows", version: VERSION, context, endpoint });
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
