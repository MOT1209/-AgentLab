import { AdbDevice } from "../../src/device/adb-device.js";
import { initializeAgentLab } from "../../src/bootstrap.js";
import type { AgentResult } from "../../src/agents/types.js";
import type { ExplorationResult } from "../../src/agents/exploration/result.js";
import { ProviderManager } from "../../src/providers/manager.js";
import type { LlmProvider } from "../../src/providers/types.js";
import { AdbDiscovery } from "../../src/runtime/discovery.js";
import { DeviceManager, DiscoveryResult } from "../../src/runtime/device-manager.js";
import type { DeviceHealth } from "../../src/runtime/health.js";
import type { DeviceSnapshot } from "../../src/runtime/types.js";
import type { Task } from "../../src/agents/types.js";

export interface ScenarioOptions {
  /** Path of the adb binary. Real runs use "adb"; the simulated test points at a fake script. */
  adbPath: string;
  packageName: string;
  llm: LlmProvider;
  evidenceDir: string;
  serial?: string;
  activity?: string;
  /** Option A: install this APK first. Option B (omitted): the app is already on the device. */
  apkPath?: string;
  maxSteps?: number;
  maxLlmCalls?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ScenarioReport {
  discovery: DiscoveryResult;
  device?: DeviceSnapshot;
  health?: DeviceHealth;
  assignedTo?: string;
  task?: Task;
  exploration?: ExplorationResult;
  during?: DeviceSnapshot;
  after?: DeviceSnapshot;
  availableAgain: boolean;
}

/**
 * discovery -> health -> registry -> pool -> lease -> MAIN-05-A -> LLM -> safe actions -> evidence -> release.
 * Used by both the opt-in real-device test and the simulated-adb test, so they exercise the same path.
 */
export async function runDeviceScenario(o: ScenarioOptions): Promise<ScenarioReport> {
  const devices = new DeviceManager();
  const discovery = await devices.discover(new AdbDiscovery(o.adbPath), (d) => new AdbDevice(d.serial, o.adbPath));
  const device = discovery.added.find((d) => (o.serial ? d.id === o.serial : true));
  if (!device) return { discovery, availableAgain: false };

  const health = await devices.deepHealth(device.id);
  if (o.apkPath) await devices.getDevice(device.id)!.install(o.apkPath);

  const providers = new ProviderManager();
  providers.register(o.llm);
  const rt = initializeAgentLab({ devices: [], deviceManager: devices, providers, assignments: { "MAIN-05": device.id } });

  let during: DeviceSnapshot | undefined;
  const unsub = rt.bus.subscribe((m) => {
    if (m.type === "PROGRESS" && !during) during = devices.describe(device.id);
  });
  const task = await rt.orchestrator.dispatch(
    "MAIN-05",
    "explore",
    {
      objective: "Launch the app, read the screen and logs, and perform a few safe actions.",
      app: { packageName: o.packageName, ...(o.activity ? { launchActivity: o.activity } : {}) },
      maxSteps: o.maxSteps ?? 8,
      ...(o.maxLlmCalls ? { maxLlmCalls: o.maxLlmCalls } : {}),
      timeoutMs: o.timeoutMs ?? 120_000,
      evidenceDir: o.evidenceDir,
    },
    o.signal ? { signal: o.signal } : {},
  );
  unsub();
  const exploration = (task.result as AgentResult | undefined)?.children?.[0]?.details as ExplorationResult | undefined;
  const after = devices.describe(device.id);
  const report: ScenarioReport = {
    discovery,
    device,
    task,
    availableAgain: devices.pool.free().some((d) => d.id === device.id),
  };
  const assignedTo = devices.registry.get(device.id)?.assignedAgentId;
  if (assignedTo) report.assignedTo = assignedTo;
  if (health) report.health = health;
  if (exploration) report.exploration = exploration;
  if (during) report.during = during;
  if (after) report.after = after;
  return report;
}
