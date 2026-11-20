/**
 * Runs the Crash Hunter (MAIN-04-A) once and writes a report. No LLM and no API key.
 *
 *   npm run crash-hunt -- --mock
 *   npm run crash-hunt -- --package com.example.app --seed 42
 *
 * Options
 *   --mock                 offline demo: fake device with a planted crash (no adb)
 *   --package <name>       Android package of the app under test (must be installed)
 *   --seed <n>             same seed, same action sequence (default 1)
 *   --max-actions <n>      actions in the stress phase (default 60, max 500)
 *   --cold-starts <n>      stop/launch cycles first (default 3)
 *   --timeout <ms>         default 300000
 *   --device <serial>      adb serial to use (default: first ready device)
 *   --activity <name>      entry activity (e.g. .MainActivity); default: the launcher activity
 *   --no-confirm           do not replay crashes to confirm them
 *   --allow-sensitive      also tap buy/pay/subscribe/delete-account/... controls (off by default)
 *   --out <dir>            report directory (default ./out)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AdbDiscovery, DeviceManager, MockDevice, createMockFleet, initializeAgentLab, type AgentResult, type ExplorationResult } from "../src/index.js";

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

const num = (v: string | true | undefined, def: number): number => (typeof v === "string" ? Number(v) : def);
const opt = args(process.argv.slice(2));
const mock = opt.mock === true;
const pkg = typeof opt.package === "string" ? opt.package : mock ? "com.example.app" : undefined;
if (!pkg) fail("--package <name> is required (e.g. --package com.example.app), or use --mock for the offline demo.");
const outDir = typeof opt.out === "string" ? opt.out : "out";
const activity = typeof opt.activity === "string" ? opt.activity : undefined;

/** A fake app with three buttons; "Crash me" throws. Only for the offline demo. */
function plantedCrash(d: MockDevice): void {
  const btn = (text: string, t: number) => ({ text, desc: "", id: `${pkg}:id/${text.toLowerCase().replace(/\W/g, "_")}`, cls: "android.widget.Button", pkg: pkg!, clickable: true, enabled: true, bounds: { l: 340, t, r: 740, b: t + 120 } });
  d.setUi([btn("Menu", 300), btn("Settings", 600), btn("Crash me", 900), { ...btn("Name", 1200), cls: "android.widget.EditText" }]);
  const tap = d.tap.bind(d);
  d.tap = async (x, y) => {
    await tap(x, y);
    if (x === 540 && y === 960) {
      d.appendLog("11-20 10:00:00.000  4242  4242 E AndroidRuntime: FATAL EXCEPTION: main");
      d.appendLog(`11-20 10:00:00.001  4242  4242 E AndroidRuntime: Process: ${pkg}, PID: 4242`);
      d.appendLog("11-20 10:00:00.002  4242  4242 E AndroidRuntime: java.lang.IllegalStateException: demo crash behind the 'Crash me' button");
    }
  };
}

let rt;
if (mock) {
  const fleet = createMockFleet(12);
  plantedCrash(fleet[3]!);
  rt = initializeAgentLab({ devices: fleet });
} else {
  const devices = new DeviceManager();
  try {
    await devices.discover(new AdbDiscovery());
  } catch (e) {
    fail(`could not run adb (${e instanceof Error ? e.message : String(e)}). Install Android platform-tools and make sure 'adb' is on PATH (or set ADB_PATH).`);
  }
  const wanted = typeof opt.device === "string" ? opt.device : undefined;
  const device = devices.snapshot().find((d) => (wanted ? d.id === wanted : true));
  if (!device) fail(wanted ? `device '${wanted}' not found. Run 'adb devices -l'.` : "no ready device found. Start an emulator or connect a phone with USB debugging, then check 'adb devices -l'.");
  console.log(`Device: ${device.id} (${device.source})`);
  rt = initializeAgentLab({ devices: [], deviceManager: devices, assignments: { "MAIN-04": device.id } });
}

const payload = {
  app: { packageName: pkg, ...(activity ? { launchActivity: activity } : {}) },
  seed: num(opt.seed, 1),
  maxActions: num(opt["max-actions"], mock ? 40 : 60),
  coldStarts: num(opt["cold-starts"], mock ? 1 : 3),
  timeoutMs: num(opt.timeout, 300_000),
  confirmCrashes: opt["no-confirm"] !== true,
  allowSensitiveActions: opt["allow-sensitive"] === true,
};
console.log(`Hunting crashes in ${pkg} (seed ${payload.seed}, ${payload.maxActions} actions, ${payload.coldStarts} cold start(s))...`);
const ac = new AbortController();
process.once("SIGINT", () => {
  console.log("\nCancelling...");
  ac.abort();
});

const task = await rt.orchestrator.dispatch("MAIN-04", "crash-hunt", payload, { signal: ac.signal });
const child = (task.result as AgentResult | undefined)?.children?.[0];
const result = child?.details as ExplorationResult | undefined;
if (!result) {
  console.log(`\nNo result. Task ${task.status}: ${child?.summary ?? task.errors.join("; ")}`);
  process.exit(2);
}

const dir = join(outDir, result.taskId);
mkdirSync(dir, { recursive: true });
for (const ev of result.evidence) if (ev.kind === "screenshot" && ev.id) writeFileSync(join(dir, `${ev.id}.png`), Buffer.from(ev.data, "base64"));
const slim = { ...result, evidence: result.evidence.map((e) => (e.kind === "screenshot" ? { ...e, data: `${e.id}.png` } : e)) };
writeFileSync(join(dir, "report.json"), JSON.stringify(slim, null, 2));

console.log(`\nStatus: ${result.status}   (task: ${task.status})`);
console.log(result.summary);
for (const f of result.findings) {
  console.log(` - [${f.severity}] ${f.title}${f.reproduced ? ` — replay: ${f.reproduced}` : ""}`);
  for (const s of f.reproSteps ?? []) console.log(`     ${s}`);
}
console.log(`\nActions: ${result.telemetry.actions} (${result.telemetry.actionFailures} failed)  Time: ${(result.telemetry.durationMs / 1000).toFixed(1)}s`);
console.log(`Report: ${join(dir, "report.json")}`);
process.exit(task.status === "FAILED" ? 1 : task.status === "PASSED" ? 0 : 2);
