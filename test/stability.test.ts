import { test } from "node:test";
import assert from "node:assert/strict";
import { MockDevice, createMockFleet } from "../src/device/mock-device.js";
import { AdbDevice, parseMeminfo } from "../src/device/adb-device.js";
import { initializeAgentLab } from "../src/bootstrap.js";
import type { AgentResult } from "../src/agents/types.js";
import { analyzeMemory, parseStabilityTask, runStability, type StabilityMetrics, type StabilityTask } from "../src/agents/behaviors/stability.js";
import { createFakeAdb, FAKE_ADB_SKIP, FAKE_SERIAL } from "./support/fake-adb.js";

const PKG = "com.example.app";
const FATAL = [
  "11-20 10:00:00.000  100  100 E AndroidRuntime: FATAL EXCEPTION: main",
  `11-20 10:00:00.001  100  100 E AndroidRuntime: Process: ${PKG}, PID: 100`,
  "11-20 10:00:00.002  100  100 E AndroidRuntime: java.lang.IllegalStateException: flaky",
];

/** Memory grows by `leakKb` per resume while the process lives; a stop resets it. Optional crash on given launch numbers. */
class App extends MockDevice {
  launches = 0;
  resumes = 0;
  constructor(readonly leakKb = 0, readonly crashOnLaunch: number[] = []) {
    super("app");
    this.memoryFn = () => 80_000 + this.resumes * this.leakKb;
  }
  override async stop(pkg: string): Promise<void> {
    await super.stop(pkg);
    this.resumes = 0;
  }
  override async launch(pkg: string, a?: string): Promise<void> {
    const wasRunning = this.isRunning(pkg);
    await super.launch(pkg, a);
    this.launches++;
    if (wasRunning) this.resumes++;
    if (this.crashOnLaunch.includes(this.launches)) for (const l of FATAL) this.appendLog(l);
  }
}

const base = (extra: Partial<StabilityTask> = {}): StabilityTask => ({ app: { packageName: PKG }, timeoutMs: 60_000, confirmCrashes: false, allowSensitiveActions: false, coldCycles: 3, warmCycles: 10, settleMs: 10, memoryGrowthPct: 25, memoryGrowthMb: 15, ...extra });
const noSleep = async () => undefined;
const run = (device: MockDevice, extra: Partial<StabilityTask> = {}, more: Record<string, unknown> = {}) => runStability({ taskId: "T-1", agentId: "MAIN-04-B", device, task: base(extra), sleep: noSleep, ...more });

test("parseStabilityTask validates and fills defaults (replay off by default)", () => {
  assert.equal(parseStabilityTask({}).ok, false);
  assert.equal(parseStabilityTask({ app: { packageName: PKG }, coldCycles: 0, warmCycles: 0 }).ok, false);
  assert.equal(parseStabilityTask({ app: { packageName: PKG }, warmCycles: 101 }).ok, false);
  assert.equal(parseStabilityTask({ app: { packageName: PKG }, settleMs: -1 }).ok, false);
  const ok = parseStabilityTask({ app: { packageName: PKG } });
  assert.ok(ok.ok);
  if (ok.ok) assert.deepEqual([ok.task.coldCycles, ok.task.warmCycles, ok.task.settleMs, ok.task.confirmCrashes, ok.task.memoryGrowthPct, ok.task.memoryGrowthMb], [10, 20, 1500, false, 25, 15]);
  const on = parseStabilityTask({ app: { packageName: PKG }, confirmCrashes: true });
  assert.ok(on.ok && on.task.confirmCrashes);
});

test("parseMeminfo reads both dumpsys formats and a missing process", () => {
  assert.equal(parseMeminfo("Applications Memory Usage (in Kilobytes):\n...\n           TOTAL PSS:   123456            TOTAL RSS:   200000       TOTAL SWAP PSS:      12"), 123456);
  assert.equal(parseMeminfo("** MEMINFO in pid 123 [com.x] **\n                   Pss  Private\n        TOTAL    98765    80000    1000\n"), 98765);
  assert.equal(parseMeminfo("No process found for: com.x"), undefined);
  assert.equal(parseMeminfo("garbage"), undefined);
});

test("analyzeMemory: growth, flat, one spike, too few samples, longest series wins", () => {
  const series = (xs: number[], run = 0) => xs.map((kb) => ({ run, kb }));
  const grow = analyzeMemory(series([80_000, 86_000, 92_000, 98_000, 104_000, 110_000, 116_000]), 25, 15);
  assert.equal(grow.verdict, "GROWS");
  assert.ok(grow.slopeKb! > 5000);
  assert.equal(analyzeMemory(series([80_000, 80_500, 79_800, 80_200, 80_100, 80_300]), 25, 15).verdict, "STABLE");
  assert.equal(analyzeMemory(series([80_000, 80_000, 80_000, 200_000, 80_000, 80_000, 80_000]), 25, 15).verdict, "STABLE", "one spike is noise");
  assert.equal(analyzeMemory(series([80_000, 120_000, 160_000]), 25, 15).verdict, "INSUFFICIENT");
  const split = analyzeMemory([...series([80_000, 200_000, 300_000], 0), ...series([80_000, 80_000, 80_100, 80_000, 80_200, 80_000], 1)], 25, 15);
  assert.equal(split.verdict, "STABLE");
  assert.equal(split.samples, 6);
  assert.equal(analyzeMemory(series([100_000, 101_000, 102_000, 103_000, 104_000, 105_000]), 1, 15).verdict, "STABLE", "+5 MB is under the MB threshold");
});

test("a leak across warm resumes is a VERIFIED MEDIUM finding with the series as evidence", async () => {
  const r = await run(new App(6 * 1024));
  assert.equal(r.status, "FAILED");
  const f = r.findings.find((x) => x.title.startsWith("Memory grows"))!;
  assert.equal(f.source, "VERIFIED");
  assert.equal(f.severity, "MEDIUM");
  assert.match(f.description, /over 10 resumes/);
  assert.ok(r.evidence.some((e) => f.evidenceIds.includes(e.id!) && e.data.startsWith("PSS per warm resume")));
  assert.equal(r.metrics.memory.verdict, "GROWS");
  assert.equal(r.metrics.cycles.length, 13);
  assert.deepEqual(r.metrics.cycles.map((c) => c.kind), [...Array(3).fill("cold"), ...Array(10).fill("warm")]);
  assert.ok(r.metrics.launch && r.metrics.launch.medianMs >= 0);
  assert.equal(r.telemetry.llmCalls, 0);
});

test("stable memory and no crashes: PASSED", async () => {
  const r = await run(new App(0));
  assert.equal(r.status, "PASSED");
  assert.equal(r.findings.length, 0);
  assert.equal(r.metrics.memory.verdict, "STABLE");
  assert.match(r.summary, /Memory stable over 10 resumes/);
});

test("an intermittent crash is reported with its rate", async () => {
  const r = await run(new App(0, [2]), { coldCycles: 10, warmCycles: 0 });
  assert.equal(r.status, "FAILED");
  assert.equal(r.findings.length, 1);
  assert.deepEqual(r.metrics.crashRates, [{ findingId: r.findings[0]!.id, occurrences: 1, cycles: 10 }]);
  assert.equal(r.metrics.cycles.filter((c) => c.crashed).length, 1);
  assert.match(r.summary, /F-001 in 1 of 10 cycles/);
  assert.equal(r.findings[0]!.reproduced, undefined, "no replay by default");
});

test("a crash during warm cycles starts a new memory series", async () => {
  // launches: 1 = warm clean start, 2.. = resumes; crash on the 4th launch (3rd resume)
  const r = await run(new App(6 * 1024, [4]), { coldCycles: 0, warmCycles: 12 });
  const runs = new Set(r.metrics.cycles.filter((c) => c.pssKb !== undefined).map((c) => c.run));
  assert.equal(runs.size, 2);
  assert.ok(r.metrics.cycles.some((c) => c.crashed));
  assert.equal(r.metrics.memory.verdict, "GROWS", "the longer series after the restart still leaks");
});

test("no memory reading: a note, no leak finding", async () => {
  const d = new App(6 * 1024);
  (d as { memoryKb?: unknown }).memoryKb = undefined;
  const r = await run(d);
  assert.equal(r.status, "PASSED");
  assert.match(r.summary, /Memory cannot be read/);
  const denied = await run(new App(6 * 1024), {}, { permissions: new Set(["APP_LAUNCH", "DEVICE_INTERACT", "LOG_READ"]) });
  assert.match(denied.summary, /DEVICE_READ is not granted/);
});

test("same task, same actions; cycles are cut to fit the step ceiling", async () => {
  const seq = async () => (await run(new App(0))).actionLog.map((h) => JSON.stringify(h.params));
  assert.deepEqual(await seq(), await seq());
  const r = await run(new App(0), { coldCycles: 10, warmCycles: 100 }, { ceilings: { maxSteps: 60, maxLLMCalls: 0, maxTokens: 0, maxExecutionTimeMs: 60_000 } });
  assert.ok(r.steps <= 60, `steps ${r.steps}`);
  assert.match(r.summary, /Reduced from 10 cold \+ 100 warm cycles/);
});

test("cancel, timeout and device loss end with a structured result", async () => {
  const ac = new AbortController();
  ac.abort();
  assert.equal((await run(new App(), {}, { signal: ac.signal })).status, "CANCELLED");
  const slow = async (ms: number, signal?: AbortSignal) => new Promise<void>((res) => { const t = setTimeout(res, ms); signal?.addEventListener("abort", () => { clearTimeout(t); res(); }, { once: true }); });
  assert.equal((await runStability({ taskId: "T-2", agentId: "MAIN-04-B", device: new App(), task: base({ timeoutMs: 30, settleMs: 1000 }), sleep: slow })).status, "TIMEOUT");
  const lost = new App();
  const press = lost.pressKey.bind(lost);
  lost.pressKey = async (k) => {
    lost.setState("OFFLINE");
    await press(k);
  };
  assert.equal((await run(lost)).status, "BLOCKED");
});

test("MAIN-04 sends stability to MAIN-04-B and crash-hunt still to MAIN-04-A", async () => {
  const fleet = createMockFleet(12);
  const d = new App(6 * 1024);
  (d as unknown as { id: string }).id = "DEVICE-04";
  fleet[3] = d;
  const rt = initializeAgentLab({ devices: fleet });
  assert.equal(rt.registry.require("MAIN-04-B").canHandle("stability"), true);
  assert.equal(rt.registry.require("MAIN-04-A").canHandle("stability"), false);
  const t = await rt.orchestrator.dispatch("MAIN-04", "stability", { app: { packageName: PKG }, coldCycles: 2, warmCycles: 8, settleMs: 0 });
  assert.equal(t.status, "FAILED");
  const child = (t.result as AgentResult).children![0]!;
  assert.equal(child.agentId, "MAIN-04-B");
  const det = child.details as { metrics: StabilityMetrics; deviceId: string };
  assert.equal(det.deviceId, "DEVICE-04");
  assert.equal(det.metrics.memory.verdict, "GROWS", "DEVICE_READ is granted through the profile");
  const hunt = await rt.orchestrator.dispatch("MAIN-04", "crash-hunt", { app: { packageName: PKG }, maxActions: 3, coldStarts: 0 });
  assert.equal((hunt.result as AgentResult).children![0]!.agentId, "MAIN-04-A");
  assert.equal(rt.devices.describe("DEVICE-04")!.lock, "FREE");
});

test("stability over the simulated adb binary reads dumpsys meminfo", { skip: FAKE_ADB_SKIP }, async () => {
  const fake = createFakeAdb();
  fake.setMeminfo("           TOTAL PSS:    90000            TOTAL RSS:   150000\n");
  const adb = new AdbDevice(FAKE_SERIAL, fake.bin);
  assert.equal(await adb.memoryKb("com.fake.app"), 90000);
  const r = await runStability({ taskId: "T-3", agentId: "MAIN-04-B", device: adb, task: { ...base({ coldCycles: 1, warmCycles: 6 }), app: { packageName: "com.fake.app" } }, sleep: noSleep });
  assert.equal(r.status, "PASSED");
  assert.equal(r.metrics.memory.verdict, "STABLE");
  const calls = fake.calls();
  assert.ok(calls.includes("shell dumpsys meminfo com.fake.app"));
  assert.ok(calls.includes("shell input keyevent KEYCODE_HOME"));
  await assert.rejects(adb.memoryKb("com.x; reboot"), /invalid package/);
});
