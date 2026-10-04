import { test } from "node:test";
import assert from "node:assert/strict";
import { MockDevice } from "../src/device/mock-device.js";
import { CoreFeatureTester, FunctionalTester } from "../src/agents/functional.js";
import { Orchestrator } from "../src/orchestrator.js";

const payload = { apkPath: "app.apk", packageName: "com.example.app" };

function setup() {
  const device = new MockDevice();
  const orch = new Orchestrator();
  orch.register(new FunctionalTester("01", device, new CoreFeatureTester("01-B", device)));
  return { device, orch };
}

test("smoke test passes on healthy device with evidence", async () => {
  const { device, orch } = setup();
  const t = await orch.dispatch("01", "smoke", payload);
  assert.equal(t.status, "PASSED");
  assert.equal((t.result as { evidence: unknown[] }).evidence.length, 2);
  assert.equal(device.isRunning("com.example.app"), false);
});

test("offline device yields BLOCKED, does not throw", async () => {
  const { device, orch } = setup();
  device.setState("OFFLINE");
  const t = await orch.dispatch("01", "smoke", payload);
  assert.equal(t.status, "BLOCKED");
});

test("unknown agent yields ERROR", async () => {
  const { orch } = setup();
  const t = await orch.dispatch("99", "smoke", payload);
  assert.equal(t.status, "ERROR");
});

test("duplicate agent registration is rejected", () => {
  const { device, orch } = setup();
  assert.throws(() => orch.register(new FunctionalTester("01", device, new CoreFeatureTester("x", device))));
});
