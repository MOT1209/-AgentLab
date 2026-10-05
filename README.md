# AgentLab

An AI-driven Android application and game testing platform, built around a fixed hierarchy of **12 main agents** and **24 sub-agents** that share a common runtime for devices, LLM providers, evidence and results.

> **Status: early. The architecture is built and unit-tested; almost nothing has run against real hardware or a live LLM.** Read [What works and what does not](#what-works-and-what-does-not) before relying on it.

- TypeScript on Node 22, strict mode, tests with `node:test`
- One runtime dependency: `@anthropic-ai/sdk`
- 108 tests, all offline (mock devices, mock LLM, no API keys)

---

## How it fits together

```
User / caller
   ↓  orchestrator.dispatch(mainId, taskType, payload, { signal })
Orchestrator              dispatches to MAIN agents only
   ↓
MAIN agent (12)           plans, picks capable sub-agents, aggregates results
   │  leases its device for the duration of the task
   ↓
SUB agent (24, 2 per MAIN)   runs a task handler on the parent's device
   ↓                         handler gets: device, runtime context, ctx.llm, abort signal
Device (interface)  ←  MockDevice | AdbDevice (physical / emulator / remote)
LlmProvider (interface)  ←  Anthropic | OpenAI-compatible | Mock
```

Key ideas:

| Concept | Where | What it means |
|---|---|---|
| **Agent definition** | `src/agents/organization.ts` | Static data: id, role, capabilities. The single source of truth for the 36 agents (`MAIN-01` … `MAIN-12`, each with `-A` and `-B`). |
| **Behavior** | `src/agents/behaviors/` | Task handlers injected per sub-agent id. A sub-agent without a handler reports `BLOCKED`. Roles are data, not 36 classes. |
| **Device runtime** | `src/runtime/` | `DeviceRegistry`, `DevicePool` (exclusive leases), `DeviceManager` (assignments, health checks, discovery). A device is a resource; an agent is a worker; the only link is `AgentAssignment`. |
| **Providers** | `src/providers/` | API keys by **environment variable name** only. Per-agent routing: agent → its MAIN parent → default. |
| **Messages** | `src/agents/messages.ts` | In-memory bus: task assigned/result, status changes, errors. |

Full 36-agent list: [`.claude/skills/ai-testing-lab/knowledge/agents.md`](.claude/skills/ai-testing-lab/knowledge/agents.md).

---

## What works and what does not

| Area | State |
|---|---|
| Agent framework, registry, factory, delegation, status tracking | Built, tested (mock) |
| Device runtime: leases, assignments, health, discovery | Built, tested (mock). Lease race conditions covered. |
| LLM providers (Anthropic, OpenAI-compatible, Mock) | Built, tested **with fakes only**. No live call has been made. |
| `AdbDevice` / `AdbDiscovery` | Built. Tested only for argument construction (fake `adb` script) and output parsing. **Never run against real `adb`.** |
| `MAIN-01-B` smoke test (install, launch, screenshot, crash-in-logs check) | Built, tested (mock) |
| `MAIN-05-A` Exploration Agent (LLM-driven loop) | Built, tested (mock device + scripted LLM). **Never run live.** |
| The other 22 sub-agents | Registered, **no behavior**. They return `BLOCKED`. |
| Local web UI (`npm run ui`): demo run verified in a headless browser; real-device mode never run | Built |
| Persistence, cost caps, vision, multi-user/remote access | **Not built** |

Limitations that matter in practice:

- **The LLM does not see pixels.** The Exploration Agent gets the UI hierarchy as text (labels and tap targets). Games, WebViews and canvases expose little or none, so exploration there will be weak.
- **UI text and log lines are sent to your LLM provider.** Do not point it at an app showing real personal data unless that is acceptable.
- **No spending cap.** A run is bounded by `maxSteps` and `timeoutMs`; tokens are counted in telemetry but not limited.
- State (leases, assignments, evidence, messages) is in memory only.

Full list: [`.claude/project-memory/known-issues.md`](.claude/project-memory/known-issues.md).

---

## Getting started

Requirements: Node 22+, npm. For real runs also `adb` (Android SDK platform-tools) and a device or emulator.

```bash
git clone https://github.com/MOT1209/-AgentLab.git
cd -AgentLab
npm install
npm test          # typecheck + build + 108 tests, fully offline
```

Other scripts: `npm run typecheck`, `npm run build`.

### Easiest: the web UI

```bash
npm run ui
```

It prints a link like `http://127.0.0.1:4173/?token=...` and opens it in your browser. From there:

1. **Demo mode** (default): press *Start test*. A scripted run with a fake phone shows the whole screen (steps, screenshots, findings, report) with no device and no key. It proves the UI works; it does not test a real app.
2. **Real device mode**: pick *Real device*, then (1) *Find devices* (needs `adb`, and an emulator or a phone with USB debugging), (2) choose the AI model and paste your API key, (3) enter the app's package name (the app must already be installed) and press *Start test*. You can stop a run at any time.

The UI is Arabic or English (switch at the top). Safety properties: it listens on `127.0.0.1` only; every API call needs the random token from the link; your API key is kept in memory only, never written to disk and never sent back to the browser; model and app text is rendered as plain text. Options: `npm run ui -- --port 4174`, `--no-open`.

> The real-device path has never been run on real hardware. Expect to hit errors and send them back.

### Command line

`npm run explore -- --mock` (offline demo) or `npm run explore -- --package com.example.app` (real device + `ANTHROPIC_API_KEY`). It writes `out/<task-id>/report.json` and the screenshots as PNG files. Otherwise AgentLab is a library (`src/index.ts`).

### 1. Try it with no device and no API key

Quickest: `npm run explore -- --mock`. Or from code:

```ts
import { initializeAgentLab, createMockFleet, ProviderManager, MockProvider } from "./src/index.js";

const providers = new ProviderManager();
providers.register(
  MockProvider.scripted([
    { json: { action: "TAP", target: { x: 540, y: 960 }, reason: "open the menu" } },
    { json: { action: "END_TEST", reason: "explored" } },
  ]),
);

const rt = initializeAgentLab({ devices: createMockFleet(12), providers });

const task = await rt.orchestrator.dispatch("MAIN-05", "explore", {
  objective: "Explore the app and look for crashes and broken navigation",
  app: { packageName: "com.example.app" },
  maxSteps: 20,
});
console.log(task.status, task.result);
```

`createMockFleet(12)` creates `DEVICE-01` … `DEVICE-12`, auto-assigned to `MAIN-01` … `MAIN-12`.

### 2. Run it for real (untested path: expect to debug)

Quickest: steps 1-2, then `npm run explore -- --package <your.app.package>`. Or from code:

1. Start an emulator or connect a device with USB debugging, and check `adb devices -l`.
2. Put your key in the environment (never in a file or in chat):
   ```bash
   export ANTHROPIC_API_KEY=...
   ```
3. Copy `providers.example.json` to `providers.local.json` (git-ignored) and edit models. Config holds the **name** of the environment variable, never the key; a key in the config is rejected.
4. Run:

```ts
import { AdbDiscovery, DeviceManager, ProviderManager, initializeAgentLab, loadProviderFile } from "./src/index.js";

const devices = new DeviceManager();
await devices.discover(new AdbDiscovery());           // registers ready adb devices
const first = devices.snapshot()[0]!.id;

const rt = initializeAgentLab({
  devices: [],
  deviceManager: devices,
  providers: ProviderManager.fromFile(loadProviderFile("providers.local.json")),
  assignments: { "MAIN-05": first },                  // only MAIN-05 gets a device
});

const ac = new AbortController();                      // cancel with ac.abort()
const task = await rt.orchestrator.dispatch(
  "MAIN-05",
  "explore",
  { objective: "Explore the app", app: { packageName: "com.example.app" }, maxSteps: 15, timeoutMs: 120_000 },
  { signal: ac.signal },
);
```

Set `AGENTLAB_LOG=1` for concise lifecycle logs on stderr (action names and short reasons only, no payloads or secrets).

A **subscription** (Claude Pro/Max, ChatGPT Plus) is not an API credential and is not supported. Use an API key, a local model through an OpenAI-compatible server such as Ollama, or an aggregator such as OpenRouter.

---

## The Exploration Agent (`MAIN-05-A`)

Task type `explore`. Each step: observe → ask the LLM → parse JSON → **validate** → execute → observe.

**Payload**

| Field | Default | Notes |
|---|---|---|
| `objective` | required | string, or `{ summary, focus? }` |
| `app` | none | `{ packageName?, name?, launchActivity?, version? }`. Without `packageName`, launch/stop are unavailable. |
| `maxSteps` | 20 (max 200) | Counts executed actions. `END_TEST` is free. |
| `timeoutMs` | 300000 (max 1800000) | |
| `screen` | none | `{ width, height }`; coordinates are bounds-checked if given |
| `captureScreenshots` | true | Stored as evidence; never sent to the LLM |

**Actions the model may request** (nothing else exists): `LAUNCH_APP` `STOP_APP` `TAP` `TYPE` `SWIPE` `BACK` `HOME` `SCREENSHOT` `WAIT` `GET_UI` `GET_LOGS` `END_TEST`.

**Safety boundary.** The model returns one JSON object per turn. `validateDecision` is the only way that output becomes an action: unknown actions, bad parameters and out-of-range coordinates are rejected, unknown keys are ignored. The executor is an exhaustive `switch` over `Device` methods. There is no shell, arbitrary-ADB, file or network action, and the model cannot name a package; launch/stop act only on the app configured in the task.

**Results.** An `ExplorationResult` (status, steps, findings, evidence, action log, telemetry incl. tokens, timestamps) is returned in `result.children[0].details`. Statuses: `PASSED`, `FAILED`, `BLOCKED`, `CANCELLED`, `TIMEOUT`, `MAX_STEPS_REACHED`, `ERROR`.

Findings are split by trust:

- `VERIFIED` — detected by the system from device logs (crash/ANR markers). Medium or worse makes the task `FAILED`.
- `AI_OBSERVATION` — something the model claims to see. Reported, never fails a task.

More: [`.claude/skills/ai-testing-lab/knowledge/exploration.md`](.claude/skills/ai-testing-lab/knowledge/exploration.md).

---

## Providers

| Kind | Use for | Notes |
|---|---|---|
| `anthropic` | Claude | Official SDK. Optional `serverSideFallback` (beta, off by default, unverified live). |
| `openai-compatible` | OpenAI, OpenRouter, Ollama, LM Studio, vLLM | `POST {baseUrl}/chat/completions`; needs `baseUrl`. |
| `mock` | Tests, offline development | `MockProvider.scripted([...])` plays replies, errors or JSON. |

```json
{
  "providers": [
    { "id": "claude", "kind": "anthropic", "model": "claude-sonnet-5-5",
      "auth": { "type": "api_key", "env": "ANTHROPIC_API_KEY" } }
  ],
  "default": "claude",
  "agents": { "MAIN-12": "claude" }
}
```

A missing environment variable fails at startup. Keys are redacted from error messages. `providers.describe()` shows whether a key is present, never its value.

---

## Project layout

```
src/
  agents/            framework: definitions, organization (36 agents), registry, factory,
                     main/sub agents, messages, validation, aggregation
    behaviors/       task handlers per sub-agent (smoke)
    exploration/     Exploration Agent: actions, validator, executor, loop, findings, prompt
  runtime/           device registry, pool/leases, manager, discovery
  device/            Device interface, MockDevice, AdbDevice, UI parser
  providers/         Anthropic, OpenAI-compatible, Mock, manager, config
  ui/                local web UI: server, page, app state, demo screens
  bootstrap.ts       initializeAgentLab()
  orchestrator.ts    dispatch (with cancellation)
examples/            runnable example (explore.ts)
test/                108 offline tests
.claude/
  skills/ai-testing-lab/   project skill: architecture, agents, android, providers, exploration notes
  project-memory/          current phase, decisions, known issues, completed work
providers.example.json
```

## Safety and scope

AgentLab is for testing applications and games you own or are authorized to test. It is not for creating fake users or engagement, farming accounts, bypassing store requirements, or manipulating platform metrics. Credentials stay in the environment and out of code, logs, reports and git.

## Roadmap (next)

1. A real run: emulator + live provider, and fix what breaks.
2. Vision input (send screenshots to the model) for games and canvas-heavy apps.
3. Cost budget per run/provider.
4. Run reports (JSON/Markdown) and persistence.
5. More sub-agent behaviors (Crash Hunter, Edge Case Agent first); dynamic device allocation if you have fewer than 12 devices.

## License

No license has been chosen yet; until one is added, all rights are reserved by the repository owner.
