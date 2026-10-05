import type { Evidence } from "../types.js";
import type { TaskHandler } from "../managed-agent.js";

export interface SmokePayload {
  apkPath: string;
  packageName: string;
}

/** Install, launch, capture evidence, check logs for crashes, stop. */
export const smokeHandler: TaskHandler = {
  requires: ["install_app", "launch_app", "stop_app", "screenshot", "logs"],
  permissions: ["APP_INSTALL", "APP_LAUNCH", "SCREENSHOT", "LOG_READ"],
  async handle({ task, device }) {
    const { apkPath, packageName } = task.payload as SmokePayload;
    await device.install(apkPath);
    await device.launch(packageName);
    const evidence: Evidence[] = [{ kind: "screenshot", data: (await device.screenshot()).toString("base64") }];
    const logs = await device.logs();
    evidence.push({ kind: "log", data: logs });
    const crashed = /FATAL EXCEPTION|ANR in/.test(logs);
    await device.stop(packageName);
    return crashed
      ? { status: "FAILED", summary: "Crash or ANR detected after launch", evidence }
      : { status: "PASSED", summary: "Install and launch succeeded, no crash in logs", evidence };
  },
};
