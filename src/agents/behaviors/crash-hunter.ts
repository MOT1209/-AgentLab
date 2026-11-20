import type { Device, UiNode } from "../../device/types.js";
import { actionAllowed, type Permission } from "../../skills/permissions.js";
import type { AgentLimits } from "../../skills/types.js";
import { ActionExecutor, type ActionOutcome } from "../exploration/action-executor.js";
import type { ActionName, AgentAction } from "../exploration/actions.js";
import { confirmCrashReplays, reproStepsFrom } from "../exploration/crash-confirm.js";
import { createFileEvidenceWriter, writeResultFile } from "../exploration/evidence-files.js";
import { EvidenceStore } from "../exploration/evidence.js";
import { detectCrash, FindingLog, hasVerifiedFailure, type Finding } from "../exploration/findings.js";
import { summarizeUi, type UiElement } from "../exploration/observation.js";
import { type ActionRecord, type ExplorationResult, type ExplorationStatus, type ExplorationTelemetry, toTaskStatus } from "../exploration/result.js";
import { sensitiveTerm } from "../exploration/sensitive-actions.js";
import type { HandlerContext, TaskHandler } from "../managed-agent.js";
import type { AgentResult } from "../types.js";

/**
 * Crash Hunter (MAIN-04-A): deterministic, seeded stress of one app to provoke crashes and ANRs.
 * No LLM and no API key. Like `adb monkey`, but driven by the UI hierarchy (it taps real controls,
 * types boundary values into text fields) and it reports every crash as a VERIFIED finding with
 * log evidence, a screenshot and reproduction steps, then replays those steps to confirm it.
 */

export const DEFAULT_SEED = 1;
export const DEFAULT_MAX_ACTIONS = 60;
export const HARD_MAX_ACTIONS = 500;
export const DEFAULT_COLD_STARTS = 3;
export const DEFAULT_HUNT_TIMEOUT_MS = 300_000;
const HARD_MAX_TIMEOUT_MS = 1_800_000;
const DEFAULT_SCREEN = { width: 1080, height: 1920 };

export interface CrashHuntTask {
  app: { packageName: string; launchActivity?: string };
  /** Same seed, same app state: same sequence of actions. */
  seed: number;
  /** Actions in the random stress phase (cold starts and the background check come on top). */
  maxActions: number;
  /** Stop/launch cycles before the stress phase. */
  coldStarts: number;
  timeoutMs: number;
  evidenceDir?: string;
  /** Used for coordinate taps and swipes when the screen exposes no UI hierarchy. */
  screen?: { width: number; height: number };
  /** Replay the steps behind each crash once. On by default. */
  confirmCrashes: boolean;
  /** Allow taps on controls that read as buy/pay/subscribe/delete account/factory reset/uninstall. Off by default. */
  allowSensitiveActions: boolean;
}

/**
 * Boundary values typed into text fields. ASCII only: stock `adb input text` cannot type anything else,
 * and non-ASCII would need the ADBKeyboard app (see AdbDevice.type).
 */
export const EDGE_INPUTS: readonly string[] = [
  "0",
  "-1",
  "2147483648",
  "-9223372036854775809",
  "99999999999999999999999999",
  "1e309",
  "NaN",
  "0.0000000001",
  "null",
  "   ",
  "a".repeat(300),
  "' OR '1'='1",
  "<script>alert(1)</script>",
  "%s%s%s%n",
  "../../../../etc/passwd",
  "!@#$%^&*()_+{}|:<>?",
  "test@",
  "@@@",
];

const PKG = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function parseCrashHuntTask(payload: unknown): { ok: true; task: CrashHuntTask } | { ok: false; errors: string[] } {
  if (!isObj(payload)) return { ok: false, errors: ["payload must be an object"] };
  const errors: string[] = [];
  let app: CrashHuntTask["app"] | undefined;
  const a = payload.app;
  if (!isObj(a) || typeof a.packageName !== "string" || !PKG.test(a.packageName)) errors.push("app.packageName is required and must be a valid package name");
  else {
    app = { packageName: a.packageName };
    if (a.launchActivity !== undefined) {
      if (typeof a.launchActivity === "string" && /^[A-Za-z0-9_.$/]{1,200}$/.test(a.launchActivity)) app.launchActivity = a.launchActivity;
      else errors.push("app.launchActivity must be an activity name like .MainActivity");
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
  const seed = int(payload.seed, "seed", DEFAULT_SEED, 0, 2 ** 31 - 1);
  const maxActions = int(payload.maxActions, "maxActions", DEFAULT_MAX_ACTIONS, 1, HARD_MAX_ACTIONS);
  const coldStarts = int(payload.coldStarts, "coldStarts", DEFAULT_COLD_STARTS, 0, 20);
  const timeoutMs = int(payload.timeoutMs, "timeoutMs", DEFAULT_HUNT_TIMEOUT_MS, 1, HARD_MAX_TIMEOUT_MS);
  let evidenceDir: string | undefined;
  if (payload.evidenceDir !== undefined) {
    const d = payload.evidenceDir;
    if (typeof d === "string" && d.length > 0 && d.length < 500 && !d.includes("\0") && (d.startsWith("/") || /^[A-Za-z]:[\\/]/.test(d))) evidenceDir = d;
    else errors.push("evidenceDir must be an absolute path");
  }
  let screen: CrashHuntTask["screen"];
  if (payload.screen !== undefined) {
    const s = payload.screen;
    if (isObj(s) && Number.isInteger(s.width) && Number.isInteger(s.height) && (s.width as number) > 0 && (s.height as number) > 0) screen = { width: s.width as number, height: s.height as number };
    else errors.push("screen must be {width, height} positive integers");
  }
  for (const k of ["confirmCrashes", "allowSensitiveActions"] as const) if (payload[k] !== undefined && typeof payload[k] !== "boolean") errors.push(`${k} must be a boolean`);
  if (errors.length > 0 || !app) return { ok: false, errors };
  return {
    ok: true,
    task: { app, seed, maxActions, coldStarts, timeoutMs, ...(evidenceDir ? { evidenceDir } : {}), ...(screen ? { screen } : {}), confirmCrashes: payload.confirmCrashes !== false, allowSensitiveActions: payload.allowSensitiveActions === true },
  };
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

const isTextField = (e: UiElement): boolean => /EditText|TextInput|AutoComplete|SearchView/i.test(e.cls ?? "");
const labelOf = (e: UiElement): string => e.text ?? e.desc ?? e.id ?? `${e.x},${e.y}`;

/** Never throws; every exit path yields a structured result in the same shape as an exploration run. */
export async function runCrashHunt(deps: CrashHuntDeps): Promise<ExplorationResult> {
  const { device, agentId, taskId } = deps;
  const ceil = deps.ceilings;
  const task: CrashHuntTask = ceil ? { ...deps.task, maxActions: Math.min(deps.task.maxActions, ceil.maxSteps), timeoutMs: Math.min(deps.task.timeoutMs, ceil.maxExecutionTimeMs) } : deps.task;
  const pkg = task.app.packageName;
  const now = deps.now ?? Date.now;
  const startMs = now();
  const startedAt = new Date(startMs).toISOString();
  const rand = seededRandom(task.seed);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;

  const evidence = new EvidenceStore(agentId, undefined, now);
  if (task.evidenceDir) evidence.persist = createFileEvidenceWriter(task.evidenceDir, taskId);
  const findings = new FindingLog(agentId, now);
  const executor = new ActionExecutor(device, { evidence, packageName: pkg, ...(task.app.launchActivity ? { launchActivity: task.app.launchActivity } : {}), ...(deps.sleep ? { sleep: deps.sleep } : {}) });
  const history: ActionRecord[] = [];
  const tel: ExplorationTelemetry = { llmCalls: 0, actions: 0, actionFailures: 0, providerErrors: 0, deviceErrors: 0, malformedResponses: 0, inputTokens: 0, outputTokens: 0, durationMs: 0 };
  const allowed = (a: ActionName): boolean => !deps.permissions || actionAllowed(a, deps.permissions);
  const canSwipe = typeof device.swipe === "function" && allowed("SWIPE");
  const canKey = typeof device.pressKey === "function" && allowed("BACK");
  const canUi = typeof device.ui === "function" && allowed("GET_UI");
  /** First step of the segment since the last recovery; a crash's repro steps and replay start here. */
  let segmentStart = 1;
  const segmentOf = new Map<string, number>();
  const occurrences = new Map<string, number>();
  const sensitiveSkipped = new Set<string>();

  const emit = (event: Record<string, unknown>) => {
    try {
      deps.onProgress?.(event);
    } catch {
      /* ignore */
    }
  };
  evidence.onAdd = (ev) => {
    if (ev.kind === "screenshot") emit({ kind: "screenshot", id: ev.id, step: ev.step, data: ev.data });
  };

  const ctrl = new AbortController();
  let stop: "timeout" | "cancelled" | undefined;
  const timer = setTimeout(() => {
    stop ??= "timeout";
    ctrl.abort();
  }, task.timeoutMs);
  const onExternalAbort = () => {
    stop ??= "cancelled";
    ctrl.abort();
  };
  if (deps.signal?.aborted) onExternalAbort();
  else deps.signal?.addEventListener("abort", onExternalAbort, { once: true });

  const deviceAlive = async (): Promise<boolean> => {
    try {
      await device.info();
      return device.state() === "ONLINE";
    } catch {
      return false;
    }
  };
  const screenshot = async (step: number): Promise<string | undefined> => {
    if (!evidence.canAddScreenshot() || !allowed("SCREENSHOT")) return undefined;
    try {
      return evidence.add("screenshot", (await device.screenshot()).toString("base64"), step)?.id;
    } catch {
      return undefined;
    }
  };

  class DeviceLost extends Error {}
  class Stopped extends Error {}

  /** Reads the log after a step. A crash becomes a VERIFIED finding; the app is then relaunched so the hunt goes on. */
  const checkForCrash = async (step: number): Promise<boolean> => {
    let logs: string;
    try {
      logs = await device.logs(100);
    } catch {
      return false;
    }
    const crash = detectCrash(logs, pkg);
    if (!crash) return false;
    const key = `${crash.title}|${crash.exception ?? ""}|${crash.process ?? ""}`;
    occurrences.set(key, (occurrences.get(key) ?? 0) + 1);
    const logEv = evidence.add("log", crash.excerpt, step);
    const shot = await screenshot(step);
    const f = findings.addVerified(key, crash.severity, crash.title, `Detected in device logs after step ${step}${crash.process ? ` (process ${crash.process})` : ""}${crash.exception ? `, ${crash.exception}` : ""}: ${crash.excerpt.split("\n")[0]}`, [logEv?.id, shot].filter((x): x is string => !!x), step);
    if (f) {
      segmentOf.set(f.id, segmentStart);
      findings.annotate(f.id, { reproSteps: reproStepsFrom(history.filter((h) => h.step >= segmentStart)) });
      emit({ kind: "finding", id: f.id, severity: f.severity, title: f.title, source: f.source });
    }
    await device.clearLogs?.().catch(() => undefined);
    // Recover: a fresh segment starts with a clean launch.
    segmentStart = tel.actions + 1;
    await act({ action: "STOP_APP" }, "recover after crash", false);
    await act({ action: "LAUNCH_APP" }, "recover after crash", false);
    return true;
  };

  /** Executes one action, records it, and (unless told not to) checks the log for a crash. */
  const act = async (action: AgentAction, reason: string, check = true): Promise<ActionOutcome> => {
    if (ctrl.signal.aborted) throw new Stopped();
    const step = ++tel.actions;
    const result = await executor.execute(action, step, ctrl.signal);
    history.push({ step, action: action.action, params: action as unknown as Record<string, unknown>, reason, ok: result.ok, detail: result.detail, ...(result.errorCode ? { errorCode: result.errorCode } : {}), evidenceIds: result.evidenceIds });
    emit({ kind: "action", step, action: action.action, params: action, reason, ok: result.ok, detail: result.detail, ...(result.errorCode ? { errorCode: result.errorCode } : {}) });
    if (!result.ok) {
      tel.actionFailures++;
      if (result.deviceError) {
        tel.deviceErrors++;
        if (!(await deviceAlive())) throw new DeviceLost(`Device became unavailable at step ${step}: ${result.detail}`);
      }
    }
    if (ctrl.signal.aborted) throw new Stopped();
    if (check) await checkForCrash(step);
    return result;
  };

  const readScreen = async (): Promise<{ elements: UiElement[]; foreground?: string; size: { width: number; height: number } }> => {
    let nodes: UiNode[] = [];
    if (canUi) {
      try {
        nodes = await device.ui!();
      } catch {
        nodes = [];
      }
    }
    const s = summarizeUi(nodes);
    const maxR = Math.max(0, ...nodes.map((n) => n.bounds.r));
    const maxB = Math.max(0, ...nodes.map((n) => n.bounds.b));
    const size = task.screen ?? (maxR > 0 && maxB > 0 ? { width: maxR, height: maxB } : DEFAULT_SCREEN);
    return { elements: s.elements, ...(s.foreground ? { foreground: s.foreground } : {}), size };
  };

  const finish = async (status: ExplorationStatus, why: string): Promise<ExplorationResult> => {
    let confirmNote: string | undefined;
    if (task.confirmCrashes && ["PASSED", "FAILED", "MAX_STEPS_REACHED"].includes(status) && (await deviceAlive())) {
      confirmNote = await confirmCrashReplays({ device, agentId, packageName: pkg, ...(task.app.launchActivity ? { launchActivity: task.app.launchActivity } : {}), findings, history, ...(deps.signal ? { signal: deps.signal } : {}), now, ...(deps.sleep ? { sleep: deps.sleep } : {}), emit, startStepOf: (f: Finding) => segmentOf.get(f.id) ?? 0 });
    }
    await device.stop(pkg).catch(() => undefined);
    const all = findings.all();
    const repeats = [...occurrences.values()].reduce((n, c) => n + c, 0) - all.length;
    tel.durationMs = now() - startMs;
    const summary =
      `${status}: ${tel.actions} action(s) with seed ${task.seed}, ${all.length} distinct crash(es)` +
      (repeats > 0 ? ` (${repeats} repeat occurrence(s) not listed again)` : "") +
      `. ${why}` +
      (sensitiveSkipped.size > 0 ? ` ${sensitiveSkipped.size} sensitive control(s) were left alone.` : "") +
      (confirmNote ?? "");
    emit({ kind: "finished", status });
    const result: ExplorationResult = {
      ...(task.evidenceDir ? { evidenceDir: task.evidenceDir } : {}),
      status,
      taskId,
      agentId,
      ...(deps.deviceId ? { deviceId: deps.deviceId } : {}),
      steps: tel.actions,
      findings: all,
      evidence: evidence.list(),
      actionLog: [...history],
      telemetry: { ...tel },
      startedAt,
      completedAt: new Date(now()).toISOString(),
      summary,
    };
    if (task.evidenceDir) writeResultFile(task.evidenceDir, taskId, result as unknown as { evidence: typeof result.evidence } & Record<string, unknown>);
    return result;
  };

  try {
    emit({ kind: "started", maxSteps: task.maxActions + task.coldStarts * 3 + 3 });
    if (!(await deviceAlive())) {
      tel.deviceErrors++;
      return await finish("BLOCKED", "Device unavailable before the first action.");
    }
    await device.clearLogs?.().catch(() => undefined);
    await screenshot(0);

    // Phase 1: cold starts. Startup crashes are the most common and the cheapest to find.
    for (let i = 0; i < task.coldStarts; i++) {
      await act({ action: "STOP_APP" }, `cold start ${i + 1}/${task.coldStarts}`, false);
      await act({ action: "LAUNCH_APP" }, `cold start ${i + 1}/${task.coldStarts}`, false);
      await act({ action: "WAIT", ms: 1500 }, "let the app settle");
    }
    if (task.coldStarts === 0) await act({ action: "LAUNCH_APP" }, "start the app");

    // Phase 2: background and resume (state restoration bugs).
    if (canKey) {
      await act({ action: "HOME" }, "send the app to the background");
      await act({ action: "WAIT", ms: 500 }, "stay in the background");
      await act({ action: "LAUNCH_APP" }, "bring the app back");
    }

    // Phase 3: seeded stress over the real controls on screen.
    segmentStart = tel.actions + 1;
    const stressEnd = tel.actions + task.maxActions;
    while (tel.actions < stressEnd) {
      const screen = await readScreen();
      if (screen.foreground && screen.foreground !== pkg) {
        await act({ action: "LAUNCH_APP" }, `the app left the foreground (${screen.foreground}); relaunch`);
        continue;
      }
      const targets = screen.elements.filter((e) => {
        if (!e.clickable) return false;
        if (task.allowSensitiveActions) return true;
        if (sensitiveTerm(e.text) ?? sensitiveTerm(e.desc) ?? sensitiveTerm(e.id)) {
          sensitiveSkipped.add(labelOf(e));
          return false;
        }
        return true;
      });
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
      } else if (r < 0.7 && fields.length > 0 && tel.actions + 2 <= stressEnd) {
        const e = pick(fields);
        const text = pick(EDGE_INPUTS);
        await act({ action: "TAP", target: { x: e.x, y: e.y } }, `focus field "${labelOf(e).slice(0, 40)}"`);
        await act({ action: "TYPE", text }, "type a boundary value");
      } else if (r < 0.85 && canSwipe) {
        const x = Math.round(width * (0.2 + rand() * 0.6));
        const up = rand() < 0.5;
        const from = { x, y: Math.round(height * (up ? 0.75 : 0.25)) };
        const to = { x, y: Math.round(height * (up ? 0.25 : 0.75)) };
        await act({ action: "SWIPE", from, to, durationMs: 200 + Math.floor(rand() * 300) }, up ? "scroll down" : "scroll up");
      } else if (r < 0.95 && canKey) {
        await act({ action: "BACK" }, "press back");
      } else {
        await act({ action: "STOP_APP" }, "rapid relaunch", false);
        await act({ action: "LAUNCH_APP" }, "rapid relaunch");
      }
    }
    // A crash can land a moment after the last action.
    await act({ action: "WAIT", ms: 1000 }, "final settle");
    await screenshot(tel.actions);
    return await finish(hasVerifiedFailure(findings.all()) ? "FAILED" : "PASSED", "Hunt completed.");
  } catch (e) {
    if (e instanceof DeviceLost) return await finish("BLOCKED", e.message);
    if (e instanceof Stopped || ctrl.signal.aborted) return await finish(stop === "timeout" ? "TIMEOUT" : "CANCELLED", stop === "timeout" ? `Stopped after ${task.timeoutMs} ms.` : "Cancelled by the dispatcher.");
    return await finish("ERROR", `Unexpected failure: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener("abort", onExternalAbort);
  }
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
