/**
 * Runs the Stability Tester (MAIN-04-B) once and writes a report. No LLM and no API key.
 *
 *   npm run stability -- --mock
 *   npm run stability -- --package com.example.app --cold 10 --warm 30
 *
 * Options
 *   --mock                 offline demo: a fake app that leaks memory on every resume and crashes on one cold start
 *   --package <name>       Android package of the app under test (must be installed)
 *   --cold <n>             cold cycles: stop, launch, settle (default 10, max 50)
 *   --warm <n>             warm cycles: home, settle, resume, settle, read memory (default 20, max 100)
 *   --settle <ms>          wait after each launch / resume (default 1500)
 *   --growth-pct <n>       leak threshold in percent (default 25)
 *   --growth-mb <n>        leak threshold in MB (default 15)
 *   --timeout <ms>         default 1200000
 *   --device <serial>      adb serial to use (default: first ready device)
 *   --activity <name>      entry activity (e.g. .MainActivity); default: the launcher activity
 *   --confirm              replay each crash once (off by default: intermittent crashes rarely recur in one replay)
 *   --out <dir>            report directory (default ./out)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AdbDiscovery, DeviceManager, MockDevice, createMockFleet, initializeAgentLab, type AgentResult, type ExplorationResult, type StabilityMetrics } from "../src/index.js";

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

const num = (v: string | true | undefined): number | undefined => (typeof v === "string" ? Number(v) : undefined);
const opt = args(process.argv.slice(2));
const mock = opt.mock === true;
const pkg = typeof opt.package === "string" ? opt.package : mock ? "com.example.app" : undefined;
if (!pkg) fail("--package <name> is required (e.g. --package com.example.app), or use --mock for the offline demo.");
const outDir = typeof opt.out === "string" ? opt.out : "out";
const activity = typeof opt.activity === "string" ? opt.activity : undefined;

/** Demo only: memory grows 6 MB per resume while the process lives; the 4th launch crashes. */
function leakyApp(d: MockDevice): void {
  let resumes = 0;
  let launches = 0;
  d.memoryFn = () => 80_000 + resumes * 6 * 1024;
  const { launch, stop } = { launch: d.launch.bind(d), stop: d.stop.bind(d) };
  d.stop = async (p) => {
    await stop(p);
    resumes = 0;
  };
  d.launch = async (p, a) => {
    const wasRunning = d.isRunning(p);
    await launch(p, a);
    if (wasRunning) resumes++;
    if (++launches === 4) {
      d.appendLog("11-20 10:00:00.000  4242  4242 E AndroidRuntime: FATAL EXCEPTION: main");
      d.appendLog(`11-20 10:00:00.001  4242  4242 E AndroidRuntime: Process: ${pkg}, PID: 4242`);
      d.appendLog("11-20 10:00:00.002  4242  4242 E AndroidRuntime: java.lang.IllegalStateException: cache not ready (demo, happens on one launch only)");
    }
  };
}

let rt;
if (mock) {
  const fleet = createMockFleet(12);
  leakyApp(fleet[3]!);
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
  coldCycles: num(opt.cold) ?? (mock ? 5 : 10),
  warmCycles: num(opt.warm) ?? (mock ? 10 : 20),
  settleMs: num(opt.settle) ?? (mock ? 200 : 1500),
  ...(num(opt["growth-pct"]) !== undefined ? { memoryGrowthPct: num(opt["growth-pct"]) } : {}),
  ...(num(opt["growth-mb"]) !== undefined ? { memoryGrowthMb: num(opt["growth-mb"]) } : {}),
  ...(num(opt.timeout) !== undefined ? { timeoutMs: num(opt.timeout) } : {}),
  confirmCrashes: opt.confirm === true,
};
console.log(`Stability run on ${pkg}: ${payload.coldCycles} cold, ${payload.warmCycles} warm cycle(s)...`);
const ac = new AbortController();
process.once("SIGINT", () => {
  console.log("\nCancelling...");
  ac.abort();
});

const task = await rt.orchestrator.dispatch("MAIN-04", "stability", payload, { signal: ac.signal });
const child = (task.result as AgentResult | undefined)?.children?.[0];
const result = child?.details as (ExplorationResult & { metrics: StabilityMetrics }) | undefined;
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
console.log("\nCycles:");
for (const c of result.metrics.cycles) console.log(`  #${String(c.n).padStart(3)} ${c.kind.padEnd(5)} ${c.launchMs !== undefined ? `launch ${c.launchMs} ms` : c.pssKb !== undefined ? `PSS ${(c.pssKb / 1024).toFixed(1)} MB` : "-"}${c.crashed ? "  CRASH" : ""}`);
for (const f of result.findings) console.log(`\n[${f.severity}] ${f.id} ${f.title}\n  ${f.description}`);
console.log(`\nActions: ${result.telemetry.actions}  Time: ${(result.telemetry.durationMs / 1000).toFixed(1)}s`);
console.log(`Report: ${join(dir, "report.json")}`);
process.exit(task.status === "FAILED" ? 1 : task.status === "PASSED" ? 0 : 2);
