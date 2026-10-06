import { ACTION_NAMES } from "../agents/exploration/actions.js";
import { MCP_GROUPS } from "./mcp.js";
import type { SkillDefinition } from "./types.js";

/**
 * The canonical skill catalog: the single source for .claude/skills and .agent/skills.
 * Only skills with real behavior (or an explicit architecture document) are "implemented"/"documented".
 * Everything else is catalogued as "planned" so the roadmap is visible without empty folders.
 * Generated files add Permissions/Tools/Environment sections from the fields below, so those cannot drift.
 */

const DEVICE_AGENTS = ["MAIN-01*", "MAIN-02*", "MAIN-03*", "MAIN-04*", "MAIN-05*", "MAIN-06*", "MAIN-07*", "MAIN-08*", "MAIN-09*", "MAIN-10*", "MAIN-11*"];

const core: SkillDefinition = {
  id: "agentlab-core",
  name: "AgentLab core rules",
  description: "Project-wide rules for working on or with AgentLab: fixed 12 main / 24 sub agent organization, device access only through the Device abstraction, BLOCKED vs ERROR semantics, no secrets, project memory discipline. Use for any AgentLab task.",
  version: "1.0.0",
  category: "core",
  status: "implemented",
  permissions: [],
  deviceCapabilities: [],
  actions: [],
  tools: [],
  mcpGroups: [],
  dependencies: [],
  triggers: [],
  alwaysOn: true,
  compatibleAgents: ["*"],
  securityLevel: "LOW",
  environmentSupport: "both",
  instructions: `## Purpose
Keep every change consistent with the architecture that already exists.

## When to use
Any task in this repository, whatever the topic.

## When not to use
Never skipped; more specific skills add to these rules, they do not replace them.

## Workflow
1. Read \`.claude/project-memory/current-phase.md\`, \`decisions.md\` and \`known-issues.md\` before important work.
2. Search for an existing implementation before creating one; extend it when it fits.
3. Work in small phases: understand, inspect, plan, implement, test, fix, review, update memory.
4. Run \`npm run typecheck\` and \`npm test\` before calling anything done.

## Safety
- The organization is exactly 12 MAIN agents and 24 SUB agents (ids MAIN-NN, MAIN-NN-A|B); \`src/agents/organization.ts\` is the single source of truth. Do not add agents.
- Devices are reached only through the Device abstraction (DeviceManager, leases, MockDevice, AdbDevice). Do not build a second device layer.
- A permission or environment problem is BLOCKED, not ERROR.
- Never put keys, tokens or credentials in code, config, logs, reports, memory or generated skills. Configs hold environment-variable names only.
- Do not automate Google accounts, OAuth or the Play Store.

## AgentLab-specific rules
Real-device testing is opt-in; normal CI must pass with no device and no API key.`,
};

const androidQa: SkillDefinition = {
  id: "agentlab-android-qa",
  name: "Android QA through the Device abstraction",
  description: "Observe and operate Android devices and emulators through AgentLab's Device abstraction (MockDevice, AdbDevice): launch and stop the app under test, take screenshots, read the UI hierarchy and logs. Use for any task that touches a device.",
  version: "1.0.0",
  category: "android",
  status: "implemented",
  permissions: ["DEVICE_READ", "SCREENSHOT", "UI_READ", "LOG_READ", "APP_LAUNCH"],
  deviceCapabilities: ["device_info", "screenshot", "inspect_ui", "logs", "launch_app", "stop_app"],
  actions: ["LAUNCH_APP", "STOP_APP", "SCREENSHOT", "GET_UI", "GET_LOGS", "WAIT", "END_TEST"],
  tools: ["device.info", "device.screenshot", "device.ui", "device.logs", "device.launch", "device.stop"],
  mcpGroups: [],
  dependencies: [],
  triggers: ["android", "device", "adb", "emulator", "screenshot", "logcat", "ui hierarchy", "launch", "app"],
  compatibleAgents: DEVICE_AGENTS,
  securityLevel: "MEDIUM",
  environmentSupport: "both",
  instructions: `## Purpose
Use devices safely and uniformly, whether the device is a mock, an emulator or a physical phone.

## When to use
Tasks that need to see or drive an app on a device.

## When not to use
Analysis-only tasks (comparing results, writing reports) that need no device.

## Workflow
1. A MAIN agent holds one exclusive device lease for the task; sub-agents run under it and never lease on their own.
2. Check device readiness (\`DeviceManager.checkHealth\`) before work; an unready device makes the task BLOCKED.
3. Act only through Device methods; the app under test comes from the task's \`app.packageName\`.
4. Store screenshots and logs as evidence; release the lease on every exit path.

## Safety
- No raw ADB or shell access for any model or skill. Package names are validated before reaching adb.
- The model sees UI element text and error-level log lines, not image bytes. Apps that show personal data would leak it to the LLM provider.
- \`ADB_PATH\` selects the adb binary; \`adb devices\` must list the device as \`device\` (not \`unauthorized\`).

## AgentLab-specific rules
MockDevice and AdbDevice are the only device implementations; real hardware stays opt-in.`,
};

const smoke: SkillDefinition = {
  id: "agentlab-smoke-testing",
  name: "Smoke testing (install, launch, check)",
  description: "Run the deterministic smoke check: install an APK, launch the app, capture a screenshot and logs, detect crash or ANR markers, stop the app. Use for the first check of a build; no LLM involved.",
  version: "1.0.0",
  category: "testing",
  status: "implemented",
  permissions: ["APP_INSTALL", "APP_LAUNCH", "SCREENSHOT", "LOG_READ"],
  deviceCapabilities: ["install_app", "launch_app", "stop_app", "screenshot", "logs"],
  actions: [],
  tools: ["device.install", "device.launch", "device.stop", "device.screenshot", "device.logs"],
  mcpGroups: [],
  dependencies: ["agentlab-android-qa"],
  triggers: ["smoke", "install", "sanity"],
  compatibleAgents: ["MAIN-01*", "MAIN-11*"],
  securityLevel: "HIGH",
  environmentSupport: "both",
  instructions: `## Purpose
Answer "does this build install and start without crashing?" quickly and repeatably.

## When to use
Task type \`smoke\`, payload \`{ apkPath, packageName }\`, dispatched to MAIN-01 (handled by MAIN-01-B).

## When not to use
Exploring behavior or judging UI quality; use exploration for that.

## Workflow
install -> launch -> screenshot -> read logs -> check for FATAL EXCEPTION / ANR -> stop. PASSED if no marker, FAILED otherwise.

## Safety
Installing an APK changes the device, so APP_INSTALL is a high-risk permission and is granted only to agents that need it. The apk path comes from the task payload, never from a model.

## AgentLab-specific rules
Crash detection is a log-marker match, not a classifier. The smoke handler does not clear logcat first.`,
};

const exploration: SkillDefinition = {
  id: "agentlab-exploration",
  name: "LLM-driven exploration",
  description: "Explore an app autonomously with a bounded observe, decide, validate, execute loop over a fixed set of 12 device actions, collecting evidence and verified crash findings. Use for exploratory, edge-case and goal-driven testing.",
  version: "1.0.0",
  category: "testing",
  status: "implemented",
  permissions: ["DEVICE_INTERACT", "UI_READ", "SCREENSHOT", "LOG_READ", "APP_LAUNCH"],
  deviceCapabilities: ["launch_app", "stop_app", "tap", "type", "swipe", "press_key", "screenshot", "inspect_ui", "logs"],
  actions: [...ACTION_NAMES],
  tools: ["device.launch", "device.stop", "device.tap", "device.type", "device.swipe", "device.key", "device.ui", "device.screenshot", "device.logs"],
  mcpGroups: [],
  dependencies: ["agentlab-android-qa", "agentlab-crash-analysis"],
  triggers: ["explore", "exploration", "exploratory", "autonomous", "edge case", "navigate", "goal"],
  compatibleAgents: ["MAIN-02*", "MAIN-04*", "MAIN-05*"],
  securityLevel: "MEDIUM",
  environmentSupport: "both",
  instructions: `## Purpose
Find defects without a fixed script, within hard limits.

## When to use
Task type \`explore\`, payload \`{ objective, app?, maxSteps, timeoutMs }\`, dispatched to MAIN-05 (handled by MAIN-05-A).

## When not to use
Deterministic install/launch checks (use smoke) or when no LLM provider is configured (the task is BLOCKED).

## Workflow
The loop is observe (UI text, error logs, evidence ids) -> ask the model for ONE JSON action -> validate -> execute -> observe.
Mapping to a goal loop: understand = objective in the prompt; plan = the model's next action; execute/observe = the loop; verify = VERIFIED crash findings from logs; replan = the next turn. Independent goal verification and explicit replanning are NOT built yet.

## Safety
- \`validateDecision\` is the only path from model output to an action. Allowed actions: ${ACTION_NAMES.join(", ")}. There is no shell, ADB, file or network action, and no action takes a package name.
- The effective action set is narrowed to what the agent's profile permits; a denied action is rejected before it runs.
- Limits: maxSteps, timeout, cancellation, repeated-action stop, and the profile's ceilings (maxSteps, maxExecutionTimeMs, maxLLMCalls, maxTokens), each the smaller of the task's and the profile's value. LLM-call and token ceilings are checked before every model call, including the correction retry; tokens are known only after a call, so one call can overshoot the token ceiling. Hitting one ends the run as BUDGET_EXCEEDED, which the platform reports as BLOCKED.

## AgentLab-specific rules
The model is blind to pixels; games, WebViews and canvases expose little UI hierarchy, so exploration there is weak. AI observations never fail a task; only VERIFIED findings do.`,
};

const crash: SkillDefinition = {
  id: "agentlab-crash-analysis",
  name: "Crash and ANR detection from logs",
  description: "Detect crashes and ANRs by matching known markers in device logs and report them as verified findings with evidence. Use after launching or exercising an app.",
  version: "1.0.0",
  category: "testing",
  status: "implemented",
  permissions: ["LOG_READ"],
  deviceCapabilities: ["logs"],
  actions: ["GET_LOGS"],
  tools: ["device.logs"],
  mcpGroups: [],
  dependencies: ["agentlab-android-qa"],
  triggers: ["crash", "anr", "fatal", "exception", "stability", "logcat"],
  compatibleAgents: ["MAIN-01*", "MAIN-02*", "MAIN-04*", "MAIN-05*"],
  securityLevel: "MEDIUM",
  environmentSupport: "both",
  instructions: `## Purpose
Turn log lines into trustworthy crash findings.

## When to use
After a launch or a batch of actions, to decide whether the app crashed or hung.

## When not to use
Root-cause analysis or crash clustering; only marker matching exists.

## Workflow
Clear logs at launch where supported, read recent logs, match FATAL EXCEPTION, ANR in, Fatal signal and process-died markers, attach the matching lines as evidence.

## Safety
Logs can contain personal data. Redact before reporting and never send them to a provider you do not control.

## AgentLab-specific rules
A marker match is VERIFIED and CRITICAL; it fails the task. This is not a classifier, and the known-issues file says so.`,
};

const security: SkillDefinition = {
  id: "agentlab-security",
  name: "AgentLab security rules",
  description: "Security rules for AgentLab itself: least-privilege permissions, environment-variable-only secrets, no raw shell/ADB/code/MCP execution for models, prompt-injection caution for third-party skills. Use when changing permissions, providers, skills or any code that touches credentials.",
  version: "1.0.0",
  category: "security",
  status: "implemented",
  permissions: [],
  deviceCapabilities: [],
  actions: [],
  tools: [],
  mcpGroups: [],
  dependencies: [],
  triggers: ["security", "secret", "credential", "permission", "privacy", "token", "password", "injection", "authorization"],
  compatibleAgents: ["*"],
  securityLevel: "LOW",
  environmentSupport: "both",
  instructions: `## Purpose
Prevent a model, a skill or a config from gaining power it was not explicitly given.

## When to use
Touching permissions, provider config, API keys, skills, or anything that executes on a device.

## When not to use
Testing an app's own security; that is a separate, not yet built, capability.

## Workflow
1. Declare the permissions a skill needs; grant them per agent in its profile, least privilege.
2. Keep keys in the environment; configs hold only the variable NAME.
3. Treat third-party skills as untrusted: read every file, check scripts and network use, and prefer wrapping or rewriting over copying.

## Safety
- Never let a model execute arbitrary shell, ADB, code, MCP calls or credential/Google/Play Store actions. CODE_WRITE and ADMIN are never granted by default.
- Dangerous tools (shell.*, adb.raw, fs.*, code.exec, credentials.*, google.*, playstore.*) are rejected by validation.
- The web UI binds to 127.0.0.1 and requires a random launch token; never expose it beyond localhost.

## AgentLab-specific rules
No Google account, OAuth or Play Store automation. Permission denials are BLOCKED, not ERROR.`,
};

const mcp: SkillDefinition = {
  id: "agentlab-mcp",
  name: "MCP architecture (planned)",
  description: "Architecture guide for future MCP capability groups in AgentLab (Android, Device, Testing, Evidence). No MCP server or client exists yet. Use when designing or building MCP tools for AgentLab.",
  version: "0.1.0",
  category: "mcp",
  status: "planned",
  documented: true,
  permissions: ["MCP_READ", "MCP_EXECUTE"],
  deviceCapabilities: [],
  actions: [],
  tools: [],
  mcpGroups: ["mcp-android", "mcp-device", "mcp-testing", "mcp-evidence"],
  dependencies: [],
  triggers: ["mcp", "model context protocol", "tool server"],
  compatibleAgents: ["*"],
  securityLevel: "HIGH",
  environmentSupport: "both",
  instructions: `## Purpose
Record where MCP fits so it can be added without a second architecture.

## When to use
Designing an MCP server for AgentLab. For the actual server-building workflow use Anthropic's \`mcp-builder\` skill (Apache-2.0, anthropics/skills); it is referenced here, not copied.

## When not to use
Today's runtime: nothing in AgentLab calls MCP, and this skill is not granted to any agent.

## Workflow
Agent -> Skill -> MCP capability group -> MCP server -> Tool -> Execution. Every group needs MCP_READ and/or MCP_EXECUTE, which are never granted implicitly, and every call must pass through the same permission check as a device action.

## Safety
MCP_EXECUTE is high risk. A model must never reach an MCP server without a controlled, logged permission. Groups planned: ${MCP_GROUPS.map((g) => g.id).join(", ")}.

## AgentLab-specific rules
The Browser MCP must stay isolated from Android device execution. Do not implement every server at once; add one when a skill needs it.`,
};

/** Hand-written developer-assistant skill that already exists. Validated, never overwritten. */
const aiTestingLab: SkillDefinition = {
  id: "ai-testing-lab",
  name: "ai-testing-lab",
  description: "Master skill for the AI Device Testing Lab. Use when planning, building, testing, reviewing, debugging, or extending the platform.",
  version: "1.0.0",
  category: "core",
  status: "implemented",
  manual: true,
  permissions: [],
  deviceCapabilities: [],
  actions: [],
  tools: [],
  mcpGroups: [],
  dependencies: [],
  triggers: ["agentlab", "platform", "testing lab"],
  compatibleAgents: ["*"],
  securityLevel: "LOW",
  environmentSupport: "claude",
  instructions: "",
};

function planned(id: string, name: string, category: SkillDefinition["category"], over: Partial<SkillDefinition>): SkillDefinition {
  return {
    id,
    name,
    description: `${name}. Planned: no runtime behavior exists yet.`,
    version: "0.0.0",
    category,
    status: "planned",
    permissions: [],
    deviceCapabilities: [],
    actions: [],
    tools: [],
    mcpGroups: [],
    dependencies: [],
    triggers: [],
    compatibleAgents: ["*"],
    securityLevel: "LOW",
    environmentSupport: "both",
    instructions: `Planned skill. See .claude/project-memory/known-issues.md for what is missing before it can be implemented.`,
    ...over,
  };
}

const PLANNED: SkillDefinition[] = [
  planned("agentlab-performance", "Android performance profiling", "performance", { permissions: ["DEVICE_READ", "LOG_READ"], triggers: ["performance", "fps", "frame", "startup", "memory", "cpu", "battery"], compatibleAgents: ["MAIN-06*"] }),
  planned("agentlab-visual-testing", "Visual and screenshot analysis", "visual", { permissions: ["SCREENSHOT", "UI_READ"], triggers: ["visual", "layout", "ocr", "baseline"], compatibleAgents: ["MAIN-02*", "MAIN-03*", "MAIN-05*", "MAIN-07*", "MAIN-10*"] }),
  planned("agentlab-accessibility", "Android accessibility checks", "accessibility", { permissions: ["UI_READ", "SCREENSHOT", "DEVICE_INTERACT"], triggers: ["accessibility", "talkback", "contrast", "touch target"], compatibleAgents: ["MAIN-03*", "MAIN-07*"] }),
  planned("agentlab-network-testing", "Network and API failure testing", "network", { permissions: ["NETWORK_TEST"], triggers: ["network", "offline", "latency", "timeout", "retry", "api"], compatibleAgents: ["MAIN-01*", "MAIN-08*"] }),
  planned("agentlab-regression", "Regression and version comparison", "regression", { permissions: ["SCREENSHOT", "LOG_READ"], triggers: ["regression", "baseline", "version"], compatibleAgents: ["MAIN-01*", "MAIN-10*"] }),
  planned("agentlab-compatibility", "Device and API-level compatibility matrix", "compatibility", { permissions: ["DEVICE_READ", "APP_INSTALL", "APP_LAUNCH"], securityLevel: "HIGH", triggers: ["compatibility", "api level", "screen size", "matrix"], compatibleAgents: ["MAIN-11*"] }),
  planned("agentlab-game-testing", "Mobile game testing", "game", { permissions: ["DEVICE_INTERACT", "SCREENSHOT"], triggers: ["game", "gameplay", "gesture", "rendering"], compatibleAgents: ["MAIN-02*"] }),
  planned("agentlab-browser", "Browser automation (isolated from devices)", "browser", { permissions: ["BROWSER_ACCESS"], securityLevel: "HIGH", triggers: ["browser", "playwright", "web"], compatibleAgents: ["MAIN-01*", "MAIN-09*"] }),
  planned("agentlab-coding", "Repository analysis and code review (read-only)", "coding", { permissions: ["CODE_READ"], triggers: ["repository", "code review", "refactor", "debug"], compatibleAgents: ["MAIN-12*"] }),
  planned("agentlab-evaluation", "Result evaluation, scoring and reporting", "evaluation", { triggers: ["evaluat", "score", "report", "root cause", "coverage"], compatibleAgents: ["MAIN-12*"] }),
  planned("agentlab-memory", "Task and project memory", "memory", { triggers: ["memory", "context", "retrieval"], compatibleAgents: ["MAIN-12*"] }),
  planned("agentlab-observability", "Agent run tracing, tokens and cost", "observability", { triggers: ["trace", "telemetry", "cost", "tokens"], compatibleAgents: ["MAIN-12*"] }),
];

export const SKILL_CATALOG: readonly SkillDefinition[] = [aiTestingLab, core, androidQa, smoke, exploration, crash, security, mcp, ...PLANNED];
