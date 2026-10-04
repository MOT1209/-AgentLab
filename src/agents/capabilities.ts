/**
 * Tool/skill capabilities an agent may declare.
 * A capability is a declaration of intent, not proof of implementation:
 * screen_recording, inspect_ui and network_control have no Device method yet.
 */
export const CAPABILITIES = [
  // device-backed
  "install_app",
  "launch_app",
  "stop_app",
  "tap",
  "type",
  "screenshot",
  "logs",
  "device_info",
  "screen_recording",
  "inspect_ui",
  "network_control",
  // analysis (no device needed)
  "analyze_results",
  "compare_results",
  "generate_report",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

const KNOWN = new Set<string>(CAPABILITIES);
export function isCapability(value: unknown): value is Capability {
  return typeof value === "string" && KNOWN.has(value);
}
