import { test } from "node:test";
import assert from "node:assert/strict";
import { SkillRegistry, validateSkill, type SkillContext } from "../src/skills/registry.js";
import { SkillResolver } from "../src/skills/resolver.js";
import { SkillError, agentMatches, type AgentLimits, type AgentProfile, type SkillDefinition } from "../src/skills/types.js";
import { ACTION_PERMISSION, actionAllowed, type Permission } from "../src/skills/permissions.js";
import { ACTION_NAMES } from "../src/agents/exploration/actions.js";
import { CANONICAL_DEFINITIONS } from "../src/agents/organization.js";
import { SKILL_CATALOG } from "../src/skills/catalog.js";
import { ProfileSet, buildProfiles, createDefaultSkillSystem, validateProfiles } from "../src/skills/profiles.js";

function skill(over: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    id: "demo-skill",
    name: "Demo skill",
    description: "A skill used by tests.",
    version: "1.0.0",
    category: "testing",
    status: "implemented",
    permissions: ["SCREENSHOT"],
    deviceCapabilities: ["screenshot"],
    actions: ["SCREENSHOT"],
    tools: ["device.screenshot"],
    mcpGroups: [],
    dependencies: [],
    triggers: ["demo"],
    compatibleAgents: ["MAIN-01*"],
    securityLevel: "LOW",
    environmentSupport: "both",
    instructions: "Do the demo.",
    ...over,
  };
}

const LIMITS: AgentLimits = { maxSteps: 20, maxLLMCalls: 30, maxTokens: 100_000, maxExecutionTimeMs: 300_000 };
const profile = (over: Partial<AgentProfile> = {}): AgentProfile => ({
  agentId: "MAIN-01-B",
  role: "core-feature",
  skills: ["demo-skill"],
  plannedSkills: [],
  permissions: ["SCREENSHOT"],
  limits: LIMITS,
  deviceSources: ["MOCK"],
  ...over,
});
const problemsOf = (s: Partial<SkillDefinition>, ctx?: SkillContext) => validateSkill(skill(s), ctx);

test("registry: register, get, list, duplicate prevention", () => {
  const r = new SkillRegistry();
  r.register(skill());
  assert.equal(r.get("demo-skill")!.name, "Demo skill");
  assert.equal(r.list().length, 1);
  assert.throws(() => r.register(skill()), (e: unknown) => e instanceof SkillError && /duplicate skill id/.test(e.message));
  assert.equal(r.list().length, 1);
  assert.equal(r.unregister("nope"), false);
  assert.equal(r.unregister("demo-skill"), true);
  assert.equal(r.get("demo-skill"), undefined);
});

test("validation: unknown or unauthorised permissions, actions, tools and MCP groups are rejected", () => {
  const cases: Array<[string, Partial<SkillDefinition>, RegExp]> = [
    ["unknown permission", { permissions: ["SCREENSHOT", "ROOT" as Permission] }, /unknown permission: ROOT/],
    ["duplicate permission", { permissions: ["SCREENSHOT", "SCREENSHOT"] }, /duplicate permission/],
    ["action without its permission", { actions: ["TAP"] }, /action TAP needs permission DEVICE_INTERACT/],
    ["unknown action", { actions: ["FORMAT_DISK" as never] }, /unknown action/],
    ["dangerous tool", { tools: ["shell.exec"] }, /dangerous tool is not allowed: shell\.exec/],
    ["dangerous tool (account)", { tools: ["google.account"] }, /dangerous tool/],
    ["unknown tool", { tools: ["device.teleport"] }, /unknown tool/],
    ["tool without its permission", { tools: ["device.tap"] }, /tool device\.tap needs permission DEVICE_INTERACT/],
    ["unknown MCP group", { mcpGroups: ["mcp-nope"] }, /unknown MCP group/],
    ["MCP group without permission", { mcpGroups: ["mcp-android"] }, /needs permission MCP_READ/],
    ["high-risk permission at LOW level", { permissions: ["SCREENSHOT", "APP_INSTALL"] }, /APP_INSTALL is high risk/],
    ["CODE_WRITE by default", { permissions: ["SCREENSHOT", "CODE_WRITE"], securityLevel: "HIGH" }, /CODE_WRITE requires explicit approval/],
    ["ADMIN by default", { permissions: ["SCREENSHOT", "ADMIN"], securityLevel: "HIGH" }, /ADMIN requires explicit approval/],
    ["agent pattern matching nothing", { compatibleAgents: ["MAIN-99*"] }, /matches no agent/],
    ["implemented without triggers", { triggers: [] }, /needs triggers or alwaysOn/],
    ["bad id", { id: "Bad Id" }, /id must be/],
    ["bad version", { version: "1" }, /MAJOR\.MINOR\.PATCH/],
  ];
  for (const [label, over, expected] of cases) {
    assert.ok(problemsOf(over).some((p) => expected.test(p)), label);
  }
  assert.deepEqual(problemsOf({}), []);
});

test("validation: CODE_WRITE only passes with explicit high-privilege approval", () => {
  const ctx: SkillContext = { agentIds: new Set(["MAIN-01"]), allowHighPrivilege: true };
  const over = { permissions: ["SCREENSHOT", "CODE_WRITE"] as Permission[], securityLevel: "HIGH" as const, compatibleAgents: ["MAIN-01"] };
  assert.deepEqual(problemsOf(over, ctx), []);
});

test("validation: MCP-referencing skills need the group's permissions", () => {
  const ok = skill({ id: "mcp-user", status: "planned", permissions: ["MCP_READ", "MCP_EXECUTE"], securityLevel: "HIGH", actions: [], tools: [], deviceCapabilities: [], mcpGroups: ["mcp-android"] });
  assert.deepEqual(validateSkill(ok), []);
});

test("agentMatches: wildcard, prefix and exact patterns", () => {
  assert.ok(agentMatches("*", "MAIN-07-B"));
  assert.ok(agentMatches("MAIN-05*", "MAIN-05"));
  assert.ok(agentMatches("MAIN-05*", "MAIN-05-A"));
  assert.ok(!agentMatches("MAIN-05*", "MAIN-06-A"));
  assert.ok(agentMatches("MAIN-05-A", "MAIN-05-A"));
  assert.ok(!agentMatches("MAIN-05-A", "MAIN-05-B"));
});

test("registry: dependencies are ordered, unregister is blocked by dependents, cycles are reported", () => {
  const r = new SkillRegistry();
  r.register(skill({ id: "base", triggers: ["base"] }));
  r.register(skill({ id: "mid", dependencies: ["base"], triggers: ["mid"] }));
  r.register(skill({ id: "top", dependencies: ["mid"], triggers: ["top"] }));
  assert.deepEqual(r.dependencies("top").map((s) => s.id), ["base", "mid", "top"]);
  assert.deepEqual(r.resolve(["top", "mid"]).skills.map((s) => s.id), ["base", "mid", "top"]);
  assert.throws(() => r.unregister("base"), /required by mid/);
  assert.deepEqual(r.validate(), []);

  const c = new SkillRegistry();
  c.register(skill({ id: "a", dependencies: ["b"], triggers: ["a"] }));
  c.register(skill({ id: "b", dependencies: ["a"], triggers: ["b"] }));
  assert.ok(c.validate().some((p) => /dependency cycle/.test(p)));
  assert.throws(() => c.dependencies("a"), /dependency cycle/);
});

test("registry: validate flags unknown dependencies and implemented-on-planned", () => {
  const r = new SkillRegistry();
  r.register(skill({ id: "needs-ghost", dependencies: ["ghost"], triggers: ["x"] }));
  r.register(skill({ id: "planned-one", status: "planned", triggers: ["p"] }));
  r.register(skill({ id: "uses-planned", dependencies: ["planned-one"], triggers: ["u"] }));
  const problems = r.validate();
  assert.ok(problems.some((p) => /unknown skill ghost/.test(p)));
  assert.ok(problems.some((p) => /depends on planned skill planned-one/.test(p)));
});

test("registry: search ranks id/name above description and ignores non-matches", () => {
  const r = new SkillRegistry();
  r.register(skill({ id: "crash-analysis", name: "Crash analysis", description: "Finds crashes.", triggers: ["crash", "anr"] }));
  r.register(skill({ id: "smoke", name: "Smoke", description: "Mentions a crash once.", triggers: ["smoke"] }));
  assert.deepEqual(r.search("crash").map((s) => s.id), ["crash-analysis", "smoke"]);
  assert.deepEqual(r.search("zzz"), []);
  assert.deepEqual(r.search("   "), []);
});

test("registry: compatibility checks status for the runtime and environment for developer assistants", () => {
  const r = new SkillRegistry();
  r.register(skill({ id: "claude-only", environmentSupport: "claude", triggers: ["c"] }));
  r.register(skill({ id: "planned-one", status: "planned", triggers: ["p"] }));
  assert.equal(r.compatibility("claude-only", { environment: "runtime" }).ok, true);
  assert.equal(r.compatibility("claude-only", { environment: "claude" }).ok, true);
  assert.match(r.compatibility("claude-only", { environment: "agent" }).reasons[0]!, /supports claude, not agent/);
  assert.match(r.compatibility("planned-one", { environment: "runtime" }).reasons[0]!, /planned/);
  assert.match(r.compatibility("claude-only", { agentId: "MAIN-09-A" }).reasons[0]!, /not compatible with MAIN-09-A/);
  assert.equal(r.compatibility("ghost").ok, false);
});

test("permissions: every LLM action has an explicit decision and read-only actions need their own permission", () => {
  for (const a of ACTION_NAMES) assert.ok(a in ACTION_PERMISSION, `${a} has no permission decision`);
  const onlyScreenshot = new Set<Permission>(["SCREENSHOT"]);
  assert.ok(actionAllowed("SCREENSHOT", onlyScreenshot));
  assert.ok(actionAllowed("WAIT", onlyScreenshot));
  assert.ok(actionAllowed("END_TEST", onlyScreenshot));
  assert.ok(!actionAllowed("TAP", onlyScreenshot));
  assert.ok(!actionAllowed("LAUNCH_APP", onlyScreenshot));
  assert.ok(!actionAllowed("GET_LOGS", onlyScreenshot));
});

function resolverFixture() {
  const r = new SkillRegistry();
  r.register(skill({ id: "core-rules", category: "core", alwaysOn: true, triggers: [], permissions: [], actions: [], tools: [], deviceCapabilities: [], compatibleAgents: ["*"] }));
  r.register(skill({ id: "shots", triggers: ["screenshot", "visual"] }));
  r.register(skill({ id: "needs-shots", dependencies: ["shots"], triggers: ["compare"] }));
  r.register(skill({ id: "claude-doc", environmentSupport: "claude", triggers: ["docs"] }));
  r.register(skill({ id: "future-visual", status: "planned", triggers: ["visual"] }));
  r.register(skill({ id: "mcp-user", status: "planned", permissions: ["MCP_READ", "MCP_EXECUTE"], securityLevel: "HIGH", actions: [], tools: [], deviceCapabilities: [], mcpGroups: ["mcp-android"], triggers: ["mcp"] }));
  const profiles = new Map<string, AgentProfile>([
    ["MAIN-01-B", profile({ skills: ["core-rules", "shots", "needs-shots", "claude-doc"], plannedSkills: ["future-visual"], permissions: ["SCREENSHOT"] })],
    ["MAIN-01-A", profile({ agentId: "MAIN-01-A", skills: ["core-rules", "needs-shots"], permissions: ["SCREENSHOT"] })],
  ]);
  return new SkillResolver(r, { get: (id) => profiles.get(id) });
}

test("resolver: task text selects skills, alwaysOn skills always apply, planned ones are reported as unavailable", () => {
  const res = resolverFixture().resolve({ agentId: "MAIN-01-B", task: { type: "explore", objective: "find visual bugs and take a screenshot" } });
  assert.deepEqual(res.skills.map((s) => s.id), ["core-rules", "shots"]);
  assert.deepEqual(res.permissions, ["SCREENSHOT"]);
  assert.deepEqual(res.tools, ["device.screenshot"]);
  assert.deepEqual(res.actions, ["SCREENSHOT"]);
  assert.deepEqual(res.unavailable, [{ kind: "skill", id: "future-visual", reason: "planned: no runtime behavior exists yet" }]);
  assert.equal(res.limits, LIMITS);
  assert.deepEqual(res.denied, []);
  assert.deepEqual(res.restricted, []);

  const none = resolverFixture().resolve({ agentId: "MAIN-01-B", task: { type: "unrelated" } });
  assert.deepEqual(none.skills.map((s) => s.id), ["core-rules"]);
});

test("resolver: least privilege - an ungranted dependency or an unknown agent denies instead of selecting", () => {
  const res = resolverFixture().resolve({ agentId: "MAIN-01-A", task: { objective: "compare builds" } });
  assert.deepEqual(res.skills.map((s) => s.id), ["core-rules"]);
  assert.equal(res.denied.length, 1);
  assert.match(res.denied[0]!.reason, /dependency shots is not granted to MAIN-01-A/);

  const ghost = resolverFixture().resolve({ agentId: "MAIN-42", task: { type: "x" } });
  assert.deepEqual(ghost.skills, []);
  assert.match(ghost.denied[0]!.reason, /no profile/);
});

test("resolver: environment compatibility and goal text are honoured", () => {
  const agentEnv = resolverFixture().resolve({ agentId: "MAIN-01-B", goal: "read the docs", environment: "agent" });
  assert.ok(agentEnv.denied.some((d) => d.skillId === "claude-doc" && /supports claude, not agent/.test(d.reason)));
  const claudeEnv = resolverFixture().resolve({ agentId: "MAIN-01-B", goal: "read the docs", environment: "claude" });
  assert.ok(claudeEnv.skills.some((s) => s.id === "claude-doc"));
});

// ---- default catalog and the 36 profiles ----------------------------------------------------------

const system = createDefaultSkillSystem();

test("catalog: valid, unique ids, only skills with behavior (or docs) are implemented", () => {
  assert.deepEqual(system.registry.validate(), []);
  assert.equal(new Set(SKILL_CATALOG.map((c) => c.id)).size, SKILL_CATALOG.length);
  const implemented = system.registry.list({ status: "implemented" }).map((x) => x.id).sort();
  assert.deepEqual(implemented, ["agentlab-android-qa", "agentlab-core", "agentlab-crash-analysis", "agentlab-exploration", "agentlab-security", "agentlab-smoke-testing", "ai-testing-lab"]);
  const mcp = system.registry.get("agentlab-mcp")!;
  assert.equal(mcp.status, "planned");
  assert.equal(mcp.documented, true);
  assert.equal(system.registry.get("ai-testing-lab")!.manual, true);
});

test("profiles: all 12 MAIN and 24 SUB agents have a valid profile", () => {
  const defs = CANONICAL_DEFINITIONS;
  assert.equal(defs.filter((d) => d.kind === "MAIN").length, 12);
  assert.equal(defs.filter((d) => d.kind === "SUB").length, 24);
  assert.equal(system.profiles.list().length, 36);
  for (const d of defs) assert.ok(system.profiles.get(d.id), `${d.id} has no profile`);
  assert.deepEqual(validateProfiles(system.profiles, system.registry), []);
});

test("profiles: a MAIN profile is exactly the union of its subs, and a sub never exceeds its parent", () => {
  for (const main of CANONICAL_DEFINITIONS.filter((d) => d.kind === "MAIN")) {
    const m = system.profiles.get(main.id)!;
    const subs = CANONICAL_DEFINITIONS.filter((d) => d.parentId === main.id).map((d) => system.profiles.get(d.id)!);
    assert.deepEqual([...m.skills].sort(), [...new Set(subs.flatMap((x) => x.skills))].sort(), main.id);
    assert.deepEqual([...m.permissions].sort(), [...new Set(subs.flatMap((x) => x.permissions))].sort(), main.id);
    for (const s of subs) for (const perm of s.permissions) assert.ok(m.permissions.includes(perm));
  }
});

test("least privilege: effective permissions follow each agent's declared capabilities", () => {
  const perms = (id: string) => system.profiles.get(id)!.permissions;
  assert.deepEqual([...perms("MAIN-03-A")].sort(), ["SCREENSHOT", "UI_READ"]);
  assert.deepEqual(perms("MAIN-12-A"), []);
  assert.deepEqual(system.profiles.get("MAIN-12-A")!.deviceSources, []);
  const holders = (perm: Permission) => system.profiles.list().filter((p) => p.permissions.includes(perm)).map((p) => p.agentId).sort();
  assert.deepEqual(holders("APP_INSTALL"), ["MAIN-01", "MAIN-01-B", "MAIN-11", "MAIN-11-A", "MAIN-11-B"]);
  for (const never of ["CODE_WRITE", "ADMIN", "MCP_EXECUTE", "MCP_READ", "BROWSER_ACCESS", "CODE_READ", "NETWORK_TEST"] as Permission[]) assert.deepEqual(holders(never), [], never);
  assert.deepEqual(holders("DEVICE_INTERACT").filter((a) => a.startsWith("MAIN-05")), ["MAIN-05", "MAIN-05-A", "MAIN-05-B"]);
  assert.ok(!perms("MAIN-01-B").includes("DEVICE_INTERACT"));
});

test("profile validation catches unauthorised grants", () => {
  const base = new Map(system.profiles.list().map((p) => [p.agentId, p]));
  const check = (id: string, over: Partial<AgentProfile>) => {
    const m = new Map(base);
    m.set(id, { ...base.get(id)!, ...over });
    return validateProfiles(new ProfileSet(m), system.registry);
  };
  assert.ok(check("MAIN-03-A", { permissions: ["SCREENSHOT", "UI_READ", "LOG_READ"] }).some((p) => /MAIN-03-A: permission LOG_READ exceeds the agent's declared capabilities/.test(p)));
  assert.ok(check("MAIN-03-A", { permissions: ["SCREENSHOT", "UI_READ", "APP_INSTALL"] }).some((p) => /APP_INSTALL/.test(p)));
  assert.ok(check("MAIN-05-A", { skills: ["agentlab-core", "agentlab-exploration"] }).some((p) => /needs agentlab-android-qa, which is not granted/.test(p)));
  assert.ok(check("MAIN-05-A", { skills: ["agentlab-core", "agentlab-android-qa", "agentlab-crash-analysis", "agentlab-exploration", "agentlab-mcp"] }).some((p) => /agentlab-mcp is not implemented/.test(p)));
  assert.ok(check("MAIN-05-A", { skills: ["agentlab-core", "ghost"] }).some((p) => /unknown skill ghost/.test(p)));
  assert.ok(check("MAIN-03-A", { skills: ["agentlab-core", "agentlab-android-qa", "agentlab-exploration"] }).some((p) => /agentlab-exploration is not in parent|not compatible with MAIN-03-A/.test(p)));
  assert.ok(check("MAIN-03-A", { plannedSkills: ["agentlab-core"] }).some((p) => /agentlab-core is implemented; grant it under skills/.test(p)));
  assert.ok(check("MAIN-03-A", { limits: { ...LIMITS, maxCost: 5 } }).some((p) => /maxCost requires provider pricing/.test(p)));
  assert.ok(check("MAIN-03-A", { limits: { ...LIMITS, maxTokens: 0 } }).some((p) => /maxTokens must be a positive integer/.test(p)));
  assert.ok(check("MAIN-03-A", { deviceSources: [] }).some((p) => /device permissions granted but no deviceSources/.test(p)));
  const without = new Map(base);
  without.delete("MAIN-09-B");
  assert.ok(validateProfiles(new ProfileSet(without), system.registry).some((p) => /MAIN-09-B: no profile/.test(p)));
  const sub = check("MAIN-04-B", { limits: { ...LIMITS, maxSteps: 9999 } });
  assert.ok(sub.some((p) => /limits.maxSteps exceeds parent MAIN-04/.test(p)));
});

test("resolver (real catalog): exploration is selected for the explorer, not for a layout tester", () => {
  const explore = system.resolver.resolve({ agentId: "MAIN-05-A", task: { type: "explore", objective: "find crashes in the app" } });
  assert.deepEqual(explore.skills.map((x) => x.id).sort(), ["agentlab-android-qa", "agentlab-core", "agentlab-crash-analysis", "agentlab-exploration"]);
  assert.deepEqual([...explore.actions].sort(), [...ACTION_NAMES].sort());
  assert.equal(explore.limits!.maxSteps, 200);

  const layout = system.resolver.resolve({ agentId: "MAIN-03-A", task: { type: "explore", objective: "find visual bugs" } });
  assert.ok(!layout.skills.some((x) => x.id === "agentlab-exploration"));
  assert.ok(layout.unavailable.some((u) => u.id === "agentlab-visual-testing"));
  assert.ok(!layout.actions.includes("TAP"));
});

test("resolver (real catalog): a partly-permitted skill is restricted to the permitted subset", () => {
  const res = system.resolver.resolve({ agentId: "MAIN-01-B", task: { type: "smoke", objective: "check the app on the device" } });
  assert.ok(res.skills.some((x) => x.id === "agentlab-smoke-testing"));
  const qa = res.restricted.find((r) => r.skillId === "agentlab-android-qa")!;
  assert.deepEqual([...qa.missing].sort(), ["DEVICE_READ", "UI_READ"]);
  assert.ok(!res.actions.includes("GET_UI"));
  assert.ok(res.actions.includes("GET_LOGS"));
  assert.ok(!res.tools.includes("device.ui"));
  assert.ok(res.tools.includes("device.install"));
});

test("resolver (real catalog): MCP and planned skills are reported unavailable, never granted", () => {
  const res = system.resolver.resolve({ agentId: "MAIN-12-A", task: { objective: "evaluate results and use mcp" } });
  assert.deepEqual(res.skills.map((x) => x.id), ["agentlab-core"]);
  assert.ok(res.unavailable.some((u) => u.kind === "skill" && u.id === "agentlab-evaluation"));
  assert.deepEqual(res.permissions, []);
  assert.deepEqual(res.actions, []);
});

test("buildProfiles on a custom organization yields no profiles (grants are for the canonical ids only)", () => {
  assert.equal(buildProfiles(system.registry, []).list().length, 0);
});
