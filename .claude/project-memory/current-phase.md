# CURRENT PHASE

Phase 1 — Vertical slice done (TypeScript/Node 22, node:test).
Device interface + MockDevice + AdbDevice, Agent base (failure-isolated), Orchestrator,
Main Agent 01 (Functional Tester) + Sub-Agent 01-B (Core Feature Tester).

## Next
- Validate AdbDevice against a real device/emulator (untested: no adb in dev container)
- Persist tasks/evidence (storage decision needed)
- Add Main Agent 04 (Crash & Stability) reusing the same base
- API layer + dashboard (later)
