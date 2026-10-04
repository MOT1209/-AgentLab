# AGENTS COMMAND

Manage the AI agent system.

Fixed architecture:

12 Main Agents
24 Sub-Agents
36 total agents

Never create duplicate permanent agents without architectural approval.

Main Agent responsibilities:

- planning
- delegation
- monitoring
- validation
- reporting

Sub-Agent responsibilities:

- specialized execution
- evidence collection
- verification
- reporting

Agent lifecycle:

INITIALIZE
↓
LOAD CONFIG
↓
CONNECT
↓
IDLE
↓
RECEIVE TASK
↓
PLAN
↓
EXECUTE
↓
VERIFY
↓
REPORT
↓
IDLE

Agent communication must use structured messages.

Every task must have:

- task_id
- agent_id
- type
- priority
- status
- payload
- result
- errors
- timestamps

Failures must be isolated so one agent does not crash the entire system.
