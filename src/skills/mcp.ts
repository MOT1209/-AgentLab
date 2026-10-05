import type { Permission } from "./permissions.js";

/**
 * MCP capability groups AgentLab intends to support. All are PLANNED: no MCP server or client
 * code exists in this repository. A skill may reference a group so the architecture is explicit,
 * but the resolver reports it as unavailable until its status becomes "available".
 */
export interface McpCapabilityGroup {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly status: "planned" | "available";
  /** Permissions a skill must hold to reference this group. */
  readonly permissions: readonly Permission[];
}

export const MCP_GROUPS: readonly McpCapabilityGroup[] = [
  { id: "mcp-android", name: "Android MCP", description: "Android SDK, emulator and ADB operations exposed as typed tools.", status: "planned", permissions: ["MCP_READ", "MCP_EXECUTE"] },
  { id: "mcp-device", name: "Device MCP", description: "DeviceManager registry, leases and health as tools.", status: "planned", permissions: ["MCP_READ", "MCP_EXECUTE"] },
  { id: "mcp-testing", name: "Testing MCP", description: "Dispatch and inspect tests through the orchestrator.", status: "planned", permissions: ["MCP_READ", "MCP_EXECUTE"] },
  { id: "mcp-evidence", name: "Evidence MCP", description: "Read screenshots, logs and findings produced by runs.", status: "planned", permissions: ["MCP_READ"] },
  { id: "mcp-performance", name: "Performance MCP", description: "Profiling and trace capture tools.", status: "planned", permissions: ["MCP_READ", "MCP_EXECUTE"] },
  { id: "mcp-security", name: "Security MCP", description: "Permission and secret audits.", status: "planned", permissions: ["MCP_READ"] },
  { id: "mcp-browser", name: "Browser MCP", description: "Browser automation, isolated from Android devices.", status: "planned", permissions: ["MCP_EXECUTE", "BROWSER_ACCESS"] },
  { id: "mcp-research", name: "Research MCP", description: "Documentation and web lookup.", status: "planned", permissions: ["MCP_READ"] },
  { id: "mcp-github", name: "GitHub MCP", description: "Repository, issue and CI access.", status: "planned", permissions: ["MCP_READ", "CODE_READ"] },
];

export const MCP_GROUP_IDS: ReadonlySet<string> = new Set(MCP_GROUPS.map((g) => g.id));

export function getMcpGroup(id: string): McpCapabilityGroup | undefined {
  return MCP_GROUPS.find((g) => g.id === id);
}
