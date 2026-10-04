import { AgentRegistry } from "./agents/registry.js";
import { MessageBus, ORCHESTRATOR, createMessage } from "./agents/messages.js";
import { newTask } from "./agents/base.js";
import type { Task } from "./agents/types.js";

/** Dispatches top-level tasks to MAIN agents. Sub-agents only receive work from their parent. */
export class Orchestrator {
  constructor(
    readonly registry: AgentRegistry,
    readonly bus: MessageBus = new MessageBus(),
  ) {}

  async dispatch(agentId: string, type: string, payload: unknown): Promise<Task> {
    const task = newTask(agentId, type, payload);
    const agent = this.registry.get(agentId);
    const reject = (reason: string): Task => {
      task.status = "ERROR";
      task.errors.push(reason);
      this.bus.publish(createMessage("ERROR", ORCHESTRATOR, agentId, { reason }, task.task_id));
      return task;
    };
    if (!agent) return reject(`unknown agent: ${agentId}`);
    if (agent.kind !== "MAIN") return reject(`${agentId} is a SUB agent; dispatch to its MAIN parent`);

    this.bus.publish(createMessage("TASK_ASSIGNED", ORCHESTRATOR, agentId, { type }, task.task_id));
    const done = await agent.run(task);
    this.bus.publish(
      createMessage("TASK_RESULT", agentId, ORCHESTRATOR, { status: done.status, summary: done.result?.summary }, task.task_id),
    );
    return done;
  }
}
