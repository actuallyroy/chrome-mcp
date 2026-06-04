// Wrap the `claude` CLI in headless / print mode so the master session can
// drive workers. Each `worker_send` invocation:
//
//   claude --resume <id> -p "<prompt>" --output-format json --disallowedTools 'Bash'
//
// The CLI loads the worker's full conversation, runs one more turn against
// the model, prints a single JSON object summarizing the turn (including any
// tool calls the worker made), and exits. The transcript on disk is updated
// in place — the worker stays "mature" because we never reset its history.
//
// Bash is denied so workers can analyze + plan + edit files but can't execute
// shell. All shell execution stays in the master session where the user can
// see it — that's the explicit design constraint.

import { execFile, type ChildProcess } from "node:child_process";

const CLAUDE_BIN = process.env.ORCH_MCP_CLAUDE_BIN || "claude";
// Default worker tool deny list. Bash is the explicit one the user asked
// for; others can be added later if a worker is doing something it shouldn't.
const DEFAULT_DENY_TOOLS = ["Bash"];

export type ToolCallSummary = {
  name: string;
  // Compact preview of the input — first ~100 chars so master sees what
  // happened without the worker's entire file dump.
  input_preview: string;
};

export type WorkerTurnResult = {
  session_id: string;
  // The worker's final text response.
  final_text: string;
  // Compact list of tool calls the worker made during the turn.
  tool_calls: ToolCallSummary[];
  // Wall-clock duration in ms.
  duration_ms: number;
  // Total cost in USD (Claude CLI reports this in JSON output).
  cost_usd?: number;
  // Total tokens. Some Claude CLI versions report input/output separately.
  input_tokens?: number;
  output_tokens?: number;
  // Whether the CLI returned a non-zero exit code or hit an error.
  is_error: boolean;
  // If something went wrong, the raw stderr / error message.
  error?: string;
};

type ClaudeJsonOutput = {
  type?: string;
  session_id?: string;
  result?: string;
  is_error?: boolean;
  duration_ms?: number;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  // Full transcript for the turn. Each entry mirrors an Anthropic message.
  messages?: Array<{
    role: string;
    content: unknown;
  }>;
  error?: string;
};

function extractToolCalls(msgs: ClaudeJsonOutput["messages"] = []): ToolCallSummary[] {
  const calls: ToolCallSummary[] = [];
  for (const m of msgs) {
    if (m.role !== "assistant") continue;
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (typeof b !== "object" || !b) continue;
      const block = b as { type?: string; name?: string; input?: unknown };
      if (block.type === "tool_use" && block.name) {
        const input = block.input ? JSON.stringify(block.input).slice(0, 100) : "";
        calls.push({ name: block.name, input_preview: input });
      }
    }
  }
  return calls;
}

function extractFinalText(parsed: ClaudeJsonOutput): string {
  // Prefer the top-level `result` field — that's what Claude CLI prints as
  // the final answer in JSON mode.
  if (typeof parsed.result === "string" && parsed.result.trim()) return parsed.result;
  // Fall back: pick the last assistant message's text content.
  const msgs = parsed.messages || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role !== "assistant") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      const text = m.content
        .map((b) => (typeof b === "object" && b && (b as { type?: string; text?: string }).type === "text" ? (b as { text?: string }).text || "" : ""))
        .join("\n")
        .trim();
      if (text) return text;
    }
  }
  return "";
}

// Return both a promise for the result AND the underlying ChildProcess so
// callers (the background-task layer) can hold the handle for cancellation
// without having to remember a separate map.
function runClaude(args: string[], timeoutMs: number): {
  proc: ChildProcess;
  done: Promise<{ stdout: string; stderr: string; code: number | null }>;
} {
  let proc!: ChildProcess;
  const done = new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
    proc = execFile(
      CLAUDE_BIN,
      args,
      { timeout: timeoutMs, maxBuffer: 128 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
          reject(new Error(
            `'${CLAUDE_BIN}' not on PATH. Install Claude Code CLI or set ORCH_MCP_CLAUDE_BIN.`,
          ));
          return;
        }
        const code = err ? (err as NodeJS.ErrnoException & { code?: number }).code ?? null : 0;
        resolve({ stdout: stdout || "", stderr: stderr || "", code: typeof code === "number" ? code : null });
      },
    );
  });
  return { proc, done };
}

function buildDenyArg(extraDenied: string[] = []): string[] {
  const denied = [...DEFAULT_DENY_TOOLS, ...extraDenied];
  return denied.length > 0 ? ["--disallowedTools", denied.join(" ")] : [];
}

export type SendOptions = {
  timeoutMs?: number;
  extraDeniedTools?: string[];
};

function shapeResult(
  sessionId: string,
  duration_ms: number,
  stdout: string,
  stderr: string,
  code: number | null,
): WorkerTurnResult {
  if (!stdout.trim()) {
    return {
      session_id: sessionId,
      final_text: "",
      tool_calls: [],
      duration_ms,
      is_error: true,
      error: `claude exited code=${code} with no stdout. stderr: ${stderr.slice(0, 500)}`,
    };
  }
  let parsed: ClaudeJsonOutput;
  try {
    parsed = JSON.parse(stdout) as ClaudeJsonOutput;
  } catch (e) {
    return {
      session_id: sessionId,
      final_text: stdout.slice(0, 2000),
      tool_calls: [],
      duration_ms,
      is_error: true,
      error: `failed to parse claude JSON output: ${(e as Error).message}`,
    };
  }
  return {
    session_id: parsed.session_id || sessionId,
    final_text: extractFinalText(parsed),
    tool_calls: extractToolCalls(parsed.messages),
    duration_ms: parsed.duration_ms ?? duration_ms,
    cost_usd: parsed.total_cost_usd,
    input_tokens: parsed.usage?.input_tokens,
    output_tokens: parsed.usage?.output_tokens,
    is_error: Boolean(parsed.is_error),
    error: parsed.error,
  };
}

// Synchronous-style invocation: spawns subprocess, awaits, returns parsed
// result. Most callers (foreground worker_send) use this.
export async function sendToWorker(
  sessionId: string,
  prompt: string,
  opts: SendOptions = {},
): Promise<WorkerTurnResult> {
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;
  const args = [
    "--resume", sessionId,
    "-p", prompt,
    "--output-format", "json",
    ...buildDenyArg(opts.extraDeniedTools),
  ];
  const t0 = Date.now();
  const { done } = runClaude(args, timeoutMs);
  const { stdout, stderr, code } = await done;
  return shapeResult(sessionId, Date.now() - t0, stdout, stderr, code);
}

// Background variant: returns the subprocess handle + a promise that resolves
// to the parsed result. The task layer holds both — handle for cancellation,
// promise for the eventual finish callback.
export function sendToWorkerBackground(
  sessionId: string,
  prompt: string,
  opts: SendOptions = {},
): { proc: ChildProcess; done: Promise<WorkerTurnResult> } {
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;
  const args = [
    "--resume", sessionId,
    "-p", prompt,
    "--output-format", "json",
    ...buildDenyArg(opts.extraDeniedTools),
  ];
  const t0 = Date.now();
  const { proc, done } = runClaude(args, timeoutMs);
  const result = done.then(({ stdout, stderr, code }) =>
    shapeResult(sessionId, Date.now() - t0, stdout, stderr, code),
  );
  return { proc, done: result };
}

export type CreateOptions = {
  sessionId: string;
  initialPrompt: string;
  timeoutMs?: number;
  extraDeniedTools?: string[];
};

// Start a fresh worker session with a pre-assigned UUID so the master can
// store the mapping immediately. The first prompt establishes context.
export async function createWorker(opts: CreateOptions): Promise<WorkerTurnResult> {
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;
  const args = [
    "--session-id", opts.sessionId,
    "-p", opts.initialPrompt,
    "--output-format", "json",
    ...buildDenyArg(opts.extraDeniedTools),
  ];
  const t0 = Date.now();
  const { done } = runClaude(args, timeoutMs);
  const { stdout, stderr, code } = await done;
  return shapeResult(opts.sessionId, Date.now() - t0, stdout, stderr, code);
}
