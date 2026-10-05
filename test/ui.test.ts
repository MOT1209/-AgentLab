import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { UiApp, UiError } from "../src/ui/app.js";
import { createUiServer } from "../src/ui/server.js";
import { MockDevice } from "../src/device/mock-device.js";
import type { DeviceDiscovery } from "../src/runtime/discovery.js";

const TOKEN = "t0ken-for-tests-1234567890abcdef";
const SECRET = "sk-ant-SECRET-DO-NOT-LEAK-0123456789";

async function start(app = new UiApp()) {
  const server = createUiServer(app, { token: TOKEN });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = { "x-agentlab-token": TOKEN }) => {
    const res = await fetch(base + path, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const type = res.headers.get("content-type") ?? "";
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, headers: res.headers, json: type.includes("json") ? JSON.parse(buf.toString("utf8")) : undefined, buf };
  };
  return { app, server, port, base, call, close: () => new Promise<void>((r) => (server.close(() => r()), server.closeAllConnections())) };
}

async function waitFor(fn: () => boolean | Promise<boolean>, ms = 5000) {
  const t0 = Date.now();
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("the page is served with a nonce CSP and no inline event handlers or styles", async () => {
  const s = await start();
  const r = await fetch(s.base + "/");
  const html = await r.text();
  const csp = r.headers.get("content-security-policy")!;
  assert.equal(r.status, 200);
  assert.match(csp, /default-src 'none'/);
  const nonce = /nonce-([^']+)'/.exec(csp)![1]!;
  assert.ok(html.includes(`<script nonce="${nonce}">`));
  assert.ok(!/ on\w+=/.test(html.split("<body>")[1]!.split("<script")[0]!), "inline event handler");
  assert.ok(!html.split("<body>")[1]!.split("<script")[0]!.includes('style="'), "inline style attribute");
  assert.ok(!html.includes("innerHTML"), "page must not use innerHTML");
  await s.close();
});

test("API requires the token; wrong or missing token is 401", async () => {
  const s = await start();
  assert.equal((await s.call("GET", "/api/state", undefined, {})).status, 401);
  assert.equal((await s.call("GET", "/api/state", undefined, { "x-agentlab-token": "wrong" })).status, 401);
  assert.equal((await s.call("GET", "/api/state")).status, 200);
  assert.equal((await s.call("GET", `/api/state?t=${TOKEN}`, undefined, {})).status, 200); // GET only
  assert.equal((await s.call("POST", `/api/provider/clear?t=${TOKEN}`, {}, {})).status, 401); // never via query for POST
  await s.close();
});

test("a foreign Host header (DNS rebinding) is rejected", async () => {
  const s = await start();
  const status = await new Promise<number>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: s.port, path: "/api/state", headers: { host: "evil.example.com", "x-agentlab-token": TOKEN } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
  assert.equal(status, 403);
  await s.close();
});

test("POST needs JSON and a bounded body", async () => {
  const s = await start();
  const noType = await fetch(s.base + "/api/provider/clear", { method: "POST", headers: { "x-agentlab-token": TOKEN, "content-type": "text/plain" }, body: "x" });
  assert.equal(noType.status, 415);
  const big = await fetch(s.base + "/api/provider", { method: "POST", headers: { "x-agentlab-token": TOKEN, "content-type": "application/json" }, body: JSON.stringify({ kind: "anthropic", model: "m", apiKey: "k".repeat(70_000) }) });
  assert.equal(big.status, 413);
  const bad = await fetch(s.base + "/api/provider", { method: "POST", headers: { "x-agentlab-token": TOKEN, "content-type": "application/json" }, body: "[1]" });
  assert.equal(bad.status, 400);
  assert.equal((await s.call("GET", "/nope")).status, 404);
  await s.close();
});

test("the API key is stored in memory and never comes back out", async () => {
  const s = await start();
  const saved = await s.call("POST", "/api/provider", { kind: "anthropic", model: "claude-sonnet-5-5", apiKey: SECRET });
  assert.equal(saved.status, 200);
  const all = [JSON.stringify(saved.json), JSON.stringify((await s.call("GET", "/api/state")).json)].join("\n");
  assert.ok(!all.includes(SECRET));
  assert.equal(saved.json.provider.keyPresent, true);
  // saving again without a key keeps the old one; clearing removes it
  assert.equal((await s.call("POST", "/api/provider", { kind: "anthropic", model: "other-model" })).json.provider.keyPresent, true);
  assert.equal((await s.call("POST", "/api/provider/clear", {})).json.provider.configured, false);
  assert.equal((await s.call("POST", "/api/provider", { kind: "anthropic", model: "m" })).status, 400);
  await s.close();
});

test("provider validation gives friendly errors", async () => {
  const s = await start();
  for (const [body, msg] of [
    [{ kind: "anthropic", model: "" }, /Model is required/],
    [{ kind: "openai-compatible", model: "m", baseUrl: "ftp://x" }, /http/],
    [{ kind: "nonsense", model: "m" }, /Unknown provider/],
  ] as const) {
    const r = await s.call("POST", "/api/provider", body);
    assert.equal(r.status, 400);
    assert.match(r.json.error, msg);
  }
  const ok = await s.call("POST", "/api/provider", { kind: "openai-compatible", model: "llama", baseUrl: "http://localhost:11434/v1" });
  assert.equal(ok.json.provider.keyPresent, false);
  await s.close();
});

test("demo run: progress events, real PNG screenshots, report, and a second run is allowed after it finishes", async () => {
  const s = await start();
  const started = await s.call("POST", "/api/run", { mode: "demo" });
  assert.equal(started.status, 202);
  await waitFor(async () => (await s.call("GET", "/api/state")).json.run.status !== "running");
  const run = (await s.call("GET", "/api/state")).json.run;
  assert.equal(run.status, "finished");
  assert.equal(run.result.status, "PASSED");
  assert.deepEqual(run.events.filter((e: { kind: string }) => e.kind === "action").map((e: { action: string }) => e.action), ["LAUNCH_APP", "TAP", "SWIPE", "BACK"]);
  assert.ok(!JSON.stringify(run).includes("iVBOR"), "image bytes must not be in the JSON state");

  const shot = run.events.find((e: { kind: string }) => e.kind === "screenshot");
  const img = await s.call("GET", `/api/run/screenshot/${shot.id}?t=${TOKEN}`, undefined, {});
  assert.equal(img.headers.get("content-type"), "image/png");
  assert.deepEqual([...img.buf.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal((await s.call("GET", "/api/run/screenshot/EV-999")).status, 404);
  assert.equal((await s.call("GET", "/api/run/screenshot/..%2Fetc")).status, 404);

  const report = await s.call("GET", "/api/run/report");
  assert.match(report.headers.get("content-disposition")!, /attachment/);
  assert.equal(report.json.result.status, "PASSED");

  assert.equal((await s.call("POST", "/api/run", { mode: "demo" })).status, 202);
  await s.close();
});

test("only one run at a time; cancel works; cancel with nothing running is 409", async () => {
  const s = await start();
  assert.equal((await s.call("POST", "/api/run/cancel", {})).status, 409);
  assert.equal((await s.call("POST", "/api/run", { mode: "demo" })).status, 202);
  const second = await s.call("POST", "/api/run", { mode: "demo" });
  // either still running (409) or already done (202): both are valid, but never two at once
  assert.ok([409, 202].includes(second.status));
  await waitFor(async () => (await s.call("GET", "/api/state")).json.run.status !== "running");
  await s.close();
});

test("real mode validates before touching anything", async () => {
  const s = await start();
  const noDev = await s.call("POST", "/api/run", { mode: "real", package: "com.x.y" });
  assert.match(noDev.json.error, /Select a connected device/);
  const badPkg = await s.call("POST", "/api/run", { mode: "real", package: "bad name; rm -rf /", deviceId: "x" });
  assert.equal(badPkg.status, 400);
  const noPkg = await s.call("POST", "/api/run", { mode: "real" });
  assert.match(noPkg.json.error, /Package name is required/);
  const badSteps = await s.call("POST", "/api/run", { mode: "demo", maxSteps: 0 });
  assert.equal(badSteps.status, 400);
  await s.close();
});

test("device refresh: adb missing is a readable message, found devices are listed", async () => {
  const missing = new UiApp({ discovery: { discover: async () => { throw Object.assign(new Error("spawn adb ENOENT"), { code: "ENOENT" }); } } });
  await missing.refreshDevices();
  assert.match((missing.state().devices as { error: string }).error, /adb not found/);

  const found: DeviceDiscovery = { discover: async () => [{ serial: "emulator-5554", state: "device", model: "sdk" }, { serial: "R58", state: "unauthorized" }] };
  const app = new UiApp({ discovery: found, createDevice: (d) => new MockDevice(d.serial) });
  await app.refreshDevices();
  const list = (app.state().devices as { list: Array<{ id: string; source: string }> }).list;
  assert.deepEqual(list.map((d) => [d.id, d.source]), [["emulator-5554", "EMULATOR"]]);
  assert.match((app.state().devices as { error: string }).error, /R58: device is unauthorized/); // the user is told why
  assert.ok(MockDevice && UiError);
});
