/**
 * OPT-IN end-to-end test on a real Android device or emulator.
 *
 *   REAL_DEVICE_TEST=1 npm run test:real
 *
 * Without REAL_DEVICE_TEST=1 it is SKIPPED. With it set but no usable device it is also SKIPPED (with the reason).
 * It FAILS only when a usable device exists and the pipeline does not work.
 *
 * Environment (all optional):
 *   TEST_DEVICE_SERIAL   use this adb serial (default: first healthy device)
 *   TEST_APP_PACKAGE     package to launch (default com.android.settings, present on every device)
 *   TEST_APP_ACTIVITY    explicit entry activity, e.g. .MainActivity
 *   TEST_APK_PATH        install this APK first (Option A); omit if the app is already installed (Option B)
 *   REAL_LLM_TEST=1      use the real LLM (needs ANTHROPIC_API_KEY; model via REAL_LLM_MODEL). Default: scripted mock LLM
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider } from "../src/providers/mock-provider.js";
import { AnthropicProvider } from "../src/providers/anthropic-provider.js";
import type { LlmProvider } from "../src/providers/types.js";
import { runDeviceScenario } from "./support/e2e-scenario.js";

const enabled = process.env.REAL_DEVICE_TEST === "1";

test("REAL DEVICE: discovery -> health -> registry -> lease -> MAIN-05-A -> safe actions -> evidence -> release", { skip: enabled ? false : "set REAL_DEVICE_TEST=1 to run on a real device" }, async (t) => {
  const pkg = process.env.TEST_APP_PACKAGE ?? "com.android.settings";
  const evidenceDir = mkdtempSync(join(tmpdir(), "agentlab-real-"));

  let llm: LlmProvider;
  const useRealLlm = process.env.REAL_LLM_TEST === "1";
  if (useRealLlm) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) return t.skip("REAL_LLM_TEST=1 but ANTHROPIC_API_KEY is not set");
    llm = new AnthropicProvider({ id: "real", kind: "anthropic", model: process.env.REAL_LLM_MODEL ?? "claude-sonnet-5-5", auth: { type: "api_key", env: "ANTHROPIC_API_KEY" } }, key);
  } else {
    // Scripted decisions, but every action runs on the real device through the real validator and executor.
    llm = MockProvider.scripted([
      { json: { action: "LAUNCH_APP", reason: "start the app" } },
      { json: { action: "GET_UI", reason: "read the screen" } },
      { json: { action: "SCREENSHOT", reason: "capture evidence" } },
      { json: { action: "GET_LOGS", reason: "read logs" } },
      { json: { action: "BACK", reason: "safe navigation action" } },
      { json: { action: "END_TEST", reason: "scripted run complete" } },
    ]);
  }

  let report;
  try {
    report = await runDeviceScenario({
      adbPath: "adb",
      packageName: pkg,
      llm,
      evidenceDir,
      ...(process.env.TEST_DEVICE_SERIAL ? { serial: process.env.TEST_DEVICE_SERIAL } : {}),
      ...(process.env.TEST_APP_ACTIVITY ? { activity: process.env.TEST_APP_ACTIVITY } : {}),
      ...(process.env.TEST_APK_PATH ? { apkPath: process.env.TEST_APK_PATH } : {}),
    });
  } catch (e) {
    if (/ENOENT/.test(String(e))) return t.skip("adb is not installed or not on PATH");
    throw e;
  }

  if (!report.device) {
    const why = report.discovery.rejected.map((r) => `${r.serial}: ${r.reason}`).join(" | ") || "adb reports no devices";
    return t.skip(`no usable Android device (${why})`);
  }

  // From here on a device exists: any failure is a real failure.
  console.log(`\n[real-device] device=${report.device.id} source=${report.device.source} model=${report.device.model} android=${report.device.androidVersion}`);
  assert.equal(report.health?.healthy, true, `health check failed: ${report.health?.errors.join("; ")}`);
  assert.ok(report.health!.checks.adb && report.health!.checks.shell && report.health!.checks.screenshot && report.health!.checks.logs);

  assert.equal(report.assignedTo, "MAIN-05");
  assert.equal(report.during?.lock, "BUSY", "device should be leased while the agent runs");
  assert.ok(report.exploration, `no exploration result: ${JSON.stringify(report.task?.result)}`);
  const r = report.exploration!;
  console.log(`[real-device] status=${r.status} steps=${r.steps} findings=${r.findings.length} evidence=${r.evidence.length} llmCalls=${r.telemetry.llmCalls} tokens=${r.telemetry.inputTokens}/${r.telemetry.outputTokens}`);
  assert.ok(["PASSED", "MAX_STEPS_REACHED", "FAILED"].includes(r.status), `unexpected status ${r.status}: ${r.summary}`);
  assert.ok(r.steps >= 1 && r.actionLog.some((a) => a.ok), "at least one action must have succeeded on the device");
  assert.equal(r.actionLog[0]?.action, "LAUNCH_APP");
  if (!useRealLlm) assert.equal(r.actionLog[0]?.ok, true, `app launch failed: ${r.actionLog[0]?.detail}`);

  // Evidence: a real PNG on disk, a UI hierarchy, logs.
  const shot = r.evidence.find((e) => e.kind === "screenshot" && e.path);
  assert.ok(shot?.path && existsSync(shot.path), "a screenshot file must exist");
  assert.deepEqual([...readFileSync(shot.path).subarray(0, 4)], [137, 80, 78, 71], "screenshot must be a real PNG");
  assert.ok(r.evidence.some((e) => e.kind === "ui_state") || r.actionLog.every((a) => a.action !== "GET_UI"));
  assert.ok(r.evidence.some((e) => e.kind === "log"));
  assert.ok(existsSync(join(evidenceDir, r.taskId, "result.json")));
  assert.ok(readdirSync(join(evidenceDir, r.taskId)).length >= 3);

  // Release.
  assert.equal(report.after?.lock, "FREE", "lease must be released");
  assert.equal(report.availableAgain, true, "device must be available again");

  // No credential ended up in the evidence.
  const key = process.env.ANTHROPIC_API_KEY;
  if (key) for (const f of readdirSync(join(evidenceDir, r.taskId))) assert.ok(!readFileSync(join(evidenceDir, r.taskId, f)).includes(key), `API key found in ${f}`);
});
