# SKILLS

Code: `src/skills/`. Catalog: `src/skills/catalog.ts` (the only place a skill is defined). Generated: `.claude/skills/agentlab-*/` and `.agent/skills/agentlab-*/`.

## Architecture

```
SkillDefinition (src/skills/catalog.ts)            one canonical definition per skill
   |-- SkillRegistry     validates, searches, resolves dependencies
   |-- AgentProfile      per agent: granted skills, effective permissions, limits, device sources
   |-- SkillResolver     task + agent + environment -> skills, permissions, tools, actions, limits
   |-- renderSkill       generates SKILL.md for each developer environment
   |       |-- .claude/skills/<id>/SKILL.md
   |       `-- .agent/skills/<id>/SKILL.md
   `-- Runtime enforcement (SubAgent, exploration loop)
```

Two audiences, kept apart on purpose:
- **AgentLab's own agents** are TypeScript handlers plus an LLM prompt. They never read SKILL.md. Permissions, action narrowing and limits are enforced here, in code.
- **Developer assistants** (Claude Code, an agent-environment assistant) read the generated SKILL.md files. These are advisory; AgentLab cannot enforce what an external assistant does with them.

## Skill model

`SkillDefinition` fields: `id, name, description, version, category, status, permissions, deviceCapabilities, actions, tools, mcpGroups, dependencies, triggers, compatibleAgents, securityLevel, environmentSupport, alwaysOn?, manual?, documented?, instructions, perEnvironment?`.

- `status`: `implemented` (behavior exists) or `planned` (catalogued, never resolvable at runtime, no folder generated unless `documented`).
- `environmentSupport`: `claude`, `agent` or `both` (which directories get a generated file).
- `compatibleAgents`: ids, `*`, or a prefix such as `MAIN-05*`. Every pattern must match a real agent.
- Names that already existed and were not reused: `Capability` (what a device or agent can do), `TaskHandler.requires`. A skill's `deviceCapabilities` uses that existing vocabulary.

## Registry and resolver

`SkillRegistry`: `register, unregister, get, list, search, dependencies, resolve, compatibility, validate`. It rejects duplicate ids, unknown permissions/actions/tools/MCP groups/agent patterns, dependency cycles, an implemented skill depending on a planned one, and dangerous tools. `unregister` refuses while another skill depends on it.

`SkillResolver.resolve({ agentId, task?, goal?, environment? })` returns `skills, permissions, tools, actions, limits, restricted, denied, unavailable`. Selection is deterministic keyword matching of `triggers` (substring, lower-case) against task type, objective and goal; no LLM call. It only ever selects skills granted in the agent's profile. A skill whose permissions the agent holds only partly is **restricted** (runs with the permitted subset). Planned skills and planned MCP groups are reported as **unavailable**. Keyword matching is crude by design; use stems (`evaluat`) where it matters.

## Catalog

Implemented: `agentlab-core` (always on), `agentlab-android-qa`, `agentlab-smoke-testing`, `agentlab-exploration`, `agentlab-crash-analysis`, `agentlab-security`, and the hand-written `ai-testing-lab` (manual, never overwritten). `agentlab-mcp` is planned but documented (architecture guide).
Planned, no folders: performance, visual-testing, accessibility, network-testing, regression, compatibility, game-testing, browser, coding, evaluation, memory, observability.
A skill is only `implemented` when code exists behind it. Do not mark one implemented to fill a matrix.

## Permissions

`DEVICE_READ, DEVICE_INTERACT, SCREENSHOT, UI_READ, LOG_READ, APP_LAUNCH, APP_INSTALL, NETWORK_TEST, BROWSER_ACCESS, CODE_READ, CODE_WRITE, MCP_READ, MCP_EXECUTE, ADMIN` (`APP_INSTALL` was added to the original list because installing is riskier than launching).

- Every LLM-callable action has a decision in `ACTION_PERMISSION` (a full `Record`, so a new action without one does not compile): TAP/TYPE/SWIPE/BACK/HOME need `DEVICE_INTERACT`, SCREENSHOT `SCREENSHOT`, GET_UI `UI_READ`, GET_LOGS `LOG_READ`, LAUNCH_APP/STOP_APP `APP_LAUNCH`, WAIT and END_TEST none.
- Declared tools and actions must be covered by the skill's permissions; MCP groups require the group's permissions.
- High-risk permissions (`APP_INSTALL, CODE_WRITE, MCP_EXECUTE, BROWSER_ACCESS, ADMIN`) require `securityLevel: HIGH`. `CODE_WRITE` and `ADMIN` are rejected outright unless validation is given explicit approval; nothing grants them today.
- Dangerous tools are rejected by name: shell, raw ADB, file access, code execution, raw network, credentials, Google account and Play Store tools.

## Agent profiles

`src/skills/profiles.ts`. SUB agents get explicit grants (`SUB_GRANTS`); a MAIN profile is the union of its subs (a MAIN agent has no behavior of its own). Effective permissions = the granted skills' permissions intersected with what the agent's declared `capabilities` imply (`CAPABILITY_PERMISSION`), so `AgentDefinition.capabilities` stays the source of truth: a Layout Tester that declares only `screenshot` and `inspect_ui` gets only `SCREENSHOT` and `UI_READ`. Profile validation rejects: a missing or extra profile, an unknown or planned skill under `skills`, an implemented skill under `plannedSkills`, an ungranted dependency, a grant that adds no permission, a permission beyond the declared capabilities, a SUB that exceeds its MAIN, non-positive limits, `maxCost` (needs provider pricing, which does not exist), device sources without device permissions. `npm run skills:list -- --agents` prints the current matrix.

Limits per profile: `maxSteps, maxLLMCalls, maxTokens, maxExecutionTimeMs` (explorers up to the existing hard caps, others lower). Device sources allowed for device-using agents: all four (`MOCK, EMULATOR, PHYSICAL, REMOTE`; REMOTE because a wireless-adb phone is labelled REMOTE by the existing heuristic). The check matters for custom profiles; real hardware stays opt-in at the device layer.

The limits are enforced by the exploration loop. The smoke handler makes no LLM calls and runs a fixed sequence, so it has no step or call budget, and `Agent.run` still has no per-task timeout (known issue).

## Runtime enforcement

On by default for the canonical organization (`initializeAgentLab({ skills: false })` disables; custom `definitions` get none; `skills: <SkillSystem>` supplies your own).
- `TaskHandler.permissions` (smoke and exploration declare theirs). `SubAgent.execute` blocks a governed handler whose permissions the profile lacks, blocks it when no profile exists (fail closed), and blocks a device source the profile does not allow. All are `BLOCKED`, never `ERROR`. Handlers declaring no permissions are not governed.
- Exploration narrows its action set to the profile, so a denied action fails validation and never reaches the device. The effective step and time limits are the smaller of the task's and the profile's. `maxLLMCalls` and `maxTokens` are checked before every model call, including the correction retry. Tokens are known only after a call, so one call can overshoot. Exhaustion ends the run as `BUDGET_EXHAUSTED`, reported as `BLOCKED`.

## Developer environments (.claude and .agent)

Both are generated from the catalog by `renderSkill`, with `name` and `description` frontmatter only (the common documented subset), a generated marker with a content hash, and an environment note. They are identical in substance today; the adapter exists so they can diverge (`perEnvironment`). Directory names are constants in `src/skills/render.ts` (`SKILL_TARGETS`).
- Claude Code format is documented (name, description and optional fields; project skills in `.claude/skills`).
- The `.agent` convention is **unverified**: search snippets say Antigravity now prefers `.agents/skills` and still accepts `.agent/skills`. If it needs `.agents`, change one constant and run `npm run skills:sync -- --prune`.

## Commands

- `npm run skills:list [-- --agents]`
- `npm run skills:validate`: catalog, profiles, generated files in sync (hash), `.claude`/`.agent` metadata equal, manual skill matches the catalog, safety scan of every skill file, non-Markdown content rejected.
- `npm run skills:sync [-- --check] [-- --prune]`: writes missing or drifted files; `--check` only reports (use in CI); `--prune` removes orphaned generated directories only.

Add a skill: define it in `catalog.ts`, grant it in `profiles.ts`, run `npm run skills:sync`, then `npm run skills:validate` and `npm test`. Never edit a generated file; the hash check reports it.

## MCP

Nine capability groups are defined as data in `src/skills/mcp.ts` (Android, Device, Testing, Evidence, Performance, Security, Browser, Research, GitHub), all `planned`. No MCP server or client exists. A skill may reference a group, the registry checks the permissions it needs, and the resolver reports it unavailable. Architecture: Agent -> Skill -> MCP group -> MCP server -> Tool -> Execution, every call passing the same permission check as a device action. For building a server, use Anthropic's `mcp-builder` skill (Apache-2.0, anthropics/skills); it is referenced, not copied. The Browser group must stay isolated from Android devices.

## External skill governance

Third-party skills are untrusted input: SKILL.md text can carry prompt injection and bundled scripts can run code. Nothing external is installed in this phase. Classes: KEEP, INTEGRATE, WRAP, ADAPT, DEFER, REJECT. Evaluate source, maintenance, dependencies, capabilities, permissions, network and file access, shell use, credentials, compatibility, duplication; read every file.

| Candidate | Verified? | Class | Note |
|---|---|---|---|
| `mcp-builder` (anthropics/skills) | files and Apache-2.0 license read | WRAP (reference only) | Python scripts; not copied. |
| android-emulator-qa (willsigmon/sigstack, openai/plugins) | seen only in search snippets; contents not inspected | DEFER | Overlaps our Device abstraction; ideas to harvest. |
| android-emulator-automation (krutikJain/android-agent-skills) | seen only in a search snippet; not inspected | DEFER | Same. |
| android-performance, end-to-end-testing, goal-mode, others | skills.sh was unreachable from the build environment; not found, not evaluated | not evaluated | No verdict is claimed. |

## Not built (deliberately)

Skill folders for planned skills; MCP servers; any `CODE_WRITE` grant; Google account, OAuth or Play Store automation; a goal loop with independent verification and replanning (the exploration loop maps onto it, but verify and replan are not implemented); per-run observability records and cost tracking (token counts are reported in telemetry, cost needs provider pricing).
