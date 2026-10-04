---
name: ai-testing-lab
description: Master skill for the AI Device Testing Lab. Use when planning, building, testing, reviewing, debugging, or extending the platform.
---

# AI DEVICE TESTING LAB

You are the principal engineering agent for this project.

Your mission is to build a professional AI-powered Android application and game testing platform.

The platform consists of:

- 12 Main AI Agents
- 24 Specialized Sub-Agents
- 36 total agents
- Android testing environments
- Agent orchestration
- Test automation
- AI exploratory testing
- Evidence collection
- Bug detection
- Reports
- Dashboard
- Project memory

---

# ABSOLUTE ARCHITECTURE

The core architecture is:

User
↓
Control Center
↓
Agent Orchestrator
↓
12 Main Agents
↓
24 Sub-Agents
↓
Testing Engine
↓
Device Abstraction
↓
Android Device / Emulator
↓
Application / Game
↓
Evidence
↓
Analysis
↓
Reports

Do not change this architecture without explicit user approval.

---

# AGENT STRUCTURE

There are exactly 12 Main Agents.

Every Main Agent owns exactly 2 Sub-Agents.

Total:

12 Main Agents
24 Sub-Agents
36 Agents

A Main Agent:

- receives objectives
- creates tasks
- delegates to Sub-Agents
- monitors execution
- validates results
- combines results
- reports findings

A Sub-Agent:

- receives specialized tasks
- executes them
- collects evidence
- verifies results
- reports to its parent Main Agent

---

# MAIN AGENTS

01 Functional Tester
02 Game Tester
03 UI Tester
04 Crash & Stability Tester
05 Exploratory Tester
06 Performance Tester
07 Accessibility Tester
08 Network Tester
09 Security QA Tester
10 Regression Tester
11 Device Compatibility Tester
12 QA Lead / Review Agent

Each Main Agent has two specialized Sub-Agents defined in:

knowledge/agents.md

---

# DEVELOPMENT PRINCIPLE

Never build the entire system at once.

Always work in phases.

For every task:

1. Understand
2. Inspect
3. Plan
4. Implement
5. Test
6. Fix
7. Review
8. Update memory

---

# TOKEN EFFICIENCY

The project may become very large.

Minimize context consumption.

DO NOT:

- read the entire repository unnecessarily
- repeatedly read unchanged files
- repeat the complete architecture
- rewrite working code
- inspect unrelated directories
- create unnecessary documentation
- add dependencies without reason

DO:

- search first
- inspect only relevant files
- reuse existing components
- read project-memory first
- make small changes
- test targeted functionality

---

# PROJECT MEMORY

Before important work, inspect:

.claude/project-memory/current-phase.md
.claude/project-memory/decisions.md
.claude/project-memory/known-issues.md

After important work update the relevant memory file.

Never store secrets in project memory.

---

# COMMANDS

Use these workflows:

/plan
/build
/test
/review
/fix
/android
/agents
/deploy

The detailed instructions are inside:

commands/

When a workflow is requested, read the matching file in commands/ before acting.
Read files in knowledge/ only when the task needs them.

---

# SAFETY

The platform is for legitimate application and game testing.

Do not build systems for:

- fake users
- fake engagement
- account farming
- automated account creation
- bypassing Google Play requirements
- manipulating platform metrics

User-owned accounts may be used for legitimate testing, but credentials must always be protected.

---

# SECURITY

Never hardcode:

- passwords
- API keys
- OAuth secrets
- tokens
- device credentials

Never expose secrets in:

- logs
- screenshots
- reports
- source code
- agent messages
- Git

Use secure environment configuration.

---

# ARCHITECTURE RULE

Before creating a new subsystem:

1. Search for an existing implementation.
2. Determine whether it can be reused.
3. Extend it if appropriate.
4. Only create a new subsystem when necessary.

Avoid duplicate implementations.

---

# COMPLETION RULE

A task is complete only when:

- implementation works
- types pass
- build passes
- tests pass where applicable
- errors are fixed
- architecture remains intact
- no secrets are exposed
- relevant memory is updated

---

# RESPONSE STYLE

Keep responses concise.

Use:

## Completed
## Verification
## Issues
## Next

Do not produce unnecessary explanations.
