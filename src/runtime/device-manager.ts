import { randomUUID } from "node:crypto";
import type { Device } from "../device/types.js";
import { AdbDevice, adbSourceOf } from "../device/adb-device.js";
import { DeviceError } from "../device/types.js";
import { DeviceDiscovery, DiscoveredDevice } from "./discovery.js";
import { DeviceHealth, deepHealthCheck, normalizeAdbState } from "./health.js";
import { DevicePool, PoolOptions } from "./device-pool.js";
import { DeviceRecord, DeviceRegistry, RegisterOptions } from "./device-registry.js";
import {
  AgentAssignment,
  DeviceRuntimeError,
  DeviceSnapshot,
  Failure,
  HealthReport,
  Lease,
  LeaseOwner,
  LeaseResult,
  LockOptions,
  ReleaseResult,
  RuntimeContext,
} from "./types.js";
import type { DeviceSource } from "../device/types.js";

export interface AvailabilityFilter {
  source?: DeviceSource;
  /** Include devices that already have an agent assignment. Default false. */
  includeAssigned?: boolean;
  predicate?: (rec: Readonly<DeviceRecord>) => boolean;
}

export interface RejectedDevice {
  serial: string;
  state: string;
  reason: string;
  health?: DeviceHealth;
}

export interface DiscoveryResult {
  added: DeviceSnapshot[];
  /** Already registered. */
  skipped: DiscoveredDevice[];
  /** Seen by discovery but not usable (unauthorized, offline, failed health check). Never registered. */
  rejected: RejectedDevice[];
}

/**
 * Owns allocation. The rest of the platform asks the manager for devices, assignments and leases
 * and never touches lock state directly.
 */
export class DeviceManager {
  readonly registry = new DeviceRegistry();
  readonly pool: DevicePool;
  private readonly assignments = new Map<string, AgentAssignment>();

  constructor(opts: PoolOptions = {}) {
    this.pool = new DevicePool(this.registry, opts);
  }

  // ---- devices -----------------------------------------------------------------------------

  addDevice(device: Device, opts: RegisterOptions = {}): DeviceSnapshot {
    return this.snapshotOf(this.registry.register(device, opts));
  }

  /** Removing an assigned or leased device requires `force`, which also drops the assignment and lease. */
  removeDevice(id: string, opts: { force?: boolean } = {}): boolean {
    const rec = this.registry.get(id);
    if (!rec) return false;
    if (opts.force) {
      this.pool.forceRelease(id);
      if (rec.assignedAgentId !== undefined) this.dropAssignment(rec.assignedAgentId);
    }
    return this.registry.unregister(id);
  }

  getDevice(id: string): Device | undefined {
    return this.registry.get(id)?.device;
  }

  /** Registers devices reported by a discovery source that are ready and not yet known. */
  async discover(
    discovery: DeviceDiscovery,
    create: (d: DiscoveredDevice) => Device = (d) => new AdbDevice(d.serial),
  ): Promise<DiscoveryResult> {
    const added: DeviceSnapshot[] = [];
    const skipped: DiscoveredDevice[] = [];
    const rejected: RejectedDevice[] = [];
    for (const d of await discovery.discover()) {
      if (this.registry.has(d.serial)) {
        skipped.push(d);
        continue;
      }
      // discovery -> health check -> registry. Unhealthy devices never enter the registry.
      const device = create(d);
      const health = await deepHealthCheck(device, d.state);
      if (!health.healthy) {
        rejected.push({ serial: d.serial, state: normalizeAdbState(d.state), reason: health.errors[0] ?? "health check failed", health });
        continue;
      }
      const opts: RegisterOptions = { source: adbSourceOf(d.serial), serial: d.serial };
      const model = health.model ?? d.model;
      if (model) opts.model = model;
      if (health.androidVersion) opts.androidVersion = health.androidVersion;
      added.push(this.addDevice(device, opts));
    }
    return { added, skipped, rejected };
  }

  findAvailable(filter: AvailabilityFilter = {}): DeviceSnapshot | undefined {
    const rec = this.pool
      .free()
      .filter((r) => filter.includeAssigned || r.assignedAgentId === undefined)
      .filter((r) => filter.source === undefined || r.source === filter.source)
      .find((r) => (filter.predicate ? filter.predicate(r) : true));
    return rec ? this.snapshotOf(rec) : undefined;
  }

  // ---- health ------------------------------------------------------------------------------

  /** Probes the device (info call), refreshes model/version, and reports readiness. */
  async checkHealth(deviceId: string): Promise<HealthReport> {
    const checkedAt = new Date().toISOString();
    const rec = this.registry.get(deviceId);
    if (!rec) return { deviceId, ready: false, state: "UNKNOWN", error: `unknown device: ${deviceId}`, checkedAt };
    try {
      const info = await rec.device.info();
      this.registry.updateInfo(deviceId, { model: info.model, androidVersion: info.androidVersion });
      const state = rec.device.state();
      return { deviceId, ready: state === "ONLINE", state, checkedAt };
    } catch (e) {
      const error = e instanceof DeviceError ? e.message : e instanceof Error ? e.message : String(e);
      return { deviceId, ready: false, state: rec.device.state(), error, checkedAt };
    }
  }

  /** Full probe (command, screenshot, logs). Slower than checkHealth(); use when registering or diagnosing. */
  async deepHealth(deviceId: string): Promise<DeviceHealth | undefined> {
    const rec = this.registry.get(deviceId);
    if (!rec) return undefined;
    const h = await deepHealthCheck(rec.device);
    if (h.healthy) this.registry.updateInfo(deviceId, { ...(h.model ? { model: h.model } : {}), ...(h.androidVersion ? { androidVersion: h.androidVersion } : {}) });
    return h;
  }

  // ---- locking -----------------------------------------------------------------------------

  lock(deviceId: string, owner: LeaseOwner, opts: LockOptions = {}): LeaseResult {
    return this.pool.lease(deviceId, owner, opts);
  }
  lockAny(owner: LeaseOwner, filter?: (rec: Readonly<DeviceRecord>) => boolean, opts: LockOptions = {}): LeaseResult {
    return this.pool.leaseAny(owner, filter, opts);
  }
  unlock(leaseId: string, ownerId: string): ReleaseResult {
    return this.pool.release(leaseId, ownerId);
  }
  activeLease(deviceId: string): Lease | undefined {
    return this.pool.activeLease(deviceId);
  }

  /**
   * Leases the device, marks it BUSY, runs `fn`, and always releases, even if `fn` throws.
   * Returns a controlled failure instead of throwing when the device cannot be acquired.
   */
  async withLease<T>(
    owner: LeaseOwner,
    deviceId: string,
    fn: (ctx: { device: Device; lease: Lease }) => Promise<T>,
    opts: LockOptions = {},
  ): Promise<{ ok: true; value: T } | Failure> {
    const leased = this.pool.lease(deviceId, owner, opts);
    if (!leased.ok) return leased;
    const { lease } = leased;
    if (!this.pool.markBusy(lease.leaseId, owner.id)) {
      this.pool.release(lease.leaseId, owner.id);
      return { ok: false, reason: "LEASE_LOST", message: `lease on ${deviceId} expired before use` };
    }
    try {
      return { ok: true, value: await fn({ device: this.registry.get(deviceId)!.device, lease }) };
    } finally {
      this.pool.release(lease.leaseId, owner.id);
    }
  }

  // ---- assignments -------------------------------------------------------------------------

  assign(agentId: string, deviceId: string): AgentAssignment {
    if (!this.registry.has(deviceId)) throw new DeviceRuntimeError(`unknown device: ${deviceId}`);
    const existing = this.assignments.get(agentId);
    if (existing) throw new DeviceRuntimeError(`${agentId} is already assigned to ${existing.deviceId}; use reassign`);
    const holder = this.registry.get(deviceId)!.assignedAgentId;
    if (holder !== undefined) throw new DeviceRuntimeError(`${deviceId} is already assigned to ${holder}`);

    const a: AgentAssignment = { assignmentId: randomUUID(), agentId, deviceId, createdAt: new Date().toISOString() };
    this.assignments.set(agentId, a);
    this.registry.setAssignedAgent(deviceId, agentId);
    return a;
  }

  /** Refuses while the agent holds a lease on its current device. */
  unassign(agentId: string): boolean {
    const a = this.assignments.get(agentId);
    if (!a) return false;
    if (this.pool.isOwner(a.deviceId, agentId)) throw new DeviceRuntimeError(`${agentId} is using ${a.deviceId}; cannot unassign`);
    this.dropAssignment(agentId);
    return true;
  }

  reassign(agentId: string, deviceId: string): AgentAssignment {
    const old = this.assignments.get(agentId);
    if (old?.deviceId === deviceId) return old;
    this.unassign(agentId);
    try {
      return this.assign(agentId, deviceId);
    } catch (e) {
      if (old) this.assign(agentId, old.deviceId); // roll back
      throw e;
    }
  }

  private dropAssignment(agentId: string): void {
    const a = this.assignments.get(agentId);
    if (!a) return;
    this.assignments.delete(agentId);
    if (this.registry.has(a.deviceId)) this.registry.setAssignedAgent(a.deviceId, undefined);
  }

  getAssignment(agentId: string): AgentAssignment | undefined {
    return this.assignments.get(agentId);
  }
  listAssignments(): AgentAssignment[] {
    return [...this.assignments.values()];
  }
  deviceFor(agentId: string): Device | undefined {
    const a = this.assignments.get(agentId);
    return a ? this.getDevice(a.deviceId) : undefined;
  }

  /**
   * Runtime context for `agentId` running under `mainAgentId`'s assignment.
   * Defined only while that MAIN agent holds an active lease on its device.
   */
  contextFor(mainAgentId: string, agentId: string): RuntimeContext | undefined {
    const a = this.assignments.get(mainAgentId);
    if (!a) return undefined;
    const lease = this.pool.activeLease(a.deviceId);
    if (!lease || lease.ownerId !== mainAgentId) return undefined;
    const rec = this.registry.get(a.deviceId)!;
    const ctx: { -readonly [K in keyof RuntimeContext]: RuntimeContext[K] } = {
      agentId,
      mainAgentId,
      deviceId: a.deviceId,
      assignmentId: a.assignmentId,
      leaseId: lease.leaseId,
      capabilities: rec.capabilities,
      startedAt: lease.createdAt,
    };
    if (lease.sessionId !== undefined) ctx.sessionId = lease.sessionId;
    return ctx;
  }

  // ---- inspection --------------------------------------------------------------------------

  describe(deviceId: string): DeviceSnapshot | undefined {
    this.pool.activeLease(deviceId); // sweeps an expired lease first
    const rec = this.registry.get(deviceId);
    return rec ? this.snapshotOf(rec) : undefined;
  }

  snapshot(): DeviceSnapshot[] {
    this.pool.free(); // sweeps expired leases
    return this.registry.list().map((r) => this.snapshotOf(r));
  }

  private snapshotOf(rec: Readonly<DeviceRecord>): DeviceSnapshot {
    const snap: { -readonly [K in keyof DeviceSnapshot]: DeviceSnapshot[K] } = {
      id: rec.id,
      source: rec.source,
      state: rec.device.state(),
      lock: rec.lock,
      capabilities: rec.capabilities,
      metadata: { ...rec.metadata },
      registeredAt: rec.registeredAt,
      updatedAt: rec.updatedAt,
    };
    if (rec.serial !== undefined) snap.serial = rec.serial;
    if (rec.model !== undefined) snap.model = rec.model;
    if (rec.androidVersion !== undefined) snap.androidVersion = rec.androidVersion;
    if (rec.assignedAgentId !== undefined) snap.assignedAgentId = rec.assignedAgentId;
    if (rec.lease) {
      snap.leaseOwner = { id: rec.lease.ownerId, type: rec.lease.ownerType };
      snap.leaseId = rec.lease.leaseId;
    }
    return snap;
  }
}
