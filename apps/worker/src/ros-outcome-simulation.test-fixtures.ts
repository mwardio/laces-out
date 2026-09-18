import {
  DEFENSE_COPULA_COMPONENTS,
  DEFENSE_EVENT_COMPONENTS,
  FIRST_PARTY_DEFENSE_GAME_VERSION,
  defenseGameRankDependence,
  firstPartyProjectionComponentsForPosition,
  firstPartyTeamDefenseProjectionComponents,
  firstPartyTeamDefenseRealizedAllowedBuckets,
  type DefenseEventComponent,
  type FirstPartyRosOutcomeInput,
  type FirstPartyRosPosition,
} from "@laces-out/projections";
import { historicalOutcomeInputFixture } from "./ros-historical-outcome.test-fixtures.js";

/** Dense, nonzero football fixture for transport equality; this is not accuracy evidence. */
export function denseSimulationInput(
  position: FirstPartyRosPosition,
  strategy: FirstPartyRosOutcomeInput["strategy"],
): FirstPartyRosOutcomeInput {
  const vocabulary =
    position === "DST"
      ? firstPartyTeamDefenseProjectionComponents()
      : firstPartyProjectionComponentsForPosition(position);
  const components: Record<string, number> = Object.fromEntries(
    vocabulary.map((stat) => [stat, 0]),
  );
  if (position === "K")
    Object.assign(components, {
      field_goals_made_0_19: 0.1,
      field_goals_made_20_29: 0.25,
      field_goals_made_30_39: 0.35,
      field_goals_made_0_39: 0.7,
      field_goals_made_40_49: 0.6,
      field_goals_made_50_59: 0.4,
      field_goals_made_60_plus: 0.1,
      field_goals_made_50_plus: 0.5,
      field_goals_made: 1.8,
      field_goals_attempted: 2.1,
      field_goals_missed: 0.3,
      field_goals_missed_0_19: 0.015,
      field_goals_missed_20_29: 0.015,
      field_goals_missed_30_39: 0.03,
      field_goals_missed_40_49: 0.09,
      field_goals_missed_50_59: 0.12,
      field_goals_missed_60_plus: 0.03,
      field_goals_missed_0_39: 0.06,
      field_goals_missed_50_plus: 0.15,
      field_goals_total_yards: 76.3,
      extra_points_made: 2.5,
      extra_points_missed: 0.1,
      extra_points_attempted: 2.6,
    });
  else if (position === "DST") {
    const low = firstPartyTeamDefenseRealizedAllowedBuckets({
      pointsAllowed: 0,
      yardsAllowed: 200,
    });
    const high = firstPartyTeamDefenseRealizedAllowedBuckets({
      pointsAllowed: 44,
      yardsAllowed: 460,
    });
    Object.assign(components, {
      ...Object.fromEntries(Object.keys(low).map((key) => [key, (low[key]! + high[key]!) / 2])),
      defensive_sacks: 2.5,
      defensive_interceptions: 1.1,
      defensive_fumble_recoveries: 0.8,
      defensive_safeties: 0.05,
      defensive_blocked_kicks: 0.1,
      fourth_down_stops: 0.9,
      special_teams_touchdowns: 0.08,
      points_allowed: 22,
      yards_allowed: 330,
      defensive_touchdowns: 0.15,
    });
  } else
    Object.assign(components, {
      passing_attempts: 32,
      passing_completions: 22,
      passing_incompletions: 10,
      passing_yards: 255,
      passing_touchdowns: 1.6,
      passing_interceptions: 0.7,
      passing_touchdowns_40_plus: 0.2,
      passing_touchdowns_50_plus: 0.08,
      rushing_attempts: 8,
      rushing_yards: 39,
      rushing_touchdowns: 0.3,
      rushing_touchdowns_40_plus: 0.025,
      rushing_touchdowns_50_plus: 0.009,
      targets: 8,
      receptions: 6,
      receiving_yards: 75,
      receiving_touchdowns: 0.55,
      receiving_touchdowns_40_plus: 0.08,
      receiving_touchdowns_50_plus: 0.03,
      punt_return_yards: -0.5,
      kickoff_return_yards: 18,
    });
  // Each position receives only its own vocabulary; unsupported other-position values are absent.
  for (const key of Object.keys(components)) if (!vocabulary.includes(key)) delete components[key];
  for (const key of Object.keys(components)) {
    if (key.endsWith("_nonnegative"))
      components[key] = Math.max(0, components[key.slice(0, -12)] ?? 0);
  }
  const recency = Object.fromEntries(
    Object.entries(components).map(([key, value]) => [
      key,
      position === "DST" && (key.endsWith("_probability") || key.endsWith("_allowed"))
        ? value
        : value * 0.87,
    ]),
  );
  const defenseDistributions = {
    pointsAllowed: {
      weights: Array.from({ length: 45 }, (_, index) => Number(index === 0 || index === 44)),
      totalWeight: 2,
    },
    yardsAllowed: {
      weights: Array.from({ length: 461 }, (_, index) => Number(index === 200 || index === 460)),
      totalWeight: 2,
    },
  };
  const { scoringProfile: _profile, ...base } = historicalOutcomeInputFixture();
  void _profile;
  return {
    ...base,
    position,
    strategy,
    playerId: `dense-${position}`,
    seed: `dense-byte-proof-${position}`,
    scenarioCount: 16_384,
    windowStartWeek: 5,
    windowEndWeek: 8,
    weeks: [5, 6, 7, 8].map((week) => ({
      season: 2026,
      week,
      scheduled: week !== 6,
      bye: week === 6,
      contextualComponents: components,
      recencyComponents: recency,
      componentElasticities: Object.fromEntries(
        Object.keys(components).map((stat) => [
          stat,
          position === "DST" ? { role: 0, production: 0 } : { role: 0.7, production: 1.1 },
        ]),
      ),
      ...(position === "DST" && week !== 6
        ? {
            defenseDistributions: {
              contextual: defenseDistributions,
              recency: defenseDistributions,
            },
          }
        : {}),
    })),
    ...(position === "DST"
      ? {
          availability: {
            state: "active" as const,
            newAbsenceProbability: 0,
            recoveryProbability: 1,
            reserveRecoveryProbability: 1,
            limitedRoleMultiplier: 1,
            returnRoleMultiplier: 1,
          },
          role: {
            currentMultiplier: 1,
            persistence: 1,
            innovationVolatility: 0,
            weeklyProductionVolatility: 0,
            minimumMultiplier: 1,
            maximumMultiplier: 1,
          },
          defense: {
            version: FIRST_PARTY_DEFENSE_GAME_VERSION,
            overdispersion: Object.fromEntries(
              DEFENSE_EVENT_COMPONENTS.map((component) => [component, 0.1]),
            ) as Record<DefenseEventComponent, number>,
            dependence: defenseGameRankDependence([DEFENSE_COPULA_COMPONENTS.map(() => 0)]),
          },
        }
      : {}),
    ...(position === "K"
      ? {
          kicker: {
            fgEventDispersion: 0.9,
            xpDispersion: 0.9,
            centerVolatility: 0.1,
            bucketMix: [0.4, 0.35, 0.25] as const,
            missBucketMix: [0.05, 0.05, 0.1, 0.3, 0.4, 0.1] as const,
          },
        }
      : {}),
  };
}
