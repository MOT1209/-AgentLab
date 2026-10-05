import { createDefaultSkillSystem } from "./profiles.js";
import { applySync, planSync, validateFiles } from "./sync.js";

const USAGE = `usage: node dist/src/skills/cli.js <command> [options]
  list [--agents]   show skills (and, with --agents, every agent's profile)
  validate          check catalog, profiles, generated files and safety scans (exit 1 on problems)
  sync [--check] [--prune]   write the .claude and .agent SKILL.md files; --check only reports (exit 1 if out of date)
options: --root <dir> (default: current directory)`;

function main(argv: readonly string[]): number {
  const [cmd, ...rest] = argv;
  const rootIdx = rest.indexOf("--root");
  const root = rootIdx >= 0 && rest[rootIdx + 1] ? rest[rootIdx + 1]! : process.cwd();
  const flag = (f: string) => rest.includes(f);
  let system;
  try {
    system = createDefaultSkillSystem();
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
  const { registry, profiles } = system;

  if (cmd === "list") {
    for (const s of registry.list()) {
      const where = s.manual ? "manual" : s.environmentSupport;
      console.log(`${s.status === "implemented" ? "[x]" : "[ ]"} ${s.id.padEnd(26)} ${s.category.padEnd(13)} ${s.securityLevel.padEnd(6)} ${where.padEnd(7)} perms: ${s.permissions.join(",") || "-"}`);
    }
    if (flag("--agents")) {
      console.log("");
      for (const p of profiles.list()) console.log(`${p.agentId.padEnd(10)} skills: ${p.skills.join(",")} | planned: ${p.plannedSkills.join(",") || "-"} | perms: ${p.permissions.join(",") || "-"}`);
    }
    return 0;
  }

  if (cmd === "validate") {
    const problems = validateFiles(registry, root);
    if (problems.length === 0) {
      console.log(`ok: ${registry.list().length} skills, ${profiles.list().length} agent profiles, files in sync`);
      return 0;
    }
    for (const p of problems) console.error(`- ${p}`);
    return 1;
  }

  if (cmd === "sync") {
    const plan = planSync(registry, root);
    const stale = plan.entries.filter((e) => e.status !== "ok");
    if (flag("--check")) {
      for (const e of stale) console.error(`- ${e.path}: ${e.status}`);
      for (const o of plan.orphans) console.error(`- ${o}: orphan`);
      if (stale.length === 0 && plan.orphans.length === 0) console.log("ok: skill files are in sync");
      return stale.length === 0 && plan.orphans.length === 0 ? 0 : 1;
    }
    const { written, pruned } = applySync(plan, { prune: flag("--prune") });
    console.log(`wrote ${written.length} file(s), pruned ${pruned.length}, unchanged ${plan.entries.length - written.length}`);
    for (const w of written) console.log(`  + ${w}`);
    if (plan.orphans.length > pruned.length) console.log(`note: ${plan.orphans.length - pruned.length} orphan(s) kept; pass --prune to remove generated ones`);
    return 0;
  }

  console.error(USAGE);
  return cmd ? 1 : 0;
}

process.exitCode = main(process.argv.slice(2));
