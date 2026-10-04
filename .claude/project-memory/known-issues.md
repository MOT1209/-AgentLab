# KNOWN ISSUES

- AdbDevice has no automated test; needs real device/emulator — MEDIUM — open
- Crash detection is a log regex (FATAL EXCEPTION|ANR in); logcat is not cleared before launch, so old lines can cause false failures — MEDIUM — open
- No persistence; tasks/evidence/messages live in memory only (MessageBus is bounded at 10k) — MEDIUM — open
- Capabilities screen_recording, inspect_ui, network_control (and analysis ones) are declared but have no Device/tool implementation — MEDIUM — open
- Only 1 of 24 SUB agents has a real behavior (MAIN-01-B smoke); others report BLOCKED — expected until Phase 3 — LOW — open
- No device lock: two MAIN agents dispatched concurrently would share one device — MEDIUM — open
- No per-task timeout/cancellation in Agent.run — LOW — open
