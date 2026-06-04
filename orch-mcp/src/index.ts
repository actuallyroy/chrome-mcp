#!/usr/bin/env node
// MCP server entry. Exposes the worker_* tools defined in tools.ts over the
// stdio transport.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { tools, VERSION, recordToolCall } from "./tools.js";

const server = new Server(
  { name: "orch-mcp", version: VERSION },
  {
    capabilities: { tools: {} },
    instructions:
      `orch-mcp v${VERSION} — let a master Claude session drive other (worker) Claude sessions in the same project. ` +
      `Adopt mature sessions with worker_register, spin up fresh ones with worker_create, talk to them with worker_send. ` +
      `Workers cannot run Bash — all shell stays in the master. Use worker_compact when a worker's transcript gets long.`,
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: zodToJsonSchema(t.schema) as Record<string, unknown>,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = tools.find((t) => t.name === req.params.name);
  if (!tool) {
    return {
      content: [{ type: "text", text: `unknown tool: ${req.params.name}` }],
      isError: true,
    };
  }
  const args = req.params.arguments ?? {};
  try {
    const validated = tool.schema.parse(args);
    const r = await tool.handler(validated as Record<string, unknown>);
    // Skip recording send_feedback so the recent-calls payload doesn't
    // recursively include the feedback call itself.
    if (tool.name !== "send_feedback") {
      const preview = r.content.find((c) => c.type === "text")?.text?.slice(0, 200) ?? "";
      recordToolCall({ tool: tool.name, ok: !r.isError, args, result_preview: preview, ts: Date.now() });
    }
    return r;
  } catch (e) {
    if (tool.name !== "send_feedback") {
      recordToolCall({ tool: tool.name, ok: false, args, result_preview: (e as Error).message.slice(0, 200), ts: Date.now() });
    }
    return {
      content: [{ type: "text", text: `${tool.name} failed: ${(e as Error).message}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
