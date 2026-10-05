import { AgentStatus, AgentValidationError } from "./definitions.js";
import type { ManagedAgent } from "./managed-agent.js";
import { assertValid, validateDefinition } from "./validation.js";

/** Holds live agents and enforces the parent/child rules. Depth is fixed at MAIN -> SUB, so cycles are impossible. */
export class AgentRegistry {
  private readonly agents = new Map<string, ManagedAgent>();

  get size(): number {
    return this.agents.size;
  }

  register(agent: ManagedAgent): void {
    const def = agent.definition;
    assertValid(validateDefinition(def), "invalid agent definition");
    if (this.agents.has(def.id)) throw new AgentValidationError([`duplicate agent id: ${def.id}`]);
    if (def.kind === "SUB") {
      const parent = def.parentId === undefined ? undefined : this.agents.get(def.parentId);
      if (!parent) throw new AgentValidationError([`${def.id}: parent '${String(def.parentId)}' is not registered`]);
      if (parent.kind !== "MAIN") throw new AgentValidationError([`${def.id}: parent '${parent.id}' is not a MAIN agent`]);
    }
    this.agents.set(def.id, agent);
  }

  /** Returns false if unknown. A MAIN agent with registered children cannot be removed. */
  unregister(id: string): boolean {
    const agent = this.agents.get(id);
    if (!agent) return false;
    if (agent.kind === "MAIN" && this.childrenOf(id).length > 0) {
      throw new AgentValidationError([`${id}: unregister its sub-agents first`]);
    }
    return this.agents.delete(id);
  }

  has(id: string): boolean {
    return this.agents.has(id);
  }
  get(id: string): ManagedAgent | undefined {
    return this.agents.get(id);
  }
  require(id: string): ManagedAgent {
    const a = this.agents.get(id);
    if (!a) throw new Error(`unknown agent: ${id}`);
    return a;
  }

  list(): ManagedAgent[] {
    return [...this.agents.values()];
  }
  mains(): ManagedAgent[] {
    return this.list().filter((a) => a.kind === "MAIN");
  }
  subs(): ManagedAgent[] {
    return this.list().filter((a) => a.kind === "SUB");
  }
  childrenOf(id: string): ManagedAgent[] {
    return this.list().filter((a) => a.definition.parentId === id);
  }
  parentOf(id: string): ManagedAgent | undefined {
    const pid = this.agents.get(id)?.definition.parentId;
    return pid === undefined ? undefined : this.agents.get(pid);
  }

  getStatus(id: string): AgentStatus | undefined {
    return this.agents.get(id)?.status;
  }
  statuses(): Record<string, AgentStatus> {
    return Object.fromEntries(this.list().map((a) => [a.id, a.status]));
  }

  /** Post-hoc consistency check; returns problems instead of throwing. */
  validateRelationships(): string[] {
    const p: string[] = [];
    for (const a of this.agents.values()) {
      const def = a.definition;
      if (def.kind === "MAIN" && def.parentId !== undefined) p.push(`${def.id}: MAIN agent has a parent`);
      if (def.kind === "SUB") {
        const parent = def.parentId === undefined ? undefined : this.agents.get(def.parentId);
        if (!parent) p.push(`${def.id}: missing parent '${String(def.parentId)}'`);
        else if (parent.kind !== "MAIN") p.push(`${def.id}: parent '${parent.id}' is not MAIN`);
      }
    }
    return p;
  }
}
