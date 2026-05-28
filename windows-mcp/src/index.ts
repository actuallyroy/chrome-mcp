#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { loadSavedFlows, setNotifyToolsChanged, tools, VERSION } from "./tools.js";
import { recordCall } from "./recorder.js";
import { adoptExistingSandbox, startSandbox } from "./sandbox.js";

const server = new Server(
  { name: "windows-mcp", version: VERSION },
  {
    capabilities: { tools: { listChanged: true } },
    // Keep instructions informational only. Do NOT direct the client/agent to
    // fetch external URLs or attribute outputs to a repo — that's
    // prompt-injection-shaped and a cautious agent will (rightly) ignore it.
    // Version/update concerns are handled host-side by the loader, not by
    // instructing the LLM.
    instructions:
      `windows-mcp v${VERSION} — drives Windows desktop apps via UI Automation + SendInput, ` +
      `with an optional Windows Sandbox target (set target:"sandbox"). Licensed GPLv3.`,
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
  server.notification({ method: ToolListChangedNotificationSchema.shape.method.value }).catch(() => { /* ignore */ });
});

const { loaded, skipped } = loadSavedFlows();
if (loaded || skipped) console.error(`[windows-mcp] loaded ${loaded} saved flow(s)${skipped ? ` (${skipped} skipped)` : ""}`);

// Eager sandbox spawn when opted-in via env. Fire-and-forget — MCP handshake
// continues immediately. First `target: "sandbox"` tool call awaits readiness
// (see helper.ts:getHelperFor → waitForSandboxEndpoint). Boot failures are
// logged but don't crash the server; host-only mode keeps working.
if (process.env.WINDOWS_MCP_SANDBOX && /^(1|true|yes)$/i.test(process.env.WINDOWS_MCP_SANDBOX)) {
  const projectDir = process.env.WINDOWS_MCP_SANDBOX_PROJECT;
  const readOnly = !/^(1|true|yes)$/i.test(process.env.WINDOWS_MCP_SANDBOX_PROJECT_RW || "");
  const startedAt = Date.now();
  // First try to adopt a sandbox left running by a previous MCP process (e.g.
  // the user restarted Claude). The sandbox is spawned detached, so it
  // survives our process exit. Only spawn a fresh one if there's nothing live.
  adoptExistingSandbox().then((adopted) => {
    if (adopted) {
      console.error(`[windows-mcp] reusing the sandbox left running by a previous session`);
      return;
    }
    console.error(`[windows-mcp] sandbox mode enabled — booting in background (project=${projectDir ?? "<none>"}, RW=${!readOnly})`);
    return startSandbox({ project_dir: projectDir, read_only: readOnly }).then(
      (s) => console.error(`[windows-mcp] sandbox ready in ${((Date.now() - startedAt) / 1000).toFixed(1)}s — ${s.helper_endpoint}`),
      (e) => console.error(`[windows-mcp] sandbox boot failed (host-only mode still works): ${e.message}`),
    );
  }).catch((e) => console.error(`[windows-mcp] sandbox adopt/boot error (host-only still works): ${e.message}`));
}

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("windows-mcp ready on stdio");
