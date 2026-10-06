/**
 * Masks obviously sensitive text before it is sent to an LLM provider (UI labels, log lines).
 * Best effort on text only: it cannot hide anything in a screenshot, and it will miss formats it does not know.
 */
const PATTERNS: [RegExp, string][] = [
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[token]"],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi, "Bearer [token]"],
  [/\b(?:sk|pk|ghp|xox[abp])[-_][A-Za-z0-9_-]{16,}/g, "[key]"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]"],
  [/\b\d(?:[ -]?\d){12,18}\b/g, "[number]"],
  [/\+?\d[\d ()-]{8,}\d/g, "[phone]"],
];

export function redactSensitive(text: string): string {
  let out = text;
  for (const [re, to] of PATTERNS) out = out.replace(re, to);
  return out;
}
