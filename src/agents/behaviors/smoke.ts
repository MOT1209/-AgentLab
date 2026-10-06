import type { Evidence } from "../types.js";
import type { TaskHandler } from "../managed-agent.js";
import { detectCrash } from "../exploration/findings.js";

export interface SmokePayload {
  apkPath: string;
  packageName: string;
}

function readPayload(raw: unknown): SmokePayload | string {
  const p = (raw ?? {}) as Partial<SmokePayload>;
  if (typeof p.packageName !== "string" || p.packageName.length === 0) return "packageName is required";
  if (typeof p.apkPath !== "string" || p.apkPath.length === 0) return "apkPath is required";
  if (p.apkPath.startsWith("-")) return "apkPath must not start with '-'";
  if (!/\.apk$/i.test(p.apkPath)) return "apkPath must end in .apk";
  return { apkPath: p.apkPath, packageName: p.packageName };
}

/** Install, launch, capture evidence, check logs for crashes of the app under test, stop. */
export const smokeHandler: TaskHandler = {
  requires: ["install_app", "launch_app", "stop_app", "screenshot", "logs"],
  permissions: ["APP_INSTALL", "APP_LAUNCH", "SCREENSHOT", "LOG_READ"],
  async handle({ task, device }) {
    const payload = readPayload(task.payload);
    if (typeof payload === "string") return { status: "ERROR", summary: `Invalid smoke payload: ${payload}`, evidence: [] };
    const { apkPath, packageName } = payload;
    await device.install(apkPath);
    // Old crashes in the shared system log must not fail this run.
    await device.clearLogs?.();
    try {
      await device.launch(packageName);
      const evidence: Evidence[] = [{ kind: "screenshot", data: (await device.screenshot()).toString("base64") }];
      const logs = await device.logs();
      evidence.push({ kind: "log", data: logs });
      const crash = detectCrash(logs, packageName);
      return crash
        ? { status: "FAILED", summary: `${crash.title} detected after launch`, evidence }
        : { status: "PASSED", summary: "Install and launch succeeded, no crash in logs", evidence };
    } finally {
      await device.stop(packageName).catch(() => undefined);
    }
  },
};
