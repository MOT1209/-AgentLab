import { AgentFactory, BehaviorTable } from "./agents/factory.js";
import { DEFAULT_BEHAVIORS } from "./agents/behaviors/index.js";
import { AgentDefinition, AgentValidationError } from "./agents/definitions.js";
import { ManagedAgent } from "./agents/managed-agent.js";
import { MessageBus } from "./agents/messages.js";
import { CANONICAL_DEFINITIONS } from "./agents/organization.js";
import { AgentRegistry } from "./agents/registry.js";
import { assertValid, validateOrganization } from "./agents/validation.js";
import { Device } from "./device/types.js";
import { Orchestrator } from "./orchestrator.js";

export interface AgentLabOptions {
  device: Device;
  /** Merged over DEFAULT_BEHAVIORS. */
  behaviors?: BehaviorTable;
  /** Custom organization. Skips the 12/24 check, which applies to the default configuration only. */
  definitions?: readonly AgentDefinition[];
}

export interface AgentLabRuntime {
  registry: AgentRegistry;
  bus: MessageBus;
  factory: AgentFactory;
  orchestrator: Orchestrator;
  agents: ManagedAgent[];
}

/** Builds, validates and wires the complete agent organization. */
export function initializeAgentLab(opts: AgentLabOptions): AgentLabRuntime {
  const defs = opts.definitions ?? CANONICAL_DEFINITIONS;
  if (!opts.definitions) assertValid(validateOrganization(defs), "canonical organization invalid");

  const registry = new AgentRegistry();
  const bus = new MessageBus();
  const ids = new Set(defs.map((d) => d.id));
  const defaults = Object.fromEntries(Object.entries(DEFAULT_BEHAVIORS).filter(([id]) => ids.has(id)));
  const factory = new AgentFactory({ device: opts.device, registry, bus, behaviors: { ...defaults, ...opts.behaviors } });
  const agents = factory.createOrganization(defs);

  const problems = registry.validateRelationships();
  if (problems.length > 0) throw new AgentValidationError(problems, "registry relationships invalid");
  return { registry, bus, factory, orchestrator: new Orchestrator(registry, bus), agents };
}
