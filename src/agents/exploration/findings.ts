import { Severity, SuggestedFinding } from "./actions.js";

/** VERIFIED: produced by the runtime from device evidence. AI_OBSERVATION: the model's claim, unverified. */
export type FindingSource = "VERIFIED" | "AI_OBSERVATION";

export interface Finding {
  id: string;
  severity: Severity;
  title: string;
  description: string;
  evidenceIds: string[];
  detectedAt: string;
  agentId: string;
  step: number;
  source: FindingSource;
}

const CRASH_PATTERNS: Array<{ re: RegExp; title: string }> = [
  { re: /FATAL EXCEPTION/, title: "Application crash (fatal exception)" },
  { re: /\bANR in\b/, title: "Application not responding (ANR)" },
  { re: /Fatal signal \d+/, title: "Native crash (fatal signal)" },
  { re: /Process .* \(pid \d+\) has died/, title: "Application process died" },
];

export interface CrashSignal {
  title: string;
  /** Stable key so the same logcat line is only reported once. */
  signature: string;
  excerpt: string;
}

/** Deliberately simple: looks for obvious crash markers in log text. Not a classifier. */
export function detectCrash(logs: string): CrashSignal | undefined {
  const lines = logs.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    for (const p of CRASH_PATTERNS) {
      if (p.re.test(line)) {
        return { title: p.title, signature: line.trim(), excerpt: lines.slice(i, i + 4).join("\n").slice(0, 600) };
      }
    }
  }
  return undefined;
}

/** Error-level lines only, for the prompt. Keeps unrelated log noise out of the model's context. */
export function relevantLogLines(logs: string, max = 5): string[] {
  return logs
    .split(/\r?\n/)
    .filter((l) => /(^|\s)E[/ ]/.test(l) || CRASH_PATTERNS.some((p) => p.re.test(l)))
    .slice(-max)
    .map((l) => l.slice(0, 200));
}

/** Only VERIFIED findings of MEDIUM or worse count as a failure; AI observations never do. */
export function hasVerifiedFailure(findings: readonly Finding[]): boolean {
  return findings.some((f) => f.source === "VERIFIED" && (f.severity === "CRITICAL" || f.severity === "HIGH" || f.severity === "MEDIUM"));
}

export class FindingLog {
  private readonly list: Finding[] = [];
  private readonly seen = new Set<string>();

  constructor(
    private readonly agentId: string,
    private readonly now: () => number = Date.now,
  ) {}

  private nextId(): string {
    return `F-${String(this.list.length + 1).padStart(3, "0")}`;
  }

  addVerified(sig: string, severity: Severity, title: string, description: string, evidenceIds: string[], step: number): Finding | undefined {
    if (this.seen.has(sig)) return undefined;
    this.seen.add(sig);
    return this.push({ severity, title, description, evidenceIds, step, source: "VERIFIED" });
  }

  addObservation(s: SuggestedFinding, evidenceIds: string[], step: number): Finding {
    return this.push({ ...s, evidenceIds, step, source: "AI_OBSERVATION" });
  }

  private push(f: Omit<Finding, "id" | "detectedAt" | "agentId">): Finding {
    const finding: Finding = { id: this.nextId(), detectedAt: new Date(this.now()).toISOString(), agentId: this.agentId, ...f };
    this.list.push(finding);
    return finding;
  }

  all(): Finding[] {
    return [...this.list];
  }
  hasVerifiedFailure(): boolean {
    return hasVerifiedFailure(this.list);
  }
}
