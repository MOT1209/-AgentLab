# CURRENT PHASE

Merge - the separate branch claude/vibrant-wozniak-a93k2e (unrelated history, same Phase 1-4 code) is now on this line: its 3 new commits were
cherry-picked (explore example, local web UI in src/ui, Phase 4.5 real-device path: health gating, structured errors, task-level maxLlmCalls,
evidence on disk, opt-in real-device test). Reconciled with Phase 5/6: ONE budget mechanism (task maxLlmCalls clamped by the agent profile ceiling;
profile adds maxTokens; single status BUDGET_EXCEEDED -> BLOCKED); discover now returns {added, skipped (already known), rejected (unusable, with
reason)} and the Control Center lists rejected devices; PROGRESS bus events stream through the API's SSE. 182 tests pass, 2 skipped (need a real adb
binary / REAL_DEVICE_TEST=1). TWO web UIs now exist: src/ui (`npm run ui`, demo + real-device modes) and src/api + web/ (`npm run dev:api`,
bilingual Control Center). Consolidating them is an open decision.

Phase 6 - skill architecture done (src/skills/, see skills-architecture.md and knowledge/skills.md). One canonical SkillDefinition catalog
(6 implemented skills + ai-testing-lab manual + MCP guide planned/documented + 12 planned entries), SkillRegistry, SkillResolver, permission model,
least-privilege profiles for all 36 agents (effective permissions = granted skills limited by each agent's declared capabilities), generated
.claude/skills and .agent/skills with drift/hash/safety validation (`npm run skills:list|validate|sync`), and runtime enforcement: handler
permissions gate SubAgent (BLOCKED), exploration actions are narrowed to the profile, profile limits are ceilings (maxSteps, time, maxLLMCalls,
maxTokens; BUDGET_EXCEEDED -> BLOCKED). On by default for the canonical organization (skills:false opts out). 154 tests pass.
Nothing external installed (skills.sh was unreachable). Still never run against a real device, real adb, or a live LLM.
Next: close the HIGH known issues; see Roadmap in skills-architecture.md.

Phase 5, Step 3.1 — adb hotfix after the user's Windows report ("adb not found" with a phone on USB):
ADB_PATH env var (and createApiServer { adbPath, discovery } options) now reach AdbDiscovery and the
AdbDevice instances it creates; the UI shows the raw error and lists skipped devices with their adb state
and a hint (unauthorized/offline). POST /tests now gives the target MAIN a device when it has none (optional
body.deviceId; else a free one; takes it from another MAIN only if its lock is FREE; 409 if none) because
devices found via Discover were previously never assigned and a test would have been BLOCKED. 112 tests pass.
Root cause of the user's screenshot is NOT confirmed (most likely adb not on PATH); waiting for `adb version`
/ `adb devices` output from their terminal.

Phase 5, Step 3 — Control Center UI done (web/: index.html, app.js, i18n.js, style.css; plain
HTML/CSS/vanilla JS, no build step, bilingual AR/EN with RTL toggle). Served by the API server
itself (createApiServer(runtime, { webRoot })); `npm run dev:api` then open http://localhost:4000.
Screens: Devices (real adb discovery), AI providers (preset dropdown, add/test/remove — keys are
env-var NAMES only, never entered in the UI), Run a test (explore/smoke, live SSE agent activity,
result card). API gained GET /providers/presets, POST /providers, DELETE /providers/:id; main.ts
always creates a ProviderManager so providers can be added from the UI. 109 tests pass.
Verified in headless Chromium against a mock fleet + mock provider (add Groq preset -> test
connection -> run smoke test -> live events + result; Arabic RTL renders). NOT verified: real adb,
real device, real LLM provider (Step 4). Next: Phase 5 Step 4 — real-world validation.

Phase 5, Step 2 — Backend/API layer done (src/api/): server.ts (plain node:http, no framework),
task-store.ts, main.ts (dev entry, `npm run dev:api`). Routes: GET /providers, POST
/providers/:id/test, GET /devices, POST /devices/discover, POST /tests (returns 202 + taskId
without blocking on the run), GET /tests/:taskId, GET /events (SSE of the MessageBus). No new
runtime dependency. 106 tests pass (6 new in test/api.test.ts), typecheck + build clean.
Manually verified with `npm run dev:api` + curl in this sandbox (no adb present here, confirming
the existing known-issue; routes behave correctly with zero providers/devices).
Next: Phase 5 Step 3 — Frontend Control Center wired to this API.

Phase 5, Step 1 — provider presets added (src/providers/presets.ts): openai, groq, openrouter,
together, fireworks, ollama. A config sets `"preset": "<id>"` to fill in `baseUrl` for
openai-compatible instead of hand-writing it; an explicit baseUrl still wins. 100 tests pass,
typecheck + build clean. "OpenCode/Zen" was requested by the user as a provider but its API shape
is unconfirmed — not added as a preset yet.

Phase 4.5 — Real Android device validation: **PARTIAL**. All code and tests are in place; the real-device proof is NOT done
because this environment has no Android device or emulator (no /dev/kvm; the Android SDK download host is blocked).
Real `adb` 34 was installed here via apt (no device). 126 tests pass + 1 opt-in real-device test (skipped here with a reason).

Phase 4 — first real LLM-driven agent done: MAIN-05-A Exploration Agent (98 tests pass, typecheck + build clean).
See knowledge/exploration.md. Earlier: agent framework (P2), device runtime (P3), providers (P3.5).

What exists: deep health check (adb/shell/PNG screenshot/logs) gating the registry; discovery -> health -> registry -> pool;
structured error codes (DEVICE_UNAVAILABLE/BUSY, NO_DEVICE_ASSIGNED); LLM-call budget (maxLlmCalls) + BUDGET_EXCEEDED;
package-aware crash detection with process/exception/timestamp; evidence files on disk + result.json; launchActivity;
UNSUPPORTED_ACTION errors; opt-in `REAL_DEVICE_TEST=1 npm run test:real`; simulated-adb end-to-end test; README section.
Earlier phases: framework (P2), device runtime (P3), providers (P3.5), Exploration Agent (P4), local web UI.

## Next (to close Phase 4.5)
- RUN `REAL_DEVICE_TEST=1 npm run test:real` on a real device/emulator and record the result here; fix what breaks.
- Then try REAL_LLM_TEST=1 once, on a simple app you own.

## After that
- Phase 5: vision / screenshot understanding (the model is blind to pixels today)
- Cost cap per provider; persistence of runs; more sub-agent behaviors (Crash Hunter, Edge Case); dynamic device allocation
