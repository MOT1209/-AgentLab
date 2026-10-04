import { randomUUID } from "node:crypto";
import { AgentResult, Priority, Task } from "./types.js";

export abstract class Agent {
  constructor(readonly id: string) {}

  /** Specialized work. May throw; run() isolates failures. */
  protected abstract execute(task: Task): Promise<AgentResult>;

  /** Failure-isolated lifecycle: RECEIVE -> EXECUTE -> VERIFY -> REPORT. */
  async run(task: Task): Promise<Task<unknown, AgentResult>> {
    task.status = "RUNNING";
    task.timestamps.started = new Date().toISOString();
    try {
      const result = await this.execute(task);
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
