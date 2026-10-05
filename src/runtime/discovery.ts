import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface DiscoveredDevice {
  serial: string;
  /** Raw adb state: device, offline, unauthorized, ... */
  state: string;
  model?: string;
  product?: string;
}

/** Source of device candidates (adb, a cloud farm, ...). Keeps the manager provider-neutral. */
export interface DeviceDiscovery {
  discover(): Promise<DiscoveredDevice[]>;
}

/** Parses `adb devices -l` output. */
export function parseAdbDevices(stdout: string): DiscoveredDevice[] {
  const out: DiscoveredDevice[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("List of devices") || line.startsWith("*")) continue;
    const [serial, state, ...rest] = line.split(/\s+/);
    if (!serial || !state) continue;
    const d: DiscoveredDevice = { serial, state };
    for (const token of rest) {
      const [k, v] = token.split(":", 2);
      if (k === "model" && v) d.model = v;
      if (k === "product" && v) d.product = v;
    }
    out.push(d);
  }
  return out;
}

export class AdbDiscovery implements DeviceDiscovery {
  constructor(private readonly adbPath = "adb") {}

  async discover(): Promise<DiscoveredDevice[]> {
    const { stdout } = await run(this.adbPath, ["devices", "-l"], { timeout: 15_000 });
    return parseAdbDevices(stdout);
  }
}
