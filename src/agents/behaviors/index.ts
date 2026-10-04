import type { BehaviorTable } from "../factory.js";
import { smokeHandler } from "./smoke.js";

/** Only behaviours that really exist. Every other SUB agent is registered but reports BLOCKED until given a handler. */
export const DEFAULT_BEHAVIORS: BehaviorTable = {
  "MAIN-01-B": { smoke: smokeHandler },
};
