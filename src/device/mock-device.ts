import { Device, DeviceError, DeviceInfo, DeviceState } from "./types.js";

/** In-memory device for tests and development without hardware. */
export class MockDevice implements Device {
  private current: DeviceState = "ONLINE";
  private installed = new Set<string>();
  private running = new Set<string>();
  readonly calls: string[] = [];

  constructor(readonly id = "mock-1") {}

  setState(s: DeviceState): void {
    this.current = s;
  }
  state(): DeviceState {
    return this.current;
  }
  private guard(op: string): void {
    this.calls.push(op);
    if (this.current !== "ONLINE") throw new DeviceError(`${op}: device is ${this.current}`, this.id);
  }
  async info(): Promise<DeviceInfo> {
    this.guard("info");
    return { id: this.id, model: "MockPhone", androidVersion: "14" };
  }
  async install(apkPath: string): Promise<void> {
    this.guard("install");
    this.installed.add(apkPath);
  }
  async launch(pkg: string): Promise<void> {
    this.guard("launch");
    this.running.add(pkg);
  }
  async stop(pkg: string): Promise<void> {
    this.guard("stop");
    this.running.delete(pkg);
  }
  async screenshot(): Promise<Buffer> {
    this.guard("screenshot");
    return Buffer.from("mock-png");
  }
  async tap(): Promise<void> {
    this.guard("tap");
  }
  async type(): Promise<void> {
    this.guard("type");
  }
  async logs(): Promise<string> {
    this.guard("logs");
    return [...this.running].map((p) => `I/${p}: running`).join("\n");
  }
  isRunning(pkg: string): boolean {
    return this.running.has(pkg);
  }
}
