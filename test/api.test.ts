import { test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApiServer } from "../src/api/server.js";
import { ProviderManager } from "../src/providers/manager.js";
import { MockProvider } from "../src/providers/mock-provider.js";
import { initializeAgentLab } from "../src/bootstrap.js";
import { DeviceManager } from "../src/runtime/device-manager.js";
import { MockDevice, createMockFleet } from "../src/device/mock-device.js";
import { lab, smokePayload } from "./helpers.js";

let currentToken = "";
/** fetch with the server's API token, like the Control Center does. */
const afetch = (url: string, init: RequestInit = {}): Promise<Response> =>
  fetch(url, { ...init, headers: { "x-agentlab-token": currentToken, ...((init.headers as Record<string, string> | undefined) ?? {}) } });

async function withServer<T>(server: Server & { apiToken?: string }, run: (base: string) => Promise<T>): Promise<T> {
  currentToken = server.apiToken ?? "";
  await new Promise<void>((resolve) => server.listen(0, resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

function getJson(url: string): Promise<{ status: number; body: unknown }> {
  return afetch(url).then(async (r) => ({ status: r.status, body: await r.json() }));
}

function postJson(url: string, body: unknown): Promise<{ status: number; body: unknown }> {
  return afetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => ({
    status: r.status,
    body: await r.json(),
  }));
}

test("api: GET /providers reflects the manager, never leaks a key", async () => {
  const providers = new ProviderManager({ get: () => "sk-ant-test" });
  providers.add({ id: "p", kind: "mock", model: "m", auth: { type: "none" } });
  const rt = lab({ providers });
  await withServer(createApiServer(rt), async (base) => {
    const r = await getJson(`${base}/providers`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, [{ id: "p", kind: "mock", model: "m", keyPresent: false, isDefault: true }]);
  });
});

test("api: POST /providers/:id/test makes the real round trip and reports failure for an unknown id", async () => {
  const providers = new ProviderManager();
  providers.add({ id: "p", kind: "mock", model: "m", auth: { type: "none" } });
  const rt = lab({ providers });
  await withServer(createApiServer(rt), async (base) => {
    const ok = await postJson(`${base}/providers/p/test`, {});
    assert.deepEqual(ok.body, { ok: true, model: "m" });
    const missing = await postJson(`${base}/providers/nope/test`, {});
    assert.equal((missing.body as { ok: boolean }).ok, false);
  });
});

test("api: GET /providers/presets lists the presets", async () => {
  await withServer(createApiServer(lab()), async (base) => {
    const r = await getJson(`${base}/providers/presets`);
    assert.equal(r.status, 200);
    const ids = (r.body as Array<{ id: string }>).map((p) => p.id);
    assert.ok(ids.includes("groq") && ids.includes("openrouter") && ids.includes("ollama"));
  });
});

test("api: POST /providers adds, rejects bad configs with 400, and never accepts a key; DELETE removes", async () => {
  const providers = new ProviderManager({ get: (n: string) => (n === "GROQ_API_KEY" ? "gsk-test-0123456789" : undefined) }, {
    anthropic: (c) => new MockProvider(c.id, c.model),
    "openai-compatible": (c) => new MockProvider(c.id, c.model),
    mock: (c) => new MockProvider(c.id, c.model),
  });
  await withServer(createApiServer(lab({ providers })), async (base) => {
    const good = { id: "groq-1", kind: "openai-compatible", preset: "groq", model: "llama-3.3-70b-versatile", auth: { type: "api_key", env: "GROQ_API_KEY" } };
    const added = await postJson(`${base}/providers`, good);
    assert.equal(added.status, 201);

    const listed = (await getJson(`${base}/providers`)).body as Array<{ id: string; baseUrl?: string }>;
    assert.equal(listed[0]!.baseUrl, "https://api.groq.com/openai/v1");

    const noEnv = await postJson(`${base}/providers`, { ...good, id: "groq-2", auth: { type: "api_key", env: "NOT_SET_API_KEY" } });
    assert.equal(noEnv.status, 400);
    assert.match((noEnv.body as { error: string }).error, /not set/);

    const withKey = await postJson(`${base}/providers`, { ...good, id: "groq-3", auth: { type: "api_key", env: "GROQ_API_KEY", key: "gsk-secret" } });
    assert.equal(withKey.status, 400);
    assert.ok(!JSON.stringify(withKey.body).includes("gsk-secret"));

    const bad = await afetch(`${base}/providers`, { method: "POST", headers: { "content-type": "application/json" }, body: "{nope" });
    assert.equal(bad.status, 400);

    const removed = await afetch(`${base}/providers/groq-1`, { method: "DELETE", headers: { "content-type": "application/json" } });
    assert.equal(removed.status, 200);
    const again = await afetch(`${base}/providers/groq-1`, { method: "DELETE", headers: { "content-type": "application/json" } });
    assert.equal(again.status, 404);
  });
});

test("api: serves the Control Center files and refuses to escape webRoot", async () => {
  await withServer(createApiServer(lab(), { webRoot: "web" }), async (base) => {
    const index = await afetch(`${base}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get("content-type") ?? "", /text\/html/);
    assert.equal((await afetch(`${base}/app.js`)).status, 200);
    assert.equal((await afetch(`${base}/..%2Fpackage.json`)).status, 404);
    assert.equal((await afetch(`${base}/%2e%2e/package.json`)).status, 404);
  });
  await withServer(createApiServer(lab()), async (base) => {
    assert.equal((await afetch(`${base}/`)).status, 404);
  });
});

test("api: GET /devices returns the registered fleet snapshot", async () => {
  const rt = lab();
  await withServer(createApiServer(rt), async (base) => {
    const r = await getJson(`${base}/devices`);
    assert.equal(r.status, 200);
    assert.equal((r.body as unknown[]).length, 12);
  });
});

test("api: POST /tests dispatches without blocking, GET /tests/:id reflects progress then the result", async () => {
  const rt = lab();
  await withServer(createApiServer(rt), async (base) => {
    const started = await postJson(`${base}/tests`, { agentId: "MAIN-01", type: "smoke", payload: smokePayload });
    assert.equal(started.status, 202);
    const { taskId } = started.body as { taskId: string };
    assert.ok(taskId);

    let status = (await getJson(`${base}/tests/${taskId}`)).body as { status: string };
    assert.ok(["RUNNING", "PASSED"].includes(status.status));

    await new Promise((r) => setTimeout(r, 20));
    status = (await getJson(`${base}/tests/${taskId}`)).body as { status: string };
    assert.equal(status.status, "PASSED");

    const missing = await getJson(`${base}/tests/does-not-exist`);
    assert.equal(missing.status, 404);
  });
});

test("api: POST /tests rejects a bad agent id without creating a task", async () => {
  const rt = lab();
  await withServer(createApiServer(rt), async (base) => {
    const r = await postJson(`${base}/tests`, { agentId: "MAIN-01-B", type: "smoke", payload: smokePayload });
    assert.equal(r.status, 400);
  });
});

test("api: GET /events streams bus messages for a dispatched task", async () => {
  const rt = lab();
  await withServer(createApiServer(rt), async (base) => {
    const res = await afetch(`${base}/events`);
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    await postJson(`${base}/tests`, { agentId: "MAIN-01", type: "smoke", payload: smokePayload });

    let buf = "";
    const deadline = Date.now() + 2000;
    while (!buf.includes("TASK_ASSIGNED") && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value);
    }
    reader.cancel();
    assert.ok(buf.includes("TASK_ASSIGNED"));
  });
});

test("api: discover surfaces the raw adb error and honours adbPath", async () => {
  await withServer(createApiServer(lab(), { adbPath: "/definitely/not/adb" }), async (base) => {
    const r = await postJson(`${base}/devices/discover`, {});
    assert.equal(r.status, 502);
    assert.match((r.body as { error: string }).error, /ENOENT/);
  });
});

test("api: discover registers healthy devices and reports unauthorized ones as rejected with their state", async () => {
  const discovery = {
    discover: async () => [
      { serial: "DEVICE-OK", state: "device", model: "Pixel_7" },
      { serial: "XYZ789", state: "unauthorized" },
    ],
  };
  const rt = initializeAgentLab({ deviceManager: new DeviceManager(), assignments: "none" });
  const createDevice = (d: { serial: string }) => new MockDevice(d.serial);
  await withServer(createApiServer(rt, { discovery, createDevice }), async (base) => {
    const r = await postJson(`${base}/devices/discover`, {});
    assert.equal(r.status, 200);
    const body = r.body as { added: unknown[]; skipped: unknown[]; rejected: Array<{ serial: string; state: string; reason: string }> };
    assert.equal(body.added.length, 1);
    assert.deepEqual(body.skipped, []);
    assert.deepEqual(body.rejected.map((d) => [d.serial, d.state]), [["XYZ789", "unauthorized"]]);
    assert.ok(body.rejected[0]!.reason.length > 0);

    const again = (await postJson(`${base}/devices/discover`, {})).body as { added: unknown[]; skipped: unknown[] };
    assert.equal(again.added.length, 0);
    assert.equal(again.skipped.length, 1, "an already registered device is skipped");
  });
});

test("api: POST /tests assigns a free device to the MAIN, moves it when idle, and 409s when none exist", async () => {
  const dm = new DeviceManager();
  const rt = initializeAgentLab({ deviceManager: dm, assignments: "none" });
  await withServer(createApiServer(rt), async (base) => {
    const none = await postJson(`${base}/tests`, { agentId: "MAIN-01", type: "smoke", payload: smokePayload });
    assert.equal(none.status, 409);

    dm.addDevice(createMockFleet(1)[0]!);
    const first = await postJson(`${base}/tests`, { agentId: "MAIN-01", type: "smoke", payload: smokePayload });
    assert.equal(first.status, 202);
    await new Promise((r) => setTimeout(r, 30));
    let devs = (await getJson(`${base}/devices`)).body as Array<{ assignedAgentId?: string }>;
    assert.equal(devs[0]!.assignedAgentId, "MAIN-01");

    const second = await postJson(`${base}/tests`, { agentId: "MAIN-03", type: "smoke", payload: smokePayload });
    assert.equal(second.status, 202);
    devs = (await getJson(`${base}/devices`)).body as Array<{ assignedAgentId?: string }>;
    assert.equal(devs[0]!.assignedAgentId, "MAIN-03");
  });
});

test("api security: token, Host, content type, body size, key env names and key targets", async () => {
  const providers = new ProviderManager({ get: () => "sk-test-secret-value" });
  await withServer(createApiServer(lab({ providers })), async (base) => {
    const body = JSON.stringify({ id: "x", kind: "openai-compatible", model: "m", baseUrl: "https://example.com/v1", auth: { type: "api_key", env: "SOME_API_KEY" } });
    // no token -> 401, for reads and writes alike
    assert.equal((await fetch(`${base}/providers`)).status, 401);
    assert.equal((await fetch(`${base}/providers`, { method: "POST", headers: { "content-type": "application/json" }, body })).status, 401);
    assert.equal((await fetch(`${base}/events`)).status, 401);
    // wrong token -> 401; token in ?t= works for GET (EventSource cannot set headers)
    assert.equal((await fetch(`${base}/providers`, { headers: { "x-agentlab-token": "nope" } })).status, 401);
    assert.equal((await fetch(`${base}/providers?t=${currentToken}`)).status, 200);
    // a form-style content type is refused even with a valid token
    assert.equal((await afetch(`${base}/providers`, { method: "POST", headers: { "content-type": "text/plain" }, body })).status, 415);
    // a foreign Host header (DNS rebinding) is refused even with a valid token
    const { request } = await import("node:http");
    const status = await new Promise<number>((resolve, reject) => {
      const u = new URL(base);
      const r = request({ host: u.hostname, port: u.port, path: "/providers", headers: { host: "evil.example", "x-agentlab-token": currentToken } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      r.on("error", reject);
      r.end();
    });
    assert.equal(status, 403);
    // oversized body -> 413
    const big = await afetch(`${base}/providers`, { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(200_000) });
    assert.equal(big.status, 413);
    // key variable names that are not key-like are refused (cannot read DATABASE_URL, PATH, ...)
    const odd = await postJson(`${base}/providers`, { ...JSON.parse(body), auth: { type: "api_key", env: "DATABASE_URL" } });
    assert.equal(odd.status, 400);
    // a key is never sent over plain http to a remote host
    const plain = await postJson(`${base}/providers`, { ...JSON.parse(body), baseUrl: "http://attacker.example/v1" });
    assert.equal(plain.status, 400);
    // https remote and plain-http localhost are fine
    assert.equal((await postJson(`${base}/providers`, JSON.parse(body))).status, 201);
    assert.equal((await postJson(`${base}/providers`, { ...JSON.parse(body), id: "y", baseUrl: "http://localhost:11434/v1" })).status, 201);
    // malformed percent-encoding is a 404/400, never a 500
    assert.notEqual((await afetch(`${base}/%E0%A4%A`)).status, 500);
  });
});
