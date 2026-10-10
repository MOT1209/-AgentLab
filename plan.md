# Plan — hardening, retention & tooling

Working branch: `feat/hardening-retention-tooling` (do **not** push to `main` / open a PR unless asked).
Base: `0a3b458` (main) → `6e2ab00` (gitignore) → `b100af5` → `403c101`.

This file tracks the 7-step task. Status is from reading the tree on 2026-10-10, not from
commit messages (the `b100af5` message claims "finish P2 retention", but no retention/delete
code is present yet — see Step 2). "Done" means the code exists AND tests pass; "needs work"
means the spec item is not yet in the tree.

## Ground rules (unchanged from the task spec)
- Production-quality, match the surrounding style, a test for every change, small commits.
- Before each commit: `rm -rf dist && npm test` and `npm run skills:validate`.
- Nothing here has run on a real device or a live LLM. Never claim otherwise; label anything
  unverified in code comments, `known-issues.md` and the final report. Do not invent prices or
  device behaviour. Do not add features beyond this list.

## Environment caveats (this machine)
- `core.autocrlf` was `true`, which rewrote files to CRLF and broke the skill content-hash
  check (`skills:validate` failed on every generated SKILL.md). Fixed locally by setting
  `core.autocrlf=false` and renormalising the working tree to LF. On a fresh Windows clone this
  must be redone, or add a `.gitattributes` with `* text=auto eol=lf` (candidate for Step 6).
- The fake-adb test harness writes an extensionless shell script named `adb` and spawns it
  directly; Windows cannot exec it (`spawn ... adb ENOENT`). Those adb/simulated tests now
  **skip** on this platform (the suite was made portable in `b100af5`). On Linux CI they run.
- Baseline full suite here: 200 tests, 0 fail, 10 skipped. Rule: a change must add **zero** new
  failures versus this baseline.
- An autonomous agent has been committing to this branch concurrently. Coordinate / verify the
  tree is stable before editing to avoid clobbering its commits.

## Status

| # | Step | Status |
|---|------|--------|
| 1 | Prompt-injection hardening + sensitive-action guard | **Done** (`b100af5` + `403c101`), verified: tsc clean, 30/30 exploration tests, full suite 0 fail. |
| 2 | Memory & retention limits | **Needs work** — not in tree. |
| 3 | uiautomator fallback | **Needs work** — not in tree. |
| 4 | Payload validation & provider resilience | **Needs work** — not in tree. |
| 5 | Crash-detection patterns | **Needs work** — only base markers (FATAL EXCEPTION / ANR in / Fatal signal) exist. |
| 6 | Tooling (ESLint, Prettier, Dockerfile, CI lint) | **Needs work** — not in tree. |
| 7 | Final report + memory updates | **Needs work**. |

## Remaining work (detail)

### Step 1 — done
- System prompt declares `untrustedDeviceData` as data, never instructions; `buildUserMessage`
  nests observed data under that field.
- Deterministic guard (`sensitive-actions.ts`) refuses TAP on buy/pay/subscribe/delete-account/
  factory-reset/uninstall controls (EN/AR/DE, text/desc/id), unless `allowSensitiveActions: true`.
  Refusal returns as a failed action (`errorCode: SENSITIVE_ACTION_BLOCKED`) and is counted in
  `telemetry.sensitiveRefusals`.
- Follow-up (optional): the guard matches element centres only; a tap at free coordinates over a
  sensitive control is not caught — already noted as a limitation in `sensitive-actions.ts`. Add a
  line to `known-issues.md`.

### Step 2 — memory & retention
- Cap screenshots held in **UiApp `RunState`** by count **and** total bytes; drop the oldest and
  record it in the run's events. (The exploration `EvidenceStore` cap is separate and already
  exists; this is the live UI run state.)
- `RunStore` retention: keep the newest N runs (default 100, env `AGENTLAB_KEEP_RUNS`) and add a
  `delete(id)` method.
- UI: a "delete run" button in the history list (`POST /api/runs/:id/delete`, token + JSON
  content-type required).
- Tests for cap, retention and delete.

### Step 3 — uiautomator fallback
- In `AdbDevice.ui()`: if `exec-out uiautomator dump /dev/tty` fails or returns no `<node>`, fall
  back to dumping to `/sdcard/window_dump.xml`, `exec-out cat` it, then remove the file.
- Update `test/support/fake-adb.ts` so both paths are testable.
- Mark the fallback unverified on real devices (code comment + known-issues).
- Note: the adb test family is skipped on this Windows machine — verify on Linux CI.

### Step 4 — payload validation & provider resilience
- Replace `as` casts of task payloads (e.g. `SmokePayload`) with small shared validators.
- Retry with exponential backoff + jitter for `ProviderError` with `retryable=true` (max 3
  attempts, abortable via the signal, counted in `telemetry.llmCalls`).
- Concurrency limiter in `ProviderManager` (default 2 concurrent requests per provider,
  configurable).
- Tests with fake providers and fake timers.

### Step 5 — crash-detection patterns
- Extend `detectCrash` with: StrictMode violations (LOW), `OutOfMemoryError` (HIGH), and ANR lines
  without a process name — keeping the package-scoping rule.
- Tests built from realistic logcat excerpts. Do not claim real-device coverage.

### Step 6 — tooling
- ESLint flat config + typescript-eslint, no stylistic rules beyond basics.
- Prettier matching the existing style (so the first run is a small diff; set `endOfLine` per the
  LF normalisation above). Consider adding `.gitattributes`.
- `npm run lint`; add it to `.github/workflows/ci.yml`.
- Dockerfile: `node:22-slim` + `android-tools-adb`, non-root, runs `npm run ui -- --no-open`,
  binds `127.0.0.1` only by default. README section stating USB-device use needs host networking
  or adb-over-network and was not tested.

### Step 7 — final report
- Per step: done / partly / blocked, with commit hash, tests added, and what remains unverified.
- Update `.claude/project-memory/known-issues.md` and `current-phase.md`.
- End with the exact commands to run on a real device:
  `REAL_DEVICE_TEST=1 npm run test:real`, then `npm run ui` — and what output to send back.
