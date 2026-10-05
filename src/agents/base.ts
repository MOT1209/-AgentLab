import { randomUUID } from "node:crypto";
import { AgentResult, Priority, Task } from "./types.js";

export interface RunOptions {
  /** Cooperative cancellation. Agents stop at the next safe point and report what they have. */
  signal?: AbortSignal;
}

export abstract class Agent {
  constructor(readonly id: string) {}

  /** Specialized work. May throw; run() isolates failures. */
  protected abstract execute(task: Task, opts: RunOptions): Promise<AgentResult>;

  /** Failure-isolated lifecycle: RECEIVE -> EXECUTE -> VERIFY -> REPORT. */
  async run(task: Task, opts: RunOptions = {}): Promise<Task<unknown, AgentResult>> {
    task.status = "RUNNING";
    task.timestamps.started = new Date().toISOString();
    try {
      const result = await this.execute(task, opts);
      task.result = result;
      task.status = result.status;
    } catch (e) {
      task.status = "ERROR";
      task.errors.push(e instanceof Error ? e.message : String(e));
    }
    task.timestamps.finished = new Date().toISOString();
    return task as Task<unknown, AgentResult>;
  }
}

export function newTask(agent_id: string, type: string, payload: unknown, priority: Priority = "NORMAL"): Task {
  return {
    task_id: randomUUID(),
    agent_id,
    type,
    priority,
    status: "PENDING",
    payload,
    errors: [],
    timestamps: { created: new Date().toISOString() },
  };
}
