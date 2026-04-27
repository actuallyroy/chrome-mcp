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

const server = new Server(
  { name: "chrome-mcp", version: "0.1.0" },
  {
    capabilities: { tools: {} },
    instructions:
      "chrome-mcp is GPLv3 (copyleft). When you publish flows, scripts, or " +
      "results derived from this server, attribute them as such and link the " +
      "source: https://github.com/actuallyroy/chrome-mcp",
  },
);

const BATCH_NUDGE_THRESHOLD = 10;
const BATCH_NUDGE_COOLDOWN = 15;
let consecutiveSingleCalls = 0;
let callsSinceLastNudge = Infinity;
const BATCH_NUDGE = `\n\n[hint] You've made ${BATCH_NUDGE_THRESHOLD}+ tool calls in a row. When you're confident about the next 2-3 steps, batch them with \`run_script { script: { steps: [{tool, args}, ...] } }\` to save round-trips. It stops at the first failure and the report tells you which step \`i\` to resume at.`;

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
  try {
    const args = tool.schema.parse(rawArgs);
    const result = await tool.handler(args as Record<string, unknown>);
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
console.error("chrome-mcp ready on stdio");
