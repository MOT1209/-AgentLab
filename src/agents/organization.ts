import type { Capability } from "./capabilities.js";
import type { AgentDefinition } from "./definitions.js";

interface SubSpec {
  name: string;
  role: string;
  description: string;
  capabilities: readonly Capability[];
}
interface MainSpec {
  name: string;
  role: string;
  description: string;
  subs: readonly [SubSpec, SubSpec];
}

/** Single source of truth for the AgentLab hierarchy. Ids are derived from position. */
const SPEC: readonly MainSpec[] = [
  {
    name: "Functional Tester",
    role: "functional-testing",
    description: "Verifies that application features work as specified.",
    subs: [
      { name: "Authentication Tester", role: "authentication-testing", description: "Tests sign-in, sign-up, session and logout flows.", capabilities: ["launch_app", "tap", "type", "screenshot", "inspect_ui", "logs"] },
      { name: "Core Feature Tester", role: "core-feature-testing", description: "Installs, launches and exercises the primary features of the app.", capabilities: ["install_app", "launch_app", "stop_app", "tap", "type", "screenshot", "logs"] },
    ],
  },
  {
    name: "Game Tester",
    role: "game-testing",
    description: "Verifies game behaviour, progression and input handling.",
    subs: [
      { name: "Gameplay Tester", role: "gameplay-testing", description: "Plays through game loops, levels and progression.", capabilities: ["launch_app", "tap", "screenshot", "screen_recording", "logs"] },
      { name: "Controls Tester", role: "controls-testing", description: "Checks touch, gesture and input responsiveness.", capabilities: ["tap", "type", "screenshot", "inspect_ui"] },
    ],
  },
  {
    name: "UI Tester",
    role: "ui-testing",
    description: "Verifies visual correctness and layout of the user interface.",
    subs: [
      { name: "Layout Tester", role: "layout-testing", description: "Detects clipped, overlapping and misaligned elements.", capabilities: ["screenshot", "inspect_ui"] },
      { name: "Visual Regression Tester", role: "visual-regression-testing", description: "Compares screens against approved baselines.", capabilities: ["screenshot", "compare_results"] },
    ],
  },
  {
    name: "Crash & Stability Tester",
    role: "crash-stability-testing",
    description: "Finds crashes, ANRs and instability under repeated use.",
    subs: [
      { name: "Crash Hunter", role: "crash-hunting", description: "Provokes and captures crashes and ANRs with evidence.", capabilities: ["launch_app", "stop_app", "tap", "logs", "screenshot"] },
      { name: "Stability Tester", role: "stability-testing", description: "Runs long and repeated sessions to find degradation.", capabilities: ["launch_app", "stop_app", "logs", "screen_recording"] },
    ],
  },
  {
    name: "Exploratory Tester",
    role: "exploratory-testing",
    description: "Explores the application without a fixed script to find unexpected defects.",
    subs: [
      { name: "Exploration Agent", role: "exploration", description: "Navigates the app autonomously and maps reachable screens.", capabilities: ["launch_app", "stop_app", "tap", "type", "swipe", "press_key", "screenshot", "inspect_ui", "logs"] },
      { name: "Edge Case Agent", role: "edge-case-testing", description: "Tries unusual inputs, sequences and boundary values.", capabilities: ["tap", "type", "screenshot", "logs"] },
    ],
  },
  {
    name: "Performance Tester",
    role: "performance-testing",
    description: "Measures responsiveness, resource use and load times.",
    subs: [
      { name: "Runtime Performance Agent", role: "runtime-performance", description: "Measures frame rate, memory and CPU while the app runs.", capabilities: ["logs", "device_info", "screen_recording"] },
      { name: "Startup & Loading Agent", role: "startup-loading-performance", description: "Measures cold/warm start and screen loading times.", capabilities: ["launch_app", "stop_app", "logs"] },
    ],
  },
  {
    name: "Accessibility Tester",
    role: "accessibility-testing",
    description: "Verifies the app is usable with assistive technologies.",
    subs: [
      { name: "Accessibility UI Agent", role: "accessibility-ui", description: "Checks labels, contrast, text scaling and touch-target sizes.", capabilities: ["inspect_ui", "screenshot"] },
      { name: "Interaction Accessibility Agent", role: "interaction-accessibility", description: "Checks focus order and screen-reader interaction paths.", capabilities: ["tap", "inspect_ui", "screenshot"] },
    ],
  },
  {
    name: "Network Tester",
    role: "network-testing",
    description: "Verifies behaviour under varying network conditions and API failures.",
    subs: [
      { name: "Connectivity Agent", role: "connectivity-testing", description: "Tests offline, slow and flapping connectivity.", capabilities: ["network_control", "logs"] },
      { name: "API & Failure Agent", role: "api-failure-testing", description: "Tests handling of API errors, timeouts and malformed responses.", capabilities: ["network_control", "logs", "analyze_results"] },
    ],
  },
  {
    name: "Security QA Tester",
    role: "security-qa",
    description: "Performs QA-level security checks on the application under test.",
    subs: [
      { name: "Authentication & Data Agent", role: "auth-data-security", description: "Checks session handling and sensitive data exposure.", capabilities: ["logs", "analyze_results", "inspect_ui"] },
      { name: "Permissions & Configuration Agent", role: "permissions-configuration-security", description: "Reviews requested permissions and risky configuration.", capabilities: ["device_info", "analyze_results", "logs"] },
    ],
  },
  {
    name: "Regression Tester",
    role: "regression-testing",
    description: "Detects behaviour changes between app versions.",
    subs: [
      { name: "Previous Test Agent", role: "previous-test-replay", description: "Re-runs previously recorded tests and checks outcomes.", capabilities: ["compare_results", "analyze_results"] },
      { name: "Version Comparison Agent", role: "version-comparison", description: "Compares results and behaviour across app versions.", capabilities: ["compare_results", "device_info"] },
    ],
  },
  {
    name: "Device Compatibility Tester",
    role: "device-compatibility",
    description: "Verifies the app across Android versions and device models.",
    subs: [
      { name: "Android Version Agent", role: "android-version-compatibility", description: "Runs checks across supported Android versions.", capabilities: ["device_info", "install_app", "launch_app"] },
      { name: "Device Compatibility Agent", role: "device-model-compatibility", description: "Runs checks across screen sizes, densities and device models.", capabilities: ["device_info", "install_app", "launch_app", "screenshot"] },
    ],
  },
  {
    name: "QA Lead / Review Agent",
    role: "qa-lead",
    description: "Reviews, validates and consolidates results from all testers.",
    subs: [
      { name: "Result Validation Agent", role: "result-validation", description: "Verifies that reported results are supported by evidence.", capabilities: ["analyze_results"] },
      { name: "Report Analysis Agent", role: "report-analysis", description: "Analyses findings and produces consolidated reports.", capabilities: ["analyze_results", "generate_report"] },
    ],
  },
];

const pad = (n: number) => String(n).padStart(2, "0");

function build(): readonly AgentDefinition[] {
  const out: AgentDefinition[] = [];
  SPEC.forEach((m, i) => {
    const mainId = `MAIN-${pad(i + 1)}`;
    const subs = m.subs.map((s, j): AgentDefinition => {
      const slot = "AB"[j] as string;
      return Object.freeze({
        id: `${mainId}-${slot}`,
        kind: "SUB",
        name: s.name,
        role: s.role,
        description: s.description,
        parentId: mainId,
        capabilities: Object.freeze([...s.capabilities]),
        metadata: Object.freeze({ slot }),
      });
    });
    // A MAIN agent coordinates; its capabilities are the union of its sub-agents'.
    const caps = [...new Set(subs.flatMap((s) => s.capabilities))];
    out.push(
      Object.freeze({
        id: mainId,
        kind: "MAIN",
        name: m.name,
        role: m.role,
        description: m.description,
        capabilities: Object.freeze(caps),
        metadata: Object.freeze({ order: i + 1 }),
      }),
      ...subs,
    );
  });
  return Object.freeze(out);
}

/** The default AgentLab organization: 12 MAIN + 24 SUB, ordered MAIN then its subs. */
export const CANONICAL_DEFINITIONS: readonly AgentDefinition[] = build();

export interface OrganizationNode {
  readonly main: AgentDefinition;
  readonly subs: readonly AgentDefinition[];
}

/** Programmatic view of the hierarchy. */
export function organizationTree(defs: readonly AgentDefinition[] = CANONICAL_DEFINITIONS): OrganizationNode[] {
  return defs
    .filter((d) => d.kind === "MAIN")
    .map((main) => ({ main, subs: defs.filter((d) => d.parentId === main.id) }));
}
