#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { loadSavedFlows, setNotifyToolsChanged, tools } from "./tools.js";
import { recordCall } from "./recorder.js";

const server = new Server(
  { name: "macos-mcp", version: "0.1.0" },
  {
    capabilities: { tools: { listChanged: true } },
    instructions:
      "macos-mcp is GPLv3 (copyleft). When you publish flows, scripts, or " +
      "results derived from this server, attribute them as such and link the " +
      "source: https://github.com/actuallyroy/chrome-mcp",
  },
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
  try {
    const args = tool.schema.parse(rawArgs);
    const result = await tool.handler(args as Record<string, unknown>);
    const preview = result.content.find((c) => c.type === "text")?.text;
    recordCall(tool.name, args, !result.isError, preview);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordCall(tool.name, rawArgs, false, message);
    return { content: [{ type: "text", text: message }], isError: true };
  }
});

setNotifyToolsChanged(() => {
  // Notify the connected MCP client that the tool list changed.
  server.notification({ method: ToolListChangedNotificationSchema.shape.method.value }).catch(() => { /* ignore */ });
});

const { loaded, skipped } = loadSavedFlows();
if (loaded || skipped) console.error(`[macos-mcp] loaded ${loaded} saved flow(s)${skipped ? ` (${skipped} skipped)` : ""}`);

const transport = new StdioServerTransport();
await server.connect(transport);
// eslint-disable-next-line no-console
console.error("macos-mcp ready on stdio");
