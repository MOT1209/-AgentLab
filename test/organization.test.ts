import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CANONICAL_DEFINITIONS, organizationTree } from "../src/agents/organization.js";
import { validateOrganization, validateDefinition } from "../src/agents/validation.js";
import { isCapability } from "../src/agents/capabilities.js";
import type { AgentDefinition } from "../src/agents/definitions.js";

test("canonical organization is exactly 12 MAIN + 24 SUB and valid", () => {
  assert.deepEqual(validateOrganization(CANONICAL_DEFINITIONS), []);
  assert.equal(CANONICAL_DEFINITIONS.filter((d) => d.kind === "MAIN").length, 12);
  assert.equal(CANONICAL_DEFINITIONS.filter((d) => d.kind === "SUB").length, 24);
  assert.equal(new Set(CANONICAL_DEFINITIONS.map((d) => d.id)).size, 36);
});

test("tree: every MAIN has subs A and B with matching parent", () => {
  const tree = organizationTree();
  assert.equal(tree.length, 12);
  for (const n of tree) {
    assert.deepEqual(n.subs.map((s) => s.id), [`${n.main.id}-A`, `${n.main.id}-B`]);
    assert.ok(n.subs.every((s) => s.parentId === n.main.id));
  }
});

test("capabilities are known and a MAIN's are the union of its subs'", () => {
  for (const n of organizationTree()) {
    const union = new Set(n.subs.flatMap((s) => s.capabilities));
    assert.deepEqual(new Set(n.main.capabilities), union);
    for (const c of [...n.main.capabilities, ...n.subs.flatMap((s) => s.capabilities)]) assert.ok(isCapability(c));
  }
});

test("definitions are frozen", () => {
  assert.throws(() => {
    (CANONICAL_DEFINITIONS[0] as { name: string }).name = "x";
  }, TypeError);
});

test("knowledge/agents.md lists every canonical id and name", () => {
  const md = readFileSync(new URL("../../.claude/skills/ai-testing-lab/knowledge/agents.md", import.meta.url), "utf8");
  for (const d of CANONICAL_DEFINITIONS) {
    assert.ok(md.includes(d.id), `missing id ${d.id}`);
    assert.ok(md.includes(d.name), `missing name ${d.name}`);
  }
});

test("validateOrganization detects missing, extra and duplicate agents", () => {
  const missing = CANONICAL_DEFINITIONS.filter((d) => d.id !== "MAIN-05-B");
  assert.ok(validateOrganization(missing).some((p) => p.includes("expected 24 SUB")));

  const extra: AgentDefinition = { ...CANONICAL_DEFINITIONS[1]!, id: "MAIN-01-C", name: "Extra" };
  const withExtra = [...CANONICAL_DEFINITIONS, extra];
  assert.ok(validateOrganization(withExtra).some((p) => p.includes("expected 24 SUB")));
  assert.ok(validateOrganization(withExtra).some((p) => p.includes("expected sub-agents A,B")));

  const dup = [...CANONICAL_DEFINITIONS, CANONICAL_DEFINITIONS[0]!];
  assert.ok(validateOrganization(dup).some((p) => p.includes("duplicate id")));
});

test("validateDefinition rejects malformed definitions", () => {
  const good = CANONICAL_DEFINITIONS[1]!; // MAIN-01-A
  const cases: Array<[string, unknown, string]> = [
    ["not an object", null, "must be an object"],
    ["bad kind", { ...good, kind: "BOSS" }, "invalid kind"],
    ["main with parent", { ...CANONICAL_DEFINITIONS[0], parentId: "MAIN-02" }, "must not have a parent"],
    ["sub without parent", { ...good, parentId: undefined }, "requires a parentId"],
    ["sub prefix mismatch", { ...good, parentId: "MAIN-02" }, "does not match parentId"],
    ["unknown capability", { ...good, capabilities: ["fly"] }, "unknown capability"],
    ["duplicate capability", { ...good, capabilities: ["tap", "tap"] }, "duplicate capability"],
    ["empty name", { ...good, name: " " }, "name must be"],
    ["missing metadata", { ...good, metadata: undefined }, "metadata must be"],
  ];
  for (const [label, def, expected] of cases) {
    assert.ok(validateDefinition(def).some((p) => p.includes(expected)), label);
  }
});
