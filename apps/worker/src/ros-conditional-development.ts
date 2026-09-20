import { createHash } from "node:crypto";
import {
  applyFirstPartyRosIntervalCalibration,
  buildMarginalIntervalEvidence,
  compareMarginalIntervalCell,
  compareMarginalIntervalPortfolio,
  evaluateFirstPartyRosMarginalPolicy,
  evaluateMarginalIntervalEvidence,
  type FirstPartyRosHeldOutForecast,
  type FirstPartyRosStrategy,
  type MarginalIntervalComparison,
  type MarginalIntervalComparisonCell,
  type MarginalIntervalComparisonRow,
  type MarginalIntervalEvaluationRow,
  type MarginalRosCandidateEvaluation,
} from "@laces-out/projections";
import {
  CONDITIONAL_ROS_DEVELOPMENT_VERSION,
  evaluateConditionalRosDevelopment,
  type ConditionalRosCandidateEvaluation,
} from "../../../packages/projections/src/conditional-ros-development.js";
import { CONDITIONAL_INTERVAL_CALIBRATION_VERSION } from "../../../packages/projections/src/conditional-interval-calibration.js";
import { historicalRosCalibrationBlockers } from "./first-party-ros-backtest.js";
import { parsePinnedRosMarginalDevelopmentInputs } from "./ros-marginal-development.js";
import type { RosDerivedEvaluationInput } from "./ros-derived-evaluation.js";

export const ROS_CONDITIONAL_DEVELOPMENT_VERSION =
  "pinned-full-portfolio-conditional-development-v1";
export const ROS_CONDITIONAL_EVIDENCE_VERSION = "conditional-prior-fit-marginal-evidence-v1";
const POSITIONS = ["QB", "RB", "WR", "TE", "K", "DST"] as const;
const BUCKETS = ["one-to-four", "five-to-eight", "nine-plus"] as const;
const STRATEGIES = ["contextual", "availability-aware-recency"] as const;
const EVALUATED_SEASONS = [2023, 2024, 2025] as const;
const PRIOR_SEASONS = [2022, 2023, 2024, 2025] as const;
const CELLS = POSITIONS.flatMap((position) => BUCKETS.map((bucket) => ({ position, bucket })));
const INTERVAL_ONLY_SUFFIXES = new Set([
  "artifact_unavailable",
  "walk_forward_unavailable",
  "walk_forward_seasons_below_minimum",
  "walk_forward_blocks_below_minimum",
  "walk_forward_samples_below_minimum",
  "coverage_shortfall_above_maximum",
]);
const CELL_BLOCKER =
  /^(cell|champion|calibration)_(QB|RB|WR|TE|K|DST)_(one-to-four|five-to-eight|nine-plus)_(.+)$/u;
const MEAN_ONLY_REASONS = new Set([
  "insufficient-global-evidence",
  "insufficient-statistical-evidence",
  "sparse-cell",
]);
const SUPPORT_REASONS = new Set([
  "insufficient_seasons",
  "insufficient_cutoffs",
  "insufficient_batches",
  "insufficient_samples",
]);
const PHYSICAL_CALIBRATION_REASONS = new Set([
  "held_out_evidence_unavailable",
  "input_coverage_below_minimum",
  "availability_mae_above_maximum",
  "availability_bias_above_maximum",
  "convergence_below_minimum",
]);

export interface RosConditionalDevelopmentInput {
  readonly candidateReportJson: string;
  readonly candidateReportChecksum: string;
  readonly previousReportJson: string;
  readonly previousReportChecksum: string;
  readonly intervalTrainingReportJson?: string;
  readonly intervalTrainingReportChecksum?: string;
  readonly derivedEvaluation?: RosDerivedEvaluationInput;
  /** Exact frozen text, including whitespace; code/build pins belong to the execution manifest. */
  readonly protocolText: string;
  readonly protocolChecksum: string;
  readonly sourceManifestChecksum: string;
  readonly scoringProfileKey: string;
}
function fail(reason: string): never {
  throw new Error(`Conditional ROS development: ${reason}`);
}
function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
/** Same canonical source-audit convention as the shared pinned-input parser. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  if (typeof value === "number" && !Number.isFinite(value)) fail("nonfinite report evidence");
  const encoded = JSON.stringify(value);
  if (encoded === undefined) fail("undefined report evidence");
  return encoded;
}
function key(strategy: FirstPartyRosStrategy): "contextual" | "recency" {
  return strategy === "contextual" ? "contextual" : "recency";
}
function bucket(row: { readonly windowStartWeek: number; readonly windowEndWeek: number }) {
  const weeks = row.windowEndWeek - row.windowStartWeek + 1;
  return weeks <= 4 ? "one-to-four" : weeks <= 8 ? "five-to-eight" : "nine-plus";
}
function sameCell(row: MarginalIntervalComparisonCell, cell: MarginalIntervalComparisonCell) {
  return row.position === cell.position && row.bucket === cell.bucket;
}
function cellKey(cell: MarginalIntervalComparisonCell): string {
  return `${cell.position}:${cell.bucket}`;
}
function quantiles(row: {
  readonly p15Points: number;
  readonly p50Points: number;
  readonly p85Points: number;
}) {
  return { p15Points: row.p15Points, p50Points: row.p50Points, p85Points: row.p85Points };
}
type Parsed = ReturnType<typeof parsePinnedRosMarginalDevelopmentInputs>;
type Conditional = ReturnType<typeof evaluateConditionalRosDevelopment>;
type ComparisonResult =
  | { readonly state: "available"; readonly comparison: MarginalIntervalComparison }
  | { readonly state: "unavailable"; readonly reason: string };
function compareSafely(run: () => MarginalIntervalComparison): ComparisonResult {
  try {
    return { state: "available", comparison: run() };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { state: "unavailable", reason: error.message };
  }
}
function comparisonPassed(result: ComparisonResult): boolean {
  return result.state === "available" && result.comparison.state === "passed";
}
function conditionalRow(
  row: ConditionalRosCandidateEvaluation,
  kind: "corrected" | "legacy" | "raw",
): MarginalIntervalComparisonRow {
  if (kind === "corrected" && row.correction === null)
    fail(`required conditional row unavailable:${row.identity}`);
  if (kind === "legacy" && row.legacyInterval.intervalCalibration !== "split-conformal-cqr")
    fail(`required same-physics legacy interval unavailable:${row.identity}`);
  return {
    playerId: row.playerId,
    forecastSeason: row.forecastSeason,
    asOfWeek: row.asOfWeek,
    position: row.position,
    windowStartWeek: row.windowStartWeek,
    windowEndWeek: row.windowEndWeek,
    scheduledGames: row.scheduledGames,
    actualPoints: row.actualPoints,
    ...quantiles(
      kind === "corrected"
        ? row.correction!
        : kind === "raw"
          ? row.rawQuantiles
          : row.legacyInterval,
    ),
  };
}
function previousRow(
  parsed: Parsed,
  row: FirstPartyRosHeldOutForecast,
  strategy: FirstPartyRosStrategy,
  raw: boolean,
): MarginalIntervalComparisonRow {
  const choice = parsed.previous.legacy.seasonPolicies
    .find((year) => year.season === row.forecastSeason)!
    .policy.choices.find((cell) => cell.position === row.position && cell.bucket === bucket(row))!;
  const interval = applyFirstPartyRosIntervalCalibration(
    row[key(strategy)],
    choice.intervalCalibrationArtifacts[key(strategy)],
  );
  if (!raw && interval.intervalCalibration !== "split-conformal-cqr")
    fail(`required retained deployed interval unavailable:${row.playerId}:${row.asOfWeek}`);
  return {
    playerId: row.position === "DST" && row.playerId === "DST:LA" ? "DST:LAR" : row.playerId,
    forecastSeason: row.forecastSeason,
    asOfWeek: row.asOfWeek,
    position: row.position,
    windowStartWeek: row.windowStartWeek,
    windowEndWeek: row.windowEndWeek,
    scheduledGames: row.evidence.availability.scheduledGames,
    actualPoints: row.actualPoints,
    ...quantiles(raw ? row[key(strategy)] : interval),
  };
}

/** Descriptive only; overlapping cutoffs are not treated as independent observations. */
function rowDiagnostics(rows: readonly ConditionalRosCandidateEvaluation[]) {
  const weighted = (value: (row: ConditionalRosCandidateEvaluation) => number): number | null => {
    if (rows.length === 0) return null;
    const seasons = new Map<number, Map<number, ConditionalRosCandidateEvaluation[]>>();
    for (const row of rows) {
      const cutoffs =
        seasons.get(row.forecastSeason) ?? new Map<number, ConditionalRosCandidateEvaluation[]>();
      const block = cutoffs.get(row.asOfWeek) ?? [];
      block.push(row);
      cutoffs.set(row.asOfWeek, block);
      seasons.set(row.forecastSeason, cutoffs);
    }
    return (
      [...seasons.values()].reduce(
        (total, cutoffs) =>
          total +
          [...cutoffs.values()].reduce(
            (year, block) => year + block.reduce((sum, row) => sum + value(row), 0) / block.length,
            0,
          ) /
            cutoffs.size,
        0,
      ) / seasons.size
    );
  };
  const complete = rows.length > 0 && rows.every((row) => row.correction !== null);
  return {
    weighting: "equal-season-equal-cutoff-equal-player",
    rawMeanSignedError: weighted((row) => row.predictedMean - row.actualPoints),
    rawMeanSignedErrorConvention: "prediction-minus-actual",
    rawWidth: weighted((row) => row.rawQuantiles.p85Points - row.rawQuantiles.p15Points),
    correctedWidth: complete
      ? weighted((row) => row.correction!.p85Points - row.correction!.p15Points)
      : null,
    endpointMeanCorrections: complete
      ? [
          weighted((row) => row.correction!.p15Points - row.rawQuantiles.p15Points),
          weighted((row) => row.correction!.p50Points - row.rawQuantiles.p50Points),
          weighted((row) => row.correction!.p85Points - row.rawQuantiles.p85Points),
        ]
      : null,
    featureClippedRows: rows.filter((row) => row.correction?.featureClipped).length,
    rearrangedRows: rows.filter((row) => row.correction?.rearrangement.crossed).length,
    maximumRearrangementMovement: Math.max(
      0,
      ...rows.map((row) => row.correction?.rearrangement.maximumMovement ?? 0),
    ),
  };
}

function conditionalMeasurement(
  rows: readonly ConditionalRosCandidateEvaluation[],
  seriesKey: string,
  evaluation: Conditional,
) {
  const fits = new Map(
    evaluation.seasonFits.flatMap((year) =>
      year.cells.map((cell) => [cell.fit.checksum, cell.fit] as const),
    ),
  );
  const scored: MarginalIntervalEvaluationRow[] = [];
  const unavailable: { identity: string; failure: ConditionalRosCandidateEvaluation["failure"] }[] =
    [];
  for (const row of rows) {
    if (row.correction === null) {
      unavailable.push({ identity: row.identity, failure: row.failure });
      continue;
    }
    const fit = fits.get(row.fitChecksum);
    if (!fit || fit.state !== "fitted" || fit.forecastSeason !== row.forecastSeason)
      fail("conditional fit/forecast binding failed");
    const requiredPrior = PRIOR_SEASONS.filter((year) => year < row.forecastSeason);
    if (canonical(fit.priorSeasons) !== canonical(requiredPrior))
      fail("conditional historical fit omits a declared prior season");
    scored.push({
      seriesKey,
      identity: row.identity,
      playerId: row.playerId,
      forecastSeason: row.forecastSeason,
      asOfWeek: row.asOfWeek,
      windowStartWeek: row.windowStartWeek,
      windowEndWeek: row.windowEndWeek,
      scheduledGames: row.scheduledGames,
      actualPoints: row.actualPoints,
      rawQuantiles: row.rawQuantiles,
      artifactChecksum: row.fitChecksum,
      trainedThroughSeason: Math.max(...fit.priorSeasons),
      ...quantiles(row.correction),
    });
  }
  // This is method-neutral quantile scoring. No v1 marginal calibration artifact is manufactured.
  const measurement = buildMarginalIntervalEvidence({ seriesKey, rows: scored });
  const byYear = EVALUATED_SEASONS.map((season) => {
    const expected = rows.filter((row) => row.forecastSeason === season);
    const measured = buildMarginalIntervalEvidence({
      seriesKey,
      rows: scored.filter((row) => row.forecastSeason === season),
    });
    return {
      season,
      expectedRows: expected.length,
      correctedRows: measured.overall.samples,
      measurement: measured,
      // Per-year screens are diagnostics; the frozen mandatory screen pools all three years.
      descriptiveScreen: evaluateMarginalIntervalEvidence(measured),
      diagnostics: rowDiagnostics(expected),
    };
  });
  return {
    version: ROS_CONDITIONAL_EVIDENCE_VERSION,
    calibrationVersion: CONDITIONAL_INTERVAL_CALIBRATION_VERSION,
    requiredEvaluationSeasons: EVALUATED_SEASONS,
    complete:
      unavailable.length === 0 &&
      byYear.every((year) => year.expectedRows > 0 && year.correctedRows === year.expectedRows),
    expectedRows: rows.length,
    correctedRows: scored.length,
    unavailable,
    measurement,
    screen: evaluateMarginalIntervalEvidence(measurement),
    diagnostics: rowDiagnostics(rows),
    perYear: byYear,
  };
}

function unconditionalMeasurement(
  rows: readonly MarginalRosCandidateEvaluation[],
  seriesKey: string,
) {
  const unavailable = rows
    .filter((row) => row.corrected === null)
    .map((row) => ({ identity: row.identity, reason: row.withheldReason }));
  const measurement = buildMarginalIntervalEvidence({
    seriesKey,
    rows: rows.flatMap((row) => (row.corrected === null ? [] : [{ ...row.corrected, seriesKey }])),
  });
  return {
    complete: unavailable.length === 0 && rows.length > 0,
    expectedRows: rows.length,
    measurement,
    unavailable,
  };
}

/** Closed six-suffix supersession, only after this conditional cell passes all required scores. */
function legacyBlockers(raw: readonly string[], passedCells: ReadonlySet<string>) {
  const effective: string[] = [],
    supersededIntervalDiagnostics: string[] = [];
  for (const reason of raw) {
    const match = CELL_BLOCKER.exec(reason);
    if (
      match?.[1] === "calibration" &&
      passedCells.has(`${match[2]}:${match[3]}`) &&
      INTERVAL_ONLY_SUFFIXES.has(match[4]!)
    )
      supersededIntervalDiagnostics.push(reason);
    else effective.push(reason);
  }
  return { raw: [...raw], effective, supersededIntervalDiagnostics };
}

/**
 * Pure pinned development grading. The fixed 2022–25 audit is development evidence, not fresh
 * confirmation. No scope/threshold/strategy knobs, database writes, admission shape or release
 * authority are provided. Execution-code and independent source-preflight pins belong to the
 * separately authenticated run manifest; caller-supplied SHA256 values are integrity, not signatures.
 */
export function buildRosConditionalDevelopmentReport(input: RosConditionalDevelopmentInput) {
  if (
    typeof input.protocolText !== "string" ||
    !input.protocolText.trim() ||
    Buffer.byteLength(input.protocolText) > 1024 * 1024 ||
    !/^[a-f0-9]{64}$/u.test(input.protocolChecksum) ||
    hash(input.protocolText) !== input.protocolChecksum
  )
    fail("protocol byte pin mismatch");
  const parsed = parsePinnedRosMarginalDevelopmentInputs({
    candidateReportJson: input.candidateReportJson,
    candidateReportChecksum: input.candidateReportChecksum,
    previousReportJson: input.previousReportJson,
    previousReportChecksum: input.previousReportChecksum,
    ...(input.derivedEvaluation === undefined
      ? {}
      : { derivedEvaluation: input.derivedEvaluation }),
    ...(input.intervalTrainingReportJson === undefined
      ? {}
      : { intervalTrainingReportJson: input.intervalTrainingReportJson }),
    ...(input.intervalTrainingReportChecksum === undefined
      ? {}
      : { intervalTrainingReportChecksum: input.intervalTrainingReportChecksum }),
    forecastSeason: 2026,
    evaluationSeason: 2025,
    positions: POSITIONS,
  });
  if (
    parsed.candidate.raw.length !== 3264 ||
    parsed.previous.raw.length !== 3264 ||
    parsed.positions.length !== 6 ||
    parsed.previous.positions.length !== 6
  )
    fail("full 3264-row six-position paired audit is required");
  if (hash(canonical(parsed.candidate.sources)) !== input.sourceManifestChecksum)
    fail("source manifest checksum mismatch");
  if (parsed.candidate.source.scoringProfileKey !== input.scoringProfileKey)
    fail("exact scoring key mismatch");
  if (
    parsed.intervalTraining !== null &&
    (parsed.composite === null ||
      parsed.intervalTraining.heldOutSeasons.flatMap((year) => year.forecasts).length !== 4896)
  )
    fail("complete 4896-row training composition is required");
  const trainingOptions =
    parsed.intervalTraining === null
      ? {}
      : { intervalTrainingSeasons: parsed.intervalTraining.heldOutSeasons };
  const evaluation = evaluateConditionalRosDevelopment(parsed.candidate.heldOutSeasons, {
    forecastSeason: 2026,
    ...trainingOptions,
  });
  if (canonical(evaluation.legacyEvaluation) !== canonical(parsed.candidate.legacy))
    fail("conditional adapter changed frozen mean choices or evidence");
  const unconditional = evaluateFirstPartyRosMarginalPolicy(parsed.candidate.heldOutSeasons, {
    forecastSeason: 2026,
    championOptions: parsed.candidate.options,
    ...trainingOptions,
  });
  if (canonical(unconditional.legacyEvaluation) !== canonical(parsed.candidate.legacy))
    fail("unconditional comparator changed frozen mean choices");
  const source = { ...parsed.candidate.source, policyVersion: CONDITIONAL_ROS_DEVELOPMENT_VERSION };
  const reasons: string[] = [];
  const cells = CELLS.map((cell) => {
    const choice = parsed.candidate.legacy.livePolicy.choices.find((candidate) =>
      sameCell(candidate, cell),
    )!;
    const previousChoice = parsed.previous.legacy.livePolicy.choices.find((candidate) =>
      sameCell(candidate, cell),
    )!;
    const strategies = STRATEGIES.map((strategy) => {
      const fit = evaluation.liveFits.cells.find(
        (candidate) => sameCell(candidate.context, cell) && candidate.context.strategy === strategy,
      )!;
      const rows = evaluation.candidates.filter(
        (row) =>
          sameCell(row, cell) &&
          row.strategy === strategy &&
          EVALUATED_SEASONS.some((year) => row.forecastSeason === year),
      );
      const evidence = conditionalMeasurement(rows, fit.seriesKey, evaluation);
      const rawUnconditional = unconditional.candidates.filter(
        (row) =>
          sameCell(row, cell) &&
          row.strategy === strategy &&
          EVALUATED_SEASONS.some((year) => row.forecastSeason === year),
      );
      const additional = unconditionalMeasurement(
        rawUnconditional,
        `additional-unconditional:${fit.seriesKey}`,
      );
      return {
        strategy,
        selectedForFinalLive: strategy === choice.strategy,
        liveFit: fit,
        evidence,
        additionalUnconditional: additional,
      };
    });
    const selected = strategies.find((row) => row.strategy === choice.strategy)!;
    const latest = evaluation.candidates.filter(
      (row) =>
        sameCell(row, cell) && row.strategy === choice.strategy && row.forecastSeason === 2025,
    );
    const old = parsed.previous.raw.filter(
      (row) =>
        row.position === cell.position &&
        bucket(row) === cell.bucket &&
        row.forecastSeason === 2025,
    );
    const comparison = compareSafely(() =>
      compareMarginalIntervalCell({
        evaluationSeason: 2025,
        cell,
        candidate: { source, rows: latest.map((row) => conditionalRow(row, "corrected")) },
        benchmarks: {
          "same-physics-legacy": {
            source: parsed.candidate.source,
            rows: latest.map((row) => conditionalRow(row, "legacy")),
          },
          "previous-deployed": {
            source: parsed.previous.source,
            rows: old.map((row) => previousRow(parsed, row, previousChoice.strategy, false)),
          },
        },
      }),
    );
    const liveAvailable =
      selected.liveFit.fit.state === "fitted" &&
      canonical(selected.liveFit.fit.priorSeasons) === canonical(PRIOR_SEASONS);
    const intervalPassed =
      liveAvailable &&
      selected.evidence.complete &&
      selected.evidence.screen.state === "descriptive-screen-passed" &&
      comparisonPassed(comparison);
    if (!liveAvailable) reasons.push(`${cellKey(cell)}:live-fit-unavailable`);
    if (!selected.evidence.complete)
      reasons.push(`${cellKey(cell)}:prequential-population-incomplete`);
    if (selected.evidence.screen.state !== "descriptive-screen-passed")
      reasons.push(`${cellKey(cell)}:marginal-screen:${selected.evidence.screen.state}`);
    if (!comparisonPassed(comparison))
      reasons.push(
        ...(comparison.state === "unavailable"
          ? [`${cellKey(cell)}:wis-comparison-unavailable`]
          : comparison.comparison.worseThan.map(
              (name) => `${cellKey(cell)}:wis-worse-than-${name}`,
            )),
      );
    return {
      ...cell,
      strategy: choice.strategy,
      previousStrategy: previousChoice.strategy,
      strategies,
      comparison,
      intervalPassed,
    };
  });
  const selected = evaluation.selected.filter((row) => row.forecastSeason === 2025);
  const oldSelected = parsed.previous.raw
    .filter((row) => row.forecastSeason === 2025)
    .map((row) => ({
      row,
      strategy: parsed.previous.legacy.seasonPolicies
        .find((year) => year.season === 2025)!
        .policy.choices.find(
          (cell) => cell.position === row.position && cell.bucket === bucket(row),
        )!.strategy,
    }));
  const portfolio = compareSafely(() =>
    compareMarginalIntervalPortfolio({
      evaluationSeason: 2025,
      cells: CELLS,
      candidate: { source, rows: selected.map((row) => conditionalRow(row, "corrected")) },
      benchmarks: {
        "same-physics-raw": {
          source: { ...parsed.candidate.source, policyVersion: "uncalibrated-raw-v1" },
          rows: selected.map((row) => conditionalRow(row, "raw")),
        },
        "same-physics-legacy": {
          source: parsed.candidate.source,
          rows: selected.map((row) => conditionalRow(row, "legacy")),
        },
        "previous-raw": {
          source: { ...parsed.previous.source, policyVersion: "uncalibrated-raw-v1" },
          rows: oldSelected.map(({ row, strategy }) => previousRow(parsed, row, strategy, true)),
        },
        "previous-deployed": {
          source: parsed.previous.source,
          rows: oldSelected.map(({ row, strategy }) => previousRow(parsed, row, strategy, false)),
        },
      },
    }),
  );
  if (!comparisonPassed(portfolio))
    reasons.push(
      ...(portfolio.state === "unavailable"
        ? ["portfolio:wis-comparison-unavailable"]
        : portfolio.comparison.worseThan.map((name) => `portfolio:wis-worse-than-${name}`)),
    );
  const passedCells = new Set(
    cells.filter((cell) => cell.intervalPassed && comparisonPassed(portfolio)).map(cellKey),
  );
  const reconstructed = [
    ...historicalRosCalibrationBlockers(parsed.candidate.legacy.livePolicy.choices),
    ...parsed.candidate.legacy.livePolicy.choices
      .filter(
        (choice) => choice.reason.startsWith("insufficient") || choice.reason === "sparse-cell",
      )
      .map((choice) => `champion_${choice.position}_${choice.bucket}_${choice.reason}`),
  ];
  const legacyDiagnostics = legacyBlockers(
    [...new Set([...parsed.candidate.blockers, ...reconstructed])],
    passedCells,
  );
  reasons.push(
    ...legacyDiagnostics.effective.map((reason) => `preserved-legacy:${reason}`),
    ...parsed.candidate.physicalBlockers,
  );
  const physicalIssues = evaluation.candidates.flatMap((row) =>
    row.physicalIssues.map((issue) => ({ ...issue, strategy: row.strategy })),
  );
  // Row-level partial coverage remains visible, while its existing aggregate .95 gate above
  // owns the verdict. Convergence retains the existing no-failed-stratum requirement.
  if (physicalIssues.some((issue) => issue.kind === "unstable-physical-convergence"))
    reasons.push("audit:physical-convergence-failures-retained");
  const trainingDiagnostics =
    parsed.training === null
      ? null
      : (() => {
          const raw = [
            ...new Set([
              ...parsed.training.blockers,
              ...historicalRosCalibrationBlockers(
                parsed.training.legacy.livePolicy.choices.filter(
                  (choice) => choice.position === "DST",
                ),
              ),
            ]),
          ];
          const effective: string[] = [],
            nonAuditDiagnostics: string[] = [];
          for (const reason of raw) {
            const match = CELL_BLOCKER.exec(reason);
            const knownMean = match?.[1] === "champion" && MEAN_ONLY_REASONS.has(match[4]!);
            const knownSupport =
              match?.[1] === "cell" &&
              match[4]!.split("+").every((entry) => SUPPORT_REASONS.has(entry));
            const knownInterval =
              match?.[1] === "calibration" && INTERVAL_ONLY_SUFFIXES.has(match[4]!);
            const knownPhysical =
              match?.[1] === "calibration" && PHYSICAL_CALIBRATION_REASONS.has(match[4]!);
            if (
              match &&
              match[2] !== "DST" &&
              (knownMean || knownSupport || knownInterval || knownPhysical)
            )
              nonAuditDiagnostics.push(reason);
            else if (match?.[1] === "calibration" && INTERVAL_ONLY_SUFFIXES.has(match[4]!))
              nonAuditDiagnostics.push(reason);
            else if (knownMean || knownSupport) nonAuditDiagnostics.push(reason);
            else effective.push(reason);
          }
          reasons.push(
            ...parsed.training.physicalBlockers.map((reason) => `interval-training:${reason}`),
            ...effective.map((reason) => `interval-training:preserved-legacy:${reason}`),
          );
          return {
            raw,
            effective,
            nonAuditDiagnostics,
            physicalBlockers: parsed.training.physicalBlockers,
          };
        })();
  const additionalCells = CELLS.map((cell) => {
    const latest = selected.filter((row) => sameCell(row, cell));
    const conditional = conditionalMeasurement(
      latest,
      `additional-conditional-selected:${cellKey(cell)}`,
      evaluation,
    );
    const fixed = unconditionalMeasurement(
      unconditional.selected.filter((row) => sameCell(row, cell) && row.forecastSeason === 2025),
      `additional-unconditional-selected:${cellKey(cell)}`,
    );
    return {
      ...cell,
      complete: conditional.unavailable.length === 0 && fixed.complete,
      conditionalWis: conditional.measurement.overall.metrics?.wis ?? null,
      unconditionalWis: fixed.measurement.overall.metrics?.wis ?? null,
    };
  });
  const additionalComplete = additionalCells.every(
    (cell) => cell.complete && cell.conditionalWis !== null && cell.unconditionalWis !== null,
  );
  const payload = {
    schemaVersion: 1,
    version: ROS_CONDITIONAL_DEVELOPMENT_VERSION,
    validationMode: "conditional-interval-development-only",
    canAuthorizeRelease: false,
    noDatabaseWrites: true,
    state: reasons.length > 0 ? "rejected-at-development-screen" : "development-screen-passed",
    forecastSeason: 2026,
    evaluationSeason: 2025,
    positions: POSITIONS,
    requiredCells: CELLS,
    completePortfolio: true,
    identityAmendments: { previousPlayerId: { "DST:LA": "DST:LAR" } },
    provenance: {
      candidate: parsed.candidate.source,
      previous: parsed.previous.source,
      ...(parsed.derivedEvaluation === null
        ? {}
        : { derivedEvaluation: parsed.derivedEvaluation.lineage }),
      sourceManifestChecksum: input.sourceManifestChecksum,
      sources: parsed.candidate.sources,
      scoringProfileKey: input.scoringProfileKey,
      protocolText: input.protocolText,
      protocolChecksum: input.protocolChecksum,
      sourceComponentEquivalence: "requires-separate-pinned-source-preflight",
      intervalTraining: parsed.intervalTraining?.source ?? null,
      intervalTrainingComposition: parsed.composite?.manifest ?? null,
    },
    legacyDiagnostics,
    trainingDiagnostics,
    legacyReports: {
      candidate: parsed.candidate.report,
      previous: parsed.originalPrevious?.report ?? parsed.previous.report,
      training: parsed.training?.report ?? null,
    },
    conditionalDevelopment: {
      interpretation: {
        cells: "retrospective-final-live-2026-mean-choice-on-prior-fit-historical-intervals",
        portfolio: "chronological-2025-mean-choice-and-interval-fits",
        historicalIntervals: "each-evaluation-year-fitted-only-on-completed-prior-years",
      },
      evaluation,
      cells,
      portfolio,
      physicalIssues,
      reasons: [...new Set(reasons)],
    },
    additionalUnconditionalComparator: {
      interpretation: "additional-development-comparator-not-a-mandatory-benchmark-replacement",
      evaluation: unconditional,
      latestChronologicalPortfolio: {
        complete: additionalComplete,
        cells: additionalCells,
        conditionalWis: additionalComplete
          ? additionalCells.reduce((total, cell) => total + cell.conditionalWis!, 0) / CELLS.length
          : null,
        unconditionalWis: additionalComplete
          ? additionalCells.reduce((total, cell) => total + cell.unconditionalWis!, 0) /
            CELLS.length
          : null,
      },
    },
  } as const;
  return { ...payload, evidenceChecksum: hash(canonical(payload)) };
}
