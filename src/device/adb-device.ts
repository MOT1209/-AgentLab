import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Device, DeviceError, DeviceInfo, DeviceSource, DeviceState } from "./types.js";

const run = promisify(execFile);
const PKG = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;

/** ADB adapter. Uses execFile (no shell) so arguments cannot inject commands. */
export class AdbDevice implements Device {
  private lastState: DeviceState = "CONNECTING";

  constructor(readonly id: string, private readonly adbPath = "adb") {}

  get source(): DeviceSource {
    return adbSourceOf(this.id);
  }

  state(): DeviceState {
    return this.lastState;
  }

  private async adb(args: string[], opts: { binary?: boolean } = {}): Promise<string | Buffer> {
    try {
      const { stdout } = await run(this.adbPath, ["-s", this.id, ...args], {
        timeout: 30_000,
        maxBuffer: 32 * 1024 * 1024,
        encoding: opts.binary ? "buffer" : "utf8",
      });
      this.lastState = "ONLINE";
      return stdout;
    } catch (e) {
      this.lastState = "ERROR";
      throw new DeviceError(`adb ${args[0]} failed: ${(e as Error).message}`, this.id);
    }
  }

  private pkg(name: string): string {
    if (!PKG.test(name)) throw new DeviceError(`invalid package name: ${name}`, this.id);
    return name;
  }

  async info(): Promise<DeviceInfo> {
    const prop = async (k: string) => String(await this.adb(["shell", "getprop", k])).trim();
    return { id: this.id, model: await prop("ro.product.model"), androidVersion: await prop("ro.build.version.release") };
  }
  async install(apkPath: string): Promise<void> {
    await this.adb(["install", "-r", apkPath]);
  }
  async launch(p: string): Promise<void> {
    await this.adb(["shell", "monkey", "-p", this.pkg(p), "-c", "android.intent.category.LAUNCHER", "1"]);
  }
  async stop(p: string): Promise<void> {
    await this.adb(["shell", "am", "force-stop", this.pkg(p)]);
  }
  async screenshot(): Promise<Buffer> {
    return (await this.adb(["exec-out", "screencap", "-p"], { binary: true })) as Buffer;
  }
  async tap(x: number, y: number): Promise<void> {
    await this.adb(["shell", "input", "tap", String(Math.trunc(x)), String(Math.trunc(y))]);
  }
  async type(text: string): Promise<void> {
    // adb input text needs %s for spaces; strip shell-significant chars.
    const safe = text.replace(/[^A-Za-z0-9 @._-]/g, "").replace(/ /g, "%s");
    await this.adb(["shell", "input", "text", safe]);
  }
  async logs(lines = 200): Promise<string> {
    return String(await this.adb(["logcat", "-d", "-t", String(lines)]));
  }
}

/** emulator-5554 -> EMULATOR, 192.168.1.5:5555 -> REMOTE, anything else -> PHYSICAL. */
export function adbSourceOf(serial: string): DeviceSource {
  if (serial.startsWith("emulator-")) return "EMULATOR";
  if (serial.includes(":")) return "REMOTE";
  return "PHYSICAL";
}
