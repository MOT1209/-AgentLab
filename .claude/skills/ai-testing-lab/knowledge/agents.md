# AGENT KNOWLEDGE

Source of truth in code: `src/agents/organization.ts`. A test keeps this file in sync.

## MAIN-01 Functional Tester

- MAIN-01-A Authentication Tester
- MAIN-01-B Core Feature Tester

## MAIN-02 Game Tester

- MAIN-02-A Gameplay Tester
- MAIN-02-B Controls Tester

## MAIN-03 UI Tester

- MAIN-03-A Layout Tester
- MAIN-03-B Visual Regression Tester

## MAIN-04 Crash & Stability Tester

- MAIN-04-A Crash Hunter — behavior: `crash-hunt` (src/agents/behaviors/crash-hunter.ts), seeded stress, no LLM
- MAIN-04-B Stability Tester — behavior: `stability` (src/agents/behaviors/stability.ts), cold/warm cycles, memory leak + crash rate, no LLM

## MAIN-05 Exploratory Tester

- MAIN-05-A Exploration Agent
- MAIN-05-B Edge Case Agent — behavior: `edge-case` (src/agents/behaviors/edge-case.ts), input/sequence matrix, no LLM

## MAIN-06 Performance Tester

- MAIN-06-A Runtime Performance Agent
- MAIN-06-B Startup & Loading Agent

## MAIN-07 Accessibility Tester

- MAIN-07-A Accessibility UI Agent
- MAIN-07-B Interaction Accessibility Agent

## MAIN-08 Network Tester

- MAIN-08-A Connectivity Agent
- MAIN-08-B API & Failure Agent

## MAIN-09 Security QA Tester

- MAIN-09-A Authentication & Data Agent
- MAIN-09-B Permissions & Configuration Agent

## MAIN-10 Regression Tester

- MAIN-10-A Previous Test Agent
- MAIN-10-B Version Comparison Agent

## MAIN-11 Device Compatibility Tester

- MAIN-11-A Android Version Agent
- MAIN-11-B Device Compatibility Agent

## MAIN-12 QA Lead / Review Agent

- MAIN-12-A Result Validation Agent
- MAIN-12-B Report Analysis Agent

## Implemented behaviors

- MAIN-01-B: `smoke` (deterministic).
- MAIN-05-A: `explore` — LLM-driven loop (src/agents/exploration/). MAIN-05-B and all others: no behavior yet (BLOCKED).
