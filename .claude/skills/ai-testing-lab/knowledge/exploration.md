# EXPLORATION AGENT (MAIN-05-A)

Task type `explore`, payload: { objective, app?{packageName,name,launchActivity,version}, maxSteps (default 20, cap 200),
timeoutMs (default 300000, cap 1800000), screen?{width,height}, captureScreenshots? }.

Loop (src/agents/exploration/exploration-agent.ts): observe → ask ctx.llm → parse JSON → validate → execute → observe.
- The model never sees image bytes: UI elements (text, tap centers), error-level log lines, evidence ids (EV-001).
- Actions: LAUNCH_APP STOP_APP TAP TYPE SWIPE BACK HOME SCREENSHOT WAIT GET_UI GET_LOGS END_TEST. No package argument:
  launch/stop act only on app.packageName from the task. Nothing else exists: no shell, adb, file or network action.
- validateDecision is the only path to an executable action. ActionExecutor is an exhaustive switch over Device methods.
- Malformed output: one correction attempt, then ERROR. Provider error → ERROR. Device lost → BLOCKED.
- Limits enforced by the runtime: maxSteps (END_TEST is free), timeoutMs, AbortSignal (orchestrator.dispatch opts.signal),
  5 identical actions in a row. Lease is released on every exit.
- Findings: VERIFIED (crash markers in logs, CRITICAL, fail the task) vs AI_OBSERVATION (model's claim, never fails the task).
- Result: ExplorationResult in ChildOutcome.details; TaskStatus via toTaskStatus (TIMEOUT→BLOCKED, CANCELLED→SKIPPED).
