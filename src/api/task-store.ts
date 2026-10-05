import type { AgentResult, Task, TaskStatus } from "../agents/types.js";

export interface TaskRecord {
  taskId: string;
  agentId: string;
  type: string;
  status: TaskStatus;
  startedAt?: string;
  finishedAt?: string;
  result?: AgentResult;
  errors: string[];
}

/** In-memory task_id -> last known status/result, fed by a dispatch promise. No persistence (see known-issues.md). */
export class TaskStore {
  private readonly tasks = new Map<string, TaskRecord>();

  /** Registers a task as RUNNING and updates it when the dispatch promise settles. */
  track(taskId: string, agentId: string, type: string, pending: Promise<Task<unknown, AgentResult>>): void {
    this.tasks.set(taskId, { taskId, agentId, type, status: "RUNNING", errors: [] });
    pending
      .then((task) => {
        const rec = this.tasks.get(taskId);
        if (!rec) return;
        rec.status = task.status;
        rec.errors = task.errors;
        if (task.result) rec.result = task.result;
        if (task.timestamps.started) rec.startedAt = task.timestamps.started;
        if (task.timestamps.finished) rec.finishedAt = task.timestamps.finished;
      })
      .catch((e: unknown) => {
        const rec = this.tasks.get(taskId);
        if (!rec) return;
        rec.status = "ERROR";
        rec.errors.push(e instanceof Error ? e.message : String(e));
      });
  }

  get(taskId: string): TaskRecord | undefined {
    return this.tasks.get(taskId);
  }
}
