import { LlmProvider, LlmRequest, LlmResponse } from "./types.js";

/** Deterministic provider for tests and offline development. Records every request. */
export class MockProvider implements LlmProvider {
  readonly kind = "mock" as const;
  readonly requests: LlmRequest[] = [];

  constructor(
    readonly id = "mock",
    readonly model = "mock-model",
    private readonly reply: (req: LlmRequest) => string = () => "mock reply",
  ) {}

  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.requests.push(req);
    return {
      text: this.reply(req),
      providerId: this.id,
      model: this.model,
      stopReason: "end_turn",
      refused: false,
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }
}
