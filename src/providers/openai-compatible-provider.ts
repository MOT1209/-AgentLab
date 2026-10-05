import { redact } from "./secrets.js";
import { LlmProvider, LlmRequest, LlmResponse, ProviderConfig, ProviderError } from "./types.js";

const DEFAULT_MAX_TOKENS = 4096;
type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

interface ChatCompletion {
  model?: string;
  choices?: { message?: { content?: string | null; refusal?: string | null }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * Any server speaking POST {baseUrl}/chat/completions: OpenAI, OpenRouter, Ollama, LM Studio, vLLM...
 * Not for calling Claude; use the anthropic kind for that.
 */
export class OpenAICompatibleProvider implements LlmProvider {
  readonly kind = "openai-compatible" as const;
  readonly id: string;
  readonly model: string;

  constructor(
    private readonly config: ProviderConfig,
    private readonly apiKey: string | undefined,
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    this.id = config.id;
    this.model = config.model;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const url = `${(this.config.baseUrl as string).replace(/\/+$/, "")}/chat/completions`;
    const body = {
      model: this.model,
      max_tokens: req.maxTokens ?? this.config.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages: [...(req.system ? [{ role: "system", content: req.system }] : []), ...req.messages],
      ...(req.jsonSchema ? { response_format: { type: "json_schema", json_schema: { name: req.jsonSchema.name, schema: req.jsonSchema.schema } } } : {}),
    };
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
        body: JSON.stringify(body),
        signal: req.signal ? AbortSignal.any([req.signal, AbortSignal.timeout(this.config.timeoutMs ?? 120_000)]) : AbortSignal.timeout(this.config.timeoutMs ?? 120_000),
      });
    } catch (e) {
      throw new ProviderError("UNAVAILABLE", this.clean(e instanceof Error ? e.message : String(e)), this.id, true);
    }
    if (!res.ok) throw this.httpError(res.status, await res.text().catch(() => ""));

    const data = (await res.json()) as ChatCompletion;
    const choice = data.choices?.[0];
    const refusal = choice?.message?.refusal ?? null;
    return {
      text: choice?.message?.content ?? "",
      providerId: this.id,
      model: data.model ?? this.model,
      stopReason: choice?.finish_reason ?? "unknown",
      refused: refusal !== null || choice?.finish_reason === "content_filter",
      usage: { inputTokens: data.usage?.prompt_tokens ?? 0, outputTokens: data.usage?.completion_tokens ?? 0 },
    };
  }

  private clean(s: string): string {
    return redact(s, [this.apiKey]).slice(0, 500);
  }

  private httpError(status: number, bodyText: string): ProviderError {
    const msg = `HTTP ${status}: ${this.clean(bodyText)}`;
    if (status === 401 || status === 403) return new ProviderError("AUTH", msg, this.id);
    if (status === 429) return new ProviderError("RATE_LIMIT", msg, this.id, true);
    if (status === 408 || status >= 500) return new ProviderError("UNAVAILABLE", msg, this.id, true);
    if (status >= 400) return new ProviderError("BAD_REQUEST", msg, this.id);
    return new ProviderError("UNKNOWN", msg, this.id);
  }
}
