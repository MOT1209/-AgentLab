import type { Capability } from "../agents/capabilities.js";
import type { ActionName } from "../agents/exploration/actions.js";
import type { DeviceSource } from "../device/types.js";
import type { Permission } from "./permissions.js";

export const SKILL_CATEGORIES = [
  "core",
  "agent",
  "android",
  "testing",
  "security",
  "mcp",
  "performance",
  "visual",
  "accessibility",
  "network",
  "regression",
  "compatibility",
  "game",
  "browser",
  "coding",
  "evaluation",
  "memory",
  "observability",
] as const;
export type SkillCategory = (typeof SKILL_CATEGORIES)[number];

/** "planned" skills are catalogued but never resolvable for execution: no behavior exists behind them. */
export type SkillStatus = "implemented" | "planned";
export type SecurityLevel = "LOW" | "MEDIUM" | "HIGH";

/** Which developer-assistant directories get a generated SKILL.md for this skill. */
export type EnvironmentSupport = "claude" | "agent" | "both";
/** Where a resolution is requested: AgentLab's own runtime, or a developer assistant. */
export type SkillEnvironment = "runtime" | "claude" | "agent";

/** Canonical, single definition of a skill. Adapters (.claude, .agent) are generated from it. */
export interface SkillDefinition {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly category: SkillCategory;
  readonly status: SkillStatus;
  readonly permissions: readonly Permission[];
  /** Device capabilities (existing vocabulary) the skill needs from a leased device. */
  readonly deviceCapabilities: readonly Capability[];
  /** LLM-callable exploration actions this skill enables. Each must be covered by `permissions`. */
  readonly actions: readonly ActionName[];
  readonly tools: readonly string[];
  readonly mcpGroups: readonly string[];
  readonly dependencies: readonly string[];
  /** Lower-case keywords; a task/goal containing one selects the skill. */
  readonly triggers: readonly string[];
  /** Agent ids; "*" for all, or a trailing-* prefix such as "MAIN-05*" (matches MAIN-05, MAIN-05-A, MAIN-05-B). */
  readonly compatibleAgents: readonly string[];
  readonly securityLevel: SecurityLevel;
  readonly environmentSupport: EnvironmentSupport;
  /** Selected for every task of a compatible agent (e.g. core rules). */
  readonly alwaysOn?: boolean;
  /** Hand-written elsewhere (e.g. ai-testing-lab). Validated, never generated or overwritten. */
  readonly manual?: boolean;
  /** Shared body written into every generated SKILL.md. */
  readonly instructions: string;
  /** Optional extra text per developer environment. */
  readonly perEnvironment?: Partial<Record<"claude" | "agent", string>>;
}

export interface AgentLimits {
  readonly maxSteps: number;
  readonly maxLLMCalls: number;
  readonly maxTokens: number;
  readonly maxExecutionTimeMs: number;
  /** Requires provider pricing; a profile with maxCost and no pricing is rejected, not ignored. */
  readonly maxCost?: number;
}

/** What one agent is allowed to use. Runtime data derived from catalog + profiles; AgentDefinition stays static. */
export interface AgentProfile {
  readonly agentId: string;
  readonly role: string;
  /** Implemented skills granted to the agent. */
  readonly skills: readonly string[];
  /** Skills the role will need but that are not built yet (documentation of intent, not a grant). */
  readonly plannedSkills: readonly string[];
  /** Union of the granted skills' permissions. */
  readonly permissions: readonly Permission[];
  readonly limits: AgentLimits;
  readonly deviceSources: readonly DeviceSource[];
}

export class SkillError extends Error {
  constructor(
    readonly problems: readonly string[],
    context = "skill validation failed",
  ) {
    super(`${context}: ${problems.join("; ")}`);
    this.name = "SkillError";
  }
}

/** True if `pattern` ("*", "MAIN-05*" or an exact id) matches `agentId`. */
export function agentMatches(pattern: string, agentId: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith("*")) return agentId.startsWith(pattern.slice(0, -1));
  return pattern === agentId;
}
