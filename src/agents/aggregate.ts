import type { TaskStatus } from "./types.js";

/**
 * Combines child task statuses into the parent's status.
 * Precedence: FAILED > ERROR > BLOCKED > (PASSED | SKIPPED). Non-terminal statuses count as ERROR.
 */
export function aggregateStatus(statuses: readonly TaskStatus[]): TaskStatus {
  if (statuses.length === 0) return "BLOCKED";
  if (statuses.includes("FAILED")) return "FAILED";
  if (statuses.some((s) => s === "ERROR" || s === "PENDING" || s === "RUNNING")) return "ERROR";
  if (statuses.includes("BLOCKED")) return "BLOCKED";
  if (statuses.every((s) => s === "SKIPPED")) return "SKIPPED";
  return "PASSED";
}
