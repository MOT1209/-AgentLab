import { ProviderKind } from "./types.js";

/**
 * Named shortcuts for common `openai-compatible` endpoints. A preset only fills in
 * `baseUrl` (and documents the conventional env var name); `id`, `model` and `auth`
 * are always supplied by the caller, same as any other provider config.
 */
export interface ProviderPreset {
  id: string;
  label: string;
  kind: ProviderKind;
  baseUrl: string;
  /** Conventional env var name for this service; a suggestion only, not enforced. */
  defaultEnv: string;
  requiresKey: boolean;
  exampleModel: string;
  docsUrl?: string;
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: "openai",
    label: "OpenAI",
    kind: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    defaultEnv: "OPENAI_API_KEY",
    requiresKey: true,
    exampleModel: "gpt-5",
    docsUrl: "https://platform.openai.com/docs",
  },
  {
    id: "groq",
    label: "Groq",
    kind: "openai-compatible",
    baseUrl: "https://api.groq.com/openai/v1",
    defaultEnv: "GROQ_API_KEY",
    requiresKey: true,
    exampleModel: "llama-3.3-70b-versatile",
    docsUrl: "https://console.groq.com/docs",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    kind: "openai-compatible",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultEnv: "OPENROUTER_API_KEY",
    requiresKey: true,
    exampleModel: "openrouter/auto",
    docsUrl: "https://openrouter.ai/docs",
  },
  {
    id: "together",
    label: "Together AI",
    kind: "openai-compatible",
    baseUrl: "https://api.together.xyz/v1",
    defaultEnv: "TOGETHER_API_KEY",
    requiresKey: true,
    exampleModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    docsUrl: "https://docs.together.ai",
  },
  {
    id: "fireworks",
    label: "Fireworks AI",
    kind: "openai-compatible",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    defaultEnv: "FIREWORKS_API_KEY",
    requiresKey: true,
    exampleModel: "accounts/fireworks/models/llama-v3p3-70b-instruct",
    docsUrl: "https://docs.fireworks.ai",
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    kind: "openai-compatible",
    baseUrl: "http://localhost:11434/v1",
    defaultEnv: "",
    requiresKey: false,
    exampleModel: "llama3.1",
    docsUrl: "https://github.com/ollama/ollama/blob/main/docs/openai.md",
  },
] as const;

export function resolvePreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === id);
}
