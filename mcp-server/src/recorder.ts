import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type FlowEntry = {
  ts: number;
  tool: string;
  args: unknown;
  ok: boolean;
  result_preview?: string;
};

type RecorderState = {
  active: boolean;
  entries: FlowEntry[];
  startedAt: number;
  path?: string;
};

const state: RecorderState = { active: false, entries: [], startedAt: 0 };

const RECENT_MAX = 20;
const recent: FlowEntry[] = [];
export function getRecentCalls(): FlowEntry[] {
  return recent.slice();
}

// Tools that record themselves shouldn't be recorded (infinite recursion in logs).
const META_TOOLS = new Set(["start_recording", "stop_recording", "recording_status"]);

// Read-only inspection tools: they observe page state but don't mutate it, so
// replaying them is a no-op. We keep them out of the saved flow (state.entries)
// but still buffer them in `recent` for feedback/diagnostics context.
// Waits (wait_for_*) and assertions are deliberately NOT here — they carry
// synchronization / checkpoint value on replay.
const READ_ONLY_TOOLS = new Set([
  "outline", "describe", "screenshot", "snapshot",
  "get_text", "get_html", "get_url", "get_title", "get_attribute",
  "get_toasts", "get_console", "get_network", "get_cookies",
  "list_tabs",
]);

// Tools that mutate / act but still don't belong in a replayable flow:
//  - pause/resume block on a human and would stall replay
//  - run_script runs another flow (meta, not a UI step)
//  - launch_chrome is session bootstrap, not a user action
// Kept in `recent` for diagnostics, excluded from the saved flow.
const NON_REPLAYABLE_TOOLS = new Set([
  "pause", "resume", "run_script", "launch_chrome",
]);

export function isRecording(): boolean {
  return state.active;
}

export function startRecording(path?: string) {
  state.active = true;
  state.entries = [];
  state.startedAt = Date.now();
  state.path = path;
}

export function stopRecording(): { path?: string; entries: FlowEntry[]; started_at: number; duration_ms: number } {
  const out = {
    entries: state.entries,
    started_at: state.startedAt,
    duration_ms: Date.now() - state.startedAt,
    path: state.path,
  };
  if (state.path) {
    const doc = {
      version: 1,
      recorded_at: new Date(state.startedAt).toISOString(),
      duration_ms: out.duration_ms,
      entries: out.entries,
    };
    mkdirSync(dirname(state.path), { recursive: true });
    writeFileSync(state.path, JSON.stringify(doc, null, 2), "utf8");
  }
  state.active = false;
  state.entries = [];
  return out;
}

export function recordCall(tool: string, args: unknown, ok: boolean, preview?: string) {
  if (META_TOOLS.has(tool) || tool === "send_feedback") return;
  const entry: FlowEntry = {
    ts: Date.now(),
    tool,
    args,
    ok,
    result_preview: preview && preview.length > 200 ? preview.slice(0, 200) + "…" : preview,
  };
  recent.push(entry);
  while (recent.length > RECENT_MAX) recent.shift();
  // Read-only and non-replayable (interactive / meta) calls are kept in `recent`
  // for diagnostics but excluded from the saved flow.
  if (state.active && !READ_ONLY_TOOLS.has(tool) && !NON_REPLAYABLE_TOOLS.has(tool)) {
    state.entries.push(entry);
  }
}

export function recorderStatus() {
  return {
    active: state.active,
    entries_recorded: state.entries.length,
    started_at: state.startedAt ? new Date(state.startedAt).toISOString() : null,
    path: state.path || null,
  };
}
