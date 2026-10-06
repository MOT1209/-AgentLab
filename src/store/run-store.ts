import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** What is kept about one finished run. `result` / `smoke` are JSON-safe, with large evidence already trimmed. */
export interface StoredRun {
  id: string;
  startedAt: string;
  finishedAt?: string;
  mode: "demo" | "real";
  test: "explore" | "smoke";
  packageName: string;
  /** Exploration status or task status for smoke. */
  status: string;
  summary: string;
  costUsd?: number;
  inputTokens: number;
  outputTokens: number;
  params: Record<string, unknown>;
  result?: unknown;
  smoke?: { status: string; summary: string };
}

export type RunSummary = Pick<StoredRun, "id" | "startedAt" | "finishedAt" | "test" | "packageName" | "status" | "summary" | "costUsd">;

/**
 * SQLite history of runs and their screenshots (node:sqlite, so no dependency; Node marks it experimental).
 * The file holds UI text and screenshots of the app under test: it is created owner-only (0600) inside an owner-only folder.
 */
export class RunStore {
  private readonly db: DatabaseSync;

  constructor(readonly path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") {
      try {
        chmodSync(path, 0o600);
      } catch {
        /* e.g. Windows */
      }
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT, mode TEXT NOT NULL, test TEXT NOT NULL,
        package TEXT NOT NULL, status TEXT NOT NULL, summary TEXT NOT NULL, cost_usd REAL,
        input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, params TEXT NOT NULL, result TEXT, smoke TEXT
      );
      CREATE TABLE IF NOT EXISTS shots (
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, ev_id TEXT NOT NULL, png BLOB NOT NULL,
        PRIMARY KEY (run_id, ev_id)
      );
    `);
    this.db.exec("PRAGMA foreign_keys = ON");
  }

  save(run: StoredRun, screenshots: ReadonlyMap<string, Buffer>): void {
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO runs (id, started_at, finished_at, mode, test, package, status, summary, cost_usd, input_tokens, output_tokens, params, result, smoke)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(run.id, run.startedAt, run.finishedAt ?? null, run.mode, run.test, run.packageName, run.status, run.summary, run.costUsd ?? null, run.inputTokens, run.outputTokens, JSON.stringify(run.params), run.result === undefined ? null : JSON.stringify(run.result), run.smoke ? JSON.stringify(run.smoke) : null);
      this.db.prepare("DELETE FROM shots WHERE run_id = ?").run(run.id);
      const ins = this.db.prepare("INSERT INTO shots (run_id, ev_id, png) VALUES (?, ?, ?)");
      for (const [id, png] of screenshots) ins.run(run.id, id, png);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  list(limit = 20): RunSummary[] {
    const rows = this.db.prepare("SELECT id, started_at, finished_at, test, package, status, summary, cost_usd FROM runs ORDER BY started_at DESC, rowid DESC LIMIT ?").all(Math.max(1, Math.min(limit, 200))) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as string,
      startedAt: r.started_at as string,
      ...(r.finished_at ? { finishedAt: r.finished_at as string } : {}),
      test: r.test as "explore" | "smoke",
      packageName: r.package as string,
      status: r.status as string,
      summary: (r.summary as string).slice(0, 200),
      ...(r.cost_usd !== null ? { costUsd: r.cost_usd as number } : {}),
    }));
  }

  get(id: string): StoredRun | undefined {
    const r = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    return {
      id: r.id as string,
      startedAt: r.started_at as string,
      ...(r.finished_at ? { finishedAt: r.finished_at as string } : {}),
      mode: r.mode as "demo" | "real",
      test: r.test as "explore" | "smoke",
      packageName: r.package as string,
      status: r.status as string,
      summary: r.summary as string,
      ...(r.cost_usd !== null ? { costUsd: r.cost_usd as number } : {}),
      inputTokens: r.input_tokens as number,
      outputTokens: r.output_tokens as number,
      params: JSON.parse(r.params as string),
      ...(r.result ? { result: JSON.parse(r.result as string) } : {}),
      ...(r.smoke ? { smoke: JSON.parse(r.smoke as string) } : {}),
    };
  }

  screenshots(runId: string): Map<string, Buffer> {
    const rows = this.db.prepare("SELECT ev_id, png FROM shots WHERE run_id = ? ORDER BY ev_id").all(runId) as Array<{ ev_id: string; png: Uint8Array }>;
    return new Map(rows.map((r) => [r.ev_id, Buffer.from(r.png)]));
  }

  screenshot(runId: string, evId: string): Buffer | undefined {
    const r = this.db.prepare("SELECT png FROM shots WHERE run_id = ? AND ev_id = ?").get(runId, evId) as { png: Uint8Array } | undefined;
    return r ? Buffer.from(r.png) : undefined;
  }

  close(): void {
    this.db.close();
  }
}
