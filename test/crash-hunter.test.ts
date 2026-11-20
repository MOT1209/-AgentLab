import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockDevice, createMockFleet } from "../src/device/mock-device.js";
import { AdbDevice } from "../src/device/adb-device.js";
import type { UiNode } from "../src/device/types.js";
import { initializeAgentLab } from "../src/bootstrap.js";
import type { AgentResult } from "../src/agents/types.js";
import type { ExplorationResult } from "../src/agents/exploration/result.js";
import { EDGE_INPUTS, parseCrashHuntTask, runCrashHunt, seededRandom, type CrashHuntTask } from "../src/agents/behaviors/crash-hunter.js";
import { createFakeAdb, FAKE_ADB_SKIP, FAKE_SERIAL } from "./support/fake-adb.js";

const PKG = "com.example.app";
const node = (text: string, l: number, t: number, extra: Partial<UiNode> = {}): UiNode => ({ text, desc: "", id: `${PKG}:id/${text.replace(/\W/g, "_").toLowerCase()}`, cls: "android.widget.Button", pkg: PKG, clickable: true, enabled: true, bounds: { l, t, r: l + 200, b: t + 100 }, ...extra });
const FATAL = (pkg: string, ex = "java.lang.IllegalStateException") => [
  "11-20 10:00:00.000  100  100 E AndroidRuntime: FATAL EXCEPTION: main",
  `11-20 10:00:00.001  100  100 E AndroidRuntime: Process: ${pkg}, PID: 100`,
  `11-20 10:00:00.002  100  100 E AndroidRuntime: ${ex}: boom`,
];

/** A mock app whose "Crash me" button (center 540,960) throws, and whose "Buy now" button would spend money. */
class CrashyApp extends MockDevice {
  buys = 0;
  constructor(readonly crashButton = true) {
    super("crashy");
    this.setUi([node("Home", 100, 200), node("Buy now", 440, 400), ...(crashButton ? [node("Crash me", 440, 910)] : []), node("Name", 100, 1200, { cls: "android.widget.EditText" })]);
  }
  override async tap(x: number, y: number): Promise<void> {
    await super.tap(x, y);
    if (x === 540 && y === 450) this.buys++;
    if (this.crashButton && x === 540 && y === 960) for (const l of FATAL(PKG)) this.appendLog(l);
  }
}

const base = (extra: Partial<CrashHuntTask> = {}): CrashHuntTask => ({ app: { packageName: PKG }, seed: 7, maxActions: 40, coldStarts: 1, timeoutMs: 60_000, confirmCrashes: true, allowSensitiveActions: false, ...extra });
const noSleep = async () => undefined;
const hunt = (device: MockDevice, extra: Partial<CrashHuntTask> = {}, more: Record<string, unknown> = {}) => runCrashHunt({ taskId: "T-1", agentId: "MAIN-04-A", device, task: base(extra), sleep: noSleep, ...more });

test("parseCrashHuntTask validates the payload and fills defaults", () => {
  assert.equal(parseCrashHuntTask(null).ok, false);
  assert.equal(parseCrashHuntTask({}).ok, false);
  assert.equal(parseCrashHuntTask({ app: { packageName: "bad name" } }).ok, false);
  assert.equal(parseCrashHuntTask({ app: { packageName: PKG }, maxActions: 0 }).ok, false);
  assert.equal(parseCrashHuntTask({ app: { packageName: PKG }, seed: 1.5 }).ok, false);
  assert.equal(parseCrashHuntTask({ app: { packageName: PKG }, evidenceDir: "relative/dir" }).ok, false);
  assert.equal(parseCrashHuntTask({ app: { packageName: PKG, launchActivity: ".Main; rm -rf /" } }).ok, false);
  const ok = parseCrashHuntTask({ app: { packageName: PKG } });
  assert.ok(ok.ok);
  if (ok.ok) assert.deepEqual([ok.task.seed, ok.task.maxActions, ok.task.coldStarts, ok.task.confirmCrashes, ok.task.allowSensitiveActions], [1, 60, 3, true, false]);
});

test("seededRandom is reproducible and edge inputs are ASCII (stock adb input text)", () => {
  const a = seededRandom(42);
  const b = seededRandom(42);
  const xs = Array.from({ length: 5 }, () => a());
  assert.deepEqual(xs, Array.from({ length: 5 }, () => b()));
  assert.ok(xs.every((x) => x >= 0 && x < 1));
  assert.ok(EDGE_INPUTS.every((s) => s.length > 0 && /^[\x20-\x7e]+$/.test(s)));
});

test("same seed, same action sequence", async () => {
  const r1 = await hunt(new CrashyApp(false));
  const r2 = await hunt(new CrashyApp(false));
  const seq = (r: ExplorationResult) => r.actionLog.map((h) => JSON.stringify(h.params));
  assert.deepEqual(seq(r1), seq(r2));
  const r3 = await hunt(new CrashyApp(false), { seed: 8 });
  assert.notDeepEqual(seq(r1), seq(r3));
});

test("finds a crash behind a button: VERIFIED finding with evidence, repro steps and a confirmed replay", async () => {
  const d = new CrashyApp();
  const r = await hunt(d, { maxActions: 60 });
  assert.equal(r.status, "FAILED");
  assert.equal(r.findings.length, 1, "the same crash is reported once");
  const f = r.findings[0]!;
  assert.equal(f.source, "VERIFIED");
  assert.equal(f.severity, "CRITICAL");
  assert.match(f.description, /IllegalStateException/);
  assert.ok(f.evidenceIds.length >= 1);
  assert.ok(r.evidence.some((e) => e.kind === "log" && e.data.includes("FATAL EXCEPTION")));
  assert.ok(f.reproSteps!.some((s) => s.includes("TAP (540, 960)")));
  assert.equal(f.reproduced, "CONFIRMED");
  assert.equal(r.telemetry.llmCalls, 0);
  assert.ok(!d.isRunning(PKG), "the app is stopped at the end");
  assert.match(r.summary, /seed 7/);
});

test("no crash: PASSED, and the sensitive control is never tapped", async () => {
  const d = new CrashyApp(false);
  const r = await hunt(d, { maxActions: 80 });
  assert.equal(r.status, "PASSED");
  assert.equal(r.findings.length, 0);
  assert.equal(d.buys, 0);
  assert.ok(d.trace.some((t) => t.startsWith("type:")), "boundary values are typed into the text field");
  assert.match(r.summary, /1 sensitive control\(s\) were left alone/);
  assert.equal(r.steps, r.actionLog.length);
});

test("allowSensitiveActions lets the hunter tap it", async () => {
  const d = new CrashyApp(false);
  await hunt(d, { maxActions: 80, allowSensitiveActions: true });
  assert.ok(d.buys > 0);
});

test("crashes of other apps are ignored; ANR of the app under test is found", async () => {
  const other = new (class extends CrashyApp {
    override async tap(x: number, y: number): Promise<void> {
      await super.tap(x, y);
      for (const l of FATAL("com.other.app")) this.appendLog(l);
    }
  })(false);
  assert.equal((await hunt(other)).findings.length, 0);

  const anr = new (class extends CrashyApp {
    override async swipe(x1: number, y1: number, x2: number, y2: number, ms?: number): Promise<void> {
      await super.swipe(x1, y1, x2, y2, ms);
      this.appendLog(`11-20 10:00:01.000  1000  1000 E ActivityManager: ANR in ${PKG}`);
    }
  })(false);
  const r = await hunt(anr, { maxActions: 60, confirmCrashes: false });
  assert.equal(r.status, "FAILED");
  assert.match(r.findings[0]!.title, /ANR/);
  assert.equal(r.findings[0]!.reproduced, undefined);
});

test("a startup crash is found in the cold-start phase", async () => {
  const d = new (class extends MockDevice {
    override async launch(pkg: string, a?: string): Promise<void> {
      await super.launch(pkg, a);
      for (const l of FATAL(PKG, "java.lang.NullPointerException")) this.appendLog(l);
    }
  })();
  const r = await hunt(d, { maxActions: 5, coldStarts: 2 });
  assert.equal(r.status, "FAILED");
  assert.equal(r.findings.length, 1);
  assert.ok(r.findings[0]!.step <= 3);
  assert.equal(r.findings[0]!.reproduced, "CONFIRMED");
  assert.match(r.summary, /repeat occurrence/);
});

test("no UI hierarchy: falls back to coordinate taps inside the screen", async () => {
  const d = new MockDevice();
  const r = await hunt(d, { maxActions: 30, screen: { width: 720, height: 1280 } });
  assert.equal(r.status, "PASSED");
  const taps = d.trace.filter((t) => t.startsWith("tap:")).map((t) => t.slice(4).split(",").map(Number));
  assert.ok(taps.length > 0);
  assert.ok(taps.every(([x, y]) => x! >= 0 && x! < 720 && y! >= 0 && y! < 1280));
});

test("device loss, cancellation and timeout end with a structured result", async () => {
  const lost = new (class extends CrashyApp {
    n = 0;
    override async tap(x: number, y: number): Promise<void> {
      if (++this.n === 3) this.setState("OFFLINE");
      await super.tap(x, y);
    }
  })(false);
  assert.equal((await hunt(lost)).status, "BLOCKED");

  const ac = new AbortController();
  ac.abort();
  assert.equal((await hunt(new CrashyApp(false), {}, { signal: ac.signal })).status, "CANCELLED");

  const slow = async (ms: number, signal?: AbortSignal) => new Promise<void>((r) => { const t = setTimeout(r, ms); signal?.addEventListener("abort", () => { clearTimeout(t); r(); }, { once: true }); });
  const r = await runCrashHunt({ taskId: "T-2", agentId: "MAIN-04-A", device: new CrashyApp(false), task: base({ timeoutMs: 30 }), sleep: slow });
  assert.equal(r.status, "TIMEOUT");
});

test("profile ceilings cap maxActions", async () => {
  const r = await hunt(new CrashyApp(false), { maxActions: 100, coldStarts: 0 }, { ceilings: { maxSteps: 10, maxLLMCalls: 0, maxTokens: 0, maxExecutionTimeMs: 60_000 } });
  assert.ok(r.steps <= 10 + 5, `steps ${r.steps}`);
});

test("evidence and result.json are written when evidenceDir is set", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hunt-"));
  const r = await hunt(new CrashyApp(), { evidenceDir: dir });
  assert.equal(r.evidenceDir, dir);
  assert.ok(existsSync(join(dir, "T-1", "result.json")));
});

test("MAIN-04 dispatches crash-hunt to MAIN-04-A on its own device, with no LLM provider", async () => {
  const fleet = createMockFleet(12);
  const d = fleet[3]!;
  d.setUi([node("Crash me", 440, 910)]);
  const tap = d.tap.bind(d);
  d.tap = async (x, y) => {
    await tap(x, y);
    if (x === 540 && y === 960) for (const l of FATAL(PKG)) d.appendLog(l);
  };
  const rt = initializeAgentLab({ devices: fleet });
  assert.equal(rt.registry.require("MAIN-04-A").canHandle("crash-hunt"), true);
  const t = await rt.orchestrator.dispatch("MAIN-04", "crash-hunt", { app: { packageName: PKG }, maxActions: 20, coldStarts: 1 });
  assert.equal(t.status, "FAILED");
  const child = (t.result as AgentResult).children![0]!;
  assert.equal(child.agentId, "MAIN-04-A");
  const det = child.details as ExplorationResult;
  assert.equal(det.deviceId, "DEVICE-04");
  assert.equal(det.findings[0]!.reproduced, "CONFIRMED");
  assert.equal(rt.devices.describe("DEVICE-04")!.lock, "FREE");

  const bad = await rt.orchestrator.dispatch("MAIN-04", "crash-hunt", { app: {} });
  assert.equal(bad.status, "ERROR");
});

test("crash hunt over the simulated adb binary finds a startup crash", { skip: FAKE_ADB_SKIP }, async () => {
  const fake = createFakeAdb();
  const adb = new AdbDevice(FAKE_SERIAL, fake.bin);
  const r = await runCrashHunt({ taskId: "T-3", agentId: "MAIN-04-A", device: adb, task: { ...base({ maxActions: 4, coldStarts: 1 }), app: { packageName: "com.fake.crash" } }, sleep: noSleep });
  assert.equal(r.status, "FAILED");
  assert.match(r.findings[0]!.description, /IllegalStateException/);
  const calls = fake.calls();
  assert.ok(calls.includes("shell am force-stop com.fake.crash"));
  assert.ok(calls.some((c) => c.startsWith("shell monkey") && c.includes("com.fake.crash")));
  assert.ok(calls.includes("logcat -c"));
});
