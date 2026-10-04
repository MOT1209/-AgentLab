import { isCapability, IMPLEMENTED_DEVICE_CAPABILITIES, type Capability } from "../agents/capabilities.js";
import { DEVICE_SOURCES, type Device, type DeviceSource, type DeviceState } from "../device/types.js";
import { DeviceMetadata, DeviceRuntimeError, Lease } from "./types.js";
import type { LockState } from "./types.js";

/** Mutable record. Only DevicePool and DeviceManager may change `lock`, `lease` and `assignedAgentId`. */
export interface DeviceRecord {
  readonly id: string;
  readonly device: Device;
  readonly source: DeviceSource;
  readonly serial?: string;
  readonly capabilities: readonly Capability[];
  readonly registeredAt: string;
  model?: string;
  androidVersion?: string;
  metadata: DeviceMetadata;
  updatedAt: string;
  lock: LockState;
  lease?: Lease;
  assignedAgentId?: string;
}

export interface RegisterOptions {
  source?: DeviceSource;
  serial?: string;
  capabilities?: readonly Capability[];
  metadata?: DeviceMetadata;
  model?: string;
  androidVersion?: string;
}

/** Central catalogue of devices. Knows nothing about agents beyond the assignment marker. */
export class DeviceRegistry {
  private readonly records = new Map<string, DeviceRecord>();

  get size(): number {
    return this.records.size;
  }

  register(device: Device, opts: RegisterOptions = {}): DeviceRecord {
    const id = device.id;
    if (typeof id !== "string" || id.trim() === "") throw new DeviceRuntimeError("device id must be a non-empty string");
    if (this.records.has(id)) throw new DeviceRuntimeError(`duplicate device id: ${id}`);
    const source = opts.source ?? device.source;
    if (!source || !DEVICE_SOURCES.includes(source)) {
      throw new DeviceRuntimeError(`${id}: device source must be one of ${DEVICE_SOURCES.join(", ")}`);
    }
    const capabilities = opts.capabilities ?? IMPLEMENTED_DEVICE_CAPABILITIES;
    const bad = capabilities.find((c) => !isCapability(c));
    if (bad !== undefined) throw new DeviceRuntimeError(`${id}: unknown capability '${String(bad)}'`);

    const now = new Date().toISOString();
    const rec: DeviceRecord = {
      id,
      device,
      source,
      capabilities: Object.freeze([...capabilities]),
      registeredAt: now,
      metadata: { ...opts.metadata },
      updatedAt: now,
      lock: "FREE",
    };
    if (opts.serial !== undefined) (rec as { serial?: string }).serial = opts.serial;
    if (opts.model !== undefined) rec.model = opts.model;
    if (opts.androidVersion !== undefined) rec.androidVersion = opts.androidVersion;
    this.records.set(id, rec);
    return rec;
  }

  /** Refuses while the device is leased; the manager handles forced removal. */
  unregister(id: string): boolean {
    const rec = this.records.get(id);
    if (!rec) return false;
    if (rec.lock !== "FREE") throw new DeviceRuntimeError(`${id} is ${rec.lock}; release it before unregistering`);
    if (rec.assignedAgentId !== undefined) throw new DeviceRuntimeError(`${id} is assigned to ${rec.assignedAgentId}; unassign it first`);
    return this.records.delete(id);
  }

  has(id: string): boolean {
    return this.records.has(id);
  }
  get(id: string): Readonly<DeviceRecord> | undefined {
    return this.records.get(id);
  }
  /** For DevicePool/DeviceManager only. */
  internal(id: string): DeviceRecord | undefined {
    return this.records.get(id);
  }

  list(): Readonly<DeviceRecord>[] {
    return [...this.records.values()];
  }
  /** Hardware ONLINE and lock FREE. Expired leases are swept by DevicePool before this is meaningful. */
  available(): Readonly<DeviceRecord>[] {
    return this.list().filter((r) => r.lock === "FREE" && r.device.state() === "ONLINE");
  }
  busy(): Readonly<DeviceRecord>[] {
    return this.list().filter((r) => r.lock !== "FREE");
  }
  /** Hardware not usable: anything but ONLINE/BUSY. */
  offline(): Readonly<DeviceRecord>[] {
    return this.list().filter((r) => {
      const s = r.device.state();
      return s !== "ONLINE" && s !== "BUSY";
    });
  }

  state(id: string): DeviceState | undefined {
    return this.records.get(id)?.device.state();
  }

  updateMetadata(id: string, patch: DeviceMetadata): void {
    const rec = this.records.get(id);
    if (!rec) throw new DeviceRuntimeError(`unknown device: ${id}`);
    rec.metadata = { ...rec.metadata, ...patch };
    rec.updatedAt = new Date().toISOString();
  }

  updateInfo(id: string, info: { model?: string; androidVersion?: string }): void {
    const rec = this.records.get(id);
    if (!rec) return;
    if (info.model !== undefined) rec.model = info.model;
    if (info.androidVersion !== undefined) rec.androidVersion = info.androidVersion;
    rec.updatedAt = new Date().toISOString();
  }

  /** Marker only; the authoritative assignment table lives in DeviceManager. */
  setAssignedAgent(id: string, agentId: string | undefined): void {
    const rec = this.records.get(id);
    if (!rec) throw new DeviceRuntimeError(`unknown device: ${id}`);
    if (agentId === undefined) delete rec.assignedAgentId;
    else rec.assignedAgentId = agentId;
    rec.updatedAt = new Date().toISOString();
  }
}
