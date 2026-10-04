import { MockDevice } from "../src/device/mock-device.js";
import { initializeAgentLab, AgentLabOptions } from "../src/bootstrap.js";

export const smokePayload = { apkPath: "app.apk", packageName: "com.example.app" };

export function lab(extra: Partial<AgentLabOptions> = {}) {
  const device = new MockDevice();
  return { device, ...initializeAgentLab({ device, ...extra }) };
}
