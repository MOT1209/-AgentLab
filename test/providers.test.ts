import { test } from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { AnthropicProvider } from "../src/providers/anthropic-provider.js";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible-provider.js";
import { MockProvider } from "../src/providers/mock-provider.js";
import { ProviderManager } from "../src/providers/manager.js";
import { parseProviderFile, validateProviderConfig } from "../src/providers/config.js";
import { redact } from "../src/providers/secrets.js";
import { ProviderError, type ProviderConfig } from "../src/providers/types.js";
import { initializeAgentLab } from "../src/bootstrap.js";
import { createMockFleet } from "../src/device/mock-device.js";
import type { TaskHandler } from "../src/agents/managed-agent.js";
import type { AgentResult } from "../src/agents/types.js";

const KEY = "sk-ant-test-0123456789abcdef";
const env = (vars: Record<string, string>) => ({ get: (n: string) => vars[n] });
const anthropicCfg: ProviderConfig = { id: "claude", kind: "anthropic", model: "claude-sonnet-5-5", auth: { type: "api_key", env: "ANTHROPIC_API_KEY" } };
const openaiCfg: ProviderConfig = { id: "local", kind: "openai-compatible", model: "m1", baseUrl: "http://localhost:11434/v1/", auth: { type: "none" } };

test("config: keys must never appear in config", () => {
  const cases: Array<[string, unknown, string]> = [
    ["key as env", { ...anthropicCfg, auth: { type: "api_key", env: KEY } }, "NAME of an environment variable"],
    ["inline key field", { ...anthropicCfg, auth: { type: "api_key", env: "ANTHROPIC_API_KEY", key: KEY } }, "never appear in config"],
    ["placeholder model", { ...openaiCfg, model: "REPLACE_WITH_X" }, "placeholder"],
    ["missing baseUrl", { ...openaiCfg, baseUrl: undefined }, "requires an http(s) baseUrl"],
    ["anthropic without key", { ...anthropicCfg, auth: { type: "none" } }, "requires an api_key"],
    ["bad kind", { ...anthropicCfg, kind: "magic" }, "kind must be"],
    ["bad id", { ...anthropicCfg, id: "a b" }, "simple identifier"],
    ["bad maxTokens", { ...anthropicCfg, maxTokens: -1 }, "maxTokens"],
  ];
  for (const [label, cfg, expected] of cases) {
    const problems = validateProviderConfig(cfg);
    assert.ok(problems.some((p) => p.includes(expected)), label);
    assert.ok(problems.every((p) => !p.includes(KEY)), `${label}: secret echoed`);
  }
  assert.deepEqual(validateProviderConfig(anthropicCfg), []);
  assert.deepEqual(validateProviderConfig(openaiCfg), []);
});

test("config: parseProviderFile validates every provider and rejects bad JSON", () => {
  const ok = parseProviderFile(JSON.stringify({ providers: [anthropicCfg, openaiCfg], default: "local", agents: { "MAIN-01": "claude" } }));
  assert.equal(ok.providers.length, 2);
  assert.throws(() => parseProviderFile("{nope"), /not valid JSON/);
  assert.throws(() => parseProviderFile("{}"), /providers/);
  assert.throws(() => parseProviderFile(JSON.stringify({ providers: [{ ...anthropicCfg, model: "" }] })), /model is required/);
});

test("manager: key comes from the environment and a missing key fails closed", () => {
  const m = new ProviderManager(env({}));
  assert.throws(() => m.add(anthropicCfg), /ANTHROPIC_API_KEY is not set/);
  assert.equal(m.list().length, 0);
});

test("manager: default, per-agent override, parent fallback, removal", () => {
  const m = new ProviderManager(env({ ANTHROPIC_API_KEY: KEY }), {
    anthropic: (c) => new MockProvider(c.id, c.model),
    "openai-compatible": (c) => new MockProvider(c.id, c.model),
    mock: (c) => new MockProvider(c.id, c.model),
  });
  m.add(anthropicCfg);
  m.add(openaiCfg);
  assert.throws(() => m.add(openaiCfg), /duplicate provider/);
  assert.equal(m.forAgent("MAIN-01")!.id, "claude"); // first added is the default
  m.setDefault("local");
  assert.equal(m.forAgent("MAIN-01")!.id, "local");

  m.setAgentProvider("MAIN-12", "claude");
  assert.equal(m.forAgent("MAIN-12-A", "MAIN-12")!.id, "claude"); // inherits the parent's override
  m.setAgentProvider("MAIN-12-A", "local");
  assert.equal(m.forAgent("MAIN-12-A", "MAIN-12")!.id, "local"); // own override wins
  assert.throws(() => m.setAgentProvider("X", "nope"), /unknown provider/);

  assert.equal(m.remove("local"), true);
  assert.equal(m.forAgent("MAIN-12-A", "MAIN-12")!.id, "claude");
  assert.equal(m.forAgent("MAIN-05")!.id, "claude"); // default re-pointed
  assert.equal(m.remove("nope"), false);
});

test("manager.describe never leaks the key", () => {
  const m = new ProviderManager(env({ ANTHROPIC_API_KEY: KEY }), {
    anthropic: (c) => new MockProvider(c.id, c.model),
    "openai-compatible": (c) => new MockProvider(c.id, c.model),
    mock: (c) => new MockProvider(c.id, c.model),
  });
  m.add(anthropicCfg);
  const d = m.describe();
  assert.deepEqual(d[0], { id: "claude", kind: "mock", model: "claude-sonnet-5-5", keyEnv: "ANTHROPIC_API_KEY", keyPresent: true, isDefault: true });
  assert.ok(!JSON.stringify(d).includes(KEY));
});

test("manager.test reports success and failure without throwing", async () => {
  const m = new ProviderManager(env({}));
  m.register(new MockProvider("ok"));
  m.register({ id: "bad", kind: "mock", model: "x", complete: async () => { throw new ProviderError("AUTH", "nope", "bad"); } });
  assert.deepEqual(await m.test("ok"), { ok: true, model: "mock-model" });
  assert.deepEqual(await m.test("bad"), { ok: false, code: "AUTH", message: "nope" });
  assert.equal((await m.test("zzz")).ok, false);
});

test("anthropic provider: request shape and response mapping", async () => {
  const calls: unknown[] = [];
  const fake = {
    messages: {
      create: async (p: unknown) => {
        calls.push(p);
        return { model: "claude-sonnet-5-5", stop_reason: "end_turn", content: [{ type: "thinking" }, { type: "text", text: "hel" }, { type: "text", text: "lo" }], usage: { input_tokens: 5, output_tokens: 2 } };
      },
    },
  } as unknown as Anthropic;
  const p = new AnthropicProvider(anthropicCfg, KEY, fake);
  const r = await p.complete({ system: "be brief", messages: [{ role: "user", content: "hi" }] });
  assert.deepEqual(calls[0], { model: "claude-sonnet-5-5", max_tokens: 16000, system: "be brief", messages: [{ role: "user", content: "hi" }] });
  assert.equal(r.text, "hello");
  assert.deepEqual(r.usage, { inputTokens: 5, outputTokens: 2 });
  assert.equal(r.refused, false);
});

test("anthropic provider: refusal is reported, fallback is opt-in and uses the beta path", async () => {
  let beta: unknown;
  const fake = {
    messages: { create: async () => ({ model: "m", stop_reason: "refusal", content: [], usage: { input_tokens: 1, output_tokens: 0 } }) },
    beta: { messages: { create: async (p: unknown) => ((beta = p), { model: "m", stop_reason: "end_turn", content: [{ type: "text", text: "x" }], usage: { input_tokens: 1, output_tokens: 1 } }) } },
  } as unknown as Anthropic;
  const plain = await new AnthropicProvider(anthropicCfg, KEY, fake).complete({ messages: [{ role: "user", content: "q" }] });
  assert.equal(plain.refused, true);
  await new AnthropicProvider({ ...anthropicCfg, serverSideFallback: true }, KEY, fake).complete({ messages: [{ role: "user", content: "q" }] });
  assert.deepEqual((beta as { betas: string[]; fallbacks: string }).betas, ["server-side-fallback-2026-07-01"]);
  assert.equal((beta as { fallbacks: string }).fallbacks, "default");
});

test("anthropic provider: SDK errors map to typed, secret-free ProviderErrors", async () => {
  const headers = new Headers();
  const mk = (status: number) => Anthropic.APIError.generate(status, { type: "error", error: { type: "x", message: `boom ${KEY}` } }, `boom ${KEY}`, headers);
  const expected: Array<[number, string, boolean]> = [[401, "AUTH", false], [403, "AUTH", false], [429, "RATE_LIMIT", true], [400, "BAD_REQUEST", false], [404, "BAD_REQUEST", false], [500, "UNAVAILABLE", true]];
  for (const [status, code, retryable] of expected) {
    const fake = { messages: { create: async () => { throw mk(status); } } } as unknown as Anthropic;
    await assert.rejects(new AnthropicProvider(anthropicCfg, KEY, fake).complete({ messages: [{ role: "user", content: "q" }] }), (e: ProviderError) => {
      assert.equal(e.code, code, `status ${status}`);
      assert.equal(e.retryable, retryable);
      assert.ok(!e.message.includes(KEY));
      return true;
    });
  }
});

test("openai-compatible provider: request, response, no auth header without a key", async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  const fakeFetch = async (url: string, init: RequestInit) => {
    seen = { url, init };
    return new Response(JSON.stringify({ model: "m1", choices: [{ message: { content: "yo" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1 } }), { status: 200 });
  };
  const p = new OpenAICompatibleProvider(openaiCfg, undefined, fakeFetch);
  const r = await p.complete({ system: "s", messages: [{ role: "user", content: "hi" }] });
  assert.equal(seen!.url, "http://localhost:11434/v1/chat/completions");
  assert.equal((seen!.init.headers as Record<string, string>).authorization, undefined);
  assert.deepEqual(JSON.parse(seen!.init.body as string).messages, [{ role: "system", content: "s" }, { role: "user", content: "hi" }]);
  assert.deepEqual([r.text, r.usage, r.refused], ["yo", { inputTokens: 3, outputTokens: 1 }, false]);
});

test("openai-compatible provider: bearer key, HTTP errors and network failures", async () => {
  const mkFetch = (status: number, body = "bad") => async () => new Response(`${body} ${KEY}`, { status });
  const req = { messages: [{ role: "user" as const, content: "q" }] };
  const withKey = { ...openaiCfg, auth: { type: "api_key" as const, env: "K" } };
  const cases: Array<[number, string]> = [[401, "AUTH"], [429, "RATE_LIMIT"], [503, "UNAVAILABLE"], [400, "BAD_REQUEST"]];
  for (const [status, code] of cases) {
    await assert.rejects(new OpenAICompatibleProvider(withKey, KEY, mkFetch(status)).complete(req), (e: ProviderError) => {
      assert.equal(e.code, code);
      assert.ok(!e.message.includes(KEY), "key leaked into error");
      return true;
    });
  }
  let auth: string | undefined;
  await new OpenAICompatibleProvider(withKey, KEY, async (_u, init) => ((auth = (init.headers as Record<string, string>).authorization), new Response(JSON.stringify({ choices: [{ message: { content: "" }, finish_reason: "content_filter" }] })))).complete(req).then((r) => assert.equal(r.refused, true));
  assert.equal(auth, `Bearer ${KEY}`);
  await assert.rejects(new OpenAICompatibleProvider(openaiCfg, undefined, async () => { throw new Error("ECONNREFUSED"); }).complete(req), (e: ProviderError) => e.code === "UNAVAILABLE" && e.retryable);
});

test("redact removes secrets but ignores short strings", () => {
  assert.equal(redact(`a ${KEY} b`, [KEY]), "a [REDACTED] b");
  assert.equal(redact("abc", ["abc"]), "abc");
});

test("agents receive their routed provider as ctx.llm; none configured means undefined", async () => {
  const ask: TaskHandler = {
    requires: [],
    handle: async ({ llm }) => ({ status: "PASSED", summary: llm ? (await llm.complete({ messages: [{ role: "user", content: "hi" }] })).providerId : "no-llm", evidence: [] }),
  };
  const providers = new ProviderManager(env({}));
  providers.register(new MockProvider("cheap"));
  providers.register(new MockProvider("smart"));
  providers.setAgentProvider("MAIN-03", "smart");

  const rt = initializeAgentLab({ devices: createMockFleet(12), providers, behaviors: { "MAIN-03-A": { ask }, "MAIN-04-A": { ask } } });
  const a = await rt.orchestrator.dispatch("MAIN-03", "ask", {});
  const b = await rt.orchestrator.dispatch("MAIN-04", "ask", {});
  assert.equal((a.result as AgentResult).children![0]!.summary, "smart"); // via the MAIN parent's override
  assert.equal((b.result as AgentResult).children![0]!.summary, "cheap"); // default
  assert.equal(rt.providers, providers);

  const bare = initializeAgentLab({ devices: createMockFleet(12), behaviors: { "MAIN-03-A": { ask } } });
  assert.equal(((await bare.orchestrator.dispatch("MAIN-03", "ask", {})).result as AgentResult).children![0]!.summary, "no-llm");
});

test("structured-output hint and abort signal are passed to the providers", async () => {
  const schema = { type: "object", properties: { a: { type: "string" } } };
  const ac = new AbortController();
  let params: Record<string, unknown> | undefined;
  let opts: unknown;
  const fake = { messages: { create: async (p: Record<string, unknown>, o: unknown) => ((params = p), (opts = o), { model: "m", stop_reason: "end_turn", content: [{ type: "text", text: "{}" }], usage: { input_tokens: 1, output_tokens: 1 } }) } } as unknown as Anthropic;
  await new AnthropicProvider(anthropicCfg, KEY, fake).complete({ messages: [{ role: "user", content: "q" }], jsonSchema: { name: "x", schema }, signal: ac.signal });
  assert.deepEqual(params!.output_config, { format: { type: "json_schema", schema } });
  assert.equal((opts as { signal: AbortSignal }).signal, ac.signal);

  let body: Record<string, unknown> = {};
  const f = async (_u: string, init: RequestInit) => ((body = JSON.parse(init.body as string)), new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] })));
  await new OpenAICompatibleProvider(openaiCfg, undefined, f).complete({ messages: [{ role: "user", content: "q" }], jsonSchema: { name: "x", schema } });
  assert.deepEqual(body.response_format, { type: "json_schema", json_schema: { name: "x", schema } });
});
