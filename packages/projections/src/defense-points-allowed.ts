import type { ProjectionDefensePointsAllowedDefinition } from "./scoring.js";

/**
 * Explicit current fantasy scoring definitions, applied to complete neutral opponent scoring
 * events. Applying a definition to an older game is modern-rule rescoring, not a claim about
 * that game's original fantasy score. The caller owns game/source/finality identity checks.
 *
 * Yahoo: https://help.yahoo.com/kb/fantasy-football/SLN6441.html
 * ESPN: https://support.espn.com/hc/en-us/articles/115003847231-Defense-and-Special-Teams-D-ST-Scoring
 * Granular ESPN rules are corroborated by public actual stat IDs 120 and 187, captured in
 * reports/ros-v13-full-defense-training-20260918/defense-source-semantics-20260919/
 * provider-points-allowed-evidence-20260919.json .
 */
export const DEFENSE_POINTS_ALLOWED_DEFINITIONS = ["yahoo-2022-v1", "espn-2019-v1"] as const;
export type DefensePointsAllowedDefinition = ProjectionDefensePointsAllowedDefinition;

/** Complete count vocabulary; these values are scoreboard points per event, not fantasy points. */
export const DEFENSE_POINTS_ALLOWED_EVENT_POINTS = {
  scoring_event_offensive_pass_touchdown: 6,
  scoring_event_offensive_rush_touchdown: 6,
  scoring_event_offensive_fumble_touchdown: 6,
  scoring_event_defensive_interception_touchdown: 6,
  scoring_event_defensive_fumble_touchdown: 6,
  scoring_event_kickoff_return_touchdown: 6,
  scoring_event_kickoff_fumble_touchdown: 6,
  scoring_event_punt_return_touchdown: 6,
  scoring_event_punt_fumble_touchdown: 6,
  scoring_event_blocked_punt_touchdown: 6,
  scoring_event_blocked_field_goal_touchdown: 6,
  scoring_event_field_goal_return_touchdown: 6,
  scoring_event_field_goal: 3,
  scoring_event_extra_point: 1,
  scoring_event_offensive_two_point_conversion: 2,
  scoring_event_defensive_two_point_return: 2,
  scoring_event_one_point_safety: 1,
  scoring_event_safety: 2,
} as const;
export type DefenseScoringEventComponent = keyof typeof DEFENSE_POINTS_ALLOWED_EVENT_POINTS;

export type DefensePointsAllowedUnresolvedReason =
  | "unsupported-definition"
  | "incomplete-scoring-events"
  | "invalid-scoring-event-count"
  | "unrecognized-scoring-event"
  | "invalid-final-score"
  | "invalid-scoring-points-total"
  | "scoring-points-total-mismatch"
  | "final-score-mismatch"
  | "unsupported-scoring-event";

export type DefensePointsAllowedResult =
  | {
      readonly state: "complete";
      readonly definition: DefensePointsAllowedDefinition;
      readonly pointsAllowed: number;
      readonly excludedPoints: number;
      readonly opponentFinalScore: number;
    }
  | {
      readonly state: "unresolved";
      readonly definition: DefensePointsAllowedDefinition;
      readonly pointsAllowed: null;
      readonly reason: DefensePointsAllowedUnresolvedReason;
      readonly component: string | null;
    };

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export type DefenseScoringEventInspection =
  | {
      readonly state: "complete";
      readonly counts: Readonly<Record<DefenseScoringEventComponent, number>>;
      readonly scoringPointsTotal: number;
    }
  | {
      readonly state: "unresolved";
      readonly reason: DefensePointsAllowedUnresolvedReason;
      readonly component: string | null;
    };

/** Validate either team's complete neutral ledger independently of fantasy scoring rules. */
export function inspectDefenseScoringEventComponents(input: {
  readonly components: Readonly<Record<string, unknown>>;
  readonly finalScore: number;
}): DefenseScoringEventInspection {
  const { components, finalScore } = input;
  const unresolved = (
    reason: DefensePointsAllowedUnresolvedReason,
    component: string | null = null,
  ): DefenseScoringEventInspection => ({
    state: "unresolved",
    reason,
    component,
  });
  if (
    components === null ||
    typeof components !== "object" ||
    Array.isArray(components) ||
    !Object.hasOwn(components, "scoring_event_totals_complete") ||
    components.scoring_event_totals_complete !== 1
  )
    return unresolved("incomplete-scoring-events");
  if (!count(finalScore)) return unresolved("invalid-final-score");
  if (!Object.hasOwn(components, "scoring_points_total") || !count(components.scoring_points_total))
    return unresolved("invalid-scoring-points-total");

  const counts = {} as Record<DefenseScoringEventComponent, number>;
  let total = 0;
  for (const [component, points] of Object.entries(DEFENSE_POINTS_ALLOWED_EVENT_POINTS)) {
    const value = components[component];
    if (!Object.hasOwn(components, component) || !count(value))
      return unresolved("invalid-scoring-event-count", component);
    counts[component as DefenseScoringEventComponent] = value;
    total += value * points;
    if (!Number.isSafeInteger(total)) return unresolved("invalid-scoring-event-count", component);
  }
  for (const component of Object.keys(components))
    if (
      component.startsWith("scoring_event_") &&
      component !== "scoring_event_totals_complete" &&
      !Object.hasOwn(DEFENSE_POINTS_ALLOWED_EVENT_POINTS, component)
    )
      return unresolved("unrecognized-scoring-event", component);
  if (total !== components.scoring_points_total) return unresolved("scoring-points-total-mismatch");
  if (total !== finalScore) return unresolved("final-score-mismatch");
  return { state: "complete", counts, scoringPointsTotal: total };
}

/** No missing counts, inferred zeros, score clamping, or provider-neutral PA substitution. */
export function defensePointsAllowedFromScoringEvents(input: {
  readonly definition: DefensePointsAllowedDefinition;
  readonly opponentComponents: Readonly<Record<string, unknown>>;
  readonly opponentFinalScore: number;
}): DefensePointsAllowedResult {
  const { definition, opponentComponents, opponentFinalScore } = input;
  if (!DEFENSE_POINTS_ALLOWED_DEFINITIONS.includes(definition))
    return {
      state: "unresolved",
      definition,
      pointsAllowed: null,
      reason: "unsupported-definition",
      component: null,
    };
  const inspection = inspectDefenseScoringEventComponents({
    components: opponentComponents,
    finalScore: opponentFinalScore,
  });
  if (inspection.state === "unresolved") return { ...inspection, definition, pointsAllowed: null };
  const { counts, scoringPointsTotal } = inspection;

  // ESPN's support page specifies fantasy credit for the scorer of a try safety, but does
  // not establish opponent PA treatment. Ordinary/blocked-punt safeties are corroborated.
  if (definition === "espn-2019-v1" && counts.scoring_event_one_point_safety > 0)
    return {
      state: "unresolved",
      definition,
      pointsAllowed: null,
      reason: "unsupported-scoring-event",
      component: "scoring_event_one_point_safety",
    };

  let excludedPoints =
    6 *
      (counts.scoring_event_defensive_interception_touchdown +
        counts.scoring_event_defensive_fumble_touchdown) +
    2 * (counts.scoring_event_safety + counts.scoring_event_defensive_two_point_return);
  if (definition === "yahoo-2022-v1")
    excludedPoints +=
      6 * counts.scoring_event_blocked_field_goal_touchdown + counts.scoring_event_one_point_safety;
  // Yahoo missed-FG return inclusion follows its general special-teams TD rule and the
  // specifically blocked-FG exclusion. This is documented inference, not a Yahoo actual
  // observation. ESPN inclusion is corroborated by ARI's 19 PA at JAX in 2021 week 3.
  return {
    state: "complete",
    definition,
    pointsAllowed: scoringPointsTotal - excludedPoints,
    excludedPoints,
    opponentFinalScore,
  };
}
