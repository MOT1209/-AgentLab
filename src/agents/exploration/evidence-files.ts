import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Evidence } from "../types.js";

const MAX_FILE_BYTES = 5 * 1024 * 1024;

/**
 * Persists evidence under `<dir>/<taskId>/EV-001.png|txt|json`. File names are generated here, never taken from
 * model output, so nothing the LLM says can choose a path. Best-effort: returns undefined instead of throwing.
 */
export function createFileEvidenceWriter(dir: string, taskId: string): (ev: Evidence) => string | undefined {
  const runDir = join(dir, taskId.replace(/[^A-Za-z0-9_-]/g, "_"));
  let ready = false;
  return (ev) => {
    try {
      if (!ev.id) return undefined;
      if (!ready) {
        mkdirSync(runDir, { recursive: true, mode: 0o700 });
        ready = true;
      }
      const isImage = ev.kind === "screenshot";
      const ext = isImage ? "png" : ev.kind === "ui_state" || ev.kind === "performance" ? "json" : "txt";
      const body = isImage ? Buffer.from(ev.data, "base64") : Buffer.from(ev.data, "utf8");
      if (body.length > MAX_FILE_BYTES) return undefined;
      const path = join(runDir, `${ev.id}.${ext}`);
      writeFileSync(path, body, { mode: 0o600 });
      return path;
    } catch {
      return undefined;
    }
  };
}

/** Writes the final result next to the evidence. Screenshot bytes are replaced by their file path. */
export function writeResultFile(dir: string, taskId: string, result: { evidence: Evidence[] } & Record<string, unknown>): string | undefined {
  try {
    const runDir = join(dir, taskId.replace(/[^A-Za-z0-9_-]/g, "_"));
    mkdirSync(runDir, { recursive: true, mode: 0o700 });
    const slim = { ...result, evidence: result.evidence.map((e) => (e.kind === "screenshot" ? { ...e, data: e.path ?? "(not persisted)" } : e)) };
    const path = join(runDir, "result.json");
    writeFileSync(path, JSON.stringify(slim, null, 2), { mode: 0o600 });
    chmodSync(path, 0o600);
    return path;
  } catch {
    return undefined;
  }
}
