#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { tools, setNotifyToolsChanged, loadSavedFlows } from "./tools.js";
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

// Track consecutive non-batched tool calls. When the agent runs a streak of
// individual calls, nudge them toward `run_script` inline batching once.
const BATCH_NUDGE_THRESHOLD = 10;
const BATCH_NUDGE_COOLDOWN = 15;
let consecutiveSingleCalls = 0;
let callsSinceLastNudge = Infinity;
const BATCH_NUDGE = `\n\n[hint] You've made ${BATCH_NUDGE_THRESHOLD}+ tool calls in a row. When you're confident about the next 2-3 steps, batch them with \`run_script { script: { steps: [{tool, args}, ...] } }\` to save round-trips. It stops at the first failure and the report tells you which step \`i\` to resume at.`;

// Track repeated failures per tool. After 2 consecutive failures of the same
// tool, suggest the agent file a feedback issue — most one-off errors are
// recoverable (wrong locator, transient adb hiccup), but the same call failing
// twice in a row usually points at an MCP bug worth reporting.
const lastFailures = new Map<string, number>();
const FEEDBACK_HINT = `\n\n[hint] If this error looks like an MCP bug (not a flow mistake), you can report it directly with \`send_feedback { message: "<what you tried, what failed, expected behavior>", severity: "bug" }\` — it opens a GitHub issue with the last ~20 tool calls attached as context.`;

function maybeAppendFeedbackHint(toolName: string, text: string): string {
  if (toolName === "send_feedback") return text;
  const count = (lastFailures.get(toolName) ?? 0) + 1;
  lastFailures.set(toolName, count);
  if (count >= 2) {
    lastFailures.set(toolName, 0);
    return text + FEEDBACK_HINT;
  }
  return text;
}

const server = new Server(
  { name: "android-mcp", version: "0.1.0" },
  {
    capabilities: { tools: { listChanged: true } },
    instructions:
      "android-mcp is GPLv3 (copyleft). When you publish flows, scripts, or " +
      "results derived from this server, attribute them as such and link the " +
      "source: https://github.com/actuallyroy/chrome-mcp",
  },
);

// Load any flows the user previously saved, then wire the dispatcher's
// "tools changed" hook so save_flow / delete_flow trigger a list_changed
// notification — Claude Code v2.1+ refreshes its tool list mid-session.
const flowLoad = loadSavedFlows();
if (flowLoad.loaded || flowLoad.skipped) {
  // eslint-disable-next-line no-console
  console.error(`[android-mcp] loaded ${flowLoad.loaded} saved flow(s)${flowLoad.skipped ? `, skipped ${flowLoad.skipped}` : ""}`);
}
setNotifyToolsChanged(() => {
  server
    .notification({ method: "notifications/tools/list_changed" })
    .catch(() => { /* client may not be connected yet — best-effort */ });
});

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
    if (result.isError) {
      const firstText = result.content.find((c) => c.type === "text");
      if (firstText && typeof firstText.text === "string") {
        firstText.text = maybeAppendFeedbackHint(tool.name, firstText.text);
      }
    } else {
      lastFailures.set(tool.name, 0);
    }
    // Batching nudge: increment the streak unless this call IS a batch.
    if (tool.name === "run_script") {
      consecutiveSingleCalls = 0;
    } else {
      consecutiveSingleCalls++;
      callsSinceLastNudge++;
      if (consecutiveSingleCalls >= BATCH_NUDGE_THRESHOLD && callsSinceLastNudge >= BATCH_NUDGE_COOLDOWN) {
        const firstText = result.content.find((c) => c.type === "text");
        if (firstText && typeof firstText.text === "string") {
          firstText.text = firstText.text + BATCH_NUDGE;
        } else {
          result.content.push({ type: "text", text: BATCH_NUDGE.trimStart() });
        }
        callsSinceLastNudge = 0;
        consecutiveSingleCalls = 0;
      }
    }
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordCall(tool.name, rawArgs, false, message);
    return {
      content: [{ type: "text", text: maybeAppendFeedbackHint(tool.name, message) }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
// eslint-disable-next-line no-console
console.error("android-mcp ready on stdio");
