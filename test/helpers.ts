import { createMockFleet, MockDevice } from "../src/device/mock-device.js";
import { initializeAgentLab, AgentLabOptions } from "../src/bootstrap.js";

export const smokePayload = { apkPath: "app.apk", packageName: "com.example.app" };

/** Runtime with the canonical fleet: DEVICE-01..12 auto-assigned to MAIN-01..12. */
export function lab(extra: Partial<AgentLabOptions> = {}) {
  const fleet = createMockFleet(12);
  const rt = initializeAgentLab({ devices: fleet, ...extra });
  const deviceOf = (mainId: string): MockDevice => fleet[Number(mainId.slice(5, 7)) - 1]!;
  return { ...rt, fleet, device: fleet[0]!, deviceOf };
}
