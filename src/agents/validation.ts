import { isCapability } from "./capabilities.js";
import { AGENT_KINDS, AgentDefinition, AgentValidationError } from "./definitions.js";

const MAIN_ID = /^MAIN-(0[1-9]|1[0-2])$/;
const SUB_ID = /^(MAIN-(?:0[1-9]|1[0-2]))-([A-Z])$/;

export const EXPECTED_MAIN_AGENTS = 12;
export const EXPECTED_SUB_AGENTS = 24;

export function assertValid(problems: readonly string[], context: string): void {
  if (problems.length > 0) throw new AgentValidationError(problems, context);
}

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

/** Structural validation of a single definition. Accepts unknown so bad input is caught at runtime too. */
export function validateDefinition(input: unknown): string[] {
  if (typeof input !== "object" || input === null) return ["definition must be an object"];
  const d = input as Record<string, unknown>;
  const label = typeof d.id === "string" ? d.id : "<no id>";
  const p: string[] = [];
  const bad = (msg: string) => p.push(`${label}: ${msg}`);

  if (!nonEmpty(d.id)) bad("id must be a non-empty string");
  if (!AGENT_KINDS.includes(d.kind as never)) bad(`invalid kind '${String(d.kind)}'`);
  for (const f of ["name", "role", "description"] as const) if (!nonEmpty(d[f])) bad(`${f} must be a non-empty string`);

  if (!Array.isArray(d.capabilities)) {
    bad("capabilities must be an array");
  } else {
    const seen = new Set<string>();
    for (const c of d.capabilities) {
      if (!isCapability(c)) bad(`unknown capability '${String(c)}'`);
      else if (seen.has(c)) bad(`duplicate capability '${c}'`);
      else seen.add(c);
    }
  }
  if (typeof d.metadata !== "object" || d.metadata === null || Array.isArray(d.metadata)) bad("metadata must be an object");

  if (typeof d.id === "string") {
    if (d.kind === "MAIN") {
      if (d.parentId !== undefined) bad("a MAIN agent must not have a parent");
      if (!MAIN_ID.test(d.id)) bad("MAIN id must match MAIN-NN (01-12)");
    } else if (d.kind === "SUB") {
      if (!nonEmpty(d.parentId)) bad("a SUB agent requires a parentId");
      const m = SUB_ID.exec(d.id);
      if (!m) bad("SUB id must match MAIN-NN-X");
      else if (m[1] !== d.parentId) bad(`SUB id prefix '${m[1]}' does not match parentId '${String(d.parentId)}'`);
    }
  }
  return p;
}

/** Validates a full organization against the canonical 12 + 24 rule. */
export function validateOrganization(defs: readonly AgentDefinition[]): string[] {
  const p: string[] = [];
  for (const d of defs) p.push(...validateDefinition(d));

  const ids = new Set<string>();
  const names = new Set<string>();
  for (const d of defs) {
    if (ids.has(d.id)) p.push(`duplicate id: ${d.id}`);
    ids.add(d.id);
    const key = d.name.trim().toLowerCase();
    if (names.has(key)) p.push(`duplicate name: ${d.name}`);
    names.add(key);
  }

  const mains = defs.filter((d) => d.kind === "MAIN");
  const subs = defs.filter((d) => d.kind === "SUB");
  if (mains.length !== EXPECTED_MAIN_AGENTS) p.push(`expected ${EXPECTED_MAIN_AGENTS} MAIN agents, found ${mains.length}`);
  if (subs.length !== EXPECTED_SUB_AGENTS) p.push(`expected ${EXPECTED_SUB_AGENTS} SUB agents, found ${subs.length}`);

  const mainIds = new Set(mains.map((m) => m.id));
  for (let n = 1; n <= EXPECTED_MAIN_AGENTS; n++) {
    const id = `MAIN-${String(n).padStart(2, "0")}`;
    if (!mainIds.has(id)) p.push(`missing ${id}`);
  }
  for (const s of subs) if (!s.parentId || !mainIds.has(s.parentId)) p.push(`${s.id}: parent '${String(s.parentId)}' is not a MAIN agent in this organization`);
  for (const m of mains) {
    const letters = subs.filter((s) => s.parentId === m.id).map((s) => s.id.slice(m.id.length + 1)).sort();
    if (letters.join(",") !== "A,B") p.push(`${m.id}: expected sub-agents A,B but found [${letters.join(",")}]`);
  }
  return p;
}
