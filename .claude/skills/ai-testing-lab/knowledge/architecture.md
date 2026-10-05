# ARCHITECTURE

Frontend
↓
Backend/API
↓
Agent Orchestrator
↓
Task Queue
↓
Main Agents
↓
Sub-Agents
↓
Testing Engine
↓
Device Manager
↓
Device Interface
↓
Android Adapter
↓
Android Environment

Supporting systems:

- Database
- Memory
- Logging
- Evidence
- Reports
- Authentication
- Security
- Monitoring

## Skill layer (Phase 6)

SkillDefinition catalog -> SkillRegistry -> AgentProfile (per agent) -> SkillResolver; enforced in SubAgent and the exploration loop.
Generated adapters: .claude/skills and .agent/skills. Details: knowledge/skills.md. It extends the agent organization and does not change it
(still exactly 12 MAIN + 24 SUB).

## Device runtime (Phase 3)

DeviceManager (src/runtime/)
↓
DeviceRegistry (catalogue) + DevicePool (exclusive leases)
↓
AgentAssignment: MAIN-NN → DEVICE-NN (one device per MAIN, sub-agents inherit)
↓
RuntimeContext (agent, device, lease, session) passed to handlers

Rules:
- A device is a runtime resource; an agent is a logical worker. The link is only AgentAssignment.
- Lock states FREE → LEASED → BUSY → FREE. Hardware state (DeviceState) is separate.
- MAIN agents lease their device for the duration of a task; sub-agents run only under that lease.
- Nobody outside DeviceManager/DevicePool changes lock state.
- AgentDefinition stays static; assignments and leases are runtime data.
