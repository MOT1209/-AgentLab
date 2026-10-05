import { test } from "node:test";
import assert from "node:assert/strict";
import { SkillRegistry, validateSkill, type SkillContext } from "../src/skills/registry.js";
import { SkillResolver } from "../src/skills/resolver.js";
import { SkillError, agentMatches, type AgentLimits, type AgentProfile, type SkillDefinition } from "../src/skills/types.js";
import { ACTION_PERMISSION, actionAllowed, type Permission } from "../src/skills/permissions.js";
import { ACTION_NAMES } from "../src/agents/exploration/actions.js";

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
