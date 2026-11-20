import type { BehaviorTable } from "../factory.js";
import { explorationHandler } from "../exploration/exploration-agent.js";
import { crashHuntHandler } from "./crash-hunter.js";
import { edgeCaseHandler } from "./edge-case.js";
import { smokeHandler } from "./smoke.js";

/** Only behaviours that really exist. Every other SUB agent is registered but reports BLOCKED until given a handler. */
export const DEFAULT_BEHAVIORS: BehaviorTable = {
  "MAIN-01-B": { smoke: smokeHandler },
  "MAIN-04-A": { "crash-hunt": crashHuntHandler },
  "MAIN-05-A": { explore: explorationHandler },
  "MAIN-05-B": { "edge-case": edgeCaseHandler },
};
