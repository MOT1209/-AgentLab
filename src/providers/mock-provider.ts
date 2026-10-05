import { LlmProvider, LlmRequest, LlmResponse, ProviderError } from "./types.js";

/** One scripted reply: text, a JSON-serialisable value, or an error to throw. */
export type ScriptStep = string | { json: unknown } | { error: ProviderError } | ((req: LlmRequest) => string);

/**
 * Deterministic provider for tests and offline development. Records every request.
 * With a script, replies are consumed in order; after the script ends the last step repeats
 * (or `exhausted` is used if given).
 */
export class MockProvider implements LlmProvider {
  readonly kind = "mock" as const;
  readonly requests: LlmRequest[] = [];
  private cursor = 0;

  constructor(
    readonly id = "mock",
    readonly model = "mock-model",
    private readonly reply: (req: LlmRequest) => string = () => "mock reply",
    private readonly script: readonly ScriptStep[] = [],
    private readonly usagePerCall = { inputTokens: 0, outputTokens: 0 },
  ) {}

  /** Convenience: a provider that plays a fixed sequence of replies. */
  static scripted(script: readonly ScriptStep[], id = "mock"): MockProvider {
    return new MockProvider(id, "mock-model", () => "mock reply", script, { inputTokens: 10, outputTokens: 5 });
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.requests.push(req);
    if (req.signal?.aborted) throw new ProviderError("UNAVAILABLE", "aborted", this.id);
    let text: string;
    if (this.script.length > 0) {
      const step = this.script[Math.min(this.cursor++, this.script.length - 1)]!;
      if (typeof step === "string") text = step;
      else if (typeof step === "function") text = step(req);
      else if ("error" in step) throw step.error;
      else text = JSON.stringify(step.json);
    } else {
      text = this.reply(req);
    }
    return {
      text,
      providerId: this.id,
      model: this.model,
      stopReason: "end_turn",
      refused: false,
      usage: { ...this.usagePerCall },
    };
  }
}
