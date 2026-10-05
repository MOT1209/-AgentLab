import { test } from "node:test";
import assert from "node:assert/strict";
import { MockDevice, createMockFleet } from "../src/device/mock-device.js";
import { adbSourceOf } from "../src/device/adb-device.js";
import { DeviceRegistry } from "../src/runtime/device-registry.js";
import { DevicePool } from "../src/runtime/device-pool.js";
import { DeviceManager } from "../src/runtime/device-manager.js";
import { parseAdbDevices } from "../src/runtime/discovery.js";
import type { LeaseOwner } from "../src/runtime/types.js";

const agent = (id: string): LeaseOwner => ({ id, type: "AGENT" });
const system: LeaseOwner = { id: "ops", type: "SYSTEM" };

test("registry: register, duplicate rejection, lookups and filters", () => {
  const r = new DeviceRegistry();
  const [a, b, c] = createMockFleet(3);
  r.register(a!);
  r.register(b!);
  r.register(c!);
  assert.throws(() => r.register(new MockDevice("DEVICE-01")), /duplicate device id/);
  assert.throws(() => r.register({ id: "x" } as never), /source/); // no source known
  assert.equal(r.size, 3);
  assert.equal(r.has("DEVICE-02"), true);
  assert.equal(r.state("DEVICE-02"), "ONLINE");

  b!.setState("OFFLINE");
  assert.deepEqual(r.available().map((x) => x.id), ["DEVICE-01", "DEVICE-03"]);
  assert.deepEqual(r.offline().map((x) => x.id), ["DEVICE-02"]);
  assert.deepEqual(r.busy(), []);

  r.updateMetadata("DEVICE-01", { rack: "A1" });
  assert.equal(r.get("DEVICE-01")!.metadata.rack, "A1");
  assert.throws(() => r.updateMetadata("nope", {}), /unknown device/);
  assert.equal(r.unregister("DEVICE-03"), true);
  assert.equal(r.unregister("DEVICE-03"), false);
});

test("registry: unknown capability and unregistering a leased device are rejected", () => {
  const m = new DeviceManager();
  assert.throws(() => m.addDevice(new MockDevice("d1"), { capabilities: ["fly" as never] }), /unknown capability/);
  m.addDevice(new MockDevice("d2"));
  m.lock("d2", agent("A"));
  assert.throws(() => m.registry.unregister("d2"), /release it/);
});

test("pool: FREE -> LEASED -> BUSY -> FREE and controlled failure for a second owner", () => {
  const reg = new DeviceRegistry();
  reg.register(new MockDevice("d1"));
  const pool = new DevicePool(reg);

  const first = pool.lease("d1", agent("A"));
  assert.ok(first.ok);
  assert.equal(reg.get("d1")!.lock, "LEASED");
  assert.equal(pool.markBusy(first.ok ? first.lease.leaseId : "", "A"), true);
  assert.equal(reg.get("d1")!.lock, "BUSY");

  const second = pool.lease("d1", agent("B"));
  assert.ok(!second.ok);
  assert.equal(second.reason, "ALREADY_LEASED");
  assert.deepEqual(second.heldBy, agent("A"));
  assert.equal(reg.get("d1")!.lock, "BUSY"); // state not corrupted

  assert.deepEqual(pool.release(first.ok ? first.lease.leaseId : "", "B"), { ok: false, reason: "NOT_OWNER" });
  assert.ok(pool.isOwner("d1", "A"));
  assert.deepEqual(pool.release(first.ok ? first.lease.leaseId : "", "A"), { ok: true });
  assert.equal(reg.get("d1")!.lock, "FREE");
  assert.deepEqual(pool.release(first.ok ? first.lease.leaseId : "", "A"), { ok: false, reason: "NOT_ACTIVE" });
  assert.deepEqual(pool.release("zzz", "A"), { ok: false, reason: "UNKNOWN_LEASE" });
  assert.equal(pool.lease("nope", agent("A")).ok, false);
  assert.equal(pool.recentLeases()[0]!.status, "RELEASED");
});

test("pool: concurrent async acquisition has exactly one winner", async () => {
  const m = new DeviceManager();
  m.addDevice(new MockDevice("d1"));
  const contenders = Array.from({ length: 20 }, (_, i) => Promise.resolve().then(() => m.lock("d1", agent(`A${i}`))));
  const results = await Promise.all(contenders);
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(results.filter((r) => !r.ok && r.reason === "ALREADY_LEASED").length, 19);
});

test("pool: leaseAny skips busy and offline devices", () => {
  const m = new DeviceManager();
  const [a, b, c] = createMockFleet(3);
  [a, b, c].forEach((d) => m.addDevice(d!));
  a!.setState("OFFLINE");
  m.lock("DEVICE-02", agent("X"));
  const r = m.lockAny(agent("Y"));
  assert.ok(r.ok && r.lease.deviceId === "DEVICE-03");
  const none = m.lockAny(agent("Z"));
  assert.ok(!none.ok && none.reason === "NO_AVAILABLE_DEVICE");
});

test("pool: TTL expires a LEASED lease but never a BUSY one", () => {
  let now = 1_000_000;
  const m = new DeviceManager({ now: () => now });
  m.addDevice(new MockDevice("d1"));
  m.addDevice(new MockDevice("d2"));

  const l1 = m.lock("d1", agent("A"), { ttlMs: 1000 });
  const l2 = m.lock("d2", agent("A"), { ttlMs: 1000 });
  assert.ok(l1.ok && l2.ok);
  assert.ok(l2.ok && m.pool.markBusy(l2.lease.leaseId, "A"));

  now += 5000;
  assert.equal(m.describe("d1")!.lock, "FREE"); // expired
  assert.equal(m.describe("d2")!.lock, "BUSY"); // running task is not cut off
  assert.equal(m.pool.recentLeases().at(-1)!.status, "EXPIRED");
  assert.ok(m.lock("d1", agent("B")).ok);
  assert.deepEqual(m.unlock(l1.ok ? l1.lease.leaseId : "", "A"), { ok: false, reason: "NOT_ACTIVE" });
});

test("manager: assignment rules and reassignment", () => {
  const m = new DeviceManager();
  createMockFleet(3).forEach((d) => m.addDevice(d));
  const a = m.assign("MAIN-01", "DEVICE-01");
  assert.equal(a.deviceId, "DEVICE-01");
  assert.equal(m.describe("DEVICE-01")!.assignedAgentId, "MAIN-01");
  assert.throws(() => m.assign("MAIN-01", "DEVICE-02"), /already assigned to DEVICE-01/);
  assert.throws(() => m.assign("MAIN-02", "DEVICE-01"), /already assigned to MAIN-01/);
  assert.throws(() => m.assign("MAIN-02", "DEVICE-99"), /unknown device/);

  m.reassign("MAIN-01", "DEVICE-02");
  assert.equal(m.getAssignment("MAIN-01")!.deviceId, "DEVICE-02");
  assert.equal(m.describe("DEVICE-01")!.assignedAgentId, undefined);

  m.assign("MAIN-02", "DEVICE-03");
  assert.throws(() => m.reassign("MAIN-01", "DEVICE-03"), /already assigned to MAIN-02/);
  assert.equal(m.getAssignment("MAIN-01")!.deviceId, "DEVICE-02"); // rolled back

  m.lock("DEVICE-02", agent("MAIN-01"));
  assert.throws(() => m.unassign("MAIN-01"), /cannot unassign/);
  assert.equal(m.unassign("MAIN-02"), true);
  assert.equal(m.unassign("MAIN-02"), false);
});

test("manager: removal needs force when assigned or leased", () => {
  const m = new DeviceManager();
  m.addDevice(new MockDevice("d1"));
  m.assign("MAIN-01", "d1");
  assert.throws(() => m.removeDevice("d1"), /assigned/);
  m.lock("d1", agent("MAIN-01"));
  assert.equal(m.removeDevice("d1", { force: true }), true);
  assert.equal(m.getAssignment("MAIN-01"), undefined);
  assert.equal(m.removeDevice("d1"), false);
});

test("manager: findAvailable honours assignment, source and predicate", () => {
  const m = new DeviceManager();
  const [a, b] = createMockFleet(2);
  m.addDevice(a!);
  m.addDevice(b!, { source: "EMULATOR" });
  m.assign("MAIN-01", "DEVICE-01");
  assert.equal(m.findAvailable()!.id, "DEVICE-02");
  assert.equal(m.findAvailable({ includeAssigned: true })!.id, "DEVICE-01");
  assert.equal(m.findAvailable({ source: "PHYSICAL" }), undefined);
  assert.equal(m.findAvailable({ source: "EMULATOR" })!.id, "DEVICE-02");
});

test("manager: checkHealth refreshes model/version and reports unreadiness", async () => {
  const m = new DeviceManager();
  const d = new MockDevice("d1");
  m.addDevice(d);
  const ok = await m.checkHealth("d1");
  assert.equal(ok.ready, true);
  assert.equal(m.describe("d1")!.model, "MockPhone");
  assert.equal(m.describe("d1")!.androidVersion, "14");
  d.setState("OFFLINE");
  const bad = await m.checkHealth("d1");
  assert.equal(bad.ready, false);
  assert.match(bad.error!, /OFFLINE/);
  assert.equal((await m.checkHealth("nope")).state, "UNKNOWN");
});

test("manager: withLease always releases and reports contention as a failure", async () => {
  const m = new DeviceManager();
  m.addDevice(new MockDevice("d1"));
  await assert.rejects(m.withLease(agent("A"), "d1", async () => { throw new Error("boom"); }), /boom/);
  assert.equal(m.describe("d1")!.lock, "FREE");

  const held = m.lock("d1", system);
  assert.ok(held.ok);
  const r = await m.withLease(agent("A"), "d1", async () => 1);
  assert.ok(!r.ok && r.reason === "ALREADY_LEASED");
  assert.equal(m.describe("d1")!.lock, "LEASED");
});

test("discovery: parseAdbDevices and source inference", () => {
  const out = [
    "* daemon not running; starting now at tcp:5037",
    "List of devices attached",
    "emulator-5554          device product:sdk_gphone model:sdk_gphone64 device:emu64 transport_id:1",
    "R58M123ABC             device usb:1-1 product:x model:SM_G991B device:y transport_id:2",
    "192.168.1.5:5555       offline",
    "0123456789ABCDEF       unauthorized usb:1-2 transport_id:3",
    "",
  ].join("\n");
  const d = parseAdbDevices(out);
  assert.deepEqual(d.map((x) => [x.serial, x.state]), [
    ["emulator-5554", "device"], ["R58M123ABC", "device"], ["192.168.1.5:5555", "offline"], ["0123456789ABCDEF", "unauthorized"],
  ]);
  assert.equal(d[1]!.model, "SM_G991B");
  assert.equal(adbSourceOf("emulator-5554"), "EMULATOR");
  assert.equal(adbSourceOf("192.168.1.5:5555"), "REMOTE");
  assert.equal(adbSourceOf("R58M123ABC"), "PHYSICAL");
});

test("manager.discover registers only ready, unknown devices", async () => {
  const m = new DeviceManager();
  const found = [
    { serial: "emulator-5554", state: "device", model: "sdk" },
    { serial: "R58M", state: "unauthorized" },
    { serial: "emulator-5556", state: "device" },
  ];
  m.addDevice(new MockDevice("emulator-5556"), { source: "MOCK" });
  const res = await m.discover({ discover: async () => found }, (d) => new MockDevice(d.serial));
  assert.deepEqual(res.added.map((x) => [x.id, x.source, x.model]), [["emulator-5554", "EMULATOR", "MockPhone"]]);
  assert.deepEqual(res.skipped.map((x) => x.serial), ["emulator-5556"]);
  assert.deepEqual(res.rejected.map((x) => [x.serial, x.state]), [["R58M", "unauthorized"]]);
});
