import { DeviceError } from "../device/types.js";
import { AgentDeps, HandlerMap, ManagedAgent } from "./managed-agent.js";
import type { AgentDefinition } from "./definitions.js";
import type { AgentResult, Task } from "./types.js";

/** Specialized executor. Behaviour comes from injected handlers, not subclasses. */
export class SubAgent extends ManagedAgent {
  constructor(
    definition: AgentDefinition,
    deps: AgentDeps,
    private readonly handlers: HandlerMap = {},
  ) {
    super(definition, deps);
  }

  canHandle(taskType: string): boolean {
    return Object.hasOwn(this.handlers, taskType);
  }

  protected async execute(task: Task): Promise<AgentResult> {
    if (!this.canHandle(task.type)) {
      return { status: "BLOCKED", summary: `${this.id} has no handler for task type '${task.type}'`, evidence: [] };
    }
    const handler = this.handlers[task.type]!;
    const missing = handler.requires.filter((c) => !this.definition.capabilities.includes(c));
    if (missing.length > 0) {
      return { status: "BLOCKED", summary: `${this.id} lacks capabilities: ${missing.join(", ")}`, evidence: [] };
    }
    try {
      return await handler.handle({ task, device: this.deps.device, definition: this.definition });
    } catch (e) {
      // An unavailable device is an environment problem, not an agent fault.
      if (e instanceof DeviceError) return { status: "BLOCKED", summary: e.message, evidence: [] };
      throw e;
    }
  }
}
