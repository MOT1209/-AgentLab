import { test } from "node:test";
import assert from "node:assert/strict";
import { MockDevice } from "../src/device/mock-device.js";
import { MockProvider } from "../src/providers/mock-provider.js";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible-provider.js";
import { costUsd, parsePricing } from "../src/providers/pricing.js";
import { redactSensitive } from "../src/agents/exploration/redact.js";
import { parseExplorationTask } from "../src/agents/exploration/task.js";
import { runExploration } from "../src/agents/exploration/exploration-agent.js";
import { observationForPrompt } from "../src/agents/exploration/observation.js";

const PKG = "com.example.app";
const base = (extra: Record<string, unknown> = {}) => {
  const p = parseExplorationTask({ objective: "explore", app: { packageName: PKG }, maxSteps: 10, ...extra });
  assert.ok(p.ok, JSON.stringify(p));
  return p.task;
};
const noSleep = async () => undefined;
const tap = { json: { action: "TAP", target: { x: 100, y: 200 }, reason: "open" } };
const end = { json: { action: "END_TEST", reason: "done" } };
const launch = { json: { action: "LAUNCH_APP", reason: "start" } };

test("redaction masks emails, tokens, card/phone numbers in what the model sees, and leaves ordinary text", () => {
  assert.equal(redactSensitive("Mail me at jane.doe@example.com now"), "Mail me at [email] now");
  assert.equal(redactSensitive("Card 4111 1111 1111 1111 ok"), "Card [number] ok");
  assert.equal(redactSensitive("Call +49 170 1234567"), "Call [phone]");
  assert.match(redactSensitive("Authorization: Bearer abcdefghijklmnop12345"), /Bearer \[token\]/);
  assert.equal(redactSensitive("Settings"), "Settings");
  const o = observationForPrompt({ step: 1, timestamp: "t", deviceState: "ONLINE", app: {}, errors: [], metadata: {}, ui: [{ text: "a@b.co", x: 1, y: 2, clickable: true }], logLines: ["E/x: user a@b.co"] });
  assert.ok(!JSON.stringify(o).includes("a@b.co"));
});

test("pricing: cost is computed from the caller's prices; a cap needs prices", () => {
  assert.equal(costUsd({ inputTokens: 2_000_000, outputTokens: 1_000_000 }, { inputPerMTok: 3, outputPerMTok: 15 }), 21);
  assert.equal(parsePricing({ inputPerMTok: -1, outputPerMTok: 1 }), undefined);
  const r = parseExplorationTask({ objective: "x", maxCostUsd: 1 });
  assert.ok(!r.ok && r.errors.some((e) => /needs pricing/.test(e)));
  assert.ok(parseExplorationTask({ objective: "x", maxCostUsd: 1, pricing: { inputPerMTok: 1, outputPerMTok: 1 } }).ok);
});

test("cost cap stops the run as BUDGET_EXCEEDED and reports the estimated cost", async () => {
  // 10 in + 5 out tokens per call at 100000 USD/MTok = $1.5 per call; cap $2 -> third call is refused
  const llm = MockProvider.scripted([launch, tap, tap, tap, end]);
  const r = await runExploration({ taskId: "t", agentId: "A", device: new MockDevice("D"), llm, sleep: noSleep, task: base({ maxCostUsd: 2, pricing: { inputPerMTok: 100_000, outputPerMTok: 100_000 } }) });
  assert.equal(r.status, "BUDGET_EXCEEDED");
  assert.equal(llm.requests.length, 2);
  assert.equal(r.telemetry.costUsd, 3);
  assert.match(r.summary, /Cost limit of \$2/);
});

test("vision is off by default; when on, the latest screenshot goes to the model", async () => {
  const run = async (vision: boolean) => {
    const llm = MockProvider.scripted([launch, end]);
    await runExploration({ taskId: "t", agentId: "A", device: new MockDevice("D"), llm, sleep: noSleep, task: base(vision ? { vision: true } : {}) });
    return llm.requests;
  };
  assert.ok((await run(false)).every((q) => !q.messages[0]!.images));
  const on = await run(true);
  assert.equal(on[0]!.messages[0]!.images?.length, 1);
  assert.equal(on[0]!.messages[0]!.images![0]!.mediaType, "image/png");
});

test("OpenAI-compatible provider sends images as image_url data URLs", async () => {
  let body: { messages: Array<{ content: unknown }> } | undefined;
  const p = new OpenAICompatibleProvider({ id: "o", kind: "openai-compatible", model: "m", baseUrl: "http://localhost:1/v1", auth: { type: "none" } }, undefined, async (_u, init) => {
    body = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: "{}" }, finish_reason: "stop" }] }));
  });
  await p.complete({ messages: [{ role: "user", content: "hi", images: [{ mediaType: "image/png", dataBase64: "QUJD" }] }] });
  const parts = body!.messages[0]!.content as Array<{ type: string; image_url?: { url: string } }>;
  assert.deepEqual(parts.map((x) => x.type), ["text", "image_url"]);
  assert.equal(parts[1]!.image_url!.url, "data:image/png;base64,QUJD");
});

/** A device whose app crashes when (100,200) is tapped: always, or only the first time (flaky). */
function crashyDevice(flaky: boolean) {
  const d = new MockDevice("D");
  let crashes = 0;
  const tapOrig = d.tap.bind(d);
  d.tap = async (x: number, y: number) => {
    await tapOrig(x, y);
    if (x === 100 && y === 200 && (!flaky || crashes === 0)) {
      crashes++;
      d.appendLog(`01-01 10:00:0${crashes}.000  1  1 E AndroidRuntime: FATAL EXCEPTION: main\n01-01 10:00:0${crashes}.001  1  1 E AndroidRuntime: Process: ${PKG}, PID: 1\n01-01 10:00:0${crashes}.002  1  1 E AndroidRuntime: java.lang.IllegalStateException: boom`);
    }
  };
  return d;
}

test("verified crashes carry reproduction steps; with confirmCrashes a deterministic crash is CONFIRMED", async () => {
  const r = await runExploration({ taskId: "t", agentId: "A", device: crashyDevice(false), llm: MockProvider.scripted([launch, tap, end]), sleep: noSleep, task: base({ confirmCrashes: true }) });
  const f = r.findings.find((x) => x.source === "VERIFIED")!;
  assert.deepEqual(f.reproSteps, ["1. LAUNCH_APP", "2. TAP (100, 200)"]);
  assert.equal(f.reproduced, "CONFIRMED");
  assert.match(r.summary, /1 of 1 reproduced/);
  assert.equal(r.actionLog[1]!.params!.action, "TAP");
});

test("a flaky crash is reported as NOT_REPRODUCED but is still a failure; without the option nothing is replayed", async () => {
  const flaky = await runExploration({ taskId: "t", agentId: "A", device: crashyDevice(true), llm: MockProvider.scripted([launch, tap, end]), sleep: noSleep, task: base({ confirmCrashes: true }) });
  assert.equal(flaky.findings.find((x) => x.source === "VERIFIED")!.reproduced, "NOT_REPRODUCED");
  assert.equal(flaky.status, "FAILED");
  const dev = crashyDevice(false);
  const plain = await runExploration({ taskId: "t", agentId: "A", device: dev, llm: MockProvider.scripted([launch, tap, end]), sleep: noSleep, task: base() });
  assert.equal(plain.findings[0]!.reproduced, undefined);
  assert.equal(dev.trace.filter((t) => t.startsWith("tap:")).length, 1);
});

test("Anthropic provider sends images as base64 image blocks before the text", async () => {
  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  const { AnthropicProvider } = await import("../src/providers/anthropic-provider.js");
  let params: { messages: Array<{ content: unknown }> } | undefined;
  const fake = { messages: { create: async (p: never) => ((params = p), { model: "m", stop_reason: "end_turn", content: [{ type: "text", text: "{}" }], usage: { input_tokens: 1, output_tokens: 1 } }) } } as unknown as InstanceType<typeof Anthropic>;
  await new AnthropicProvider({ id: "c", kind: "anthropic", model: "m", auth: { type: "api_key", env: "K" } }, "sk-test-0123456789", fake).complete({ messages: [{ role: "user", content: "hi", images: [{ mediaType: "image/png", dataBase64: "QUJD" }] }] });
  assert.deepEqual(params!.messages[0]!.content, [{ type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } }, { type: "text", text: "hi" }]);
});
