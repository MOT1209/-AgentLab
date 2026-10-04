# CURRENT PHASE

Phase 3 — Device runtime done (52 tests pass, typecheck clean).
src/runtime/: DeviceRegistry, DevicePool (leases), DeviceManager (assignments, health, discovery, withLease), RuntimeContext.
Agents no longer hold a Device: AgentDeps.devices is a DeviceManager. MAIN agents lease their assigned device per task;
sub-agents run under the parent's lease and see it via HandlerContext.device / runtime.
initializeAgentLab({ devices | deviceManager, assignments: "auto" | "none" | Record }) — no implicit mock fleet.
createMockFleet(12) gives DEVICE-01..12 for development.

Providers (Phase 3.5): src/providers/ — ProviderManager, AnthropicProvider (SDK), OpenAICompatibleProvider (fetch), MockProvider, config validation. initializeAgentLab({ providers }). 65 tests pass.
No agent calls an LLM yet: ctx.llm exists, but no handler uses it.

## Next
- Real LLM-driven behavior for one agent (e.g. Exploration Agent) using ctx.llm
- Verify AnthropicProvider and OpenAICompatibleProvider against live APIs (only tested with fakes)
- Cost controls: per-provider token/cost budget and usage accounting
- Validate AdbDevice and AdbDiscovery on a real device/emulator (still untested; only the parser is unit-tested)
- Real behaviors for more SUB agents (only MAIN-01-B "smoke" exists; the other 23 report BLOCKED)
- Clear logcat before launch; crash detection beyond regex
- Persistence for tasks/evidence/messages/leases
- Dynamic device allocation (MAIN without a fixed device takes any free one) if 12 physical devices are unrealistic
- API layer + dashboard (later)
