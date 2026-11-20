import { MockDevice, createMockFleet } from "../device/mock-device.js";
import type { AgentResult } from "../agents/types.js";
import { parseExplorationTask } from "../agents/exploration/task.js";
import type { ExplorationResult } from "../agents/exploration/result.js";
import { initializeAgentLab } from "../bootstrap.js";
import { demoScreenshot } from "./demo-png.js";
import { parseCrashHuntTask, type CrashHuntTask } from "../agents/behaviors/crash-hunter.js";
import { parseEdgeCaseTask, type EdgeCaseTask } from "../agents/behaviors/edge-case.js";
import { parseStabilityTask, type StabilityTask } from "../agents/behaviors/stability.js";
import { MockProvider } from "../providers/mock-provider.js";
import { ProviderManager } from "../providers/manager.js";
import type { ProviderConfig } from "../providers/types.js";
import { PROVIDER_PRESETS } from "../providers/presets.js";
import { randomBytes } from "node:crypto";
import type { RunStore, StoredRun } from "../store/run-store.js";
import { renderReportHtml, type ReportLang } from "./report-html.js";
import type { Device } from "../device/types.js";
import { AdbDevice } from "../device/adb-device.js";
import { AdbDiscovery, DeviceDiscovery, DiscoveredDevice } from "../runtime/discovery.js";
import { DeviceManager } from "../runtime/device-manager.js";
import type { DeviceSnapshot } from "../runtime/types.js";

/** An error whose message is safe to show to the user, with an HTTP status. */
export class UiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface ProviderInput {
  kind: "anthropic" | "openai-compatible";
  model: string;
  baseUrl?: string;
  /** Kept in memory only. Never written to disk, never sent back to the browser. */
  apiKey?: string;
}

export interface RunInput {
  mode: "demo" | "real";
  /**
   * "explore" (LLM-driven, default), "crash-hunt" (seeded stress, no LLM; demo or real),
   * "edge-case" (boundary-value and sequence matrix, no LLM; demo or real),
   * "stability" (repeated cold starts and warm resumes: memory leaks and intermittent crashes, no LLM; demo or real) or
   * "smoke" (install, launch, crash check; no LLM; real device only).
   */
  test?: TestKind;
  /** Crash hunt only: same seed, same action sequence. */
  seed?: number;
  /** Smoke only: path of the APK to install. */
  apkPath?: string;
  /** Explore only. Stop once the estimated cost reaches this many USD. Needs both prices. */
  maxCostUsd?: number;
  /** USD per million tokens, as stated by the user (there is no built-in price table). */
  inputPrice?: number;
  outputPrice?: number;
  /** Send each screenshot to the model. */
  vision?: boolean;
  /** Replay the steps behind each crash to see whether it happens again. */
  confirmCrashes?: boolean;
  package?: string;
  objective?: string;
  maxSteps?: number;
  timeoutMs?: number;
  deviceId?: string;
}

interface RunEvent {
  n: number;
  at: string;
  kind: string;
  [k: string]: unknown;
}

interface RunState {
  id: string;
  mode: "demo" | "real";
  test: TestKind;
  status: "running" | "finished" | "error";
  startedAt: string;
  finishedAt?: string;
  params: { package: string; objective: string; maxSteps: number; timeoutMs: number; deviceId: string };
  events: RunEvent[];
  screenshots: Map<string, Buffer>;
  result?: ExplorationResult;
  /** Smoke runs have no ExplorationResult; this is their outcome. */
  smoke?: { status: string; summary: string };
  taskStatus?: string;
  error?: string;
  abort: AbortController;
}

export type TestKind = "explore" | "smoke" | "crash-hunt" | "edge-case" | "stability";
const MAX_EVENTS = 1000;
/** Retention: finished real runs kept in SQLite; older ones are pruned on every save. */
const MAX_STORED_RUNS = 50;
const KEY_NAME = "AGENTLAB_UI_API_KEY";

/** UI logic without HTTP, so it can be tested directly. Holds everything in memory. */
export class UiApp {
  private readonly devices = new DeviceManager();
  private deviceError: string | undefined;
  private secrets = new Map<string, string>();
  private providers: ProviderManager | undefined;
  private providerInfo: { kind: string; model: string; baseUrl?: string; keyPresent: boolean } | undefined;
  private providerTest: { ok: boolean; message: string } | undefined;
  private run: RunState | undefined;

  constructor(private readonly opts: { discovery?: DeviceDiscovery; createDevice?: (d: DiscoveredDevice) => Device; /** adb executable; default "adb" on PATH. */ adbPath?: string; /** Where finished real runs are kept. Without it nothing is saved. */ store?: RunStore } = {}) {}

  // ---- devices -----------------------------------------------------------------------------

  async refreshDevices(): Promise<void> {
    this.deviceError = undefined;
    try {
      // Forget devices that disappeared (unless a run is using them), then add new ones.
      if (this.run?.status !== "running") {
        for (const d of this.devices.snapshot()) {
          if (d.lock === "FREE") {
            if (d.assignedAgentId) this.devices.unassign(d.assignedAgentId);
            this.devices.removeDevice(d.id);
          }
        }
      }
      const adb = this.opts.adbPath ?? "adb";
      const res = await this.devices.discover(this.opts.discovery ?? new AdbDiscovery(adb), this.opts.createDevice ?? ((d) => new AdbDevice(d.serial, adb)));
      // Tell the user why a device that adb can see is not usable.
      if (res.rejected.length > 0) this.deviceError = res.rejected.map((r) => `${r.serial}: ${r.reason}`).join(" | ");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.deviceError = /ENOENT/.test(msg)
        ? "adb not found. Install Android platform-tools and make sure 'adb' is on PATH."
        : `Could not list devices: ${msg}`;
    }
  }

  // ---- provider ----------------------------------------------------------------------------

  setProvider(input: ProviderInput): void {
    if (this.run?.status === "running") throw new UiError(409, "A run is in progress.");
    const model = typeof input.model === "string" ? input.model.trim() : "";
    if (!model) throw new UiError(400, "Model is required.");
    const typed = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
    // Leaving the key field empty keeps the key saved earlier for the same kind of provider.
    const apiKey = typed || (this.providerInfo?.kind === input.kind ? (this.secrets.get(KEY_NAME) ?? "") : "");

    let config: ProviderConfig;
    if (input.kind === "anthropic") {
      if (!apiKey) throw new UiError(400, "An API key is required for Anthropic.");
      config = { id: "ui", kind: "anthropic", model, auth: { type: "api_key", env: KEY_NAME } };
    } else if (input.kind === "openai-compatible") {
      const baseUrl = typeof input.baseUrl === "string" ? input.baseUrl.trim() : "";
      if (!/^https?:\/\//.test(baseUrl)) throw new UiError(400, "Base URL must start with http:// or https://");
      config = { id: "ui", kind: "openai-compatible", model, baseUrl, auth: apiKey ? { type: "api_key", env: KEY_NAME } : { type: "none" } };
    } else {
      throw new UiError(400, "Unknown provider kind.");
    }

    const secrets = new Map<string, string>();
    if (apiKey) secrets.set(KEY_NAME, apiKey);
    try {
      const pm = new ProviderManager({ get: (n) => secrets.get(n) });
      pm.add(config);
      this.providers = pm;
      this.secrets = secrets;
      this.providerInfo = { kind: input.kind, model, ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}), keyPresent: secrets.has(KEY_NAME) };
      this.providerTest = undefined;
    } catch (e) {
      throw new UiError(400, e instanceof Error ? e.message : String(e));
    }
  }

  clearProvider(): void {
    this.providers = undefined;
    this.providerInfo = undefined;
    this.providerTest = undefined;
    this.secrets = new Map();
  }

  async testProvider(): Promise<{ ok: boolean; message: string }> {
    if (!this.providers) throw new UiError(400, "Configure the model first.");
    const r = await this.providers.test("ui");
    this.providerTest = r.ok ? { ok: true, message: `OK (${r.model})` } : { ok: false, message: `${r.code}: ${r.message}` };
    return this.providerTest;
  }

  // ---- runs --------------------------------------------------------------------------------

  startRun(input: RunInput): { id: string } {
    if (this.run?.status === "running") throw new UiError(409, "A run is already in progress.");
    const demo = input.mode === "demo";
    const test: TestKind = input.test === "smoke" || input.test === "crash-hunt" || input.test === "edge-case" || input.test === "stability" ? input.test : "explore";
    if (test === "smoke" && demo) throw new UiError(400, "The smoke test needs a real device.");
    const apkPath = (input.apkPath ?? "").trim();
    if (test === "smoke" && (!apkPath || apkPath.startsWith("-") || !/\.apk$/i.test(apkPath))) throw new UiError(400, "APK path is required and must end in .apk.");
    const pkg = demo ? "com.example.demo" : (input.package ?? "").trim();
    const objective = (input.objective ?? "").trim() || "Explore the application and identify crashes, broken navigation, unresponsive controls and obvious UI problems.";
    if (!demo && !pkg) throw new UiError(400, "Package name is required (e.g. com.example.app).");
    const extra: Record<string, unknown> = {};
    if (!demo && test === "explore") {
      if (input.maxCostUsd !== undefined) extra.maxCostUsd = input.maxCostUsd;
      if (input.inputPrice !== undefined || input.outputPrice !== undefined) extra.pricing = { inputPerMTok: input.inputPrice, outputPerMTok: input.outputPrice };
      if (input.vision === true) extra.vision = true;
      if (input.confirmCrashes === true) extra.confirmCrashes = true;
    }
    const parsed = parseExplorationTask({
      objective,
      app: { packageName: pkg },
      ...(input.maxSteps !== undefined ? { maxSteps: input.maxSteps } : { maxSteps: demo ? 6 : 15 }),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : { timeoutMs: 180_000 }),
      ...extra,
    });
    if (!parsed.ok) throw new UiError(400, parsed.errors.join("; "));
    let hunt: CrashHuntTask | undefined;
    if (test === "crash-hunt") {
      const h = parseCrashHuntTask({
        app: { packageName: pkg },
        maxActions: input.maxSteps ?? (demo ? 15 : 60),
        coldStarts: demo ? 1 : 3,
        timeoutMs: input.timeoutMs ?? 300_000,
        ...(input.seed !== undefined ? { seed: input.seed } : {}),
      });
      if (!h.ok) throw new UiError(400, h.errors.join("; "));
      hunt = h.task;
    }
    let edge: EdgeCaseTask | undefined;
    if (test === "edge-case") {
      const e = parseEdgeCaseTask({
        app: { packageName: pkg },
        maxCases: input.maxSteps ?? (demo ? 12 : 80),
        timeoutMs: input.timeoutMs ?? 600_000,
        // The demo form has two fields; two inputs keep it short. Real runs use the full boundary-value list.
        ...(demo ? { inputs: ["abc", "-1"] } : {}),
      });
      if (!e.ok) throw new UiError(400, e.errors.join("; "));
      edge = e.task;
    }
    let stab: StabilityTask | undefined;
    if (test === "stability") {
      const st = parseStabilityTask({
        app: { packageName: pkg },
        warmCycles: input.maxSteps ?? (demo ? 10 : 20),
        coldCycles: demo ? 5 : 10,
        settleMs: demo ? 200 : 1500,
        timeoutMs: input.timeoutMs ?? 1_200_000,
      });
      if (!st.ok) throw new UiError(400, st.errors.join("; "));
      stab = st.task;
    }

    let rt;
    let deviceId: string;
    if (demo) {
      const fleet = createMockFleet(12);
      if (hunt) {
        demoDevice(fleet[3]!, true);
        rt = initializeAgentLab({ devices: fleet });
        deviceId = "DEVICE-04 (demo)";
      } else if (stab) {
        demoLeak(fleet[3]!);
        rt = initializeAgentLab({ devices: fleet });
        deviceId = "DEVICE-04 (demo)";
      } else if (edge) {
        demoForm(fleet[4]!);
        rt = initializeAgentLab({ devices: fleet });
        deviceId = "DEVICE-05 (demo)";
      } else {
        demoDevice(fleet[4]!);
        rt = initializeAgentLab({ devices: fleet, providers: demoProviders() });
        deviceId = "DEVICE-05 (demo)";
      }
    } else {
      if (!input.deviceId || !this.devices.getDevice(input.deviceId)) throw new UiError(400, "Select a connected device first.");
      if (test === "explore" && !this.providers) throw new UiError(400, "Configure the AI model first.");
      const snap = this.devices.describe(input.deviceId)!;
      if (snap.state !== "ONLINE") throw new UiError(400, `Device ${input.deviceId} is ${snap.state}.`);
      const mainId = test === "smoke" ? "MAIN-01" : test === "crash-hunt" || test === "stability" ? "MAIN-04" : "MAIN-05";
      if (this.devices.getAssignment(mainId)) this.devices.unassign(mainId);
      rt = initializeAgentLab({ devices: [], deviceManager: this.devices, providers: this.providers ?? new ProviderManager(), assignments: { [mainId]: input.deviceId } });
      deviceId = input.deviceId;
    }

    const run: RunState = {
      id: randomBytes(5).toString("hex"),
      mode: input.mode,
      test,
      status: "running",
      startedAt: new Date().toISOString(),
      params: hunt
        ? { package: pkg, objective: `Crash hunt, seed ${hunt.seed}`, maxSteps: hunt.maxActions + hunt.coldStarts * 3 + 4, timeoutMs: hunt.timeoutMs, deviceId }
        : stab
        ? { package: pkg, objective: `Stability: ${stab.coldCycles} cold, ${stab.warmCycles} warm cycle(s)`, maxSteps: stab.coldCycles * 3 + stab.warmCycles * 4 + 4, timeoutMs: stab.timeoutMs, deviceId }
        : edge
        ? { package: pkg, objective: `Edge cases, up to ${edge.maxCases} case(s)`, maxSteps: edge.maxCases * 7 + 3, timeoutMs: edge.timeoutMs, deviceId }
        : { package: pkg, objective, maxSteps: parsed.task.maxSteps, timeoutMs: parsed.task.timeoutMs, deviceId },
      events: [],
      screenshots: new Map(),
      abort: new AbortController(),
    };
    this.run = run;

    rt.bus.subscribe((m) => {
      if (m.type !== "PROGRESS") return;
      const e = m.payload as Record<string, unknown>;
      if (e.kind === "screenshot" && typeof e.id === "string" && typeof e.data === "string") {
        run.screenshots.set(e.id, Buffer.from(e.data, "base64"));
        pushEvent(run, { kind: "screenshot", id: e.id, step: e.step });
      } else {
        const { data: _data, ...rest } = e;
        void _data;
        pushEvent(run, rest as { kind: string });
      }
    });

    void (async () => {
      try {
        if (test === "smoke") {
          const task = await rt.orchestrator.dispatch("MAIN-01", "smoke", { apkPath, packageName: pkg }, { signal: run.abort.signal });
          const res = task.result as AgentResult | undefined;
          run.taskStatus = task.status;
          const shot = res?.evidence.find((e) => e.kind === "screenshot");
          if (shot) {
            run.screenshots.set("EV-001", Buffer.from(shot.data, "base64"));
            pushEvent(run, { kind: "screenshot", id: "EV-001", step: 0 });
          }
          run.smoke = { status: task.status, summary: res?.children?.[0]?.summary ?? res?.summary ?? (task.errors.join("; ") || "No result.") };
          run.status = "finished";
          return;
        }
        const task = hunt
          ? await rt.orchestrator.dispatch("MAIN-04", "crash-hunt", hunt, { signal: run.abort.signal })
          : stab
          ? await rt.orchestrator.dispatch("MAIN-04", "stability", stab, { signal: run.abort.signal })
          : edge
          ? await rt.orchestrator.dispatch("MAIN-05", "edge-case", edge, { signal: run.abort.signal })
          : await rt.orchestrator.dispatch("MAIN-05", "explore", { objective, app: { packageName: pkg }, maxSteps: parsed.task.maxSteps, timeoutMs: parsed.task.timeoutMs, ...extra }, { signal: run.abort.signal });
        const child = (task.result as AgentResult | undefined)?.children?.[0];
        const result = child?.details as ExplorationResult | undefined;
        run.taskStatus = task.status;
        if (result) run.result = result;
        else run.error = child?.summary ?? (task.errors.join("; ") || "No result.");
        run.status = result ? "finished" : "error";
      } catch (e) {
        run.status = "error";
        run.error = e instanceof Error ? e.message : String(e);
      } finally {
        run.finishedAt = new Date().toISOString();
        this.persist(run);
      }
    })();
    return { id: run.id };
  }

  /** Real runs only; a storage failure must never break the UI. */
  private persist(run: RunState): void {
    if (!this.opts.store || run.mode !== "real") return;
    try {
      this.opts.store.save(toStored(run), run.screenshots);
    } catch (e) {
      pushEvent(run, { kind: "storage-error", message: e instanceof Error ? e.message.slice(0, 200) : "save failed" });
    }
    // Retention is a separate concern: the run is already persisted, so a prune failure is not a save failure.
    try {
      this.opts.store.prune(MAX_STORED_RUNS);
    } catch {
      /* the run is safe in the database; the next save will try to prune again */
    }
  }

  /** Newest first. Empty without a store. */
  history(limit = 15) {
    try {
      return this.opts.store?.list(limit) ?? [];
    } catch {
      return [];
    }
  }

  /** HTML report of the current run (`id` omitted or equal to it) or a saved one. */
  reportHtml(id: string | undefined, lang: ReportLang, nonce: string): string | undefined {
    const r = this.run;
    if (r && r.status !== "running" && (id === undefined || id === r.id)) return renderReportHtml(toStored(r), r.screenshots, lang, nonce);
    if (id === undefined || !this.opts.store) return undefined;
    const saved = this.opts.store.get(id);
    return saved ? renderReportHtml(saved, this.opts.store.screenshots(id), lang, nonce) : undefined;
  }

  /** A screenshot of a saved run. */
  savedScreenshot(runId: string, evId: string): Buffer | undefined {
    return this.opts.store?.screenshot(runId, evId);
  }

  cancelRun(): void {
    if (this.run?.status !== "running") throw new UiError(409, "No run in progress.");
    this.run.abort.abort();
  }

  screenshot(id: string): Buffer | undefined {
    return this.run?.screenshots.get(id);
  }

  /** JSON-safe state. Contains no secrets and no image bytes. */
  state(): Record<string, unknown> {
    const r = this.run;
    return {
      devices: { list: this.devices.snapshot().map(slimDevice), error: this.deviceError ?? null },
      presets: PROVIDER_PRESETS.filter((p) => p.kind === "openai-compatible").map((p) => ({ id: p.id, label: p.label, baseUrl: p.baseUrl, exampleModel: p.exampleModel, requiresKey: p.requiresKey })),
      history: this.history(),
      provider: this.providerInfo ? { configured: true, ...this.providerInfo, test: this.providerTest ?? null } : { configured: false },
      run: r
        ? {
            id: r.id,
            mode: r.mode,
            test: r.test,
            status: r.status,
            startedAt: r.startedAt,
            finishedAt: r.finishedAt ?? null,
            params: r.params,
            events: r.events,
            taskStatus: r.taskStatus ?? null,
            error: r.error ?? null,
            result: r.result ? slimResult(r.result) : null,
            smoke: r.smoke ?? null,
          }
        : null,
    };
  }

  report(): Record<string, unknown> | undefined {
    const r = this.run;
    if (r?.smoke) return { run: { id: r.id, mode: r.mode, test: r.test, params: r.params, taskStatus: r.taskStatus }, smoke: r.smoke };
    if (!r?.result) return undefined;
    return { run: { id: r.id, mode: r.mode, test: r.test, params: r.params, taskStatus: r.taskStatus }, result: slimResult(r.result) };
  }
}

function toStored(r: RunState): StoredRun {
  const tel = r.result?.telemetry;
  return {
    id: r.id,
    startedAt: r.startedAt,
    ...(r.finishedAt ? { finishedAt: r.finishedAt } : {}),
    mode: r.mode,
    test: r.test,
    packageName: r.params.package,
    status: r.smoke?.status ?? r.result?.status ?? "ERROR",
    summary: r.smoke?.summary ?? r.result?.summary ?? r.error ?? "",
    ...(tel?.costUsd !== undefined ? { costUsd: tel.costUsd } : {}),
    inputTokens: tel?.inputTokens ?? 0,
    outputTokens: tel?.outputTokens ?? 0,
    params: r.params,
    ...(r.result ? { result: slimResult(r.result) } : {}),
    ...(r.smoke ? { smoke: r.smoke } : {}),
  };
}

function pushEvent(run: RunState, e: { kind: string; [k: string]: unknown }): void {
  if (run.events.length >= MAX_EVENTS) return;
  run.events.push({ n: run.events.length + 1, at: new Date().toISOString(), ...e });
}

function slimDevice(d: DeviceSnapshot) {
  return { id: d.id, source: d.source, state: d.state, lock: d.lock, model: d.model ?? null, androidVersion: d.androidVersion ?? null };
}

/** Screenshot bytes are served separately; other evidence is truncated. */
function slimResult(r: ExplorationResult) {
  return { ...r, evidence: r.evidence.map((e) => (e.kind === "screenshot" ? { id: e.id, kind: e.kind, step: e.step, at: e.at } : { ...e, data: e.data.slice(0, 2000) })) };
}

function demoProviders(): ProviderManager {
  const pm = new ProviderManager();
  pm.register(
    MockProvider.scripted([
      { json: { action: "LAUNCH_APP", reason: "Start the app under test" } },
      { json: { action: "TAP", target: { x: 540, y: 400 }, reason: "Open the main menu" } },
      { json: { action: "SWIPE", from: { x: 540, y: 1400 }, to: { x: 540, y: 600 }, reason: "Scroll the list to see more items" } },
      { json: { action: "BACK", reason: "Check that back navigation works" } },
      { json: { action: "END_TEST", reason: "Demo finished: this is a scripted run, not a real test." } },
    ]),
  );
  return pm;
}

/** `crashButton`: add a "Crash me" button that throws, so the crash-hunt demo has something to find. */
function demoDevice(d: MockDevice, crashButton = false): void {
  d.screenshotFn = () => {
    const taps = d.trace.filter((t) => t.startsWith("tap:"));
    const m = /^tap:(\d+),(\d+)$/.exec(taps[taps.length - 1] ?? "");
    return demoScreenshot(d.trace.length, m ? { x: Number(m[1]), y: Number(m[2]) } : undefined);
  };
  d.setUi([
    { text: "Menu", desc: "", id: "com.example.demo:id/menu", cls: "android.widget.Button", pkg: "com.example.demo", clickable: true, enabled: true, bounds: { l: 440, t: 360, r: 640, b: 440 } },
    { text: "Settings", desc: "", id: "com.example.demo:id/settings", cls: "android.widget.Button", pkg: "com.example.demo", clickable: true, enabled: true, bounds: { l: 440, t: 600, r: 640, b: 680 } },
    ...(crashButton ? [{ text: "Crash me", desc: "", id: "com.example.demo:id/crash", cls: "android.widget.Button", pkg: "com.example.demo", clickable: true, enabled: true, bounds: { l: 440, t: 840, r: 640, b: 920 } }] : []),
  ]);
  if (!crashButton) return;
  const tap = d.tap.bind(d);
  d.tap = async (x, y) => {
    await tap(x, y);
    if (x === 540 && y === 880) {
      d.appendLog("11-20 10:00:00.000  4242  4242 E AndroidRuntime: FATAL EXCEPTION: main");
      d.appendLog("11-20 10:00:00.001  4242  4242 E AndroidRuntime: Process: com.example.demo, PID: 4242");
      d.appendLog("11-20 10:00:00.002  4242  4242 E AndroidRuntime: java.lang.IllegalStateException: demo crash behind the 'Crash me' button");
    }
  };
}

/** Demo for the edge-case test: a form with "Name" and "Age" fields and a Save button; saving with age -1 crashes. */
function demoForm(d: MockDevice): void {
  d.screenshotFn = () => {
    const taps = d.trace.filter((t) => t.startsWith("tap:"));
    const m = /^tap:(\d+),(\d+)$/.exec(taps[taps.length - 1] ?? "");
    return demoScreenshot(d.trace.length, m ? { x: Number(m[1]), y: Number(m[2]) } : undefined);
  };
  const node = (id: string, text: string, cls: string, t: number) => ({ text, desc: "", id: `com.example.demo:id/${id}`, cls, pkg: "com.example.demo", clickable: true, enabled: true, bounds: { l: 340, t, r: 740, b: t + 80 } });
  d.setUi([node("name", "", "android.widget.EditText", 360), node("age", "", "android.widget.EditText", 600), node("save", "Save", "android.widget.Button", 840)]);
  let focused = "";
  let age = "";
  const { tap, type, stop } = { tap: d.tap.bind(d), type: d.type.bind(d), stop: d.stop.bind(d) };
  d.stop = async (p) => {
    await stop(p);
    age = "";
    focused = "";
  };
  d.tap = async (x, y) => {
    await tap(x, y);
    if (y === 640) focused = "age";
    else if (y === 400) focused = "name";
    else if (y === 880 && age === "-1") {
      d.appendLog("11-20 10:00:00.000  4242  4242 E AndroidRuntime: FATAL EXCEPTION: main");
      d.appendLog("11-20 10:00:00.001  4242  4242 E AndroidRuntime: Process: com.example.demo, PID: 4242");
      d.appendLog("11-20 10:00:00.002  4242  4242 E AndroidRuntime: java.lang.IllegalArgumentException: age must not be negative (demo)");
    }
  };
  d.type = async (t) => {
    await type(t);
    if (focused === "age") age += t;
  };
}

/** Demo for the stability test: memory grows 6 MB per resume while the process lives; the 4th launch crashes once. */
function demoLeak(d: MockDevice): void {
  demoDevice(d);
  let resumes = 0;
  let launches = 0;
  d.memoryFn = () => 80_000 + resumes * 6 * 1024;
  const { launch, stop } = { launch: d.launch.bind(d), stop: d.stop.bind(d) };
  d.stop = async (p) => {
    await stop(p);
    resumes = 0;
  };
  d.launch = async (p, a) => {
    const wasRunning = d.isRunning(p);
    await launch(p, a);
    if (wasRunning) resumes++;
    if (++launches === 4) {
      d.appendLog("11-20 10:00:00.000  4242  4242 E AndroidRuntime: FATAL EXCEPTION: main");
      d.appendLog("11-20 10:00:00.001  4242  4242 E AndroidRuntime: Process: com.example.demo, PID: 4242");
      d.appendLog("11-20 10:00:00.002  4242  4242 E AndroidRuntime: java.lang.IllegalStateException: cache not ready (demo, happens on one launch only)");
    }
  };
}
