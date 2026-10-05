# CURRENT PHASE

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

## UI (added after Phase 4)
`npm run ui` — local web UI (src/ui/): demo mode verified in headless Chromium; real mode untested on hardware.
Progress reaches the UI through PROGRESS messages on the bus (HandlerContext.report). 108 tests pass.
