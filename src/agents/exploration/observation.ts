import type { DeviceState, UiNode } from "../../device/types.js";
import { redactSensitive } from "./redact.js";

export interface AppContext {
  packageName?: string;
  name?: string;
  launchActivity?: string;
  version?: string;
}

/** Compact view of one UI element, as the model sees it. Coordinates are tap targets (element centers). */
export interface UiElement {
  text?: string;
  desc?: string;
  id?: string;
  cls?: string;
  x: number;
  y: number;
  clickable: boolean;
}

export interface Observation {
  step: number;
  timestamp: string;
  deviceState: DeviceState;
  app: { packageName?: string; foregroundPackage?: string };
  /** Reference only. Image bytes go to the model only when the task opts in to vision (see ExplorationTask.vision). */
  screenshotRef?: string;
  ui?: UiElement[];
  uiTruncated?: boolean;
  recentAction?: { action: string; reason: string };
  actionResult?: { ok: boolean; detail: string };
  logLines?: string[];
  errors: string[];
  metadata: Record<string, string | number | boolean>;
}

const MAX_UI_ELEMENTS = 40;
const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** Reduces a hierarchy to the elements worth acting on: clickable or labelled, enabled, on screen. */
export function summarizeUi(nodes: readonly UiNode[]): { elements: UiElement[]; truncated: boolean; foreground?: string } {
  const useful = nodes.filter((n) => n.enabled && n.bounds.r > n.bounds.l && n.bounds.b > n.bounds.t && (n.clickable || n.text || n.desc));
  const counts = new Map<string, number>();
  for (const n of nodes) if (n.pkg && n.pkg !== "com.android.systemui") counts.set(n.pkg, (counts.get(n.pkg) ?? 0) + 1);
  const foreground = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

  const elements = useful.slice(0, MAX_UI_ELEMENTS).map((n): UiElement => {
    const e: UiElement = { x: Math.round((n.bounds.l + n.bounds.r) / 2), y: Math.round((n.bounds.t + n.bounds.b) / 2), clickable: n.clickable };
    if (n.text) e.text = short(n.text, 80);
    if (n.desc) e.desc = short(n.desc, 80);
    if (n.id) e.id = n.id.split("/").pop() as string;
    if (n.cls) e.cls = n.cls.split(".").pop() as string;
    return e;
  });
  return { elements, truncated: useful.length > MAX_UI_ELEMENTS, ...(foreground ? { foreground } : {}) };
}

const redactElement = (e: UiElement): UiElement => ({ ...e, ...(e.text ? { text: redactSensitive(e.text) } : {}), ...(e.desc ? { desc: redactSensitive(e.desc) } : {}) });

/** What goes into the prompt for one observation. Small, text-only, no binary. */
export function observationForPrompt(o: Observation): Record<string, unknown> {
  return {
    step: o.step,
    deviceState: o.deviceState,
    app: o.app,
    ...(o.screenshotRef ? { screenshotRef: o.screenshotRef } : {}),
    ...(o.recentAction ? { recentAction: o.recentAction } : {}),
    ...(o.actionResult ? { actionResult: o.actionResult } : {}),
    ...(o.ui ? { ui: o.ui.map(redactElement), uiTruncated: o.uiTruncated ?? false } : { ui: "unavailable" }),
    ...(o.logLines && o.logLines.length > 0 ? { errorLogLines: o.logLines.map(redactSensitive) } : {}),
    ...(o.errors.length > 0 ? { errors: o.errors } : {}),
  };
}
