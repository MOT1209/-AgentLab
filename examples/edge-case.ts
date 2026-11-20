/**
 * Runs the Edge Case Agent (MAIN-05-B) once and writes a report. No LLM and no API key.
 *
 *   npm run edge-case -- --mock
 *   npm run edge-case -- --package com.example.app --max-cases 60
 *
 * Options
 *   --mock                 offline demo: fake form app with a planted crash (no adb)
 *   --package <name>       Android package of the app under test (must be installed)
 *   --inputs-file <file>   one input per line (ASCII); default: the built-in boundary values
 *   --max-cases <n>        default 80, max 300
 *   --max-fields <n>       text fields tested on the start screen (default 5)
 *   --no-sequences         skip double submit, back during submit, rapid relaunch, ...
 *   --timeout <ms>         default 600000
 *   --device <serial>      adb serial to use (default: first ready device)
 *   --activity <name>      entry activity (e.g. .MainActivity); default: the launcher activity
 *   --no-confirm           do not replay crashes to confirm them
 *   --allow-sensitive      also press buy/pay/subscribe/delete-account/... controls (off by default)
 *   --out <dir>            report directory (default ./out)
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AdbDiscovery, DeviceManager, MockDevice, createMockFleet, initializeAgentLab, type AgentResult, type EdgeCaseRecord, type ExplorationResult } from "../src/index.js";

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
let inputs: string[] | undefined;
if (typeof opt["inputs-file"] === "string") {
  try {
    inputs = readFileSync(opt["inputs-file"], "utf8").split(/\r?\n/).filter((l) => l.length > 0);
  } catch (e) {
    fail(`cannot read --inputs-file: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** A fake sign-up form: "Name" and "Age" fields and a Save button; saving with age -1 crashes. Only for the offline demo. */
function plantedForm(d: MockDevice): void {
  const node = (id: string, text: string, cls: string, t: number) => ({ text, desc: "", id: `${pkg}:id/${id}`, cls, pkg: pkg!, clickable: true, enabled: true, bounds: { l: 240, t, r: 840, b: t + 120 } });
  d.setUi([node("name", "", "android.widget.EditText", 300), node("age", "", "android.widget.EditText", 500), node("save", "Save", "android.widget.Button", 800)]);
  let focused = "";
  let age = "";
  const { tap, type, stop } = { tap: d.tap.bind(d), type: d.type.bind(d), stop: d.stop.bind(d) };
  d.stop = async (p) => {
    await stop(p);
    age = "";
    focused = "";
  };
  d.tap = async (x, y) => {
    await tap(x, y);
    if (y === 560) focused = "age";
    else if (y === 360) focused = "name";
    else if (y === 860 && age === "-1") {
      d.appendLog("11-20 10:00:00.000  4242  4242 E AndroidRuntime: FATAL EXCEPTION: main");
      d.appendLog(`11-20 10:00:00.001  4242  4242 E AndroidRuntime: Process: ${pkg}, PID: 4242`);
      d.appendLog("11-20 10:00:00.002  4242  4242 E AndroidRuntime: java.lang.IllegalArgumentException: age must not be negative (demo)");
    }
  };
  d.type = async (t) => {
    await type(t);
    if (focused === "age") age += t;
  };
}

let rt;
if (mock) {
  const fleet = createMockFleet(12);
  plantedForm(fleet[4]!);
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
  rt = initializeAgentLab({ devices: [], deviceManager: devices, assignments: { "MAIN-05": device.id } });
}

const payload = {
  app: { packageName: pkg, ...(activity ? { launchActivity: activity } : {}) },
  ...(inputs ? { inputs } : mock ? { inputs: ["0", "-1", "abc", "a".repeat(300)] } : {}),
  ...(num(opt["max-cases"]) !== undefined ? { maxCases: num(opt["max-cases"]) } : {}),
  ...(num(opt["max-fields"]) !== undefined ? { maxFields: num(opt["max-fields"]) } : {}),
  ...(num(opt.timeout) !== undefined ? { timeoutMs: num(opt.timeout) } : {}),
  sequences: opt["no-sequences"] !== true,
  confirmCrashes: opt["no-confirm"] !== true,
  allowSensitiveActions: opt["allow-sensitive"] === true,
};
console.log(`Testing edge cases in ${pkg}...`);
const ac = new AbortController();
process.once("SIGINT", () => {
  console.log("\nCancelling...");
  ac.abort();
});

const task = await rt.orchestrator.dispatch("MAIN-05", "edge-case", payload, { signal: ac.signal });
const child = (task.result as AgentResult | undefined)?.children?.[0];
const result = child?.details as (ExplorationResult & { cases: EdgeCaseRecord[] }) | undefined;
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
console.log("\nCases:");
for (const c of result.cases) console.log(`  ${c.id}  ${c.outcome.padEnd(10)} ${c.kind.padEnd(8)} ${c.name}${c.findingId ? `  -> ${c.findingId}` : ""}`);
for (const f of result.findings) {
  console.log(`\n[${f.severity}] ${f.id} ${f.title}${f.reproduced ? ` — replay: ${f.reproduced}` : ""}`);
  console.log(`  ${f.description}`);
  for (const st of f.reproSteps ?? []) console.log(`     ${st}`);
}
console.log(`\nActions: ${result.telemetry.actions}  Time: ${(result.telemetry.durationMs / 1000).toFixed(1)}s`);
console.log(`Report: ${join(dir, "report.json")}`);
process.exit(task.status === "FAILED" ? 1 : task.status === "PASSED" ? 0 : 2);
