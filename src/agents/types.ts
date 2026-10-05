export type TaskStatus = "PENDING" | "RUNNING" | "PASSED" | "FAILED" | "BLOCKED" | "SKIPPED" | "ERROR";
export type Priority = "LOW" | "NORMAL" | "HIGH";

export interface Task<P = unknown, R = unknown> {
  task_id: string;
  /** Set when this task was created by delegation from another task. */
  parent_task_id?: string;
  agent_id: string;
  type: string;
  priority: Priority;
  status: TaskStatus;
  payload: P;
  result?: R;
  errors: string[];
  timestamps: { created: string; started?: string; finished?: string };
}

export type EvidenceKind = "screenshot" | "log" | "action_result" | "ui_state" | "error" | "performance";

export interface Evidence {
  /** Stable reference, e.g. EV-007. Optional for evidence from simple handlers. */
  id?: string;
  kind: EvidenceKind;
  /** Execution step that produced it (exploration agents). */
  step?: number;
  at?: string;
  data: string; // base64 for binary, text for logs
  /** Id of the agent that produced it. */
  source?: string;
}

export interface ChildOutcome {
  agentId: string;
  taskId: string;
  status: TaskStatus;
  summary: string;
  /** The child's AgentResult.details, passed up unchanged. */
  details?: unknown;
}

export interface AgentResult {
  status: TaskStatus;
  summary: string;
  evidence: Evidence[];
  /** Present on results produced by delegation. */
  children?: ChildOutcome[];
  /** Handler-specific structured result (e.g. an ExplorationResult). */
  details?: unknown;
}
