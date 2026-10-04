# KNOWN ISSUES

- AdbDevice has no automated test; needs real device/emulator — MEDIUM — open
- Crash detection is a log regex (FATAL EXCEPTION|ANR in); logcat is not cleared before launch, so old lines can cause false failures — MEDIUM — open
- No persistence; tasks/evidence/messages live in memory only (MessageBus is bounded at 10k) — MEDIUM — open
- Capabilities screen_recording, inspect_ui, network_control (and analysis ones) are declared but have no Device/tool implementation — MEDIUM — open
- Only 1 of 24 SUB agents has a real behavior (MAIN-01-B smoke); others report BLOCKED — expected until Phase 3 — LOW — open
- No per-task timeout/cancellation in Agent.run — LOW — open
- Fixed MAIN->device assignment needs up to 12 devices; with fewer, unassigned MAINs are BLOCKED. Dynamic allocation not built — MEDIUM — open
- AdbDevice/AdbDiscovery still untested against real adb (only parseAdbDevices is unit-tested) — MEDIUM — open
- Leases and assignments are in memory only; a process crash loses them (a restarted run starts clean, which is safe, but history is lost) — LOW — open
- Device capability list is declared per device (defaults to the 8 implemented); AdbDevice does not verify it — LOW — open
