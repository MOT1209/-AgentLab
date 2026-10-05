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

export interface CrashSignal {
  title: string;
  severity: Severity;
  /** Stable key so the same logcat line is only reported once. */
  signature: string;
  excerpt: string;
  /** Crashed process, when the log says so. */
  process?: string;
  exception?: string;
  timestamp?: string;
}

const TS = /^(\d\d-\d\d \d\d:\d\d:\d\d\.\d+)/;
const ownsProcess = (proc: string | undefined, pkg: string | undefined): boolean =>
  !pkg || !proc || proc === pkg || proc.startsWith(`${pkg}:`); // secondary processes look like "pkg:service"

/**
 * Looks for real crash markers. With `packageName`, crashes of OTHER apps in the shared system log are ignored
 * (the main source of false positives). Simple on purpose: this is a detector, not a classifier.
 */
export function detectCrash(logs: string, packageName?: string): CrashSignal | undefined {
  const lines = logs.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const timestamp = TS.exec(line)?.[1];
    const tail = lines.slice(i, i + 12);
    const excerpt = lines.slice(i, i + 4).join("\n").slice(0, 600);
    const base = { signature: line.trim(), excerpt, ...(timestamp ? { timestamp } : {}) };

    if (/FATAL EXCEPTION/.test(line)) {
      const proc = /Process:\s*([\w.:]+),\s*PID/.exec(tail.join("\n"))?.[1];
      if (!ownsProcess(proc, packageName)) continue;
      const exception = tail.slice(1).map((l) => /([\w$.]+(?:Exception|Error))\b/.exec(l)?.[1]).find(Boolean);
      return { title: "Application crash (fatal exception)", severity: "CRITICAL", ...base, ...(proc ? { process: proc } : {}), ...(exception ? { exception } : {}) };
    }
    const anr = /\bANR in ([\w.:]+)/.exec(line);
    if (anr) {
      if (!ownsProcess(anr[1], packageName)) continue;
      return { title: "Application not responding (ANR)", severity: "CRITICAL", ...base, process: anr[1]! };
    }
    if (/Fatal signal \d+/.test(line)) {
      const proc = />>> ([\w.:]+) <<</.exec(tail.join("\n"))?.[1];
      if (!ownsProcess(proc, packageName)) continue;
      return { title: "Native crash (fatal signal)", severity: "CRITICAL", ...base, ...(proc ? { process: proc } : {}) };
    }
    const died = /Process ([\w.:]+) \(pid \d+\) has died/.exec(line);
    if (died) {
      // Only for our own app: system logs say this for every background kill.
      if (!packageName || !ownsProcess(died[1], packageName)) continue;
      return { title: "Application process died (crash or system kill)", severity: "HIGH", ...base, process: died[1]! };
    }
  }
  return undefined;
}

/** Error-level lines only, for the prompt. Keeps unrelated log noise out of the model's context. */
export function relevantLogLines(logs: string, max = 5): string[] {
  return logs
    .split(/\r?\n/)
    .filter((l) => /(^|\s)E[/ ]/.test(l) || /FATAL EXCEPTION|\bANR in\b|Fatal signal \d+/.test(l))
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
