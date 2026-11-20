import type { Device } from "../../device/types.js";
import type { Permission } from "../../skills/permissions.js";
import type { AgentLimits } from "../../skills/types.js";
import { hasVerifiedFailure } from "../exploration/findings.js";
import { type ExplorationResult, toTaskStatus } from "../exploration/result.js";
import type { HandlerContext, TaskHandler } from "../managed-agent.js";
import type { AgentResult } from "../types.js";
import { DeterministicSession, EDGE_INPUTS, intField, isObj, isTextField, labelOf, parseCommon, type CommonTaskOptions } from "./deterministic-session.js";

/**
 * Crash Hunter (MAIN-04-A): deterministic, seeded stress of one app to provoke crashes and ANRs.
 * No LLM and no API key. Like `adb monkey`, but driven by the UI hierarchy (it taps real controls,
 * types boundary values into text fields) and it reports every crash as a VERIFIED finding with
 * log evidence, a screenshot and reproduction steps, then replays those steps to confirm it.
 */

export { EDGE_INPUTS } from "./deterministic-session.js";

export const DEFAULT_SEED = 1;
export const DEFAULT_MAX_ACTIONS = 60;
export const HARD_MAX_ACTIONS = 500;
export const DEFAULT_COLD_STARTS = 3;
export const DEFAULT_HUNT_TIMEOUT_MS = 300_000;

export interface CrashHuntTask extends CommonTaskOptions {
  /** Same seed, same app state: same sequence of actions. */
  seed: number;
  /** Actions in the random stress phase (cold starts and the background check come on top). */
  maxActions: number;
  /** Stop/launch cycles before the stress phase. */
  coldStarts: number;
}

export function parseCrashHuntTask(payload: unknown): { ok: true; task: CrashHuntTask } | { ok: false; errors: string[] } {
  if (!isObj(payload)) return { ok: false, errors: ["payload must be an object"] };
  const errors: string[] = [];
  const common = parseCommon(payload, errors, DEFAULT_HUNT_TIMEOUT_MS);
  const seed = intField(errors, payload.seed, "seed", DEFAULT_SEED, 0, 2 ** 31 - 1);
  const maxActions = intField(errors, payload.maxActions, "maxActions", DEFAULT_MAX_ACTIONS, 1, HARD_MAX_ACTIONS);
  const coldStarts = intField(errors, payload.coldStarts, "coldStarts", DEFAULT_COLD_STARTS, 0, 20);
  if (errors.length > 0 || !common) return { ok: false, errors };
  return { ok: true, task: { ...common, seed, maxActions, coldStarts } };
}

/** mulberry32: tiny, fast, good enough for test input selection, and fully reproducible from the seed. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface CrashHuntDeps {
  taskId: string;
  agentId: string;
  deviceId?: string;
  device: Device;
  task: CrashHuntTask;
  permissions?: ReadonlySet<Permission>;
  ceilings?: AgentLimits;
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  onProgress?: (event: Record<string, unknown>) => void;
}

/** Never throws; every exit path yields a structured result in the same shape as an exploration run. */
export async function runCrashHunt(deps: CrashHuntDeps): Promise<ExplorationResult> {
  const ceil = deps.ceilings;
  const task: CrashHuntTask = ceil ? { ...deps.task, maxActions: Math.min(deps.task.maxActions, ceil.maxSteps), timeoutMs: Math.min(deps.task.timeoutMs, ceil.maxExecutionTimeMs) } : deps.task;
  const s = new DeterministicSession({ ...deps, options: task });
  const pkg = s.pkg;
  const rand = seededRandom(task.seed);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const act = s.act.bind(s);

  const body = async (): Promise<string> => {
    // Phase 1: cold starts. Startup crashes are the most common and the cheapest to find.
    for (let i = 0; i < task.coldStarts; i++) {
      await act({ action: "STOP_APP" }, `cold start ${i + 1}/${task.coldStarts}`, false);
      await act({ action: "LAUNCH_APP" }, `cold start ${i + 1}/${task.coldStarts}`, false);
      await act({ action: "WAIT", ms: 1500 }, "let the app settle");
    }
    if (task.coldStarts === 0) await act({ action: "LAUNCH_APP" }, "start the app");

    // Phase 2: background and resume (state restoration bugs).
    if (s.canKey) {
      await act({ action: "HOME" }, "send the app to the background");
      await act({ action: "WAIT", ms: 500 }, "stay in the background");
      await act({ action: "LAUNCH_APP" }, "bring the app back");
    }

    // Phase 3: seeded stress over the real controls on screen.
    s.startSegment();
    const stressEnd = s.tel.actions + task.maxActions;
    while (s.tel.actions < stressEnd) {
      const screen = await s.readScreen();
      if (screen.foreground && screen.foreground !== pkg) {
        await act({ action: "LAUNCH_APP" }, `the app left the foreground (${screen.foreground}); relaunch`);
        continue;
      }
      const targets = screen.elements.filter((e) => e.clickable && !s.isSensitive(e));
      const fields = screen.elements.filter(isTextField);
      const r = rand();
      const { width, height } = screen.size;
      if (r < 0.55) {
        if (targets.length > 0) {
          const e = pick(targets);
          await act({ action: "TAP", target: { x: e.x, y: e.y } }, `tap "${labelOf(e).slice(0, 40)}"`);
        } else {
          // No hierarchy (game, canvas, WebView): fall back to coordinates. The sensitive-tap guard cannot see these.
          const target = { x: Math.floor(rand() * width), y: Math.floor(rand() * height) };
          await act({ action: "TAP", target }, "tap at random coordinates (no UI hierarchy)");
        }
      } else if (r < 0.7 && fields.length > 0 && s.tel.actions + 2 <= stressEnd) {
        const e = pick(fields);
        const text = pick(EDGE_INPUTS);
        await act({ action: "TAP", target: { x: e.x, y: e.y } }, `focus field "${labelOf(e).slice(0, 40)}"`);
        await act({ action: "TYPE", text }, "type a boundary value");
      } else if (r < 0.85 && s.canSwipe) {
        const x = Math.round(width * (0.2 + rand() * 0.6));
        const up = rand() < 0.5;
        const from = { x, y: Math.round(height * (up ? 0.75 : 0.25)) };
        const to = { x, y: Math.round(height * (up ? 0.25 : 0.75)) };
        await act({ action: "SWIPE", from, to, durationMs: 200 + Math.floor(rand() * 300) }, up ? "scroll down" : "scroll up");
      } else if (r < 0.95 && s.canKey) {
        await act({ action: "BACK" }, "press back");
      } else {
        await act({ action: "STOP_APP" }, "rapid relaunch", false);
        await act({ action: "LAUNCH_APP" }, "rapid relaunch");
      }
    }
    // A crash can land a moment after the last action.
    await act({ action: "WAIT", ms: 1000 }, "final settle");
    await s.screenshot(s.tel.actions);
    return "Hunt completed.";
  };

  return s.run({ maxSteps: task.maxActions + task.coldStarts * 3 + 3 }, body, (f) =>
    `${f.status}: ${f.actions} action(s) with seed ${task.seed}, ${f.crashes} distinct crash(es)` +
    (f.repeats > 0 ? ` (${f.repeats} repeat occurrence(s) not listed again)` : "") +
    `. ${f.why}` +
    (f.sensitiveSkipped > 0 ? ` ${f.sensitiveSkipped} sensitive control(s) were left alone.` : "") +
    f.confirmNote,
  );
}

/** Task handler for MAIN-04-A ("crash-hunt"). Needs no LLM. */
export const crashHuntHandler: TaskHandler = {
  requires: ["launch_app", "stop_app", "tap", "type", "swipe", "press_key", "screenshot", "inspect_ui", "logs"],
  permissions: ["APP_LAUNCH", "DEVICE_INTERACT", "LOG_READ"],
  async handle(ctx: HandlerContext): Promise<AgentResult> {
    const parsed = parseCrashHuntTask(ctx.task.payload);
    if (!parsed.ok) return { status: "ERROR", summary: `Invalid crash-hunt task: ${parsed.errors.join("; ")}`, evidence: [] };
    const result = await runCrashHunt({
      taskId: ctx.task.task_id,
      agentId: ctx.definition.id,
      deviceId: ctx.runtime.deviceId,
      device: ctx.device,
      task: parsed.task,
      ...(ctx.profile ? { permissions: new Set(ctx.profile.permissions), ceilings: ctx.profile.limits } : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      onProgress: ctx.report,
    });
    return { status: toTaskStatus(result.status, hasVerifiedFailure(result.findings)), summary: result.summary, evidence: result.evidence, details: result };
  },
};
