import { Device, DeviceError, UiNode } from "../../device/types.js";
import { AgentAction } from "./actions.js";
import type { EvidenceStore } from "./evidence.js";

export type ActionErrorCode = "UNSUPPORTED_ACTION" | "DEVICE_ERROR" | "ACTION_FAILED" | "SENSITIVE_ACTION_BLOCKED";

export interface ActionOutcome {
  ok: boolean;
  detail: string;
  /** Set when ok is false. UNSUPPORTED_ACTION: the device/task cannot do this; it is never faked or ignored. */
  errorCode?: ActionErrorCode;
  /** The failure came from the device layer (as opposed to a bad request). */
  deviceError: boolean;
  evidenceIds: string[];
  /** Present after GET_UI. */
  ui?: UiNode[];
}

export interface ExecutorOptions {
  /** The only app LAUNCH_APP / STOP_APP may touch. Comes from the task, never from the model. */
  packageName?: string;
  /** Optional entry point for LAUNCH_APP, also from the task. */
  launchActivity?: string;
  evidence: EvidenceStore;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", done);
      clearTimeout(t);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });

/**
 * Maps a validated AgentAction onto Device methods. It knows nothing about LLMs, providers, ADB or shells:
 * the switch below is exhaustive, so a new action cannot exist without an explicit device mapping.
 */
export class ActionExecutor {
  constructor(
    private readonly device: Device,
    private readonly opts: ExecutorOptions,
  ) {}

  async execute(action: AgentAction, step: number, signal?: AbortSignal): Promise<ActionOutcome> {
    const ids: string[] = [];
    const ev = (kind: "screenshot" | "log" | "action_result" | "ui_state", data: string) => {
      const e = this.opts.evidence.add(kind, data, step);
      if (e?.id) ids.push(e.id);
    };
    const ok = (detail: string, extra: Partial<ActionOutcome> = {}): ActionOutcome => ({ ok: true, detail, deviceError: false, evidenceIds: ids, ...extra });
    const d = this.device;
    const pkg = this.opts.packageName;

    try {
      switch (action.action) {
        case "LAUNCH_APP":
          if (!pkg) return { ok: false, detail: "no app package configured", errorCode: "UNSUPPORTED_ACTION", deviceError: false, evidenceIds: ids };
          await d.clearLogs?.(); // so earlier crashes are not blamed on this launch
          await d.launch(pkg, this.opts.launchActivity);
          ev("action_result", `launched ${pkg}`);
          return ok(`launched ${pkg}`);
        case "STOP_APP":
          if (!pkg) return { ok: false, detail: "no app package configured", errorCode: "UNSUPPORTED_ACTION", deviceError: false, evidenceIds: ids };
          await d.stop(pkg);
          ev("action_result", `stopped ${pkg}`);
          return ok(`stopped ${pkg}`);
        case "TAP":
          await d.tap(action.target.x, action.target.y);
          ev("action_result", `tap ${action.target.x},${action.target.y}`);
          return ok(`tapped (${action.target.x}, ${action.target.y})`);
        case "TYPE":
          await d.type(action.text);
          ev("action_result", `typed ${action.text.length} characters`);
          return ok(`typed ${action.text.length} characters`);
        case "SWIPE":
          if (!d.swipe) return { ok: false, detail: "device does not support swipe", errorCode: "UNSUPPORTED_ACTION", deviceError: false, evidenceIds: ids };
          await d.swipe(action.from.x, action.from.y, action.to.x, action.to.y, action.durationMs);
          ev("action_result", `swipe ${action.from.x},${action.from.y} -> ${action.to.x},${action.to.y}`);
          return ok("swiped");
        case "BACK":
        case "HOME":
          if (!d.pressKey) return { ok: false, detail: "device does not support key presses", errorCode: "UNSUPPORTED_ACTION", deviceError: false, evidenceIds: ids };
          await d.pressKey(action.action);
          ev("action_result", `key ${action.action}`);
          return ok(`pressed ${action.action}`);
        case "SCREENSHOT": {
          if (!this.opts.evidence.canAddScreenshot()) return ok("screenshot skipped: evidence limit reached");
          ev("screenshot", (await d.screenshot()).toString("base64"));
          return ok(ids.length > 0 ? `screenshot stored as ${ids[0]}` : "screenshot skipped: evidence limit reached");
        }
        case "WAIT":
          await (this.opts.sleep ?? defaultSleep)(action.ms, signal);
          return ok(`waited ${action.ms} ms`);
        case "GET_UI": {
          if (!d.ui) return { ok: false, detail: "device does not support UI inspection", errorCode: "UNSUPPORTED_ACTION", deviceError: false, evidenceIds: ids };
          const ui = await d.ui();
          ev("ui_state", JSON.stringify(ui).slice(0, 20_000));
          return ok(`read ${ui.length} UI nodes`, { ui });
        }
        case "GET_LOGS": {
          const logs = await d.logs(100);
          ev("log", logs.slice(0, 20_000));
          return ok(`read ${logs.split("\n").length} log lines`);
        }
        case "END_TEST":
          return { ok: false, detail: "END_TEST is handled by the agent loop", errorCode: "UNSUPPORTED_ACTION", deviceError: false, evidenceIds: ids };
        default: {
          const never: never = action;
          return { ok: false, detail: `unhandled action ${JSON.stringify(never)}`, errorCode: "UNSUPPORTED_ACTION", deviceError: false, evidenceIds: ids };
        }
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      ev("action_result", `FAILED: ${message}`.slice(0, 500));
      const isDevice = e instanceof DeviceError;
      return { ok: false, detail: message.slice(0, 300), errorCode: isDevice ? "DEVICE_ERROR" : "ACTION_FAILED", deviceError: isDevice, evidenceIds: ids };
    }
  }
}
