import { MockDevice, createMockFleet } from "../device/mock-device.js";
import type { AgentResult } from "../agents/types.js";
import { parseExplorationTask } from "../agents/exploration/task.js";
import type { ExplorationResult } from "../agents/exploration/result.js";
import { initializeAgentLab } from "../bootstrap.js";
import { demoScreenshot } from "./demo-png.js";
import { MockProvider } from "../providers/mock-provider.js";
import { ProviderManager } from "../providers/manager.js";
import type { ProviderConfig } from "../providers/types.js";
import { AdbDiscovery, DeviceDiscovery } from "../runtime/discovery.js";
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
  status: "running" | "finished" | "error";
  startedAt: string;
  finishedAt?: string;
  params: { package: string; objective: string; maxSteps: number; timeoutMs: number; deviceId: string };
  events: RunEvent[];
  screenshots: Map<string, Buffer>;
  result?: ExplorationResult;
  taskStatus?: string;
  error?: string;
  abort: AbortController;
}

const MAX_EVENTS = 1000;
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

  constructor(private readonly opts: { discovery?: DeviceDiscovery } = {}) {}

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
      await this.devices.discover(this.opts.discovery ?? new AdbDiscovery());
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
    const pkg = demo ? "com.example.demo" : (input.package ?? "").trim();
    const objective = (input.objective ?? "").trim() || "Explore the application and identify crashes, broken navigation, unresponsive controls and obvious UI problems.";
    if (!demo && !pkg) throw new UiError(400, "Package name is required (e.g. com.example.app).");
    const parsed = parseExplorationTask({
      objective,
      app: { packageName: pkg },
      ...(input.maxSteps !== undefined ? { maxSteps: input.maxSteps } : { maxSteps: demo ? 6 : 15 }),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : { timeoutMs: 180_000 }),
    });
    if (!parsed.ok) throw new UiError(400, parsed.errors.join("; "));

    let rt;
    let deviceId: string;
    if (demo) {
      const fleet = createMockFleet(12);
      demoDevice(fleet[4]!);
      rt = initializeAgentLab({ devices: fleet, providers: demoProviders() });
      deviceId = "DEVICE-05 (demo)";
    } else {
      if (!input.deviceId || !this.devices.getDevice(input.deviceId)) throw new UiError(400, "Select a connected device first.");
      if (!this.providers) throw new UiError(400, "Configure the AI model first.");
      const snap = this.devices.describe(input.deviceId)!;
      if (snap.state !== "ONLINE") throw new UiError(400, `Device ${input.deviceId} is ${snap.state}.`);
      if (this.devices.getAssignment("MAIN-05")) this.devices.unassign("MAIN-05");
      rt = initializeAgentLab({ devices: [], deviceManager: this.devices, providers: this.providers, assignments: { "MAIN-05": input.deviceId } });
      deviceId = input.deviceId;
    }

    const run: RunState = {
      id: Math.random().toString(36).slice(2, 10),
      mode: input.mode,
      status: "running",
      startedAt: new Date().toISOString(),
      params: { package: pkg, objective, maxSteps: parsed.task.maxSteps, timeoutMs: parsed.task.timeoutMs, deviceId },
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
        const task = await rt.orchestrator.dispatch("MAIN-05", "explore", { objective, app: { packageName: pkg }, maxSteps: parsed.task.maxSteps, timeoutMs: parsed.task.timeoutMs }, { signal: run.abort.signal });
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
      }
    })();
    return { id: run.id };
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
      provider: this.providerInfo ? { configured: true, ...this.providerInfo, test: this.providerTest ?? null } : { configured: false },
      run: r
        ? {
            id: r.id,
            mode: r.mode,
            status: r.status,
            startedAt: r.startedAt,
            finishedAt: r.finishedAt ?? null,
            params: r.params,
            events: r.events,
            taskStatus: r.taskStatus ?? null,
            error: r.error ?? null,
            result: r.result ? slimResult(r.result) : null,
          }
        : null,
    };
  }

  report(): Record<string, unknown> | undefined {
    const r = this.run;
    if (!r?.result) return undefined;
    return { run: { id: r.id, mode: r.mode, params: r.params, taskStatus: r.taskStatus }, result: slimResult(r.result) };
  }
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

function demoDevice(d: MockDevice): void {
  d.screenshotFn = () => {
    const taps = d.trace.filter((t) => t.startsWith("tap:"));
    const m = /^tap:(\d+),(\d+)$/.exec(taps[taps.length - 1] ?? "");
    return demoScreenshot(d.trace.length, m ? { x: Number(m[1]), y: Number(m[2]) } : undefined);
  };
  d.setUi([
    { text: "Menu", desc: "", id: "com.example.demo:id/menu", cls: "android.widget.Button", pkg: "com.example.demo", clickable: true, enabled: true, bounds: { l: 440, t: 360, r: 640, b: 440 } },
    { text: "Settings", desc: "", id: "com.example.demo:id/settings", cls: "android.widget.Button", pkg: "com.example.demo", clickable: true, enabled: true, bounds: { l: 440, t: 600, r: 640, b: 680 } },
  ]);
}
