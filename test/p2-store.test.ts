import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { RunStore, type StoredRun } from "../src/store/run-store.js";
import { renderReportHtml } from "../src/ui/report-html.js";
import { UiApp } from "../src/ui/app.js";
import { createUiServer } from "../src/ui/server.js";
import { MockDevice } from "../src/device/mock-device.js";
import type { DeviceDiscovery } from "../src/runtime/discovery.js";

const PNG = Buffer.from("89504e470d0a1a0a", "hex");
const run = (over: Partial<StoredRun> = {}): StoredRun => ({
  id: "abcdef0123", startedAt: "2026-01-02T03:04:05.000Z", finishedAt: "2026-01-02T03:05:00.000Z", mode: "real", test: "explore", packageName: "com.example.app",
  status: "FAILED", summary: "FAILED: 2 action(s)", costUsd: 0.0123, inputTokens: 100, outputTokens: 20, params: { package: "com.example.app" },
  result: {
    findings: [{ id: "F-001", severity: "CRITICAL", title: "Application crash", description: "boom", source: "VERIFIED", reproSteps: ["1. LAUNCH_APP", "2. TAP (1, 2)"], reproduced: "CONFIRMED" }],
    actionLog: [{ step: 1, action: "TAP", reason: "open", ok: true, detail: "tapped" }],
    telemetry: { actions: 1, actionFailures: 0, llmCalls: 2, inputTokens: 100, outputTokens: 20, durationMs: 1000, costUsd: 0.0123 },
  },
  ...over,
});

test("store: save/list/get/screenshots round-trip; re-saving replaces; newest first", () => {
  const s = new RunStore(":memory:");
  s.save(run({ id: "aaaaaaaaaa", startedAt: "2026-01-01T00:00:00Z" }), new Map([["EV-001", PNG]]));
  s.save(run(), new Map([["EV-001", PNG], ["EV-002", PNG]]));
  s.save(run(), new Map([["EV-001", PNG]]));
  assert.deepEqual(s.list().map((r) => r.id), ["abcdef0123", "aaaaaaaaaa"]);
  assert.equal(s.get("abcdef0123")!.costUsd, 0.0123);
  assert.deepEqual([...s.screenshots("abcdef0123").keys()], ["EV-001"]);
  assert.deepEqual(s.screenshot("abcdef0123", "EV-001"), PNG);
  assert.equal(s.get("nope"), undefined);
  s.close();
});

test("store: the database file is owner-only", { skip: process.platform === "win32" }, () => {
  const path = join(mkdtempSync(join(tmpdir(), "al-db-")), "sub", "a.db");
  const s = new RunStore(path);
  assert.equal(statSync(path).mode & 0o077, 0);
  s.close();
});

test("report: self-contained, escapes everything, embeds screenshots, shows repro and confirmation", () => {
  const evil = run({ packageName: "com.x.y", summary: "<script>alert(1)</script>" });
  (evil.result as { findings: Array<{ title: string }> }).findings[0]!.title = "<img src=x onerror=alert(1)>";
  const html = renderReportHtml(evil, new Map([["EV-001", PNG]]), "en", "N0NCE");
  assert.ok(!html.includes("<script"), "no script at all");
  assert.ok(!html.includes("<img src=x"));
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
  assert.ok(html.includes("data:image/png;base64,"));
  assert.match(html, /Steps to reproduce/);
  assert.match(html, /happened again when replayed/);
  assert.match(html, /\$0\.0123/);
  assert.match(renderReportHtml(run(), new Map(), "ar", "N"), /dir="rtl"/);
  assert.match(renderReportHtml(run({ costUsd: undefined, result: { findings: [] } }), new Map(), "en", "N"), /not computed/);
});

test("UI: a finished real run is saved, listed in history, and its report is served with a strict CSP", async () => {
  const store = new RunStore(":memory:");
  const found: DeviceDiscovery = { discover: async () => [{ serial: "emulator-5554", state: "device", model: "sdk" }] };
  const app = new UiApp({ discovery: found, createDevice: (d) => new MockDevice(d.serial), store });
  await app.refreshDevices();
  const server = createUiServer(app, { token: "tok-1234567890abcdef" });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, init: RequestInit = {}) => fetch(base + path, { ...init, headers: { "x-agentlab-token": "tok-1234567890abcdef", "content-type": "application/json", ...(init.headers as object) } });
  try {
    const started = await call("/api/run", { method: "POST", body: JSON.stringify({ mode: "real", test: "smoke", package: "com.example.app", apkPath: "/tmp/app.apk", deviceId: "emulator-5554" }) });
    assert.equal(started.status, 202);
    for (let i = 0; i < 250; i++) {
      if (((await (await call("/api/state")).json()) as { run: { status: string } }).run.status !== "running") break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const state = (await (await call("/api/state")).json()) as { history: Array<{ id: string; status: string }> };
    assert.equal(state.history.length, 1);
    assert.equal(state.history[0]!.status, "PASSED");
    const id = state.history[0]!.id;
    const saved = await call(`/api/runs/${id}/report.html?lang=en`);
    assert.equal(saved.status, 200);
    assert.match(saved.headers.get("content-security-policy")!, /default-src 'none'; img-src data:/);
    assert.match(await saved.text(), /AgentLab test report/);
    assert.equal((await call("/api/run/report.html")).status, 200);
    assert.equal((await call("/api/runs/0000000000/report.html")).status, 404);
    assert.equal((await fetch(`${base}/api/runs/${id}/report.html`)).status, 401); // token still required
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
