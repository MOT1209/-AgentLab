import { Agent, newTask } from "./agents/base.js";
import { Task } from "./agents/types.js";

export class Orchestrator {
  private agents = new Map<string, Agent>();

  register(agent: Agent): void {
    if (this.agents.has(agent.id)) throw new Error(`duplicate agent: ${agent.id}`);
    this.agents.set(agent.id, agent);
  }

  async dispatch(agentId: string, type: string, payload: unknown): Promise<Task> {
    const agent = this.agents.get(agentId);
    const task = newTask(agentId, type, payload);
    if (!agent) {
      task.status = "ERROR";
      task.errors.push(`unknown agent: ${agentId}`);
      return task;
    }
    return agent.run(task);
  }
}
