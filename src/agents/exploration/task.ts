import { parsePricing, type Pricing } from "../../providers/pricing.js";
import type { AppContext } from "./observation.js";

export const DEFAULT_MAX_STEPS = 20;
export const HARD_MAX_STEPS = 200;
export const DEFAULT_TIMEOUT_MS = 120_000;
export const HARD_MAX_LLM_CALLS = 1000;
export const HARD_MAX_TIMEOUT_MS = 1_800_000;

export interface ExplorationObjective {
  summary: string;
  /** Optional emphasis, e.g. "crashes", "navigation", "forms". */
  focus?: string[];
}

/** Structured input for the "explore" task type. */
export interface ExplorationTask {
  objective: ExplorationObjective;
  app?: AppContext;
  maxSteps: number;
  /** Hard cap on LLM requests (including correction attempts). Default: maxSteps + 5. */
  maxLlmCalls: number;
  timeoutMs: number;
  /** If set, evidence files and result.json are written under <evidenceDir>/<taskId>/. Set by the caller, never by the model. */
  evidenceDir?: string;
  screen?: { width: number; height: number };
  captureScreenshots: boolean;
  /** Stop with BUDGET_EXCEEDED once the estimated cost reaches this many USD. Needs `pricing`. One call can overshoot it. */
  maxCostUsd?: number;
  /** USD per million tokens, stated by the caller (there is no built-in price table). */
  pricing?: Pricing;
  /** Send the latest screenshot to the model each step. Off by default: costs more and the pixels cannot be redacted. */
  vision?: boolean;
  /** After the run, replay the steps that led to each verified crash to see whether it happens again. */
  confirmCrashes?: boolean;
  /**
   * Allow taps whose target element reads as a destructive or paid control (buy, subscribe,
   * delete account, factory reset, uninstall). Off by default: the exploration agent refuses
   * those taps so it cannot spend money or wipe app data just because a screen offered the button.
   */
  allowSensitiveActions?: boolean;
}

const PKG = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function parseExplorationTask(payload: unknown): { ok: true; task: ExplorationTask } | { ok: false; errors: string[] } {
  if (!isObj(payload)) return { ok: false, errors: ["payload must be an object"] };
  const errors: string[] = [];

  let objective: ExplorationObjective | undefined;
  const o = payload.objective;
  if (typeof o === "string" && o.trim()) objective = { summary: o.trim().slice(0, 1000) };
  else if (isObj(o) && typeof o.summary === "string" && o.summary.trim()) {
    const focus = Array.isArray(o.focus) ? o.focus.filter((f): f is string => typeof f === "string").slice(0, 10).map((f) => f.slice(0, 40)) : undefined;
    objective = { summary: o.summary.trim().slice(0, 1000), ...(focus ? { focus } : {}) };
  } else errors.push("objective must be a non-empty string or {summary, focus?}");

  let app: AppContext | undefined;
  if (payload.app !== undefined) {
    if (!isObj(payload.app)) errors.push("app must be an object");
    else {
      const a = payload.app;
      app = {};
      if (a.packageName !== undefined) {
        if (typeof a.packageName === "string" && PKG.test(a.packageName)) app.packageName = a.packageName;
        else errors.push("app.packageName is not a valid package name");
      }
      for (const k of ["name", "launchActivity", "version"] as const) if (typeof a[k] === "string") app[k] = (a[k] as string).slice(0, 100);
    }
  }

  const int = (v: unknown, name: string, def: number, min: number, max: number): number => {
    if (v === undefined) return def;
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
      errors.push(`${name} must be an integer in ${min}..${max}`);
      return def;
    }
    return v;
  };
  const maxSteps = int(payload.maxSteps, "maxSteps", DEFAULT_MAX_STEPS, 1, HARD_MAX_STEPS);
  const timeoutMs = int(payload.timeoutMs, "timeoutMs", DEFAULT_TIMEOUT_MS, 1, HARD_MAX_TIMEOUT_MS);
  const maxLlmCalls = int(payload.maxLlmCalls, "maxLlmCalls", maxSteps + 5, 1, HARD_MAX_LLM_CALLS);
  let evidenceDir: string | undefined;
  if (payload.evidenceDir !== undefined) {
    const d = payload.evidenceDir;
    if (typeof d === "string" && d.length > 0 && d.length < 500 && !d.includes("\0") && (d.startsWith("/") || /^[A-Za-z]:[\\/]/.test(d))) evidenceDir = d;
    else errors.push("evidenceDir must be an absolute path");
  }

  let screen: ExplorationTask["screen"];
  if (payload.screen !== undefined) {
    const s = payload.screen;
    if (isObj(s) && Number.isInteger(s.width) && Number.isInteger(s.height) && (s.width as number) > 0 && (s.height as number) > 0) {
      screen = { width: s.width as number, height: s.height as number };
    } else errors.push("screen must be {width, height} positive integers");
  }
  let maxCostUsd: number | undefined;
  if (payload.maxCostUsd !== undefined) {
    const c = payload.maxCostUsd;
    if (typeof c === "number" && Number.isFinite(c) && c > 0 && c <= 1000) maxCostUsd = c;
    else errors.push("maxCostUsd must be a number in (0, 1000]");
  }
  let pricing: Pricing | undefined;
  if (payload.pricing !== undefined) {
    pricing = parsePricing(payload.pricing);
    if (!pricing) errors.push("pricing must be {inputPerMTok, outputPerMTok} (USD per million tokens, 0..100000)");
  }
  if (maxCostUsd !== undefined && payload.pricing === undefined) errors.push("maxCostUsd needs pricing: there is no built-in price table");
  for (const k of ["vision", "confirmCrashes", "allowSensitiveActions"] as const) if (payload[k] !== undefined && typeof payload[k] !== "boolean") errors.push(`${k} must be a boolean`);
  if (payload.captureScreenshots !== undefined && typeof payload.captureScreenshots !== "boolean") errors.push("captureScreenshots must be a boolean");

  if (errors.length > 0 || !objective) return { ok: false, errors };
  return {
    ok: true,
    task: { objective, ...(app ? { app } : {}), maxSteps, maxLlmCalls, timeoutMs, ...(evidenceDir ? { evidenceDir } : {}), ...(screen ? { screen } : {}), captureScreenshots: payload.captureScreenshots !== false, ...(maxCostUsd !== undefined ? { maxCostUsd } : {}), ...(pricing ? { pricing } : {}), ...(payload.vision === true ? { vision: true } : {}), ...(payload.confirmCrashes === true ? { confirmCrashes: true } : {}), ...(payload.allowSensitiveActions === true ? { allowSensitiveActions: true } : {}) },
  };
}
