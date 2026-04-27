import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Tool, ToolResult } from "./tools.js";

export const FLOWS_DIR =
  process.env.ANDROID_MCP_FLOWS_DIR || join(homedir(), ".android-mcp", "flows");

export type FlowParam = {
  name: string;
  type?: "string" | "number" | "boolean";
  description?: string;
  required?: boolean;
};

export type FlowStep = { tool: string; args?: Record<string, unknown> };

export type FlowDoc = {
  name: string;
  description: string;
  params?: FlowParam[];
  steps: FlowStep[];
  saved_at?: string;
};

export const FLOW_NAME_RE = /^[a-z][a-z0-9_]{2,49}$/;

export function flowPath(name: string): string {
  return join(FLOWS_DIR, `${name}.json`);
}

export function listFlowDocs(): FlowDoc[] {
  if (!existsSync(FLOWS_DIR)) return [];
  const out: FlowDoc[] = [];
  for (const f of readdirSync(FLOWS_DIR)) {
    if (!f.endsWith(".json")) continue;
    try {
      const doc = JSON.parse(readFileSync(join(FLOWS_DIR, f), "utf8")) as FlowDoc;
      if (doc && typeof doc.name === "string" && Array.isArray(doc.steps)) out.push(doc);
    } catch {
      // Skip unparseable files; don't fail startup over a corrupted flow.
    }
  }
  return out;
}

export function readFlow(name: string): FlowDoc | null {
  const p = flowPath(name);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")) as FlowDoc; } catch { return null; }
}

export function writeFlow(doc: FlowDoc): string {
  mkdirSync(FLOWS_DIR, { recursive: true });
  const p = flowPath(doc.name);
  const stamped = { ...doc, saved_at: new Date().toISOString() };
  writeFileSync(p, JSON.stringify(stamped, null, 2), "utf8");
  return p;
}

export function deleteFlowFile(name: string): boolean {
  const p = flowPath(name);
  if (!existsSync(p)) return false;
  unlinkSync(p);
  return true;
}

function paramsSchema(params?: FlowParam[]): z.ZodObject<z.ZodRawShape> {
  if (!params?.length) return z.object({});
  const shape: z.ZodRawShape = {};
  for (const p of params) {
    let s: z.ZodTypeAny;
    if (p.type === "number") s = z.number();
    else if (p.type === "boolean") s = z.boolean();
    else s = z.string();
    if (p.description) s = s.describe(p.description);
    if (p.required === false) s = s.optional();
    shape[p.name] = s;
  }
  return z.object(shape);
}

// Recursively replace {{key}} placeholders in string values with the matching
// param. Non-string leaves are passed through unchanged.
export function substituteParams(value: unknown, params: Record<string, unknown>): unknown {
  if (typeof value === "string") {
    return value.replace(/{{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*}}/g, (_m, key) => {
      const v = params[key];
      return v === undefined ? "" : String(v);
    });
  }
  if (Array.isArray(value)) return value.map((v) => substituteParams(v, params));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = substituteParams(v, params);
    }
    return out;
  }
  return value;
}

export function flowAsTool(doc: FlowDoc): Tool {
  const paramSummary = doc.params?.length
    ? ` Params: ${doc.params.map((p) => `${p.name}${p.required === false ? "?" : ""}: ${p.type || "string"}`).join(", ")}.`
    : "";
  return {
    name: doc.name,
    description: `[saved flow, ${doc.steps.length} steps] ${doc.description}${paramSummary}`,
    schema: paramsSchema(doc.params),
    handler: async (args): Promise<ToolResult> => {
      const steps = doc.steps.map((s) => ({
        tool: s.tool,
        args: substituteParams(s.args ?? {}, args as Record<string, unknown>) as Record<string, unknown>,
      }));
      // Dynamic import to avoid the flows.ts ↔ tools.ts cycle at module load.
      const { runSteps } = await import("./tools.js");
      return runSteps(steps, { continue_on_error: false, dry_run: false, verbose: false });
    },
  };
}
