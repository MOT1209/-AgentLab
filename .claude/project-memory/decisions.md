# DECISIONS

Format: date — decision — reason

- Fixed architecture: 12 Main Agents + 24 Sub-Agents (see skill knowledge/agents.md).
- Device access only through a Device Abstraction Layer.
- No secrets in code, logs, reports, or memory.
- Stack: TypeScript on Node 22, node:test, no runtime deps — minimal and typed.
- AdbDevice uses execFile (no shell) and validates package names to prevent injection.
- Roles are built as thin classes on one Agent base, not separate codebases.
