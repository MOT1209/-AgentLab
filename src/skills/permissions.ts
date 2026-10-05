import type { Capability } from "../agents/capabilities.js";
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

/** Permissions that mean "touches a device"; an agent holding any of them needs a device source. */
export const DEVICE_PERMISSIONS: readonly Permission[] = ["DEVICE_READ", "DEVICE_INTERACT", "SCREENSHOT", "UI_READ", "LOG_READ", "APP_LAUNCH", "APP_INSTALL"];

/**
 * What each existing agent `Capability` implies. An agent's effective permissions are the granted
 * skills' permissions intersected with this, so AgentDefinition.capabilities stays the source of truth.
 */
export const CAPABILITY_PERMISSION: Readonly<Partial<Record<Capability, Permission>>> = {
  install_app: "APP_INSTALL",
  launch_app: "APP_LAUNCH",
  stop_app: "APP_LAUNCH",
  tap: "DEVICE_INTERACT",
  type: "DEVICE_INTERACT",
  swipe: "DEVICE_INTERACT",
  press_key: "DEVICE_INTERACT",
  screenshot: "SCREENSHOT",
  logs: "LOG_READ",
  device_info: "DEVICE_READ",
  inspect_ui: "UI_READ",
  network_control: "NETWORK_TEST",
};

/** Permissions an agent capability can imply; only these are narrowed by AgentDefinition.capabilities. */
export const CAPABILITY_GATED: ReadonlySet<Permission> = new Set(Object.values(CAPABILITY_PERMISSION) as Permission[]);

export function permissionsForCapabilities(caps: readonly Capability[]): Set<Permission> {
  const out = new Set<Permission>();
  for (const c of caps) {
    const perm = CAPABILITY_PERMISSION[c];
    if (perm) out.add(perm);
  }
  return out;
}
