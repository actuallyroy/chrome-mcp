// Enumerate Claude Code session transcripts for the current project so the
// master can discover existing (potentially mature) sessions worth adopting.
//
// Claude Code writes each session's full conversation as a JSONL stream at:
//   ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
//
// We read each file's last few lines to extract a "topic" hint (the most
// recent user prompt) and "last activity" (mtime). That's enough for the
// master to decide which one is mature enough on a given subject.

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { encodeProjectDir, projectRoot } from "./registry.js";

export type AvailableSession = {
  session_id: string;
  last_activity_at: number;
  size_bytes: number;
  // Best-effort: the most recent user message in the transcript, trimmed.
  last_user_prompt?: string;
  // Best-effort: a short snippet from the last assistant response, trimmed.
  last_assistant_snippet?: string;
};

export function projectClaudeDir(): string {
  return join(
    homedir(),
    ".claude",
    "projects",
    encodeProjectDir(projectRoot()),
  );
}

export function sessionTranscriptPath(sessionId: string): string {
  return join(projectClaudeDir(), `${sessionId}.jsonl`);
}

// Snapshot a session's transcript under a brand-new UUID, returning the new
// id. The destination file is a byte-for-byte copy at the moment of the
// snapshot, so resuming with the new id loads the same conversation as the
// source had up to that point. From there the two sessions diverge — turns
// added to one don't reach the other.
//
// Safe even while the source session is actively in use: we use streaming
// copy so partial writes from the source aren't a concern (we capture the
// state-of-the-world at copy time and that's it). If a write to the source
// is mid-flight, the destination may end with a truncated last line —
// `claude --resume` tolerates this because parse is line-delimited.
export async function forkSession(sourceSessionId: string, newSessionId: string): Promise<void> {
  const src = sessionTranscriptPath(sourceSessionId);
  const dst = sessionTranscriptPath(newSessionId);
  await fs.mkdir(projectClaudeDir(), { recursive: true });
  await fs.copyFile(src, dst);
}

// Cheap "tail": read last ~32KB of the file and split by lines. Transcript
// lines are JSON objects on their own line, so we can parse the trailing N.
async function tailLines(path: string, maxBytes = 32 * 1024): Promise<string[]> {
  const fh = await fs.open(path, "r");
  try {
    const stat = await fh.stat();
    const size = stat.size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    return buf.toString("utf8").split("\n").filter((l) => l.trim().length > 0);
  } finally {
    await fh.close();
  }
}

function extractText(msg: unknown): string {
  // Anthropic content is either a string or an array of {type, text}.
  // Defensive: handle either, return empty otherwise.
  if (typeof msg === "string") return msg;
  if (Array.isArray(msg)) {
    return msg
      .map((b) => (typeof b === "object" && b && (b as { text?: string }).text) || "")
      .join(" ");
  }
  return "";
}

export async function listAvailableSessions(): Promise<AvailableSession[]> {
  const dir = projectClaudeDir();
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }

  const results: AvailableSession[] = [];
  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    const path = join(dir, name);
    const session_id = name.replace(/\.jsonl$/, "");
    try {
      const stat = await fs.stat(path);
      const lines = await tailLines(path);

      // Walk tail in reverse to find the most recent user message and
      // assistant message — they may be interleaved with tool use entries.
      let last_user_prompt: string | undefined;
      let last_assistant_snippet: string | undefined;
      for (let i = lines.length - 1; i >= 0 && (!last_user_prompt || !last_assistant_snippet); i--) {
        try {
          const obj = JSON.parse(lines[i]) as {
            type?: string;
            message?: { role?: string; content?: unknown };
          };
          const msg = obj.message;
          if (!msg) continue;
          if (msg.role === "user" && !last_user_prompt) {
            const t = extractText(msg.content).trim();
            if (t) last_user_prompt = t.slice(0, 240);
          } else if (msg.role === "assistant" && !last_assistant_snippet) {
            const t = extractText(msg.content).trim();
            if (t) last_assistant_snippet = t.slice(0, 240);
          }
        } catch {
          // Lines that aren't message envelopes (e.g. summary entries) are fine to skip.
        }
      }

      results.push({
        session_id,
        last_activity_at: stat.mtimeMs,
        size_bytes: stat.size,
        last_user_prompt,
        last_assistant_snippet,
      });
    } catch {
      // File disappeared mid-scan or unreadable — skip it.
    }
  }

  results.sort((a, b) => b.last_activity_at - a.last_activity_at);
  return results;
}
