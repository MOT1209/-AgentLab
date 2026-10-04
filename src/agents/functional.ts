import { Agent, newTask } from "./base.js";
import { AgentResult, Evidence, Task } from "./types.js";

export interface SmokePayload {
  apkPath: string;
  packageName: string;
}

/** Sub-Agent 01-B: Core Feature Tester. Installs, launches, and verifies the app is alive. */
export class CoreFeatureTester extends Agent {
  protected async execute(task: Task): Promise<AgentResult> {
    const { apkPath, packageName } = task.payload as SmokePayload;
    const evidence: Evidence[] = [];
    await this.device.install(apkPath);
    await this.device.launch(packageName);
    evidence.push({ kind: "screenshot", data: (await this.device.screenshot()).toString("base64") });
    const logs = await this.device.logs();
    evidence.push({ kind: "log", data: logs });
    const crashed = /FATAL EXCEPTION|ANR in/.test(logs);
    await this.device.stop(packageName);
    return crashed
      ? { status: "FAILED", summary: "Crash or ANR detected after launch", evidence }
      : { status: "PASSED", summary: "Install and launch succeeded, no crash in logs", evidence };
  }
}

/** Main Agent 01: Functional Tester. Delegates to its Sub-Agent, validates and reports. */
export class FunctionalTester extends Agent {
  constructor(id: string, device: ConstructorParameters<typeof Agent>[1], private readonly sub: CoreFeatureTester) {
    super(id, device);
  }

  protected async execute(task: Task): Promise<AgentResult> {
    const subTask = await this.sub.run(newTask(this.sub.id, "smoke", task.payload, task.priority));
    if (subTask.status === "ERROR") {
      return { status: "BLOCKED", summary: `Sub-agent error: ${subTask.errors.join("; ")}`, evidence: [] };
    }
    return subTask.result ?? { status: "ERROR", summary: "Sub-agent returned no result", evidence: [] };
  }
}
