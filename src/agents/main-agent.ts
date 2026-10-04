import { newTask } from "./base.js";
import { aggregateStatus } from "./aggregate.js";
import { createMessage } from "./messages.js";
import { ManagedAgent } from "./managed-agent.js";
import type { AgentResult, ChildOutcome, Evidence, Task } from "./types.js";

/** Coordinator: selects capable children, delegates, validates and combines their results. */
export class MainAgent extends ManagedAgent {
  private capableChildren(taskType: string): ManagedAgent[] {
    return this.deps.registry.childrenOf(this.id).filter((c) => c.canHandle(taskType));
  }

  canHandle(taskType: string): boolean {
    return this.capableChildren(taskType).length > 0;
  }

  protected async execute(task: Task): Promise<AgentResult> {
    this.setStatus("PLANNING");
    const targets = this.capableChildren(task.type);
    if (targets.length === 0) {
      return { status: "BLOCKED", summary: `${this.id}: no sub-agent can handle task type '${task.type}'`, evidence: [] };
    }

    this.setStatus("WAITING");
    const outcomes: ChildOutcome[] = [];
    const evidence: Evidence[] = [];
    // Sequential on purpose: sub-agents share one device.
    for (const child of targets) {
      const sub = newTask(child.id, task.type, task.payload, task.priority);
      sub.parent_task_id = task.task_id;
      this.deps.bus.publish(createMessage("TASK_ASSIGNED", this.id, child.id, { type: sub.type }, sub.task_id));
      const done = await child.run(sub);
      const result = done.result as AgentResult | undefined;
      const summary = result?.summary ?? (done.errors.join("; ") || "no result");
      this.deps.bus.publish(createMessage("TASK_RESULT", child.id, this.id, { status: done.status, summary }, sub.task_id));
      outcomes.push({ agentId: child.id, taskId: sub.task_id, status: done.status, summary });
      for (const e of result?.evidence ?? []) evidence.push({ ...e, source: e.source ?? child.id });
    }

    this.setStatus("REVIEWING");
    const status = aggregateStatus(outcomes.map((o) => o.status));
    const summary =
      outcomes.length === 1
        ? outcomes[0]!.summary
        : `${outcomes.length} sub-agents: ` + outcomes.map((o) => `${o.agentId}=${o.status}`).join(", ");
    return { status, summary, evidence, children: outcomes };
  }
}
