import type { ActionName } from "../agents/exploration/actions.js";
import { getMcpGroup } from "./mcp.js";
import { actionAllowed, type Permission } from "./permissions.js";
import { KNOWN_TOOLS } from "./tools.js";
import type { SkillRegistry } from "./registry.js";
import type { AgentLimits, AgentProfile, SkillDefinition, SkillEnvironment } from "./types.js";

export interface ProfileSource {
  get(agentId: string): AgentProfile | undefined;
}

export interface ResolveRequest {
  agentId: string;
  task?: { type?: string; objective?: string };
  goal?: string;
  /** Default "runtime". */
  environment?: SkillEnvironment;
}

export interface Resolution {
  readonly agentId: string;
  readonly skills: readonly SkillDefinition[];
  readonly permissions: readonly Permission[];
  readonly tools: readonly string[];
  readonly actions: readonly ActionName[];
  readonly limits?: AgentLimits;
  /** Granted skills whose permissions the agent only partly holds; they run with the permitted subset. */
  readonly restricted: readonly { skillId: string; missing: readonly Permission[] }[];
  /** Skills that matched but the agent may not use, with the reason. */
  readonly denied: readonly { skillId: string; reason: string }[];
  /** Things that matched but cannot run yet (planned skills, planned MCP groups). */
  readonly unavailable: readonly { kind: "skill" | "mcp"; id: string; reason: string }[];
}

const uniq = <T,>(xs: Iterable<T>): T[] => [...new Set(xs)];

/**
 * Picks the skills an agent should use for a task. Deterministic keyword matching, no LLM call, and
 * least privilege: only skills granted in the agent's profile can ever be selected.
 */
export class SkillResolver {
  constructor(
    private readonly registry: SkillRegistry,
    private readonly profiles: ProfileSource,
  ) {}

  resolve(req: ResolveRequest): Resolution {
    const profile = this.profiles.get(req.agentId);
    if (!profile) {
      return { agentId: req.agentId, skills: [], permissions: [], tools: [], actions: [], restricted: [], denied: [{ skillId: "*", reason: `no profile for ${req.agentId}` }], unavailable: [] };
    }
    const text = [req.task?.type, req.task?.objective, req.goal].filter(Boolean).join(" ").toLowerCase();
    const matches = (s: SkillDefinition): boolean => s.alwaysOn === true || s.triggers.some((t) => text.includes(t));
    const granted = new Set(profile.skills);
    const grantedPerms = new Set(profile.permissions);
    const denied: { skillId: string; reason: string }[] = [];
    const unavailable: { kind: "skill" | "mcp"; id: string; reason: string }[] = [];
    const restricted: { skillId: string; missing: Permission[] }[] = [];
    const accepted: SkillDefinition[] = [];

    for (const id of profile.skills) {
      const skill = this.registry.get(id);
      if (!skill) {
        denied.push({ skillId: id, reason: "profile references an unknown skill" });
        continue;
      }
      if (!matches(skill)) continue;
      const compat = this.registry.compatibility(id, { agentId: req.agentId, ...(req.environment ? { environment: req.environment } : {}) });
      if (!compat.ok) {
        denied.push({ skillId: id, reason: compat.reasons.join("; ") });
        continue;
      }
      const missingDep = this.registry.dependencies(id).find((d) => !granted.has(d.id));
      if (missingDep) {
        denied.push({ skillId: id, reason: `dependency ${missingDep.id} is not granted to ${req.agentId}` });
        continue;
      }
      const missing = skill.permissions.filter((p) => !grantedPerms.has(p));
      if (missing.length > 0) restricted.push({ skillId: id, missing });
      accepted.push(skill);
    }

    for (const id of profile.plannedSkills) {
      const skill = this.registry.get(id);
      if (skill && matches(skill)) unavailable.push({ kind: "skill", id, reason: "planned: no runtime behavior exists yet" });
    }

    for (const g of uniq(accepted.flatMap((s) => s.mcpGroups))) {
      if (getMcpGroup(g)?.status !== "available") unavailable.push({ kind: "mcp", id: g, reason: "planned: no MCP server exists yet" });
    }

    const permissions = uniq(accepted.flatMap((s) => s.permissions)).filter((p) => grantedPerms.has(p));
    const effective = new Set(permissions);
    return {
      agentId: req.agentId,
      skills: accepted,
      permissions,
      tools: uniq(accepted.flatMap((s) => s.tools)).filter((t) => effective.has(KNOWN_TOOLS[t]!)),
      actions: uniq(accepted.flatMap((s) => s.actions)).filter((a) => actionAllowed(a, effective)),
      limits: profile.limits,
      restricted,
      denied,
      unavailable,
    };
  }
}
