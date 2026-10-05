import { test } from "node:test";
import assert from "node:assert/strict";
import { MockDevice } from "../src/device/mock-device.js";
import { DeviceError, type UiNode } from "../src/device/types.js";
import { MockProvider } from "../src/providers/mock-provider.js";
import { ProviderError, type LlmProvider, type LlmRequest } from "../src/providers/types.js";
import { ActionExecutor } from "../src/agents/exploration/action-executor.js";
import { parseJsonObject, supportedActions, validateDecision } from "../src/agents/exploration/action-validator.js";
import { EvidenceStore } from "../src/agents/exploration/evidence.js";
import { detectCrash } from "../src/agents/exploration/findings.js";
import { summarizeUi } from "../src/agents/exploration/observation.js";
import { runExploration } from "../src/agents/exploration/exploration-agent.js";
import { parseExplorationTask, type ExplorationTask } from "../src/agents/exploration/task.js";
import type { ActionName } from "../src/agents/exploration/actions.js";

const ALL = new Set<ActionName>(["LAUNCH_APP", "STOP_APP", "TAP", "TYPE", "SWIPE", "BACK", "HOME", "SCREENSHOT", "WAIT", "GET_UI", "GET_LOGS", "END_TEST"]);
const limits = { supported: ALL };
const PKG = "com.example.app";

const node = (text: string, l: number, t: number, r: number, b: number, clickable = true): UiNode => ({ text, desc: "", id: `${PKG}:id/${text}`, cls: "android.widget.Button", pkg: PKG, clickable, enabled: true, bounds: { l, t, r, b } });
const tap = (x: number, y: number, extra: object = {}) => ({ json: { action: "TAP", target: { x, y }, reason: "open it", ...extra } });
const end = (reason = "done") => ({ json: { action: "END_TEST", reason } });

function task(over: Partial<ExplorationTask> = {}): ExplorationTask {
  return { objective: { summary: "Explore the app" }, app: { packageName: PKG }, maxSteps: 20, timeoutMs: 5000, captureScreenshots: true, ...over };
}
function run(llm: LlmProvider, device = new MockDevice("DEVICE-05"), over: Partial<ExplorationTask> = {}, signal?: AbortSignal) {
  return runExploration({ taskId: "T-1", agentId: "MAIN-05-A", deviceId: device.id, device, llm, task: task(over), ...(signal ? { signal } : {}), log: () => undefined });
}
const hangingProvider: LlmProvider = {
  id: "hang", kind: "mock", model: "m",
  complete: (req: LlmRequest) => new Promise((_, reject) => req.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
};

// ---------- validator ----------

test("validator accepts every well-formed action", () => {
  const cases: unknown[] = [
    { action: "TAP", target: { x: 500, y: 800 }, reason: "r" },
    { action: "TYPE", text: "hello", reason: "r" },
    { action: "SWIPE", from: { x: 1, y: 2 }, to: { x: 3, y: 4 }, durationMs: 200, reason: "r" },
    { action: "SWIPE", from: { x: 1, y: 2 }, to: { x: 3, y: 4 }, reason: "r" },
    { action: "BACK", reason: "r" }, { action: "HOME", reason: "r" }, { action: "SCREENSHOT", reason: "r" },
    { action: "WAIT", ms: 500, reason: "r" }, { action: "GET_UI", reason: "r" }, { action: "GET_LOGS", reason: "r" },
    { action: "LAUNCH_APP", reason: "r" }, { action: "STOP_APP", reason: "r" }, { action: "END_TEST", reason: "done" },
  ];
  for (const c of cases) assert.equal(validateDecision(c, limits).ok, true, JSON.stringify(c));
  const swipe = validateDecision(cases[3], limits);
  assert.ok(swipe.ok && swipe.decision.action.action === "SWIPE" && swipe.decision.action.durationMs === 300);
});

test("validator rejects unknown actions, bad parameters and bad coordinates", () => {
  const bad: Array<[string, unknown, string]> = [
    ["not an object", [1], "JSON object"],
    ["unknown action", { action: "SHELL", command: "rm -rf /", reason: "r" }, "unknown action"],
    ["adb passthrough", { action: "ADB", args: ["shell", "id"], reason: "r" }, "unknown action"],
    ["missing reason", { action: "BACK" }, "reason"],
    ["tap without target", { action: "TAP", reason: "r" }, "target"],
    ["negative x", { action: "TAP", target: { x: -1, y: 5 }, reason: "r" }, "outside"],
    ["huge y", { action: "TAP", target: { x: 5, y: 10001 }, reason: "r" }, "outside"],
    ["string coordinate", { action: "TAP", target: { x: "5", y: 5 }, reason: "r" }, "finite number"],
    ["empty text", { action: "TYPE", text: "", reason: "r" }, "non-empty"],
    ["long text", { action: "TYPE", text: "a".repeat(201), reason: "r" }, "longer than"],
    ["control chars", { action: "TYPE", text: "a\nb", reason: "r" }, "control"],
    ["wait too long", { action: "WAIT", ms: 60000, reason: "r" }, "ms must be"],
    ["swipe duration", { action: "SWIPE", from: { x: 1, y: 1 }, to: { x: 2, y: 2 }, durationMs: 99999, reason: "r" }, "durationMs"],
    ["bad confidence", { action: "BACK", confidence: 3, reason: "r" }, "confidence"],
    ["bad finding", { action: "BACK", reason: "r", finding: { severity: "DOOM", title: "t", description: "d" } }, "finding.severity"],
  ];
  for (const [label, input, expected] of bad) {
    const r = validateDecision(input, limits);
    assert.ok(!r.ok && r.errors.some((e) => e.includes(expected)), `${label}: ${JSON.stringify(r)}`);
  }
});

test("validator enforces screen bounds and ignores extra keys", () => {
  const screen = { supported: ALL, screen: { width: 1080, height: 1920 } };
  assert.equal(validateDecision({ action: "TAP", target: { x: 1081, y: 5 }, reason: "r" }, screen).ok, false);
  assert.equal(validateDecision({ action: "TAP", target: { x: 1080, y: 1920 }, reason: "r" }, screen).ok, true);
  const r = validateDecision({ action: "TAP", target: { x: 1, y: 2 }, reason: "r", command: "rm -rf /", package: "evil.app" }, limits);
  assert.ok(r.ok);
  assert.deepEqual(r.decision.action, { action: "TAP", target: { x: 1, y: 2 } }); // extra keys never reach the action
});

test("validator rejects actions the device or task cannot perform", () => {
  const bare = { id: "d", tap: async () => undefined } as never;
  const sup = supportedActions(bare, false);
  for (const a of ["SWIPE", "BACK", "HOME", "GET_UI", "LAUNCH_APP", "STOP_APP"]) assert.ok(!sup.has(a as ActionName), a);
  const r = validateDecision({ action: "SWIPE", from: { x: 1, y: 1 }, to: { x: 2, y: 2 }, reason: "r" }, { supported: sup });
  assert.ok(!r.ok && r.errors[0]!.includes("not available"));
  assert.ok(supportedActions(new MockDevice(), true).has("LAUNCH_APP"));
});

test("parseJsonObject accepts bare and fenced JSON only", () => {
  assert.deepEqual(parseJsonObject('{"a":1}'), { ok: true, value: { a: 1 } });
  assert.deepEqual(parseJsonObject('```json\n{"a":1}\n```'), { ok: true, value: { a: 1 } });
  assert.equal(parseJsonObject('Sure! {"a":1}').ok, false);
  assert.equal(parseJsonObject("").ok, false);
});

test("task parsing: defaults, caps and rejection", () => {
  const ok = parseExplorationTask({ objective: "Explore", app: { packageName: PKG } });
  assert.ok(ok.ok && ok.task.maxSteps === 20 && ok.task.timeoutMs === 300_000 && ok.task.captureScreenshots);
  for (const bad of [{}, { objective: "x", maxSteps: 0 }, { objective: "x", maxSteps: 9999 }, { objective: "x", app: { packageName: "bad name; rm" } }, { objective: "x", timeoutMs: 1.5 }]) {
    assert.equal(parseExplorationTask(bad).ok, false, JSON.stringify(bad));
  }
});

// ---------- executor ----------

test("executor maps each action onto the device and records evidence", async () => {
  const d = new MockDevice("D");
  d.setUi([node("ok", 0, 0, 10, 10)]);
  const ev = new EvidenceStore("A");
  const waits: number[] = [];
  const ex = new ActionExecutor(d, { packageName: PKG, evidence: ev, sleep: async (ms) => void waits.push(ms) });
  const run1 = (a: Parameters<ActionExecutor["execute"]>[0]) => ex.execute(a, 1);
  await run1({ action: "LAUNCH_APP" });
  await run1({ action: "TAP", target: { x: 5, y: 6 } });
  await run1({ action: "TYPE", text: "hi" });
  await run1({ action: "SWIPE", from: { x: 1, y: 2 }, to: { x: 3, y: 4 }, durationMs: 250 });
  await run1({ action: "BACK" });
  await run1({ action: "HOME" });
  await run1({ action: "STOP_APP" });
  const shot = await run1({ action: "SCREENSHOT" });
  const ui = await run1({ action: "GET_UI" });
  const logs = await run1({ action: "GET_LOGS" });
  await run1({ action: "WAIT", ms: 700 });
  assert.deepEqual(d.trace, [`launch:${PKG}`, "tap:5,6", "type:hi", "swipe:1,2>3,4@250", "key:BACK", "key:HOME"]);
  assert.deepEqual(waits, [700]);
  assert.ok(shot.ok && shot.evidenceIds.length === 1 && ev.get(shot.evidenceIds[0]!)!.kind === "screenshot");
  assert.equal(ui.ui!.length, 1);
  assert.ok(logs.ok);
});

test("executor reports failures without throwing and flags device errors", async () => {
  const d = new MockDevice("D");
  const ex = new ActionExecutor(d, { packageName: PKG, evidence: new EvidenceStore("A") });
  d.setState("OFFLINE");
  const r = await ex.execute({ action: "TAP", target: { x: 1, y: 1 } }, 1);
  assert.ok(!r.ok && r.deviceError && r.evidenceIds.length === 1);
  const noPkg = await new ActionExecutor(new MockDevice(), { evidence: new EvidenceStore("A") }).execute({ action: "LAUNCH_APP" }, 1);
  assert.ok(!noPkg.ok && !noPkg.deviceError && /no app package/.test(noPkg.detail));
});

test("executor has no path to arbitrary commands", async () => {
  const d = new MockDevice("D");
  const ex = new ActionExecutor(d, { packageName: PKG, evidence: new EvidenceStore("A") });
  const r = await ex.execute({ action: "SHELL", command: "rm -rf /" } as never, 1);
  assert.ok(!r.ok && /unhandled/.test(r.detail));
  assert.deepEqual(d.trace, []);
  assert.deepEqual(d.calls, []);
});

test("crash detection finds obvious markers only", () => {
  assert.equal(detectCrash("E/AndroidRuntime: FATAL EXCEPTION: main\nat x")?.title, "Application crash (fatal exception)");
  assert.equal(detectCrash("ActivityManager: ANR in com.example")?.title, "Application not responding (ANR)");
  assert.equal(detectCrash("I/app: all good"), undefined);
  const s = summarizeUi([node("Login", 0, 0, 100, 40), node("", 0, 0, 1, 1, false)]);
  assert.deepEqual(s.elements, [{ x: 50, y: 20, clickable: true, text: "Login", id: "Login", cls: "Button" }]);
  assert.equal(s.foreground, PKG);
});

// ---------- agent loop ----------

test("miniature loop: task -> LLM -> TAP -> device -> observation -> LLM -> END_TEST -> result", async () => {
  const device = new MockDevice("DEVICE-05");
  device.setUi([node("Menu", 100, 200, 300, 280)]);
  const llm = MockProvider.scripted([tap(200, 240), end("explored the menu")]);
  const r = await run(llm, device);

  assert.deepEqual(device.trace, ["tap:200,240"]);
  assert.equal(r.status, "PASSED");
  assert.deepEqual([r.taskId, r.agentId, r.deviceId, r.steps], ["T-1", "MAIN-05-A", "DEVICE-05", 1]);
  assert.equal(r.telemetry.llmCalls, 2);
  assert.deepEqual([r.telemetry.inputTokens, r.telemetry.outputTokens], [20, 10]);
  assert.ok(r.startedAt <= r.completedAt && r.evidence.length >= 3 && r.actionLog.length === 1);
  assert.match(r.summary, /explored the menu/);
  assert.match(r.summary, /unverified/);

  // the model saw text only: UI with tap targets, the previous result, evidence ids, never image bytes
  const [first, second] = llm.requests;
  assert.ok(first!.system!.includes("exploration tester") && first!.jsonSchema!.name === "agent_decision");
  const msg2 = second!.messages[0]!.content;
  assert.ok(msg2.includes('"x": 200') === false || msg2.includes("Menu"));
  assert.match(msg2, /tapped \(200, 240\)/);
  assert.match(msg2, /EV-\d{3}/);
  assert.ok(!msg2.includes(Buffer.from("mock-png").toString("base64")));
  assert.match(first!.messages[0]!.content, /"stepsRemaining": 20/);
});

test("launch uses the configured package and ignores any package the model names", async () => {
  const device = new MockDevice("D");
  const r = await run(MockProvider.scripted([{ json: { action: "LAUNCH_APP", reason: "start", package: "evil.app" } }, end()]), device);
  assert.deepEqual(device.trace, [`launch:${PKG}`]);
  assert.equal(r.status, "PASSED");
});

test("maxSteps is enforced by the runtime: action 4 is never requested or executed", async () => {
  const device = new MockDevice("D");
  let n = 0;
  const llm = MockProvider.scripted([() => JSON.stringify({ action: "TAP", target: { x: ++n, y: n }, reason: "again" })]);
  const r = await run(llm, device, { maxSteps: 3 });
  assert.equal(r.status, "MAX_STEPS_REACHED");
  assert.equal(r.steps, 3);
  assert.equal(device.trace.length, 3);
  assert.equal(r.telemetry.llmCalls, 3);
  assert.equal(llm.requests.length, 3);
});

test("the same action chosen over and over stops the run, with a warning first", async () => {
  const llm = MockProvider.scripted([tap(5, 5)]);
  const device = new MockDevice("D");
  const r = await run(llm, device);
  assert.equal(r.status, "ERROR");
  assert.match(r.summary, /same action/);
  assert.equal(device.trace.length, 5);
  assert.ok(llm.requests.some((q) => q.messages[0]!.content.includes("repeated the same action")));
});

test("timeout yields a controlled TIMEOUT result and keeps evidence", async () => {
  const r = await run(hangingProvider, new MockDevice("D"), { timeoutMs: 40 });
  assert.equal(r.status, "TIMEOUT");
  assert.ok(r.evidence.length > 0);
  assert.ok(r.telemetry.durationMs >= 30 && r.telemetry.durationMs < 2000);
});

test("cancellation stops safely and preserves evidence", async () => {
  const ac = new AbortController();
  const device = new MockDevice("D");
  const llm = MockProvider.scripted([() => (ac.abort(), JSON.stringify({ action: "TAP", target: { x: 1, y: 1 }, reason: "r" }))]);
  const r = await run(llm, device, {}, ac.signal);
  assert.equal(r.status, "CANCELLED");
  assert.deepEqual(device.trace, []);
  assert.ok(r.evidence.length > 0);

  const pre = new AbortController();
  pre.abort();
  const never = MockProvider.scripted([end()]);
  const r2 = await run(never, new MockDevice("D"), {}, pre.signal);
  assert.equal(r2.status, "CANCELLED");
  assert.equal(never.requests.length, 0);
});

test("malformed output gets exactly one correction, then a controlled ERROR", async () => {
  const llm = MockProvider.scripted(["I think we should tap the button", "still prose"]);
  const device = new MockDevice("D");
  const r = await run(llm, device);
  assert.equal(r.status, "ERROR");
  assert.equal(r.telemetry.llmCalls, 2);
  assert.equal(r.telemetry.malformedResponses, 2);
  assert.deepEqual(device.trace, []);
  const retry = llm.requests[1]!.messages;
  assert.equal(retry.length, 3);
  assert.match(retry[2]!.content, /rejected/);
});

test("a corrected response is accepted; a rejected action is never executed", async () => {
  const llm = MockProvider.scripted([{ json: { action: "SHELL", command: "id", reason: "r" } }, end("ok")]);
  const device = new MockDevice("D");
  const r = await run(llm, device);
  assert.equal(r.status, "PASSED");
  assert.equal(r.telemetry.llmCalls, 2);
  assert.deepEqual(device.trace, []);
});

test("provider failure produces a controlled result", async () => {
  const r = await run(MockProvider.scripted([{ error: new ProviderError("AUTH", "bad key", "mock") }]));
  assert.equal(r.status, "ERROR");
  assert.equal(r.telemetry.providerErrors, 1);
  assert.match(r.summary, /AUTH/);
});

test("device lost mid-run -> BLOCKED with evidence kept; device offline at start -> BLOCKED", async () => {
  const device = new MockDevice("D");
  const llm = MockProvider.scripted([() => (device.setState("OFFLINE"), JSON.stringify({ action: "TAP", target: { x: 1, y: 1 }, reason: "r" }))]);
  const r = await run(llm, device);
  assert.equal(r.status, "BLOCKED");
  assert.ok(r.evidence.length > 0 && r.telemetry.deviceErrors >= 1);

  const off = new MockDevice("D");
  off.setState("OFFLINE");
  const llm2 = MockProvider.scripted([end()]);
  assert.equal((await run(llm2, off)).status, "BLOCKED");
  assert.equal(llm2.requests.length, 0);
});

test("a transient device error is shown to the model, which can recover", async () => {
  class Flaky extends MockDevice {
    private failed = false;
    override async tap(x: number, y: number): Promise<void> {
      if (!this.failed) {
        this.failed = true;
        throw new DeviceError("tap rejected", this.id);
      }
      return super.tap(x, y);
    }
  }
  const device = new Flaky("D");
  const llm = MockProvider.scripted([tap(1, 1), tap(2, 2), end()]);
  const r = await run(llm, device);
  assert.equal(r.status, "PASSED");
  assert.equal(r.telemetry.actionFailures, 1);
  assert.equal(r.actionLog[0]!.ok, false);
  assert.match(llm.requests[1]!.messages[0]!.content, /tap rejected/);
  assert.deepEqual(device.trace, ["tap:2,2"]);
});

test("a crash in the logs becomes a verified finding with evidence, is shown to the model, and fails the run", async () => {
  const device = new MockDevice("D");
  const llm = MockProvider.scripted([
    () => (device.appendLog("E/AndroidRuntime: FATAL EXCEPTION: main\nat com.example.Boom"), JSON.stringify({ action: "TAP", target: { x: 9, y: 9 }, reason: "press boom" })),
    () => JSON.stringify({ action: "GET_LOGS", reason: "re-check" }),
    end("crash seen"),
  ]);
  const r = await run(llm, device);
  assert.equal(r.status, "FAILED");
  assert.equal(r.findings.length, 1); // same crash line is not reported twice
  const f = r.findings[0]!;
  assert.deepEqual([f.source, f.severity, f.agentId, f.step], ["VERIFIED", "CRITICAL", "MAIN-05-A", 1]);
  assert.ok(f.evidenceIds.length >= 1 && f.evidenceIds.every((id) => r.evidence.some((e) => e.id === id)));
  assert.match(llm.requests[1]!.messages[0]!.content, /CRASH DETECTED/);
});

test("AI-suggested findings are marked unverified and never fail the run", async () => {
  const llm = MockProvider.scripted([{ json: { action: "END_TEST", reason: "done", finding: { severity: "HIGH", title: "Button looks broken", description: "No visible label" } } }]);
  const r = await run(llm);
  assert.equal(r.status, "PASSED");
  assert.deepEqual(r.findings.map((f) => [f.source, f.severity]), [["AI_OBSERVATION", "HIGH"]]);
});
