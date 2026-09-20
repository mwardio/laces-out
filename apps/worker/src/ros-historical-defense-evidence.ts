import {
  defensePointsAllowedDefinitionForProfile,
  isDefensePointsAllowedStatId,
  type ProjectionScoringProfile,
} from "@laces-out/projections";

export const ROS_CORRECTED_DEFENSE_EVIDENCE_BLOCKER =
  "corrected_defense_historical_evidence_required";
export const ROS_CORRECTED_ACTUAL_DEFINITION_VERSION = "observed-weekly-components-complete-v1";
export const ROS_CORRECTED_DEFENSE_EVIDENCE_MESSAGE =
  "Corrected provider-specific defense history must be recaptured and validated before ROS evidence can be used.";

/** This release retains the legacy simulator; old outcomes are not corrected by repricing them. */
export function requireCorrectedRosDefenseEvidence(input: {
  readonly positions: readonly string[];
  readonly evidence?: unknown;
  readonly scoringProfile?: ProjectionScoringProfile;
}): void {
  if (!input.positions.includes("DST")) return;
  const evidence = input.evidence;
  if (evidence === null || typeof evidence !== "object" || Array.isArray(evidence))
    throw new Error(ROS_CORRECTED_DEFENSE_EVIDENCE_MESSAGE);
  const value = evidence as Record<string, unknown>;
  if (
    value.actualDefinitionVersion !== ROS_CORRECTED_ACTUAL_DEFINITION_VERSION ||
    (value.pointsAllowedDefinition !== "yahoo-2022-v1" &&
      value.pointsAllowedDefinition !== "espn-2019-v1")
  )
    throw new Error(ROS_CORRECTED_DEFENSE_EVIDENCE_MESSAGE);
  if (input.scoringProfile) {
    const definition = defensePointsAllowedDefinitionForProfile(input.scoringProfile);
    const active = input.scoringProfile.rules.some(
      (rule) =>
        isDefensePointsAllowedStatId(rule.statId) &&
        (rule.points !== 0 || (rule.bonuses ?? []).some((bonus) => bonus.points !== 0)),
    );
    if (active && (definition === null || definition !== value.pointsAllowedDefinition))
      throw new Error(ROS_CORRECTED_DEFENSE_EVIDENCE_MESSAGE);
  }
}
