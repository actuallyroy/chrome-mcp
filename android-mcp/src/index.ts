#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { tools } from "./tools.js";
import { recordCall } from "./recorder.js";
import { dismissDevOverlay } from "./uiautomator2.js";
import { fingerprint } from "./outline.js";

// Tools that skip auto-dismiss: the dismiss itself (would recurse), and the
// "pure read / non-interactive" tools where speed matters more than overlay
// cleanliness. Everything else gets auto-dismiss before execution.
const SKIP_AUTO_DISMISS = new Set<string>([
  "dismiss_dev_overlay",
  "list_devices",
  "select_device",
  "device_info",
  "get_logcat",
  "recording_status",
  "start_recording",
  "stop_recording",
]);

const server = new Server(
  { name: "android-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: zodToJsonSchema(t.schema, { target: "openApi3" }) as Record<string, unknown>,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = tools.find((t) => t.name === req.params.name);
  if (!tool) {
    return { content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }], isError: true };
  }
  const rawArgs = req.params.arguments ?? {};
  // Interactive tools that may trigger new dev overlays after executing — also
  // auto-dismiss afterwards so the next outline/call sees a clean tree.
  const INTERACTIVE_TOOLS = new Set<string>([
    "click", "fill", "press_key", "long_press", "swipe", "scroll",
    "launch_app", "stop_app", "install_app", "clear_app_data",
  ]);
  // Tools where an unchanged screen is actively suspicious (a nav attempt that
  // accomplished nothing). For these, the absence of change is flagged louder.
  const NAV_EXPECTED = new Set<string>([
    "press_key", "launch_app", "stop_app",
  ]);
  if (!SKIP_AUTO_DISMISS.has(tool.name)) {
    try { await dismissDevOverlay(); } catch { /* best-effort */ }
  }
  try {
    const args = tool.schema.parse(rawArgs);
    const before = INTERACTIVE_TOOLS.has(tool.name)
      ? await fingerprint().catch(() => "")
      : "";
    const result = await tool.handler(args as Record<string, unknown>);
    if (INTERACTIVE_TOOLS.has(tool.name)) {
      // Dev overlays spawned by this action can still block the next call.
      try { await dismissDevOverlay(); } catch { /* best-effort */ }
      // Sample twice with a gap — animated bottom-sheet / modal transitions
      // can take ~200-400ms. If either sample differs from before, it changed.
      await new Promise((r) => setTimeout(r, 200));
      let after = await fingerprint().catch(() => "");
      if (before && after === before) {
        await new Promise((r) => setTimeout(r, 250));
        after = await fingerprint().catch(() => "");
      }
      if (before && after) {
        const changed = before !== after;
        const navHint =
          !changed && NAV_EXPECTED.has(tool.name)
            ? " — expected navigation did not happen (modal, root screen, or blocked?)"
            : "";
        const note = `[screen_changed: ${changed}]${navHint}`;
        const firstText = result.content.find((c) => c.type === "text");
        if (firstText && typeof firstText.text === "string") {
          firstText.text = `${firstText.text}\n${note}`;
        } else {
          result.content.push({ type: "text", text: note });
        }
      }
    }
    const preview = result.content.find((c) => c.type === "text")?.text;
    recordCall(tool.name, args, !result.isError, preview);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordCall(tool.name, rawArgs, false, message);
    return { content: [{ type: "text", text: message }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
// eslint-disable-next-line no-console
console.error("android-mcp ready on stdio");
