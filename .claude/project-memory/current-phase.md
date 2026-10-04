# CURRENT PHASE

Phase 2 — Agent architecture done (26 tests pass, typecheck clean).
Config-driven framework in src/agents/: definitions, capabilities, organization (12 MAIN + 24 SUB, ids MAIN-NN / MAIN-NN-A|B),
validation, AgentRegistry, AgentFactory, ManagedAgent/MainAgent/SubAgent, MessageBus, aggregate, behaviors.
Entry point: initializeAgentLab() in src/bootstrap.ts. Orchestrator dispatches to MAIN agents only.

## Next
- Validate AdbDevice on a real device/emulator (still untested)
- Real behaviors for more SUB agents (only MAIN-01-B "smoke" exists; the other 23 report BLOCKED)
- Device lock so concurrent MAIN agents don't share one device unsafely
- Persistence for tasks/evidence/messages
- API layer + dashboard (later)
