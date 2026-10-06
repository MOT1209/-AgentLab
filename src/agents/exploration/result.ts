import type { Evidence, TaskStatus } from "../types.js";
import type { Finding } from "./findings.js";

export type ExplorationStatus = "PASSED" | "FAILED" | "BLOCKED" | "CANCELLED" | "TIMEOUT" | "MAX_STEPS_REACHED" | "BUDGET_EXCEEDED" | "ERROR";

export interface ExplorationTelemetry {
  llmCalls: number;
  actions: number;
  actionFailures: number;
  providerErrors: number;
  deviceErrors: number;
  malformedResponses: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  /** Estimated from token usage and the caller's pricing; absent when no pricing was given. */
  costUsd?: number;
}

export interface ActionRecord {
  step: number;
  action: string;
  reason: string;
  ok: boolean;
  detail: string;
  errorCode?: string;
  evidenceIds: string[];
  /** The action as executed, so a run can be replayed and reported as reproduction steps. */
  params?: Record<string, unknown>;
}

export interface ExplorationResult {
  /** Where evidence files and result.json were written, if persistence was enabled. */
  evidenceDir?: string;
  status: ExplorationStatus;
  taskId: string;
  agentId: string;
  deviceId?: string;
  /** Actions executed (END_TEST is not counted). */
  steps: number;
  findings: Finding[];
  evidence: Evidence[];
  actionLog: ActionRecord[];
  telemetry: ExplorationTelemetry;
  startedAt: string;
  completedAt: string;
  /** Written by the runtime from facts. The model's own conclusion is quoted separately and labelled. */
  summary: string;
}

/** Maps to the platform-wide TaskStatus. A verified serious finding always wins: a bug was found. */
export function toTaskStatus(status: ExplorationStatus, verifiedFailure: boolean): TaskStatus {
  if (verifiedFailure) return "FAILED";
  switch (status) {
    case "PASSED":
    case "MAX_STEPS_REACHED":
      return "PASSED";
    case "FAILED":
      return "FAILED";
    case "BLOCKED":
    case "TIMEOUT":
    case "BUDGET_EXCEEDED":
      return "BLOCKED";
    case "CANCELLED":
      return "SKIPPED";
    case "ERROR":
      return "ERROR";
  }
}
