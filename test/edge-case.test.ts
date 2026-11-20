import { test } from "node:test";
import assert from "node:assert/strict";
import { MockDevice, createMockFleet } from "../src/device/mock-device.js";
import { AdbDevice } from "../src/device/adb-device.js";
import type { UiNode } from "../src/device/types.js";
import { initializeAgentLab } from "../src/bootstrap.js";
import type { AgentResult } from "../src/agents/types.js";
import { parseEdgeCaseTask, runEdgeCases, type EdgeCaseRecord, type EdgeCaseTask } from "../src/agents/behaviors/edge-case.js";
import { EDGE_INPUTS } from "../src/agents/behaviors/deterministic-session.js";
import { createFakeAdb, FAKE_ADB_SKIP, FAKE_SERIAL } from "./support/fake-adb.js";

const PKG = "com.example.app";
const el = (text: string, l: number, t: number, extra: Partial<UiNode> = {}): UiNode => ({ text, desc: "", id: `${PKG}:id/${text.replace(/\W/g, "_").toLowerCase() || "field"}`, cls: "android.widget.Button", pkg: PKG, clickable: true, enabled: true, bounds: { l, t, r: l + 200, b: t + 100 }, ...extra });
const field = (id: string, t: number): UiNode => el("", 100, t, { id: `${PKG}:id/${id}`, cls: "android.widget.EditText" });
const FATAL = (ex = "java.lang.NumberFormatException") => [
  "11-20 10:00:00.000  100  100 E AndroidRuntime: FATAL EXCEPTION: main",
  `11-20 10:00:00.001  100  100 E AndroidRuntime: Process: ${PKG}, PID: 100`,
  `11-20 10:00:00.002  100  100 E AndroidRuntime: ${ex}: boom`,
];

/**
 * A form app: fields "name" (y 250) and "age" (y 450), a "Save" button (center 200,650) and a "Help" button.
 * Saving with age "-1" crashes. The typed text is kept per field until the app is stopped.
 */
class FormApp extends MockDevice {
  focused: string | undefined;
  typed = new Map<string, string>();
  saves = 0;
  crashOnDoubleSave = false;
  lastSaveAt = -1;
  constructor(nodes?: UiNode[]) {
    super("form");
    this.setUi(nodes ?? [field("name", 200), field("age", 400), el("Save", 100, 600), el("Help", 400, 600)]);
  }
  override async stop(pkg: string): Promise<void> {
    await super.stop(pkg);
    this.typed.clear();
    this.focused = undefined;
  }
  override async tap(x: number, y: number): Promise<void> {
    await super.tap(x, y);
    if (x === 200 && y === 250) this.focused = "name";
    else if (x === 200 && y === 450) this.focused = "age";
    else if (x === 200 && y === 650) {
      this.saves++;
      const n = this.trace.length;
      if (this.typed.get("age") === "-1") for (const l of FATAL()) this.appendLog(l);
      if (this.crashOnDoubleSave && this.lastSaveAt === n - 1) for (const l of FATAL("java.lang.IllegalStateException")) this.appendLog(l);
      this.lastSaveAt = n;
    }
  }
  override async type(text: string): Promise<void> {
    await super.type(text);
    if (this.focused) this.typed.set(this.focused, (this.typed.get(this.focused) ?? "") + text);
  }
}

const base = (extra: Partial<EdgeCaseTask> = {}): EdgeCaseTask => ({ app: { packageName: PKG }, timeoutMs: 60_000, confirmCrashes: true, allowSensitiveActions: false, inputs: ["0", "-1", "abc"], maxFields: 5, maxCases: 80, sequences: false, ...extra });
const noSleep = async () => undefined;
const run = (device: MockDevice, extra: Partial<EdgeCaseTask> = {}, more: Record<string, unknown> = {}) => runEdgeCases({ taskId: "T-1", agentId: "MAIN-05-B", device, task: base(extra), sleep: noSleep, ...more });

test("parseEdgeCaseTask validates the payload and fills defaults", () => {
  assert.equal(parseEdgeCaseTask({}).ok, false);
  assert.equal(parseEdgeCaseTask({ app: { packageName: PKG }, inputs: [] }).ok, false);
  assert.equal(parseEdgeCaseTask({ app: { packageName: PKG }, inputs: ["مرحبا"] }).ok, false, "non-ASCII cannot be typed by stock adb");
  assert.equal(parseEdgeCaseTask({ app: { packageName: PKG }, inputs: ["x".repeat(501)] }).ok, false);
  assert.equal(parseEdgeCaseTask({ app: { packageName: PKG }, inputs: [""] }).ok, false);
  assert.equal(parseEdgeCaseTask({ app: { packageName: PKG }, maxCases: 0 }).ok, false);
  assert.equal(parseEdgeCaseTask({ app: { packageName: PKG }, sequences: "yes" }).ok, false);
  const ok = parseEdgeCaseTask({ app: { packageName: PKG } });
  assert.ok(ok.ok);
  if (ok.ok) {
    assert.deepEqual(ok.task.inputs, EDGE_INPUTS);
    assert.deepEqual([ok.task.maxFields, ok.task.maxCases, ok.task.sequences, ok.task.confirmCrashes], [5, 80, true, true]);
  }
});

test("the crash is attributed to the right field and input; the other cases pass", async () => {
  const r = await run(new FormApp());
  assert.equal(r.status, "FAILED");
  assert.equal(r.cases.length, 6, "2 fields x 3 inputs");
  const bad = r.cases.filter((c) => c.outcome === "CRASH");
  assert.equal(bad.length, 1);
  assert.deepEqual([bad[0]!.field, bad[0]!.input], [`${PKG}:id/age`.split("/").pop(), "-1"]);
  assert.ok(r.cases.filter((c) => c !== bad[0]).every((c) => c.outcome === "OK"));
  assert.equal(r.findings.length, 1);
  const f = r.findings[0]!;
  assert.equal(bad[0]!.findingId, f.id);
  assert.equal(f.source, "VERIFIED");
  assert.match(f.description, /field "age" with input "-1"/);
  assert.equal(f.reproduced, "CONFIRMED");
  assert.equal(r.telemetry.llmCalls, 0);
});

test("every case starts from a clean launch and its repro steps are only that case", async () => {
  const r = await run(new FormApp());
  for (const c of r.cases) {
    const first = r.actionLog.find((h) => h.step === c.steps[0])!;
    assert.equal(first.action, "STOP_APP");
  }
  const steps = r.findings[0]!.reproSteps!;
  assert.equal(steps[0], "1. STOP_APP");
  assert.equal(steps.filter((x) => x.startsWith("TYPE") || x.includes("TYPE")).length, 1, `one TYPE only: ${steps.join(" | ")}`);
  assert.ok(steps.some((x) => x.includes('TYPE "-1"')));
});

test("same task, same actions", async () => {
  const seq = async () => (await run(new FormApp(), { sequences: true })).actionLog.map((h) => JSON.stringify(h.params));
  assert.deepEqual(await seq(), await seq());
});

test("sequences: a double-submit crash is found as a sequence case", async () => {
  const d = new FormApp();
  d.crashOnDoubleSave = true;
  const r = await run(d, { inputs: ["abc"], sequences: true });
  const names = r.cases.filter((c) => c.kind === "sequence").map((c) => c.name);
  assert.ok(names.includes("double submit") && names.includes("back past the root") && names.includes("rapid relaunch x3"), names.join(", "));
  const dbl = r.cases.find((c) => c.name === "double submit")!;
  assert.equal(dbl.outcome, "CRASH");
  assert.match(r.findings.find((f) => f.id === dbl.findingId)!.description, /sequence "double submit"/);
});

test("no fields: only sequences run, and the summary says why", async () => {
  const r = await run(new FormApp([el("Help", 100, 600)]), { sequences: true });
  assert.ok(r.cases.length > 0);
  assert.ok(r.cases.every((c) => c.kind === "sequence"));
  assert.match(r.summary, /No text fields on the start screen/);
});

test("a sensitive submit button is never pressed", async () => {
  const d = new FormApp([field("card", 200), el("Pay now", 100, 600)]);
  const r = await run(d, { sequences: true });
  assert.equal(d.saves, 0);
  assert.ok(!d.trace.includes("tap:200,650"));
  assert.match(r.summary, /No submit control found/);
  assert.match(r.summary, /sensitive control/);
});

test("maxCases caps the run, and sequence cases keep their reserved budget", async () => {
  const r = await run(new FormApp(), { inputs: EDGE_INPUTS, maxCases: 10, sequences: true });
  assert.equal(r.cases.length, 10);
  assert.ok(r.cases.some((c) => c.kind === "sequence"));
});

test("the profile's step ceiling stops new cases", async () => {
  const r = await run(new FormApp(), { inputs: EDGE_INPUTS }, { ceilings: { maxSteps: 40, maxLLMCalls: 0, maxTokens: 0, maxExecutionTimeMs: 60_000 } });
  assert.ok(r.steps <= 40 + 3, `steps ${r.steps}`);
  assert.match(r.summary, /step ceiling/);
});

test("a field that is gone after relaunch is FIELD_GONE, not OK", async () => {
  const d = new FormApp();
  let launches = 0;
  const launch = d.launch.bind(d);
  d.launch = async (p, a) => {
    await launch(p, a);
    if (++launches === 2) d.setUi([el("Save", 100, 600)]);
  };
  const r = await run(d, { inputs: ["0"] });
  assert.ok(r.cases.every((c) => c.outcome === "FIELD_GONE"), r.cases.map((c) => c.outcome).join());
});

test("cancel, timeout and device loss end with a structured result", async () => {
  const ac = new AbortController();
  ac.abort();
  assert.equal((await run(new FormApp(), {}, { signal: ac.signal })).status, "CANCELLED");
  const slow = async (ms: number, signal?: AbortSignal) => new Promise<void>((res) => { const t = setTimeout(res, ms); signal?.addEventListener("abort", () => { clearTimeout(t); res(); }, { once: true }); });
  assert.equal((await runEdgeCases({ taskId: "T-2", agentId: "MAIN-05-B", device: new FormApp(), task: base({ timeoutMs: 30 }), sleep: slow })).status, "TIMEOUT");
  const lost = new FormApp();
  const type = lost.type.bind(lost);
  lost.type = async (t) => {
    lost.setState("OFFLINE");
    await type(t);
  };
  assert.equal((await run(lost)).status, "BLOCKED");
});

test("MAIN-05 dispatches edge-case to MAIN-05-B on DEVICE-05 with no LLM provider", async () => {
  const fleet = createMockFleet(12);
  const d = new FormApp();
  (d as unknown as { id: string }).id = "DEVICE-05";
  fleet[4] = d;
  const rt = initializeAgentLab({ devices: fleet });
  assert.equal(rt.registry.require("MAIN-05-B").canHandle("edge-case"), true);
  assert.equal(rt.registry.require("MAIN-05-B").canHandle("explore"), false);
  const t = await rt.orchestrator.dispatch("MAIN-05", "edge-case", { app: { packageName: PKG }, inputs: ["-1"], sequences: false });
  assert.equal(t.status, "FAILED");
  const child = (t.result as AgentResult).children![0]!;
  assert.equal(child.agentId, "MAIN-05-B");
  const det = child.details as { deviceId: string; cases: EdgeCaseRecord[] };
  assert.equal(det.deviceId, "DEVICE-05");
  assert.equal(det.cases.find((c) => c.outcome === "CRASH")?.input, "-1");
  assert.equal(rt.devices.describe("DEVICE-05")!.lock, "FREE");
  assert.equal((await rt.orchestrator.dispatch("MAIN-05", "edge-case", { app: {} })).status, "ERROR");
});

test("edge cases over the simulated adb binary: field taps, typing and the real command shapes", { skip: FAKE_ADB_SKIP }, async () => {
  const fake = createFakeAdb();
  const adb = new AdbDevice(FAKE_SERIAL, fake.bin);
  const r = await runEdgeCases({ taskId: "T-3", agentId: "MAIN-05-B", device: adb, task: { ...base({ inputs: ["0"], sequences: true, maxCases: 3 }), app: { packageName: "com.fake.app" } }, sleep: noSleep });
  assert.equal(r.status, "PASSED");
  const calls = fake.calls();
  assert.ok(calls.includes("shell am force-stop com.fake.app"));
  assert.ok(calls.some((c) => c.startsWith("shell input tap")));
  assert.ok(calls.includes("exec-out uiautomator dump /dev/tty"));
});
