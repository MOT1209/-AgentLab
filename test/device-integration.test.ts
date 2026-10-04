import { test } from "node:test";
import assert from "node:assert/strict";
import { createMockFleet } from "../src/device/mock-device.js";
import { initializeAgentLab } from "../src/bootstrap.js";
import { newTask } from "../src/agents/base.js";
import type { TaskHandler } from "../src/agents/managed-agent.js";
import type { AgentResult } from "../src/agents/types.js";
import { lab, smokePayload } from "./helpers.js";

const ok: TaskHandler = { requires: [], handle: async () => ({ status: "PASSED", summary: "ok", evidence: [] }) };
const whereAmI: TaskHandler = {
  requires: ["screenshot"],
  handle: async ({ device, runtime }) => ({ status: "PASSED", summary: `${device.id}|${runtime.mainAgentId}|${runtime.agentId}`, evidence: [] }),
};

test("auto assignment: MAIN-01..12 -> DEVICE-01..12, subs have no assignment of their own", () => {
  const { devices } = lab();
  const a = devices.listAssignments();
  assert.equal(a.length, 12);
  for (let i = 1; i <= 12; i++) {
    const n = String(i).padStart(2, "0");
    assert.equal(devices.getAssignment(`MAIN-${n}`)!.deviceId, `DEVICE-${n}`);
    assert.equal(devices.getAssignment(`MAIN-${n}-A`), undefined);
  }
  assert.equal(new Set(a.map((x) => x.assignmentId)).size, 12);
});

test("both sub-agents run on their parent's device and see the same runtime context", async () => {
  const { orchestrator, fleet } = lab({
    behaviors: { "MAIN-05-A": { probe: whereAmI }, "MAIN-05-B": { probe: whereAmI } },
  });
  const t = await orchestrator.dispatch("MAIN-05", "probe", {});
  assert.equal(t.status, "PASSED");
  const sums = (t.result as AgentResult).children!.map((c) => c.summary);
  assert.deepEqual(sums, ["DEVICE-05|MAIN-05|MAIN-05-A", "DEVICE-05|MAIN-05|MAIN-05-B"]);
  assert.equal(fleet[4]!.id, "DEVICE-05");
});

test("device operations hit only the parent's device", async () => {
  const { orchestrator, fleet } = lab();
  await orchestrator.dispatch("MAIN-01", "smoke", smokePayload);
  assert.ok(fleet[0]!.calls.includes("install"));
  assert.ok(fleet.slice(1).every((d) => d.calls.length === 0));
});

test("lease lifecycle during a run: BUSY while executing, FREE afterwards", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const seen: string[] = [];
  const slow: TaskHandler = {
    requires: [],
    handle: async ({ runtime }) => {
      seen.push(runtime.leaseId);
      await gate;
      return { status: "PASSED", summary: "", evidence: [] };
    },
  };
  const { orchestrator, devices } = lab({ behaviors: { "MAIN-03-A": { slow } } });
  const running = orchestrator.dispatch("MAIN-03", "slow", {});
  await new Promise((r) => setImmediate(r));
  const snap = devices.describe("DEVICE-03")!;
  assert.equal(snap.lock, "BUSY");
  assert.deepEqual(snap.leaseOwner, { id: "MAIN-03", type: "AGENT" });
  assert.equal(snap.leaseId, seen[0]);
  release();
  assert.equal((await running).status, "PASSED");
  assert.equal(devices.describe("DEVICE-03")!.lock, "FREE");
});

test("different MAIN agents run concurrently on different devices", async () => {
  let inFlight = 0;
  let peak = 0;
  const probe: TaskHandler = {
    requires: [],
    handle: async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return { status: "PASSED", summary: "", evidence: [] };
    },
  };
  const { orchestrator, devices } = lab({ behaviors: { "MAIN-02-A": { probe }, "MAIN-03-A": { probe }, "MAIN-04-A": { probe } } });
  const all = await Promise.all(["MAIN-02", "MAIN-03", "MAIN-04"].map((m) => orchestrator.dispatch(m, "probe", {})));
  assert.ok(all.every((t) => t.status === "PASSED"));
  assert.equal(peak, 3);
  assert.ok(devices.snapshot().every((d) => d.lock === "FREE"));
});

test("a device held by someone else gives a controlled BLOCKED, and its lock is untouched", async () => {
  const { orchestrator, devices } = lab();
  const held = devices.lock("DEVICE-01", { id: "ops", type: "SYSTEM" });
  assert.ok(held.ok);
  const t = await orchestrator.dispatch("MAIN-01", "smoke", smokePayload);
  assert.equal(t.status, "BLOCKED");
  assert.match((t.result as AgentResult).summary, /SYSTEM:ops/);
  assert.deepEqual(devices.describe("DEVICE-01")!.leaseOwner, { id: "ops", type: "SYSTEM" });
});

test("lease is released even when a sub-agent throws", async () => {
  const boom: TaskHandler = { requires: [], handle: async () => { throw new Error("kaput"); } };
  const { orchestrator, devices } = lab({ behaviors: { "MAIN-03-A": { boom } } });
  assert.equal((await orchestrator.dispatch("MAIN-03", "boom", {})).status, "ERROR");
  assert.equal(devices.describe("DEVICE-03")!.lock, "FREE");
});

test("unready device: BLOCKED, never leased", async () => {
  const { orchestrator, devices, device } = lab();
  device.setState("OFFLINE");
  const t = await orchestrator.dispatch("MAIN-01", "smoke", smokePayload);
  assert.equal(t.status, "BLOCKED");
  assert.match((t.result as AgentResult).summary, /not ready/);
  assert.equal(devices.pool.recentLeases().length, 0);
});

test("MAIN without an assigned device is BLOCKED", async () => {
  const { orchestrator } = initializeAgentLab({ devices: createMockFleet(1), behaviors: { "MAIN-02-A": { probe: ok } } });
  assert.equal((await orchestrator.dispatch("MAIN-01", "smoke", smokePayload)).status, "PASSED");
  const t = await orchestrator.dispatch("MAIN-02", "probe", {});
  assert.equal(t.status, "BLOCKED");
  assert.match((t.result as AgentResult).summary, /no device assigned/);
});

test("sub-agent run outside its parent's lease is BLOCKED", async () => {
  const { registry } = lab({ behaviors: { "MAIN-03-A": { probe: ok } } });
  const sub = registry.require("MAIN-03-A");
  const t = await sub.run(newTask(sub.id, "probe", {}));
  assert.equal(t.status, "BLOCKED");
  assert.match((t.result as AgentResult).summary, /no active device lease/);
});

test("handler needing a device capability the device lacks is BLOCKED", async () => {
  const rec: TaskHandler = { requires: ["screen_recording"], handle: async () => ({ status: "PASSED", summary: "", evidence: [] }) };
  const { orchestrator } = lab({ behaviors: { "MAIN-02-A": { record: rec } } });
  const t = await orchestrator.dispatch("MAIN-02", "record", {});
  assert.equal(t.status, "BLOCKED");
  assert.match((t.result as AgentResult).children![0]!.summary, /does not support: screen_recording/);
});

test("explicit assignments, reassignment and SUB rejection", async () => {
  const rt = initializeAgentLab({
    devices: createMockFleet(3),
    assignments: { "MAIN-07": "DEVICE-03", "MAIN-01": "DEVICE-01" },
    behaviors: { "MAIN-07-A": { probe: whereAmI } },
  });
  assert.equal(rt.devices.getAssignment("MAIN-07")!.deviceId, "DEVICE-03");
  assert.equal(rt.devices.getAssignment("MAIN-02"), undefined);
  assert.equal((await rt.orchestrator.dispatch("MAIN-07", "probe", {})).status, "PASSED");

  rt.reassignDevice("MAIN-07", "DEVICE-02");
  const t = await rt.orchestrator.dispatch("MAIN-07", "probe", {});
  assert.match((t.result as AgentResult).children![0]!.summary, /^DEVICE-02\|/);

  assert.throws(() => rt.assignDevice("MAIN-07-A", "DEVICE-02"), /SUB agent/);
  assert.throws(() => rt.assignDevice("MAIN-99", "DEVICE-02"), /unknown agent/);
  assert.throws(() => rt.assignDevice("MAIN-02", "DEVICE-02"), /already assigned to MAIN-07/);
});

test("initializeAgentLab requires devices; assignments 'none' leaves everything unassigned", () => {
  assert.throws(() => initializeAgentLab({}), /provide `devices`/);
  const rt = initializeAgentLab({ devices: createMockFleet(12), assignments: "none" });
  assert.equal(rt.devices.listAssignments().length, 0);
});
