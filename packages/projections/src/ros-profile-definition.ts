import { createHash } from "node:crypto";

import { rosAvailableProjectionStatIds } from "./ros-scoring-profiles.js";
import { projectionScoringRulesFromProfileKey } from "./scoring-position-keys.js";
import type { ProjectionScoringProfile } from "./scoring.js";

/** Matches the persisted champion artifact identity limit. */
export const ROS_PROFILE_KEY_MAXIMUM_BYTES = 8_192;

export interface RosProfileDefinition {
  readonly key: string;
  readonly label: string;
  readonly digest: string;
  readonly scoringProfileKey: string;
  readonly profile: ProjectionScoringProfile;
}

/** Parse an exact normalized identity; unknown components and nonlinear bonuses fail closed. */
export function rosProfileDefinitionFromKey(scoringProfileKey: string): RosProfileDefinition {
  if (
    typeof scoringProfileKey !== "string" ||
    Buffer.byteLength(scoringProfileKey, "utf8") > ROS_PROFILE_KEY_MAXIMUM_BYTES
  ) {
    throw new TypeError("ROS scoring profile key exceeds its identity limit");
  }
  // This validates canonical ordering, exact fields, duplicate rules, finite points and bonus
  // thresholds, then proves that parsing loses none of the scoring identity.
  const rules = projectionScoringRulesFromProfileKey(scoringProfileKey);
  const available = new Set(rosAvailableProjectionStatIds());
  for (const rule of rules) {
    if (!available.has(rule.statId))
      throw new TypeError("ROS scoring profile has an unknown component");
    // League normalization rejects thresholding a projected total. Valid yardage bonuses are
    // represented by probability components, which remain accepted here.
    if ((rule.bonuses ?? []).length > 0)
      throw new TypeError("ROS scoring profile has a nonlinear bonus");
  }
  if (rules.every((rule) => rule.points === 0))
    throw new TypeError("ROS scoring profile prices no components");
  const digest = createHash("sha256").update(scoringProfileKey).digest("hex");
  return {
    key: `exact-${digest}`,
    label: "Exact league scoring",
    digest,
    scoringProfileKey,
    profile: { id: `laces-out-ros-exact-${digest}`, version: "1", rules },
  };
}
