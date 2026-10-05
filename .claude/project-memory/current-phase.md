# CURRENT PHASE

Phase 4.5 — Real Android device validation: **PARTIAL**. All code and tests are in place; the real-device proof is NOT done
because this environment has no Android device or emulator (no /dev/kvm; the Android SDK download host is blocked).
Real `adb` 34 was installed here via apt (no device). 126 tests pass + 1 opt-in real-device test (skipped here with a reason).

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
