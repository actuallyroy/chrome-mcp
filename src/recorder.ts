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

// Tools that record themselves shouldn't be recorded (infinite recursion in logs).
const META_TOOLS = new Set(["start_recording", "stop_recording", "recording_status"]);

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
  if (!state.active || META_TOOLS.has(tool)) return;
  state.entries.push({
    ts: Date.now(),
    tool,
    args,
    ok,
    result_preview: preview && preview.length > 200 ? preview.slice(0, 200) + "…" : preview,
  });
}

export function recorderStatus() {
  return {
    active: state.active,
    entries_recorded: state.entries.length,
    started_at: state.startedAt ? new Date(state.startedAt).toISOString() : null,
    path: state.path || null,
  };
}
