import type { AppContext } from "./observation.js";

export const DEFAULT_MAX_STEPS = 20;
export const HARD_MAX_STEPS = 200;
export const DEFAULT_TIMEOUT_MS = 300_000;
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
  timeoutMs: number;
  screen?: { width: number; height: number };
  captureScreenshots: boolean;
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

  let screen: ExplorationTask["screen"];
  if (payload.screen !== undefined) {
    const s = payload.screen;
    if (isObj(s) && Number.isInteger(s.width) && Number.isInteger(s.height) && (s.width as number) > 0 && (s.height as number) > 0) {
      screen = { width: s.width as number, height: s.height as number };
    } else errors.push("screen must be {width, height} positive integers");
  }
  if (payload.captureScreenshots !== undefined && typeof payload.captureScreenshots !== "boolean") errors.push("captureScreenshots must be a boolean");

  if (errors.length > 0 || !objective) return { ok: false, errors };
  return {
    ok: true,
    task: { objective, ...(app ? { app } : {}), maxSteps, timeoutMs, ...(screen ? { screen } : {}), captureScreenshots: payload.captureScreenshots !== false },
  };
}
