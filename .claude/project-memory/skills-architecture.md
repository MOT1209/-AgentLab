# SKILLS ARCHITECTURE (Phase 6)

State and decisions. Reference and how-to: .claude/skills/ai-testing-lab/knowledge/skills.md. Code: src/skills/.

## Decisions (user-confirmed)
- A skill is an executed TypeScript definition (src/skills/catalog.ts) plus generated SKILL.md adapters. AgentLab runtime agents never read SKILL.md, so a markdown-only system would be documentation, not protection.
- Scope: core + 36 profiles + only skills backed by existing behavior. Planned skills are catalogued, not given folders.
- External skills (skills.sh): classify and document only; nothing installed.

## Selected (implemented)
agentlab-core, agentlab-android-qa, agentlab-smoke-testing, agentlab-exploration, agentlab-crash-analysis, agentlab-security; ai-testing-lab registered as manual. agentlab-mcp is planned but documented.

## Deferred (planned entries, no folders)
performance, visual-testing, accessibility, network-testing, regression, compatibility, game-testing, browser, coding, evaluation, memory, observability. Reason: no behavior exists behind them; each is blocked by the gaps in known-issues.md.

## Rejected / not evaluated
Nothing installed. mcp-builder (Apache-2.0) is referenced, not copied. android-emulator-qa / android-emulator-automation seen only as search snippets: DEFER. skills.sh and the Antigravity docs were unreachable from the build environment, so no comprehensive search was possible and no verdict is claimed for the rest.

## Permission model
14 permissions (user list + APP_INSTALL). Every LLM action maps to a permission (compile-time complete). Effective profile permissions = granted skills intersected with what the agent declared capabilities imply. CODE_WRITE and ADMIN are rejected by validation and granted to nobody. Dangerous tools (shell, raw adb, fs, code exec, credentials, Google/Play Store) are rejected by name. Violations are BLOCKED, never ERROR.

## MCP architecture
9 capability groups as data (src/skills/mcp.ts), all planned; no server or client code. Skills may reference a group; the resolver reports it unavailable. Browser MCP must stay isolated from devices.

## .claude / .agent integration
Both generated from the catalog (name + description frontmatter, generated marker + content hash). .claude format is documented. The .agent convention is UNVERIFIED (Antigravity docs blocked; snippets say .agents/skills is the new default, .agent/skills legacy). One constant (SKILL_TARGETS) to change.

## Agent skill matrix (generated from live profile data)
| Agent | Skills | Planned | Effective permissions | Limits steps/LLM calls/tokens/time |
|---|---|---|---|---|
| MAIN-01-A | core, android-qa | network-testing | SCREENSHOT, UI_READ, LOG_READ, APP_LAUNCH | 50/100/500000/600s |
| MAIN-01-B | core, android-qa, smoke-testing, crash-analysis | regression | SCREENSHOT, LOG_READ, APP_LAUNCH, APP_INSTALL | 50/100/500000/600s |
| MAIN-02-A | core, android-qa, crash-analysis, exploration | game-testing, visual-testing | SCREENSHOT, LOG_READ, APP_LAUNCH, DEVICE_INTERACT | 200/400/2000000/1800s |
| MAIN-02-B | core, android-qa | game-testing | SCREENSHOT, UI_READ | 50/100/500000/600s |
| MAIN-03-A | core, android-qa | visual-testing | SCREENSHOT, UI_READ | 50/100/500000/600s |
| MAIN-03-B | core, android-qa | visual-testing | SCREENSHOT | 50/100/500000/600s |
| MAIN-04-A | core, android-qa, crash-analysis, exploration | - | SCREENSHOT, LOG_READ, APP_LAUNCH, DEVICE_INTERACT | 200/400/2000000/1800s |
| MAIN-04-B | core, android-qa, crash-analysis | - | LOG_READ, APP_LAUNCH | 50/100/500000/600s |
| MAIN-05-A | core, android-qa, crash-analysis, exploration | - | SCREENSHOT, UI_READ, LOG_READ, APP_LAUNCH, DEVICE_INTERACT | 200/400/2000000/1800s |
| MAIN-05-B | core, android-qa, crash-analysis, exploration | - | SCREENSHOT, LOG_READ, DEVICE_INTERACT | 200/400/2000000/1800s |
| MAIN-06-A | core, android-qa | performance | DEVICE_READ, LOG_READ | 50/100/500000/600s |
| MAIN-06-B | core, android-qa | performance | LOG_READ, APP_LAUNCH | 50/100/500000/600s |
| MAIN-07-A | core, android-qa | accessibility, visual-testing | SCREENSHOT, UI_READ | 50/100/500000/600s |
| MAIN-07-B | core, android-qa | accessibility | SCREENSHOT, UI_READ | 50/100/500000/600s |
| MAIN-08-A | core, android-qa | network-testing | LOG_READ | 50/100/500000/600s |
| MAIN-08-B | core, android-qa | network-testing | LOG_READ | 50/100/500000/600s |
| MAIN-09-A | core, security | - | - | 50/100/500000/600s |
| MAIN-09-B | core, android-qa, security | - | DEVICE_READ, LOG_READ | 50/100/500000/600s |
| MAIN-10-A | core | regression | - | 50/100/500000/600s |
| MAIN-10-B | core | regression, visual-testing | - | 50/100/500000/600s |
| MAIN-11-A | core, android-qa, smoke-testing | compatibility | DEVICE_READ, APP_LAUNCH, APP_INSTALL | 50/100/500000/600s |
| MAIN-11-B | core, android-qa, smoke-testing | compatibility | DEVICE_READ, SCREENSHOT, APP_LAUNCH, APP_INSTALL | 50/100/500000/600s |
| MAIN-12-A | core | evaluation, memory | - | 50/100/500000/600s |
| MAIN-12-B | core | evaluation, observability | - | 50/100/500000/600s |
| MAIN-01 | core, android-qa, smoke-testing, crash-analysis | network-testing, regression | SCREENSHOT, UI_READ, LOG_READ, APP_LAUNCH, APP_INSTALL | 50/100/500000/600s |
| MAIN-02 | core, android-qa, crash-analysis, exploration | game-testing, visual-testing | SCREENSHOT, LOG_READ, APP_LAUNCH, DEVICE_INTERACT, UI_READ | 200/400/2000000/1800s |
| MAIN-03 | core, android-qa | visual-testing | SCREENSHOT, UI_READ | 50/100/500000/600s |
| MAIN-04 | core, android-qa, crash-analysis, exploration | - | SCREENSHOT, LOG_READ, APP_LAUNCH, DEVICE_INTERACT | 200/400/2000000/1800s |
| MAIN-05 | core, android-qa, crash-analysis, exploration | - | SCREENSHOT, UI_READ, LOG_READ, APP_LAUNCH, DEVICE_INTERACT | 200/400/2000000/1800s |
| MAIN-06 | core, android-qa | performance | DEVICE_READ, LOG_READ, APP_LAUNCH | 50/100/500000/600s |
| MAIN-07 | core, android-qa | accessibility, visual-testing | SCREENSHOT, UI_READ | 50/100/500000/600s |
| MAIN-08 | core, android-qa | network-testing | LOG_READ | 50/100/500000/600s |
| MAIN-09 | core, security, android-qa | - | DEVICE_READ, LOG_READ | 50/100/500000/600s |
| MAIN-10 | core | regression, visual-testing | - | 50/100/500000/600s |
| MAIN-11 | core, android-qa, smoke-testing | compatibility | DEVICE_READ, APP_LAUNCH, APP_INSTALL, SCREENSHOT | 50/100/500000/600s |
| MAIN-12 | core | evaluation, memory, observability | - | 50/100/500000/600s |

## Roadmap
1. Close the HIGH known issues (real device and live LLM never run).
2. Give MAIN-05-B and MAIN-10-A the capabilities their roles need (see known-issues) before granting them more.
3. Provider pricing config, then maxCost.
4. Agent Run record (skills, tools, LLM calls, tokens, cost, evidence) reusing ExplorationTelemetry and the MessageBus.
5. First planned skill with real behavior (suggest performance or visual regression), then MCP only when a skill needs it.
6. Decide the fate of branch claude/vibrant-wozniak-a93k2e (overlapping LLM budget and web UI; unrelated history).
