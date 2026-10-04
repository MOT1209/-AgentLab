import type { ProviderManager } from "../providers/manager.js";
import type { DeviceManager } from "../runtime/device-manager.js";
import { AgentDefinition, AgentValidationError } from "./definitions.js";
import { MainAgent } from "./main-agent.js";
import { AgentDeps, HandlerMap, ManagedAgent } from "./managed-agent.js";
import { MessageBus } from "./messages.js";
import { CANONICAL_DEFINITIONS } from "./organization.js";
import type { AgentRegistry } from "./registry.js";
import { SubAgent } from "./sub-agent.js";
import { assertValid, validateDefinition } from "./validation.js";

/** Handlers per SUB agent id, then per task type. This is how behaviour is configured. */
export type BehaviorTable = Readonly<Record<string, HandlerMap>>;

export interface FactoryOptions {
  devices: DeviceManager;
  providers?: ProviderManager;
  registry: AgentRegistry;
  bus?: MessageBus;
  behaviors?: BehaviorTable;
}

export class AgentFactory {
  private readonly deps: AgentDeps;
  private readonly behaviors: BehaviorTable;

  constructor(opts: FactoryOptions) {
    this.deps = { devices: opts.devices, ...(opts.providers ? { providers: opts.providers } : {}), registry: opts.registry, bus: opts.bus ?? new MessageBus() };
    this.behaviors = opts.behaviors ?? {};
  }

  get bus(): MessageBus {
    return this.deps.bus;
  }

  createMain(def: AgentDefinition): MainAgent {
    assertValid(validateDefinition(def), "invalid agent definition");
    if (def.kind !== "MAIN") throw new AgentValidationError([`${def.id}: expected kind MAIN`]);
    return new MainAgent(def, this.deps);
  }

  createSub(def: AgentDefinition): SubAgent {
    assertValid(validateDefinition(def), "invalid agent definition");
    if (def.kind !== "SUB") throw new AgentValidationError([`${def.id}: expected kind SUB`]);
    const handlers = Object.hasOwn(this.behaviors, def.id) ? this.behaviors[def.id] : undefined;
    return new SubAgent(def, this.deps, handlers);
  }

  create(def: AgentDefinition): ManagedAgent {
    return def.kind === "MAIN" ? this.createMain(def) : this.createSub(def);
  }

  /**
   * Creates and registers a whole organization. MAIN agents must precede their subs in `defs`.
   * All-or-nothing: on failure, agents registered so far are removed again.
   */
  createOrganization(defs: readonly AgentDefinition[] = CANONICAL_DEFINITIONS): ManagedAgent[] {
    this.checkBehaviors(defs);
    const created: ManagedAgent[] = [];
    try {
      for (const def of defs) {
        const agent = this.create(def);
        this.deps.registry.register(agent);
        created.push(agent);
      }
    } catch (e) {
      for (const a of [...created].reverse()) this.deps.registry.unregister(a.id);
      throw e;
    }
    return created;
  }

  private checkBehaviors(defs: readonly AgentDefinition[]): void {
    const kinds = new Map(defs.map((d) => [d.id, d.kind]));
    const problems: string[] = [];
    for (const id of Object.keys(this.behaviors)) {
      const kind = kinds.get(id);
      if (kind === undefined) problems.push(`behaviors reference unknown agent '${id}'`);
      else if (kind !== "SUB") problems.push(`behaviors are only allowed on SUB agents, not '${id}'`);
    }
    assertValid(problems, "invalid behavior table");
  }
}
