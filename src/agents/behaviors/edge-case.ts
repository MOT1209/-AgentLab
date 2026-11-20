import type { Device } from "../../device/types.js";
import type { Permission } from "../../skills/permissions.js";
import type { AgentLimits } from "../../skills/types.js";
import { hasVerifiedFailure } from "../exploration/findings.js";
import type { UiElement } from "../exploration/observation.js";
import { type ExplorationResult, toTaskStatus } from "../exploration/result.js";
import type { HandlerContext, TaskHandler } from "../managed-agent.js";
import type { AgentResult } from "../types.js";
import { DeterministicSession, EDGE_INPUTS, intField, isObj, isTextField, labelOf, parseCommon, type CommonTaskOptions, type Screen } from "./deterministic-session.js";

/**
 * Edge Case Agent (MAIN-05-B): a deterministic matrix of unusual inputs and sequences. No LLM, no API key.
 *
 * Every case starts from a clean launch, so a crash is attributed to exactly one field and one input
 * (or one sequence) and its repro steps are just that case. Input cases come from the text fields on
 * the start screen; sequence cases try double submits, back during submit, empty submit, rapid relaunch,
 * background during input, back past the root and rapid taps on each control.
 */

export const DEFAULT_MAX_CASES = 80;
export const HARD_MAX_CASES = 300;
export const DEFAULT_MAX_FIELDS = 5;
export const DEFAULT_EDGE_TIMEOUT_MS = 600_000;
const MAX_INPUTS = 50;
const MAX_INPUT_LENGTH = 500;
const RAPID_TAP_TARGETS = 5;
const RAPID_TAPS = 5;

export interface EdgeCaseTask extends CommonTaskOptions {
  /** Values typed into each field. ASCII only (stock adb input). Default: EDGE_INPUTS. */
  inputs: readonly string[];
  maxFields: number;
  maxCases: number;
  /** Run the unusual-sequence cases too. */
  sequences: boolean;
}

export type EdgeCaseOutcome = "OK" | "CRASH" | "LEFT_APP" | "FIELD_GONE" | "SKIPPED";

export interface EdgeCaseRecord {
  id: string;
  kind: "input" | "sequence";
  name: string;
  field?: string;
  input?: string;
  outcome: EdgeCaseOutcome;
  findingId?: string;
  /** First and last action step of the case. */
  steps: [number, number];
  note?: string;
}

/** Labels of controls that submit a form, in English, German and Arabic. Word-boundaried for Latin script. */
const SUBMIT_LATIN = /\b(submit|ok|save|send|log ?in|sign ?in|next|continue|search|done|apply|confirm|go|speichern|senden|anmelden|weiter|suchen|fertig|bestätigen)\b/i;
const SUBMIT_ARABIC = /(حفظ|إرسال|ارسال|تسجيل الدخول|دخول|التالي|متابعة|بحث|تم|تأكيد)/;
const looksLikeSubmit = (e: UiElement): boolean => [e.text, e.desc, e.id?.replace(/[_.]/g, " ")].some((t) => !!t && (SUBMIT_LATIN.test(t) || SUBMIT_ARABIC.test(t)));

export function parseEdgeCaseTask(payload: unknown): { ok: true; task: EdgeCaseTask } | { ok: false; errors: string[] } {
  if (!isObj(payload)) return { ok: false, errors: ["payload must be an object"] };
  const errors: string[] = [];
  const common = parseCommon(payload, errors, DEFAULT_EDGE_TIMEOUT_MS);
  let inputs: readonly string[] = EDGE_INPUTS;
  if (payload.inputs !== undefined) {
    const v = payload.inputs;
    if (!Array.isArray(v) || v.length === 0 || v.length > MAX_INPUTS) errors.push(`inputs must be a list of 1..${MAX_INPUTS} strings`);
    else if (!v.every((x) => typeof x === "string" && x.length > 0 && x.length <= MAX_INPUT_LENGTH && /^[\x20-\x7e]+$/.test(x))) errors.push(`each input must be 1..${MAX_INPUT_LENGTH} printable ASCII characters (stock adb input cannot type anything else)`);
    else inputs = v as string[];
  }
  const maxFields = intField(errors, payload.maxFields, "maxFields", DEFAULT_MAX_FIELDS, 1, 10);
  const maxCases = intField(errors, payload.maxCases, "maxCases", DEFAULT_MAX_CASES, 1, HARD_MAX_CASES);
  if (payload.sequences !== undefined && typeof payload.sequences !== "boolean") errors.push("sequences must be a boolean");
  if (errors.length > 0 || !common) return { ok: false, errors };
  return { ok: true, task: { ...common, inputs, maxFields, maxCases, sequences: payload.sequences !== false } };
}

export interface EdgeCaseDeps {
  taskId: string;
  agentId: string;
  deviceId?: string;
  device: Device;
  task: EdgeCaseTask;
  permissions?: ReadonlySet<Permission>;
  ceilings?: AgentLimits;
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  onProgress?: (event: Record<string, unknown>) => void;
}

interface FieldRef {
  id?: string;
  label: string;
  index: number;
}

/** Never throws. The result is an ExplorationResult plus `cases`, one record per case. */
export async function runEdgeCases(deps: EdgeCaseDeps): Promise<ExplorationResult & { cases: EdgeCaseRecord[] }> {
  const ceil = deps.ceilings;
  const task: EdgeCaseTask = ceil ? { ...deps.task, timeoutMs: Math.min(deps.task.timeoutMs, ceil.maxExecutionTimeMs) } : deps.task;
  /** The profile's step ceiling caps the total number of actions; no case starts past it. */
  const maxActions = ceil?.maxSteps ?? Number.POSITIVE_INFINITY;
  const s = new DeterministicSession({ ...deps, options: task });
  const act = s.act.bind(s);
  const cases: EdgeCaseRecord[] = [];
  const notes: string[] = [];
  let stoppedAtCeiling = false;

  const fieldsOf = (screen: Screen) => screen.elements.filter(isTextField);
  const locate = (screen: Screen, f: FieldRef): UiElement | undefined => {
    const fields = fieldsOf(screen);
    return (f.id ? fields.find((e) => e.id === f.id) : undefined) ?? fields[f.index];
  };
  const tap = (e: UiElement, why: string) => act({ action: "TAP", target: { x: e.x, y: e.y } }, why);

  /** One case: clean launch, the case's own actions, a settle, then its outcome. Returns false when no more cases may run. */
  const runCase = async (rec: Omit<EdgeCaseRecord, "id" | "outcome" | "steps">, steps: (screen: Screen) => Promise<EdgeCaseOutcome | void>, estimate: number): Promise<boolean> => {
    if (cases.length >= task.maxCases) return false;
    if (s.tel.actions + estimate > maxActions) {
      stoppedAtCeiling = true;
      return false;
    }
    const id = `C-${String(cases.length + 1).padStart(3, "0")}`;
    const crashesBefore = s.crashCount;
    s.crashContext = rec.kind === "input" ? `field "${rec.field}" with input "${(rec.input ?? "").slice(0, 60)}"` : `sequence "${rec.name}"`;
    s.startSegment();
    const from = s.tel.actions + 1;
    await act({ action: "STOP_APP" }, `${id}: clean start`, false);
    await act({ action: "LAUNCH_APP" }, `${id}: clean start`, false);
    await act({ action: "WAIT", ms: 1000 }, `${id}: let the app settle`);
    let outcome: EdgeCaseOutcome = (await steps(await s.readScreen())) ?? "OK";
    if (s.crashCount === crashesBefore) await act({ action: "WAIT", ms: 1000 }, `${id}: watch for a late crash`);
    if (s.crashCount > crashesBefore) outcome = "CRASH";
    else if (outcome === "OK") {
      const after = await s.readScreen();
      if (after.foreground && after.foreground !== s.pkg) outcome = "LEFT_APP";
    }
    s.crashContext = undefined;
    const record: EdgeCaseRecord = { id, ...rec, outcome, steps: [from, s.tel.actions] };
    if (outcome === "CRASH" && s.lastCrash?.findingId) record.findingId = s.lastCrash.findingId;
    cases.push(record);
    s.emit({ kind: "case", id, name: rec.name, outcome });
    return true;
  };

  const body = async (): Promise<string> => {
    // Survey the start screen: which fields exist, which control submits.
    await act({ action: "STOP_APP" }, "survey: clean start", false);
    await act({ action: "LAUNCH_APP" }, "survey: clean start", false);
    await act({ action: "WAIT", ms: 1500 }, "survey: let the app settle");
    const screen = await s.readScreen();
    const fields: FieldRef[] = fieldsOf(screen)
      .slice(0, task.maxFields)
      .map((e, index) => ({ ...(e.id ? { id: e.id } : {}), label: labelOf(e).slice(0, 60), index }));
    const submitEl = screen.elements.find((e) => e.clickable && !isTextField(e) && looksLikeSubmit(e) && !s.isSensitive(e));
    const submitLabel = submitEl ? labelOf(submitEl).slice(0, 40) : undefined;
    const tappables = screen.elements.filter((e) => e.clickable && !isTextField(e) && !s.isSensitive(e)).slice(0, RAPID_TAP_TARGETS);
    if (!s.canUi) notes.push("The device gives no UI hierarchy: only the sequence cases that need no fields ran.");
    else if (fields.length === 0) notes.push("No text fields on the start screen: no input cases.");
    if (fields.length > 0 && !submitEl) notes.push("No submit control found: inputs were typed but not submitted.");

    /** The submit control on the current screen (positions can move after a relaunch), by label. */
    const findSubmit = (sc: Screen): UiElement | undefined => (submitLabel ? sc.elements.find((e) => e.clickable && labelOf(e).slice(0, 40) === submitLabel) : undefined);
    const fill = async (sc: Screen, f: FieldRef, text: string): Promise<boolean> => {
      const el = locate(sc, f);
      if (!el) return false;
      await tap(el, `focus field "${f.label}"`);
      await act({ action: "TYPE", text }, `type into "${f.label}"`);
      return true;
    };

    // Sequence cases (built first so their budget is reserved; run after the input matrix).
    type Seq = { name: string; estimate: number; run: (sc: Screen) => Promise<EdgeCaseOutcome | void> };
    const seqs: Seq[] = [];
    if (task.sequences) {
      if (submitLabel) {
        seqs.push({
          name: "double submit",
          estimate: 8,
          run: async (sc) => {
            if (fields[0]) await fill(sc, fields[0], "test");
            const b = findSubmit(await s.readScreen());
            if (!b) return "FIELD_GONE";
            await tap(b, "submit");
            await tap(b, "submit again at once");
          },
        });
        seqs.push({ name: "submit empty form", estimate: 5, run: async (sc) => { const b = findSubmit(sc); if (!b) return "FIELD_GONE"; await tap(b, "submit with nothing filled in"); } });
        if (s.canKey) seqs.push({ name: "back right after submit", estimate: 6, run: async (sc) => { const b = findSubmit(sc); if (!b) return "FIELD_GONE"; await tap(b, "submit"); await act({ action: "BACK" }, "back while it is still working"); } });
      }
      seqs.push({
        name: "rapid relaunch x3",
        estimate: 10,
        run: async () => {
          for (let i = 0; i < 3; i++) {
            await act({ action: "STOP_APP" }, "rapid relaunch", false);
            await act({ action: "LAUNCH_APP" }, "rapid relaunch", i === 2);
          }
        },
      });
      if (s.canKey && fields[0]) {
        seqs.push({
          name: "background during input",
          estimate: 9,
          run: async (sc) => {
            if (!(await fill(sc, fields[0]!, "test"))) return "FIELD_GONE";
            await act({ action: "HOME" }, "leave in the middle of typing");
            await act({ action: "WAIT", ms: 500 }, "stay in the background");
            await act({ action: "LAUNCH_APP" }, "come back");
          },
        });
      }
      if (s.canKey) {
        seqs.push({
          name: "back past the root",
          estimate: 9,
          run: async () => {
            for (let i = 0; i < 4; i++) await act({ action: "BACK" }, `back ${i + 1}/4`);
            await act({ action: "LAUNCH_APP" }, "open the app again");
          },
        });
      }
      for (const t of tappables) {
        const label = labelOf(t).slice(0, 40);
        seqs.push({
          name: `rapid taps on "${label}"`,
          estimate: 4 + RAPID_TAPS,
          run: async (sc) => {
            const el = sc.elements.find((e) => e.clickable && labelOf(e).slice(0, 40) === label);
            if (!el) return "FIELD_GONE";
            for (let i = 0; i < RAPID_TAPS; i++) await tap(el, `rapid tap ${i + 1}/${RAPID_TAPS}`);
          },
        });
      }
    }

    // Input matrix: every field x every input, each from a clean launch.
    const matrixBudget = Math.max(0, task.maxCases - seqs.length);
    let done = 0;
    outer: for (const f of fields) {
      for (const input of task.inputs) {
        if (done >= matrixBudget) break outer;
        const ran = await runCase(
          { kind: "input", name: `"${f.label}" = ${JSON.stringify(input.length > 40 ? `${input.slice(0, 40)}…(${input.length})` : input)}`, field: f.label, input },
          async (sc) => {
            if (!(await fill(sc, f, input))) return "FIELD_GONE";
            const b = findSubmit(await s.readScreen());
            if (b) await tap(b, "submit");
          },
          submitLabel ? 7 : 6,
        );
        if (!ran) break outer;
        done++;
      }
    }
    for (const q of seqs) if (!(await runCase({ kind: "sequence", name: q.name }, q.run, q.estimate))) break;

    await s.screenshot(s.tel.actions);
    if (stoppedAtCeiling) notes.push(`Stopped at the agent's step ceiling (${maxActions} actions).`);
    return "Edge cases completed.";
  };

  const result = await s.run({ maxSteps: Math.min(maxActions, task.maxCases * 7 + 3) }, body, (f) => {
    const count = (o: EdgeCaseOutcome) => cases.filter((c) => c.outcome === o).length;
    const parts = (["CRASH", "LEFT_APP", "FIELD_GONE", "OK"] as const).filter((o) => count(o) > 0).map((o) => `${count(o)} ${o}`);
    return (
      `${f.status}: ${cases.length} case(s) (${parts.join(", ") || "none"}), ${f.actions} action(s), ${f.crashes} distinct crash(es). ${f.why}` +
      (notes.length > 0 ? ` ${notes.join(" ")}` : "") +
      (f.sensitiveSkipped > 0 ? ` ${f.sensitiveSkipped} sensitive control(s) were left alone.` : "") +
      f.confirmNote
    );
  }, () => ({ cases }));
  return result as ExplorationResult & { cases: EdgeCaseRecord[] };
}

/** Task handler for MAIN-05-B ("edge-case"). Needs no LLM. */
export const edgeCaseHandler: TaskHandler = {
  requires: ["launch_app", "stop_app", "tap", "type", "swipe", "press_key", "screenshot", "inspect_ui", "logs"],
  permissions: ["APP_LAUNCH", "DEVICE_INTERACT", "LOG_READ"],
  async handle(ctx: HandlerContext): Promise<AgentResult> {
    const parsed = parseEdgeCaseTask(ctx.task.payload);
    if (!parsed.ok) return { status: "ERROR", summary: `Invalid edge-case task: ${parsed.errors.join("; ")}`, evidence: [] };
    const result = await runEdgeCases({
      taskId: ctx.task.task_id,
      agentId: ctx.definition.id,
      deviceId: ctx.runtime.deviceId,
      device: ctx.device,
      task: parsed.task,
      ...(ctx.profile ? { permissions: new Set(ctx.profile.permissions), ceilings: ctx.profile.limits } : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      onProgress: ctx.report,
    });
    return { status: toTaskStatus(result.status, hasVerifiedFailure(result.findings)), summary: result.summary, evidence: result.evidence, details: result };
  },
};
