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
  { capabilities: { tools: {} } },
);

const BATCH_NUDGE_THRESHOLD = 10;
const BATCH_NUDGE_COOLDOWN = 15;
let consecutiveSingleCalls = 0;
let callsSinceLastNudge = Infinity;
const BATCH_NUDGE = `\n\n[hint] You've made ${BATCH_NUDGE_THRESHOLD}+ tool calls in a row. When you're confident about the next 2-3 steps, batch them with \`run_script { script: { steps: [{tool, args}, ...] } }\` to save round-trips. It stops at the first failure and the report tells you which step \`i\` to resume at.`;

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
    return { content: [{ type: "text", text: message }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
// eslint-disable-next-line no-console
console.error("chrome-mcp ready on stdio");
