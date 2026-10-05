# TESTING MODEL

Application
↓
Test Session
↓
Test Plan
↓
Agent Assignment
↓
Execution
↓
Evidence
↓
Validation
↓
Bug
↓
Report

Test statuses:

PENDING
RUNNING
PASSED
FAILED
BLOCKED
SKIPPED
ERROR

Bug severity:

CRITICAL
HIGH
MEDIUM
LOW
INFO

## How AgentLab itself is tested

Levels, from cheapest to most real:
1. Unit/integration with MockDevice + MockProvider — `npm test`, always offline, no key, no adb.
2. Simulated adb (`test/support/fake-adb.ts`) — real `AdbDiscovery`/`AdbDevice` child-process handling against a shell script that imitates one device. Proves plumbing, NOT Android behaviour.
3. Real `adb` binary without a device — runs automatically if `adb` is installed; skipped otherwise.
4. Real device/emulator — opt-in: `REAL_DEVICE_TEST=1 npm run test:real` (skips with a reason if no usable device).
5. Real LLM — additionally `REAL_LLM_TEST=1` (+ `ANTHROPIC_API_KEY`). Costs money.

Never report level 4/5 as passed unless it was run on a device. Shared scenario: `test/support/e2e-scenario.ts`.

## Real-device pipeline

adb devices -l → state normalised (device/offline/unauthorized/unknown) → deep health (shell, PNG screenshot, logs) → DeviceRegistry → lease → MAIN-05-A → evidence on disk (<evidenceDir>/<taskId>/EV-xxx.*, result.json) → release.
Error codes on blocked tasks: DEVICE_UNAVAILABLE, DEVICE_BUSY, NO_DEVICE_ASSIGNED, NO_CAPABLE_AGENT. Action error codes: UNSUPPORTED_ACTION, DEVICE_ERROR, ACTION_FAILED.
