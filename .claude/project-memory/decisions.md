# DECISIONS

Format: date — decision — reason

- Fixed architecture: 12 Main Agents + 24 Sub-Agents (see skill knowledge/agents.md).
- Device access only through a Device Abstraction Layer.
- No secrets in code, logs, reports, or memory.
- Stack: TypeScript on Node 22, node:test, no runtime deps — minimal and typed.
- AdbDevice uses execFile (no shell) and validates package names to prevent injection.
- Roles are built as thin classes on one Agent base, not separate codebases.
- Phase 2: agent identity = AgentDefinition data (src/agents/organization.ts is the single source of truth). Ids: MAIN-NN, MAIN-NN-A|B.
- Behavior is injected as TaskHandlers per SUB id (BehaviorTable). MAIN agents have no behavior of their own: they delegate to children whose handler supports the task type.
- Phase 1 classes FunctionalTester/CoreFeatureTester and ids "01"/"01-B" were removed (replaced by MAIN-01 / MAIN-01-B + smokeHandler) to avoid two implementations of one role.
- Agent status (AgentStatus) is separate from TaskStatus. Agent ERROR = the agent itself failed; a child's ERROR aggregated into a result does not make the parent ERROR.
- DeviceError inside a handler => task BLOCKED (environment problem), not ERROR.
- Aggregation precedence: FAILED > ERROR > BLOCKED > PASSED/SKIPPED.
- Only MAIN agents accept orchestrator dispatch; SUB agents receive work from their parent only.
- Children run sequentially because they share one device.
- Canonical 12/24 rule is enforced by validateOrganization at bootstrap; custom definitions skip it.
