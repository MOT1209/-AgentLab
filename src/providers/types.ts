export const PROVIDER_KINDS = ["anthropic", "openai-compatible", "mock"] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export interface LlmMessage {
  role: "user" | "assistant";
  content: string;
}

export interface LlmRequest {
  system?: string;
  /**
   * Ask the provider to constrain output to this JSON Schema, where it supports that.
   * It is a hint: callers must still validate the result.
   */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  /** Aborts the request. */
  signal?: AbortSignal;
  messages: readonly LlmMessage[];
  maxTokens?: number;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmResponse {
  text: string;
  providerId: string;
  model: string;
  stopReason: string;
  /** True if the provider declined the request for safety reasons. `text` may be empty. */
  refused: boolean;
  usage: LlmUsage;
}

/** What agents see. Nothing about keys, URLs or SDKs. */
export interface LlmProvider {
  readonly id: string;
  readonly kind: ProviderKind;
  readonly model: string;
  complete(req: LlmRequest): Promise<LlmResponse>;
}

export type ProviderErrorCode = "CONFIG" | "AUTH" | "RATE_LIMIT" | "BAD_REQUEST" | "UNAVAILABLE" | "UNKNOWN";

export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    readonly providerId: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/** Auth never carries a secret, only the NAME of the environment variable that holds it. */
export type ProviderAuth = { type: "api_key"; env: string } | { type: "none" };

export interface ProviderConfig {
  id: string;
  kind: ProviderKind;
  model: string;
  auth: ProviderAuth;
  /** Required for openai-compatible. Optional override for anthropic (proxies, gateways). */
  baseUrl?: string;
  maxTokens?: number;
  timeoutMs?: number;
  /**
   * anthropic only. Opt in to server-side refusal fallback (beta). Off by default because it is
   * a beta parameter that has not been exercised against the live API from this repository.
   */
  serverSideFallback?: boolean;
}
