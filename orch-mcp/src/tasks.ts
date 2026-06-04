// In-flight background task registry. When worker_send is invoked with
// background=true the subprocess is kicked off and a task_id is returned
// immediately; the master can keep working and later poll worker_result.
//
// State is in-memory only — restarting the MCP loses in-flight handles. For
// short-to-medium tasks (the dominant case) that's fine. A task that's
// already running in its own subprocess will keep running and update the
// session transcript on disk regardless; the master just can't fetch the
// structured result after a restart (it would need to re-resume the worker
// with no prompt to inspect the latest exchange).

import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import type { WorkerTurnResult } from "./claude.js";

export type TaskState = "running" | "done" | "cancelled" | "error";

export type Task = {
  task_id: string;
  worker_name: string;
  prompt: string;
  state: TaskState;
  started_at: number;
  finished_at?: number;
  result?: WorkerTurnResult;
  error?: string;
  // The underlying subprocess so we can cancel.
  proc?: ChildProcess;
  // Resolver hooks for worker_result wait_ms blocking.
  waiters: Array<(t: Task) => void>;
};

const tasks = new Map<string, Task>();

export function createTask(workerName: string, prompt: string): Task {
  const task: Task = {
    task_id: randomUUID(),
    worker_name: workerName,
    prompt,
    state: "running",
    started_at: Date.now(),
    waiters: [],
  };
  tasks.set(task.task_id, task);
  return task;
}

export function attachProcess(taskId: string, proc: ChildProcess): void {
  const t = tasks.get(taskId);
  if (t) t.proc = proc;
}

export function finishTask(
  taskId: string,
  outcome:
    | { state: "done"; result: WorkerTurnResult }
    | { state: "cancelled"; error?: string }
    | { state: "error"; error: string },
): void {
  const t = tasks.get(taskId);
  if (!t) return;
  t.state = outcome.state;
  t.finished_at = Date.now();
  if (outcome.state === "done") t.result = outcome.result;
  if (outcome.state !== "done") t.error = outcome.error;
  // Detach proc — outcome is final, no need for the handle anymore.
  t.proc = undefined;
  // Wake all waiters.
  const waiters = t.waiters.splice(0);
  for (const w of waiters) w(t);
}

export function getTask(taskId: string): Task | null {
  return tasks.get(taskId) || null;
}

export function listTasks(): Task[] {
  return Array.from(tasks.values()).sort((a, b) => b.started_at - a.started_at);
}

// Wait for a task to leave the "running" state, up to timeoutMs. Returns the
// task in its current state (which may still be "running" if the wait timed
// out). Resolves immediately if the task is already finished.
export function waitForTask(taskId: string, timeoutMs: number): Promise<Task | null> {
  const t = tasks.get(taskId);
  if (!t) return Promise.resolve(null);
  if (t.state !== "running") return Promise.resolve(t);
  if (timeoutMs <= 0) return Promise.resolve(t);
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | null = setTimeout(() => {
      timer = null;
      // Remove this waiter from the queue so finishTask doesn't double-call.
      const idx = t.waiters.indexOf(onDone);
      if (idx >= 0) t.waiters.splice(idx, 1);
      resolve(t);
    }, timeoutMs);
    const onDone = (task: Task) => {
      if (timer) { clearTimeout(timer); timer = null; }
      resolve(task);
    };
    t.waiters.push(onDone);
  });
}

export function cancelTask(taskId: string): { ok: boolean; reason?: string } {
  const t = tasks.get(taskId);
  if (!t) return { ok: false, reason: "no such task" };
  if (t.state !== "running") return { ok: false, reason: `task already ${t.state}` };
  if (!t.proc) return { ok: false, reason: "no process handle (race with finish?)" };
  try {
    t.proc.kill("SIGTERM");
    // Give it a beat to exit gracefully; the exit handler will call finishTask.
    setTimeout(() => { try { t.proc?.kill("SIGKILL"); } catch { /* ignore */ } }, 2000);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

// Reap completed tasks older than maxAgeMs so the in-memory map doesn't grow
// forever during a long-lived MCP session. Safe to call periodically.
export function reapOldTasks(maxAgeMs = 60 * 60 * 1000): number {
  const cutoff = Date.now() - maxAgeMs;
  let n = 0;
  for (const [id, t] of tasks) {
    if (t.state === "running") continue;
    if ((t.finished_at ?? t.started_at) < cutoff) {
      tasks.delete(id);
      n++;
    }
  }
  return n;
}
