import { test } from "node:test";
import assert from "node:assert/strict";
import type { TaskHandler } from "../src/agents/managed-agent.js";
import { newTask } from "../src/agents/base.js";
import { lab } from "./helpers.js";

const ok: TaskHandler = { requires: [], handle: async () => ({ status: "PASSED", summary: "ok", evidence: [] }) };

test("orchestrator rejects unknown agents and direct SUB dispatch", async () => {
  const { orchestrator, bus } = lab();
  assert.equal((await orchestrator.dispatch("MAIN-99", "x", {})).status, "ERROR");
  const t = await orchestrator.dispatch("MAIN-01-B", "smoke", {});
  assert.equal(t.status, "ERROR");
  assert.match(t.errors[0]!, /SUB agent/);
  assert.equal(bus.history({ type: "ERROR" }).length, 2);
});

test("PAUSED and OFFLINE agents refuse tasks; resume restores them", async () => {
  const { orchestrator, registry } = lab({ behaviors: { "MAIN-03-A": { probe: ok } } });
  const main = registry.require("MAIN-03");
  main.pause();
  assert.equal(registry.getStatus("MAIN-03"), "PAUSED");
  assert.equal((await orchestrator.dispatch("MAIN-03", "probe", {})).status, "BLOCKED");
  assert.throws(() => registry.require("MAIN-03-B").resume(), /not paused/);
  main.resume();
  assert.equal((await orchestrator.dispatch("MAIN-03", "probe", {})).status, "PASSED");

  const sub = registry.require("MAIN-03-A");
  sub.setOffline();
  const t = await orchestrator.dispatch("MAIN-03", "probe", {});
  assert.equal(t.status, "BLOCKED"); // child refused
  sub.setOnline();
  assert.equal((await orchestrator.dispatch("MAIN-03", "probe", {})).status, "PASSED");
});

test("a busy agent refuses a second task", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const slow: TaskHandler = { requires: [], handle: async () => (await gate, { status: "PASSED", summary: "", evidence: [] }) };
  const { registry } = lab({ behaviors: { "MAIN-03-A": { slow } } });
  const sub = registry.require("MAIN-03-A");

  const first = sub.run(newTask(sub.id, "slow", {}));
  assert.equal(sub.status, "EXECUTING");
  const second = await sub.run(newTask(sub.id, "slow", {}));
  assert.equal(second.status, "BLOCKED");
  assert.throws(() => sub.pause(), /busy/);
  release();
  assert.equal((await first).status, "PASSED");
  assert.equal(sub.status, "IDLE");
});

test("unexpected exception -> task ERROR, agent ERROR, next task recovers", async () => {
  let boom = true;
  const flaky: TaskHandler = {
    requires: [],
    handle: async () => {
      if (boom) throw new Error("kaput");
      return { status: "PASSED", summary: "", evidence: [] };
    },
  };
  const { registry, orchestrator } = lab({ behaviors: { "MAIN-03-A": { flaky } } });
  const t = await orchestrator.dispatch("MAIN-03", "flaky", {});
  assert.equal(t.status, "ERROR"); // child ERROR propagates
  assert.equal(registry.getStatus("MAIN-03-A"), "ERROR");
  assert.equal(registry.getStatus("MAIN-03"), "IDLE"); // failure isolated from other agents

  boom = false;
  assert.equal((await orchestrator.dispatch("MAIN-03", "flaky", {})).status, "PASSED");
  assert.equal(registry.getStatus("MAIN-03-A"), "IDLE");
});

test("a throwing bus subscriber does not break execution", async () => {
  const { orchestrator, bus } = lab({ behaviors: { "MAIN-03-A": { probe: ok } } });
  bus.subscribe(() => {
    throw new Error("bad subscriber");
  });
  assert.equal((await orchestrator.dispatch("MAIN-03", "probe", {})).status, "PASSED");
});
