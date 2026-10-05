import type { Device } from "../../device/types.js";
import type { LlmProvider } from "../../providers/types.js";
import { actionAllowed, type Permission } from "../../skills/permissions.js";
import type { AgentLimits } from "../../skills/types.js";
import type { HandlerContext, TaskHandler } from "../managed-agent.js";
import type { AgentResult } from "../types.js";
import { ActionExecutor, ActionOutcome } from "./action-executor.js";
import { supportedActions, ValidationLimits } from "./action-validator.js";
import type { AgentDecision } from "./actions.js";
import { requestDecision } from "./decision.js";
import { EvidenceStore } from "./evidence.js";
import { detectCrash, FindingLog, hasVerifiedFailure, relevantLogLines } from "./findings.js";
import { Observation, summarizeUi } from "./observation.js";
import { buildUserMessage } from "./prompt.js";
import { ActionRecord, ExplorationResult, ExplorationStatus, ExplorationTelemetry, toTaskStatus } from "./result.js";
import { ExplorationTask, parseExplorationTask } from "./task.js";

export type Logger = (event: string, data?: Record<string, unknown>) => void;

/** Quiet unless AGENTLAB_LOG=1. Only ever receives ids, action names and short reasons, never payloads or secrets. */
export const envLogger: Logger = (event, data) => {
  if (process.env.AGENTLAB_LOG === "1") console.error(`[exploration] ${event}`, data ?? "");
};

export interface ExplorationDeps {
  taskId: string;
  agentId: string;
  deviceId?: string;
  device: Device;
  llm: LlmProvider;
  task: ExplorationTask;
  /** When set, only actions these permissions cover can run; END_TEST and WAIT need none. */
  permissions?: ReadonlySet<Permission>;
  /** Ceilings from the agent's skill profile. The effective limit is the smaller of task and ceiling. */
  ceilings?: AgentLimits;
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  log?: Logger;
}

/** The smaller of what the task asked for and what the agent's profile allows. */
function clampTask(task: ExplorationTask, ceilings?: AgentLimits): ExplorationTask {
  if (!ceilings) return task;
  return { ...task, maxSteps: Math.min(task.maxSteps, ceilings.maxSteps), timeoutMs: Math.min(task.timeoutMs, ceilings.maxExecutionTimeMs) };
}

const REPEAT_WARN_AT = 3;
const REPEAT_STOP_AT = 5;

/**
 * The bounded observe -> decide -> validate -> execute -> observe loop.
 * Never throws; every exit path (limit, timeout, cancel, error, device loss) yields a structured result.
 */
export async function runExploration(deps: ExplorationDeps): Promise<ExplorationResult> {
  const { device, llm, taskId, agentId } = deps;
  const task = clampTask(deps.task, deps.ceilings);
  const now = deps.now ?? Date.now;
  const log = deps.log ?? envLogger;
  const startMs = now();
  const startedAt = new Date(startMs).toISOString();

  const evidence = new EvidenceStore(agentId, undefined, now);
  const findings = new FindingLog(agentId, now);
  const packageName = task.app?.packageName;
  const executor = new ActionExecutor(device, { evidence, ...(packageName ? { packageName } : {}), ...(deps.sleep ? { sleep: deps.sleep } : {}) });
  const deviceActions = supportedActions(device, !!packageName);
  const supported = deps.permissions ? new Set([...deviceActions].filter((a) => actionAllowed(a, deps.permissions!))) : deviceActions;
  const limits: ValidationLimits = { supported, ...(task.screen ? { screen: task.screen } : {}) };
  const history: ActionRecord[] = [];
  const tel: ExplorationTelemetry = { llmCalls: 0, actions: 0, actionFailures: 0, providerErrors: 0, deviceErrors: 0, malformedResponses: 0, inputTokens: 0, outputTokens: 0, durationMs: 0 };

  // One controller for both timeout and external cancellation. `stop` records which one fired first.
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

  let conclusion: string | undefined;

  const finish = (status: ExplorationStatus, why: string): ExplorationResult => {
    const all = findings.all();
    const verified = all.filter((f) => f.source === "VERIFIED").length;
    tel.durationMs = now() - startMs;
    const summary =
      `${status}: ${tel.actions} action(s), ${all.length} finding(s) (${verified} verified, ${all.length - verified} AI-observed). ${why}` +
      (conclusion ? ` Agent's own conclusion (unverified): "${conclusion.slice(0, 300)}"` : "");
    log("finished", { agentId, taskId, status, steps: tel.actions });
    return {
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
  };
  const aborted = (): ExplorationResult => finish(stop === "timeout" ? "TIMEOUT" : "CANCELLED", stop === "timeout" ? `Stopped after ${task.timeoutMs} ms.` : "Cancelled by the dispatcher.");

  /** After a failure: is the device still usable? Uses info(), which also refreshes adapter state. */
  const deviceAlive = async (): Promise<boolean> => {
    try {
      await device.info();
      return device.state() === "ONLINE";
    } catch {
      return false;
    }
  };

  const observe = async (step: number, decision?: AgentDecision, outcome?: ActionOutcome): Promise<{ obs: Observation; deviceError: boolean }> => {
    const errors: string[] = [];
    let deviceError = false;
    const obs: Observation = { step, timestamp: new Date(now()).toISOString(), deviceState: device.state(), app: { ...(packageName ? { packageName } : {}) }, errors, metadata: {} };
    if (decision) obs.recentAction = { action: decision.action.action, reason: decision.reason };
    if (outcome) obs.actionResult = { ok: outcome.ok, detail: outcome.detail };
    const fail = (what: string, e: unknown) => {
      const m = e instanceof Error ? e.message : String(e);
      errors.push(`${what} failed: ${m}`.slice(0, 300));
      if ((e as { name?: string }).name === "DeviceError") deviceError = true;
    };

    if (task.captureScreenshots && evidence.canAddScreenshot()) {
      try {
        const ev = evidence.add("screenshot", (await device.screenshot()).toString("base64"), step);
        if (ev?.id) obs.screenshotRef = ev.id;
      } catch (e) {
        fail("screenshot", e);
      }
    }
    if (typeof device.ui === "function") {
      try {
        const ui = outcome?.ui ?? (await device.ui());
        const s = summarizeUi(ui);
        obs.ui = s.elements;
        obs.uiTruncated = s.truncated;
        if (s.foreground) obs.app.foregroundPackage = s.foreground;
      } catch (e) {
        fail("ui inspection", e);
      }
    }
    try {
      const logs = await device.logs(100);
      const crash = detectCrash(logs);
      if (crash) {
        const logEv = evidence.add("log", crash.excerpt, step);
        const f = findings.addVerified(crash.signature, "CRITICAL", crash.title, `Detected in device logs after step ${step}: ${crash.excerpt.split("\n")[0]}`, [logEv?.id, obs.screenshotRef].filter((x): x is string => !!x), step);
        if (f) {
          errors.push(`CRASH DETECTED (${f.id}): ${crash.title}`);
          log("crash", { agentId, finding: f.id, step });
          await device.clearLogs?.().catch(() => undefined);
        }
      }
      const lines = relevantLogLines(logs);
      if (lines.length > 0) obs.logLines = lines;
    } catch (e) {
      fail("log read", e);
    }
    return { obs, deviceError };
  };

  try {
    log("started", { agentId, taskId, deviceId: deps.deviceId, maxSteps: task.maxSteps });

    let { obs, deviceError } = await observe(0);
    if (deviceError && !(await deviceAlive())) {
      tel.deviceErrors++;
      return finish("BLOCKED", "Device unavailable before the first action.");
    }

    let lastKey = "";
    let repeats = 0;
    for (;;) {
      if (ctrl.signal.aborted) return aborted();
      if (tel.actions >= task.maxSteps) return finish("MAX_STEPS_REACHED", `Step budget of ${task.maxSteps} used.`);

      const warning = repeats >= REPEAT_WARN_AT ? `You have repeated the same action ${repeats} times without progress. Try something different or END_TEST.` : undefined;
      const message = buildUserMessage({
        task,
        observation: obs,
        history,
        findings: findings.all(),
        stepsUsed: tel.actions,
        msRemaining: task.timeoutMs - (now() - startMs),
        available: [...supported],
        ...(warning ? { warning } : {}),
      });
      const budget = deps.ceilings ? { maxLLMCalls: deps.ceilings.maxLLMCalls, maxTokens: deps.ceilings.maxTokens } : undefined;
      const out = await requestDecision({ llm, userMessage: message, limits, signal: ctrl.signal, telemetry: tel, ...(budget ? { budget } : {}) });
      if (!out.ok) {
        if (out.kind === "ABORTED") return aborted();
        if (out.kind === "BUDGET") return finish("BUDGET_EXHAUSTED", out.message);
        if (out.kind === "PROVIDER_ERROR") return finish("ERROR", `LLM provider failed: ${out.message}`);
        return finish("ERROR", `The model returned no valid action after one correction attempt (${out.errors.join("; ")}).`);
      }
      const { decision } = out;

      if (decision.finding) {
        findings.addObservation(decision.finding, obs.screenshotRef ? [obs.screenshotRef] : [], tel.actions);
      }
      if (decision.action.action === "END_TEST") {
        conclusion = decision.reason;
        return finish(hasVerifiedFailure(findings.all()) ? "FAILED" : "PASSED", "The agent ended the test.");
      }

      const key = JSON.stringify(decision.action);
      repeats = key === lastKey ? repeats + 1 : 1;
      lastKey = key;
      if (repeats > REPEAT_STOP_AT) return finish("ERROR", `Stopped: the same action was chosen ${repeats} times in a row.`);

      const step = ++tel.actions;
      log("action", { agentId, step, action: decision.action.action, reason: decision.reason.slice(0, 120) });
      const result = await executor.execute(decision.action, step, ctrl.signal);
      history.push({ step, action: decision.action.action, reason: decision.reason, ok: result.ok, detail: result.detail, evidenceIds: result.evidenceIds });
      if (!result.ok) {
        tel.actionFailures++;
        log("action_failed", { agentId, step, detail: result.detail.slice(0, 120) });
        if (result.deviceError) {
          tel.deviceErrors++;
          if (!(await deviceAlive())) return finish("BLOCKED", `Device became unavailable at step ${step}: ${result.detail}`);
        }
      }
      if (ctrl.signal.aborted) return aborted();

      ({ obs, deviceError } = await observe(step, decision, result));
      if (deviceError) {
        tel.deviceErrors++;
        if (!(await deviceAlive())) return finish("BLOCKED", `Device became unavailable while observing after step ${step}.`);
      }
    }
  } catch (e) {
    if (ctrl.signal.aborted) return aborted();
    return finish("ERROR", `Unexpected failure: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener("abort", onExternalAbort);
  }
}

/** Task handler for MAIN-05-A. The only inputs are the validated task payload, ctx.llm and the leased device. */
export const explorationHandler: TaskHandler = {
  requires: ["launch_app", "stop_app", "tap", "type", "swipe", "press_key", "screenshot", "inspect_ui", "logs"],
  permissions: ["UI_READ", "APP_LAUNCH"],
  async handle(ctx: HandlerContext): Promise<AgentResult> {
    if (!ctx.llm) {
      return { status: "BLOCKED", summary: `${ctx.definition.id}: no LLM provider configured for this agent`, evidence: [] };
    }
    const parsed = parseExplorationTask(ctx.task.payload);
    if (!parsed.ok) {
      return { status: "ERROR", summary: `Invalid exploration task: ${parsed.errors.join("; ")}`, evidence: [] };
    }
    const result = await runExploration({
      taskId: ctx.task.task_id,
      agentId: ctx.definition.id,
      deviceId: ctx.runtime.deviceId,
      device: ctx.device,
      llm: ctx.llm,
      task: parsed.task,
      ...(ctx.profile ? { permissions: new Set(ctx.profile.permissions), ceilings: ctx.profile.limits } : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    return {
      status: toTaskStatus(result.status, hasVerifiedFailure(result.findings)),
      summary: result.summary,
      evidence: result.evidence,
      details: result,
    };
  },
};
