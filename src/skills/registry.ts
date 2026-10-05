import { isCapability } from "../agents/capabilities.js";
import { ACTION_NAMES } from "../agents/exploration/actions.js";
import { CANONICAL_DEFINITIONS } from "../agents/organization.js";
import { getMcpGroup } from "./mcp.js";
import { ACTION_PERMISSION, HIGH_RISK_PERMISSIONS, isPermission, type Permission } from "./permissions.js";
import { KNOWN_TOOLS, isDeniedTool } from "./tools.js";
import {
  SKILL_CATEGORIES,
  SkillError,
  agentMatches,
  type SkillDefinition,
  type SkillEnvironment,
} from "./types.js";

export interface SkillContext {
  /** Agent ids that `compatibleAgents` patterns are checked against. Defaults to the canonical 36. */
  readonly agentIds: ReadonlySet<string>;
  /** CODE_WRITE and ADMIN are rejected unless this is true. Default false: they need explicit approval. */
  readonly allowHighPrivilege?: boolean;
}

export const DEFAULT_CONTEXT: SkillContext = { agentIds: new Set(CANONICAL_DEFINITIONS.map((d) => d.id)) };

const ID = /^[a-z][a-z0-9-]*$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
const ENVIRONMENTS = ["claude", "agent", "both"] as const;
const LEVELS = ["LOW", "MEDIUM", "HIGH"] as const;

/** Problems with one skill in isolation (cross-skill checks live in SkillRegistry.validate). */
export function validateSkill(skill: SkillDefinition, ctx: SkillContext = DEFAULT_CONTEXT): string[] {
  const label = typeof skill?.id === "string" && skill.id ? skill.id : "<no id>";
  const p: string[] = [];
  const bad = (m: string) => p.push(`${label}: ${m}`);

  if (typeof skill.id !== "string" || !ID.test(skill.id)) bad("id must be lower-case letters, digits and dashes");
  if (!skill.name?.trim()) bad("name is required");
  if (!skill.description?.trim()) bad("description is required");
  else if (skill.description.length > 1024) bad("description is longer than 1024 characters");
  if (!SEMVER.test(skill.version ?? "")) bad("version must be MAJOR.MINOR.PATCH");
  if (!SKILL_CATEGORIES.includes(skill.category)) bad(`unknown category: ${String(skill.category)}`);
  if (skill.status !== "implemented" && skill.status !== "planned") bad("status must be implemented or planned");
  if (!LEVELS.includes(skill.securityLevel)) bad("securityLevel must be LOW, MEDIUM or HIGH");
  if (!ENVIRONMENTS.includes(skill.environmentSupport)) bad("environmentSupport must be claude, agent or both");

  const perms = new Set<Permission>();
  for (const perm of skill.permissions ?? []) {
    if (!isPermission(perm)) bad(`unknown permission: ${String(perm)}`);
    else if (perms.has(perm)) bad(`duplicate permission: ${perm}`);
    else perms.add(perm);
  }
  for (const perm of perms) {
    if ((perm === "CODE_WRITE" || perm === "ADMIN") && !ctx.allowHighPrivilege) bad(`${perm} requires explicit approval and is not granted by default`);
    if (HIGH_RISK_PERMISSIONS.includes(perm) && skill.securityLevel !== "HIGH") bad(`${perm} is high risk; securityLevel must be HIGH`);
  }

  for (const c of skill.deviceCapabilities ?? []) if (!isCapability(c)) bad(`unknown device capability: ${String(c)}`);

  for (const a of skill.actions ?? []) {
    if (!(ACTION_NAMES as readonly string[]).includes(a)) {
      bad(`unknown action: ${String(a)}`);
      continue;
    }
    const needed = ACTION_PERMISSION[a];
    if (needed !== null && !perms.has(needed)) bad(`action ${a} needs permission ${needed}`);
  }

  for (const t of skill.tools ?? []) {
    if (isDeniedTool(t)) bad(`dangerous tool is not allowed: ${t}`);
    else if (!(t in KNOWN_TOOLS)) bad(`unknown tool: ${t}`);
    else if (!perms.has(KNOWN_TOOLS[t]!)) bad(`tool ${t} needs permission ${KNOWN_TOOLS[t]!}`);
  }

  for (const g of skill.mcpGroups ?? []) {
    const group = getMcpGroup(g);
    if (!group) {
      bad(`unknown MCP group: ${g}`);
      continue;
    }
    for (const need of group.permissions) if (!perms.has(need)) bad(`MCP group ${g} needs permission ${need}`);
  }

  for (const d of skill.dependencies ?? []) {
    if (!ID.test(d)) bad(`invalid dependency id: ${d}`);
    if (d === skill.id) bad("a skill cannot depend on itself");
  }

  if (!skill.compatibleAgents?.length) bad("compatibleAgents must not be empty");
  for (const pattern of skill.compatibleAgents ?? []) {
    if (![...ctx.agentIds].some((id) => agentMatches(pattern, id))) bad(`compatibleAgents pattern matches no agent: ${pattern}`);
  }

  if (skill.status === "implemented" && !skill.alwaysOn && !skill.triggers?.length) bad("an implemented skill needs triggers or alwaysOn");
  for (const t of skill.triggers ?? []) if (t !== t.toLowerCase() || !t.trim()) bad(`trigger must be non-empty lower-case: "${t}"`);
  if (!skill.manual && !skill.instructions?.trim()) bad("instructions are required");
  return p;
}

export interface ResolvedSet {
  /** Dependencies first, no duplicates. */
  readonly skills: readonly SkillDefinition[];
  readonly permissions: readonly Permission[];
  readonly tools: readonly string[];
  readonly mcpGroups: readonly string[];
  readonly actions: readonly string[];
}

export interface Compatibility {
  readonly ok: boolean;
  readonly reasons: readonly string[];
}

/** The one registry of canonical skills. */
export class SkillRegistry {
  private readonly skills = new Map<string, SkillDefinition>();

  constructor(private readonly ctx: SkillContext = DEFAULT_CONTEXT) {}

  register(skill: SkillDefinition): void {
    const problems = validateSkill(skill, this.ctx);
    if (this.skills.has(skill.id)) problems.push(`${skill.id}: duplicate skill id`);
    if (problems.length > 0) throw new SkillError(problems, `cannot register ${skill?.id ?? "skill"}`);
    this.skills.set(skill.id, skill);
  }

  /** Refuses while another skill depends on it. Returns false if it was not registered. */
  unregister(id: string): boolean {
    if (!this.skills.has(id)) return false;
    const dependents = this.list().filter((s) => s.dependencies.includes(id)).map((s) => s.id);
    if (dependents.length > 0) throw new SkillError([`${id} is required by ${dependents.join(", ")}`], `cannot unregister ${id}`);
    return this.skills.delete(id);
  }

  get(id: string): SkillDefinition | undefined {
    return this.skills.get(id);
  }

  list(filter: { status?: SkillDefinition["status"]; category?: SkillDefinition["category"] } = {}): SkillDefinition[] {
    return [...this.skills.values()].filter((s) => (!filter.status || s.status === filter.status) && (!filter.category || s.category === filter.category));
  }

  /** Free-text search over id, name, triggers and description. Best matches first. */
  search(query: string): SkillDefinition[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return [];
    const scored = this.list().map((s) => {
      let score = 0;
      for (const w of words) {
        if (s.id.includes(w) || s.name.toLowerCase().includes(w)) score += 3;
        if (s.triggers.some((t) => t.includes(w) || w.includes(t))) score += 2;
        if (s.description.toLowerCase().includes(w)) score += 1;
      }
      return { s, score };
    });
    return scored.filter((x) => x.score > 0).sort((a, b) => b.score - a.score || a.s.id.localeCompare(b.s.id)).map((x) => x.s);
  }

  /** Transitive dependencies of `id`, dependencies first, ending with the skill itself. */
  dependencies(id: string): SkillDefinition[] {
    const out: SkillDefinition[] = [];
    const done = new Set<string>();
    const visiting: string[] = [];
    const visit = (cur: string): void => {
      if (done.has(cur)) return;
      if (visiting.includes(cur)) throw new SkillError([`dependency cycle: ${[...visiting, cur].join(" -> ")}`]);
      const skill = this.skills.get(cur);
      if (!skill) throw new SkillError([`unknown skill: ${cur}`]);
      visiting.push(cur);
      for (const d of skill.dependencies) visit(d);
      visiting.pop();
      done.add(cur);
      out.push(skill);
    };
    visit(id);
    return out;
  }

  /** The skills plus everything they depend on, with the union of what they need. */
  resolve(ids: readonly string[]): ResolvedSet {
    const seen = new Set<string>();
    const skills: SkillDefinition[] = [];
    for (const id of ids) for (const s of this.dependencies(id)) if (!seen.has(s.id)) (seen.add(s.id), skills.push(s));
    const uniq = <T,>(xs: Iterable<T>): T[] => [...new Set(xs)];
    return {
      skills,
      permissions: uniq(skills.flatMap((s) => s.permissions)),
      tools: uniq(skills.flatMap((s) => s.tools)),
      mcpGroups: uniq(skills.flatMap((s) => s.mcpGroups)),
      actions: uniq(skills.flatMap((s) => s.actions)),
    };
  }

  compatibility(id: string, opts: { agentId?: string; environment?: SkillEnvironment } = {}): Compatibility {
    const skill = this.skills.get(id);
    if (!skill) return { ok: false, reasons: [`unknown skill: ${id}`] };
    const reasons: string[] = [];
    const env = opts.environment ?? "runtime";
    if (env === "runtime") {
      if (skill.status !== "implemented") reasons.push(`${id} is planned; no runtime behavior exists`);
    } else if (skill.environmentSupport !== "both" && skill.environmentSupport !== env) {
      reasons.push(`${id} supports ${skill.environmentSupport}, not ${env}`);
    }
    if (opts.agentId && !skill.compatibleAgents.some((p) => agentMatches(p, opts.agentId!))) reasons.push(`${id} is not compatible with ${opts.agentId}`);
    return { ok: reasons.length === 0, reasons };
  }

  /** Cross-skill checks: dependencies exist, no cycles, an implemented skill never relies on a planned one. */
  validate(): string[] {
    const p: string[] = [];
    for (const s of this.skills.values()) {
      p.push(...validateSkill(s, this.ctx));
      for (const d of s.dependencies) {
        const dep = this.skills.get(d);
        if (!dep) p.push(`${s.id}: depends on unknown skill ${d}`);
        else if (s.status === "implemented" && dep.status !== "implemented") p.push(`${s.id}: implemented skill depends on planned skill ${d}`);
      }
    }
    for (const s of this.skills.values()) {
      try {
        this.dependencies(s.id);
      } catch (e) {
        if (e instanceof SkillError && e.problems.some((x) => x.startsWith("dependency cycle"))) p.push(`${s.id}: ${e.problems.join("; ")}`);
      }
    }
    return [...new Set(p)];
  }
}
