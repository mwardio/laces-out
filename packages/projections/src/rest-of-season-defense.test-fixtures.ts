import { firstPartyTeamDefenseRealizedAllowedBuckets } from "./first-party.js";
import {
  FIRST_PARTY_DEFENSE_GAME_VERSION,
  DEFENSE_COPULA_COMPONENTS,
  DEFENSE_EVENT_COMPONENTS,
  defenseGameRankDependence,
  type DefenseEventComponent,
} from "./team-defense-game.js";
import type { FirstPartyRosProjectionInput } from "./rest-of-season.js";

export function firstPartyRosDefenseInputFixture(): FirstPartyRosProjectionInput {
  const low = firstPartyTeamDefenseRealizedAllowedBuckets({ pointsAllowed: 0, yardsAllowed: 300 });
  const high = firstPartyTeamDefenseRealizedAllowedBuckets({
    pointsAllowed: 46,
    yardsAllowed: 550,
  });
  const components = {
    ...Object.fromEntries(Object.keys(low).map((key) => [key, (low[key]! + high[key]!) / 2])),
    defensive_sacks: 2.6,
    defensive_interceptions: 0.85,
    defensive_fumble_recoveries: 0.65,
    defensive_touchdowns: 0.18,
    defensive_safeties: 0.05,
    defensive_blocked_kicks: 0.12,
    fourth_down_stops: 0.85,
    special_teams_touchdowns: 0.08,
    points_allowed: 23,
    yards_allowed: 425,
    defensive_two_point_returns: 0,
    one_point_safeties: 0,
  };
  const weights = (size: number, a: number, b: number) =>
    Array.from({ length: size }, (_, i) => Number(i === a || i === b));
  const allowed = {
    pointsAllowed: { weights: weights(47, 0, 46), totalWeight: 2 },
    yardsAllowed: { weights: weights(551, 300, 550), totalWeight: 2 },
  };
  return {
    playerId: "DST:BUF",
    position: "DST",
    season: 2026,
    asOfWeek: 1,
    asOfAt: "2026-09-15T00:00:00.000Z",
    windowStartWeek: 2,
    windowEndWeek: 5,
    strategy: "contextual",
    inputChecksum: "a".repeat(64),
    weeklyModelVersion: "weekly-test",
    seed: "defense-integration",
    scenarioCount: 512,
    scoringProfile: {
      id: "defense-brackets",
      rules: [
        { statId: "defensive_sacks", points: 1 },
        { statId: "points_allowed_0_probability", points: 10 },
        { statId: "points_allowed_35_plus_probability", points: -4 },
      ],
    },
    role: {
      currentMultiplier: 1,
      minimumMultiplier: 1,
      maximumMultiplier: 1,
      persistence: 1,
      innovationVolatility: 0,
      weeklyProductionVolatility: 0,
    },
    availability: {
      state: "active",
      newAbsenceProbability: 0,
      recoveryProbability: 1,
      reserveRecoveryProbability: 1,
      limitedRoleMultiplier: 1,
      returnRoleMultiplier: 1,
    },
    defense: {
      version: FIRST_PARTY_DEFENSE_GAME_VERSION,
      overdispersion: Object.fromEntries(DEFENSE_EVENT_COMPONENTS.map((key) => [key, 0])) as Record<
        DefenseEventComponent,
        number
      >,
      dependence: defenseGameRankDependence([DEFENSE_COPULA_COMPONENTS.map(() => 0)]),
    },
    weeks: [2, 3, 4, 5].map((week) => ({
      season: 2026,
      week,
      scheduled: week !== 3,
      bye: week === 3,
      contextualComponents:
        week === 3
          ? Object.fromEntries(Object.keys(components).map((key) => [key, 0]))
          : components,
      recencyComponents:
        week === 3
          ? Object.fromEntries(Object.keys(components).map((key) => [key, 0]))
          : components,
      componentElasticities: Object.fromEntries(
        Object.keys(components).map((key) => [key, { role: 0, production: 0 }]),
      ),
      ...(week === 3 ? {} : { defenseDistributions: { contextual: allowed, recency: allowed } }),
    })),
  };
}
