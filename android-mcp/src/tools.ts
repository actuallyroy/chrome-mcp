import { readFileSync, unlinkSync } from "node:fs";
import { PNG } from "pngjs";
import { z } from "zod";
import { adb, adbShell, screenSize } from "./adb.js";
import {
  currentApp,
  deviceInfo,
  ensureDevice,
  listDevices,
  selectDevice,
} from "./devices.js";
import { resolveElementId, type LocatorArgs } from "./locators.js";
import { outline } from "./outline.js";
import { readLogcat } from "./logcat.js";
import {
  getRecentCalls,
  recorderStatus,
  startRecording,
  stopRecording,
} from "./recorder.js";
import {
  clearElement,
  clickElement,
  dismissDevOverlay,
  pressKeyCode,
  screenshot as u2Screenshot,
  setElementValue,
  u2,
} from "./uiautomator2.js";

export type ToolResult = {
  content: { type: "text" | "image"; text?: string; data?: string; mimeType?: string }[];
  isError?: boolean;
};

const text = (s: string): ToolResult => ({ content: [{ type: "text", text: s }] });
const json = (o: unknown): ToolResult => text(JSON.stringify(o, null, 2));
const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Nearest-neighbor PNG downscale so the longest side is <= maxDim. Returns
// base64. If the image is already small enough, returns the input unchanged.
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

export type Tool = {
  name: string;
  description: string;
  schema: z.ZodObject<z.ZodRawShape>;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
};

const Locator = {
  ref: z.number().int().optional().describe("Ref from the most recent outline()"),
  text: z.string().optional().describe("Exact text of the element (UiSelector.text)"),
  desc: z.string().optional().describe("content-desc (a11y id)"),
  id: z.string().optional().describe("resource-id, e.g. com.app:id/submit"),
  xpath: z.string().optional(),
  class: z.string().optional().describe("Fully qualified class name"),
  selector: z.string().optional().describe("UiSelector fluent string (advanced)"),
};

// Android key codes for common keys.
const KEYCODES: Record<string, number> = {
  HOME: 3, BACK: 4, CALL: 5, ENDCALL: 6,
  VOLUME_UP: 24, VOLUME_DOWN: 25, POWER: 26, CAMERA: 27, MENU: 82,
  ENTER: 66, DEL: 67, TAB: 61, SPACE: 62, ESCAPE: 111,
  APP_SWITCH: 187,
};

export const tools: Tool[] = [
  // ---- Device lifecycle --------------------------------------------------
  {
    name: "list_devices",
    description: "List connected Android devices/emulators with their state.",
    schema: z.object({}),
    handler: async () => json(await listDevices()),
  },
  {
    name: "select_device",
    description: "Make a device active for subsequent tool calls (by serial).",
    schema: z.object({ serial: z.string() }),
    handler: async (args) => {
      const d = await selectDevice((args as { serial: string }).serial);
      return text(`active: ${d.serial} (${d.model || d.product || "?"})`);
    },
  },
  {
    name: "device_info",
    description: "Return manufacturer, model, Android version, SDK level of the active device.",
    schema: z.object({}),
    handler: async () => json(await deviceInfo()),
  },
  {
    name: "current_app",
    description: "Return the package + activity of the currently foregrounded app.",
    schema: z.object({}),
    handler: async () => json(await currentApp()),
  },

  // ---- App lifecycle -----------------------------------------------------
  {
    name: "launch_app",
    description:
      "Launch an app by package name. If activity is omitted, uses monkey to start the main launcher activity.",
    schema: z.object({ package: z.string(), activity: z.string().optional() }),
    handler: async (args) => {
      await ensureDevice();
      const { package: pkg, activity } = args as { package: string; activity?: string };
      if (activity) {
        await adbShell(`am start -n ${pkg}/${activity}`);
      } else {
        await adbShell(`monkey -p ${pkg} -c android.intent.category.LAUNCHER 1 >/dev/null`);
      }
      return text(`launched ${pkg}${activity ? `/${activity}` : ""}`);
    },
  },
  {
    name: "stop_app",
    description: "Force-stop an app by package name.",
    schema: z.object({ package: z.string() }),
    handler: async (args) => {
      await ensureDevice();
      const { package: pkg } = args as { package: string };
      await adbShell(`am force-stop ${pkg}`);
      return text(`stopped ${pkg}`);
    },
  },
  {
    name: "install_app",
    description: "Install an APK on the active device. Path must be absolute on the local machine.",
    schema: z.object({ apk_path: z.string(), replace: z.boolean().default(true) }),
    handler: async (args) => {
      await ensureDevice();
      const { apk_path, replace } = args as { apk_path: string; replace: boolean };
      await adb(["install", ...(replace ? ["-r"] : []), apk_path], { timeout_ms: 180_000 });
      return text(`installed ${apk_path}`);
    },
  },
  {
    name: "clear_app_data",
    description: "Clear all data (cache, preferences, databases) for a package.",
    schema: z.object({ package: z.string() }),
    handler: async (args) => {
      await ensureDevice();
      const { package: pkg } = args as { package: string };
      await adbShell(`pm clear ${pkg}`);
      return text(`cleared ${pkg}`);
    },
  },

  // ---- Page inspection ---------------------------------------------------
  {
    name: "outline",
    description:
      "Return a compact text outline of the current screen's interactive elements with stable refs. Use instead of screenshot for navigation.",
    schema: z.object({}),
    handler: async () => text(await outline()),
  },
  {
    name: "describe",
    description: "Return detailed info about a single element (by locator).",
    schema: z.object(Locator),
    handler: async (args) => {
      const elId = await resolveElementId(args as LocatorArgs);
      const [rect, text, enabled, displayed, name] = await Promise.all([
        u2("GET", `/element/${elId}/rect`),
        u2("GET", `/element/${elId}/text`),
        u2("GET", `/element/${elId}/enabled`),
        u2("GET", `/element/${elId}/displayed`),
        u2("GET", `/element/${elId}/name`).catch(() => null),
      ]);
      return json({ rect, text, enabled, displayed, name, elementId: elId });
    },
  },
  {
    name: "screenshot",
    description:
      "PNG screenshot of the current device screen (base64), auto-downscaled to fit the MCP 2000px image limit. Prefer `outline` for navigation and element lookup — it's cheaper, faster, and returns stable refs. Use screenshot only for visual verification, layout bugs, or content the view hierarchy can't describe (canvas, charts, map tiles, rendered images).",
    schema: z.object({
      max_dim: z.number().int().min(256).max(2000).default(1600),
    }),
    handler: async (args) => {
      const { max_dim } = args as { max_dim: number };
      const b64 = await u2Screenshot();
      const resized = resizePngBase64(b64, max_dim);
      return { content: [{ type: "image", data: resized, mimeType: "image/png" }] };
    },
  },

  // ---- Interaction -------------------------------------------------------
  {
    name: "click",
    description: "Tap an element. Locator: ref | text | desc | id | xpath | class | selector.",
    schema: z.object(Locator),
    handler: async (args) => {
      const elId = await resolveElementId(args as LocatorArgs);
      await clickElement(elId);
      return text(`clicked ${elId}`);
    },
  },
  {
    name: "fill",
    description: "Clear and type into a text field. Locator + value. Automatically falls back to click+adb-input for React Native TextInputs that reject the WebDriver setValue call.",
    schema: z.object({ ...Locator, value: z.string() }),
    handler: async (args) => {
      const { value, ...loc } = args as LocatorArgs & { value: string };
      const elId = await resolveElementId(loc);
      try {
        await clearElement(elId);
        await setElementValue(elId, value);
        return text(`filled`);
      } catch (e) {
        const msg = (e as Error).message || "";
        // Typical RN TextInput error: "Cannot set the element to '<value>'. Did you interact with the correct element?"
        if (!/invalid element state|Cannot set the element|Did you interact/i.test(msg)) throw e;
        // Fallback: click the element to focus it, then use adb shell input text.
        await clickElement(elId);
        // Clear any existing content: move to end, delete back a bunch of times.
        await adbShell("input keyevent KEYCODE_MOVE_END").catch(() => {});
        for (let i = 0; i < 40; i++) {
          await adbShell("input keyevent KEYCODE_DEL").catch(() => {});
        }
        // `adb shell input text` uses %s for space and needs quoting for shell metas.
        const escaped = value
          .replace(/\\/g, "\\\\")
          .replace(/"/g, '\\"')
          .replace(/`/g, "\\`")
          .replace(/\$/g, "\\$")
          .replace(/ /g, "%s");
        await adbShell(`input text "${escaped}"`);
        return text(`filled (adb fallback)`);
      }
    },
  },
  {
    name: "press_key",
    description: `Press a hardware/system key. Known names: ${Object.keys(KEYCODES).join(", ")}. Or pass a numeric keycode.`,
    schema: z.object({ key: z.union([z.string(), z.number().int()]) }),
    handler: async (args) => {
      const { key } = args as { key: string | number };
      const code = typeof key === "number" ? key : KEYCODES[key.toUpperCase()];
      if (code == null) throw new Error(`Unknown key: ${key}`);
      await pressKeyCode(code);
      return text(`pressed ${key} (${code})`);
    },
  },
  {
    name: "long_press",
    description: "Long-press an element.",
    schema: z.object({ ...Locator, duration_ms: z.number().int().min(100).default(1000) }),
    handler: async (args) => {
      const { duration_ms, ...loc } = args as LocatorArgs & { duration_ms: number };
      const elId = await resolveElementId(loc);
      await u2("POST", "/touch/longclick", { element: elId, duration: duration_ms });
      return text(`long-pressed`);
    },
  },
  {
    name: "swipe",
    description: "Swipe between two screen coordinates. (x1,y1) → (x2,y2) over duration ms.",
    schema: z.object({
      x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number(),
      duration_ms: z.number().int().min(100).default(500),
    }),
    handler: async (args) => {
      const a = args as { x1: number; y1: number; x2: number; y2: number; duration_ms: number };
      await adbShell(`input swipe ${Math.round(a.x1)} ${Math.round(a.y1)} ${Math.round(a.x2)} ${Math.round(a.y2)} ${a.duration_ms}`);
      return text(`swiped (${a.x1},${a.y1}) → (${a.x2},${a.y2})`);
    },
  },
  {
    name: "scroll",
    description:
      "Scroll in a direction. With `until_text`, `until_desc`, or `until_id` populated, swipes up to max_steps times and stops as soon as a matching element becomes visible (substring match against text / content-desc / resource-id in the view hierarchy). Without an `until_*`, just performs max_steps swipes.",
    schema: z.object({
      direction: z.enum(["up", "down", "left", "right"]).default("down"),
      until_text: z.string().optional().describe("Stop when an element with this visible text appears (substring match)."),
      until_desc: z.string().optional().describe("Stop when an element with this content-desc / accessibility label appears (substring match)."),
      until_id: z.string().optional().describe("Stop when an element with this resource-id appears (substring match, e.g. 'com.app:id/checkout')."),
      max_steps: z.number().int().min(1).default(8),
    }),
    handler: async (args) => {
      const { direction, until_text, until_desc, until_id, max_steps } = args as {
        direction: "up" | "down" | "left" | "right";
        until_text?: string;
        until_desc?: string;
        until_id?: string;
        max_steps: number;
      };
      const { w, h } = await screenSize();
      const mx = Math.round(w / 2);
      const my = Math.round(h / 2);
      const [x1, y1, x2, y2] =
        direction === "down" ? [mx, Math.round(h * 0.75), mx, Math.round(h * 0.25)]
        : direction === "up" ? [mx, Math.round(h * 0.25), mx, Math.round(h * 0.75)]
        : direction === "left" ? [Math.round(w * 0.75), my, Math.round(w * 0.25), my]
        : [Math.round(w * 0.25), my, Math.round(w * 0.75), my];

      const matches = (xml: string): string | null => {
        if (until_text && new RegExp(`text="[^"]*${escapeRegex(until_text)}`).test(xml)) return `text~="${until_text}"`;
        if (until_desc && new RegExp(`content-desc="[^"]*${escapeRegex(until_desc)}`).test(xml)) return `desc~="${until_desc}"`;
        if (until_id && new RegExp(`resource-id="[^"]*${escapeRegex(until_id)}`).test(xml)) return `id~="${until_id}"`;
        return null;
      };
      const hasUntil = !!(until_text || until_desc || until_id);
      if (hasUntil) {
        const { dumpSource } = await import("./uiautomator2.js");
        for (let i = 0; i <= max_steps; i++) {
          const xml = await dumpSource().catch(() => "");
          const hit = matches(xml);
          if (hit) return text(`scrolled until visible: ${hit} (step ${i})`);
          if (i === max_steps) break;
          await adbShell(`input swipe ${x1} ${y1} ${x2} ${y2} 400`);
          await new Promise((r) => setTimeout(r, 250));
        }
        const tried = [until_text && `text="${until_text}"`, until_desc && `desc="${until_desc}"`, until_id && `id="${until_id}"`]
          .filter(Boolean).join(", ");
        throw new Error(`scroll until ${tried} not found after ${max_steps} steps`);
      }
      for (let i = 0; i < max_steps; i++) {
        await adbShell(`input swipe ${x1} ${y1} ${x2} ${y2} 300`);
      }
      return text(`scrolled ${direction} x${max_steps}`);
    },
  },

  // ---- Logs --------------------------------------------------------------
  {
    name: "get_logcat",
    description:
      "Return recent logcat entries. Filter matches tag or text. Level is a comma-list of V,D,I,W,E,F.",
    schema: z.object({
      filter: z.string().optional(),
      level: z.string().optional(),
      limit: z.number().int().min(1).max(2000).default(200),
      clear: z.boolean().default(false),
    }),
    handler: async (args) =>
      json(readLogcat(args as { filter?: string; level?: string; limit: number; clear: boolean })),
  },
  {
    name: "adb_shell",
    description: "Escape hatch: run an arbitrary `adb shell` command and return stdout.",
    schema: z.object({ command: z.string() }),
    handler: async (args) => {
      await ensureDevice();
      const out = await adbShell((args as { command: string }).command);
      return text(out);
    },
  },

  // ---- Device state ------------------------------------------------------
  {
    name: "set_orientation",
    description: "Set screen orientation: portrait or landscape.",
    schema: z.object({ orientation: z.enum(["PORTRAIT", "LANDSCAPE"]) }),
    handler: async (args) => {
      const { orientation } = args as { orientation: "PORTRAIT" | "LANDSCAPE" };
      await u2("POST", "/orientation", { orientation });
      return text(`oriented ${orientation}`);
    },
  },
  {
    name: "dismiss_dev_overlay",
    description:
      "Dismiss React Native LogBox dev overlays (full-screen stack-trace view and minimized warning badges). Called automatically before every interactive tool; expose as an explicit tool for debugging.",
    schema: z.object({}),
    handler: async () => json(await dismissDevOverlay()),
  },
  {
    name: "wait_for_stable",
    description:
      "Wait until the UI tree stops changing (two consecutive snapshots identical). Useful after a click triggers async re-renders. Returns once stable or at the timeout.",
    schema: z.object({
      timeout_ms: z.number().int().min(100).default(3000),
      poll_ms: z.number().int().min(50).default(250),
    }),
    handler: async (args) => {
      const { timeout_ms, poll_ms } = args as { timeout_ms: number; poll_ms: number };
      const deadline = Date.now() + timeout_ms;
      let prev = "";
      let stable_polls = 0;
      while (Date.now() < deadline) {
        let cur = "";
        try { cur = await (await import("./uiautomator2.js")).dumpSource(); } catch { cur = ""; }
        if (cur && cur === prev) {
          stable_polls++;
          if (stable_polls >= 1) {
            return text(`stable`);
          }
        } else {
          stable_polls = 0;
        }
        prev = cur;
        await new Promise((r) => setTimeout(r, poll_ms));
      }
      return text(`timeout`);
    },
  },
  {
    name: "open_notifications",
    description: "Pull down the notification shade.",
    schema: z.object({}),
    handler: async () => { await u2("POST", "/appium/device/open_notifications", {}); return text("opened"); },
  },

  // ---- Assertion ---------------------------------------------------------
  {
    name: "assert",
    description: "Throw if a condition fails. Useful as a script step.",
    schema: z.object({
      text_visible: z.string().optional(),
      current_package: z.string().optional(),
      element: z
        .object({ ref: z.number().int().optional(), text: z.string().optional(), desc: z.string().optional(), id: z.string().optional(), xpath: z.string().optional() })
        .optional(),
      logcat_contains: z.string().optional(),
    }),
    handler: async (args) => {
      const a = args as {
        text_visible?: string;
        current_package?: string;
        element?: LocatorArgs;
        logcat_contains?: string;
      };
      if (a.text_visible) {
        const src = await outline();
        if (!src.includes(a.text_visible)) throw new Error(`assert.text_visible failed: "${a.text_visible}"`);
        return text("ok (text visible)");
      }
      if (a.current_package) {
        const cur = await currentApp();
        if (cur?.package !== a.current_package)
          throw new Error(`assert.current_package: got ${cur?.package}, want ${a.current_package}`);
        return text("ok (package matches)");
      }
      if (a.element) {
        await resolveElementId(a.element);
        return text("ok (element present)");
      }
      if (a.logcat_contains) {
        const entries = readLogcat({ filter: a.logcat_contains, limit: 20 });
        if (entries.length === 0) throw new Error(`assert.logcat_contains: no match for "${a.logcat_contains}"`);
        return text("ok (logcat match)");
      }
      throw new Error("assert: provide one of text_visible / current_package / element / logcat_contains");
    },
  },

  // ---- Debug pause (MVP: stderr + flag-file) -----------------------------
  {
    name: "pause",
    description:
      "Pause the agent. Prints a message to stderr; the agent blocks until the user creates the file at path (default /tmp/android-mcp.resume). Use `touch /tmp/android-mcp.resume` to resume. Times out after timeout_ms.",
    schema: z.object({
      message: z.string().optional(),
      resume_file: z.string().default("/tmp/android-mcp.resume"),
      timeout_ms: z.number().int().min(0).default(300_000),
    }),
    handler: async (args) => {
      const { message, resume_file, timeout_ms } = args as {
        message?: string;
        resume_file: string;
        timeout_ms: number;
      };
      // eslint-disable-next-line no-console
      console.error(`[android-mcp] PAUSE${message ? ": " + message : ""}. Resume: touch ${resume_file}`);
      const deadline = Date.now() + timeout_ms;
      while (Date.now() < deadline) {
        try {
          readFileSync(resume_file);
          unlinkSync(resume_file);
          return text("resumed");
        } catch { /* not present yet */ }
        await new Promise((r) => setTimeout(r, 400));
      }
      return text("pause timed out");
    },
  },

  // ---- Flow recording ----------------------------------------------------
  {
    name: "start_recording",
    description: "Begin recording tool calls to a flow file.",
    schema: z.object({ path: z.string().optional() }),
    handler: async (args) => {
      startRecording((args as { path?: string }).path);
      return text(`recording started`);
    },
  },
  {
    name: "stop_recording",
    description: "Stop recording and return the captured entries (writes to path if provided to start_recording).",
    schema: z.object({}),
    handler: async () => json(stopRecording()),
  },
  {
    name: "recording_status",
    description: "Is recording active?",
    schema: z.object({}),
    handler: async () => json(recorderStatus()),
  },
  {
    name: "run_script",
    description:
      "Execute a JSON flow. Accepts `path` or inline `script`. Shape: {steps|entries: [{tool, args, name?, skip?, on_error?}]}.",
    schema: z.object({
      path: z.string().optional(),
      script: z.object({
        steps: z.array(z.object({ tool: z.string(), args: z.record(z.any()).optional() })).optional(),
        entries: z.array(z.object({ tool: z.string(), args: z.record(z.any()).optional() })).optional(),
      }).optional(),
      continue_on_error: z.boolean().default(false),
      dry_run: z.boolean().default(false),
    }),
    handler: async (args) => {
      const { path, script, continue_on_error, dry_run } = args as {
        path?: string;
        script?: { steps?: { tool: string; args?: Record<string, unknown> }[]; entries?: { tool: string; args?: Record<string, unknown> }[] };
        continue_on_error: boolean;
        dry_run: boolean;
      };
      const parsed = path ? JSON.parse(readFileSync(path, "utf8")) : script;
      if (!parsed) throw new Error("run_script: provide path or script");
      const steps = parsed.steps ?? parsed.entries ?? [];
      if (!steps.length) throw new Error("run_script: no steps");
      const report: {
        i: number; tool: string; ok: boolean; ms: number;
        result_preview?: string; error?: string;
      }[] = [];
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i] as {
          tool: string;
          args?: Record<string, unknown>;
          skip?: boolean;
          on_error?: "continue" | "stop";
        };
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
          const preview = r.content.find((c) => c.type === "text")?.text?.slice(0, 200);
          if (r.isError) {
            report.push({ i, tool: step.tool, ok: false, ms: Date.now() - t0, error: preview });
            if (!continue_on_error && step.on_error !== "continue") return json({ ok: false, stopped_at: i, report });
            continue;
          }
          report.push({ i, tool: step.tool, ok: true, ms: Date.now() - t0, result_preview: preview });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          report.push({ i, tool: step.tool, ok: false, ms: Date.now() - t0, error: msg });
          if (!continue_on_error && step.on_error !== "continue") return json({ ok: false, stopped_at: i, report });
        }
      }
      return json({ ok: true, steps_run: report.length, report });
    },
  },
  {
    name: "send_feedback",
    description:
      "Send feedback about android-mcp itself — bugs, missing tools, surprising behavior, or 'this would be easier if'. Opens a GitHub issue. Auto-attaches product+version and recent tool calls as context. Use this when the MCP blocks you or forces a workaround (e.g. shelling out to adb because a tool is broken) — do not use it for app-level bugs in the target app.",
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
        process.env.ANDROID_MCP_FEEDBACK_ENDPOINT ||
        process.env.ANDROID_MCP_ENDPOINT ||
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
          product: "android",
          version: "0.1.9",
          context,
        }),
      });
      const bodyText = await res.text();
      if (!res.ok) {
        throw new Error(`feedback POST failed: ${res.status} ${bodyText.slice(0, 300)}`);
      }
      const parsed = JSON.parse(bodyText) as { url?: string; issue_number?: number };
      return text(`filed issue #${parsed.issue_number} — ${parsed.url}`);
    },
  },
];

