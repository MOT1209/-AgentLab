import type { ActionName, AgentDecision } from "./actions.js";
import { observationForPrompt, Observation } from "./observation.js";
import type { ExplorationTask } from "./task.js";
import type { ActionRecord } from "./result.js";
import type { Finding } from "./findings.js";

/** Provider-neutral: no model names, no API specifics. */
export const EXPLORATION_SYSTEM_PROMPT = `You are an autonomous mobile application exploration tester.
You control an Android device ONLY by choosing one action per turn from the list you are given.

Goals: explore the application systematically and find crashes, broken navigation, unresponsive controls and obvious UI problems.

How to work:
- Start from the application's launch and main screen, then main navigation, then primary features, important buttons, forms and input, back navigation, then edge cases and repeated interactions.
- Choose tap targets from the "ui" list of the current observation (use the x and y given). Do not guess coordinates when a UI list is available.
- Prefer actions that reach screens or states you have not seen. Do not repeat an action that already produced no change.
- After each action, read the next observation before deciding. A tap that changed nothing is evidence of an unresponsive control only if the observation shows no change.
- Never invent observations. Never claim an action succeeded unless the actionResult says so. If something is unknown, say so in your reason.
- Suggest a "finding" only when the observation supports it; describe exactly what you saw. Findings you suggest are marked as unverified. Crashes are detected by the system separately.
- Use END_TEST when exploration is complete, when you are stuck, or when the step budget is nearly spent.

Respond with ONE JSON object and nothing else. Fields:
  action (required), reason (required, one sentence), and the parameters of that action:
  TAP: target {x, y} | TYPE: text | SWIPE: from {x, y}, to {x, y}, durationMs | WAIT: ms
  LAUNCH_APP, STOP_APP, BACK, HOME, SCREENSHOT, GET_UI, GET_LOGS, END_TEST take no parameters.
  Optional: confidence (0..1), expectedOutcome, finding {severity: CRITICAL|HIGH|MEDIUM|LOW|INFO, title, description}.`;

export interface PromptState {
  task: ExplorationTask;
  observation: Observation;
  history: readonly ActionRecord[];
  findings: readonly Finding[];
  stepsUsed: number;
  msRemaining: number;
  available: readonly ActionName[];
  warning?: string;
}

const RECENT = 6;

/** Only what the next decision needs: objective, budget, current observation, recent actions. */
export function buildUserMessage(s: PromptState): string {
  return JSON.stringify(
    {
      objective: s.task.objective,
      ...(s.task.app ? { app: s.task.app } : {}),
      budget: { stepsUsed: s.stepsUsed, stepsRemaining: s.task.maxSteps - s.stepsUsed, secondsRemaining: Math.max(0, Math.round(s.msRemaining / 1000)) },
      availableActions: s.available,
      observation: observationForPrompt(s.observation),
      recentActions: s.history.slice(-RECENT).map((h) => ({ step: h.step, action: h.action, reason: h.reason, ok: h.ok, result: h.detail })),
      knownFindings: s.findings.map((f) => ({ id: f.id, severity: f.severity, title: f.title, verified: f.source === "VERIFIED" })),
      ...(s.warning ? { warning: s.warning } : {}),
    },
    null,
    1,
  );
}

export function correctionMessage(errors: readonly string[]): string {
  return `Your previous response was rejected: ${errors.join("; ")}. Respond again with ONE valid JSON object only, following the format.`;
}

export type { AgentDecision };
