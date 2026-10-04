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

export interface Evidence {
  kind: "screenshot" | "log";
  data: string; // base64 for binary, text for logs
  /** Id of the agent that produced it. */
  source?: string;
}

export interface ChildOutcome {
  agentId: string;
  taskId: string;
  status: TaskStatus;
  summary: string;
}

export interface AgentResult {
  status: TaskStatus;
  summary: string;
  evidence: Evidence[];
  /** Present on results produced by delegation. */
  children?: ChildOutcome[];
}
