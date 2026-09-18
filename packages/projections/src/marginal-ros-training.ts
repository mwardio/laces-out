import {
  validateFirstPartyRosHeldOutSeasons,
  type FirstPartyRosHeldOutForecast,
  type FirstPartyRosHeldOutSeason,
} from "./rest-of-season.js";
import { sha256Hex } from "./sha256.js";

export const MARGINAL_ROS_TRAINING_COHORT_VERSION = "separate-prior-interval-training-cohort-v1";
const MAX_FORECASTS = 20_000;

/** Separate training provenance; these extra rows never become mean-selection or audit evidence. */
export interface MarginalRosTrainingCohort {
  readonly version: typeof MARGINAL_ROS_TRAINING_COHORT_VERSION;
  readonly seasons: readonly number[];
  readonly evaluationForecasts: number;
  readonly trainingForecasts: number;
  readonly additionalTrainingForecasts: number;
  readonly evaluationRowsChecksum: string;
  readonly trainingRowsChecksum: string;
  /** Diagnostic rows remain in evidence; fitting is never an assertion that they are qualified. */
  readonly diagnostics: {
    readonly zeroScheduledGameForecasts: number;
    readonly contextual: {
      readonly incompleteCoverageForecasts: number;
      readonly unstableForecasts: number;
    };
    readonly recency: {
      readonly incompleteCoverageForecasts: number;
      readonly unstableForecasts: number;
    };
  };
}

function semanticIdentity(row: FirstPartyRosHeldOutForecast): string {
  return JSON.stringify([row.forecastSeason, row.asOfWeek, row.playerId]);
}

function block(row: FirstPartyRosHeldOutForecast): string {
  return JSON.stringify([
    row.forecastSeason,
    row.asOfWeek,
    row.position,
    row.windowStartWeek,
    row.windowEndWeek,
  ]);
}

/** Reconstruct known values so JSONB object-key order cannot change the cohort identity. */
function physicalRow(row: FirstPartyRosHeldOutForecast) {
  const candidate = (value: FirstPartyRosHeldOutForecast["contextual"]) => ({
    meanPoints: value.meanPoints,
    p15Points: value.p15Points,
    p50Points: value.p50Points,
    p85Points: value.p85Points,
  });
  const availability = row.evidence.availability;
  return {
    playerId: row.playerId,
    position: row.position,
    forecastSeason: row.forecastSeason,
    asOfWeek: row.asOfWeek,
    windowStartWeek: row.windowStartWeek,
    windowEndWeek: row.windowEndWeek,
    trainedThroughSeason: row.trainedThroughSeason,
    inputChecksum: row.inputChecksum,
    contextualModelVersion: row.contextualModelVersion,
    recencyModelVersion: row.recencyModelVersion,
    scoringProfileKey: row.scoringProfileKey,
    intervalMethodVersion: row.intervalMethodVersion,
    contextual: candidate(row.contextual),
    recency: candidate(row.recency),
    actualPoints: row.actualPoints,
    coverage: {
      contextual: row.evidence.coverage.contextual,
      recency: row.evidence.coverage.recency,
    },
    availability: {
      scheduledGames: availability.scheduledGames,
      actualGames: availability.actualGames,
      contextualExpectedGames: availability.contextualExpectedGames,
      recencyExpectedGames: availability.recencyExpectedGames,
    },
  };
}

function checkedRows(seasons: readonly FirstPartyRosHeldOutSeason[]) {
  const rows = seasons.flatMap((season) => season.forecasts);
  if (rows.length === 0 || rows.length > MAX_FORECASTS)
    throw new RangeError("Marginal training cohort must contain 1..20000 forecasts");
  const byIdentity = new Map<string, FirstPartyRosHeldOutForecast>();
  for (const row of rows) {
    const games = row.evidence.availability.scheduledGames;
    if (games > Math.min(17, row.windowEndWeek - row.windowStartWeek + 1))
      throw new RangeError("Marginal training games exceed the exact forecast window");
    const identity = semanticIdentity(row);
    if (byIdentity.has(identity))
      throw new Error("Marginal training contains duplicate season/cutoff/player forecasts");
    byIdentity.set(identity, row);
  }
  return byIdentity;
}

function checksum(rows: ReadonlyMap<string, FirstPartyRosHeldOutForecast>): string {
  return sha256Hex(
    JSON.stringify(
      [...rows.entries()]
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([, row]) => ({
          ...physicalRow(row),
          // A broader cohort may select a different convergence sample. Bind its diagnostics
          // separately; never replace the original audit's convergence state with these values.
          convergence: {
            contextual: {
              state: row.evidence.convergence.contextual.state,
              diagnosticChecksum: row.evidence.convergence.contextual.diagnosticChecksum,
            },
            recency: {
              state: row.evidence.convergence.recency.state,
              diagnosticChecksum: row.evidence.convergence.recency.diagnosticChecksum,
            },
          },
        })),
    ),
  );
}

/**
 * Require a physical superset of the frozen audit within the same completed seasons and exact
 * position/cutoff/windows. This validates scope, not source authenticity or release qualification.
 * The chronological evaluator still adds a season only AFTER evaluating that complete season.
 */
export function validateMarginalRosTrainingCohort(
  evaluationSeasons: readonly FirstPartyRosHeldOutSeason[],
  trainingSeasons: readonly FirstPartyRosHeldOutSeason[],
): {
  readonly ordered: readonly FirstPartyRosHeldOutSeason[];
  readonly provenance: MarginalRosTrainingCohort;
} {
  if (
    [...evaluationSeasons, ...trainingSeasons].some(
      (season) => season.complete !== true || season.forecasts.length === 0,
    )
  )
    throw new Error("Explicit marginal training requires nonempty, completed seasons");
  const evaluation = validateFirstPartyRosHeldOutSeasons(evaluationSeasons);
  const training = validateFirstPartyRosHeldOutSeasons(trainingSeasons);
  const seasons = evaluation.ordered.map((season) => season.season);
  if (JSON.stringify(seasons) !== JSON.stringify(training.ordered.map((season) => season.season)))
    throw new Error("Marginal interval training must use exactly the audit's completed seasons");
  if (JSON.stringify(evaluation.evidenceIdentity) !== JSON.stringify(training.evidenceIdentity))
    throw new Error("Marginal training must share the audit's model and scoring identity");
  const auditRows = checkedRows(evaluation.ordered);
  const trainingRows = checkedRows(training.ordered);
  const auditBlocks = new Set([...auditRows.values()].map(block));
  for (const [identity, row] of auditRows) {
    const trained = trainingRows.get(identity);
    if (!trained || JSON.stringify(physicalRow(row)) !== JSON.stringify(physicalRow(trained)))
      throw new Error("Marginal training must preserve every original audit input and target");
  }
  for (const row of trainingRows.values()) {
    if (!auditBlocks.has(block(row)))
      throw new Error("Marginal training cannot introduce a new position/cutoff/window scope");
  }
  const rows = [...trainingRows.values()];
  const diagnostics = (strategy: "contextual" | "recency") => ({
    incompleteCoverageForecasts: rows.filter((row) => row.evidence.coverage[strategy] < 1).length,
    unstableForecasts: rows.filter(
      (row) => row.evidence.convergence[strategy].state !== "converged",
    ).length,
  });
  return {
    ordered: training.ordered,
    provenance: {
      version: MARGINAL_ROS_TRAINING_COHORT_VERSION,
      seasons,
      evaluationForecasts: auditRows.size,
      trainingForecasts: trainingRows.size,
      additionalTrainingForecasts: trainingRows.size - auditRows.size,
      evaluationRowsChecksum: checksum(auditRows),
      trainingRowsChecksum: checksum(trainingRows),
      diagnostics: {
        zeroScheduledGameForecasts: rows.filter(
          (row) => row.evidence.availability.scheduledGames === 0,
        ).length,
        contextual: diagnostics("contextual"),
        recency: diagnostics("recency"),
      },
    },
  };
}
