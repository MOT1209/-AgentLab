import Anthropic from "@anthropic-ai/sdk";
import { redact } from "./secrets.js";
import { LlmProvider, LlmRequest, LlmResponse, ProviderConfig, ProviderError } from "./types.js";

const DEFAULT_MAX_TOKENS = 16000;

/** Uses the official Anthropic SDK. The SDK already retries 408/409/429/5xx twice. */
export class AnthropicProvider implements LlmProvider {
  readonly kind = "anthropic" as const;
  readonly id: string;
  readonly model: string;

  constructor(
    private readonly config: ProviderConfig,
    apiKey: string,
    /** Injected in tests. */
    private readonly client: Anthropic = new Anthropic({
      apiKey,
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
      ...(config.timeoutMs ? { timeout: config.timeoutMs } : {}),
    }),
    private readonly secret: string = apiKey,
  ) {
    this.id = config.id;
    this.model = config.model;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const params = {
      model: this.model,
      max_tokens: req.maxTokens ?? this.config.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(req.system ? { system: req.system } : {}),
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      ...(req.jsonSchema ? { output_config: { format: { type: "json_schema" as const, schema: req.jsonSchema.schema } } } : {}),
    };
    const opts = req.signal ? { signal: req.signal } : undefined;
    try {
      const msg = this.config.serverSideFallback
        ? await this.client.beta.messages.create({ ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } as never, opts)
        : await this.client.messages.create(params, opts);
      const text = (msg.content as { type: string; text?: string }[])
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("");
      return {
        text,
        providerId: this.id,
        model: msg.model,
        stopReason: msg.stop_reason ?? "unknown",
        refused: msg.stop_reason === "refusal",
        usage: { inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens },
      };
    } catch (e) {
      throw this.mapError(e);
    }
  }

  /** Most specific first: 429/auth/bad request are distinguishable, connection errors are retryable. */
  private mapError(e: unknown): ProviderError {
    const msg = redact(e instanceof Error ? e.message : String(e), [this.secret]);
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
      return new ProviderError("AUTH", msg, this.id);
    }
    if (e instanceof Anthropic.RateLimitError) return new ProviderError("RATE_LIMIT", msg, this.id, true);
    if (e instanceof Anthropic.BadRequestError || e instanceof Anthropic.NotFoundError) {
      return new ProviderError("BAD_REQUEST", msg, this.id);
    }
    if (e instanceof Anthropic.APIConnectionError) return new ProviderError("UNAVAILABLE", msg, this.id, true);
    if (e instanceof Anthropic.APIError) {
      const retryable = (e.status ?? 0) >= 500;
      return new ProviderError(retryable ? "UNAVAILABLE" : "UNKNOWN", msg, this.id, retryable);
    }
    return new ProviderError("UNKNOWN", msg, this.id);
  }
}
