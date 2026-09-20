import type {
  FirstPartyRosPosition,
  ProjectionDefensePointsAllowedDefinition,
  RosProfileDefinition,
} from "@laces-out/projections";
import {
  HISTORICAL_ROS_SUPPORTED_POSITIONS,
  historicalRosBucket,
  type HistoricalRosBacktestResult,
} from "./first-party-ros-backtest.js";
import { firstPartyRosChampionPolicyChecksum } from "./first-party-ros-publication.js";
import { ROS_HISTORICAL_ACTUAL_DEFINITION_VERSION } from "./ros-historical-corpus.js";
import type { RosHistoricalCoverageReport } from "./ros-data-coverage.js";

/** Deterministic scalar report projection matching the native CLI, without process or clock state. */
export function buildRosDerivedReplayReport(input: {
  readonly result: HistoricalRosBacktestResult;
  readonly positions: readonly FirstPartyRosPosition[] | undefined;
  readonly scoringProfile: RosProfileDefinition;
  readonly coverage: RosHistoricalCoverageReport;
  readonly sourceAudit: readonly Readonly<Record<string, string | number>>[];
  readonly outcomeCorpusIdentity?: string;
  readonly pointsAllowedDefinition: ProjectionDefensePointsAllowedDefinition;
}): Record<string, unknown> {
  const {
    result,
    positions,
    scoringProfile,
    coverage,
    sourceAudit,
    outcomeCorpusIdentity,
    pointsAllowedDefinition,
  } = input;
  // Signed expected-games bias per selected strategy and cell (row-weighted, diagnostic-only):
  // the release gate uses block-weighted MAE, but a signed view identifies systematic hazard
  // mismatch before any threshold tuning is considered.
  const meanOf = (values: readonly number[]): number =>
    values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
  const availabilityAudit = result.champion.livePolicy.choices.map((choice) => {
    const rows = result.heldOutSeasons.flatMap((season) =>
      season.forecasts.filter(
        (forecast) =>
          forecast.position === choice.position &&
          historicalRosBucket(forecast.windowStartWeek, forecast.windowEndWeek) === choice.bucket,
      ),
    );
    const selected = choice.strategy === "contextual" ? "contextual" : "recency";
    const errors = rows.map((forecast) => {
      const expected =
        selected === "contextual"
          ? forecast.evidence.availability.contextualExpectedGames
          : forecast.evidence.availability.recencyExpectedGames;
      return expected - forecast.evidence.availability.actualGames;
    });
    return {
      position: choice.position,
      bucket: choice.bucket,
      strategy: choice.strategy,
      rows: rows.length,
      signedExpectedGamesBias: meanOf(errors),
      expectedGamesRowMae: meanOf(errors.map((error) => Math.abs(error))),
    };
  });
  const output = {
    validationMode: "read-only-first-party-ros-backtest",
    validationScope: {
      positions: positions ?? HISTORICAL_ROS_SUPPORTED_POSITIONS,
      completePortfolio: positions === undefined,
    },
    generatedAt: "1970-01-01T00:00:00.000Z",
    elapsedSeconds: 0,
    noDatabaseWrites: true,
    sourcePolicy: "official-nflverse-artifacts",
    actualDefinitionVersion: ROS_HISTORICAL_ACTUAL_DEFINITION_VERSION,
    pointsAllowedDefinition,
    ...(outcomeCorpusIdentity ? { outcomeCorpusIdentity } : {}),
    // Recorded so a report can never be misattributed to a profile it was not graded under. The
    // authoritative identity remains `identityAudit.scoringProfileKey`, which admission compares.
    scoringProfile: {
      key: scoringProfile.key,
      label: scoringProfile.label,
      digest: scoringProfile.digest,
    },
    availabilityAudit,
    coverage: {
      state: coverage.state,
      fullyHeldOutSeasons: coverage.fullyHeldOutSeasons,
      completeAsOfBatches: coverage.completeAsOfBatches,
      totalAsOfBatches: coverage.totalAsOfBatches,
    },
    report: result.report,
    identityAudit: {
      inputChecksums: new Set(
        result.heldOutSeasons.flatMap((season) =>
          season.forecasts.map((forecast) => forecast.inputChecksum),
        ),
      ).size,
      contextualConvergenceChecksums: new Set(
        result.heldOutSeasons.flatMap((season) =>
          season.forecasts.map(
            (forecast) => forecast.evidence.convergence.contextual.diagnosticChecksum,
          ),
        ),
      ).size,
      recencyConvergenceChecksums: new Set(
        result.heldOutSeasons.flatMap((season) =>
          season.forecasts.map(
            (forecast) => forecast.evidence.convergence.recency.diagnosticChecksum,
          ),
        ),
      ).size,
      scoringProfileKey: result.champion.livePolicy.evidenceIdentity?.scoringProfileKey ?? null,
      contextualModelVersion:
        result.champion.livePolicy.evidenceIdentity?.contextualModelVersion ?? null,
      recencyModelVersion: result.champion.livePolicy.evidenceIdentity?.recencyModelVersion ?? null,
      intervalMethodVersion:
        result.champion.livePolicy.evidenceIdentity?.intervalMethodVersion ?? null,
    },
    champion: {
      policyVersion: result.champion.livePolicy.policyVersion,
      meanSelectionEvidenceVersion: result.champion.livePolicy.meanSelectionEvidenceVersion,
      legacyPointImprovementMetric: result.champion.livePolicy.legacyPointImprovementMetric,
      modelVersion: result.champion.livePolicy.modelVersion,
      evidenceThroughSeason: result.champion.livePolicy.evidenceThroughSeason,
      globalBatches: result.champion.livePolicy.globalBatches,
      evidenceIdentity: result.champion.livePolicy.evidenceIdentity,
      publicationPolicyChecksum: firstPartyRosChampionPolicyChecksum(result.champion.livePolicy),
      choices: result.champion.livePolicy.choices.map((choice) => {
        const selected = choice.strategy === "contextual" ? "contextual" : "recency";
        const calibration = choice.intervalCalibrationArtifacts[selected];
        const walkForward = choice.walkForwardCalibrationEvidence[selected];
        return {
          position: choice.position,
          bucket: choice.bucket,
          strategy: choice.strategy,
          reason: choice.reason,
          heldOutSeasons: choice.heldOutSeasons,
          batches: choice.batches,
          samples: choice.samples,
          legacyPointImprovementMetric: "mean-absolute-error",
          contextualMae: choice.contextualMae,
          recencyMae: choice.recencyMae,
          meanSelectionEvidence: choice.meanSelectionEvidence,
          modelImprovement: choice.modelImprovement,
          modelImprovementLowerBound: choice.modelImprovementLowerBound,
          intervalScoreDifferenceUpperBound: choice.intervalScoreDifferenceUpperBound,
          inputCoverage: {
            contextual: choice.heldOutEvidence.contextualMeanInputCoverage,
            recency: choice.heldOutEvidence.recencyMeanInputCoverage,
          },
          convergenceRate: {
            contextual: choice.heldOutEvidence.contextualConvergenceRate,
            recency: choice.heldOutEvidence.recencyConvergenceRate,
          },
          // Uncalibrated simulation-interval hit rates; the release gate judges only the
          // CQR-calibrated walk-forward coverage, but the raw rate shows how much work the
          // conformal expansion is doing.
          observedIntervalCoverage: {
            contextual: choice.heldOutEvidence.contextualObservedIntervalCoverage,
            recency: choice.heldOutEvidence.recencyObservedIntervalCoverage,
          },
          intervalCalibration: choice.intervalCalibration,
          selectedCalibrationState: calibration.state,
          selectedCalibrationCorrectionPoints: calibration.adjustmentPoints,
          selectedHeldOutEvidence: {
            state: choice.heldOutEvidence.state,
            inputCoverage:
              selected === "contextual"
                ? choice.heldOutEvidence.contextualMeanInputCoverage
                : choice.heldOutEvidence.recencyMeanInputCoverage,
            availabilityMae:
              selected === "contextual"
                ? choice.heldOutEvidence.contextualAvailabilityMae
                : choice.heldOutEvidence.recencyAvailabilityMae,
            availabilityBias:
              selected === "contextual"
                ? choice.heldOutEvidence.contextualAvailabilityBias
                : choice.heldOutEvidence.recencyAvailabilityBias,
            convergenceRate:
              selected === "contextual"
                ? choice.heldOutEvidence.contextualConvergenceRate
                : choice.heldOutEvidence.recencyConvergenceRate,
          },
          walkForwardCalibration: {
            state: walkForward.state,
            seasons: walkForward.seasons,
            blocks: walkForward.blocks,
            samples: walkForward.samples,
            observedBlockCoverage: walkForward.observedBlockCoverage,
            nominalCoverage: calibration.nominalCoverage,
            coverageShortfall: calibration.nominalCoverage - walkForward.observedBlockCoverage,
          },
        };
      }),
    },
    // Admission needs the exact executable policy, including immutable calibration artifacts and
    // their checksums. `champion` above remains the concise human-audit summary; it must never be
    // cast back into this richer runtime contract.
    publicationPolicy: result.champion.livePolicy,
    diagnostics: {
      seasonPolicies: result.champion.seasonPolicies.map((audit) => ({
        season: audit.season,
        evidenceThroughSeason: audit.evidenceThroughSeason,
        choices: audit.policy.choices
          .filter((choice) => positions === undefined || positions.includes(choice.position))
          .map((choice) => ({
            position: choice.position,
            bucket: choice.bucket,
            strategy: choice.strategy,
            reason: choice.reason,
            contextualCalibration: choice.intervalCalibrationArtifacts.contextual,
            recencyCalibration: choice.intervalCalibrationArtifacts.recency,
          })),
      })),
      selected: result.champion.selected.filter(
        (row) => positions === undefined || positions.includes(row.position),
      ),
      // Bounded per-forecast scalar summaries/evidence only; no scenario vectors or histories.
      candidateForecasts: result.heldOutSeasons.flatMap((season) => season.forecasts),
    },
    sources: sourceAudit,
  };
  return output;
}
