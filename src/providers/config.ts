import { readFileSync } from "node:fs";
import { resolvePreset } from "./presets.js";
import { PROVIDER_KINDS, ProviderConfig, ProviderError } from "./types.js";

const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
const SECRET_LOOKING = /^(sk-|sk_|AIza|ghp_|xox[bap]-|Bearer\s)/i;

/**
 * Fills `baseUrl` from a named preset (see providers/presets.ts) when the config
 * references one and doesn't already set baseUrl itself. Leaves everything else,
 * including validation of the preset id, to validateProviderConfig.
 */
function applyPreset(input: Record<string, unknown>): Record<string, unknown> {
  if (typeof input.preset !== "string") return input;
  const preset = resolvePreset(input.preset);
  if (!preset || input.baseUrl !== undefined) return input;
  return { ...input, baseUrl: preset.baseUrl };
}

/** Returns the problems with a config, or []. Never echoes secret-looking values. */
export function validateProviderConfig(rawInput: unknown): string[] {
  if (typeof rawInput !== "object" || rawInput === null) return ["config must be an object"];
  const c = applyPreset(rawInput as Record<string, unknown>);
  const label = typeof c.id === "string" && c.id ? c.id : "<no id>";
  const p: string[] = [];
  const bad = (m: string) => p.push(`${label}: ${m}`);

  if (typeof c.id !== "string" || !/^[a-z0-9][a-z0-9._-]*$/i.test(c.id)) bad("id must be a simple identifier");
  if (!PROVIDER_KINDS.includes(c.kind as never)) bad(`kind must be one of ${PROVIDER_KINDS.join(", ")}`);
  if (typeof c.model !== "string" || c.model.trim() === "") bad("model is required");
  else if (/^REPLACE/i.test(c.model)) bad("model is still a placeholder");
  if (c.preset !== undefined && !resolvePreset(c.preset as string)) bad(`preset '${c.preset as string}' is not known`);

  const a = c.auth as Record<string, unknown> | undefined;
  if (typeof a !== "object" || a === null) {
    bad("auth is required ({type:'api_key', env:'NAME'} or {type:'none'})");
  } else if (a.type === "api_key") {
    if (typeof a.env !== "string" || !ENV_NAME.test(a.env)) {
      bad("auth.env must be the NAME of an environment variable (e.g. ANTHROPIC_API_KEY), not the key itself");
    } else if (SECRET_LOOKING.test(a.env)) {
      bad("auth.env looks like a secret value; put the key in the environment and name the variable here");
    }
    if ("key" in a || "value" in a || "apiKey" in a) bad("keys must never appear in config; use auth.env");
  } else if (a.type !== "none") {
    bad("auth.type must be 'api_key' or 'none'");
  }

  if (c.kind === "openai-compatible") {
    if (typeof c.baseUrl !== "string" || !/^https?:\/\//.test(c.baseUrl)) bad("openai-compatible requires an http(s) baseUrl");
  } else if (c.baseUrl !== undefined && (typeof c.baseUrl !== "string" || !/^https?:\/\//.test(c.baseUrl))) {
    bad("baseUrl must be an http(s) URL");
  }
  if (c.kind === "anthropic" && a && a.type === "none") bad("anthropic requires an api_key");
  if (c.maxTokens !== undefined && (!Number.isInteger(c.maxTokens) || (c.maxTokens as number) <= 0)) bad("maxTokens must be a positive integer");
  if (c.timeoutMs !== undefined && (!Number.isInteger(c.timeoutMs) || (c.timeoutMs as number) <= 0)) bad("timeoutMs must be a positive integer");
  return p;
}

export function assertProviderConfig(input: unknown): ProviderConfig {
  const problems = validateProviderConfig(input);
  if (problems.length > 0) {
    const id = typeof (input as { id?: unknown })?.id === "string" ? (input as { id: string }).id : "unknown";
    throw new ProviderError("CONFIG", problems.join("; "), id);
  }
  return applyPreset(input as Record<string, unknown>) as unknown as ProviderConfig;
}

export interface ProviderFile {
  providers: ProviderConfig[];
  /** Provider used when an agent has no override. */
  default?: string;
  /** Per-agent overrides: agent id (MAIN-xx or MAIN-xx-y) -> provider id. */
  agents?: Record<string, string>;
}

export function parseProviderFile(json: string): ProviderFile {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new ProviderError("CONFIG", "provider file is not valid JSON", "file");
  }
  const f = raw as Partial<ProviderFile>;
  if (!f || !Array.isArray(f.providers)) throw new ProviderError("CONFIG", "provider file needs a 'providers' array", "file");
  return { providers: f.providers.map(assertProviderConfig), ...(f.default ? { default: f.default } : {}), ...(f.agents ? { agents: f.agents } : {}) };
}

export function loadProviderFile(path: string): ProviderFile {
  return parseProviderFile(readFileSync(path, "utf8"));
}
