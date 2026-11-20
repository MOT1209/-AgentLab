import type { Device } from "../../device/types.js";
import type { Permission } from "../../skills/permissions.js";
import type { AgentLimits } from "../../skills/types.js";
import { hasVerifiedFailure } from "../exploration/findings.js";
import { type ExplorationResult, toTaskStatus } from "../exploration/result.js";
import type { HandlerContext, TaskHandler } from "../managed-agent.js";
import type { AgentResult } from "../types.js";
import { DeterministicSession, intField, isObj, parseCommon, type CommonTaskOptions } from "./deterministic-session.js";

/**
 * Stability Tester (MAIN-04-B): long, repeated sessions of one app, deterministic and without an LLM.
 *
 * Cold cycles (stop, launch, settle) count crashes that only happen sometimes and record the launch time.
 * Warm cycles (home, settle, resume, settle) keep the process alive and sample its memory (PSS) after
 * each resume; steady growth across resumes is reported as a leak. Every crash is a VERIFIED finding,
 * with how often it happened.
 */

export const DEFAULT_COLD_CYCLES = 10;
export const DEFAULT_WARM_CYCLES = 20;
export const DEFAULT_SETTLE_MS = 1500;
export const DEFAULT_STABILITY_TIMEOUT_MS = 1_200_000;
const MIN_RUN_SAMPLES = 6;
const ACTIONS_PER_COLD = 3;
const ACTIONS_PER_WARM = 4;
const WARM_START_ACTIONS = 3;

export interface StabilityTask extends CommonTaskOptions {
  coldCycles: number;
  warmCycles: number;
  settleMs: number;
  /** A leak is reported when memory grows by at least this percentage AND at least memoryGrowthMb. */
  memoryGrowthPct: number;
  memoryGrowthMb: number;
}

export interface CycleRecord {
  n: number;
  kind: "cold" | "warm";
  /** Cold cycles: wall time of the launch command (adb round trip, not time to first frame). */
  launchMs?: number;
  /** Warm cycles: total PSS after the resume, if the device can read it. */
  pssKb?: number;
  /** Memory series index; a crash restarts the process and starts a new series. */
  run?: number;
  crashed: boolean;
}

export interface MemorySample {
  run: number;
  kb: number;
}

export interface MemoryVerdict {
  verdict: "GROWS" | "STABLE" | "INSUFFICIENT";
  /** Samples in the series that was judged (the longest uninterrupted one). */
  samples: number;
  firstKb?: number;
  lastKb?: number;
  growthPct?: number;
  /** Least-squares slope in KB per resume. */
  slopeKb?: number;
}

const median = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/**
 * Judges the longest uninterrupted series (at least 6 samples). Compares the median of its first 3 samples
 * with the median of its last 3, so one spike does not decide it, and requires a positive trend line.
 */
export function analyzeMemory(samples: readonly MemorySample[], growthPct: number, growthMb: number): MemoryVerdict {
  const runs = new Map<number, number[]>();
  for (const s of samples) runs.set(s.run, [...(runs.get(s.run) ?? []), s.kb]);
  const series = [...runs.values()].sort((a, b) => b.length - a.length)[0] ?? [];
  if (series.length < MIN_RUN_SAMPLES) return { verdict: "INSUFFICIENT", samples: series.length };
  const first = median(series.slice(0, 3));
  const last = median(series.slice(-3));
  const n = series.length;
  const mx = (n - 1) / 2;
  const my = series.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  series.forEach((y, x) => {
    num += (x - mx) * (y - my);
    den += (x - mx) ** 2;
  });
  const slope = den > 0 ? num / den : 0;
  const pct = first > 0 ? ((last - first) / first) * 100 : 0;
  const grows = pct >= growthPct && last - first >= growthMb * 1024 && slope > 0;
  return { verdict: grows ? "GROWS" : "STABLE", samples: n, firstKb: first, lastKb: last, growthPct: Math.round(pct * 10) / 10, slopeKb: Math.round(slope) };
}

export function parseStabilityTask(payload: unknown): { ok: true; task: StabilityTask } | { ok: false; errors: string[] } {
  if (!isObj(payload)) return { ok: false, errors: ["payload must be an object"] };
  const errors: string[] = [];
  // Default for confirmCrashes is false here: an intermittent crash rarely recurs in one replay; its rate is the evidence.
  const common = parseCommon({ ...payload, confirmCrashes: payload.confirmCrashes ?? false }, errors, DEFAULT_STABILITY_TIMEOUT_MS);
  const coldCycles = intField(errors, payload.coldCycles, "coldCycles", DEFAULT_COLD_CYCLES, 0, 50);
  const warmCycles = intField(errors, payload.warmCycles, "warmCycles", DEFAULT_WARM_CYCLES, 0, 100);
  const settleMs = intField(errors, payload.settleMs, "settleMs", DEFAULT_SETTLE_MS, 0, 10_000);
  const memoryGrowthPct = intField(errors, payload.memoryGrowthPct, "memoryGrowthPct", 25, 1, 1000);
  const memoryGrowthMb = intField(errors, payload.memoryGrowthMb, "memoryGrowthMb", 15, 1, 10_000);
  if (coldCycles + warmCycles < 1) errors.push("coldCycles + warmCycles must be at least 1");
  if (errors.length > 0 || !common) return { ok: false, errors };
  return { ok: true, task: { ...common, coldCycles, warmCycles, settleMs, memoryGrowthPct, memoryGrowthMb } };
}

export interface StabilityDeps {
  taskId: string;
  agentId: string;
  deviceId?: string;
  device: Device;
  task: StabilityTask;
  permissions?: ReadonlySet<Permission>;
  ceilings?: AgentLimits;
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  onProgress?: (event: Record<string, unknown>) => void;
}

export interface StabilityMetrics {
  cycles: CycleRecord[];
  memory: MemoryVerdict;
  launch?: { firstMs: number; medianMs: number; lastMs: number };
  /** Per crash finding: how many of the cycles it happened in. */
  crashRates: Array<{ findingId: string; occurrences: number; cycles: number }>;
}

/** Never throws. The result is an ExplorationResult plus `metrics`. */
export async function runStability(deps: StabilityDeps): Promise<ExplorationResult & { metrics: StabilityMetrics }> {
  const ceil = deps.ceilings;
  const notes: string[] = [];
  let { coldCycles, warmCycles } = deps.task;
  // Plan within the step ceiling up front (crash recovery can still add a few actions).
  if (ceil) {
    const cost = () => coldCycles * ACTIONS_PER_COLD + (warmCycles > 0 ? WARM_START_ACTIONS + warmCycles * ACTIONS_PER_WARM : 0) + 1;
    const asked = `${coldCycles} cold + ${warmCycles} warm`;
    while (cost() > ceil.maxSteps && warmCycles > 0) warmCycles--;
    while (cost() > ceil.maxSteps && coldCycles > 0) coldCycles--;
    if (`${coldCycles} cold + ${warmCycles} warm` !== asked) notes.push(`Reduced from ${asked} cycles to fit the agent's step ceiling (${ceil.maxSteps} actions).`);
  }
  const task: StabilityTask = { ...deps.task, coldCycles, warmCycles, ...(ceil ? { timeoutMs: Math.min(deps.task.timeoutMs, ceil.maxExecutionTimeMs) } : {}) };
  const s = new DeterministicSession({ ...deps, options: task });
  const act = s.act.bind(s);
  const now = deps.now ?? Date.now;
  const cycles: CycleRecord[] = [];
  const canMemory = typeof s.device.memoryKb === "function" && (!deps.permissions || deps.permissions.has("DEVICE_READ"));
  let memory: MemoryVerdict = { verdict: "INSUFFICIENT", samples: 0 };
  const settle = (why: string) => act({ action: "WAIT", ms: task.settleMs }, why);
  const sampleMemory = async (): Promise<number | undefined> => {
    if (!canMemory) return undefined;
    try {
      return await s.device.memoryKb!(s.pkg);
    } catch {
      return undefined;
    }
  };

  const body = async (): Promise<string> => {
    // Cold cycles: intermittent startup crashes and launch time.
    for (let i = 1; i <= task.coldCycles; i++) {
      const before = s.crashCount;
      s.crashContext = `first seen in cold cycle ${i} of ${task.coldCycles}`;
      s.startSegment();
      await act({ action: "STOP_APP" }, `cold ${i}/${task.coldCycles}: stop`, false);
      const t0 = now();
      await act({ action: "LAUNCH_APP" }, `cold ${i}/${task.coldCycles}: launch`, false);
      const launchMs = now() - t0;
      await settle(`cold ${i}/${task.coldCycles}: settle`);
      cycles.push({ n: cycles.length + 1, kind: "cold", launchMs, crashed: s.crashCount > before });
      s.emit({ kind: "cycle", n: cycles.length, cycle: "cold", launchMs, crashed: s.crashCount > before });
    }

    // Warm cycles: the process stays alive across resumes, so its memory should not keep growing.
    if (task.warmCycles > 0) {
      if (!s.canKey) notes.push("The device cannot press HOME: no warm cycles.");
      else {
        if (!canMemory) notes.push("Memory cannot be read on this device (or DEVICE_READ is not granted): no leak check.");
        let run = 0;
        s.startSegment();
        await act({ action: "STOP_APP" }, "warm phase: clean start", false);
        await act({ action: "LAUNCH_APP" }, "warm phase: clean start", false);
        await settle("warm phase: settle");
        for (let i = 1; i <= task.warmCycles; i++) {
          const before = s.crashCount;
          s.crashContext = `first seen in warm resume ${i} of ${task.warmCycles}`;
          await act({ action: "HOME" }, `warm ${i}/${task.warmCycles}: background`);
          await settle(`warm ${i}/${task.warmCycles}: stay in the background`);
          await act({ action: "LAUNCH_APP" }, `warm ${i}/${task.warmCycles}: resume`, false);
          await settle(`warm ${i}/${task.warmCycles}: settle`);
          const crashed = s.crashCount > before;
          // A crash restarted the process: memory from here on is a new series.
          if (crashed) run++;
          const pssKb = crashed ? undefined : await sampleMemory();
          cycles.push({ n: cycles.length + 1, kind: "warm", ...(pssKb !== undefined ? { pssKb } : {}), run, crashed });
          s.emit({ kind: "cycle", n: cycles.length, cycle: "warm", pssKb, crashed });
        }
        s.crashContext = undefined;
        const samples = cycles.filter((c) => c.kind === "warm" && c.pssKb !== undefined).map((c) => ({ run: c.run!, kb: c.pssKb! }));
        memory = analyzeMemory(samples, task.memoryGrowthPct, task.memoryGrowthMb);
        if (memory.verdict === "GROWS") {
          const mb = (kb: number) => `${Math.round(kb / 1024)} MB`;
          const ev = s.evidence.add("action_result", `PSS per warm resume (KB): ${samples.map((x) => x.kb).join(", ")}`, s.tel.actions);
          const f = s.findings.addVerified(
            "memory-growth",
            "MEDIUM",
            "Memory grows across warm resumes (possible leak)",
            `Total PSS went from ${mb(memory.firstKb!)} to ${mb(memory.lastKb!)} (+${memory.growthPct}%) over ${memory.samples} resumes without the process restarting (trend +${Math.round(memory.slopeKb! / 1024 * 10) / 10} MB per resume). Medians of the first and last 3 samples.`,
            ev?.id ? [ev.id] : [],
            s.tel.actions,
          );
          if (f) s.emit({ kind: "finding", id: f.id, severity: f.severity, title: f.title, source: f.source });
        } else if (canMemory && memory.verdict === "INSUFFICIENT") notes.push(`Too few memory samples in one uninterrupted series (${memory.samples}, need ${MIN_RUN_SAMPLES}) to judge a leak.`);
      }
    }
    await s.screenshot(s.tel.actions);
    return "Stability run completed.";
  };

  const launchStats = (): StabilityMetrics["launch"] => {
    const ms = cycles.filter((c) => c.launchMs !== undefined).map((c) => c.launchMs!);
    return ms.length > 0 ? { firstMs: ms[0]!, medianMs: Math.round(median(ms)), lastMs: ms[ms.length - 1]! } : undefined;
  };
  const crashRates = (): StabilityMetrics["crashRates"] => [...s.occurrencesByFinding()].map(([findingId, occurrences]) => ({ findingId, occurrences, cycles: cycles.length }));

  const result = await s.run(
    { maxSteps: task.coldCycles * ACTIONS_PER_COLD + (task.warmCycles > 0 ? WARM_START_ACTIONS + task.warmCycles * ACTIONS_PER_WARM : 0) + 1 },
    body,
    (f) => {
      const cold = cycles.filter((c) => c.kind === "cold").length;
      const warm = cycles.length - cold;
      const rates = crashRates().map((r) => `${r.findingId} in ${r.occurrences} of ${r.cycles} cycles`);
      const mem =
        memory.verdict === "GROWS" ? ` Memory grows: +${memory.growthPct}% over ${memory.samples} resumes.`
        : memory.verdict === "STABLE" ? ` Memory stable over ${memory.samples} resumes (${memory.growthPct}% change).`
        : "";
      const launch = launchStats();
      return (
        `${f.status}: ${cold} cold start(s), ${warm} warm resume(s), ${f.actions} action(s), ${f.crashes} finding(s). ${f.why}` +
        (rates.length > 0 ? ` Crashes: ${rates.join("; ")}.` : "") +
        mem +
        (launch ? ` Launch command time (adb round trip) first ${launch.firstMs} ms, median ${launch.medianMs} ms, last ${launch.lastMs} ms.` : "") +
        (notes.length > 0 ? ` ${notes.join(" ")}` : "") +
        f.confirmNote
      );
    },
    () => ({ metrics: { cycles, memory, ...(launchStats() ? { launch: launchStats()! } : {}), crashRates: crashRates() } }),
  );
  return result as ExplorationResult & { metrics: StabilityMetrics };
}

/** Task handler for MAIN-04-B ("stability"). Needs no LLM. */
export const stabilityHandler: TaskHandler = {
  requires: ["launch_app", "stop_app", "logs", "press_key"],
  permissions: ["APP_LAUNCH", "DEVICE_INTERACT", "LOG_READ"],
  async handle(ctx: HandlerContext): Promise<AgentResult> {
    const parsed = parseStabilityTask(ctx.task.payload);
    if (!parsed.ok) return { status: "ERROR", summary: `Invalid stability task: ${parsed.errors.join("; ")}`, evidence: [] };
    const result = await runStability({
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
