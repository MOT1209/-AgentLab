/** Resolves a secret by environment-variable name. Swap for a vault in production. */
export interface SecretResolver {
  get(name: string): string | undefined;
}

export const envSecrets: SecretResolver = { get: (name) => process.env[name] };

/** Replaces every occurrence of the given secrets in text. For logs and error messages. */
export function redact(text: string, secrets: readonly (string | undefined)[]): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 8) out = out.split(s).join("[REDACTED]");
  return out;
}
