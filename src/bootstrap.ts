import { AgentFactory, BehaviorTable } from "./agents/factory.js";
import { DEFAULT_BEHAVIORS } from "./agents/behaviors/index.js";
import { AgentDefinition, AgentValidationError } from "./agents/definitions.js";
import { ManagedAgent } from "./agents/managed-agent.js";
import { MessageBus } from "./agents/messages.js";
import { CANONICAL_DEFINITIONS } from "./agents/organization.js";
import { AgentRegistry } from "./agents/registry.js";
import { assertValid, validateOrganization } from "./agents/validation.js";
import type { Device } from "./device/types.js";
import { Orchestrator } from "./orchestrator.js";
import { DeviceManager } from "./runtime/device-manager.js";
import type { RegisterOptions } from "./runtime/device-registry.js";
import type { AgentAssignment } from "./runtime/types.js";

/** A bare Device, or a Device with registration details. */
export type DeviceInput = Device | ({ device: Device } & RegisterOptions);

export interface AgentLabOptions {
  /** Devices to register. Provide this or `deviceManager`; there is deliberately no implicit mock fleet. */
  devices?: readonly DeviceInput[];
  /** A pre-built manager (may already hold devices). Devices in `devices` are added to it. */
  deviceManager?: DeviceManager;
  /**
   * "auto" (default): MAIN agents, in order, get unassigned devices, in order, until one runs out.
   * "none": no assignments. Record: explicit MAIN id -> device id.
   */
  assignments?: "auto" | "none" | Readonly<Record<string, string>>;
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
  devices: DeviceManager;
  agents: ManagedAgent[];
  /** Assign a device to a MAIN agent (sub-agents inherit it). */
  assignDevice(mainId: string, deviceId: string): AgentAssignment;
  reassignDevice(mainId: string, deviceId: string): AgentAssignment;
  unassignDevice(mainId: string): boolean;
}

function addDevices(manager: DeviceManager, inputs: readonly DeviceInput[]): void {
  for (const input of inputs) {
    if ("device" in input) {
      const { device, ...opts } = input;
      manager.addDevice(device, opts);
    } else {
      manager.addDevice(input);
    }
  }
}

/** Builds, validates and wires the agent organization and its device runtime. */
export function initializeAgentLab(opts: AgentLabOptions): AgentLabRuntime {
  if (!opts.devices && !opts.deviceManager) {
    throw new Error("initializeAgentLab: provide `devices` or `deviceManager`");
  }
  const defs = opts.definitions ?? CANONICAL_DEFINITIONS;
  if (!opts.definitions) assertValid(validateOrganization(defs), "canonical organization invalid");

  const devices = opts.deviceManager ?? new DeviceManager();
  addDevices(devices, opts.devices ?? []);

  const registry = new AgentRegistry();
  const bus = new MessageBus();
  const ids = new Set(defs.map((d) => d.id));
  const defaults = Object.fromEntries(Object.entries(DEFAULT_BEHAVIORS).filter(([id]) => ids.has(id)));
  const factory = new AgentFactory({ devices, registry, bus, behaviors: { ...defaults, ...opts.behaviors } });
  const agents = factory.createOrganization(defs);

  const problems = registry.validateRelationships();
  if (problems.length > 0) throw new AgentValidationError(problems, "registry relationships invalid");

  const requireMain = (id: string): void => {
    const a = registry.get(id);
    if (!a) throw new Error(`unknown agent: ${id}`);
    if (a.kind !== "MAIN") throw new Error(`${id} is a SUB agent; devices are assigned to its MAIN parent`);
  };
  const runtime: AgentLabRuntime = {
    registry,
    bus,
    factory,
    orchestrator: new Orchestrator(registry, bus),
    devices,
    agents,
    assignDevice(mainId, deviceId) {
      requireMain(mainId);
      return devices.assign(mainId, deviceId);
    },
    reassignDevice(mainId, deviceId) {
      requireMain(mainId);
      return devices.reassign(mainId, deviceId);
    },
    unassignDevice(mainId) {
      requireMain(mainId);
      return devices.unassign(mainId);
    },
  };

  const mode = opts.assignments ?? "auto";
  if (mode === "auto") {
    const free = devices.snapshot().filter((d) => d.assignedAgentId === undefined);
    registry.mains().forEach((m, i) => {
      const d = free[i];
      if (d && !devices.getAssignment(m.id)) runtime.assignDevice(m.id, d.id);
    });
  } else if (mode !== "none") {
    for (const [mainId, deviceId] of Object.entries(mode)) runtime.assignDevice(mainId, deviceId);
  }
  return runtime;
}
