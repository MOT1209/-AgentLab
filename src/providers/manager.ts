import { AnthropicProvider } from "./anthropic-provider.js";
import { assertProviderConfig, ProviderFile } from "./config.js";
import { MockProvider } from "./mock-provider.js";
import { OpenAICompatibleProvider } from "./openai-compatible-provider.js";
import { envSecrets, SecretResolver } from "./secrets.js";
import { LlmProvider, LlmRequest, LlmResponse, ProviderConfig, ProviderError, ProviderKind } from "./types.js";

export type ProviderBuilder = (config: ProviderConfig, secret: string | undefined) => LlmProvider;

const DEFAULT_BUILDERS: Record<ProviderKind, ProviderBuilder> = {
  anthropic: (c, secret) => new AnthropicProvider(c, secret as string),
  "openai-compatible": (c, secret) => new OpenAICompatibleProvider(c, secret),
  mock: (c) => new MockProvider(c.id, c.model),
};

export interface ProviderStatus {
  id: string;
  kind: ProviderKind;
  model: string;
  baseUrl?: string;
  /** Name of the env var, never its value. */
  keyEnv?: string;
  /** Whether that env var is currently set. */
  keyPresent: boolean;
  isDefault: boolean;
}

/** Registry of configured providers plus agent -> provider routing. */
export class ProviderManager {
  private readonly providers = new Map<string, LlmProvider>();
  private readonly configs = new Map<string, ProviderConfig>();
  private readonly agentOverrides = new Map<string, string>();
  private defaultId?: string;

  constructor(
    private readonly secrets: SecretResolver = envSecrets,
    private readonly builders: Record<ProviderKind, ProviderBuilder> = DEFAULT_BUILDERS,
  ) {}

  static fromFile(file: ProviderFile, secrets?: SecretResolver, builders?: Record<ProviderKind, ProviderBuilder>): ProviderManager {
    const m = new ProviderManager(secrets, builders);
    for (const c of file.providers) m.add(c);
    if (file.default) m.setDefault(file.default);
    for (const [agent, provider] of Object.entries(file.agents ?? {})) m.setAgentProvider(agent, provider);
    return m;
  }

  /** Validates, resolves the secret from the environment and builds the provider. Fails closed if the key is missing. */
  add(config: unknown): LlmProvider {
    const c = assertProviderConfig(config);
    if (this.providers.has(c.id)) throw new ProviderError("CONFIG", `duplicate provider id: ${c.id}`, c.id);
    let secret: string | undefined;
    if (c.auth.type === "api_key") {
      secret = this.secrets.get(c.auth.env);
      if (!secret) throw new ProviderError("CONFIG", `environment variable ${c.auth.env} is not set`, c.id);
    }
    const provider = this.builders[c.kind](c, secret);
    this.providers.set(c.id, provider);
    this.configs.set(c.id, c);
    this.defaultId ??= c.id;
    return provider;
  }

  /** Adds a prebuilt provider (tests, custom adapters). */
  register(provider: LlmProvider): void {
    if (this.providers.has(provider.id)) throw new ProviderError("CONFIG", `duplicate provider id: ${provider.id}`, provider.id);
    this.providers.set(provider.id, provider);
    this.defaultId ??= provider.id;
  }

  remove(id: string): boolean {
    if (!this.providers.delete(id)) return false;
    this.configs.delete(id);
    for (const [agent, p] of this.agentOverrides) if (p === id) this.agentOverrides.delete(agent);
    if (this.defaultId === id) this.defaultId = this.providers.keys().next().value;
    return true;
  }

  get(id: string): LlmProvider | undefined {
    return this.providers.get(id);
  }
  list(): LlmProvider[] {
    return [...this.providers.values()];
  }

  setDefault(id: string): void {
    if (!this.providers.has(id)) throw new ProviderError("CONFIG", `unknown provider: ${id}`, id);
    this.defaultId = id;
  }
  setAgentProvider(agentId: string, providerId: string): void {
    if (!this.providers.has(providerId)) throw new ProviderError("CONFIG", `unknown provider: ${providerId}`, providerId);
    this.agentOverrides.set(agentId, providerId);
  }
  clearAgentProvider(agentId: string): boolean {
    return this.agentOverrides.delete(agentId);
  }

  /** Agent override, else the first of `fallbackAgentIds` with one (e.g. its MAIN parent), else the default. */
  forAgent(agentId: string, ...fallbackAgentIds: string[]): LlmProvider | undefined {
    for (const a of [agentId, ...fallbackAgentIds]) {
      const id = this.agentOverrides.get(a);
      if (id) return this.providers.get(id);
    }
    return this.defaultId ? this.providers.get(this.defaultId) : undefined;
  }

  /** Safe to print or send to a UI: no secret values. */
  describe(): ProviderStatus[] {
    return [...this.providers.values()].map((p) => {
      const c = this.configs.get(p.id);
      const s: ProviderStatus = {
        id: p.id,
        kind: p.kind,
        model: p.model,
        keyPresent: c?.auth.type === "api_key" ? !!this.secrets.get(c.auth.env) : false,
        isDefault: p.id === this.defaultId,
      };
      if (c?.baseUrl) s.baseUrl = c.baseUrl;
      if (c?.auth.type === "api_key") s.keyEnv = c.auth.env;
      return s;
    });
  }

  /** Explicit connectivity test. Makes one tiny real request, which may cost a few tokens. */
  async test(id: string): Promise<{ ok: true; model: string } | { ok: false; code: string; message: string }> {
    const p = this.providers.get(id);
    if (!p) return { ok: false, code: "CONFIG", message: `unknown provider: ${id}` };
    try {
      const r: LlmResponse = await p.complete({ messages: [{ role: "user", content: "Reply with OK." }], maxTokens: 16 });
      return { ok: true, model: r.model };
    } catch (e) {
      return e instanceof ProviderError ? { ok: false, code: e.code, message: e.message } : { ok: false, code: "UNKNOWN", message: String(e) };
    }
  }
}

export type { LlmRequest };
