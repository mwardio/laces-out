import {
  firstPartyProjectionPositionIsSupported,
  projectFirstPartyRecencyBaselineComponents,
  projectFirstPartyWeeklyComponents,
  type FirstPartyProjectionConfig,
  type FirstPartyWeeklyProjection,
  type FirstPartyWeeklyStatLine,
} from "./first-party.js";
import { scoreProjectionStatComponents, type ProjectionScoringProfile } from "./scoring.js";

const ordinal = (row: { season: number; week: number }) => row.season * 25 + row.week;
const supported = (position: string) => ["RB", "WR", "TE"].includes(position);

export interface LineupColdStartForecast {
  readonly actual: FirstPartyWeeklyStatLine;
  readonly model: FirstPartyWeeklyProjection;
  readonly baseline: FirstPartyWeeklyProjection;
}

/** Bounded offline diagnostic; it neither trains a policy nor changes the release population. */
export function buildLineupColdStartForecasts(input: {
  readonly history: readonly FirstPartyWeeklyStatLine[];
  readonly evaluationWeeks: readonly { readonly season: number; readonly week: number }[];
  readonly maximumTargets?: number;
  readonly config?: Partial<FirstPartyProjectionConfig>;
}) {
  const maximumTargets = input.maximumTargets ?? 512;
  if (!Number.isSafeInteger(maximumTargets) || maximumTargets < 1 || maximumTargets > 1_000)
    throw new RangeError("Cold-start diagnostic target limit must be between 1 and 1000");
  const evaluationWeeks = new Set(input.evaluationWeeks.map(ordinal));
  const history = input.history
    .filter((row) => firstPartyProjectionPositionIsSupported(row.position))
    .sort(
      (left, right) =>
        ordinal(left) - ordinal(right) || left.playerId.localeCompare(right.playerId),
    );
  const byWeek = new Map<number, FirstPartyWeeklyStatLine[]>();
  const seenOutcomes = new Set<string>();
  for (const row of history) {
    const key = `${row.playerId}:${ordinal(row)}`;
    if (seenOutcomes.has(key)) throw new Error("Duplicate historical cold-start outcome");
    seenOutcomes.add(key);
    const batch = byWeek.get(ordinal(row)) ?? [];
    batch.push(row);
    byWeek.set(ordinal(row), batch);
  }
  const seenPlayers = new Set<string>();
  const eligible: FirstPartyWeeklyStatLine[] = [];
  for (const [week, batch] of byWeek) {
    for (const row of batch)
      if (evaluationWeeks.has(week) && supported(row.position) && !seenPlayers.has(row.playerId))
        eligible.push(row);
    for (const row of batch) if (row.played !== false) seenPlayers.add(row.playerId);
  }
  // Evenly spaced chronological identities, without reading current-week outcomes or usage.
  const selected =
    eligible.length <= maximumTargets
      ? eligible
      : Array.from(
          { length: maximumTargets },
          (_, index) => eligible[Math.floor(((index + 0.5) * eligible.length) / maximumTargets)]!,
        );
  const forecasts: LineupColdStartForecast[] = [];
  let prior: FirstPartyWeeklyStatLine[] = [];
  let selectedWeek = -1;
  for (const actual of selected) {
    const week = ordinal(actual);
    if (selectedWeek !== week) {
      prior = history.filter((row) => ordinal(row) < week);
      selectedWeek = week;
    }
    const target = {
      playerId: actual.playerId,
      position: actual.position,
      season: actual.season,
      week: actual.week,
      team: actual.team,
      ...(actual.opponent === undefined ? {} : { opponent: actual.opponent }),
    };
    const model = projectFirstPartyWeeklyComponents({
      target,
      history: prior,
      ...(input.config === undefined ? {} : { config: input.config }),
    });
    const baseline = projectFirstPartyRecencyBaselineComponents({
      target,
      history: prior,
      ...(input.config === undefined ? {} : { config: input.config }),
    });
    if (model.coverage.playerGames !== 0 || baseline.coverage.playerGames !== 0)
      throw new Error("Cold-start target unexpectedly has prior player games");
    forecasts.push({ actual, model, baseline });
  }
  return {
    eligibleTargets: eligible.length,
    sampledTargets: forecasts.length,
    sampling: "evenly-spaced-chronological-identities-without-outcome-selection" as const,
    forecasts,
  };
}

export function evaluateLineupColdStartForecasts(
  input: ReturnType<typeof buildLineupColdStartForecasts>,
  profile: ProjectionScoringProfile,
) {
  const mean = (values: readonly number[]) =>
    values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const metrics = (forecasts: readonly LineupColdStartForecast[]) => {
    const usable = forecasts.filter(
      (row) => row.model.state !== "unavailable" && row.baseline.state !== "unavailable",
    );
    const rows = usable.map((row) => ({
      actual: scoreProjectionStatComponents(row.actual.components, profile),
      model: scoreProjectionStatComponents(row.model.components, profile),
      baseline: scoreProjectionStatComponents(row.baseline.components, profile),
    }));
    return {
      sampledTargets: forecasts.length,
      samples: rows.length,
      unavailableTargets: forecasts.length - rows.length,
      modelMae: mean(rows.map((row) => Math.abs(row.model - row.actual))),
      baselineMae: mean(rows.map((row) => Math.abs(row.baseline - row.actual))),
      modelBias: mean(rows.map((row) => row.model - row.actual)),
      baselineBias: mean(rows.map((row) => row.baseline - row.actual)),
      actualMean: mean(rows.map((row) => row.actual)),
      modelMean: mean(rows.map((row) => row.model)),
      baselineMean: mean(rows.map((row) => row.baseline)),
      modelConfidenceMean: mean(usable.map((row) => row.model.quality.confidence)),
      baselineConfidenceMean: mean(usable.map((row) => row.baseline.quality.confidence)),
      modelQualityGrades: Object.fromEntries(
        ["high", "medium", "low", "unavailable"].map((grade) => [
          grade,
          forecasts.filter((row) => row.model.quality.grade === grade).length,
        ]),
      ),
      baselineQualityGrades: Object.fromEntries(
        ["high", "medium", "low", "unavailable"].map((grade) => [
          grade,
          forecasts.filter((row) => row.baseline.quality.grade === grade).length,
        ]),
      ),
    };
  };
  return {
    scoringProfile: profile.id,
    eligibleTargets: input.eligibleTargets,
    sampledTargets: input.sampledTargets,
    sampling: input.sampling,
    comparison: "raw-contextual-model-vs-raw-recency-position-baseline" as const,
    overall: metrics(input.forecasts),
    byPosition: Object.fromEntries(
      ["RB", "WR", "TE"].map((position) => [
        position,
        metrics(input.forecasts.filter((row) => row.actual.position === position)),
      ]),
    ),
    bySeason: Object.fromEntries(
      [...new Set(input.forecasts.map((row) => row.actual.season))]
        .sort((a, b) => a - b)
        .map((season) => [
          season,
          metrics(input.forecasts.filter((row) => row.actual.season === season)),
        ]),
    ),
    withPositionHistory: metrics(
      input.forecasts.filter((row) => row.model.coverage.positionGames > 0),
    ),
    withoutPositionHistory: metrics(
      input.forecasts.filter((row) => row.model.coverage.positionGames === 0),
    ),
    observedAppearances: metrics(input.forecasts.filter((row) => row.actual.played !== false)),
    observedDnp: metrics(input.forecasts.filter((row) => row.actual.played === false)),
    limitations: [
      "Targets come from observed historical roster/appearance outcomes, not a reconstructed pre-kickoff decision universe.",
      "No target-week status, participation, usage, role, or outcomes enter the forecast; only strictly earlier history and the scheduled team/opponent context are used.",
      "No scoring policy, residual center correction, or intervals are fitted here; these raw diagnostics do not qualify a model for publication.",
      "Confidence grades omit historical interval calibration and therefore do not reproduce the confidence attached to live published forecasts.",
    ],
  };
}
