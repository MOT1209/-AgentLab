import { Device } from "../device/types.js";

export type AdbState = "device" | "offline" | "unauthorized" | "unknown";

/** Maps raw `adb devices` states (device, offline, unauthorized, no permissions, recovery...) onto four. */
export function normalizeAdbState(raw: string): AdbState {
  if (raw === "device" || raw === "offline" || raw === "unauthorized") return raw;
  return "unknown";
}

export interface DeviceHealth {
  healthy: boolean;
  serial: string;
  model?: string;
  androidVersion?: string;
  state: AdbState;
  checks: { adb: boolean; shell: boolean; screenshot: boolean; logs: boolean };
  errors: string[];
  checkedAt: string;
}

const PNG_MAGIC = Buffer.from([137, 80, 78, 71]);

/**
 * Deep readiness probe: can we run a command, take a screenshot and read logs?
 * `rawState` is the state reported by discovery (adb devices); without it, the device's own state is used.
 * Never throws.
 */
export async function deepHealthCheck(device: Device, rawState?: string): Promise<DeviceHealth> {
  const errors: string[] = [];
  const state: AdbState = rawState !== undefined ? normalizeAdbState(rawState) : device.state() === "ONLINE" ? "device" : "unknown";
  const checks = { adb: state === "device", shell: false, screenshot: false, logs: false };
  const health: DeviceHealth = { healthy: false, serial: device.id, state, checks, errors, checkedAt: new Date().toISOString() };

  if (state === "unauthorized") errors.push("device is unauthorized: accept the USB debugging prompt on the device, then retry");
  else if (state === "offline") errors.push("device is offline: reconnect it or restart adb (adb kill-server)");
  else if (state === "unknown") errors.push("device is in an unknown adb state");
  if (state !== "device") return health;

  const run = async (name: keyof typeof checks, fn: () => Promise<void>) => {
    try {
      await fn();
      checks[name] = true;
    } catch (e) {
      errors.push(`${name} check failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`);
    }
  };
  await run("shell", async () => {
    const info = await device.info();
    health.model = info.model;
    health.androidVersion = info.androidVersion;
    if (!info.model && !info.androidVersion) throw new Error("device returned no properties");
  });
  await run("screenshot", async () => {
    const png = await device.screenshot();
    // Real devices return PNG. Test doubles may not, so a non-PNG is only flagged when it is empty.
    if (png.length === 0) throw new Error("empty screenshot");
    if (device.source !== "MOCK" && !png.subarray(0, 4).equals(PNG_MAGIC)) throw new Error("screenshot is not a PNG");
  });
  await run("logs", async () => {
    await device.logs(5);
  });
  health.healthy = checks.adb && checks.shell && checks.screenshot && checks.logs;
  return health;
}
