import type { Capability } from "./capabilities.js";

export const AGENT_KINDS = ["MAIN", "SUB"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

/** Agent runtime status. Separate from TaskStatus. */
export const AGENT_STATUSES = [
  "IDLE",
  "THINKING",
  "PLANNING",
  "EXECUTING",
  "WAITING",
  "REVIEWING",
  "PAUSED",
  "ERROR",
  "OFFLINE",
] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

/** Statuses in which an agent is actively working a task. */
export const BUSY_STATUSES: ReadonlySet<AgentStatus> = new Set([
  "THINKING",
  "PLANNING",
  "EXECUTING",
  "WAITING",
  "REVIEWING",
]);

export type AgentMetadata = Readonly<Record<string, string | number | boolean>>;

/** Static, immutable description of an agent. Relationships are by id only. */
export interface AgentDefinition {
  readonly id: string;
  readonly kind: AgentKind;
  readonly name: string;
  readonly role: string;
  readonly description: string;
  readonly parentId?: string;
  readonly capabilities: readonly Capability[];
  readonly metadata: AgentMetadata;
}

export class AgentValidationError extends Error {
  constructor(readonly problems: readonly string[], context = "validation failed") {
    super(`${context}: ${problems.join("; ")}`);
    this.name = "AgentValidationError";
  }
}
