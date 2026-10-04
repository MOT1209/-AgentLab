export type DeviceState = "ONLINE" | "OFFLINE" | "BUSY" | "ERROR" | "CONNECTING" | "MAINTENANCE";

export interface DeviceInfo {
  id: string;
  model: string;
  androidVersion: string;
}

export interface Device {
  readonly id: string;
  state(): DeviceState;
  info(): Promise<DeviceInfo>;
  install(apkPath: string): Promise<void>;
  launch(packageName: string): Promise<void>;
  stop(packageName: string): Promise<void>;
  screenshot(): Promise<Buffer>;
  tap(x: number, y: number): Promise<void>;
  type(text: string): Promise<void>;
  logs(lines?: number): Promise<string>;
}

export class DeviceError extends Error {
  constructor(message: string, readonly deviceId: string) {
    super(message);
    this.name = "DeviceError";
  }
}
