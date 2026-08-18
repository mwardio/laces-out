/**
 * Publication-grade ROS evidence contract.
 *
 * Exploratory runs may deliberately use smaller samples, but an artifact may never be admitted
 * from less evidence than the locked release replay. Keeping this contract in code prevents a
 * command-line default or maintenance script from silently weakening an otherwise valid run.
 */
export const FIRST_PARTY_ROS_RELEASE_PLAYERS_PER_POSITION = 8;
export const FIRST_PARTY_ROS_RELEASE_MAXIMUM_FORECASTS = 6_000;
// The ESPN-shaped release profiles legitimately yield 2,965 usable forecasts at N=8; generic
// profiles yield 3,264. Locking the lower observed release population still rejects the old N=5
// exploratory replay (2,040 forecasts) without excluding valid ESPN evidence.
export const FIRST_PARTY_ROS_RELEASE_MINIMUM_FORECASTS = 2_965;
export const FIRST_PARTY_ROS_RELEASE_MINIMUM_BATCHES = 68;
export const FIRST_PARTY_ROS_RELEASE_MINIMUM_HELD_OUT_SEASONS = 4;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeIntegerAtLeast(value: unknown, minimum: number): boolean {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}

/** Returns fail-closed admission blockers for an undersized or unreadable release replay. */
export function firstPartyRosReleaseValidationBlockers(reportBody: unknown): readonly string[] {
  if (!isObject(reportBody)) return ["release_validation_configuration_missing"];

  const blockers: string[] = [];
  if (
    !safeIntegerAtLeast(reportBody.playersPerPosition, FIRST_PARTY_ROS_RELEASE_PLAYERS_PER_POSITION)
  ) {
    blockers.push("release_validation_players_per_position_below_minimum");
  }
  if (!safeIntegerAtLeast(reportBody.maximumForecasts, FIRST_PARTY_ROS_RELEASE_MAXIMUM_FORECASTS)) {
    blockers.push("release_validation_forecast_cap_below_minimum");
  }
  if (!safeIntegerAtLeast(reportBody.forecasts, FIRST_PARTY_ROS_RELEASE_MINIMUM_FORECASTS)) {
    blockers.push("release_validation_forecasts_below_minimum");
  }
  if (!safeIntegerAtLeast(reportBody.batches, FIRST_PARTY_ROS_RELEASE_MINIMUM_BATCHES)) {
    blockers.push("release_validation_batches_below_minimum");
  }
  if (
    !Array.isArray(reportBody.seasons) ||
    new Set(reportBody.seasons.filter((season) => Number.isSafeInteger(season))).size <
      FIRST_PARTY_ROS_RELEASE_MINIMUM_HELD_OUT_SEASONS
  ) {
    blockers.push("release_validation_held_out_seasons_below_minimum");
  }
  return blockers;
}
