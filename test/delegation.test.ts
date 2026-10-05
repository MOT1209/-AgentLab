import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregateStatus } from "../src/agents/aggregate.js";
import type { TaskHandler } from "../src/agents/managed-agent.js";
import type { AgentResult, TaskStatus } from "../src/agents/types.js";
import { lab, smokePayload } from "./helpers.js";

const fixed = (status: TaskStatus, requires: TaskHandler["requires"] = ["tap"]): TaskHandler => ({
  requires,
  handle: async () => ({ status, summary: `done ${status}`, evidence: [{ kind: "log", data: "x" }] }),
});

test("aggregateStatus precedence", () => {
  const cases: Array<[TaskStatus[], TaskStatus]> = [
    [[], "BLOCKED"],
    [["PASSED", "PASSED"], "PASSED"],
    [["PASSED", "SKIPPED"], "PASSED"],
    [["SKIPPED", "SKIPPED"], "SKIPPED"],
    [["PASSED", "BLOCKED"], "BLOCKED"],
    [["BLOCKED", "ERROR"], "ERROR"],
    [["ERROR", "FAILED", "PASSED"], "FAILED"],
    [["PASSED", "RUNNING"], "ERROR"],
  ];
  for (const [input, expected] of cases) assert.equal(aggregateStatus(input), expected, input.join());
});

test("MAIN delegates to every capable child, propagates results, evidence and messages", async () => {
  const { orchestrator, bus } = lab({
    behaviors: { "MAIN-02-A": { probe: fixed("PASSED") }, "MAIN-02-B": { probe: fixed("FAILED") } },
  });
  const t = await orchestrator.dispatch("MAIN-02", "probe", {});
  const r = t.result as AgentResult;
  assert.equal(t.status, "FAILED");
  assert.deepEqual(r.children?.map((c) => [c.agentId, c.status]), [["MAIN-02-A", "PASSED"], ["MAIN-02-B", "FAILED"]]);
  assert.deepEqual(r.evidence.map((e) => e.source), ["MAIN-02-A", "MAIN-02-B"]);

  const assigned = bus.history({ type: "TASK_ASSIGNED" });
  assert.deepEqual(assigned.map((m) => `${m.from}>${m.to}`), ["ORCHESTRATOR>MAIN-02", "MAIN-02>MAIN-02-A", "MAIN-02>MAIN-02-B"]);
  const results = bus.history({ type: "TASK_RESULT" });
  assert.deepEqual(results.map((m) => `${m.from}>${m.to}`), ["MAIN-02-A>MAIN-02", "MAIN-02-B>MAIN-02", "MAIN-02>ORCHESTRATOR"]);
});

test("child tasks reference the parent task", async () => {
  const seen: Array<string | undefined> = [];
  const h: TaskHandler = { requires: [], handle: async ({ task }) => (seen.push(task.parent_task_id), { status: "PASSED", summary: "", evidence: [] }) };
  const { orchestrator } = lab({ behaviors: { "MAIN-03-A": { probe: h } } });
  const t = await orchestrator.dispatch("MAIN-03", "probe", {});
  assert.deepEqual(seen, [t.task_id]);
});

test("MAIN status goes through PLANNING, WAITING, REVIEWING and returns to IDLE", async () => {
  const { orchestrator, bus, registry } = lab({ behaviors: { "MAIN-03-A": { probe: fixed("PASSED") } } });
  await orchestrator.dispatch("MAIN-03", "probe", {});
  const to = bus.history({ type: "STATUS_CHANGED", from: "MAIN-03" }).map((m) => (m.payload as { to: string }).to);
  assert.deepEqual(to, ["EXECUTING", "PLANNING", "WAITING", "REVIEWING", "IDLE"]);
  assert.equal(registry.getStatus("MAIN-03"), "IDLE");
});

test("no capable child -> BLOCKED; SUB without handler -> BLOCKED", async () => {
  const { orchestrator, registry } = lab();
  const t = await orchestrator.dispatch("MAIN-02", "smoke", smokePayload);
  assert.equal(t.status, "BLOCKED");
  assert.match((t.result as AgentResult).summary, /no sub-agent can handle/);
  assert.equal(registry.require("MAIN-02").canHandle("smoke"), false);
});

test("handler requiring a capability the agent lacks is BLOCKED", async () => {
  const { orchestrator } = lab({ behaviors: { "MAIN-03-A": { probe: fixed("PASSED", ["install_app"]) } } });
  const t = await orchestrator.dispatch("MAIN-03", "probe", {});
  assert.equal(t.status, "BLOCKED");
  assert.match((t.result as AgentResult).children![0]!.summary, /lacks capabilities: install_app/);
});

test("end to end smoke through the default behaviors", async () => {
  const { orchestrator, device } = lab();
  const t = await orchestrator.dispatch("MAIN-01", "smoke", smokePayload);
  assert.equal(t.status, "PASSED");
  assert.deepEqual((t.result as AgentResult).evidence.map((e) => e.source), ["MAIN-01-B", "MAIN-01-B"]);
  assert.equal(device.isRunning(smokePayload.packageName), false);
});

test("offline device -> BLOCKED, agents return to IDLE", async () => {
  const { orchestrator, device, registry } = lab();
  device.setState("OFFLINE");
  const t = await orchestrator.dispatch("MAIN-01", "smoke", smokePayload);
  assert.equal(t.status, "BLOCKED");
  assert.equal(registry.getStatus("MAIN-01-B"), "IDLE");
});
