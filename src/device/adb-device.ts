import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseUiAutomatorXml } from "./ui-parse.js";
import { Device, DeviceError, DeviceInfo, DeviceKey, DeviceSource, DeviceState, UiNode } from "./types.js";

const run = promisify(execFile);
const PKG = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
const ACTIVITY = /^\.?[A-Za-z][A-Za-z0-9_$]*(\.[A-Za-z][A-Za-z0-9_$]*)*$/;

/** Per-command timeouts. Installing a large app or game can take minutes; everything else should be quick. */
export interface AdbTimeouts {
  defaultMs: number;
  installMs: number;
}
const DEFAULT_TIMEOUTS: AdbTimeouts = { defaultMs: 30_000, installMs: 10 * 60_000 };

/** adb says these when the device itself is gone, as opposed to one command failing. */
const CONNECTION_LOST = /device .*not found|no devices|offline|unauthorized|cannot connect|device disconnected|closed/i;

/** The ADBKeyboard IME (github.com/senzhk/ADBKeyBoard) is what makes non-ASCII input possible; stock `input text` is ASCII only. */
const ADB_KEYBOARD_IME = "com.android.adbkeyboard/.AdbIME";

/** ADB adapter. Uses execFile (no shell) so arguments cannot inject commands. */
export class AdbDevice implements Device {
  private lastState: DeviceState = "CONNECTING";

  private readonly timeouts: AdbTimeouts;

  constructor(readonly id: string, private readonly adbPath = "adb", timeouts: Partial<AdbTimeouts> = {}) {
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...timeouts };
  }

  get source(): DeviceSource {
    return adbSourceOf(this.id);
  }

  state(): DeviceState {
    return this.lastState;
  }

  private async adb(args: string[], opts: { binary?: boolean; timeoutMs?: number } = {}): Promise<string | Buffer> {
    try {
      const { stdout } = await run(this.adbPath, ["-s", this.id, ...args], {
        timeout: opts.timeoutMs ?? this.timeouts.defaultMs,
        maxBuffer: 32 * 1024 * 1024,
        encoding: opts.binary ? "buffer" : "utf8",
      });
      this.lastState = "ONLINE";
      return stdout;
    } catch (e) {
      // One failed command (a timeout, uiautomator during an animation) does not mean the device is gone.
      if (CONNECTION_LOST.test(String((e as { stderr?: unknown }).stderr ?? "") + (e as Error).message)) this.lastState = "ERROR";
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
    // A path starting with "-" would be read by adb as an option.
    if (apkPath.startsWith("-") || apkPath.length === 0) throw new DeviceError(`invalid apk path: ${apkPath}`, this.id);
    await this.adb(["install", "-r", apkPath], { timeoutMs: this.timeouts.installMs });
  }
  async launch(p: string, activity?: string): Promise<void> {
    if (activity !== undefined) {
      if (!ACTIVITY.test(activity)) throw new DeviceError(`invalid activity name: ${activity}`, this.id);
      await this.adb(["shell", "am", "start", "-n", `${this.pkg(p)}/${activity}`]);
      return;
    }
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
    if (/[^\x20-\x7e]/.test(text)) return this.typeUnicode(text);
    // The device shell re-parses the arguments, so the text is single-quoted (a literal ' becomes '\''); `%s` is a space for `input text`.
    const quoted = `'${text.replace(/%/g, "").replace(/ /g, "%s").replace(/'/g, "'\\''")}'`;
    await this.adb(["shell", "input", "text", quoted]);
  }

  /** Non-ASCII text (Arabic, umlauts, emoji) needs the ADBKeyboard IME. Fails loudly instead of dropping characters. */
  private async typeUnicode(text: string): Promise<void> {
    const imes = String(await this.adb(["shell", "ime", "list", "-s"]));
    if (!imes.includes(ADB_KEYBOARD_IME)) {
      throw new DeviceError("typing non-ASCII text needs the ADBKeyboard app installed on the device (stock `input text` is ASCII only)", this.id);
    }
    await this.adb(["shell", "ime", "set", ADB_KEYBOARD_IME]);
    const b64 = Buffer.from(text, "utf8").toString("base64");
    await this.adb(["shell", "am", "broadcast", "-a", "ADB_INPUT_B64", "--es", "msg", b64]);
  }
  async swipe(x1: number, y1: number, x2: number, y2: number, durationMs = 300): Promise<void> {
    const n = [x1, y1, x2, y2, durationMs].map((v) => String(Math.trunc(Number(v))));
    if (n.some((v) => !/^\d+$/.test(v))) throw new DeviceError("swipe: coordinates must be non-negative integers", this.id);
    await this.adb(["shell", "input", "swipe", ...n]);
  }
  async pressKey(key: DeviceKey): Promise<void> {
    const code = { BACK: "KEYCODE_BACK", HOME: "KEYCODE_HOME" }[key];
    if (!code) throw new DeviceError(`unsupported key: ${String(key)}`, this.id);
    await this.adb(["shell", "input", "keyevent", code]);
  }
  async clearLogs(): Promise<void> {
    await this.adb(["logcat", "-c"]);
  }
  async ui(): Promise<UiNode[]> {
    const xml = String(await this.adb(["exec-out", "uiautomator", "dump", "/dev/tty"]));
    return parseUiAutomatorXml(xml);
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
