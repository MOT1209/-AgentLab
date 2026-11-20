import type { Device, UiNode } from "../../device/types.js";
import { actionAllowed, type Permission } from "../../skills/permissions.js";
import { ActionExecutor, type ActionOutcome } from "../exploration/action-executor.js";
import type { ActionName, AgentAction } from "../exploration/actions.js";
import { confirmCrashReplays, reproStepsFrom } from "../exploration/crash-confirm.js";
import { createFileEvidenceWriter, writeResultFile } from "../exploration/evidence-files.js";
import { EvidenceStore } from "../exploration/evidence.js";
import { detectCrash, FindingLog, hasVerifiedFailure, type Finding } from "../exploration/findings.js";
import { summarizeUi, type UiElement } from "../exploration/observation.js";
import type { ActionRecord, ExplorationResult, ExplorationStatus, ExplorationTelemetry } from "../exploration/result.js";
import { sensitiveTerm } from "../exploration/sensitive-actions.js";

/**
 * Shared machinery for the deterministic (no-LLM) device agents: Crash Hunter (MAIN-04-A) and
 * Edge Case Agent (MAIN-05-B). One session = one run against one app: it executes and records actions,
 * checks the log after each one, turns crashes into VERIFIED findings with evidence and repro steps,
 * handles timeout/cancel/device loss, replays crashes at the end and builds the result.
 */

export const DEFAULT_SCREEN = { width: 1080, height: 1920 };
export const HARD_MAX_TIMEOUT_MS = 1_800_000;

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

export const PKG = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export const isTextField = (e: UiElement): boolean => /EditText|TextInput|AutoComplete|SearchView/i.test(e.cls ?? "");
export const labelOf = (e: UiElement): string => e.text ?? e.desc ?? e.id ?? `${e.x},${e.y}`;

export interface AppTarget {
  packageName: string;
  launchActivity?: string;
}

/** Options every deterministic task shares, parsed the same way everywhere. */
export interface CommonTaskOptions {
  app: AppTarget;
  timeoutMs: number;
  evidenceDir?: string;
  /** Used for coordinate taps and swipes when the screen exposes no UI hierarchy. */
  screen?: { width: number; height: number };
  /** Replay the steps behind each crash once. On by default. */
  confirmCrashes: boolean;
  /** Allow taps on controls that read as buy/pay/subscribe/delete account/factory reset/uninstall. Off by default. */
  allowSensitiveActions: boolean;
}

/** Validates an integer field, recording an error and returning the default when it is out of range. */
export function intField(errors: string[], v: unknown, name: string, def: number, min: number, max: number): number {
  if (v === undefined) return def;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    errors.push(`${name} must be an integer in ${min}..${max}`);
    return def;
  }
  return v;
}

/** Parses app, timeoutMs, evidenceDir, screen, confirmCrashes, allowSensitiveActions. Undefined when `app` is invalid. */
export function parseCommon(payload: Record<string, unknown>, errors: string[], defaultTimeoutMs: number): CommonTaskOptions | undefined {
  let app: AppTarget | undefined;
  const a = payload.app;
  if (!isObj(a) || typeof a.packageName !== "string" || !PKG.test(a.packageName)) errors.push("app.packageName is required and must be a valid package name");
  else {
    app = { packageName: a.packageName };
    if (a.launchActivity !== undefined) {
      if (typeof a.launchActivity === "string" && /^[A-Za-z0-9_.$/]{1,200}$/.test(a.launchActivity)) app.launchActivity = a.launchActivity;
      else errors.push("app.launchActivity must be an activity name like .MainActivity");
    }
  }
  const timeoutMs = intField(errors, payload.timeoutMs, "timeoutMs", defaultTimeoutMs, 1, HARD_MAX_TIMEOUT_MS);
  let evidenceDir: string | undefined;
  if (payload.evidenceDir !== undefined) {
    const d = payload.evidenceDir;
    if (typeof d === "string" && d.length > 0 && d.length < 500 && !d.includes("\0") && (d.startsWith("/") || /^[A-Za-z]:[\\/]/.test(d))) evidenceDir = d;
    else errors.push("evidenceDir must be an absolute path");
  }
  let screen: CommonTaskOptions["screen"];
  if (payload.screen !== undefined) {
    const s = payload.screen;
    if (isObj(s) && Number.isInteger(s.width) && Number.isInteger(s.height) && (s.width as number) > 0 && (s.height as number) > 0) screen = { width: s.width as number, height: s.height as number };
    else errors.push("screen must be {width, height} positive integers");
  }
  for (const k of ["confirmCrashes", "allowSensitiveActions"] as const) if (payload[k] !== undefined && typeof payload[k] !== "boolean") errors.push(`${k} must be a boolean`);
  if (!app) return undefined;
  return { app, timeoutMs, ...(evidenceDir ? { evidenceDir } : {}), ...(screen ? { screen } : {}), confirmCrashes: payload.confirmCrashes !== false, allowSensitiveActions: payload.allowSensitiveActions === true };
}

export interface SessionDeps {
  taskId: string;
  agentId: string;
  deviceId?: string;
  device: Device;
  options: CommonTaskOptions;
  permissions?: ReadonlySet<Permission>;
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  onProgress?: (event: Record<string, unknown>) => void;
}

export interface Screen {
  elements: UiElement[];
  foreground?: string;
  size: { width: number; height: number };
}

/** What a run's summary is built from. */
export interface SummaryFacts {
  status: ExplorationStatus;
  why: string;
  actions: number;
  /** Distinct crash findings. */
  crashes: number;
  /** Crash occurrences beyond the first of each kind. */
  repeats: number;
  sensitiveSkipped: number;
  /** Sentence from crash replay, or "". */
  confirmNote: string;
}

class DeviceLost extends Error {}
class Stopped extends Error {}

export class DeterministicSession {
  readonly device: Device;
  readonly pkg: string;
  readonly opts: CommonTaskOptions;
  readonly evidence: EvidenceStore;
  readonly findings: FindingLog;
  readonly history: ActionRecord[] = [];
  readonly tel: ExplorationTelemetry = { llmCalls: 0, actions: 0, actionFailures: 0, providerErrors: 0, deviceErrors: 0, malformedResponses: 0, inputTokens: 0, outputTokens: 0, durationMs: 0 };
  readonly sensitiveSkipped = new Set<string>();
  readonly canSwipe: boolean;
  readonly canKey: boolean;
  readonly canUi: boolean;
  /** First step of the current segment; a crash's repro steps and replay start here. */
  segmentStart = 1;
  private readonly segmentOf = new Map<string, number>();
  private readonly occurrences = new Map<string, number>();
  private readonly findingOfKey = new Map<string, string>();
  /** The most recent crash: its finding (the first one of that kind) and the step it was seen after. */
  lastCrash: { findingId?: string; step: number } | undefined;
  private readonly executor: ActionExecutor;
  private readonly ctrl = new AbortController();
  private stop: "timeout" | "cancelled" | undefined;
  private readonly now: () => number;
  private readonly startMs: number;

  constructor(private readonly deps: SessionDeps) {
    this.device = deps.device;
    this.opts = deps.options;
    this.pkg = deps.options.app.packageName;
    this.now = deps.now ?? Date.now;
    this.startMs = this.now();
    this.evidence = new EvidenceStore(deps.agentId, undefined, this.now);
    if (this.opts.evidenceDir) this.evidence.persist = createFileEvidenceWriter(this.opts.evidenceDir, deps.taskId);
    this.findings = new FindingLog(deps.agentId, this.now);
    const la = this.opts.app.launchActivity;
    this.executor = new ActionExecutor(this.device, { evidence: this.evidence, packageName: this.pkg, ...(la ? { launchActivity: la } : {}), ...(deps.sleep ? { sleep: deps.sleep } : {}) });
    this.canSwipe = typeof this.device.swipe === "function" && this.allowed("SWIPE");
    this.canKey = typeof this.device.pressKey === "function" && this.allowed("BACK");
    this.canUi = typeof this.device.ui === "function" && this.allowed("GET_UI");
    this.evidence.onAdd = (ev) => {
      if (ev.kind === "screenshot") this.emit({ kind: "screenshot", id: ev.id, step: ev.step, data: ev.data });
    };
  }

  allowed(a: ActionName): boolean {
    return !this.deps.permissions || actionAllowed(a, this.deps.permissions);
  }

  emit(event: Record<string, unknown>): void {
    try {
      this.deps.onProgress?.(event);
    } catch {
      /* a listener must never break a run */
    }
  }

  /** Total crash occurrences so far, including repeats; compare before and after a case to see whether it crashed. */
  get crashCount(): number {
    return [...this.occurrences.values()].reduce((n, c) => n + c, 0);
  }

  /** Starts a new segment: crashes found from here on are reproduced from this step. */
  startSegment(): void {
    this.segmentStart = this.tel.actions + 1;
  }

  async deviceAlive(): Promise<boolean> {
    try {
      await this.device.info();
      return this.device.state() === "ONLINE";
    } catch {
      return false;
    }
  }

  async screenshot(step: number): Promise<string | undefined> {
    if (!this.evidence.canAddScreenshot() || !this.allowed("SCREENSHOT")) return undefined;
    try {
      return this.evidence.add("screenshot", (await this.device.screenshot()).toString("base64"), step)?.id;
    } catch {
      return undefined;
    }
  }

  /** True (and recorded as skipped) when the element reads as a paid or destructive control and those are not allowed. */
  isSensitive(e: UiElement): boolean {
    if (this.opts.allowSensitiveActions) return false;
    if (sensitiveTerm(e.text) ?? sensitiveTerm(e.desc) ?? sensitiveTerm(e.id)) {
      this.sensitiveSkipped.add(labelOf(e));
      return true;
    }
    return false;
  }

  /**
   * Reads the log after a step. A crash becomes a VERIFIED finding (once per title+exception+process);
   * `context` is appended to its description. The app is then relaunched in a fresh segment.
   */
  async checkForCrash(step: number, context?: string): Promise<Finding | boolean> {
    let logs: string;
    try {
      logs = await this.device.logs(100);
    } catch {
      return false;
    }
    const crash = detectCrash(logs, this.pkg);
    if (!crash) return false;
    const key = `${crash.title}|${crash.exception ?? ""}|${crash.process ?? ""}`;
    this.occurrences.set(key, (this.occurrences.get(key) ?? 0) + 1);
    const logEv = this.evidence.add("log", crash.excerpt, step);
    const shot = await this.screenshot(step);
    const description = `Detected in device logs after step ${step}${crash.process ? ` (process ${crash.process})` : ""}${crash.exception ? `, ${crash.exception}` : ""}${context ? `, ${context}` : ""}: ${crash.excerpt.split("\n")[0]}`;
    const f = this.findings.addVerified(key, crash.severity, crash.title, description, [logEv?.id, shot].filter((x): x is string => !!x), step);
    if (f) this.findingOfKey.set(key, f.id);
    const fid = this.findingOfKey.get(key);
    this.lastCrash = { ...(fid ? { findingId: fid } : {}), step };
    if (f) {
      this.segmentOf.set(f.id, this.segmentStart);
      this.findings.annotate(f.id, { reproSteps: reproStepsFrom(this.history.filter((h) => h.step >= this.segmentStart)) });
      this.emit({ kind: "finding", id: f.id, severity: f.severity, title: f.title, source: f.source });
    }
    await this.device.clearLogs?.().catch(() => undefined);
    this.startSegment();
    await this.act({ action: "STOP_APP" }, "recover after crash", false);
    await this.act({ action: "LAUNCH_APP" }, "recover after crash", false);
    return f ?? true;
  }

  /** Context added to a crash's description by `act`, e.g. which field and input the case was testing. */
  crashContext: string | undefined;

  /** Executes one action, records it, and (unless told not to) checks the log for a crash. */
  async act(action: AgentAction, reason: string, check = true): Promise<ActionOutcome> {
    if (this.ctrl.signal.aborted) throw new Stopped();
    const step = ++this.tel.actions;
    const result = await this.executor.execute(action, step, this.ctrl.signal);
    this.history.push({ step, action: action.action, params: action as unknown as Record<string, unknown>, reason, ok: result.ok, detail: result.detail, ...(result.errorCode ? { errorCode: result.errorCode } : {}), evidenceIds: result.evidenceIds });
    this.emit({ kind: "action", step, action: action.action, params: action, reason, ok: result.ok, detail: result.detail, ...(result.errorCode ? { errorCode: result.errorCode } : {}) });
    if (!result.ok) {
      this.tel.actionFailures++;
      if (result.deviceError) {
        this.tel.deviceErrors++;
        if (!(await this.deviceAlive())) throw new DeviceLost(`Device became unavailable at step ${step}: ${result.detail}`);
      }
    }
    if (this.ctrl.signal.aborted) throw new Stopped();
    if (check) await this.checkForCrash(step, this.crashContext);
    return result;
  }

  async readScreen(): Promise<Screen> {
    let nodes: UiNode[] = [];
    if (this.canUi) {
      try {
        nodes = await this.device.ui!();
      } catch {
        nodes = [];
      }
    }
    const s = summarizeUi(nodes);
    const maxR = Math.max(0, ...nodes.map((n) => n.bounds.r));
    const maxB = Math.max(0, ...nodes.map((n) => n.bounds.b));
    const size = this.opts.screen ?? (maxR > 0 && maxB > 0 ? { width: maxR, height: maxB } : DEFAULT_SCREEN);
    return { elements: s.elements, ...(s.foreground ? { foreground: s.foreground } : {}), size };
  }

  /**
   * Runs `body` with timeout, cancellation and device-loss handling. Never throws.
   * `body` returns the closing reason; the status is FAILED when a verified crash was found, else PASSED.
   */
  async run(
    startedEvent: Record<string, unknown>,
    body: () => Promise<string>,
    summarize: (facts: SummaryFacts) => string,
    extra?: () => Record<string, unknown>,
  ): Promise<ExplorationResult> {
    const { signal } = this.deps;
    const timer = setTimeout(() => {
      this.stop ??= "timeout";
      this.ctrl.abort();
    }, this.opts.timeoutMs);
    const onExternalAbort = () => {
      this.stop ??= "cancelled";
      this.ctrl.abort();
    };
    if (signal?.aborted) onExternalAbort();
    else signal?.addEventListener("abort", onExternalAbort, { once: true });
    const finish = (status: ExplorationStatus, why: string) => this.finish(status, why, summarize, extra);
    try {
      this.emit({ kind: "started", ...startedEvent });
      if (!(await this.deviceAlive())) {
        this.tel.deviceErrors++;
        return await finish("BLOCKED", "Device unavailable before the first action.");
      }
      await this.device.clearLogs?.().catch(() => undefined);
      await this.screenshot(0);
      const why = await body();
      return await finish(hasVerifiedFailure(this.findings.all()) ? "FAILED" : "PASSED", why);
    } catch (e) {
      if (e instanceof DeviceLost) return await finish("BLOCKED", e.message);
      if (e instanceof Stopped || this.ctrl.signal.aborted) return await finish(this.stop === "timeout" ? "TIMEOUT" : "CANCELLED", this.stop === "timeout" ? `Stopped after ${this.opts.timeoutMs} ms.` : "Cancelled by the dispatcher.");
      return await finish("ERROR", `Unexpected failure: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onExternalAbort);
    }
  }

  private async finish(status: ExplorationStatus, why: string, summarize: (facts: SummaryFacts) => string, extra?: () => Record<string, unknown>): Promise<ExplorationResult> {
    const { device, pkg, findings, now } = this;
    let confirmNote: string | undefined;
    if (this.opts.confirmCrashes && ["PASSED", "FAILED", "MAX_STEPS_REACHED"].includes(status) && (await this.deviceAlive())) {
      const la = this.opts.app.launchActivity;
      confirmNote = await confirmCrashReplays({ device, agentId: this.deps.agentId, packageName: pkg, ...(la ? { launchActivity: la } : {}), findings, history: this.history, ...(this.deps.signal ? { signal: this.deps.signal } : {}), now, ...(this.deps.sleep ? { sleep: this.deps.sleep } : {}), emit: (e) => this.emit(e), startStepOf: (f: Finding) => this.segmentOf.get(f.id) ?? 0 });
    }
    await device.stop(pkg).catch(() => undefined);
    const all = findings.all();
    this.tel.durationMs = now() - this.startMs;
    const summary = summarize({ status, why, actions: this.tel.actions, crashes: all.length, repeats: this.crashCount - all.length, sensitiveSkipped: this.sensitiveSkipped.size, confirmNote: confirmNote ?? "" });
    this.emit({ kind: "finished", status });
    const { taskId, agentId, deviceId } = this.deps;
    const result: ExplorationResult = {
      ...(this.opts.evidenceDir ? { evidenceDir: this.opts.evidenceDir } : {}),
      status,
      taskId,
      agentId,
      ...(deviceId ? { deviceId } : {}),
      steps: this.tel.actions,
      findings: all,
      evidence: this.evidence.list(),
      actionLog: [...this.history],
      telemetry: { ...this.tel },
      startedAt: new Date(this.startMs).toISOString(),
      completedAt: new Date(now()).toISOString(),
      summary,
      ...(extra ? extra() : {}),
    };
    if (this.opts.evidenceDir) writeResultFile(this.opts.evidenceDir, taskId, result as unknown as { evidence: typeof result.evidence } & Record<string, unknown>);
    return result;
  }
}
