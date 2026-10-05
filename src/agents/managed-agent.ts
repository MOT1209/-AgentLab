import type { Device } from "../device/types.js";
import type { DeviceManager } from "../runtime/device-manager.js";
import type { ProviderManager } from "../providers/manager.js";
import type { LlmProvider } from "../providers/types.js";
import type { RuntimeContext } from "../runtime/types.js";
import { Agent, type RunOptions } from "./base.js";
import type { Capability } from "./capabilities.js";
import { AgentDefinition, AgentStatus, BUSY_STATUSES } from "./definitions.js";
import { MessageBus, createMessage } from "./messages.js";
import type { AgentRegistry } from "./registry.js";
import type { AgentResult, Task } from "./types.js";

export interface AgentDeps {
  devices: DeviceManager;
  /** Optional. Without it, handlers get no `llm` and must work deterministically. */
  providers?: ProviderManager;
  registry: AgentRegistry;
  bus: MessageBus;
}

export interface HandlerContext {
  task: Task;
  /** The device assigned to this agent's MAIN agent. Exclusively leased for the duration of the task. */
  device: Device;
  runtime: RuntimeContext;
  /** Cancellation signal from the dispatcher, if any. */
  signal?: AbortSignal;
  /** The LLM provider routed to this agent (its own override, its MAIN's, or the default). */
  llm?: LlmProvider;
  definition: AgentDefinition;
}

/** Configurable unit of work a SUB agent can perform for one task type. */
export interface TaskHandler {
  /** Capabilities the executing agent must declare. */
  readonly requires: readonly Capability[];
  handle(ctx: HandlerContext): Promise<AgentResult>;
}

export type HandlerMap = Readonly<Record<string, TaskHandler>>;

/** Shared lifecycle, status tracking and task gating for MAIN and SUB agents. */
export abstract class ManagedAgent extends Agent {
  private current: AgentStatus = "IDLE";

  constructor(
    readonly definition: AgentDefinition,
    protected readonly deps: AgentDeps,
  ) {
    super(definition.id);
  }

  get kind() {
    return this.definition.kind;
  }
  get status(): AgentStatus {
    return this.current;
  }

  /** The MAIN agent whose device assignment this agent works under (itself, for a MAIN agent). */
  protected get rootMainId(): string {
    return this.definition.kind === "MAIN" ? this.id : (this.definition.parentId as string);
  }

  /** Defined only while the root MAIN agent holds an active lease on its assigned device. */
  protected runtimeContext(): RuntimeContext | undefined {
    return this.deps.devices.contextFor(this.rootMainId, this.id);
  }

  /** True if this agent (or, for MAIN, one of its children) can handle the task type. */
  abstract canHandle(taskType: string): boolean;

  protected setStatus(next: AgentStatus): void {
    if (next === this.current) return;
    const from = this.current;
    this.current = next;
    this.deps.bus.publish(createMessage("STATUS_CHANGED", this.id, this.id, { from, to: next }));
  }

  private isBusy(): boolean {
    return BUSY_STATUSES.has(this.current);
  }

  pause(): void {
    if (this.isBusy()) throw new Error(`${this.id} is busy (${this.current}); cannot pause`);
    this.setStatus("PAUSED");
  }
  resume(): void {
    if (this.current !== "PAUSED") throw new Error(`${this.id} is not paused`);
    this.setStatus("IDLE");
  }
  setOffline(): void {
    if (this.isBusy()) throw new Error(`${this.id} is busy (${this.current}); cannot go offline`);
    this.setStatus("OFFLINE");
  }
  setOnline(): void {
    if (this.current !== "OFFLINE") throw new Error(`${this.id} is not offline`);
    this.setStatus("IDLE");
  }

  override async run(task: Task, opts: RunOptions = {}) {
    if (this.current === "PAUSED" || this.current === "OFFLINE" || this.isBusy()) {
      task.status = "BLOCKED";
      task.errors.push(`${this.id} cannot accept tasks while ${this.current}`);
      task.timestamps.finished = new Date().toISOString();
      return task as Awaited<ReturnType<Agent["run"]>>;
    }
    this.setStatus("EXECUTING");
    const done = await super.run(task, opts);
    // ERROR means this agent itself failed (exception, no result). A child's ERROR that was
    // aggregated into a result does not make the parent unhealthy. It persists until the next accepted task.
    this.setStatus(done.status === "ERROR" && done.result === undefined ? "ERROR" : "IDLE");
    return done;
  }
}
