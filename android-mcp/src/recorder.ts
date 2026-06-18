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

// Always-on rolling buffer of recent calls (separate from explicit recording).
// Used by send_feedback to attach context without needing the user to have
// pressed "record".
const RECENT_MAX = 20;
const recent: FlowEntry[] = [];
export function getRecentCalls(): FlowEntry[] {
  return recent.slice();
}

// Tools that record themselves shouldn't be recorded (infinite recursion in logs).
const META_TOOLS = new Set(["start_recording", "stop_recording", "recording_status"]);

// Read-only inspection tools: they observe device/app state but don't mutate it,
// so replaying them is a no-op. We keep them out of the saved flow (state.entries)
// but still buffer them in `recent` for feedback/diagnostics context.
// Waits (wait_for_*) and assertions are deliberately NOT here — they carry
// synchronization / checkpoint value on replay.
const READ_ONLY_TOOLS = new Set([
  "outline", "describe", "screenshot",
  "device_info", "current_app", "list_devices",
  "get_logcat",
  "sqlite_check", "sqlite_list_databases", "sqlite_list_packages",
  "sqlite_list_tables", "sqlite_table_schema", "sqlite_query", "sqlite_pull_db",
]);

// Tools that mutate / act but still don't belong in a replayable flow:
//  - pause blocks on a human and would stall replay
//  - run_script runs another flow (meta, not a UI step)
//  - save_flow/delete_flow/list_flows are flow management, like start_recording
// Kept in `recent` for diagnostics, excluded from the saved flow.
const NON_REPLAYABLE_TOOLS = new Set([
  "pause", "run_script", "save_flow", "delete_flow", "list_flows",
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
  // Always push to recent rolling buffer.
  recent.push(entry);
  while (recent.length > RECENT_MAX) recent.shift();
  // Also push to active recording if any — but skip read-only inspection calls
  // (no-ops on replay) and non-replayable interactive / meta tools.
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
