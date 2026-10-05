import type { Permission } from "./permissions.js";

/**
 * Internal tools a skill may declare, each tied to the permission that covers it.
 * These are AgentLab's own Device-abstraction operations, not shell access.
 */
export const KNOWN_TOOLS: Readonly<Record<string, Permission>> = {
  "device.info": "DEVICE_READ",
  "device.screenshot": "SCREENSHOT",
  "device.ui": "UI_READ",
  "device.logs": "LOG_READ",
  "device.launch": "APP_LAUNCH",
  "device.stop": "APP_LAUNCH",
  "device.install": "APP_INSTALL",
  "device.tap": "DEVICE_INTERACT",
  "device.type": "DEVICE_INTERACT",
  "device.swipe": "DEVICE_INTERACT",
  "device.key": "DEVICE_INTERACT",
};

/**
 * Tools that must never be granted to a skill: they would hand an LLM arbitrary shell/ADB/code/
 * credential/account power. Listed so validation can say "dangerous" rather than "unknown".
 */
export const DENIED_TOOLS: readonly string[] = [
  "shell.exec",
  "adb.raw",
  "fs.write",
  "fs.read",
  "code.exec",
  "net.raw",
  "credentials.read",
  "google.account",
  "playstore.publish",
  "playstore.login",
];

export function isDeniedTool(id: string): boolean {
  return DENIED_TOOLS.includes(id) || id.startsWith("shell.") || id.startsWith("playstore.") || id.startsWith("google.");
}
