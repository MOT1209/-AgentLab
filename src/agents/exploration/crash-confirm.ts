import type { Device } from "../../device/types.js";
import { ActionExecutor } from "./action-executor.js";
import type { AgentAction } from "./actions.js";
import { EvidenceStore } from "./evidence.js";
import { detectCrash, type Finding, type FindingLog } from "./findings.js";
import type { ActionRecord } from "./result.js";

/** Only actions that change app state are replayed or listed as reproduction steps. */
export const REPLAYABLE: ReadonlySet<string> = new Set(["LAUNCH_APP", "STOP_APP", "TAP", "TYPE", "SWIPE", "BACK", "HOME", "WAIT"]);
const CONFIRM_MAX_FINDINGS = 3;
const CONFIRM_MAX_MS = 90_000;

/** One human-readable line for a recorded action, e.g. `TAP (540, 960)`. */
export function describeStep(h: ActionRecord): string {
  const p = (h.params ?? {}) as { target?: { x: number; y: number }; text?: string; from?: { x: number; y: number }; to?: { x: number; y: number }; ms?: number };
  const arg = h.action === "TAP" && p.target ? ` (${p.target.x}, ${p.target.y})` : h.action === "TYPE" ? ` "${String(p.text ?? "")}"` : h.action === "SWIPE" && p.from && p.to ? ` (${p.from.x}, ${p.from.y}) -> (${p.to.x}, ${p.to.y})` : h.action === "WAIT" ? ` ${p.ms ?? ""} ms` : "";
  return `${h.action}${arg}`;
}

/** The successful, replayable actions so far, numbered for a human to follow. */
export function reproStepsFrom(history: readonly ActionRecord[]): string[] {
  return history.filter((h) => h.ok && REPLAYABLE.has(h.action)).map((h, i) => `${i + 1}. ${describeStep(h)}`);
}

export interface ConfirmDeps {
  device: Device;
  agentId: string;
  packageName: string;
  launchActivity?: string;
  findings: FindingLog;
  history: readonly ActionRecord[];
  signal?: AbortSignal;
  now: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  emit?: (event: Record<string, unknown>) => void;
  /** First step to replay for a finding (default: the start of the run). Lets a caller that recovers from a crash replay only the segment after it. */
  startStepOf?: (f: Finding) => number;
}

/**
 * Replays the steps behind each verified crash (at most 3, 90 s each) and records whether it happened again.
 * Replays coordinates blindly: a layout change or timing can make a real crash look NOT_REPRODUCED. Never throws.
 * Returns a sentence for the run summary, or undefined when there was nothing to confirm.
 */
export async function confirmCrashReplays(d: ConfirmDeps): Promise<string | undefined> {
  const { device, packageName, findings, now } = d;
  const replay = new ActionExecutor(device, { evidence: new EvidenceStore(d.agentId, undefined, now), packageName, ...(d.launchActivity ? { launchActivity: d.launchActivity } : {}), ...(d.sleep ? { sleep: d.sleep } : {}) });
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const targets = findings.all().filter((f) => f.source === "VERIFIED" && f.reproSteps).slice(0, CONFIRM_MAX_FINDINGS);
  let confirmed = 0;
  for (const f of targets) {
    const from = d.startStepOf?.(f) ?? 0;
    const steps = d.history.filter((h) => h.ok && h.step >= from && h.step <= f.step && h.params && REPLAYABLE.has(h.action));
    let outcome: NonNullable<Finding["reproduced"]> = "NOT_REPRODUCED";
    const deadline = now() + CONFIRM_MAX_MS;
    try {
      if (steps.length === 0) outcome = "INCONCLUSIVE";
      else {
        await device.stop(packageName).catch(() => undefined);
        await device.clearLogs?.();
        if (steps[0]!.action !== "LAUNCH_APP") await device.launch(packageName, d.launchActivity);
        for (const h of steps) {
          if (d.signal?.aborted || now() > deadline) {
            outcome = "INCONCLUSIVE";
            break;
          }
          const out = await replay.execute(h.params as unknown as AgentAction, h.step);
          if (!out.ok && out.deviceError) {
            outcome = "INCONCLUSIVE";
            break;
          }
          if (detectCrash(await device.logs(100), packageName)?.title === f.title) {
            outcome = "CONFIRMED";
            break;
          }
        }
        if (outcome === "NOT_REPRODUCED") {
          await sleep(1500); // a crash can land just after the last action
          if (detectCrash(await device.logs(100), packageName)?.title === f.title) outcome = "CONFIRMED";
        }
      }
    } catch {
      outcome = "INCONCLUSIVE";
    }
    if (outcome === "CONFIRMED") confirmed++;
    findings.annotate(f.id, { reproduced: outcome });
    try {
      d.emit?.({ kind: "confirm", id: f.id, result: outcome });
    } catch {
      /* ignore */
    }
  }
  return targets.length > 0 ? ` Crash confirmation: ${confirmed} of ${targets.length} reproduced by replaying the steps.` : undefined;
}
