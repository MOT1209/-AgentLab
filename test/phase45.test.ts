import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdbDevice } from "../src/device/adb-device.js";
import { MockDevice, createMockFleet } from "../src/device/mock-device.js";
import { DeviceError, type Device } from "../src/device/types.js";
import { MockProvider } from "../src/providers/mock-provider.js";
import { initializeAgentLab } from "../src/bootstrap.js";
import { ProviderManager } from "../src/providers/manager.js";
import { AdbDiscovery } from "../src/runtime/discovery.js";
import { DeviceManager } from "../src/runtime/device-manager.js";
import { deepHealthCheck, normalizeAdbState } from "../src/runtime/health.js";
import { detectCrash } from "../src/agents/exploration/findings.js";
import { runExploration } from "../src/agents/exploration/exploration-agent.js";
import { ActionExecutor } from "../src/agents/exploration/action-executor.js";
import { EvidenceStore } from "../src/agents/exploration/evidence.js";
import { parseExplorationTask, type ExplorationTask } from "../src/agents/exploration/task.js";
import { demoScreenshot } from "../src/ui/demo-png.js";
import type { AgentResult } from "../src/agents/types.js";
import { runDeviceScenario } from "./support/e2e-scenario.js";
import { createFakeAdb, FAKE_ADB_SKIP, FAKE_SERIAL } from "./support/fake-adb.js";

const PKG = "com.example.app";
const tap = (x: number, y: number) => ({ json: { action: "TAP", target: { x, y }, reason: "r" } });
const end = () => ({ json: { action: "END_TEST", reason: "done" } });
function task(over: Partial<ExplorationTask> = {}): ExplorationTask {
  return { objective: { summary: "Explore" }, app: { packageName: PKG }, maxSteps: 20, maxLlmCalls: 25, timeoutMs: 5000, captureScreenshots: true, ...over };
}
const run = (llm: MockProvider, device: Device = new MockDevice("D"), over: Partial<ExplorationTask> = {}) =>
  runExploration({ taskId: "T-1", agentId: "MAIN-05-A", deviceId: device.id, device, llm, task: task(over), log: () => undefined });
const hasAdb = (() => { try { execFileSync("adb", ["version"], { stdio: "ignore" }); return true; } catch { return false; } })();

// ---------- health ----------

test("health: adb states are normalised and only 'device' can be healthy", async () => {
  assert.deepEqual(["device", "offline", "unauthorized", "no permissions", "recovery"].map(normalizeAdbState), ["device", "offline", "unauthorized", "unknown", "unknown"]);
  const d = new MockDevice("D");
  const ok = await deepHealthCheck(d, "device");
  assert.deepEqual([ok.healthy, ok.serial, ok.model, ok.androidVersion, ok.state], [true, "D", "MockPhone", "14", "device"]);
  assert.deepEqual(ok.checks, { adb: true, shell: true, screenshot: true, logs: true });

  for (const [raw, expect] of [["unauthorized", /USB debugging prompt/], ["offline", /offline/], ["authorizing", /unknown/]] as const) {
    const h = await deepHealthCheck(d, raw);
    assert.equal(h.healthy, false);
    assert.match(h.errors[0]!, expect);
    assert.equal(h.checks.shell, false); // nothing else is attempted on an unusable device
  }
});

test("health: each failing capability is reported separately", async () => {
  class NoShot extends MockDevice {
    override async screenshot(): Promise<Buffer> {
      throw new DeviceError("screencap failed", this.id);
    }
  }
  const h = await deepHealthCheck(new NoShot("D"), "device");
  assert.deepEqual([h.healthy, h.checks.shell, h.checks.screenshot, h.checks.logs], [false, true, false, true]);
  assert.match(h.errors.join(), /screenshot check failed: screencap failed/);

  const fake: Device = { ...new MockDevice("P"), id: "P", source: "PHYSICAL", state: () => "ONLINE", info: async () => ({ id: "P", model: "m", androidVersion: "14" }), screenshot: async () => Buffer.from("not a png"), logs: async () => "" } as never;
  assert.match((await deepHealthCheck(fake, "device")).errors.join(), /not a PNG/);
});

test("pipeline: unhealthy devices never reach the registry; healthy ones do, with model and version", async () => {
  class Broken extends MockDevice {
    override async logs(): Promise<string> {
      throw new DeviceError("logcat denied", this.id);
    }
  }
  const m = new DeviceManager();
  const res = await m.discover(
    { discover: async () => [{ serial: "A1", state: "device" }, { serial: "B2", state: "device" }, { serial: "C3", state: "unauthorized" }, { serial: "D4", state: "offline" }, { serial: "E5", state: "weird" }] },
    (d) => (d.serial === "B2" ? new Broken(d.serial) : new MockDevice(d.serial)),
  );
  assert.deepEqual(res.added.map((d) => [d.id, d.model, d.androidVersion]), [["A1", "MockPhone", "14"]]);
  assert.deepEqual(res.rejected.map((r) => [r.serial, r.state]), [["B2", "device"], ["C3", "unauthorized"], ["D4", "offline"], ["E5", "unknown"]]);
  assert.match(res.rejected[0]!.reason, /logs check failed/);
  assert.equal(m.registry.has("B2"), false);
  assert.deepEqual(m.pool.free().map((d) => d.id), ["A1"]);
});

// ---------- structured device errors ----------

test("device problems come back as structured error codes, not crashes", async () => {
  const mk = () => {
    const providers = new ProviderManager();
    providers.register(MockProvider.scripted([end()]));
    const fleet = createMockFleet(12);
    return { fleet, rt: initializeAgentLab({ devices: fleet, providers }) };
  };
  const payload = { objective: "x", app: { packageName: PKG } };
  const code = (t: { result?: unknown }) => (t.result as AgentResult).error;

  const a = mk();
  a.fleet[4]!.setState("OFFLINE");
  const offline = await a.rt.orchestrator.dispatch("MAIN-05", "explore", payload);
  assert.deepEqual([offline.status, code(offline)?.code], ["BLOCKED", "DEVICE_UNAVAILABLE"]);

  const b = mk();
  b.rt.devices.lock("DEVICE-05", { id: "ops", type: "SYSTEM" });
  const busy = await b.rt.orchestrator.dispatch("MAIN-05", "explore", payload);
  assert.deepEqual([busy.status, code(busy)?.code], ["BLOCKED", "DEVICE_BUSY"]);
  assert.deepEqual((code(busy)!.data as { heldBy: unknown }).heldBy, { id: "ops", type: "SYSTEM" });

  const c = mk();
  c.rt.unassignDevice("MAIN-05");
  assert.equal(code(await c.rt.orchestrator.dispatch("MAIN-05", "explore", payload))?.code, "NO_DEVICE_ASSIGNED");
});

test("a second agent cannot take a leased device; after release it is available again", () => {
  const providers = new ProviderManager();
  providers.register(MockProvider.scripted([end()]));
  const rt = initializeAgentLab({ devices: createMockFleet(12), providers });
  const first = rt.devices.lock("DEVICE-05", { id: "MAIN-05", type: "AGENT" });
  assert.ok(first.ok);
  const second = rt.devices.lock("DEVICE-05", { id: "MAIN-09", type: "AGENT" });
  assert.ok(!second.ok && second.reason === "ALREADY_LEASED");
  assert.throws(() => rt.devices.assign("MAIN-09", "DEVICE-05"), /already assigned/); // double assignment
  assert.equal(rt.devices.pool.free().some((d) => d.id === "DEVICE-05"), false);
  assert.deepEqual(rt.devices.unlock(first.ok ? first.lease.leaseId : "", "MAIN-05"), { ok: true });
  assert.equal(rt.devices.pool.free().some((d) => d.id === "DEVICE-05"), true);
  assert.deepEqual(rt.devices.unlock(first.ok ? first.lease.leaseId : "", "MAIN-05"), { ok: false, reason: "NOT_ACTIVE" }); // no stale/double release
});

// ---------- LLM budget ----------

test("maxLlmCalls stops the run even when maxSteps would allow more", async () => {
  let n = 0;
  const llm = MockProvider.scripted([() => JSON.stringify({ action: "TAP", target: { x: ++n, y: n }, reason: "r" })]);
  const device = new MockDevice("D");
  const r = await run(llm, device, { maxSteps: 50, maxLlmCalls: 3 });
  assert.equal(r.status, "BUDGET_EXCEEDED");
  assert.equal(r.telemetry.llmCalls, 3);
  assert.equal(device.trace.length, 3);
  assert.deepEqual([r.telemetry.inputTokens, r.telemetry.outputTokens], [30, 15]); // usage is kept
  const parsed = parseExplorationTask({ objective: "x", maxSteps: 10 });
  assert.ok(parsed.ok && parsed.task.maxLlmCalls === 15 && parsed.task.timeoutMs === 120_000);
  assert.equal(parseExplorationTask({ objective: "x", maxLlmCalls: 0 }).ok, false);
});

test("the correction attempt counts against the LLM budget", async () => {
  const llm = MockProvider.scripted(["garbage", "more garbage"]);
  const r = await run(llm, new MockDevice("D"), { maxLlmCalls: 1 });
  assert.equal(r.status, "BUDGET_EXCEEDED");
  assert.equal(llm.requests.length, 1);
});

// ---------- crash detection ----------

test("crash detection: parses process/exception/timestamp and ignores other apps' crashes", () => {
  const log = [
    "01-01 10:00:00.100  1  1 E AndroidRuntime: FATAL EXCEPTION: main",
    "01-01 10:00:00.101  1  1 E AndroidRuntime: Process: com.other.app, PID: 77",
    "01-01 10:00:00.102  1  1 E AndroidRuntime: java.lang.NullPointerException: x",
    "01-01 10:00:05.200  2  2 E AndroidRuntime: FATAL EXCEPTION: main",
    "01-01 10:00:05.201  2  2 E AndroidRuntime: Process: com.example.app:worker, PID: 88",
    "01-01 10:00:05.202  2  2 E AndroidRuntime: java.lang.IllegalStateException: boom",
  ].join("\n");
  assert.equal(detectCrash(log)?.process, "com.other.app"); // no package filter: first crash
  const c = detectCrash(log, "com.example.app")!;
  assert.deepEqual([c.process, c.exception, c.timestamp, c.severity], ["com.example.app:worker", "java.lang.IllegalStateException", "01-01 10:00:05.200", "CRITICAL"]);
  assert.equal(detectCrash(log, "com.third.app"), undefined);

  assert.equal(detectCrash("ActivityManager: Process com.example.app (pid 5) has died: cch+5", "com.example.app")?.severity, "HIGH");
  assert.equal(detectCrash("ActivityManager: Process com.example.app (pid 5) has died", undefined), undefined); // too noisy without a package
  assert.equal(detectCrash("ActivityManager: Process com.other (pid 5) has died", "com.example.app"), undefined);
  assert.equal(detectCrash("ANR in com.example.app (com.example.app/.Main)", "com.example.app")?.process, "com.example.app");
  assert.equal(detectCrash("F libc: Fatal signal 11 (SIGSEGV)\n>>> com.example.app <<<", "com.example.app")?.title, "Native crash (fatal signal)");
  assert.equal(detectCrash("I/AndroidRuntime: Calling main entry com.example.app", "com.example.app"), undefined);
});

test("an unrelated app crashing in the shared log does not fail the run", async () => {
  const device = new MockDevice("D");
  const llm = MockProvider.scripted([
    () => (device.appendLog("E AndroidRuntime: FATAL EXCEPTION: main\nE AndroidRuntime: Process: com.other.app, PID: 9\nE AndroidRuntime: java.lang.Error"), JSON.stringify({ action: "BACK", reason: "r" })),
    end(),
  ]);
  const r = await run(llm, device);
  assert.equal(r.status, "PASSED");
  assert.equal(r.findings.length, 0);
});

// ---------- evidence on disk ----------

test("evidence is written under the evidence dir, linked by path, with generated file names only", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentlab-ev-"));
  const device = new MockDevice("D");
  device.screenshotFn = () => demoScreenshot(1);
  const llm = MockProvider.scripted([{ json: { action: "GET_UI", reason: "r" } }, { json: { action: "GET_LOGS", reason: "r" } }, tap(5, 5), end()]);
  const r = await runExploration({ taskId: "../../evil/T 1", agentId: "MAIN-05-A", device, llm, task: task({ evidenceDir: dir }), log: () => undefined });
  assert.equal(r.status, "PASSED");
  const runDir = join(dir, "______evil_T_1");
  assert.ok(existsSync(runDir), "task id must be sanitised into a single directory name");
  const files = readdirSync(runDir).sort();
  assert.ok(files.includes("result.json") && files.some((f) => f.endsWith(".png")) && files.some((f) => f.endsWith(".json")) && files.some((f) => f.endsWith(".txt")));
  assert.ok(files.every((f) => /^(EV-\d{3}\.(png|txt|json)|result\.json)$/.test(f)), files.join());
  const shot = r.evidence.find((e) => e.kind === "screenshot")!;
  assert.deepEqual([...readFileSync(shot.path!).subarray(0, 4)], [137, 80, 78, 71]);
  // POSIX permission bits are meaningless on NTFS: chmod(0600) still reports 0666, so only assert where they exist.
  if (process.platform !== "win32") assert.equal(statSync(shot.path!).mode & 0o077, 0, "files must not be group/world readable");
  const saved = JSON.parse(readFileSync(join(runDir, "result.json"), "utf8"));
  assert.equal(saved.status, "PASSED");
  assert.ok(saved.evidence.filter((e: { kind: string }) => e.kind === "screenshot").every((e: { data: string }) => e.data.endsWith(".png")), "result.json must reference screenshots, not embed them");
  assert.equal(parseExplorationTask({ objective: "x", evidenceDir: "relative/path" }).ok, false);
});

// ---------- failure recovery ----------

test("launch failure is recorded with its error code and the log tail as evidence", async () => {
  class NoLaunch extends MockDevice {
    override async launch(): Promise<void> {
      throw new DeviceError("Activity not found", this.id);
    }
  }
  const device = new NoLaunch("D");
  device.appendLog("E ActivityManager: no activity");
  const llm = MockProvider.scripted([{ json: { action: "LAUNCH_APP", reason: "start" } }, end()]);
  const r = await run(llm, device);
  assert.equal(r.status, "PASSED");
  const rec = r.actionLog[0]!;
  assert.deepEqual([rec.ok, rec.errorCode], [false, "DEVICE_ERROR"]);
  assert.ok(rec.evidenceIds.some((id) => r.evidence.find((e) => e.id === id)?.kind === "log"), "log tail attached to the failed launch");
  assert.match(llm.requests[1]!.messages[0]!.content, /Activity not found/);
});

test("launchActivity is passed through; unsupported actions return a structured error instead of being faked", async () => {
  const device = new MockDevice("D");
  const ex = new ActionExecutor(device, { packageName: PKG, launchActivity: ".MainActivity", evidence: new EvidenceStore("A") });
  await ex.execute({ action: "LAUNCH_APP" }, 1);
  assert.deepEqual(device.trace, [`launch:${PKG}/.MainActivity`]);

  const bare = { ...device, swipe: undefined, pressKey: undefined, ui: undefined } as unknown as Device;
  const ex2 = new ActionExecutor(bare, { evidence: new EvidenceStore("A") });
  for (const a of [{ action: "SWIPE", from: { x: 1, y: 1 }, to: { x: 2, y: 2 }, durationMs: 100 }, { action: "BACK" }, { action: "GET_UI" }, { action: "LAUNCH_APP" }] as const) {
    const out = await ex2.execute(a, 1);
    assert.deepEqual([out.ok, out.errorCode], [false, "UNSUPPORTED_ACTION"], a.action);
  }
});

test("an action the device cannot perform is never offered to the model", async () => {
  const device = new MockDevice("D");
  (device as { swipe?: unknown }).swipe = undefined;
  const llm = MockProvider.scripted([{ json: { action: "SWIPE", from: { x: 1, y: 1 }, to: { x: 2, y: 2 }, reason: "r" } }, end()]);
  const r = await run(llm, device);
  assert.equal(r.status, "PASSED");
  assert.equal(r.telemetry.malformedResponses, 1); // rejected and corrected, never executed
  assert.deepEqual(device.trace, []);
  assert.ok(!JSON.parse(llm.requests[0]!.messages[0]!.content).availableActions.includes("SWIPE"));
});

// ---------- AdbDevice security (argument construction) ----------

test("AdbDevice: activity injection is rejected and typed text cannot become a shell command", { skip: FAKE_ADB_SKIP }, async () => {
  const fake = createFakeAdb();
  const d = new AdbDevice(FAKE_SERIAL, fake.bin);
  await d.launch("com.fake.app", ".Main");
  await d.launch("com.fake.app");
  await assert.rejects(d.launch("com.fake.app", ".Main; rm -rf /"), /invalid activity/);
  await assert.rejects(d.launch("com.fake.app", "a b"), /invalid activity/);
  await d.type("hi; reboot $(id)");
  const calls = fake.calls();
  assert.ok(calls.includes("shell am start -n com.fake.app/.Main"));
  assert.ok(calls.some((c) => c.startsWith("shell monkey -p com.fake.app")));
  // the text is single-quoted, so the device shell sees one literal word list, never a command
  assert.ok(calls.includes("shell input text 'hi;%sreboot%s$(id)'"), calls.join("|"));
  assert.ok(!calls.some((c) => /rm -rf/.test(c)));
});

// ---------- simulated adb: real AdbDiscovery/AdbDevice process plumbing, fake device ----------

test("SIMULATED adb end-to-end: same scenario as the real-device test, through real child processes", { skip: FAKE_ADB_SKIP }, async () => {
  const fake = createFakeAdb();
  const evidenceDir = mkdtempSync(join(tmpdir(), "agentlab-sim-"));
  const llm = MockProvider.scripted([
    { json: { action: "LAUNCH_APP", reason: "start" } },
    { json: { action: "GET_UI", reason: "read" } },
    { json: { action: "TAP", target: { x: 300, y: 250 }, reason: "press the menu button from the UI list" } },
    { json: { action: "SCREENSHOT", reason: "evidence" } },
    { json: { action: "GET_LOGS", reason: "logs" } },
    end(),
  ]);
  const rep = await runDeviceScenario({ adbPath: fake.bin, packageName: "com.fake.app", llm, evidenceDir });

  assert.equal(rep.device?.id, FAKE_SERIAL);
  assert.deepEqual([rep.device?.source, rep.device?.model, rep.device?.androidVersion], ["PHYSICAL", "Fake_Phone", "14"]);
  assert.equal(rep.health?.healthy, true);
  assert.equal(rep.assignedTo, "MAIN-05");
  assert.equal(rep.during?.lock, "BUSY");
  const r = rep.exploration!;
  assert.equal(r.status, "PASSED");
  assert.deepEqual(r.actionLog.map((a) => [a.action, a.ok]), [["LAUNCH_APP", true], ["GET_UI", true], ["TAP", true], ["SCREENSHOT", true], ["GET_LOGS", true]]);
  assert.equal(rep.after?.lock, "FREE");
  assert.equal(rep.availableAgain, true);

  // the commands that really reached "adb"
  const calls = fake.calls();
  assert.ok(calls.includes("logcat -c") && calls.some((c) => c.startsWith("shell monkey -p com.fake.app")));
  assert.ok(calls.includes("shell input tap 300 250"));
  assert.ok(calls.every((c) => /^(shell (getprop|monkey|am|input)|exec-out|logcat|install)/.test(c)), `unexpected adb command: ${calls.join(" | ")}`);

  const shot = r.evidence.find((e) => e.kind === "screenshot")!;
  assert.deepEqual([...readFileSync(shot.path!).subarray(0, 4)], [137, 80, 78, 71]);
  const ui = r.evidence.find((e) => e.kind === "ui_state")!;
  assert.match(ui.data, /Open menu/);
});

test("SIMULATED adb: a crash of the launched app becomes a verified finding; a device that goes away is handled", { skip: FAKE_ADB_SKIP }, async () => {
  const fake = createFakeAdb();
  const llm = MockProvider.scripted([{ json: { action: "LAUNCH_APP", reason: "start" } }, end()]);
  const rep = await runDeviceScenario({ adbPath: fake.bin, packageName: "com.fake.crash", llm, evidenceDir: mkdtempSync(join(tmpdir(), "agentlab-sim-")) });
  assert.equal(rep.exploration?.status, "FAILED");
  const f = rep.exploration!.findings[0]!;
  assert.deepEqual([f.source, f.severity, f.title], ["VERIFIED", "CRITICAL", "Application crash (fatal exception)"]);
  assert.match(f.description, /com\.fake\.crash/);
  assert.equal(rep.task?.status, "FAILED");
  assert.equal(rep.after?.lock, "FREE");

  const unauth = createFakeAdb({ state: "unauthorized" });
  const rep2 = await runDeviceScenario({ adbPath: unauth.bin, packageName: "com.fake.app", llm: MockProvider.scripted([end()]), evidenceDir: tmpdir() });
  assert.equal(rep2.device, undefined);
  assert.match(rep2.discovery.rejected[0]!.reason, /unauthorized.*USB debugging/);
});

// ---------- the real adb binary, no device required ----------

test("REAL adb binary without a device: discovery works, a missing device is a clean failure", { skip: hasAdb ? false : "adb is not installed" }, async () => {
  const found = await new AdbDiscovery().discover(); // real `adb devices -l`; format validated against the real tool
  assert.ok(Array.isArray(found));
  const ghost = new AdbDevice("no-such-device-9999");
  await assert.rejects(ghost.info(), (e: DeviceError) => e instanceof DeviceError && /not found/.test(e.message));
  assert.equal(ghost.state(), "ERROR");
  const h = await deepHealthCheck(ghost, "device");
  assert.equal(h.healthy, false);
  assert.match(h.errors.join(), /shell check failed/);
  const m = new DeviceManager();
  const res = await m.discover({ discover: async () => [{ serial: "no-such-device-9999", state: "device" }] });
  assert.deepEqual([res.added.length, res.rejected[0]?.serial], [0, "no-such-device-9999"]);
});
