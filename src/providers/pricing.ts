/**
 * Money cost of a run. There is deliberately NO built-in price table: prices change and differ per
 * provider and plan, so the caller states them (USD per million tokens) and owns their accuracy.
 */
export interface Pricing {
  inputPerMTok: number;
  outputPerMTok: number;
}

export function costUsd(usage: { inputTokens: number; outputTokens: number }, pricing: Pricing): number {
  return (usage.inputTokens * pricing.inputPerMTok + usage.outputTokens * pricing.outputPerMTok) / 1_000_000;
}

export function parsePricing(v: unknown): Pricing | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const { inputPerMTok, outputPerMTok } = v as Record<string, unknown>;
  const ok = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 100_000;
  return ok(inputPerMTok) && ok(outputPerMTok) ? { inputPerMTok, outputPerMTok } : undefined;
}
