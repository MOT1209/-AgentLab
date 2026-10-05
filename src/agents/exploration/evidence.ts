import type { Evidence, EvidenceKind } from "../types.js";

export interface EvidenceLimits {
  maxItems: number;
  maxScreenshots: number;
}

/** In-memory evidence with stable ids (EV-001...). Binary data stays here; prompts only carry the ids. */
export class EvidenceStore {
  private readonly items: Evidence[] = [];
  private screenshots = 0;
  /** Called for every stored item. Used for live UIs; must not throw. */
  onAdd?: (ev: Evidence) => void;

  constructor(
    private readonly source: string,
    private readonly limits: EvidenceLimits = { maxItems: 500, maxScreenshots: 40 },
    private readonly now: () => number = Date.now,
  ) {}

  canAddScreenshot(): boolean {
    return this.screenshots < this.limits.maxScreenshots && this.items.length < this.limits.maxItems;
  }

  /** Returns undefined when a limit is reached; evidence is best-effort, never a reason to fail a run. */
  add(kind: EvidenceKind, data: string, step: number): Evidence | undefined {
    if (this.items.length >= this.limits.maxItems) return undefined;
    if (kind === "screenshot") {
      if (this.screenshots >= this.limits.maxScreenshots) return undefined;
      this.screenshots++;
    }
    const ev: Evidence = {
      id: `EV-${String(this.items.length + 1).padStart(3, "0")}`,
      kind,
      step,
      at: new Date(this.now()).toISOString(),
      data,
      source: this.source,
    };
    this.items.push(ev);
    try {
      this.onAdd?.(ev);
    } catch {
      /* a listener must never break a run */
    }
    return ev;
  }

  get(id: string): Evidence | undefined {
    return this.items.find((e) => e.id === id);
  }
  list(): Evidence[] {
    return [...this.items];
  }
}
