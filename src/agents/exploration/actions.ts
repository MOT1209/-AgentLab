/**
 * The complete set of things the LLM may ask for. Anything else is rejected before it can run.
 * There is deliberately no shell, file, network or arbitrary-ADB action, and no way to name a package:
 * LAUNCH_APP / STOP_APP act on the app configured in the task, never on a model-chosen target.
 */
export const ACTION_NAMES = [
  "LAUNCH_APP",
  "STOP_APP",
  "TAP",
  "TYPE",
  "SWIPE",
  "BACK",
  "HOME",
  "SCREENSHOT",
  "WAIT",
  "GET_UI",
  "GET_LOGS",
  "END_TEST",
] as const;
export type ActionName = (typeof ACTION_NAMES)[number];

export interface Point {
  x: number;
  y: number;
}

export type AgentAction =
  | { action: "LAUNCH_APP" }
  | { action: "STOP_APP" }
  | { action: "TAP"; target: Point }
  | { action: "TYPE"; text: string }
  | { action: "SWIPE"; from: Point; to: Point; durationMs: number }
  | { action: "BACK" }
  | { action: "HOME" }
  | { action: "SCREENSHOT" }
  | { action: "WAIT"; ms: number }
  | { action: "GET_UI" }
  | { action: "GET_LOGS" }
  | { action: "END_TEST" };

export const SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** A problem the model claims to see. It is an AI observation, never verified system evidence. */
export interface SuggestedFinding {
  severity: Severity;
  title: string;
  description: string;
}

export interface AgentDecision {
  action: AgentAction;
  reason: string;
  confidence?: number;
  expectedOutcome?: string;
  finding?: SuggestedFinding;
}

const point = {
  type: "object",
  properties: { x: { type: "number" }, y: { type: "number" } },
  required: ["x", "y"],
  additionalProperties: false,
};

/** Hint for providers with structured output. The validator is the real gate. */
export const DECISION_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    action: { type: "string", enum: [...ACTION_NAMES] },
    reason: { type: "string" },
    target: point,
    from: point,
    to: point,
    durationMs: { type: "number" },
    text: { type: "string" },
    ms: { type: "number" },
    confidence: { type: "number" },
    expectedOutcome: { type: "string" },
    finding: {
      type: "object",
      properties: {
        severity: { type: "string", enum: [...SEVERITIES] },
        title: { type: "string" },
        description: { type: "string" },
      },
      required: ["severity", "title", "description"],
      additionalProperties: false,
    },
  },
  required: ["action", "reason"],
  additionalProperties: false,
};
