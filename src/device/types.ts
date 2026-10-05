export type DeviceState = "ONLINE" | "OFFLINE" | "BUSY" | "ERROR" | "CONNECTING" | "MAINTENANCE";

/** Where a device comes from. Agents never branch on this; the runtime uses it for reporting and filtering. */
export const DEVICE_SOURCES = ["PHYSICAL", "EMULATOR", "REMOTE", "MOCK"] as const;
export type DeviceSource = (typeof DEVICE_SOURCES)[number];

export interface DeviceInfo {
  id: string;
  model: string;
  androidVersion: string;
}

/** A visible UI element, from the accessibility hierarchy. */
export interface UiNode {
  text: string;
  desc: string;
  id: string;
  cls: string;
  pkg: string;
  clickable: boolean;
  enabled: boolean;
  bounds: { l: number; t: number; r: number; b: number };
}

export type DeviceKey = "BACK" | "HOME";

export interface Device {
  readonly id: string;
  /** Provenance, if the adapter knows it. */
  readonly source?: DeviceSource;
  state(): DeviceState;
  info(): Promise<DeviceInfo>;
  install(apkPath: string): Promise<void>;
  /** `activity` (e.g. ".MainActivity") selects a specific entry point; otherwise the launcher activity is started. */
  launch(packageName: string, activity?: string): Promise<void>;
  stop(packageName: string): Promise<void>;
  screenshot(): Promise<Buffer>;
  tap(x: number, y: number): Promise<void>;
  type(text: string): Promise<void>;
  logs(lines?: number): Promise<string>;
  // Optional capabilities. Callers must check before use.
  swipe?(x1: number, y1: number, x2: number, y2: number, durationMs?: number): Promise<void>;
  pressKey?(key: DeviceKey): Promise<void>;
  /** Current UI hierarchy. */
  ui?(): Promise<UiNode[]>;
  clearLogs?(): Promise<void>;
}

export class DeviceError extends Error {
  constructor(message: string, readonly deviceId: string) {
    super(message);
    this.name = "DeviceError";
  }
}
