import { test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApiServer } from "../src/api/server.js";
import { ProviderManager } from "../src/providers/manager.js";
import { lab, smokePayload } from "./helpers.js";

async function withServer<T>(server: Server, run: (base: string) => Promise<T>): Promise<T> {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

function getJson(url: string): Promise<{ status: number; body: unknown }> {
  return fetch(url).then(async (r) => ({ status: r.status, body: await r.json() }));
}

function postJson(url: string, body: unknown): Promise<{ status: number; body: unknown }> {
  return fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => ({
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
    const res = await fetch(`${base}/events`);
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
