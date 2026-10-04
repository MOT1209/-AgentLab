export type TaskStatus = "PENDING" | "RUNNING" | "PASSED" | "FAILED" | "BLOCKED" | "SKIPPED" | "ERROR";
export type Priority = "LOW" | "NORMAL" | "HIGH";

export interface Task<P = unknown, R = unknown> {
  task_id: string;
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
}

export interface AgentResult {
  status: TaskStatus;
  summary: string;
  evidence: Evidence[];
}
