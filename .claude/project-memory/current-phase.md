# CURRENT PHASE

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

Phase 4 — first real LLM-driven agent done: MAIN-05-A Exploration Agent (98 tests pass, typecheck + build clean).
See knowledge/exploration.md. Earlier: agent framework (P2), device runtime (P3), providers (P3.5).

Flow: orchestrator.dispatch("MAIN-05","explore",payload,{signal}) → MAIN-05 leases DEVICE-05 → MAIN-05-A runs
runExploration(ctx.llm, leased device) → ExplorationResult (ChildOutcome.details) → released.
Only MAIN-01-B (smoke) and MAIN-05-A (explore) have behavior; the other 22 sub-agents report BLOCKED. MAIN-05-B untouched.

## Next
- RUN IT FOR REAL: AdbDevice (swipe/pressKey/ui/clearLogs), a real emulator, a real provider key. Nothing live has been verified.
- Cost control: budget per provider/run (usage is counted in telemetry but not capped)
- Edge Case Agent (MAIN-05-B) reusing runExploration with a different system prompt/strategy
- Persistence of runs/evidence; report output (JSON/Markdown)
- Dynamic device allocation if fewer than 12 devices
