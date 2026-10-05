/**
 * Runs the Exploration Agent (MAIN-05-A) once and writes a report.
 *
 *   npm run explore -- --mock
 *   npm run explore -- --package com.example.app --objective "Explore login and menus"
 *
 * Options
 *   --mock                 offline demo: fake device + scripted LLM (no adb, no key)
 *   --package <name>       Android package of the app under test
 *   --objective <text>     what to look for (default: general exploration)
 *   --max-steps <n>        default 15
 *   --timeout <ms>         default 180000
 *   --device <serial>      adb serial to use (default: first ready device)
 *   --providers <file>     provider config JSON (default: use ANTHROPIC_API_KEY)
 *   --model <id>           model for the default Anthropic provider (default claude-sonnet-5-5)
 *   --out <dir>            report directory (default ./out)
 *   --activity <name>      entry activity (e.g. .MainActivity); default: the launcher activity
 *   --max-llm-calls <n>    hard cap on LLM requests (default: max-steps + 5)
 *   --evidence-dir <dir>   absolute path; evidence files + result.json are written there (default: <out>/<task>)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AdbDiscovery, DeviceManager, MockProvider, ProviderManager, createMockFleet, initializeAgentLab, loadProviderFile,
  type AgentResult, type ExplorationResult,
} from "../src/index.js";

function args(argv: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[a.slice(2)] = true;
    else (out[a.slice(2)] = next), i++;
  }
  return out;
}

function fail(message: string): never {
  console.error(`\nError: ${message}\n`);
  process.exit(2);
}

const opt = args(process.argv.slice(2));
const mock = opt.mock === true;
const pkg = typeof opt.package === "string" ? opt.package : mock ? "com.example.app" : undefined;
if (!pkg) fail("--package <name> is required (e.g. --package com.example.app), or use --mock for the offline demo.");

const maxSteps = Number(opt["max-steps"] ?? 15);
const timeoutMs = Number(opt.timeout ?? 180_000);
const objective = typeof opt.objective === "string" ? opt.objective : "Explore the application and identify crashes, broken navigation, unresponsive controls and obvious UI problems.";
const outDir = typeof opt.out === "string" ? opt.out : "out";
const activity = typeof opt.activity === "string" ? opt.activity : undefined;
const maxLlmCalls = opt["max-llm-calls"] !== undefined ? Number(opt["max-llm-calls"]) : undefined;
const evidenceDir = typeof opt["evidence-dir"] === "string" ? opt["evidence-dir"] : undefined;

let rt;
if (mock) {
  const providers = new ProviderManager();
  providers.register(
    MockProvider.scripted([
      { json: { action: "LAUNCH_APP", reason: "start the app" } },
      { json: { action: "TAP", target: { x: 540, y: 960 }, reason: "open the main menu" } },
      { json: { action: "END_TEST", reason: "demo finished" } },
    ]),
  );
  rt = initializeAgentLab({ devices: createMockFleet(12), providers });
} else {
  // 1. devices
  const devices = new DeviceManager();
  try {
    await devices.discover(new AdbDiscovery());
  } catch (e) {
    fail(`could not run adb (${e instanceof Error ? e.message : String(e)}). Install Android platform-tools and make sure 'adb' is on PATH.`);
  }
  const wanted = typeof opt.device === "string" ? opt.device : undefined;
  const device = devices.snapshot().find((d) => (wanted ? d.id === wanted : true));
  if (!device) fail(wanted ? `device '${wanted}' not found. Run 'adb devices -l'.` : "no ready device found. Start an emulator or connect a phone with USB debugging and accept the prompt, then check 'adb devices -l'.");
  console.log(`Device: ${device.id} (${device.source})`);

  // 2. LLM provider
  let providers: ProviderManager;
  if (typeof opt.providers === "string") {
    providers = ProviderManager.fromFile(loadProviderFile(opt.providers));
  } else {
    if (!process.env.ANTHROPIC_API_KEY) fail("ANTHROPIC_API_KEY is not set. Run:  export ANTHROPIC_API_KEY=...   (or pass --providers <file>)");
    providers = new ProviderManager();
    providers.add({ id: "claude", kind: "anthropic", model: typeof opt.model === "string" ? opt.model : "claude-sonnet-5-5", auth: { type: "api_key", env: "ANTHROPIC_API_KEY" } });
  }
  console.log(`Model: ${providers.list()[0]!.model}`);

  rt = initializeAgentLab({ devices: [], deviceManager: devices, providers, assignments: { "MAIN-05": device.id } });
}

console.log(`Exploring ${pkg} (max ${maxSteps} steps, ${timeoutMs} ms)...`);
const ac = new AbortController();
process.once("SIGINT", () => {
  console.log("\nCancelling...");
  ac.abort();
});

const task = await rt.orchestrator.dispatch("MAIN-05", "explore", { objective, app: { packageName: pkg, ...(activity ? { launchActivity: activity } : {}) }, maxSteps, timeoutMs, ...(maxLlmCalls ? { maxLlmCalls } : {}), ...(evidenceDir ? { evidenceDir } : {}) }, { signal: ac.signal });
const child = (task.result as AgentResult | undefined)?.children?.[0];
const result = child?.details as ExplorationResult | undefined;

if (!result) {
  console.log(`\nNo exploration result. Task ${task.status}: ${child?.summary ?? task.errors.join("; ")}`);
  process.exit(2);
}

// Report: JSON without image bytes, plus the screenshots as PNG files.
const dir = join(outDir, result.taskId);
mkdirSync(dir, { recursive: true });
for (const ev of result.evidence) if (ev.kind === "screenshot" && ev.id) writeFileSync(join(dir, `${ev.id}.png`), Buffer.from(ev.data, "base64"));
const slim = { ...result, evidence: result.evidence.map((e) => (e.kind === "screenshot" ? { ...e, data: `${e.id}.png` } : e)) };
writeFileSync(join(dir, "report.json"), JSON.stringify(slim, null, 2));

console.log(`\nStatus: ${result.status}   (task: ${task.status})`);
console.log(result.summary);
for (const f of result.findings) console.log(` - [${f.severity}] ${f.title} (${f.source === "VERIFIED" ? "verified" : "AI observation, unverified"})`);
const t = result.telemetry;
console.log(`\nActions: ${t.actions} (${t.actionFailures} failed)  LLM calls: ${t.llmCalls}  Tokens in/out: ${t.inputTokens}/${t.outputTokens}  Time: ${(t.durationMs / 1000).toFixed(1)}s`);
console.log(`Report: ${join(dir, "report.json")}`);
process.exit(task.status === "FAILED" ? 1 : task.status === "PASSED" ? 0 : 2);
