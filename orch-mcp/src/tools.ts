// MCP tool definitions exposed to the master Claude session.

import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  getWorker,
  readRegistry,
  removeWorker,
  touchWorker,
  upsertWorker,
} from "./registry.js";
import { forkSession, listAvailableSessions, sessionTranscriptPath } from "./sessions.js";
import { promises as fs } from "node:fs";
import { createWorker, sendToWorker, sendToWorkerBackground } from "./claude.js";
import {
  cancelTask,
  createTask,
  finishTask,
  getTask,
  listTasks,
  reapOldTasks,
  waitForTask,
} from "./tasks.js";
import { fileFeedback } from "./feedback.js";

export const VERSION = "0.2.1";

// Tiny ring buffer of the last ~20 tool invocations so send_feedback can
// attach recent activity as context. Mirrors what chrome/android-mcp do via
// their recorder module, just inline-tiny here since orch-mcp doesn't have
// recording as a feature surface of its own.
type RecentCall = {
  tool: string;
  ok: boolean;
  args: unknown;
  result_preview: string;
  ts: number;
};
const RECENT_CAPACITY = 20;
const recentCalls: RecentCall[] = [];

export function recordToolCall(call: RecentCall): void {
  recentCalls.push(call);
  if (recentCalls.length > RECENT_CAPACITY) recentCalls.shift();
}

export function getRecentCalls(): RecentCall[] {
  return recentCalls.slice();
}

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

const text = (s: string): ToolResult => ({ content: [{ type: "text", text: s }] });
const json = (v: unknown): ToolResult => text(JSON.stringify(v, null, 2));

export type Tool = {
  name: string;
  description: string;
  schema: z.ZodObject<z.ZodRawShape>;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
};

function formatTurn(name: string, r: Awaited<ReturnType<typeof sendToWorker>>): string {
  const head = r.is_error
    ? `[worker:${name}] ERROR after ${r.duration_ms}ms — ${r.error || "(no detail)"}`
    : `[worker:${name}] done in ${r.duration_ms}ms` +
      (r.cost_usd != null ? ` ($${r.cost_usd.toFixed(4)})` : "") +
      (r.input_tokens != null && r.output_tokens != null
        ? ` [tokens: in=${r.input_tokens} out=${r.output_tokens}]`
        : "");
  const calls = r.tool_calls.length
    ? `\nTool calls: ${r.tool_calls.map((t) => `${t.name}${t.input_preview ? `(${t.input_preview})` : ""}`).join(", ")}`
    : "";
  const body = r.final_text ? `\n\n${r.final_text}` : "";
  return head + calls + body;
}

export const tools: Tool[] = [
  {
    name: "worker_list",
    description:
      "List all registered workers for this project. Each entry shows the worker's name, session_id, current topic, " +
      "creation time, and time of last activity. Use this to remember which workers exist and pick one to send a prompt to.",
    schema: z.object({}),
    handler: async () => {
      const r = await readRegistry();
      const entries = Object.entries(r.workers).map(([name, w]) => ({
        name,
        session_id: w.session_id,
        topic: w.topic,
        created_at: new Date(w.created_at).toISOString(),
        last_activity_at: new Date(w.last_activity_at).toISOString(),
        initial_prompt: w.initial_prompt,
      }));
      if (entries.length === 0) return text("(no workers registered yet — use worker_register to adopt an existing session or worker_create to spin up a fresh one)");
      return json(entries);
    },
  },

  {
    name: "worker_list_available",
    description:
      "List existing Claude Code session transcripts in this project that are NOT yet registered as workers. " +
      "Each entry shows session_id, last activity time, file size, and (best-effort) the most recent user prompt + assistant snippet so you can judge which session is mature enough on a given topic. " +
      "Use the session_id from this list with worker_register to adopt one.",
    schema: z.object({}),
    handler: async () => {
      const [available, reg] = await Promise.all([listAvailableSessions(), readRegistry()]);
      const taken = new Set(Object.values(reg.workers).map((w) => w.session_id));
      const unregistered = available.filter((s) => !taken.has(s.session_id));
      if (unregistered.length === 0) return text("(no unregistered sessions found in this project)");
      return json(unregistered.map((s) => ({
        session_id: s.session_id,
        last_activity_at: new Date(s.last_activity_at).toISOString(),
        size_kb: Math.round(s.size_bytes / 1024),
        last_user_prompt: s.last_user_prompt,
        last_assistant_snippet: s.last_assistant_snippet,
      })));
    },
  },

  {
    name: "worker_register",
    description:
      "Adopt an existing Claude Code session as a named worker. Pass the session_id (from worker_list_available) and a friendly name. " +
      "`topic` is a short string describing what this worker is mature in (e.g. \"backend API\", \"frontend redesign\") — used by worker_status and as a reminder when picking who to ask.",
    schema: z.object({
      name: z.string().min(1).describe("Friendly worker name. Use this in subsequent worker_send / worker_compact calls."),
      session_id: z.string().min(1).describe("Existing session id from worker_list_available."),
      topic: z.string().min(1).describe("One-line description of what this worker is good for."),
    }),
    handler: async (args) => {
      const a = args as { name: string; session_id: string; topic: string };
      const existing = await getWorker(a.name);
      if (existing) {
        return text(`worker '${a.name}' already registered (session_id=${existing.session_id}). Pick a different name or call worker_remove first.`);
      }
      const now = Date.now();
      await upsertWorker(a.name, {
        session_id: a.session_id,
        topic: a.topic,
        created_at: now,
        last_activity_at: now,
      });
      return text(`registered '${a.name}' → ${a.session_id} (topic: ${a.topic})`);
    },
  },

  {
    name: "worker_create",
    description:
      "Spin up a fresh Claude Code session as a named worker, then send it an initial prompt that establishes its context (its role, what to focus on, what's out of scope). Returns the worker's first response. " +
      "Use this when no existing session is mature enough on the topic — for adoption of an existing session use worker_register instead. " +
      "The worker is launched with Bash denied; it cannot execute shell. All shell stays in the master.",
    schema: z.object({
      name: z.string().min(1).describe("Friendly worker name."),
      topic: z.string().min(1).describe("One-line description of what this worker should focus on."),
      initial_prompt: z.string().min(1).describe("The first prompt — should fully establish the worker's role, scope, and what context to load (e.g. file paths, related sessions). The worker will treat this as its founding instructions."),
      timeout_ms: z.number().int().min(10_000).max(30 * 60 * 1000).default(10 * 60 * 1000).describe("Max wait for the worker's first response."),
    }),
    handler: async (args) => {
      const a = args as { name: string; topic: string; initial_prompt: string; timeout_ms: number };
      const existing = await getWorker(a.name);
      if (existing) {
        return text(`worker '${a.name}' already exists (session_id=${existing.session_id}). Use worker_send to talk to it, or worker_remove first to recreate.`);
      }
      const sessionId = randomUUID();
      const result = await createWorker({
        sessionId,
        initialPrompt: a.initial_prompt,
        timeoutMs: a.timeout_ms,
      });
      const now = Date.now();
      await upsertWorker(a.name, {
        session_id: result.session_id,
        topic: a.topic,
        created_at: now,
        last_activity_at: now,
        initial_prompt: a.initial_prompt,
      });
      return text(`created '${a.name}' → ${result.session_id} (topic: ${a.topic})\n\n` + formatTurn(a.name, result));
    },
  },

  {
    name: "worker_send",
    description:
      "Send a prompt to a registered worker. " +
      "Default (background=false) blocks until the worker finishes and returns its final response + a compact tool-call summary — convenient for short questions. " +
      "Set background=true to fire-and-poll: returns a task_id immediately so the master can keep working; retrieve the result later with worker_result, list outstanding tasks with worker_tasks, or kill one with worker_cancel. " +
      "The worker's full conversation history is loaded automatically (via `claude --resume`). " +
      "The worker cannot run Bash — if it needs shell execution, it will say so and the master must run it.",
    schema: z.object({
      name: z.string().min(1).describe("Worker name from worker_list."),
      prompt: z.string().min(1).describe("What to ask / instruct the worker."),
      background: z.boolean().default(false).describe("true = return task_id immediately, poll with worker_result. false = block until done."),
      timeout_ms: z.number().int().min(10_000).max(30 * 60 * 1000).default(10 * 60 * 1000),
    }),
    handler: async (args) => {
      const a = args as { name: string; prompt: string; background: boolean; timeout_ms: number };
      const w = await getWorker(a.name);
      if (!w) {
        return text(`no worker named '${a.name}'. Use worker_list to see registered workers, or worker_create to start a new one.`);
      }
      if (!a.background) {
        const result = await sendToWorker(w.session_id, a.prompt, { timeoutMs: a.timeout_ms });
        await touchWorker(a.name);
        return text(formatTurn(a.name, result));
      }
      // Background: kick off, register task, return immediately.
      reapOldTasks();
      const task = createTask(a.name, a.prompt);
      const { proc, done } = sendToWorkerBackground(w.session_id, a.prompt, { timeoutMs: a.timeout_ms });
      task.proc = proc;
      done.then(
        async (result) => {
          finishTask(task.task_id, { state: "done", result });
          await touchWorker(a.name).catch(() => {});
        },
        (err: Error) => {
          finishTask(task.task_id, { state: "error", error: err.message });
        },
      );
      proc.on("exit", (code, signal) => {
        // If we sent SIGTERM via cancelTask, the close callback above may
        // arrive first with a stdout. Only mark cancelled if still running.
        const cur = getTask(task.task_id);
        if (cur && cur.state === "running" && signal) {
          finishTask(task.task_id, { state: "cancelled", error: `killed by ${signal}` });
        }
      });
      return text(`[worker:${a.name}] started in background — task_id=${task.task_id}. Poll with worker_result.`);
    },
  },

  {
    name: "worker_result",
    description:
      "Fetch a background task's result. If wait_ms>0, blocks up to that long for the task to finish; otherwise returns the current state immediately. " +
      "States: 'running' (no result yet), 'done' (result field populated), 'cancelled' (killed via worker_cancel), 'error' (subprocess crashed or output unparseable).",
    schema: z.object({
      task_id: z.string().min(1).describe("From worker_send { background: true } or worker_tasks."),
      wait_ms: z.number().int().min(0).max(10 * 60 * 1000).default(0).describe("Block up to this long if still running. 0 = poll-only."),
    }),
    handler: async (args) => {
      const a = args as { task_id: string; wait_ms: number };
      let t = await waitForTask(a.task_id, a.wait_ms);
      if (!t) return text(`no task with id ${a.task_id}.`);
      t = getTask(a.task_id) ?? t;
      const elapsed = (t.finished_at ?? Date.now()) - t.started_at;
      const head = `[worker:${t.worker_name}] task=${t.task_id} state=${t.state} (${elapsed}ms)`;
      if (t.state === "running") return text(head + " — still running, retry with worker_result");
      if (t.state === "done" && t.result) return text(head + "\n\n" + formatTurn(t.worker_name, t.result));
      return text(head + (t.error ? `\n\nerror: ${t.error}` : ""));
    },
  },

  {
    name: "worker_tasks",
    description:
      "List all background tasks tracked in this MCP session: running, done, cancelled, errored. " +
      "Completed tasks are reaped after ~1 hour to keep this list short.",
    schema: z.object({}),
    handler: async () => {
      const ts = listTasks();
      if (ts.length === 0) return text("(no background tasks)");
      return json(ts.map((t) => ({
        task_id: t.task_id,
        worker: t.worker_name,
        state: t.state,
        started_at: new Date(t.started_at).toISOString(),
        finished_at: t.finished_at ? new Date(t.finished_at).toISOString() : null,
        elapsed_ms: (t.finished_at ?? Date.now()) - t.started_at,
        prompt_preview: t.prompt.slice(0, 100),
        error: t.error,
      })));
    },
  },

  {
    name: "worker_cancel",
    description:
      "Kill a running background task's subprocess. The worker's session transcript may end up partially written depending on when the kill landed. Does nothing for already-finished tasks.",
    schema: z.object({
      task_id: z.string().min(1),
    }),
    handler: async (args) => {
      const a = args as { task_id: string };
      const r = cancelTask(a.task_id);
      return text(r.ok ? `cancelled task ${a.task_id}` : `cancel failed: ${r.reason}`);
    },
  },

  {
    name: "worker_compact",
    description:
      "Compact a worker's conversation history by invoking `/compact` against it. Use when worker_status shows the session is getting long. " +
      "The worker keeps its identity and topic; only intermediate detail is summarized away.",
    schema: z.object({
      name: z.string().min(1),
      focus: z.string().optional().describe("Optional instruction to /compact about what to preserve (e.g. 'keep all file paths and API endpoints')."),
      timeout_ms: z.number().int().min(10_000).max(30 * 60 * 1000).default(10 * 60 * 1000),
    }),
    handler: async (args) => {
      const a = args as { name: string; focus?: string; timeout_ms: number };
      const w = await getWorker(a.name);
      if (!w) return text(`no worker named '${a.name}'.`);
      const cmd = a.focus ? `/compact ${a.focus}` : "/compact";
      const result = await sendToWorker(w.session_id, cmd, { timeoutMs: a.timeout_ms });
      await touchWorker(a.name);
      return text(formatTurn(a.name, result));
    },
  },

  {
    name: "worker_status",
    description:
      "Report status for one worker: session_id, topic, transcript size, last activity, initial prompt, and a snippet of its most recent exchange. " +
      "Use to decide whether a worker is fresh, busy, or due for compaction.",
    schema: z.object({
      name: z.string().min(1),
    }),
    handler: async (args) => {
      const a = args as { name: string };
      const w = await getWorker(a.name);
      if (!w) return text(`no worker named '${a.name}'.`);
      const all = await listAvailableSessions();
      const session = all.find((s) => s.session_id === w.session_id);
      return json({
        name: a.name,
        session_id: w.session_id,
        topic: w.topic,
        initial_prompt: w.initial_prompt,
        created_at: new Date(w.created_at).toISOString(),
        last_activity_at: new Date(w.last_activity_at).toISOString(),
        transcript_size_kb: session ? Math.round(session.size_bytes / 1024) : null,
        transcript_last_modified: session ? new Date(session.last_activity_at).toISOString() : null,
        last_user_prompt: session?.last_user_prompt,
        last_assistant_snippet: session?.last_assistant_snippet,
      });
    },
  },

  {
    name: "worker_fork",
    description:
      "Fork an existing session (the master's own by default) into a brand-new worker. The fork starts knowing everything the source knew up to fork time, then diverges. " +
      "Use this when you want a worker to keep your full project context as background but go off and do a focused subtask without polluting the master's transcript. " +
      "If `from_session_id` is omitted, forks the master itself (read from CLAUDE_CODE_SESSION_ID). The worker can run in background via worker_send { background: true }. " +
      "Caveat: forking is a snapshot of the transcript file at that instant — if the source session is actively writing, the last line of the fork may be truncated; Claude tolerates this on resume.",
    schema: z.object({
      name: z.string().min(1).describe("Friendly name for the forked worker."),
      topic: z.string().min(1).describe("What the fork should focus on."),
      initial_prompt: z.string().min(1).describe("First prompt to the fork — typically 'here's the subtask, work on it independently'. The fork sees its full prior context PLUS this prompt."),
      from_session_id: z.string().optional().describe("Source session id to fork from. Defaults to the master's own session (CLAUDE_CODE_SESSION_ID)."),
      background: z.boolean().default(true).describe("true = kick off the fork's first turn in background, return immediately. false = block until the fork answers."),
      timeout_ms: z.number().int().min(10_000).max(30 * 60 * 1000).default(10 * 60 * 1000),
    }),
    handler: async (args) => {
      const a = args as {
        name: string;
        topic: string;
        initial_prompt: string;
        from_session_id?: string;
        background: boolean;
        timeout_ms: number;
      };
      const existing = await getWorker(a.name);
      if (existing) {
        return text(`worker '${a.name}' already exists (session_id=${existing.session_id}). Pick another name or worker_remove first.`);
      }
      const source = a.from_session_id || process.env.CLAUDE_CODE_SESSION_ID;
      if (!source) {
        return text("worker_fork: no source session id. Pass from_session_id, or run the master under Claude Code (which sets CLAUDE_CODE_SESSION_ID).");
      }
      const srcPath = sessionTranscriptPath(source);
      try {
        await fs.access(srcPath);
      } catch {
        return text(`worker_fork: source session ${source} has no transcript at ${srcPath} — is this the right project dir?`);
      }
      const newId = randomUUID();
      await forkSession(source, newId);
      const now = Date.now();
      await upsertWorker(a.name, {
        session_id: newId,
        topic: a.topic,
        created_at: now,
        last_activity_at: now,
        initial_prompt: a.initial_prompt,
      });

      if (!a.background) {
        const result = await sendToWorker(newId, a.initial_prompt, { timeoutMs: a.timeout_ms });
        await touchWorker(a.name);
        return text(`forked from ${source} → '${a.name}' (${newId})\n\n` + formatTurn(a.name, result));
      }
      reapOldTasks();
      const task = createTask(a.name, a.initial_prompt);
      const { proc, done } = sendToWorkerBackground(newId, a.initial_prompt, { timeoutMs: a.timeout_ms });
      task.proc = proc;
      done.then(
        async (result) => {
          finishTask(task.task_id, { state: "done", result });
          await touchWorker(a.name).catch(() => {});
        },
        (err: Error) => finishTask(task.task_id, { state: "error", error: err.message }),
      );
      proc.on("exit", (_code, signal) => {
        const cur = getTask(task.task_id);
        if (cur && cur.state === "running" && signal) {
          finishTask(task.task_id, { state: "cancelled", error: `killed by ${signal}` });
        }
      });
      return text(`forked from ${source} → '${a.name}' (${newId}). First turn running in background — task_id=${task.task_id}.`);
    },
  },

  {
    name: "send_feedback",
    description:
      "Send feedback about orch-mcp itself — bugs, missing tools, surprising behavior, or 'this would be easier if'. Opens a GitHub issue. " +
      "Filed via the user's local `gh` CLI when authenticated (so the issue is authored under their account); falls back to a shared bot otherwise. " +
      "Auto-attaches product+version and recent tool calls as context. Use this when orch-mcp itself blocks you — not for issues in the workers' work product.",
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
        process.env.ORCH_MCP_FEEDBACK_ENDPOINT ||
        process.env.CHROME_MCP_ENDPOINT ||
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
      const r = await fileFeedback({
        message, severity, product: "orch", version: VERSION, context, endpoint,
      });
      const via = r.authored_by === "user" ? "via your gh CLI" : "via shared bot (install gh + auth to file as yourself)";
      return text(`filed issue #${r.issue_number} ${via} — ${r.url}`);
    },
  },

  {
    name: "worker_remove",
    description:
      "Unregister a worker by name. This only removes the master's mapping — the underlying Claude session transcript on disk is left untouched and can be re-adopted later via worker_register.",
    schema: z.object({
      name: z.string().min(1),
    }),
    handler: async (args) => {
      const a = args as { name: string };
      const ok = await removeWorker(a.name);
      return text(ok ? `unregistered '${a.name}'` : `no worker named '${a.name}'.`);
    },
  },
];
