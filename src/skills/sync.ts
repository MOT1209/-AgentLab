import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { GENERATED_MARKER, SKILL_TARGETS, checkGeneratedHash, parseSkillFile, renderSkill, targetsFor, type SkillTarget } from "./render.js";
import type { SkillRegistry } from "./registry.js";

export type FileStatus = "ok" | "missing" | "drift";

export interface SyncEntry {
  readonly target: SkillTarget;
  readonly skillId: string;
  readonly path: string;
  readonly expected: string;
  readonly status: FileStatus;
}

export interface SyncPlan {
  readonly entries: readonly SyncEntry[];
  /** Generated-looking skill directories that no longer correspond to a catalog skill. */
  readonly orphans: readonly string[];
}

const skillsDir = (root: string, target: SkillTarget) => join(root, SKILL_TARGETS[target]);

function read(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

export function planSync(registry: SkillRegistry, root: string): SyncPlan {
  const entries: SyncEntry[] = [];
  const wanted: Record<SkillTarget, Set<string>> = { claude: new Set(), agent: new Set() };
  for (const skill of registry.list()) {
    for (const target of targetsFor(skill)) {
      const path = join(skillsDir(root, target), skill.id, "SKILL.md");
      const expected = renderSkill(skill, target);
      const actual = read(path);
      wanted[target].add(skill.id);
      entries.push({ target, skillId: skill.id, path, expected, status: actual === undefined ? "missing" : actual === expected ? "ok" : "drift" });
    }
  }
  const orphans: string[] = [];
  for (const target of Object.keys(SKILL_TARGETS) as SkillTarget[]) {
    const dir = skillsDir(root, target);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const file = join(dir, name, "SKILL.md");
      const text = read(file);
      if (text !== undefined && text.includes(GENERATED_MARKER) && !wanted[target].has(name)) orphans.push(join(dir, name));
    }
  }
  return { entries, orphans };
}

/** Writes missing/drifted files. Orphans are removed only with `prune` and only if they carry the generated marker. */
export function applySync(plan: SyncPlan, opts: { prune?: boolean } = {}): { written: string[]; pruned: string[] } {
  const written: string[] = [];
  for (const e of plan.entries) {
    if (e.status === "ok") continue;
    mkdirSync(join(e.path, ".."), { recursive: true });
    writeFileSync(e.path, e.expected, "utf8");
    written.push(e.path);
  }
  const pruned: string[] = [];
  if (opts.prune) {
    for (const dir of plan.orphans) {
      rmSync(dir, { recursive: true, force: true });
      pruned.push(dir);
    }
  }
  return { written, pruned };
}

const DANGEROUS: ReadonlyArray<[RegExp, string]> = [
  [/\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/i, "pipes a download into a shell"],
  [/\brm\s+-rf?\s+(\/|~|\$HOME)(\s|$)/i, "recursive delete of a root or home path"],
  [/\bchmod\s+(-R\s+)?7[0-7][0-7]\b/i, "world-writable chmod"],
  [/\bsudo\b/i, "uses sudo"],
  [/\/dev\/tcp\//i, "opens a raw network socket"],
  [/\bnc\s+-e\b/i, "netcat with a command (reverse shell)"],
  [/\bInvoke-Expression\b|\biex\s*\(/i, "PowerShell Invoke-Expression"],
  [/\bpowershell(\.exe)?\s+-e(nc|ncodedcommand)\b/i, "PowerShell encoded command"],
  [/\bbase64\s+(-d|--decode)\b[^\n]*\|\s*(sh|bash)\b/i, "decodes and runs a payload"],
];
const SECRETS: ReadonlyArray<[RegExp, string]> = [
  [/\bsk-[A-Za-z0-9_-]{16,}/, "looks like an API key (sk-)"],
  [/\bAIza[0-9A-Za-z_-]{20,}/, "looks like a Google API key"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/, "looks like a GitHub token"],
  [/\bxox[bap]-[A-Za-z0-9-]{10,}/, "looks like a Slack token"],
  [/-----BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY-----/, "contains a private key"],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{20,}/, "contains a bearer token"],
];

/** Text-level safety scan of one skill file. */
export function scanText(text: string): string[] {
  const found: string[] = [];
  for (const [re, why] of DANGEROUS) if (re.test(text)) found.push(why);
  for (const [re, why] of SECRETS) if (re.test(text)) found.push(why);
  return found;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

/** Checks the files on disk against the catalog. Empty array = in sync and safe. */
export function validateFiles(registry: SkillRegistry, root: string): string[] {
  const p: string[] = [];
  const plan = planSync(registry, root);
  for (const e of plan.entries) {
    const rel = relative(root, e.path);
    if (e.status === "missing") p.push(`${rel}: missing (run npm run skills:sync)`);
    else if (e.status === "drift") {
      const actual = read(e.path) ?? "";
      p.push(`${rel}: ${checkGeneratedHash(actual) === "tampered" ? "edited by hand" : "out of date"} (run npm run skills:sync)`);
    }
  }
  for (const o of plan.orphans) p.push(`${relative(root, o)}: generated skill no longer in the catalog (run npm run skills:sync -- --prune)`);

  for (const skill of registry.list()) {
    if (!skill.manual) continue;
    for (const target of skill.environmentSupport === "both" ? (["claude", "agent"] as const) : [skill.environmentSupport]) {
      const path = join(skillsDir(root, target), skill.id, "SKILL.md");
      const text = read(path);
      if (text === undefined) {
        p.push(`${relative(root, path)}: manual skill file is missing`);
        continue;
      }
      const parsed = parseSkillFile(text);
      if (parsed.name !== skill.id) p.push(`${relative(root, path)}: frontmatter name "${parsed.name ?? ""}" must be ${skill.id}`);
      if (parsed.description !== skill.description) p.push(`${relative(root, path)}: frontmatter description differs from the catalog`);
    }
  }

  // .claude and .agent copies of one skill must agree on metadata.
  for (const skill of registry.list()) {
    const metas = (["claude", "agent"] as const).map((t) => {
      const text = read(join(skillsDir(root, t), skill.id, "SKILL.md"));
      return text === undefined ? undefined : parseSkillFile(text);
    });
    const [a, b] = metas;
    if (a && b && (a.name !== b.name || a.description !== b.description)) p.push(`${skill.id}: .claude and .agent metadata differ`);
  }

  // Everything under the skills directories is scanned; executable content is not allowed at all.
  for (const target of Object.keys(SKILL_TARGETS) as SkillTarget[]) {
    const dir = skillsDir(root, target);
    if (!existsSync(dir)) continue;
    for (const file of walk(dir)) {
      const rel = relative(root, file);
      if (!file.endsWith(".md")) {
        p.push(`${rel}: only Markdown is allowed in skill directories (scripts are not audited)`);
        continue;
      }
      const text = read(file) ?? "";
      for (const why of scanText(text)) p.push(`${rel}: ${why}`);
    }
  }
  return [...new Set(p)];
}
