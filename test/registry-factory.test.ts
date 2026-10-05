import { test } from "node:test";
import assert from "node:assert/strict";
import { createMockFleet } from "../src/device/mock-device.js";
import { DeviceManager } from "../src/runtime/device-manager.js";
import { AgentRegistry } from "../src/agents/registry.js";
import { AgentFactory } from "../src/agents/factory.js";
import { CANONICAL_DEFINITIONS } from "../src/agents/organization.js";
import { AgentValidationError } from "../src/agents/definitions.js";
import { initializeAgentLab } from "../src/bootstrap.js";

const def = (id: string) => CANONICAL_DEFINITIONS.find((d) => d.id === id)!;

function factory(behaviors = {}) {
  const registry = new AgentRegistry();
  return { registry, factory: new AgentFactory({ devices: new DeviceManager(), registry, behaviors }) };
}

test("registry rejects duplicates, orphan subs, parented mains, bad kinds, sub-of-sub", () => {
  const { registry, factory: f } = factory();
  registry.register(f.create(def("MAIN-01")));
  assert.throws(() => registry.register(f.create(def("MAIN-01"))), /duplicate agent id/);
  assert.throws(() => registry.register(f.create(def("MAIN-02-A"))), /not registered/);

  registry.register(f.create(def("MAIN-01-A")));
  assert.throws(() => f.create({ ...def("MAIN-01-B"), parentId: "MAIN-01-A" }), AgentValidationError); // a SUB cannot parent

  assert.throws(() => f.create({ ...def("MAIN-03"), parentId: "MAIN-01" }), /must not have a parent/);
  assert.throws(() => f.create({ ...def("MAIN-03"), kind: "BOSS" as never }), /invalid kind/);
  assert.throws(() => f.createMain(def("MAIN-01-A")), /expected kind MAIN/);
  assert.throws(() => f.createSub(def("MAIN-01")), /expected kind SUB/);
});

test("registry lookup, hierarchy, status, unregister", () => {
  const { registry, factory: f } = factory();
  f.createOrganization();
  assert.equal(registry.size, 36);
  assert.equal(registry.mains().length, 12);
  assert.equal(registry.subs().length, 24);
  assert.deepEqual(registry.childrenOf("MAIN-07").map((a) => a.id), ["MAIN-07-A", "MAIN-07-B"]);
  assert.equal(registry.parentOf("MAIN-07-B")?.id, "MAIN-07");
  assert.equal(registry.parentOf("MAIN-07"), undefined);
  assert.equal(registry.getStatus("MAIN-12-A"), "IDLE");
  assert.equal(registry.getStatus("nope"), undefined);
  assert.throws(() => registry.require("nope"), /unknown agent/);
  assert.deepEqual(registry.validateRelationships(), []);

  assert.throws(() => registry.unregister("MAIN-07"), /unregister its sub-agents first/);
  assert.equal(registry.unregister("MAIN-07-A"), true);
  assert.equal(registry.unregister("MAIN-07-A"), false);
  assert.equal(registry.childrenOf("MAIN-07").length, 1);
});

test("createOrganization is all-or-nothing", () => {
  const { registry, factory: f } = factory();
  const bad = [def("MAIN-01"), def("MAIN-01-A"), def("MAIN-02-A")]; // third has no registered parent
  assert.throws(() => f.createOrganization(bad), /not registered/);
  assert.equal(registry.size, 0);
});

test("behavior table must reference existing SUB agents only", () => {
  const h = { requires: [], handle: async () => ({ status: "PASSED" as const, summary: "", evidence: [] }) };
  assert.throws(() => factory({ "MAIN-99-A": { x: h } }).factory.createOrganization(), /unknown agent/);
  assert.throws(() => factory({ "MAIN-01": { x: h } }).factory.createOrganization(), /only allowed on SUB/);
});

test("initializeAgentLab builds the full validated runtime", () => {
  const rt = initializeAgentLab({ devices: createMockFleet(12) });
  assert.equal(rt.agents.length, 36);
  assert.equal(rt.registry.size, 36);
  assert.ok(Object.values(rt.registry.statuses()).every((s) => s === "IDLE"));
  assert.throws(
    () => initializeAgentLab({ devices: createMockFleet(12), behaviors: { "MAIN-42-A": {} } }),
    /unknown agent/,
  );
});

test("initializeAgentLab with custom definitions skips the 12/24 rule", () => {
  const rt = initializeAgentLab({ devices: createMockFleet(12), definitions: [def("MAIN-01"), def("MAIN-01-A")] });
  assert.equal(rt.registry.size, 2);
});
