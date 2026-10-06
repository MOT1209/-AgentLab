import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdbDevice } from "../src/device/adb-device.js";
import { MockDevice } from "../src/device/mock-device.js";
import { smokeHandler } from "../src/agents/behaviors/smoke.js";
import { createFakeAdb, FAKE_SERIAL } from "./support/fake-adb.js";

/** A tiny adb stand-in: `install` sleeps, everything else prints the argument line. */
function scriptedAdb(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "p1-adb-"));
  const bin = join(dir, "adb");
  writeFileSync(bin, `#!/bin/sh\n${body}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

test("adb: install has its own, longer timeout; other commands keep the short one", async () => {
  const bin = scriptedAdb(`case "$*" in *install*) sleep 1; echo Success ;; *) sleep 1 ;; esac`);
  const d = new AdbDevice("X", bin, { defaultMs: 200, installMs: 5_000 });
  await d.install("app.apk"); // 1s > defaultMs, but within installMs
  await assert.rejects(d.stop("com.fake.app"), /failed/); // 1s > defaultMs
});

test("adb: an option-looking apk path is refused", async () => {
  const d = new AdbDevice(FAKE_SERIAL, createFakeAdb().bin);
  await assert.rejects(d.install("-g"), /invalid apk path/);
});

test("adb: one failed command does not mark the device ERROR; a lost device does", async () => {
  const flaky = scriptedAdb(`echo "java.lang.RuntimeException: uiautomator busy" >&2; exit 1`);
  const d = new AdbDevice("X", flaky);
  await assert.rejects(d.ui());
  assert.notEqual(d.state(), "ERROR");
  const gone = scriptedAdb(`echo "adb: device 'X' not found" >&2; exit 1`);
  const g = new AdbDevice("X", gone);
  await assert.rejects(g.ui());
  assert.equal(g.state(), "ERROR");
});

test("adb: TYPE keeps symbols, quotes safely, and refuses non-ASCII without ADBKeyboard instead of dropping text", async () => {
  const fake = createFakeAdb();
  const d = new AdbDevice(FAKE_SERIAL, fake.bin);
  await d.type("it's a+b!#1");
  assert.ok(fake.calls().includes("shell input text 'it'\\''s%sa+b!#1'"), fake.calls().join("|"));
  // fake adb has no `ime list`, so the Unicode path fails loudly
  await assert.rejects(d.type("مرحبا"), /ADBKeyboard|failed/);
  assert.ok(!fake.calls().some((c) => c.startsWith("shell input text") && c.includes("مرحبا")));
});

const ctx = (device: MockDevice, payload: unknown) => ({ task: { payload }, device }) as never;

test("smoke: invalid payloads are rejected before touching the device", async () => {
  const device = new MockDevice("D");
  for (const bad of [{}, { packageName: "com.example.app" }, { packageName: "com.example.app", apkPath: "-g" }, { packageName: "com.example.app", apkPath: "x.txt" }]) {
    const r = await smokeHandler.handle(ctx(device, bad));
    assert.equal(r.status, "ERROR");
  }
  assert.ok(!device.calls.includes("install"));
});

test("smoke: a crash of another app in the log does not fail the run; the app's own crash does", async () => {
  const other = new MockDevice("D");
  const wrap = other.launch.bind(other);
  other.launch = async (pkg: string, act?: string) => {
    await wrap(pkg, act);
    other.appendLog("01-01 10:00:00.000  1  1 E AndroidRuntime: FATAL EXCEPTION: main\n01-01 10:00:00.001  1  1 E AndroidRuntime: Process: com.other.app, PID: 1");
  };
  assert.equal((await smokeHandler.handle(ctx(other, { packageName: "com.example.app", apkPath: "app.apk" }))).status, "PASSED");

  const own = new MockDevice("D");
  const wrap2 = own.launch.bind(own);
  own.launch = async (pkg: string, act?: string) => {
    await wrap2(pkg, act);
    own.appendLog("01-01 10:00:00.000  1  1 E AndroidRuntime: FATAL EXCEPTION: main\n01-01 10:00:00.001  1  1 E AndroidRuntime: Process: com.example.app, PID: 1");
  };
  const r = await smokeHandler.handle(ctx(own, { packageName: "com.example.app", apkPath: "app.apk" }));
  assert.equal(r.status, "FAILED");
  assert.equal(own.isRunning("com.example.app"), false);
});

test("smoke: the app is stopped even when a step after launch throws", async () => {
  const device = new MockDevice("D");
  device.screenshot = async () => {
    throw new Error("screencap failed");
  };
  await assert.rejects(smokeHandler.handle(ctx(device, { packageName: "com.example.app", apkPath: "app.apk" })), /screencap failed/);
  assert.equal(device.isRunning("com.example.app"), false);
});
