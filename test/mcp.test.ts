import { test } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "../src/mcp/server.js";
import { MockDevice } from "../src/device/mock-device.js";

const call = (s: McpServer, name: string, args: Record<string, unknown> = {}, id = 1) =>
  s.handle({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) as Promise<any>;

test("read-only by default: action tools are not listed and cannot be called", async () => {
  const s = new McpServer({ devices: [new MockDevice("d1")] });
  const list: any = await s.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const names = list.result.tools.map((t: { name: string }) => t.name);
  assert.deepEqual(names.sort(), ["get_logs", "get_ui", "list_devices", "screenshot"]);
  const r = await call(s, "tap", { x: 1, y: 1 });
  assert.equal(r.error.code, -32602);
});

test("actions work only when enabled; bad arguments come back as tool errors", async () => {
  const s = new McpServer({ devices: [new MockDevice("d1")], allowActions: true });
  assert.equal((await call(s, "launch_app", { packageName: "com.example.app" })).result.isError, undefined);
  assert.equal((await call(s, "tap", { x: -1, y: 2 })).result.isError, true);
  assert.equal((await call(s, "press_key", { key: "POWER" })).result.isError, true);
});

test("device selection: optional with one device, required with several, unknown rejected", async () => {
  const one = new McpServer({ devices: [new MockDevice("a")] });
  assert.equal((await call(one, "get_logs")).result.isError, undefined);
  const many = new McpServer({ devices: [new MockDevice("a"), new MockDevice("b")] });
  assert.equal((await call(many, "get_logs")).result.isError, true);
  assert.equal((await call(many, "get_logs", { deviceId: "zzz" })).result.isError, true);
  assert.equal((await call(many, "get_logs", { deviceId: "b" })).result.isError, undefined);
  const none = new McpServer({ devices: [] });
  assert.equal((await call(none, "list_devices")).result.isError, undefined);
});

test("screenshot returns an image and protocol basics hold", async () => {
  const s = new McpServer({ devices: [new MockDevice("a")] });
  const shot = await call(s, "screenshot");
  assert.equal(shot.result.content[0].type, "image");
  const init: any = await s.handle({ jsonrpc: "2.0", id: 2, method: "initialize", params: {} });
  assert.equal(init.result.serverInfo.name, "agentlab");
  assert.equal(await s.handle({ jsonrpc: "2.0", method: "notifications/initialized" }), undefined);
  const bad: any = await s.handle({ jsonrpc: "2.0", id: 3, method: "nope" });
  assert.equal(bad.error.code, -32601);
});
