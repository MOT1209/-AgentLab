import { randomUUID } from "node:crypto";
import { DeviceRecord, DeviceRegistry } from "./device-registry.js";
import type { LeaseOwner, LeaseResult, LockOptions, ReleaseResult } from "./types.js";
import type { Lease } from "./types.js";

type MutableLease = { -readonly [K in keyof Lease]: Lease[K] };

export interface PoolOptions {
  now?: () => number;
  defaultTtlMs?: number;
}

const HISTORY_LIMIT = 1000;

/**
 * Exclusive leasing. All lease transitions are synchronous (no await between check and set),
 * so concurrent async callers can never both win the same device.
 * FREE -> LEASED -> BUSY -> (lease RELEASED) -> FREE
 */
export class DevicePool {
  private readonly history: Lease[] = [];
  private readonly now: () => number;

  constructor(
    private readonly registry: DeviceRegistry,
    private readonly opts: PoolOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
  }

  /** Lazily expires a LEASED (not BUSY) lease whose TTL has passed. */
  private sweep(rec: DeviceRecord): void {
    const lease = rec.lease as MutableLease | undefined;
    if (rec.lock !== "LEASED" || !lease?.expiresAt) return;
    if (Date.parse(lease.expiresAt) > this.now()) return;
    lease.status = "EXPIRED";
    lease.releasedAt = new Date(this.now()).toISOString();
    this.retire(lease);
    delete rec.lease;
    rec.lock = "FREE";
  }

  private retire(lease: Lease): void {
    this.history.push({ ...lease });
    if (this.history.length > HISTORY_LIMIT) this.history.shift();
  }

  private sweepAll(): void {
    for (const rec of this.registry.list()) this.sweep(this.registry.internal(rec.id)!);
  }

  /** Devices that are hardware ONLINE and not leased. */
  free(): Readonly<DeviceRecord>[] {
    this.sweepAll();
    return this.registry.available();
  }

  lease(deviceId: string, owner: LeaseOwner, opts: LockOptions = {}): LeaseResult {
    const rec = this.registry.internal(deviceId);
    if (!rec) return { ok: false, reason: "UNKNOWN_DEVICE", message: `unknown device: ${deviceId}` };
    this.sweep(rec);
    if (rec.lock === "FREE") return this.create(rec, owner, opts);
    const heldBy: LeaseOwner = { id: rec.lease!.ownerId, type: rec.lease!.ownerType };
    return {
      ok: false,
      reason: "ALREADY_LEASED",
      message: `${deviceId} is ${rec.lock} (held by ${heldBy.type}:${heldBy.id})`,
      heldBy,
    };
  }

  private create(rec: DeviceRecord, owner: LeaseOwner, opts: LockOptions): LeaseResult {
    const nowMs = this.now();
    const ttl = opts.ttlMs ?? this.opts.defaultTtlMs;
    const lease: MutableLease = {
      leaseId: randomUUID(),
      deviceId: rec.id,
      ownerId: owner.id,
      ownerType: owner.type,
      createdAt: new Date(nowMs).toISOString(),
      status: "ACTIVE",
    };
    if (opts.sessionId !== undefined) lease.sessionId = opts.sessionId;
    if (ttl !== undefined) lease.expiresAt = new Date(nowMs + ttl).toISOString();
    rec.lease = lease;
    rec.lock = "LEASED";
    rec.updatedAt = lease.createdAt;
    return { ok: true, lease: { ...lease } };
  }

  /** Leases the first free device accepted by `filter`. */
  leaseAny(owner: LeaseOwner, filter: (rec: Readonly<DeviceRecord>) => boolean = () => true, opts: LockOptions = {}): LeaseResult {
    const pick = this.free().find(filter);
    if (!pick) return { ok: false, reason: "NO_AVAILABLE_DEVICE", message: "no free device matches" };
    return this.lease(pick.id, owner, opts);
  }

  /** LEASED -> BUSY. False if the lease is no longer active or not owned by `ownerId`. */
  markBusy(leaseId: string, ownerId: string): boolean {
    const rec = this.findActive(leaseId);
    if (!rec || rec.lease!.ownerId !== ownerId) return false;
    this.sweep(rec);
    if (rec.lease?.leaseId !== leaseId) return false;
    rec.lock = "BUSY";
    rec.updatedAt = new Date(this.now()).toISOString();
    return true;
  }

  release(leaseId: string, ownerId: string): ReleaseResult {
    const rec = this.findActive(leaseId);
    if (!rec) {
      const past = this.history.find((l) => l.leaseId === leaseId);
      return { ok: false, reason: past ? "NOT_ACTIVE" : "UNKNOWN_LEASE" };
    }
    const lease = rec.lease as MutableLease;
    if (lease.ownerId !== ownerId) return { ok: false, reason: "NOT_OWNER" };
    this.finish(rec, "RELEASED");
    return { ok: true };
  }

  /** Administrative override (device removal, recovery). */
  forceRelease(deviceId: string): boolean {
    const rec = this.registry.internal(deviceId);
    if (!rec?.lease) return false;
    this.finish(rec, "RELEASED");
    return true;
  }

  private finish(rec: DeviceRecord, status: "RELEASED" | "EXPIRED"): void {
    const lease = rec.lease as MutableLease;
    lease.status = status;
    lease.releasedAt = new Date(this.now()).toISOString();
    this.retire(lease);
    delete rec.lease;
    rec.lock = "FREE";
    rec.updatedAt = lease.releasedAt;
  }

  private findActive(leaseId: string): DeviceRecord | undefined {
    for (const r of this.registry.list()) {
      const rec = this.registry.internal(r.id)!;
      if (rec.lease?.leaseId === leaseId) return rec;
    }
    return undefined;
  }

  activeLease(deviceId: string): Lease | undefined {
    const rec = this.registry.internal(deviceId);
    if (!rec) return undefined;
    this.sweep(rec);
    return rec.lease ? { ...rec.lease } : undefined;
  }

  isOwner(deviceId: string, ownerId: string): boolean {
    return this.activeLease(deviceId)?.ownerId === ownerId;
  }

  /** Most recent finished leases, newest last. Bounded. */
  recentLeases(): readonly Lease[] {
    return [...this.history];
  }
}
