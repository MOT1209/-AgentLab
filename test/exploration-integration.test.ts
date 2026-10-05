import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockFleet } from "../src/device/mock-device.js";
import { AdbDevice } from "../src/device/adb-device.js";
import { parseUiAutomatorXml } from "../src/device/ui-parse.js";
import { initializeAgentLab } from "../src/bootstrap.js";
import { MockProvider } from "../src/providers/mock-provider.js";
import { ProviderManager } from "../src/providers/manager.js";
import type { LlmProvider, LlmRequest } from "../src/providers/types.js";
import type { AgentResult } from "../src/agents/types.js";
import type { ExplorationResult } from "../src/agents/exploration/result.js";

const PKG = "com.example.app";
const payload = { objective: "Explore the application", app: { packageName: PKG }, maxSteps: 5 };
const script = () => MockProvider.scripted([
  { json: { action: "LAUNCH_APP", reason: "start the app" } },
  { json: { action: "TAP", target: { x: 540, y: 960 }, reason: "open main menu" } },
  { json: { action: "END_TEST", reason: "explored" } },
]);

function build(llm?: LlmProvider) {
  const fleet = createMockFleet(12);
  let providers: ProviderManager | undefined;
  if (llm) {
    providers = new ProviderManager();
    providers.register(llm);
  }
  const rt = initializeAgentLab({ devices: fleet, ...(providers ? { providers } : {}) });
  return { ...rt, fleet };
}
const details = (t: { result?: unknown }) => (t.result as AgentResult).children![0]!.details as ExplorationResult;

test("MAIN-05 -> MAIN-05-A explores on MAIN-05's leased device and releases it", async () => {
  const { orchestrator, fleet, devices } = build(script());
  const t = await orchestrator.dispatch("MAIN-05", "explore", payload);
  assert.equal(t.status, "PASSED");
  const d = details(t);
  assert.deepEqual([d.status, d.agentId, d.deviceId, d.steps], ["PASSED", "MAIN-05-A", "DEVICE-05", 2]);
  assert.deepEqual(fleet[4]!.trace, [`launch:${PKG}`, "tap:540,960"]);
  assert.ok(fleet.filter((_, i) => i !== 4).every((f) => f.trace.length === 0));
  assert.equal(devices.describe("DEVICE-05")!.lock, "FREE");
  assert.equal(devices.pool.recentLeases().at(-1)!.status, "RELEASED");
  const child = (t.result as AgentResult).children![0]!;
  assert.deepEqual([child.agentId, child.status], ["MAIN-05-A", "PASSED"]);
});

test("MAIN-05-B has no exploration behavior and stays BLOCKED", async () => {
  const { registry } = build(script());
  assert.equal(registry.require("MAIN-05-B").canHandle("explore"), false);
  assert.equal(registry.require("MAIN-05-A").canHandle("explore"), true);
});

test("without an LLM provider the agent is BLOCKED, not faking a result", async () => {
  const { orchestrator, fleet } = build();
  const t = await orchestrator.dispatch("MAIN-05", "explore", payload);
  assert.equal(t.status, "BLOCKED");
  assert.match((t.result as AgentResult).children![0]!.summary, /no LLM provider/);
  assert.equal(fleet[4]!.trace.length, 0);
});

test("an invalid task payload is an ERROR and touches nothing", async () => {
  const { orchestrator, fleet, devices } = build(script());
  const t = await orchestrator.dispatch("MAIN-05", "explore", { maxSteps: 0 });
  assert.equal(t.status, "ERROR");
  assert.match((t.result as AgentResult).children![0]!.summary, /Invalid exploration task/);
  assert.equal(fleet[4]!.trace.length, 0);
  assert.equal(devices.describe("DEVICE-05")!.lock, "FREE");
});

test("cancelling through the orchestrator stops the run and leaves no stale lease", async () => {
  const hanging: LlmProvider = {
    id: "hang", kind: "mock", model: "m",
    complete: (req: LlmRequest) => new Promise((_, reject) => req.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
  };
  const { orchestrator, devices } = build(hanging);
  const ac = new AbortController();
  const running = orchestrator.dispatch("MAIN-05", "explore", payload, { signal: ac.signal });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(devices.describe("DEVICE-05")!.lock, "BUSY");
  ac.abort();
  const t = await running;
  assert.equal(details(t).status, "CANCELLED");
  assert.equal(t.status, "SKIPPED");
  assert.equal(devices.describe("DEVICE-05")!.lock, "FREE");

  const pre = new AbortController();
  pre.abort();
  assert.equal((await orchestrator.dispatch("MAIN-05", "explore", payload, { signal: pre.signal })).status, "SKIPPED");
});

test("a timeout through the handler releases the device", async () => {
  const hanging: LlmProvider = {
    id: "hang", kind: "mock", model: "m",
    complete: (req: LlmRequest) => new Promise((_, reject) => req.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
  };
  const { orchestrator, devices } = build(hanging);
  const t = await orchestrator.dispatch("MAIN-05", "explore", { ...payload, timeoutMs: 40 });
  assert.equal(details(t).status, "TIMEOUT");
  assert.equal(t.status, "BLOCKED");
  assert.equal(devices.describe("DEVICE-05")!.lock, "FREE");
});

test("a verified crash makes the platform-level task FAILED even if the agent ends normally", async () => {
  const llm = MockProvider.scripted([
    () => JSON.stringify({ action: "TAP", target: { x: 1, y: 1 }, reason: "press" }),
    { json: { action: "END_TEST", reason: "done" } },
  ]);
  const { orchestrator, fleet } = build(llm);
  fleet[4]!.appendLog("E/AndroidRuntime: FATAL EXCEPTION: main");
  const t = await orchestrator.dispatch("MAIN-05", "explore", payload);
  assert.equal(t.status, "FAILED");
  assert.equal(details(t).findings[0]!.source, "VERIFIED");
});

// ---------- UI parsing and AdbDevice plumbing (no real adb) ----------

const XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">
<node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.example.app" clickable="false" enabled="true" bounds="[0,0][1080,1920]">
<node index="0" text="Sign &amp; go" resource-id="com.example.app:id/login" class="android.widget.Button" package="com.example.app" content-desc="Login" clickable="true" enabled="true" bounds="[100,200][300,280]" />
</node></hierarchy>
UI hierarchy dumped to: /dev/tty`;

test("uiautomator XML is parsed into nodes", () => {
  const nodes = parseUiAutomatorXml(XML);
  assert.equal(nodes.length, 2);
  assert.deepEqual(nodes[1], { text: "Sign & go", desc: "Login", id: "com.example.app:id/login", cls: "android.widget.Button", pkg: PKG, clickable: true, enabled: true, bounds: { l: 100, t: 200, r: 300, b: 280 } });
});

test("AdbDevice builds fixed argument lists for the new operations (fake adb binary)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fakeadb-"));
  const bin = join(dir, "adb");
  const argLog = join(dir, "args.txt");
  const xmlFile = join(dir, "ui.xml");
  writeFileSync(xmlFile, XML);
  writeFileSync(bin, `#!/bin/sh\nprintf '%s ' "$@" >> "${argLog}"\nprintf '\\n' >> "${argLog}"\ncase "$*" in *uiautomator*) cat "${xmlFile}";; esac\n`);
  chmodSync(bin, 0o755);

  const adb = new AdbDevice("emulator-5554", bin);
  assert.equal(adb.source, "EMULATOR");
  await adb.swipe(10.9, 20, 30, 40, 250);
  await adb.pressKey("BACK");
  await adb.pressKey("HOME");
  await adb.clearLogs();
  const nodes = await adb.ui();
  assert.equal(nodes.length, 2);
  await assert.rejects(adb.swipe(-1, 0, 5, 5), /non-negative integers/);
  await assert.rejects(adb.pressKey("POWER; reboot" as never), /unsupported key/);
  await assert.rejects(adb.launch("com.x; rm -rf /"), /invalid package/);

  const lines = readFileSync(argLog, "utf8").trim().split("\n").map((l) => l.trimEnd());
  assert.deepEqual(lines, [
    "-s emulator-5554 shell input swipe 10 20 30 40 250",
    "-s emulator-5554 shell input keyevent KEYCODE_BACK",
    "-s emulator-5554 shell input keyevent KEYCODE_HOME",
    "-s emulator-5554 logcat -c",
    "-s emulator-5554 exec-out uiautomator dump /dev/tty",
  ]);
});
