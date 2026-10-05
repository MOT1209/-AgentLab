import type { AgentDefinition } from "../agents/definitions.js";
import { CANONICAL_DEFINITIONS } from "../agents/organization.js";
import type { DeviceSource } from "../device/types.js";
import { SKILL_CATALOG } from "./catalog.js";
import { CAPABILITY_GATED, DEVICE_PERMISSIONS, isPermission, permissionsForCapabilities, type Permission } from "./permissions.js";
import { SkillRegistry } from "./registry.js";
import { SkillResolver, type ProfileSource } from "./resolver.js";
import type { AgentLimits, AgentProfile } from "./types.js";

const CORE = "agentlab-core";
const QA = "agentlab-android-qa";
const SMOKE = "agentlab-smoke-testing";
const EXPLORE = "agentlab-exploration";
const CRASH = "agentlab-crash-analysis";
const SECURITY = "agentlab-security";

interface Grant {
  readonly skills: readonly string[];
  readonly planned: readonly string[];
}
const g = (skills: readonly string[], planned: readonly string[] = []): Grant => ({ skills, planned });

/**
 * Least-privilege grants for the 24 SUB agents (implemented skills) plus the planned skills each role
 * will need. MAIN profiles are derived as the union of their subs, matching the existing rule that a
 * MAIN agent has no behavior of its own. A skill's dependencies must be granted too (validated).
 */
const SUB_GRANTS: Readonly<Record<string, Grant>> = {
  "MAIN-01-A": g([CORE, QA], ["agentlab-network-testing"]),
  "MAIN-01-B": g([CORE, QA, SMOKE, CRASH], ["agentlab-regression"]),
  "MAIN-02-A": g([CORE, QA, CRASH, EXPLORE], ["agentlab-game-testing", "agentlab-visual-testing"]),
  "MAIN-02-B": g([CORE, QA], ["agentlab-game-testing"]),
  "MAIN-03-A": g([CORE, QA], ["agentlab-visual-testing"]),
  "MAIN-03-B": g([CORE, QA], ["agentlab-visual-testing"]),
  "MAIN-04-A": g([CORE, QA, CRASH, EXPLORE]),
  "MAIN-04-B": g([CORE, QA, CRASH]),
  "MAIN-05-A": g([CORE, QA, CRASH, EXPLORE]),
  "MAIN-05-B": g([CORE, QA, CRASH, EXPLORE]),
  "MAIN-06-A": g([CORE, QA], ["agentlab-performance"]),
  "MAIN-06-B": g([CORE, QA], ["agentlab-performance"]),
  "MAIN-07-A": g([CORE, QA], ["agentlab-accessibility", "agentlab-visual-testing"]),
  "MAIN-07-B": g([CORE, QA], ["agentlab-accessibility"]),
  "MAIN-08-A": g([CORE, QA], ["agentlab-network-testing"]),
  "MAIN-08-B": g([CORE, QA], ["agentlab-network-testing"]),
  "MAIN-09-A": g([CORE, SECURITY]),
  "MAIN-09-B": g([CORE, QA, SECURITY]),
  "MAIN-10-A": g([CORE, QA], ["agentlab-regression"]),
  "MAIN-10-B": g([CORE], ["agentlab-regression", "agentlab-visual-testing"]),
  "MAIN-11-A": g([CORE, QA, SMOKE], ["agentlab-compatibility"]),
  "MAIN-11-B": g([CORE, QA, SMOKE], ["agentlab-compatibility"]),
  "MAIN-12-A": g([CORE], ["agentlab-evaluation", "agentlab-memory"]),
  "MAIN-12-B": g([CORE], ["agentlab-evaluation", "agentlab-observability"]),
};

/** Ceilings. Explorers may run to the existing hard caps (200 steps, 30 min); everyone else gets less. */
const EXPLORER_LIMITS: AgentLimits = { maxSteps: 200, maxLLMCalls: 400, maxTokens: 2_000_000, maxExecutionTimeMs: 1_800_000 };
const DEFAULT_LIMITS: AgentLimits = { maxSteps: 50, maxLLMCalls: 100, maxTokens: 500_000, maxExecutionTimeMs: 600_000 };
const DEVICE_SOURCES: readonly DeviceSource[] = ["MOCK", "EMULATOR", "PHYSICAL"];

const uniq = <T,>(xs: Iterable<T>): T[] => [...new Set(xs)];
const LIMIT_KEYS = ["maxSteps", "maxLLMCalls", "maxTokens", "maxExecutionTimeMs"] as const;

export class ProfileSet implements ProfileSource {
  constructor(private readonly profiles: ReadonlyMap<string, AgentProfile>) {}
  get(agentId: string): AgentProfile | undefined {
    return this.profiles.get(agentId);
  }
  list(): AgentProfile[] {
    return [...this.profiles.values()];
  }
}

export function buildProfiles(registry: SkillRegistry, defs: readonly AgentDefinition[] = CANONICAL_DEFINITIONS): ProfileSet {
  const out = new Map<string, AgentProfile>();
  const permsOf = (skills: readonly string[], def: AgentDefinition): Permission[] => {
    if (!skills.every((s) => registry.get(s))) return [];
    const allowed = permissionsForCapabilities(def.capabilities);
    return registry.resolve(skills).permissions.filter((perm) => !CAPABILITY_GATED.has(perm) || allowed.has(perm));
  };
  for (const def of defs) {
    if (def.kind !== "SUB") continue;
    const grant = SUB_GRANTS[def.id];
    if (!grant) continue;
    const explorer = grant.skills.includes(EXPLORE);
    const permissions = permsOf(grant.skills, def);
    out.set(def.id, {
      agentId: def.id,
      role: def.role,
      skills: grant.skills,
      plannedSkills: grant.planned,
      permissions,
      limits: explorer ? EXPLORER_LIMITS : DEFAULT_LIMITS,
      deviceSources: permissions.some((x) => DEVICE_PERMISSIONS.includes(x)) ? DEVICE_SOURCES : [],
    });
  }
  for (const def of defs) {
    if (def.kind !== "MAIN") continue;
    const subs = defs.filter((d) => d.parentId === def.id).map((d) => out.get(d.id)).filter((p): p is AgentProfile => p !== undefined);
    if (subs.length === 0) continue;
    const limits = Object.fromEntries(LIMIT_KEYS.map((k) => [k, Math.max(...subs.map((s) => s.limits[k]))])) as unknown as AgentLimits;
    out.set(def.id, {
      agentId: def.id,
      role: def.role,
      skills: uniq(subs.flatMap((s) => s.skills)),
      plannedSkills: uniq(subs.flatMap((s) => s.plannedSkills)),
      permissions: uniq(subs.flatMap((s) => s.permissions)),
      limits,
      deviceSources: uniq(subs.flatMap((s) => s.deviceSources)),
    });
  }
  return new ProfileSet(out);
}

/** Every problem that makes the profile set unsafe or inconsistent with the agent definitions. */
export function validateProfiles(profiles: ProfileSet, registry: SkillRegistry, defs: readonly AgentDefinition[] = CANONICAL_DEFINITIONS): string[] {
  const p: string[] = [];
  const ids = new Set(defs.map((d) => d.id));
  for (const def of defs) if (!profiles.get(def.id)) p.push(`${def.id}: no profile`);
  for (const prof of profiles.list()) if (!ids.has(prof.agentId)) p.push(`${prof.agentId}: profile for an unknown agent`);

  for (const def of defs) {
    const prof = profiles.get(def.id);
    if (!prof) continue;
    const bad = (m: string) => p.push(`${def.id}: ${m}`);
    const granted = new Set(prof.skills);
    if (granted.size !== prof.skills.length) bad("duplicate skills");

    for (const id of prof.skills) {
      const skill = registry.get(id);
      if (!skill) {
        bad(`unknown skill ${id}`);
        continue;
      }
      if (skill.status !== "implemented") bad(`${id} is not implemented; list it under plannedSkills`);
      const compat = registry.compatibility(id, { agentId: def.id });
      if (!compat.ok && skill.status === "implemented") bad(compat.reasons.join("; "));
      for (const dep of registry.dependencies(id)) if (!granted.has(dep.id)) bad(`${id} needs ${dep.id}, which is not granted`);
    }
    for (const id of prof.plannedSkills) {
      const skill = registry.get(id);
      if (!skill) bad(`unknown planned skill ${id}`);
      else if (skill.status !== "planned") bad(`${id} is implemented; grant it under skills`);
      else if (!registry.compatibility(id, { agentId: def.id, environment: "claude" }).ok) bad(`planned skill ${id} is not compatible with this agent`);
    }

    for (const perm of prof.permissions) if (!isPermission(perm)) bad(`unknown permission ${String(perm)}`);
    const fromSkills = new Set(registry.resolve(prof.skills.filter((s) => registry.get(s))).permissions);
    for (const perm of prof.permissions) if (!fromSkills.has(perm)) bad(`permission ${perm} is not provided by any granted skill`);
    const allowedByCaps = permissionsForCapabilities(def.capabilities);
    for (const perm of prof.permissions) {
      if (CAPABILITY_GATED.has(perm) && !allowedByCaps.has(perm)) bad(`permission ${perm} exceeds the agent's declared capabilities`);
    }

    for (const k of LIMIT_KEYS) if (!Number.isInteger(prof.limits[k]) || prof.limits[k] <= 0) bad(`limits.${k} must be a positive integer`);
    if (prof.limits.maxCost !== undefined) bad("limits.maxCost requires provider pricing, which is not configured");

    const needsDevice = prof.permissions.some((x) => DEVICE_PERMISSIONS.includes(x));
    if (needsDevice && prof.deviceSources.length === 0) bad("device permissions granted but no deviceSources");
    if (!needsDevice && prof.deviceSources.length > 0) bad("deviceSources set but no device permissions granted");

    if (def.kind === "SUB" && def.parentId) {
      const parent = profiles.get(def.parentId);
      if (parent) {
        for (const s of prof.skills) if (!parent.skills.includes(s)) bad(`skill ${s} is not in parent ${parent.agentId}`);
        for (const perm of prof.permissions) if (!parent.permissions.includes(perm)) bad(`permission ${perm} is not in parent ${parent.agentId}`);
        for (const k of LIMIT_KEYS) if (prof.limits[k] > parent.limits[k]) bad(`limits.${k} exceeds parent ${parent.agentId}`);
        for (const s of prof.deviceSources) if (!parent.deviceSources.includes(s)) bad(`deviceSource ${s} is not in parent ${parent.agentId}`);
      }
    }
  }
  return p;
}

export interface SkillSystem {
  readonly registry: SkillRegistry;
  readonly profiles: ProfileSet;
  readonly resolver: SkillResolver;
}

/** Registry + profiles + resolver for the canonical organization. Throws if anything is inconsistent. */
export function createDefaultSkillSystem(): SkillSystem {
  const registry = new SkillRegistry();
  for (const s of SKILL_CATALOG) registry.register(s);
  const profiles = buildProfiles(registry);
  const problems = [...registry.validate(), ...validateProfiles(profiles, registry)];
  if (problems.length > 0) throw new Error(`default skill system is invalid:\n- ${problems.join("\n- ")}`);
  return { registry, profiles, resolver: new SkillResolver(registry, profiles) };
}
