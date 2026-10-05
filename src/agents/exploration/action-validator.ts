import type { Device } from "../../device/types.js";
import { ACTION_NAMES, ActionName, AgentAction, AgentDecision, Point, SEVERITIES, SuggestedFinding } from "./actions.js";

export const MAX_COORDINATE = 10_000;
export const MAX_TEXT_LENGTH = 200;
export const WAIT_MIN_MS = 100;
export const WAIT_MAX_MS = 10_000;
const SWIPE_MIN_MS = 50;
const SWIPE_MAX_MS = 3_000;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export interface ValidationLimits {
  /** Actions this device/task combination can actually perform. */
  supported: ReadonlySet<ActionName>;
  /** If known, coordinates must lie inside the screen. */
  screen?: { width: number; height: number };
}

export type ValidationResult = { ok: true; decision: AgentDecision } | { ok: false; errors: string[] };

/** Actions the given device can perform. LAUNCH/STOP need a package configured in the task. */
export function supportedActions(device: Device, hasPackage: boolean): Set<ActionName> {
  const s = new Set<ActionName>(["TAP", "TYPE", "SCREENSHOT", "WAIT", "GET_LOGS", "END_TEST"]);
  if (hasPackage) {
    s.add("LAUNCH_APP");
    s.add("STOP_APP");
  }
  if (typeof device.swipe === "function") s.add("SWIPE");
  if (typeof device.pressKey === "function") {
    s.add("BACK");
    s.add("HOME");
  }
  if (typeof device.ui === "function") s.add("GET_UI");
  return s;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function readPoint(v: unknown, name: string, limits: ValidationLimits, errors: string[]): Point | undefined {
  if (!isObj(v)) {
    errors.push(`${name} must be an object {x, y}`);
    return undefined;
  }
  const maxX = limits.screen ? limits.screen.width : MAX_COORDINATE;
  const maxY = limits.screen ? limits.screen.height : MAX_COORDINATE;
  let ok = true;
  for (const [axis, max] of [["x", maxX], ["y", maxY]] as const) {
    const n = v[axis];
    if (typeof n !== "number" || !Number.isFinite(n)) {
      errors.push(`${name}.${axis} must be a finite number`);
      ok = false;
    } else if (n < 0 || n > max) {
      errors.push(`${name}.${axis}=${n} is outside 0..${max}`);
      ok = false;
    }
  }
  return ok ? { x: Math.round(v.x as number), y: Math.round(v.y as number) } : undefined;
}

function readFinding(v: unknown, errors: string[]): SuggestedFinding | undefined {
  if (v === undefined || v === null) return undefined;
  if (!isObj(v)) {
    errors.push("finding must be an object");
    return undefined;
  }
  const { severity, title, description } = v;
  if (!SEVERITIES.includes(severity as never)) errors.push(`finding.severity must be one of ${SEVERITIES.join(", ")}`);
  if (typeof title !== "string" || title.trim() === "") errors.push("finding.title must be a non-empty string");
  if (typeof description !== "string" || description.trim() === "") errors.push("finding.description must be a non-empty string");
  if (errors.length > 0) return undefined;
  return { severity: severity as SuggestedFinding["severity"], title: (title as string).slice(0, 120), description: (description as string).slice(0, 1000) };
}

/**
 * The only way a model output becomes an executable action. Pure and total: never throws.
 * Unknown extra keys are ignored and never read.
 */
export function validateDecision(raw: unknown, limits: ValidationLimits): ValidationResult {
  if (!isObj(raw)) return { ok: false, errors: ["decision must be a JSON object"] };
  const errors: string[] = [];

  const name = raw.action;
  if (typeof name !== "string" || !ACTION_NAMES.includes(name as ActionName)) {
    return { ok: false, errors: [`unknown action '${String(name)}'; allowed: ${[...limits.supported].join(", ")}`] };
  }
  const actionName = name as ActionName;
  if (!limits.supported.has(actionName)) {
    return { ok: false, errors: [`action ${actionName} is not available here; allowed: ${[...limits.supported].join(", ")}`] };
  }

  let action: AgentAction | undefined;
  switch (actionName) {
    case "TAP": {
      const target = readPoint(raw.target, "target", limits, errors);
      if (target) action = { action: "TAP", target };
      break;
    }
    case "TYPE": {
      const t = raw.text;
      if (typeof t !== "string" || t.length === 0) errors.push("text must be a non-empty string");
      else if (t.length > MAX_TEXT_LENGTH) errors.push(`text is longer than ${MAX_TEXT_LENGTH} characters`);
      else if (CONTROL_CHARS.test(t)) errors.push("text must not contain control characters");
      else action = { action: "TYPE", text: t };
      break;
    }
    case "SWIPE": {
      const from = readPoint(raw.from, "from", limits, errors);
      const to = readPoint(raw.to, "to", limits, errors);
      const d = raw.durationMs === undefined ? 300 : raw.durationMs;
      if (typeof d !== "number" || !Number.isFinite(d) || d < SWIPE_MIN_MS || d > SWIPE_MAX_MS) {
        errors.push(`durationMs must be a number in ${SWIPE_MIN_MS}..${SWIPE_MAX_MS}`);
      } else if (from && to) action = { action: "SWIPE", from, to, durationMs: Math.round(d) };
      break;
    }
    case "WAIT": {
      const ms = raw.ms;
      if (typeof ms !== "number" || !Number.isFinite(ms) || ms < WAIT_MIN_MS || ms > WAIT_MAX_MS) {
        errors.push(`ms must be a number in ${WAIT_MIN_MS}..${WAIT_MAX_MS}`);
      } else action = { action: "WAIT", ms: Math.round(ms) };
      break;
    }
    case "LAUNCH_APP":
    case "STOP_APP":
    case "BACK":
    case "HOME":
    case "SCREENSHOT":
    case "GET_UI":
    case "GET_LOGS":
    case "END_TEST":
      action = { action: actionName };
      break;
  }

  const reason = typeof raw.reason === "string" ? raw.reason.trim() : "";
  if (reason === "") errors.push("reason must be a non-empty string");

  let confidence: number | undefined;
  if (raw.confidence !== undefined) {
    if (typeof raw.confidence !== "number" || !(raw.confidence >= 0 && raw.confidence <= 1)) errors.push("confidence must be a number in 0..1");
    else confidence = raw.confidence;
  }
  const expectedOutcome = typeof raw.expectedOutcome === "string" ? raw.expectedOutcome.slice(0, 300) : undefined;
  const findingErrors: string[] = [];
  const finding = readFinding(raw.finding, findingErrors);
  errors.push(...findingErrors);

  if (errors.length > 0 || !action) return { ok: false, errors: errors.length > 0 ? errors : ["invalid action"] };
  return {
    ok: true,
    decision: {
      action,
      reason: reason.slice(0, 500),
      ...(confidence !== undefined ? { confidence } : {}),
      ...(expectedOutcome ? { expectedOutcome } : {}),
      ...(finding ? { finding } : {}),
    },
  };
}

/** Parses model text into a JSON value. Accepts bare JSON or one fenced block; never evaluates anything. */
export function parseJsonObject(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  let t = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
  if (fenced) t = fenced[1] ?? "";
  try {
    return { ok: true, value: JSON.parse(t) };
  } catch {
    return { ok: false, error: "response is not valid JSON" };
  }
}
