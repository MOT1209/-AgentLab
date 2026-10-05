import type { Capability } from "../agents/capabilities.js";
import type { DeviceSource, DeviceState } from "../device/types.js";

export type { DeviceSource } from "../device/types.js";

/** Lock state of a device. Independent of its hardware state (DeviceState). */
export type LockState = "FREE" | "LEASED" | "BUSY";

export type OwnerType = "AGENT" | "TEST_SESSION" | "SYSTEM";
export interface LeaseOwner {
  readonly id: string;
  readonly type: OwnerType;
}

export type LeaseStatus = "ACTIVE" | "RELEASED" | "EXPIRED";

export interface Lease {
  readonly leaseId: string;
  readonly deviceId: string;
  readonly ownerId: string;
  readonly ownerType: OwnerType;
  readonly sessionId?: string;
  readonly createdAt: string;
  readonly expiresAt?: string;
  readonly status: LeaseStatus;
  readonly releasedAt?: string;
}

export interface LockOptions {
  /** Optional time-to-live. Applies only while the lease is LEASED, never while a task is BUSY. */
  ttlMs?: number;
  sessionId?: string;
}

export type LeaseFailureReason = "UNKNOWN_DEVICE" | "ALREADY_LEASED" | "NO_AVAILABLE_DEVICE" | "LEASE_LOST";
export interface Failure {
  readonly ok: false;
  readonly reason: LeaseFailureReason;
  readonly message: string;
  readonly heldBy?: LeaseOwner;
}
export type LeaseResult = { readonly ok: true; readonly lease: Lease } | Failure;

export type ReleaseResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "UNKNOWN_LEASE" | "NOT_OWNER" | "NOT_ACTIVE" };

/** Explicit agent -> device binding. Runtime data, never part of an AgentDefinition. */
export interface AgentAssignment {
  readonly assignmentId: string;
  readonly agentId: string;
  readonly deviceId: string;
  readonly createdAt: string;
}

/** What an executing agent may know about its runtime environment. */
export interface RuntimeContext {
  readonly agentId: string;
  readonly mainAgentId: string;
  readonly deviceId: string;
  readonly assignmentId: string;
  readonly leaseId: string;
  readonly sessionId?: string;
  readonly capabilities: readonly Capability[];
  readonly startedAt: string;
}

export interface HealthReport {
  readonly deviceId: string;
  readonly ready: boolean;
  readonly state: DeviceState | "UNKNOWN";
  readonly error?: string;
  readonly checkedAt: string;
}

export type DeviceMetadata = Record<string, string | number | boolean>;

/** Read-only view for reporting. */
export interface DeviceSnapshot {
  readonly id: string;
  readonly source: DeviceSource;
  readonly serial?: string;
  readonly state: DeviceState;
  readonly lock: LockState;
  readonly model?: string;
  readonly androidVersion?: string;
  readonly capabilities: readonly Capability[];
  readonly assignedAgentId?: string;
  readonly leaseOwner?: LeaseOwner;
  readonly leaseId?: string;
  readonly metadata: Readonly<DeviceMetadata>;
  readonly registeredAt: string;
  readonly updatedAt: string;
}

export class DeviceRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeviceRuntimeError";
  }
}
