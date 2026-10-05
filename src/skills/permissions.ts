import type { ActionName } from "../agents/exploration/actions.js";

/** What a skill/agent may do. Distinct from device `Capability` (what hardware can do). */
export const PERMISSIONS = [
  "DEVICE_READ",
  "DEVICE_INTERACT",
  "SCREENSHOT",
  "UI_READ",
  "LOG_READ",
  "APP_LAUNCH",
  "APP_INSTALL",
  "NETWORK_TEST",
  "BROWSER_ACCESS",
  "CODE_READ",
  "CODE_WRITE",
  "MCP_READ",
  "MCP_EXECUTE",
  "ADMIN",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export function isPermission(value: unknown): value is Permission {
  return typeof value === "string" && (PERMISSIONS as readonly string[]).includes(value);
}

/** Permissions that change state outside the device UI or run code. Never granted implicitly. */
export const HIGH_RISK_PERMISSIONS: readonly Permission[] = ["APP_INSTALL", "CODE_WRITE", "MCP_EXECUTE", "BROWSER_ACCESS", "ADMIN"];

/**
 * Permission required for each LLM-callable action. Typed as a full Record so adding an action
 * without deciding its permission is a compile error. null = always allowed (no side effect).
 */
export const ACTION_PERMISSION: Readonly<Record<ActionName, Permission | null>> = {
  LAUNCH_APP: "APP_LAUNCH",
  STOP_APP: "APP_LAUNCH",
  TAP: "DEVICE_INTERACT",
  TYPE: "DEVICE_INTERACT",
  SWIPE: "DEVICE_INTERACT",
  BACK: "DEVICE_INTERACT",
  HOME: "DEVICE_INTERACT",
  SCREENSHOT: "SCREENSHOT",
  WAIT: null,
  GET_UI: "UI_READ",
  GET_LOGS: "LOG_READ",
  END_TEST: null,
};

export function permissionForAction(action: ActionName): Permission | null {
  return ACTION_PERMISSION[action];
}

/** True if `granted` covers the action. */
export function actionAllowed(action: ActionName, granted: ReadonlySet<Permission>): boolean {
  const needed = ACTION_PERMISSION[action];
  return needed === null || granted.has(needed);
}
