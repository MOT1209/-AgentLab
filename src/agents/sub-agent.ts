import { DeviceError } from "../device/types.js";
import { DEVICE_CAPABILITIES } from "./capabilities.js";
import type { RunOptions } from "./base.js";
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

  protected async execute(task: Task, opts: RunOptions): Promise<AgentResult> {
    if (!this.canHandle(task.type)) {
      return { status: "BLOCKED", summary: `${this.id} has no handler for task type '${task.type}'`, evidence: [] };
    }
    const handler = this.handlers[task.type]!;
    const missing = handler.requires.filter((c) => !this.definition.capabilities.includes(c));
    if (missing.length > 0) {
      return { status: "BLOCKED", summary: `${this.id} lacks capabilities: ${missing.join(", ")}`, evidence: [] };
    }
    const runtime = this.runtimeContext();
    if (!runtime) {
      return { status: "BLOCKED", summary: `${this.id}: no active device lease for ${this.rootMainId}`, evidence: [] };
    }
    const unsupported = handler.requires.filter((c) => DEVICE_CAPABILITIES.includes(c) && !runtime.capabilities.includes(c));
    if (unsupported.length > 0) {
      return { status: "BLOCKED", summary: `device ${runtime.deviceId} does not support: ${unsupported.join(", ")}`, evidence: [] };
    }
    const device = this.deps.devices.getDevice(runtime.deviceId);
    if (!device) return { status: "BLOCKED", summary: `device ${runtime.deviceId} is no longer registered`, evidence: [] };
    try {
      const llm = this.deps.providers?.forAgent(this.id, this.rootMainId);
      return await handler.handle({ task, device, runtime, definition: this.definition, ...(llm ? { llm } : {}), ...(opts.signal ? { signal: opts.signal } : {}) });
    } catch (e) {
      // An unavailable device is an environment problem, not an agent fault.
      if (e instanceof DeviceError) return { status: "BLOCKED", summary: e.message, evidence: [] };
      throw e;
    }
  }
}
