import {
  marginalIntervalArtifactIsValid,
  marginalIntervalArtifactSeriesKey,
} from "./marginal-interval-artifact.js";
import {
  marginalIntervalComparisonIsValid,
  type MarginalIntervalComparisonCell,
} from "./marginal-interval-comparison.js";
import {
  evaluateMarginalIntervalEvidence,
  validateMarginalIntervalEvidence,
  type MarginalIntervalFraction,
} from "./marginal-interval-evidence.js";
import {
  applyFirstPartyRosIntervalCalibration,
  firstPartyRosMeanSelectionEvidenceIsValid,
  type FirstPartyRosChampionChoice,
} from "./rest-of-season.js";
import type { RosMarginalIntervalQualification } from "./ros-marginal-interval-qualification.js";
import { projectionScoringRulesFromProfileKey } from "./scoring-position-keys.js";
import { sha256Hex } from "./sha256.js";

export const ROS_MARGINAL_INTERVAL_STORAGE_VERSION = "ros-marginal-interval-storage-v1";
const QUALIFICATION = "ros-marginal-interval-qualification-v1";
const LEGACY_POLICY = "season-walk-forward-mean-rmse-block-wis-cqr-v7";
const MARGINAL_POLICY = "season-walk-forward-mean-rmse-marginal-quantiles-v8";
const METHOD = "season-prior-weighted-quantile-residuals-v1";
const MAX_ROWS = 20_000;
const MEAN_OPTIONS = {
  minimumHeldOutSeasons: 3,
  minimumBatches: 30,
  minimumSamples: 300,
  minimumCellSeasons: 3,
  minimumCellSamples: 18,
  minimumCellCutoffs: 3,
  minimumCellBatches: 9,
  minimumModelImprovement: 0.01,
} as const;

function fail(message: string): never {
  throw new Error(`ROS marginal interval storage: ${message}`);
}
function check(condition: unknown, message = "inconsistent receipt"): asserts condition {
  if (!condition) fail(message);
}
function object(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  check(value !== null && typeof value === "object" && !Array.isArray(value), "invalid object");
  check(
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)),
    "unknown or missing fields",
  );
}
function array(value: unknown, min: number, max: number): asserts value is readonly unknown[] {
  check(Array.isArray(value) && value.length >= min && value.length <= max, "invalid array");
  check(Object.keys(value).length === value.length, "non-dense array");
  for (let index = 0; index < value.length; index++) check(Object.hasOwn(value, index));
}
function integer(value: unknown, min = 0, max = MAX_ROWS): asserts value is number {
  check(
    Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max,
    "invalid count",
  );
}
function finite(value: unknown, min = -Infinity, max = Infinity): asserts value is number {
  check(
    typeof value === "number" && Number.isFinite(value) && value >= min && value <= max,
    "invalid metric",
  );
}
function digest(value: unknown): asserts value is string {
  check(typeof value === "string" && /^[a-f0-9]{64}$/u.test(value), "invalid checksum");
}
function text(value: unknown, max = 256): asserts value is string {
  check(
    typeof value === "string" && value.trim().length > 0 && value.length <= max,
    "invalid identity",
  );
}
// Bound traversal before handing unknown JSON to existing compact validators or hashing it.
function boundedJson(value: unknown): void {
  const parents = new Set<object>();
  let nodes = 0;
  const visit = (entry: unknown, depth: number) => {
    check(++nodes <= 500_000 && depth <= 16, "receipt exceeds JSON bounds");
    if (entry === null || typeof entry === "boolean") return;
    if (typeof entry === "string") {
      check(entry.length <= 65_536);
      return;
    }
    if (typeof entry === "number") {
      finite(entry);
      return;
    }
    check(typeof entry === "object", "non-JSON value");
    check(!parents.has(entry), "cyclic receipt");
    parents.add(entry);
    if (Array.isArray(entry)) {
      array(entry, 0, MAX_ROWS);
      for (const child of entry) visit(child, depth + 1);
    } else {
      check(
        Object.getPrototypeOf(entry) === Object.prototype || Object.getPrototypeOf(entry) === null,
      );
      let count = 0;
      for (const key in entry)
        if (Object.hasOwn(entry, key)) {
          check(++count <= 64 && key.length <= 256, "object exceeds bounds");
          visit((entry as Record<string, unknown>)[key], depth + 1);
        }
    }
    parents.delete(entry);
  };
  visit(value, 0);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function equal(left: unknown, right: unknown): void {
  check(canonical(left) === canonical(right));
}
function hash(value: unknown): string {
  return sha256Hex(canonical(value));
}
function checksum(value: object, key: string): void {
  const body = { ...value } as Record<string, unknown>;
  const received = body[key];
  digest(received);
  delete body[key];
  check(hash(body) === received, "checksum mismatch");
}
function cellKey(value: MarginalIntervalComparisonCell): string {
  object(value, ["position", "bucket"]);
  check(["QB", "RB", "WR", "TE", "K", "DST"].includes(value.position));
  check(["one-to-four", "five-to-eight", "nine-plus"].includes(value.bucket));
  return `${value.position}:${value.bucket}`;
}
function cells(value: readonly MarginalIntervalComparisonCell[]): void {
  array(value, 1, 18);
  check(new Set(value.map(cellKey)).size === value.length, "duplicate cells");
}
function years(value: readonly number[], min: number): void {
  array(value, min, 201);
  let prior = 1999;
  for (const year of value) {
    integer(year, prior + 1, 2200);
    prior = year;
  }
}
function strategy(value: unknown): void {
  check(value === "contextual" || value === "availability-aware-recency");
}
function identity(value: unknown): void {
  object(value, [
    "contextualModelVersion",
    "recencyModelVersion",
    "scoringProfileKey",
    "intervalMethodVersion",
  ]);
  for (const key of ["contextualModelVersion", "recencyModelVersion", "intervalMethodVersion"])
    text(value[key]);
  text(value.scoringProfileKey, 65_536);
}

function meanChoice(
  choice: FirstPartyRosChampionChoice,
  receipt: RosMarginalIntervalQualification,
  previous: boolean,
): void {
  object(choice, [
    "position",
    "bucket",
    "strategy",
    "reason",
    "heldOutSeasons",
    "batches",
    "globalBatches",
    "globalSeasons",
    "globalSamples",
    "distinctCutoffs",
    "samples",
    "contextualMae",
    "recencyMae",
    "contextualWeightedIntervalScore",
    "recencyWeightedIntervalScore",
    "modelImprovement",
    "meanSelectionEvidence",
    "pairedBlocks",
    "modelImprovementLowerBound",
    "intervalScoreDifferenceUpperBound",
    "uncertaintyMethod",
    "heldOutEvidence",
    "intervalCalibrationArtifacts",
    "walkForwardCalibrationEvidence",
    "intervalCalibration",
  ]);
  equal({ position: choice.position, bucket: choice.bucket }, receipt.cell);
  strategy(choice.strategy);
  check(choice.strategy === (previous ? receipt.previousStrategy : receipt.strategy));
  check(choice.uncertaintyMethod === "paired-season-clustered-one-sided-95");
  for (const key of [
    "heldOutSeasons",
    "batches",
    "globalBatches",
    "globalSeasons",
    "globalSamples",
    "distinctCutoffs",
    "samples",
    "pairedBlocks",
  ] as const)
    integer(choice[key]);
  for (const key of [
    "contextualMae",
    "recencyMae",
    "contextualWeightedIntervalScore",
    "recencyWeightedIntervalScore",
  ] as const)
    finite(choice[key], 0);
  finite(choice.modelImprovement);
  for (const metric of [
    choice.modelImprovementLowerBound,
    choice.intervalScoreDifferenceUpperBound,
  ])
    if (metric !== null) finite(metric);
  const mean = choice.meanSelectionEvidence;
  object(mean, [
    "version",
    "state",
    "target",
    "loss",
    "weighting",
    "uncertaintyMethod",
    "minimumRelativeRmseImprovement",
    "squaredLossBaselineMultiplier",
    "seasons",
    "blocks",
    "samples",
    "seasonEvidence",
    "contextualMse",
    "recencyMse",
    "contextualRmse",
    "recencyRmse",
    "relativeRmseImprovement",
    "marginMean",
    "marginStandardError",
    "marginLowerBound",
    "clearsMeanMargin",
  ]);
  array(mean.seasonEvidence, 4, 201);
  for (const row of mean.seasonEvidence) {
    object(row, ["season", "blocks", "samples", "contextualMse", "recencyMse"]);
    integer(row.blocks, 1, 18);
    integer(row.samples, row.blocks);
  }
  check(firstPartyRosMeanSelectionEvidenceIsValid(mean, 0.01), "invalid frozen mean proof");
  equal(
    mean.seasonEvidence.map((row) => row.season),
    receipt.sourceScope.sourceSeasons,
  );
  check(
    mean.samples === choice.samples &&
      mean.blocks === choice.batches &&
      mean.seasons === choice.heldOutSeasons,
  );
  check(
    choice.globalSeasons === choice.heldOutSeasons &&
      choice.globalSamples >= choice.samples &&
      choice.globalBatches >= choice.batches,
  );
  check(
    choice.pairedBlocks === choice.batches &&
      choice.distinctCutoffs >= 1 &&
      choice.distinctCutoffs <= 17,
  );
  const global =
    choice.globalSeasons >= 3 && choice.globalBatches >= 30 && choice.globalSamples >= 300;
  const local =
    choice.heldOutSeasons >= 3 &&
    choice.samples >= 18 &&
    choice.distinctCutoffs >= 3 &&
    choice.batches >= 9;
  const available =
    global &&
    local &&
    mean.state === "available" &&
    choice.intervalScoreDifferenceUpperBound !== null;
  const clears =
    available && mean.clearsMeanMargin && choice.intervalScoreDifferenceUpperBound <= 0;
  check(
    choice.strategy === (clears ? "contextual" : "availability-aware-recency"),
    "mean strategy mismatch",
  );
  check(
    choice.reason ===
      (!global
        ? "insufficient-global-evidence"
        : !local
          ? "sparse-cell"
          : !available
            ? "insufficient-statistical-evidence"
            : clears
              ? "model-cleared-margin"
              : "baseline-defended"),
  );
  const held = choice.heldOutEvidence;
  object(held, [
    "state",
    "evidenceChecksum",
    "nominalCentralIntervalCoverage",
    "contextualObservedIntervalCoverage",
    "recencyObservedIntervalCoverage",
    "contextualMeanInputCoverage",
    "recencyMeanInputCoverage",
    "contextualAvailabilityMae",
    "recencyAvailabilityMae",
    "contextualAvailabilityBias",
    "recencyAvailabilityBias",
    "contextualConvergenceRate",
    "recencyConvergenceRate",
    "seasons",
    "blocks",
    "samples",
    "intervalCalibration",
  ]);
  check(held.state === (available ? "derived-immutable-not-calibrated" : "insufficient-evidence"));
  digest(held.evidenceChecksum);
  check(
    held.nominalCentralIntervalCoverage === 0.7 && held.intervalCalibration === "not-calibrated",
  );
  for (const key of [
    "contextualObservedIntervalCoverage",
    "recencyObservedIntervalCoverage",
    "contextualMeanInputCoverage",
    "recencyMeanInputCoverage",
    "contextualConvergenceRate",
    "recencyConvergenceRate",
  ] as const)
    finite(held[key], 0, 1);
  for (const key of ["contextualAvailabilityMae", "recencyAvailabilityMae"] as const)
    finite(held[key], 0);
  finite(held.contextualAvailabilityBias);
  finite(held.recencyAvailabilityBias);
  check(
    held.seasons === choice.heldOutSeasons &&
      held.blocks === choice.batches &&
      held.samples === choice.samples,
  );
  object(choice.intervalCalibrationArtifacts, ["contextual", "recency"]);
  object(choice.walkForwardCalibrationEvidence, ["contextual", "recency"]);
  for (const name of ["contextual", "recency"] as const) {
    const artifact = choice.intervalCalibrationArtifacts[name];
    object(artifact, [
      "state",
      "calibrationVersion",
      "strategy",
      "position",
      "bucket",
      "evidenceIdentity",
      "nominalCoverage",
      "lowerQuantile",
      "upperQuantile",
      "adjustmentPoints",
      "observedCalibratedBlockCoverage",
      "trainedThroughSeason",
      "seasons",
      "blocks",
      "samples",
      "evidenceChecksum",
      "artifactChecksum",
    ]);
    check(
      artifact.calibrationVersion === "season-blocked-split-conformal-cqr-v1" &&
        artifact.lowerQuantile === 0.15 &&
        artifact.upperQuantile === 0.85,
    );
    check(
      artifact.strategy === (name === "contextual" ? "contextual" : "availability-aware-recency"),
    );
    equal({ position: artifact.position, bucket: artifact.bucket }, receipt.cell);
    check(
      artifact.trainedThroughSeason === receipt.comparisonSeason &&
        artifact.seasons === choice.heldOutSeasons &&
        artifact.blocks === choice.batches &&
        artifact.samples === choice.samples,
    );
    if (artifact.evidenceIdentity !== null) {
      identity(artifact.evidenceIdentity);
      if (!previous)
        equal(artifact.evidenceIdentity, receipt.liveArtifact.context.evidenceIdentity);
      const source = receipt.sources[previous ? "previous" : "candidate"].source;
      check(artifact.evidenceIdentity.scoringProfileKey === source.scoringProfileKey);
      check(
        artifact.evidenceIdentity.contextualModelVersion.startsWith(
          `${source.modelVersion}:contextual:`,
        ),
      );
      check(
        artifact.evidenceIdentity.recencyModelVersion.startsWith(
          `${source.modelVersion}:availability-aware-recency:`,
        ),
      );
    }
    finite(artifact.adjustmentPoints, 0);
    finite(artifact.observedCalibratedBlockCoverage, 0, 1);
    check(artifact.evidenceChecksum === held.evidenceChecksum);
    check([0.7, 0.8, 0.85].includes(artifact.nominalCoverage));
    if (artifact.state === "calibrated") {
      check(
        applyFirstPartyRosIntervalCalibration(
          { p15Points: 0, p50Points: 0, p85Points: 0 },
          artifact,
        ).intervalCalibration === "split-conformal-cqr",
        "invalid retained legacy artifact",
      );
    } else {
      check(
        artifact.state === "not-calibrated" &&
          artifact.artifactChecksum === null &&
          artifact.adjustmentPoints === 0 &&
          artifact.observedCalibratedBlockCoverage === 0,
      );
    }
    const walk = choice.walkForwardCalibrationEvidence[name];
    object(walk, [
      "state",
      "observedBlockCoverage",
      "seasons",
      "blocks",
      "samples",
      "evidenceChecksum",
    ]);
    for (const count of [walk.seasons, walk.blocks, walk.samples]) integer(count);
    finite(walk.observedBlockCoverage, 0, 1);
    check(
      walk.seasons <= choice.heldOutSeasons &&
        walk.blocks <= choice.batches &&
        walk.samples <= choice.samples,
    );
    if (walk.state === "available") {
      digest(walk.evidenceChecksum);
      check(walk.seasons > 0 && walk.blocks > 0 && walk.samples > 0);
    } else
      check(
        walk.state === "unavailable" &&
          walk.evidenceChecksum === null &&
          walk.seasons === 0 &&
          walk.blocks === 0 &&
          walk.samples === 0 &&
          walk.observedBlockCoverage === 0,
      );
  }
  const selected =
    choice.intervalCalibrationArtifacts[
      choice.strategy === "contextual" ? "contextual" : "recency"
    ];
  check(
    choice.intervalCalibration ===
      (selected.state === "calibrated" ? "split-conformal-cqr" : "not-calibrated"),
  );
}

function validateQualification(value: unknown): asserts value is RosMarginalIntervalQualification {
  boundedJson(value);
  object(value, [
    "schemaVersion",
    "qualificationMethod",
    "state",
    "interpretation",
    "canAuthorizeRelease",
    "scope",
    "cell",
    "forecastSeason",
    "requiredEvaluationSeasons",
    "comparisonSeason",
    "strategy",
    "previousStrategy",
    "meanSelectorPolicyVersion",
    "meanSelectorOptions",
    "meanChoice",
    "previousMeanChoice",
    "sourceScope",
    "sources",
    "intervalTraining",
    "liveArtifact",
    "historicalArtifacts",
    "evidence",
    "comparison",
    "linkage",
    "reasons",
    "qualificationChecksum",
  ]);
  const receipt = value as unknown as RosMarginalIntervalQualification;
  check(
    receipt.schemaVersion === 1 &&
      receipt.qualificationMethod === QUALIFICATION &&
      receipt.interpretation === "historical-descriptive" &&
      receipt.canAuthorizeRelease === false &&
      receipt.scope === "final-live-fixed-strategy-cell",
  );
  integer(receipt.forecastSeason, 2000, 2200);
  cellKey(receipt.cell);
  strategy(receipt.strategy);
  strategy(receipt.previousStrategy);
  check(receipt.meanSelectorPolicyVersion === LEGACY_POLICY);
  equal(receipt.meanSelectorOptions, MEAN_OPTIONS);
  const scope = receipt.sourceScope;
  object(scope, [
    "sourceSeasons",
    "requiredCells",
    "protocolChecksum",
    "sourceManifestChecksum",
    "fullReportChecksum",
    "identityAmendment",
  ]);
  years(scope.sourceSeasons, 4);
  cells(scope.requiredCells);
  check(scope.requiredCells.some((cell) => cellKey(cell) === cellKey(receipt.cell)));
  for (const pin of [
    scope.protocolChecksum,
    scope.sourceManifestChecksum,
    scope.fullReportChecksum,
  ])
    digest(pin);
  check(
    scope.identityAmendment === "none" ||
      scope.identityAmendment === "previous-defense-la-to-lar-v1",
  );
  equal(receipt.requiredEvaluationSeasons, scope.sourceSeasons.slice(1));
  check(
    receipt.comparisonSeason === scope.sourceSeasons.at(-1) &&
      receipt.forecastSeason > receipt.comparisonSeason,
  );
  object(receipt.sources, ["candidate", "previous", "intervalTraining"]);
  for (const source of [
    receipt.sources.candidate,
    receipt.sources.previous,
    receipt.sources.intervalTraining,
  ]) {
    if (source === null) continue;
    object(source, ["source", "sourceManifestChecksum", "rowsChecksum"]);
    object(source.source, [
      "modelVersion",
      "policyVersion",
      "scoringProfileKey",
      "physicalCorpusChecksum",
      "reportChecksum",
    ]);
    text(source.source.modelVersion);
    text(source.source.scoringProfileKey, 65_536);
    check(
      source.source.policyVersion === LEGACY_POLICY &&
        source.sourceManifestChecksum === scope.sourceManifestChecksum,
    );
    for (const pin of [
      source.rowsChecksum,
      source.source.physicalCorpusChecksum,
      source.source.reportChecksum,
    ])
      digest(pin);
  }
  check(
    receipt.sources.candidate.source.scoringProfileKey ===
      receipt.sources.previous.source.scoringProfileKey,
  );
  const training = receipt.intervalTraining;
  check((training === null) === (receipt.sources.intervalTraining === null));
  if (training !== null) {
    object(training, [
      "version",
      "seasons",
      "evaluationForecasts",
      "trainingForecasts",
      "additionalTrainingForecasts",
      "evaluationRowsChecksum",
      "trainingRowsChecksum",
      "diagnostics",
    ]);
    check(training.version === "separate-prior-interval-training-cohort-v1");
    equal(training.seasons, scope.sourceSeasons);
    integer(training.evaluationForecasts, 1);
    integer(training.trainingForecasts, training.evaluationForecasts);
    check(
      training.additionalTrainingForecasts ===
        training.trainingForecasts - training.evaluationForecasts,
    );
    check(
      training.evaluationRowsChecksum === receipt.sources.candidate.rowsChecksum &&
        training.trainingRowsChecksum === receipt.sources.intervalTraining!.rowsChecksum,
    );
    const source = receipt.sources.intervalTraining!.source;
    check(
      source.modelVersion === receipt.sources.candidate.source.modelVersion &&
        source.scoringProfileKey === receipt.sources.candidate.source.scoringProfileKey,
    );
    check(
      source.physicalCorpusChecksum !== receipt.sources.candidate.source.physicalCorpusChecksum &&
        source.physicalCorpusChecksum !== receipt.sources.previous.source.physicalCorpusChecksum,
    );
    object(training.diagnostics, ["zeroScheduledGameForecasts", "contextual", "recency"]);
    integer(training.diagnostics.zeroScheduledGameForecasts, 0, training.trainingForecasts);
    for (const metrics of [training.diagnostics.contextual, training.diagnostics.recency]) {
      object(metrics, ["incompleteCoverageForecasts", "unstableForecasts"]);
      integer(metrics.incompleteCoverageForecasts, 0, training.trainingForecasts);
      integer(metrics.unstableForecasts, 0, training.trainingForecasts);
    }
  }
  check(
    marginalIntervalArtifactIsValid(receipt.liveArtifact) &&
      receipt.liveArtifact.fit.state === "fitted",
  );
  const live = receipt.liveArtifact;
  equal({ position: live.context.position, bucket: live.context.bucket }, receipt.cell);
  check(
    live.context.strategy === receipt.strategy &&
      live.fit.forecastSeason === receipt.forecastSeason,
  );
  equal(live.fit.priorSeasons, scope.sourceSeasons);
  check(
    live.context.evidenceIdentity.scoringProfileKey ===
      receipt.sources.candidate.source.scoringProfileKey,
  );
  check(
    live.context.evidenceIdentity.contextualModelVersion.startsWith(
      `${receipt.sources.candidate.source.modelVersion}:contextual:`,
    ),
  );
  check(
    live.context.evidenceIdentity.recencyModelVersion.startsWith(
      `${receipt.sources.candidate.source.modelVersion}:availability-aware-recency:`,
    ),
  );
  array(
    receipt.historicalArtifacts,
    receipt.requiredEvaluationSeasons.length,
    receipt.requiredEvaluationSeasons.length,
  );
  for (const [index, entry] of receipt.historicalArtifacts.entries()) {
    object(entry, ["forecastSeason", "artifact"]);
    check(entry.forecastSeason === receipt.requiredEvaluationSeasons[index]);
    check(marginalIntervalArtifactIsValid(entry.artifact) && entry.artifact.fit.state === "fitted");
    equal(entry.artifact.context, live.context);
    check(entry.artifact.fit.forecastSeason === entry.forecastSeason);
    equal(entry.artifact.fit.priorSeasons, scope.sourceSeasons.slice(0, index + 1));
  }
  const evidence = validateMarginalIntervalEvidence(receipt.evidence);
  check(evidence.seriesKey === marginalIntervalArtifactSeriesKey(live.context));
  equal(
    evidence.perSeason.map((row) => row.forecastSeason),
    receipt.requiredEvaluationSeasons,
  );
  for (const season of evidence.perSeason)
    check(
      season.blocks >= 3 && season.distinctCutoffs >= 3 && season.samples >= 18,
      "insufficient annual support",
    );
  for (const block of evidence.blocks) {
    const artifact = receipt.historicalArtifacts.find(
      (entry) => entry.forecastSeason === block.forecastSeason,
    )!.artifact;
    check(
      block.artifactChecksum === artifact.artifactChecksum &&
        block.trainedThroughSeason === artifact.fit.priorSeasons.at(-1),
    );
    const span = block.windowEndWeek - block.windowStartWeek + 1;
    check(
      (span <= 4 ? "one-to-four" : span <= 8 ? "five-to-eight" : "nine-plus") ===
        receipt.cell.bucket,
    );
  }
  check(marginalIntervalComparisonIsValid(receipt.comparison));
  const comparison = receipt.comparison;
  check(
    comparison.scope === "final-live-cell" &&
      comparison.evaluationSeason === receipt.comparisonSeason &&
      comparison.cells.length === 1,
  );
  equal(
    { position: comparison.cells[0]!.position, bucket: comparison.cells[0]!.bucket },
    receipt.cell,
  );
  equal(comparison.candidateSource, {
    ...receipt.sources.candidate.source,
    policyVersion: MARGINAL_POLICY,
  });
  equal(comparison.benchmarkSources["same-physics-legacy"], receipt.sources.candidate.source);
  equal(comparison.benchmarkSources["previous-deployed"], receipt.sources.previous.source);
  const latest = evidence.blocks.filter(
    (block) => block.forecastSeason === receipt.comparisonSeason,
  );
  check(latest.length === comparison.cells[0]!.blocks.length);
  array(receipt.linkage, evidence.blocks.length, evidence.blocks.length);
  for (const [index, link] of receipt.linkage.entries()) {
    object(link, [
      "forecastSeason",
      "asOfWeek",
      "samples",
      "observationChecksum",
      "correctedRowsChecksum",
      "comparisonCandidateRowsChecksum",
      "evidenceSourceRowsChecksum",
      "comparisonRowsChecksum",
    ]);
    const block = evidence.blocks[index]!;
    check(
      link.forecastSeason === block.forecastSeason &&
        link.asOfWeek === block.asOfWeek &&
        link.samples === block.samples &&
        link.evidenceSourceRowsChecksum === block.sourceRowsChecksum,
    );
    digest(link.observationChecksum);
    digest(link.correctedRowsChecksum);
    if (link.forecastSeason === receipt.comparisonSeason) {
      const matched = comparison.cells[0]!.blocks.find((entry) => entry.asOfWeek === link.asOfWeek);
      check(
        matched &&
          matched.samples === link.samples &&
          matched.windowStartWeek === block.windowStartWeek &&
          matched.windowEndWeek === block.windowEndWeek,
      );
      check(
        link.comparisonRowsChecksum === matched.rowsChecksum &&
          link.comparisonCandidateRowsChecksum === link.correctedRowsChecksum,
      );
    } else
      check(link.comparisonRowsChecksum === null && link.comparisonCandidateRowsChecksum === null);
  }
  meanChoice(receipt.meanChoice, receipt, false);
  meanChoice(receipt.previousMeanChoice, receipt, true);
  const auditYears = receipt.meanChoice.meanSelectionEvidence.seasonEvidence;
  equal(
    receipt.previousMeanChoice.meanSelectionEvidence.seasonEvidence.map(
      ({ season, blocks, samples }) => ({ season, blocks, samples }),
    ),
    auditYears.map(({ season, blocks, samples }) => ({ season, blocks, samples })),
  );
  for (const season of evidence.perSeason) {
    const audit = auditYears.find((entry) => entry.season === season.forecastSeason)!;
    check(
      audit.samples === season.samples && audit.blocks === season.blocks,
      "audit/mean cohort support mismatch",
    );
  }
  for (const artifact of [live, ...receipt.historicalArtifacts.map((entry) => entry.artifact)]) {
    const prior = auditYears.filter((entry) => entry.season < artifact.fit.forecastSeason);
    // Warmup can contain zero-schedule rows, which the fit intentionally excludes. Every
    // reconstructed held-out interval has positive schedule, so those prior rows are a floor.
    const evaluated = prior.filter((entry) =>
      receipt.requiredEvaluationSeasons.includes(entry.season),
    );
    check(artifact.fit.blocks >= evaluated.reduce((total, entry) => total + entry.blocks, 0));
    check(artifact.fit.blocks <= prior.reduce((total, entry) => total + entry.blocks, 0));
    check(artifact.fit.samples >= evaluated.reduce((total, entry) => total + entry.samples, 0));
    check(
      artifact.fit.samples <=
        (training === null
          ? prior.reduce((total, entry) => total + entry.samples, 0)
          : training.trainingForecasts),
    );
  }
  check(live.fit.distinctCutoffs <= receipt.meanChoice.distinctCutoffs);
  if (training !== null) check(training.evaluationForecasts === receipt.meanChoice.globalSamples);
  const screen = evaluateMarginalIntervalEvidence(evidence);
  const reasons = [
    ...screen.reasons,
    ...comparison.worseThan.map((name) => `wis-worse-than-${name}`),
  ];
  equal(receipt.reasons, reasons);
  check(receipt.state === (reasons.length ? "failed-qualification" : "qualified"));
  checksum(receipt, "qualificationChecksum");
}

/** Self-consistency only. Admission must authenticate the immutable, raw-reconstructed receipt. */
export function rosMarginalIntervalQualificationIsStructurallyValid(
  value: unknown,
): value is RosMarginalIntervalQualification {
  try {
    validateQualification(value);
    return true;
  } catch {
    return false;
  }
}

/** Interval qualification alone never clears mean, availability, convergence or source gates. */
export function rosMarginalIntervalQualificationIsPublicationQualified(
  value: unknown,
): value is RosMarginalIntervalQualification {
  return rosMarginalIntervalQualificationIsStructurallyValid(value) && value.state === "qualified";
}

type Fractions = {
  readonly coverage: MarginalIntervalFraction;
  readonly lowerTail: MarginalIntervalFraction;
  readonly upperTail: MarginalIntervalFraction;
};
export interface RosMarginalIntervalStoredCell {
  readonly cell: MarginalIntervalComparisonCell;
  readonly strategy: RosMarginalIntervalQualification["strategy"];
  readonly forecastSeason: number;
  readonly scoringProfileKey: string;
  readonly sourceSeasons: readonly number[];
  readonly requiredEvaluationSeasons: readonly number[];
  readonly comparisonSeason: number;
  readonly annualSupport: readonly ({
    readonly forecastSeason: number;
    readonly samples: number;
    readonly cutoffs: readonly number[];
  } & Fractions)[];
  readonly aggregate: Fractions;
  readonly candidateWis: number;
  readonly benchmarkWis: {
    readonly "same-physics-legacy": number;
    readonly "previous-deployed": number;
  };
  readonly qualificationChecksum: string;
  readonly artifactChecksum: string;
  readonly evidenceChecksum: string;
  readonly comparisonChecksum: string;
  readonly meanChoiceChecksum: string;
  readonly sourceScopeChecksum: string;
  readonly sourceBindingsChecksum: string;
  readonly linkageChecksum: string;
  readonly comparisonCohortChecksum: string;
  readonly fullReportChecksum: string;
  readonly protocolChecksum: string;
  readonly sourceManifestChecksum: string;
  readonly cellChecksum: string;
}
export interface RosMarginalIntervalStorage {
  readonly schemaVersion: 2;
  readonly version: typeof ROS_MARGINAL_INTERVAL_STORAGE_VERSION;
  readonly method: typeof METHOD;
  readonly qualificationMethod: typeof QUALIFICATION;
  readonly target: "individual-player-marginal-quantiles";
  readonly quantiles: readonly [0.15, 0.5, 0.85];
  readonly nominalCoverage: 0.7;
  readonly interpretation: "historical-descriptive";
  readonly championArtifactChecksum: string;
  readonly forecastSeason: number;
  readonly scoringProfileKey: string;
  readonly releasedCells: readonly MarginalIntervalComparisonCell[];
  readonly cells: readonly RosMarginalIntervalStoredCell[];
  readonly evidenceChecksum: string;
}
function fractions(value: Fractions): Fractions {
  return { coverage: value.coverage, lowerTail: value.lowerTail, upperTail: value.upperTail };
}
function storedCell(receipt: RosMarginalIntervalQualification): RosMarginalIntervalStoredCell {
  const body = {
    cell: receipt.cell,
    strategy: receipt.strategy,
    forecastSeason: receipt.forecastSeason,
    scoringProfileKey: receipt.sources.candidate.source.scoringProfileKey,
    sourceSeasons: receipt.sourceScope.sourceSeasons,
    requiredEvaluationSeasons: receipt.requiredEvaluationSeasons,
    comparisonSeason: receipt.comparisonSeason,
    annualSupport: receipt.evidence.perSeason.map((season) => ({
      forecastSeason: season.forecastSeason,
      samples: season.samples,
      cutoffs: receipt.evidence.blocks
        .filter((block) => block.forecastSeason === season.forecastSeason)
        .map((block) => block.asOfWeek),
      ...fractions(season.metrics!),
    })),
    aggregate: fractions(receipt.evidence.overall.metrics!),
    candidateWis: receipt.comparison.candidateWis,
    benchmarkWis: {
      "same-physics-legacy": receipt.comparison.benchmarkWis["same-physics-legacy"]!,
      "previous-deployed": receipt.comparison.benchmarkWis["previous-deployed"]!,
    },
    qualificationChecksum: receipt.qualificationChecksum,
    artifactChecksum: receipt.liveArtifact.artifactChecksum,
    evidenceChecksum: receipt.evidence.evidenceChecksum,
    comparisonChecksum: receipt.comparison.evidenceChecksum,
    meanChoiceChecksum: hash(receipt.meanChoice),
    sourceScopeChecksum: hash(receipt.sourceScope),
    sourceBindingsChecksum: hash(receipt.sources),
    linkageChecksum: hash(receipt.linkage),
    comparisonCohortChecksum: receipt.comparison.cells[0]!.cohortChecksum,
    fullReportChecksum: receipt.sourceScope.fullReportChecksum,
    protocolChecksum: receipt.sourceScope.protocolChecksum,
    sourceManifestChecksum: receipt.sourceScope.sourceManifestChecksum,
  };
  return { ...body, cellChecksum: hash(body) };
}
function gcd(left: bigint, right: bigint): bigint {
  while (right !== 0n) [left, right] = [right, left % right];
  return left;
}
function fraction(value: MarginalIntervalFraction): [bigint, bigint] {
  object(value, ["numerator", "denominator"]);
  check(typeof value.numerator === "string" && /^(0|[1-9][0-9]{0,4095})$/u.test(value.numerator));
  check(typeof value.denominator === "string" && /^[1-9][0-9]{0,4095}$/u.test(value.denominator));
  const n = BigInt(value.numerator),
    d = BigInt(value.denominator);
  check(n <= d && gcd(n, d) === 1n, "noncanonical probability fraction");
  return [n, d];
}
function add(left: [bigint, bigint], right: [bigint, bigint]): [bigint, bigint] {
  const n = left[0] * right[1] + right[0] * left[1],
    d = left[1] * right[1],
    divisor = gcd(n, d);
  return [n / divisor, d / divisor];
}
function validateFractions(value: Fractions): void {
  const sum = [value.coverage, value.lowerTail, value.upperTail]
    .map(fraction)
    .reduce(add, [0n, 1n]);
  check(sum[0] === sum[1], "coverage/tail fractions do not partition outcomes");
}
function validateCell(value: RosMarginalIntervalStoredCell): void {
  object(value, [
    "cell",
    "strategy",
    "forecastSeason",
    "scoringProfileKey",
    "sourceSeasons",
    "requiredEvaluationSeasons",
    "comparisonSeason",
    "annualSupport",
    "aggregate",
    "candidateWis",
    "benchmarkWis",
    "qualificationChecksum",
    "artifactChecksum",
    "evidenceChecksum",
    "comparisonChecksum",
    "meanChoiceChecksum",
    "sourceScopeChecksum",
    "sourceBindingsChecksum",
    "linkageChecksum",
    "comparisonCohortChecksum",
    "fullReportChecksum",
    "protocolChecksum",
    "sourceManifestChecksum",
    "cellChecksum",
  ]);
  cellKey(value.cell);
  strategy(value.strategy);
  integer(value.forecastSeason, 2000, 2200);
  text(value.scoringProfileKey, 65_536);
  years(value.sourceSeasons, 4);
  equal(value.requiredEvaluationSeasons, value.sourceSeasons.slice(1));
  check(
    value.comparisonSeason === value.sourceSeasons.at(-1) &&
      value.forecastSeason > value.comparisonSeason,
  );
  array(
    value.annualSupport,
    value.requiredEvaluationSeasons.length,
    value.requiredEvaluationSeasons.length,
  );
  let samples = 0;
  for (const [index, annual] of value.annualSupport.entries()) {
    object(annual, ["forecastSeason", "samples", "cutoffs", "coverage", "lowerTail", "upperTail"]);
    check(annual.forecastSeason === value.requiredEvaluationSeasons[index]);
    integer(annual.samples, 18);
    samples += annual.samples;
    array(annual.cutoffs, 3, 17);
    let previous = 0;
    for (const cutoff of annual.cutoffs) {
      integer(cutoff, previous + 1, 17);
      previous = cutoff;
    }
    // An equal-cutoff mean of count/sample fractions cannot have a reduced denominator
    // larger than k * samples^k. Check before accumulating years to bound BigInt work.
    const denominatorBound =
      BigInt(annual.cutoffs.length) * BigInt(annual.samples) ** BigInt(annual.cutoffs.length);
    for (const key of ["coverage", "lowerTail", "upperTail"] as const) {
      const denominator = annual[key]?.denominator;
      check(
        typeof denominator === "string" && denominator.length <= denominatorBound.toString().length,
        "annual fraction exceeds support bound",
      );
      check(fraction(annual[key])[1] <= denominatorBound, "annual fraction exceeds support bound");
    }
    validateFractions(annual);
  }
  check(samples <= MAX_ROWS);
  object(value.aggregate, ["coverage", "lowerTail", "upperTail"]);
  validateFractions(value.aggregate);
  for (const key of ["coverage", "lowerTail", "upperTail"] as const) {
    const sum = value.annualSupport.map((annual) => fraction(annual[key])).reduce(add, [0n, 1n]);
    const [n, d] = fraction(value.aggregate[key]);
    check(
      n * sum[1] * BigInt(value.annualSupport.length) === sum[0] * d,
      "incorrect equal-season aggregate",
    );
    check(key === "coverage" ? n * 5n >= d * 3n : n * 4n <= d, "failed interval screen");
  }
  finite(value.candidateWis, 0);
  object(value.benchmarkWis, ["same-physics-legacy", "previous-deployed"]);
  for (const name of ["same-physics-legacy", "previous-deployed"] as const) {
    finite(value.benchmarkWis[name], 0);
    check(value.candidateWis <= value.benchmarkWis[name], "failed matched WIS comparison");
  }
  for (const key of [
    "qualificationChecksum",
    "artifactChecksum",
    "evidenceChecksum",
    "comparisonChecksum",
    "meanChoiceChecksum",
    "sourceScopeChecksum",
    "sourceBindingsChecksum",
    "linkageChecksum",
    "comparisonCohortChecksum",
    "fullReportChecksum",
    "protocolChecksum",
    "sourceManifestChecksum",
    "cellChecksum",
  ] as const)
    digest(value[key]);
  checksum(value, "cellChecksum");
}

/** Compact SQL/API parity contract; immutable admitted-artifact linkage is an external requirement. */
export function rosMarginalIntervalStorageIsValid(
  value: unknown,
): value is RosMarginalIntervalStorage {
  try {
    boundedJson(value);
    object(value, [
      "schemaVersion",
      "version",
      "method",
      "qualificationMethod",
      "target",
      "quantiles",
      "nominalCoverage",
      "interpretation",
      "championArtifactChecksum",
      "forecastSeason",
      "scoringProfileKey",
      "releasedCells",
      "cells",
      "evidenceChecksum",
    ]);
    const receipt = value as unknown as RosMarginalIntervalStorage;
    check(
      receipt.schemaVersion === 2 &&
        receipt.version === ROS_MARGINAL_INTERVAL_STORAGE_VERSION &&
        receipt.method === METHOD &&
        receipt.qualificationMethod === QUALIFICATION &&
        receipt.target === "individual-player-marginal-quantiles" &&
        receipt.nominalCoverage === 0.7 &&
        receipt.interpretation === "historical-descriptive",
    );
    equal(receipt.quantiles, [0.15, 0.5, 0.85]);
    digest(receipt.championArtifactChecksum);
    integer(receipt.forecastSeason, 2000, 2200);
    text(receipt.scoringProfileKey, 65_536);
    projectionScoringRulesFromProfileKey(receipt.scoringProfileKey);
    cells(receipt.releasedCells);
    array(receipt.cells, receipt.releasedCells.length, receipt.releasedCells.length);
    let prior = "";
    for (const [index, cell] of receipt.cells.entries()) {
      validateCell(cell);
      const key = cellKey(cell.cell);
      check(key > prior, "noncanonical cell order");
      prior = key;
      equal(cell.cell, receipt.releasedCells[index]);
      check(
        cell.forecastSeason === receipt.forecastSeason &&
          cell.scoringProfileKey === receipt.scoringProfileKey,
      );
      const first = receipt.cells[0]!;
      for (const field of [
        "sourceScopeChecksum",
        "sourceBindingsChecksum",
        "fullReportChecksum",
        "protocolChecksum",
        "sourceManifestChecksum",
        "sourceSeasons",
        "requiredEvaluationSeasons",
        "comparisonSeason",
      ] as const)
        equal(cell[field], first[field]);
    }
    checksum(receipt, "evidenceChecksum");
    return true;
  } catch {
    return false;
  }
}

/**
 * Input receipts must already belong to the immutable admitted champion. This builder verifies
 * consistency, not authenticity. It preserves no release authority and never drops a failed cell
 * that the caller explicitly declares released. Unreleased failures remain in the full report.
 */
export function buildRosMarginalIntervalStorage(input: {
  readonly qualifications: readonly RosMarginalIntervalQualification[];
  readonly championArtifactChecksum: string;
  readonly releasedCells: readonly MarginalIntervalComparisonCell[];
}): RosMarginalIntervalStorage {
  object(input, ["qualifications", "championArtifactChecksum", "releasedCells"]);
  digest(input.championArtifactChecksum);
  cells(input.releasedCells);
  array(input.qualifications, 1, 18);
  const byCell = new Map<string, RosMarginalIntervalQualification>();
  for (const receipt of input.qualifications) {
    validateQualification(receipt);
    const key = cellKey(receipt.cell);
    check(!byCell.has(key), "duplicate qualification");
    byCell.set(key, receipt);
  }
  const first = input.qualifications[0]!;
  check(
    input.qualifications.length === first.sourceScope.requiredCells.length,
    "incomplete qualification set",
  );
  for (const receipt of input.qualifications) {
    equal(receipt.sourceScope, first.sourceScope);
    equal(receipt.sources, first.sources);
    check(receipt.forecastSeason === first.forecastSeason);
  }
  for (const required of first.sourceScope.requiredCells)
    check(byCell.has(cellKey(required)), "missing required qualification");
  const releasedCells = [...input.releasedCells].sort((a, b) =>
    cellKey(a) < cellKey(b) ? -1 : cellKey(a) > cellKey(b) ? 1 : 0,
  );
  const selected = releasedCells.map((cell) => {
    const receipt = byCell.get(cellKey(cell));
    check(receipt && receipt.state === "qualified", "released cell lacks interval qualification");
    return storedCell(receipt);
  });
  const body = {
    schemaVersion: 2,
    version: ROS_MARGINAL_INTERVAL_STORAGE_VERSION,
    method: METHOD,
    qualificationMethod: QUALIFICATION,
    target: "individual-player-marginal-quantiles",
    quantiles: [0.15, 0.5, 0.85],
    nominalCoverage: 0.7,
    interpretation: "historical-descriptive",
    championArtifactChecksum: input.championArtifactChecksum,
    forecastSeason: first.forecastSeason,
    scoringProfileKey: first.sources.candidate.source.scoringProfileKey,
    releasedCells,
    cells: selected,
  } as const;
  const result = { ...body, evidenceChecksum: hash(body) };
  check(rosMarginalIntervalStorageIsValid(result), "invalid compact projection");
  return result;
}

/** Compare every binding to an authenticated immutable full set, not merely to a plausible hash. */
export function rosMarginalIntervalStorageMatchesQualifications(
  value: unknown,
  input: Parameters<typeof buildRosMarginalIntervalStorage>[0],
): boolean {
  if (!rosMarginalIntervalStorageIsValid(value)) return false;
  try {
    return canonical(value) === canonical(buildRosMarginalIntervalStorage(input));
  } catch {
    return false;
  }
}
