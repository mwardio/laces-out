import {
  createConditionalIntervalArtifact,
  prepareConditionalIntervalArtifact,
} from "./conditional-interval-artifact.js";
import {
  conditionalContractArray as array,
  conditionalContractCanonical as canonical,
  conditionalContractDigest as digest,
  conditionalContractMatches as matches,
  conditionalContractObject as object,
} from "./conditional-interval-contract.js";
import {
  evaluateConditionalRosDevelopment,
  type ConditionalRosCandidateEvaluation,
  type ConditionalRosCellFit,
} from "./conditional-ros-development.js";
import {
  compareMarginalIntervalCell,
  compareMarginalIntervalPortfolio,
  type MarginalIntervalComparisonCell,
  type MarginalIntervalComparisonRow,
} from "./marginal-interval-comparison.js";
import {
  buildMarginalIntervalEvidence,
  evaluateMarginalIntervalEvidence,
  type MarginalIntervalEvaluationRow,
} from "./marginal-interval-evidence.js";
import { validateMarginalRosTrainingCohort } from "./marginal-ros-training.js";
import type {
  RosMarginalQualificationDataset,
  RosMarginalQualificationScope,
} from "./ros-marginal-interval-qualification.js";
import {
  applyFirstPartyRosIntervalCalibration,
  evaluateRetainedV12FirstPartyRosChampionPolicy,
  FIRST_PARTY_ROS_MODEL_VERSION,
  type FirstPartyRosHeldOutForecast,
  type FirstPartyRosStrategy,
} from "./rest-of-season.js";
import { projectionScoringRulesFromProfileKey } from "./scoring-position-keys.js";
import { sha256Hex } from "./sha256.js";

export const ROS_CONDITIONAL_INTERVAL_QUALIFICATION_VERSION =
  "ros-conditional-interval-qualification-v1";
const LEGACY_POLICY = "season-walk-forward-mean-rmse-block-wis-cqr-v7";
const RETAINED_MODEL = "laces-ros-distribution-v12";
const STRATEGIES = ["contextual", "availability-aware-recency"] as const;
/** No user-selected strategy, fitted coefficients, claimed screen or development receipt input. */
export interface RosConditionalIntervalQualificationInput {
  readonly forecastSeason: number;
  readonly scope: RosMarginalQualificationScope;
  readonly candidate: RosMarginalQualificationDataset;
  readonly previous: RosMarginalQualificationDataset;
  /** Complete authenticated physical superset, not the DST-only report on its own. */
  readonly intervalTraining?: RosMarginalQualificationDataset;
}
function fail(message: string): never {
  throw new Error(`Conditional qualification: ${message}`);
}
function equal(left: unknown, right: unknown, message: string) {
  if (!matches(left, right)) fail(message);
}
function bucket(row: { windowStartWeek: number; windowEndWeek: number }) {
  const weeks = row.windowEndWeek - row.windowStartWeek + 1;
  return weeks <= 4 ? "one-to-four" : weeks <= 8 ? "five-to-eight" : "nine-plus";
}
function cellKey(cell: MarginalIntervalComparisonCell): string {
  object(cell, ["position", "bucket"]);
  if (
    !["QB", "RB", "WR", "TE", "K", "DST"].includes(cell.position) ||
    !["one-to-four", "five-to-eight", "nine-plus"].includes(cell.bucket)
  )
    fail("invalid cell");
  return `${cell.position}:${cell.bucket}`;
}
function sameCell(row: MarginalIntervalComparisonCell, cell: MarginalIntervalComparisonCell) {
  return row.position === cell.position && row.bucket === cell.bucket;
}
function key(strategy: FirstPartyRosStrategy) {
  return strategy === "contextual" ? "contextual" : "recency";
}
function forecastShape(row: FirstPartyRosHeldOutForecast) {
  object(row, [
    "playerId",
    "position",
    "forecastSeason",
    "asOfWeek",
    "windowStartWeek",
    "windowEndWeek",
    "trainedThroughSeason",
    "inputChecksum",
    "contextualModelVersion",
    "recencyModelVersion",
    "scoringProfileKey",
    "intervalMethodVersion",
    "evidence",
    "contextual",
    "recency",
    "actualPoints",
  ]);
  for (const strategy of ["contextual", "recency"] as const)
    object(row[strategy], ["meanPoints", "p15Points", "p50Points", "p85Points"]);
  object(row.evidence, ["coverage", "availability", "convergence"]);
  object(row.evidence.coverage, ["contextual", "recency"]);
  object(row.evidence.availability, [
    "scheduledGames",
    "actualGames",
    "contextualExpectedGames",
    "recencyExpectedGames",
  ]);
  object(row.evidence.convergence, ["contextual", "recency"]);
  for (const strategy of ["contextual", "recency"] as const)
    object(row.evidence.convergence[strategy], ["state", "diagnosticChecksum"]);
}
function dataset(
  input: RosMarginalQualificationDataset,
  scope: RosMarginalQualificationScope,
  model: string,
) {
  object(input, ["source", "sourceManifestChecksum", "rowsChecksum", "heldOutSeasons"]);
  object(input.source, [
    "modelVersion",
    "policyVersion",
    "scoringProfileKey",
    "physicalCorpusChecksum",
    "reportChecksum",
  ]);
  for (const pin of [
    input.rowsChecksum,
    input.sourceManifestChecksum,
    input.source.physicalCorpusChecksum,
    input.source.reportChecksum,
  ])
    digest(pin);
  if (
    input.source.modelVersion !== model ||
    input.source.policyVersion !== LEGACY_POLICY ||
    input.sourceManifestChecksum !== scope.sourceManifestChecksum
  )
    fail("raw source identity mismatch");
  projectionScoringRulesFromProfileKey(input.source.scoringProfileKey);
  array(input.heldOutSeasons, 4, 201);
  let count = 0;
  for (const season of input.heldOutSeasons) {
    object(season, ["season", "complete", "forecasts"]);
    array(season.forecasts, 1, 20_000);
    count += season.forecasts.length;
    if (count > 20_000 || season.complete !== true) fail("incomplete or oversized source");
    for (const row of season.forecasts) {
      forecastShape(row);
      if (
        row.scoringProfileKey !== input.source.scoringProfileKey ||
        !row.contextualModelVersion.startsWith(`${model}:contextual:`) ||
        !row.recencyModelVersion.startsWith(`${model}:availability-aware-recency:`)
      )
        fail("row/source identity mismatch");
    }
  }
  const checked = validateMarginalRosTrainingCohort(input.heldOutSeasons, input.heldOutSeasons);
  equal(checked.provenance.seasons, scope.sourceSeasons, "declared source years mismatch");
  if (checked.provenance.evaluationRowsChecksum !== input.rowsChecksum)
    fail("raw rows checksum mismatch");
  return {
    ...input,
    ordered: checked.ordered,
    raw: checked.ordered.flatMap((year) => year.forecasts),
  };
}
function previousPlayer(row: FirstPartyRosHeldOutForecast, scope: RosMarginalQualificationScope) {
  return scope.identityAmendment === "previous-defense-la-to-lar-v1" &&
    row.position === "DST" &&
    row.playerId === "DST:LA"
    ? "DST:LAR"
    : row.playerId;
}
function observation(row: FirstPartyRosHeldOutForecast, playerId = row.playerId) {
  return [
    row.position,
    row.forecastSeason,
    row.asOfWeek,
    playerId,
    row.windowStartWeek,
    row.windowEndWeek,
    row.evidence.availability.scheduledGames,
    row.evidence.availability.actualGames,
    row.actualPoints,
  ];
}
function prepare(supplied: RosConditionalIntervalQualificationInput) {
  object(supplied, ["forecastSeason", "scope", "candidate", "previous"], ["intervalTraining"]);
  object(supplied.scope, [
    "sourceSeasons",
    "requiredCells",
    "protocolChecksum",
    "sourceManifestChecksum",
    "fullReportChecksum",
    "identityAmendment",
  ]);
  canonical(supplied); // Reject oversized/cyclic/unserializable input before fitting or snapshotting.
  const input = structuredClone(supplied),
    scope = input.scope;
  array(scope.sourceSeasons, 4, 201);
  array(scope.requiredCells, 1, 18);
  for (const [index, year] of scope.sourceSeasons.entries())
    if (
      !Number.isSafeInteger(year) ||
      year < 2000 ||
      year > 2199 ||
      (index > 0 && year !== scope.sourceSeasons[index - 1]! + 1)
    )
      fail("completed years must be consecutive");
  if (input.forecastSeason !== scope.sourceSeasons.at(-1)! + 1)
    fail("live year must immediately follow prior years");
  for (const pin of [
    scope.protocolChecksum,
    scope.sourceManifestChecksum,
    scope.fullReportChecksum,
  ])
    digest(pin);
  if (!["none", "previous-defense-la-to-lar-v1"].includes(scope.identityAmendment))
    fail("unknown identity amendment");
  const cells = [...scope.requiredCells].sort((a, b) => cellKey(a).localeCompare(cellKey(b)));
  if (new Set(cells.map(cellKey)).size !== cells.length) fail("duplicate declared cell");
  const candidate = dataset(input.candidate, scope, FIRST_PARTY_ROS_MODEL_VERSION);
  const previous = dataset(input.previous, scope, RETAINED_MODEL);
  const training =
    input.intervalTraining === undefined
      ? null
      : dataset(input.intervalTraining, scope, FIRST_PARTY_ROS_MODEL_VERSION);
  if (
    candidate.source.scoringProfileKey !== previous.source.scoringProfileKey ||
    (training !== null && training.source.scoringProfileKey !== candidate.source.scoringProfileKey)
  )
    fail("exact profile mismatch");
  if (
    candidate.source.physicalCorpusChecksum === previous.source.physicalCorpusChecksum ||
    candidate.source.reportChecksum === previous.source.reportChecksum
  )
    fail("retained benchmark must have distinct source identity");
  if (
    training !== null &&
    [candidate.source.physicalCorpusChecksum, previous.source.physicalCorpusChecksum].includes(
      training.source.physicalCorpusChecksum,
    )
  )
    fail("broader training must have a distinct corpus identity");
  const index = (row: FirstPartyRosHeldOutForecast, player = row.playerId) =>
    JSON.stringify([row.position, row.forecastSeason, row.asOfWeek, player]);
  const old = new Map(previous.raw.map((row) => [index(row, previousPlayer(row, scope)), row]));
  if (old.size !== previous.raw.length || old.size !== candidate.raw.length)
    fail("paired benchmark cohort mismatch");
  for (const row of candidate.raw) {
    const matched = old.get(index(row));
    if (!matched) fail("paired benchmark observation missing");
    if (scope.identityAmendment !== "none" && row.playerId === "DST:LA")
      fail("candidate has obsolete defense identity");
    equal(
      observation(row),
      observation(matched, previousPlayer(matched, scope)),
      "paired target/schedule mismatch",
    );
  }
  equal(
    [
      ...new Set(
        candidate.raw.map((row) => cellKey({ position: row.position, bucket: bucket(row) })),
      ),
    ].sort(),
    cells.map(cellKey).sort(),
    "raw source does not cover exactly the declared cells",
  );
  const evaluation = evaluateConditionalRosDevelopment(candidate.ordered, {
    forecastSeason: input.forecastSeason,
    ...(training === null ? {} : { intervalTrainingSeasons: training.ordered }),
  });
  const retained = evaluateRetainedV12FirstPartyRosChampionPolicy(
    previous.ordered,
    evaluation.meanSelectorOptions,
  );
  return {
    input,
    cells,
    candidate,
    previous,
    training,
    evaluation,
    retained,
    requiredYears: scope.sourceSeasons.slice(1),
    comparisonYear: scope.sourceSeasons.at(-1)!,
  };
}
type Prepared = ReturnType<typeof prepare>;
function provenance(p: Prepared) {
  const source = p.training ?? p.candidate;
  return {
    protocolChecksum: p.input.scope.protocolChecksum,
    sourceManifestChecksum: source.sourceManifestChecksum,
    physicalCorpusChecksum: source.source.physicalCorpusChecksum,
    reportChecksum: source.source.reportChecksum,
    trainingRowsChecksum: source.rowsChecksum,
  };
}
function certifyFit(p: Prepared, cell: ConditionalRosCellFit) {
  if (cell.fit.state !== "fitted") return null;
  equal(
    cell.fit.priorSeasons,
    p.input.scope.sourceSeasons.filter((year) => year < cell.fit.forecastSeason),
    "fit omitted a declared prior year",
  );
  return createConditionalIntervalArtifact({
    context: cell.context,
    fit: cell.fit,
    provenance: provenance(p),
  });
}
function evaluateStrategy(
  p: Prepared,
  cell: MarginalIntervalComparisonCell,
  strategy: FirstPartyRosStrategy,
) {
  const matchesCell = (fit: ConditionalRosCellFit) =>
    sameCell(fit.context, cell) && fit.context.strategy === strategy;
  const live = p.evaluation.liveFits.cells.find(matchesCell)!;
  const liveArtifact = certifyFit(p, live);
  const history = p.evaluation.seasonFits
    .filter((year) => p.requiredYears.includes(year.forecastSeason))
    .map((year) => {
      const fit = year.cells.find(matchesCell)!;
      return {
        forecastSeason: year.forecastSeason,
        artifact: certifyFit(p, fit),
        training: fit.training,
        unavailable: fit.fit.state === "unavailable" ? fit.fit.reasons : null,
      };
    });
  const byYear = new Map(history.map((row) => [row.forecastSeason, row]));
  const applications = new Map(
    history
      .filter((row) => row.artifact !== null)
      .map((row) => [
        row.forecastSeason,
        prepareConditionalIntervalArtifact(row.artifact!, {
          context: row.artifact!.context,
          forecastSeason: row.forecastSeason,
          artifactChecksum: row.artifact!.artifactChecksum,
        }),
      ]),
  );
  const rows = p.evaluation.candidates.filter(
    (row) =>
      sameCell(row, cell) &&
      row.strategy === strategy &&
      p.requiredYears.includes(row.forecastSeason),
  );
  const corrected: MarginalIntervalEvaluationRow[] = [];
  for (const row of rows) {
    const artifact = byYear.get(row.forecastSeason)!.artifact;
    if (row.correction === null) continue;
    if (artifact === null || artifact.fit.checksum !== row.fitChecksum)
      fail("corrected row lacks its certified fit");
    const forecast = {
      seriesKey: row.seriesKey,
      forecastSeason: row.forecastSeason,
      asOfWeek: row.asOfWeek,
      windowStartWeek: row.windowStartWeek,
      windowEndWeek: row.windowEndWeek,
      scheduledGames: row.scheduledGames,
      meanPoints: row.predictedMean,
      ...row.rawQuantiles,
    };
    const rebuilt = applications.get(row.forecastSeason)!(forecast);
    const { calibrationArtifactChecksum: _checksum, ...correction } = rebuilt;
    void _checksum;
    equal(correction, row.correction, "independently applied interval changed");
    corrected.push({
      seriesKey: row.seriesKey,
      forecastSeason: row.forecastSeason,
      asOfWeek: row.asOfWeek,
      windowStartWeek: row.windowStartWeek,
      windowEndWeek: row.windowEndWeek,
      scheduledGames: row.scheduledGames,
      identity: row.identity,
      playerId: row.playerId,
      actualPoints: row.actualPoints,
      rawQuantiles: row.rawQuantiles,
      artifactChecksum: artifact.artifactChecksum,
      trainedThroughSeason: Math.max(...artifact.fit.priorSeasons),
      p15Points: correction.p15Points,
      p50Points: correction.p50Points,
      p85Points: correction.p85Points,
    });
  }
  const evidence = buildMarginalIntervalEvidence({ seriesKey: live.seriesKey, rows: corrected });
  const screen = evaluateMarginalIntervalEvidence(evidence);
  const annual = p.requiredYears.map((year) => ({
    year,
    rows: rows.filter((row) => row.forecastSeason === year),
  }));
  const reasons = [
    ...(liveArtifact === null ? ["live-fit-unavailable"] : []),
    ...history
      .filter((row) => row.artifact === null)
      .map((row) => `${row.forecastSeason}:prior-fit-unavailable`),
    ...annual
      .filter(
        ({ rows: yearRows }) =>
          yearRows.length < 18 || new Set(yearRows.map((row) => row.asOfWeek)).size < 3,
      )
      .map(({ year }) => `${year}:annual-support-incomplete`),
    ...(rows.length !== corrected.length ? ["audit-application-unavailable"] : []),
    ...screen.reasons,
  ];
  return {
    strategy,
    liveArtifact,
    liveTraining: live.training,
    historicalArtifacts: history,
    evidence,
    screen,
    reasons,
    rows,
  };
}
function comparisonRow(
  row: ConditionalRosCandidateEvaluation,
  mode: "corrected" | "legacy" | "raw",
): MarginalIntervalComparisonRow {
  const interval =
    mode === "corrected"
      ? row.correction
      : mode === "legacy"
        ? row.legacyInterval
        : row.rawQuantiles;
  if (
    interval === null ||
    (mode === "legacy" && row.legacyInterval.intervalCalibration !== "split-conformal-cqr")
  )
    fail("required comparison interval unavailable");
  return {
    playerId: row.playerId,
    position: row.position,
    forecastSeason: row.forecastSeason,
    asOfWeek: row.asOfWeek,
    windowStartWeek: row.windowStartWeek,
    windowEndWeek: row.windowEndWeek,
    scheduledGames: row.scheduledGames,
    actualPoints: row.actualPoints,
    p15Points: interval.p15Points,
    p50Points: interval.p50Points,
    p85Points: interval.p85Points,
  };
}
function retainedRow(
  p: Prepared,
  row: FirstPartyRosHeldOutForecast,
  strategy: FirstPartyRosStrategy,
  raw: boolean,
): MarginalIntervalComparisonRow {
  const choice = p.retained.seasonPolicies
    .find((year) => year.season === row.forecastSeason)!
    .policy.choices.find((cell) => cell.position === row.position && cell.bucket === bucket(row))!;
  const artifact = choice.intervalCalibrationArtifacts[key(strategy)];
  if (
    !raw &&
    (artifact.state !== "calibrated" ||
      artifact.trainedThroughSeason === null ||
      artifact.trainedThroughSeason >= row.forecastSeason)
  )
    fail("retained comparator lacks a prior-only calibrated fit");
  const interval = raw
    ? row[key(strategy)]
    : applyFirstPartyRosIntervalCalibration(row[key(strategy)], artifact);
  return {
    playerId: previousPlayer(row, p.input.scope),
    position: row.position,
    forecastSeason: row.forecastSeason,
    asOfWeek: row.asOfWeek,
    windowStartWeek: row.windowStartWeek,
    windowEndWeek: row.windowEndWeek,
    scheduledGames: row.evidence.availability.scheduledGames,
    actualPoints: row.actualPoints,
    p15Points: interval.p15Points,
    p50Points: interval.p50Points,
    p85Points: interval.p85Points,
  };
}
function compare<T>(
  fn: () => T,
): { state: "available"; comparison: T } | { state: "unavailable"; reason: string } {
  try {
    return { state: "available", comparison: fn() };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { state: "unavailable", reason: error.message };
  }
}

/**
 * Independently reconstructs interval evidence from declared raw datasets, never a supplied
 * development verdict. "qualified-interval-evidence" is arithmetic/descriptive qualification:
 * source authenticity, independent predictive confirmation and every non-interval release gate
 * remain separate. Hashes bind supplied provenance; they do not establish its authenticity.
 */
export function buildRosConditionalIntervalQualification(
  input: RosConditionalIntervalQualificationInput,
) {
  const p = prepare(input);
  const source = {
    ...p.candidate.source,
    policyVersion: ROS_CONDITIONAL_INTERVAL_QUALIFICATION_VERSION,
  };
  const reasons: string[] = [];
  const cells = p.cells.map((cell) => {
    const choice = p.evaluation.legacyEvaluation.livePolicy.choices.find((row) =>
      sameCell(row, cell),
    )!;
    const oldChoice = p.retained.livePolicy.choices.find((row) => sameCell(row, cell))!;
    const strategies = STRATEGIES.map((strategy) => evaluateStrategy(p, cell, strategy));
    const selected = strategies.find((row) => row.strategy === choice.strategy)!;
    const rows = selected.rows.filter((row) => row.forecastSeason === p.comparisonYear);
    const previousRows = p.previous.raw.filter(
      (row) =>
        row.forecastSeason === p.comparisonYear &&
        row.position === cell.position &&
        bucket(row) === cell.bucket,
    );
    const comparison = compare(() =>
      compareMarginalIntervalCell({
        evaluationSeason: p.comparisonYear,
        cell,
        candidate: { source, rows: rows.map((row) => comparisonRow(row, "corrected")) },
        benchmarks: {
          "same-physics-legacy": {
            source: p.candidate.source,
            rows: rows.map((row) => comparisonRow(row, "legacy")),
          },
          "previous-deployed": {
            source: p.previous.source,
            rows: previousRows.map((row) => retainedRow(p, row, oldChoice.strategy, false)),
          },
        },
      }),
    );
    const cellReasons = [
      ...selected.reasons,
      ...(comparison.state === "unavailable"
        ? ["wis-comparison-unavailable"]
        : comparison.comparison.worseThan.map((name) => `wis-worse-than-${name}`)),
    ];
    reasons.push(...cellReasons.map((reason) => `${cellKey(cell)}:${reason}`));
    return {
      cell,
      strategy: choice.strategy,
      previousStrategy: oldChoice.strategy,
      meanChoice: choice,
      previousMeanChoice: oldChoice,
      strategies,
      comparison,
      interpretation: "retrospective-final-live-strategy-selection" as const,
      reasons: cellReasons,
    };
  });
  const selected = p.evaluation.selected.filter((row) => row.forecastSeason === p.comparisonYear);
  const previous = p.previous.raw
    .filter((row) => row.forecastSeason === p.comparisonYear)
    .map((row) => ({
      row,
      strategy: p.retained.seasonPolicies
        .find((year) => year.season === p.comparisonYear)!
        .policy.choices.find(
          (cell) => cell.position === row.position && cell.bucket === bucket(row),
        )!.strategy,
    }));
  const portfolio = compare(() =>
    compareMarginalIntervalPortfolio({
      evaluationSeason: p.comparisonYear,
      cells: p.cells,
      candidate: { source, rows: selected.map((row) => comparisonRow(row, "corrected")) },
      benchmarks: {
        "same-physics-raw": {
          source: { ...p.candidate.source, policyVersion: "uncalibrated-raw-v1" },
          rows: selected.map((row) => comparisonRow(row, "raw")),
        },
        "same-physics-legacy": {
          source: p.candidate.source,
          rows: selected.map((row) => comparisonRow(row, "legacy")),
        },
        "previous-raw": {
          source: { ...p.previous.source, policyVersion: "uncalibrated-raw-v1" },
          rows: previous.map(({ row, strategy }) => retainedRow(p, row, strategy, true)),
        },
        "previous-deployed": {
          source: p.previous.source,
          rows: previous.map(({ row, strategy }) => retainedRow(p, row, strategy, false)),
        },
      },
    }),
  );
  reasons.push(
    ...(portfolio.state === "unavailable"
      ? ["portfolio:wis-comparison-unavailable"]
      : portfolio.comparison.worseThan.map((name) => `portfolio:wis-worse-than-${name}`)),
  );
  const sourceBinding = (value: Prepared["candidate"]) => ({
    source: value.source,
    sourceManifestChecksum: value.sourceManifestChecksum,
    rowsChecksum: value.rowsChecksum,
  });
  const body = {
    schemaVersion: 1 as const,
    qualificationMethod: ROS_CONDITIONAL_INTERVAL_QUALIFICATION_VERSION,
    state:
      reasons.length === 0
        ? ("qualified-interval-evidence" as const)
        : ("rejected-interval-evidence" as const),
    canAuthorizeRelease: false as const,
    requiredExternalEvidence: [
      "authenticated-source-and-execution-provenance",
      "independent-predictive-confirmation",
      "mean-and-availability-release-gates",
      "historical-and-live-numerical-qualification",
    ] as const,
    forecastSeason: p.input.forecastSeason,
    sourceScope: p.input.scope,
    requiredEvaluationSeasons: p.requiredYears,
    comparisonSeason: p.comparisonYear,
    sources: {
      candidate: sourceBinding(p.candidate),
      previous: sourceBinding(p.previous),
      intervalTraining: p.training === null ? null : sourceBinding(p.training),
    },
    trainingCohort: p.evaluation.cohort,
    meanSelectorOptions: p.evaluation.meanSelectorOptions,
    meanSelectorPolicyVersion: LEGACY_POLICY,
    cells,
    portfolio,
    portfolioInterpretation: "chronological-prior-policy-and-fit" as const,
    auditCoverage: p.evaluation.auditCoverage,
    // Keep original diagnostics and selected means; interval qualification does not waive them.
    legacyMeanEvaluation: p.evaluation.legacyEvaluation,
    retainedMeanEvaluation: p.retained,
    warmup: p.evaluation.candidates.filter((row) => !p.requiredYears.includes(row.forecastSeason)),
    reasons,
  };
  return { ...body, qualificationChecksum: sha256Hex(canonical(body)) };
}
export type RosConditionalIntervalQualification = ReturnType<
  typeof buildRosConditionalIntervalQualification
>;
/** Rebuild from trusted caller inputs; a self-consistent submitted checksum is insufficient. */
export function rosConditionalIntervalQualificationMatchesInput(
  value: unknown,
  input: RosConditionalIntervalQualificationInput,
): value is RosConditionalIntervalQualification {
  try {
    return matches(value, buildRosConditionalIntervalQualification(input));
  } catch {
    return false;
  }
}
