import { Device, DeviceError, DeviceInfo, DeviceKey, DeviceState, UiNode } from "./types.js";

/** In-memory device for tests and development without hardware. */
export class MockDevice implements Device {
  private current: DeviceState = "ONLINE";
  private installed = new Set<string>();
  private running = new Set<string>();
  readonly calls: string[] = [];
  readonly source = "MOCK" as const;
  /** Human-readable record of device operations, e.g. "tap:10,20". */
  readonly trace: string[] = [];
  private extraLogs: string[] = [];
  private uiNodes: UiNode[] = [];

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
    this.trace.push(`launch:${pkg}`);
  }
  async stop(pkg: string): Promise<void> {
    this.guard("stop");
    this.running.delete(pkg);
  }
  async screenshot(): Promise<Buffer> {
    this.guard("screenshot");
    return Buffer.from("mock-png");
  }
  async tap(x: number, y: number): Promise<void> {
    this.guard("tap");
    this.trace.push(`tap:${x},${y}`);
  }
  async type(text: string): Promise<void> {
    this.guard("type");
    this.trace.push(`type:${text}`);
  }
  async swipe(x1: number, y1: number, x2: number, y2: number, durationMs = 300): Promise<void> {
    this.guard("swipe");
    this.trace.push(`swipe:${x1},${y1}>${x2},${y2}@${durationMs}`);
  }
  async pressKey(key: DeviceKey): Promise<void> {
    this.guard("pressKey");
    this.trace.push(`key:${key}`);
  }
  async clearLogs(): Promise<void> {
    this.guard("clearLogs");
    this.extraLogs = [];
  }
  async ui(): Promise<UiNode[]> {
    this.guard("ui");
    return this.uiNodes;
  }
  async logs(): Promise<string> {
    this.guard("logs");
    return [...[...this.running].map((p) => `I/${p}: running`), ...this.extraLogs].join("\n");
  }
  /** Test helpers. */
  appendLog(line: string): void {
    this.extraLogs.push(line);
  }
  setUi(nodes: UiNode[]): void {
    this.uiNodes = nodes;
  }
  isRunning(pkg: string): boolean {
    return this.running.has(pkg);
  }
}

/** Canonical development fleet: DEVICE-01 ... DEVICE-NN. */
export function createMockFleet(count = 12, prefix = "DEVICE"): MockDevice[] {
  return Array.from({ length: count }, (_, i) => new MockDevice(`${prefix}-${String(i + 1).padStart(2, "0")}`));
}
