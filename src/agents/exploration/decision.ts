import { costUsd, type Pricing } from "../../providers/pricing.js";
import type { LlmImage, LlmProvider, LlmResponse } from "../../providers/types.js";
import { ProviderError } from "../../providers/types.js";
import { AgentDecision, DECISION_SCHEMA } from "./actions.js";
import { parseJsonObject, validateDecision, ValidationLimits } from "./action-validator.js";
import { correctionMessage, EXPLORATION_SYSTEM_PROMPT } from "./prompt.js";
import type { ExplorationTelemetry } from "./result.js";

export type DecisionOutcome =
  | { ok: true; decision: AgentDecision }
  | { ok: false; kind: "INVALID_OUTPUT"; errors: string[] }
  | { ok: false; kind: "PROVIDER_ERROR"; message: string }
  | { ok: false; kind: "ABORTED" }
  | { ok: false; kind: "BUDGET"; message: string };

const MAX_DECISION_TOKENS = 1024;

/**
 * Asks the model for the next action. Malformed or invalid output gets exactly ONE correction attempt;
 * after that the caller gets INVALID_OUTPUT and must stop. Provider failures are returned, not thrown.
 */
export async function requestDecision(opts: {
  llm: LlmProvider;
  userMessage: string;
  limits: ValidationLimits;
  signal: AbortSignal;
  telemetry: ExplorationTelemetry;
  /** Total LLM requests allowed for the whole run, corrections included. Checked before every call. */
  maxCalls: number;
  /**
   * Optional token ceiling (input + output) for the whole run. Tokens are only known after a call
   * returns, so the last call before the ceiling can overshoot it.
   */
  maxTokens?: number;
  /** Optional money ceiling for the whole run (needs pricing). Like tokens, the last call can overshoot it. */
  maxCostUsd?: number;
  pricing?: Pricing;
  /** Attached to the first message only (vision). */
  images?: readonly LlmImage[];
}): Promise<DecisionOutcome> {
  const { llm, limits, signal, telemetry } = opts;
  const messages: { role: "user" | "assistant"; content: string; images?: readonly LlmImage[] }[] = [{ role: "user", content: opts.userMessage, ...(opts.images?.length ? { images: opts.images } : {}) }];
  let lastErrors: string[] = [];

  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal.aborted) return { ok: false, kind: "ABORTED" };
    if (telemetry.llmCalls >= opts.maxCalls) {
      return { ok: false, kind: "BUDGET", message: `LLM call limit of ${opts.maxCalls} reached.` };
    }
    if (opts.maxTokens !== undefined && telemetry.inputTokens + telemetry.outputTokens >= opts.maxTokens) {
      return { ok: false, kind: "BUDGET", message: `Token limit of ${opts.maxTokens} reached (${telemetry.inputTokens + telemetry.outputTokens} used).` };
    }
    if (opts.maxCostUsd !== undefined && (telemetry.costUsd ?? 0) >= opts.maxCostUsd) {
      return { ok: false, kind: "BUDGET", message: `Cost limit of $${opts.maxCostUsd} reached (about $${(telemetry.costUsd ?? 0).toFixed(4)} used).` };
    }
    let res: LlmResponse;
    telemetry.llmCalls++;
    try {
      res = await raceAbort(
        llm.complete({
          system: EXPLORATION_SYSTEM_PROMPT,
          messages: [...messages],
          maxTokens: MAX_DECISION_TOKENS,
          jsonSchema: { name: "agent_decision", schema: DECISION_SCHEMA },
          signal,
        }),
        signal,
      );
    } catch (e) {
      if (signal.aborted) return { ok: false, kind: "ABORTED" };
      telemetry.providerErrors++;
      return { ok: false, kind: "PROVIDER_ERROR", message: e instanceof ProviderError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e) };
    }
    telemetry.inputTokens += res.usage.inputTokens;
    telemetry.outputTokens += res.usage.outputTokens;
    if (opts.pricing) telemetry.costUsd = costUsd({ inputTokens: telemetry.inputTokens, outputTokens: telemetry.outputTokens }, opts.pricing);
    if (res.refused) {
      telemetry.providerErrors++;
      return { ok: false, kind: "PROVIDER_ERROR", message: "provider refused the request" };
    }

    const parsed = parseJsonObject(res.text);
    const checked = parsed.ok ? validateDecision(parsed.value, limits) : ({ ok: false, errors: [parsed.error] } as const);
    if (checked.ok) return { ok: true, decision: checked.decision };

    telemetry.malformedResponses++;
    lastErrors = [...checked.errors];
    messages.push({ role: "assistant", content: res.text.slice(0, 2000) }, { role: "user", content: correctionMessage(checked.errors) });
  }
  return { ok: false, kind: "INVALID_OUTPUT", errors: lastErrors };
}

/** Rejects as soon as the signal aborts, even if the underlying call ignores it. */
export function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}
