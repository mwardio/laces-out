import {
  applyMarginalIntervalArtifact,
  marginalIntervalArtifactIsValid,
  marginalIntervalArtifactSeriesKey,
  type MarginalIntervalArtifact,
} from "./marginal-interval-artifact.js";
import {
  compareMarginalIntervalCell,
  type MarginalIntervalComparisonCell,
  type MarginalIntervalComparisonRow,
  type MarginalIntervalComparisonSource,
} from "./marginal-interval-comparison.js";
import {
  buildMarginalIntervalEvidence,
  evaluateMarginalIntervalEvidence,
  type MarginalIntervalEvaluationRow,
} from "./marginal-interval-evidence.js";
import {
  evaluateFirstPartyRosMarginalPolicy,
  FIRST_PARTY_ROS_MARGINAL_POLICY_VERSION,
} from "./marginal-ros-policy.js";
import { validateMarginalRosTrainingCohort } from "./marginal-ros-training.js";
import {
  applyFirstPartyRosIntervalCalibration,
  evaluateFirstPartyRosChampionPolicy,
  type FirstPartyRosChampionOptions,
  type FirstPartyRosHeldOutForecast,
  type FirstPartyRosHeldOutSeason,
  type FirstPartyRosStrategy,
} from "./rest-of-season.js";
import { sha256Hex } from "./sha256.js";

export const ROS_MARGINAL_INTERVAL_QUALIFICATION_VERSION = "ros-marginal-interval-qualification-v1";
const MAX_ROWS = 20_000;
const LEGACY_MEAN_POLICY_VERSION = "season-walk-forward-mean-rmse-block-wis-cqr-v7";
// These are the frozen v7 selector settings, not caller-adjustable qualification parameters.
const MEAN_OPTIONS = {
  minimumHeldOutSeasons: 3,
  minimumBatches: 30,
  minimumSamples: 300,
  minimumCellSeasons: 3,
  minimumCellSamples: 18,
  minimumCellCutoffs: 3,
  minimumCellBatches: 9,
  minimumModelImprovement: 0.01,
} as const satisfies FirstPartyRosChampionOptions;

export interface RosMarginalQualificationDataset {
  /** Pinned raw v7 report identity. These hashes bind a caller's sources; they are not signatures. */
  readonly source: MarginalIntervalComparisonSource;
  readonly sourceManifestChecksum: string;
  /** validateMarginalRosTrainingCohort(seasons, seasons).provenance.evaluationRowsChecksum */
  readonly rowsChecksum: string;
  readonly heldOutSeasons: readonly FirstPartyRosHeldOutSeason[];
}

export interface RosMarginalQualificationScope {
  /** First declared year is warmup; EVERY later year is required, regardless of fit or results. */
  readonly sourceSeasons: readonly number[];
  /** Predeclared complete scope; a missing whole cell must never redefine the required set. */
  readonly requiredCells: readonly MarginalIntervalComparisonCell[];
  readonly protocolChecksum: string;
  readonly sourceManifestChecksum: string;
  /** Immutable full input/evidence report, excluding this envelope to avoid a checksum cycle. */
  readonly fullReportChecksum: string;
  readonly identityAmendment: "none" | "previous-defense-la-to-lar-v1";
}

export interface RosMarginalQualificationInput {
  readonly cell: MarginalIntervalComparisonCell;
  readonly forecastSeason: number;
  readonly scope: RosMarginalQualificationScope;
  readonly candidate: RosMarginalQualificationDataset;
  readonly previous: RosMarginalQualificationDataset;
  readonly intervalTraining?: RosMarginalQualificationDataset;
}

export type RosMarginalQualificationSetInput = Omit<RosMarginalQualificationInput, "cell">;

function fail(message: string): never {
  throw new Error(`ROS marginal qualification: ${message}`);
}

function object(value: unknown, keys: readonly string[], optional: readonly string[] = []): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("invalid object");
  if (
    keys.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !keys.includes(key) && !optional.includes(key))
  )
    fail("unknown or missing fields");
}

function array(value: unknown, min: number, max: number): asserts value is readonly unknown[] {
  if (
    !Array.isArray(value) ||
    value.length < min ||
    value.length > max ||
    Object.keys(value).length !== value.length
  )
    fail("invalid bounded array");
  for (let index = 0; index < value.length; index++)
    if (!Object.hasOwn(value, index)) fail("sparse array");
}

function digest(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) fail("invalid checksum");
}

function integer(value: unknown, min: number, max: number): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max)
    fail("invalid season/count");
}

function text(value: unknown, maximum: number): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum)
    fail("invalid bounded identity");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    array(value, 0, MAX_ROWS);
    return `[${value.map(canonical).join(",")}]`;
  }
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  const result = JSON.stringify(value);
  if (result === undefined || (typeof value === "number" && !Number.isFinite(value)))
    fail("invalid serialized value");
  return result;
}

function equal(left: unknown, right: unknown, message: string): void {
  if (canonical(left) !== canonical(right)) fail(message);
}

/** Traverse only the bounded expected shape; an unknown proof tree is never recursively hashed. */
function matchesExpected(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false;
    if (Object.keys(actual).length !== expected.length) return false;
    return expected.every(
      (entry, index) => Object.hasOwn(actual, index) && matchesExpected(actual[index], entry),
    );
  }
  if (expected !== null && typeof expected === "object") {
    if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return false;
    const keys = Object.keys(expected);
    let count = 0;
    for (const key in actual) {
      if (!Object.hasOwn(actual, key)) continue;
      if (++count > keys.length || !Object.hasOwn(expected, key)) return false;
    }
    if (count !== keys.length) return false;
    return Object.entries(expected).every(
      ([key, entry]) =>
        Object.hasOwn(actual, key) &&
        matchesExpected((actual as Record<string, unknown>)[key], entry),
    );
  }
  return actual === expected;
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

function strategyKey(strategy: FirstPartyRosStrategy) {
  return strategy === "contextual" ? "contextual" : "recency";
}

function forecastShape(row: FirstPartyRosHeldOutForecast): void {
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
  text(row.playerId, 256);
  text(row.contextualModelVersion, 256);
  text(row.recencyModelVersion, 256);
  text(row.intervalMethodVersion, 256);
  text(row.scoringProfileKey, 65_536);
  digest(row.inputChecksum);
  for (const strategy of ["contextual", "recency"] as const) {
    object(row[strategy], ["meanPoints", "p15Points", "p50Points", "p85Points"]);
  }
  object(row.evidence, ["coverage", "availability", "convergence"]);
  object(row.evidence.coverage, ["contextual", "recency"]);
  object(row.evidence.availability, [
    "scheduledGames",
    "actualGames",
    "contextualExpectedGames",
    "recencyExpectedGames",
  ]);
  object(row.evidence.convergence, ["contextual", "recency"]);
  object(row.evidence.convergence.contextual, ["state", "diagnosticChecksum"]);
  object(row.evidence.convergence.recency, ["state", "diagnosticChecksum"]);
}

function dataset(input: RosMarginalQualificationDataset, scope: RosMarginalQualificationScope) {
  object(input, ["source", "sourceManifestChecksum", "rowsChecksum", "heldOutSeasons"]);
  object(input.source, [
    "modelVersion",
    "policyVersion",
    "scoringProfileKey",
    "physicalCorpusChecksum",
    "reportChecksum",
  ]);
  for (const checksum of [
    input.rowsChecksum,
    input.sourceManifestChecksum,
    input.source.physicalCorpusChecksum,
    input.source.reportChecksum,
  ])
    digest(checksum);
  text(input.source.modelVersion, 256);
  text(input.source.scoringProfileKey, 65_536);
  if (input.source.policyVersion !== LEGACY_MEAN_POLICY_VERSION)
    fail("raw report must use the frozen v7 mean selector");
  if (input.sourceManifestChecksum !== scope.sourceManifestChecksum)
    fail("source manifest mismatch");
  array(input.heldOutSeasons, 4, 201);
  let samples = 0;
  for (const season of input.heldOutSeasons) {
    object(season, ["season", "complete", "forecasts"]);
    if (season.complete !== true) fail("source season is incomplete");
    array(season.forecasts, 1, MAX_ROWS);
    samples += season.forecasts.length;
    if (samples > MAX_ROWS) fail("source corpus exceeds row bound");
    for (const row of season.forecasts) {
      forecastShape(row);
      if (
        row.scoringProfileKey !== input.source.scoringProfileKey ||
        !row.contextualModelVersion.startsWith(`${input.source.modelVersion}:contextual:`) ||
        !row.recencyModelVersion.startsWith(
          `${input.source.modelVersion}:availability-aware-recency:`,
        )
      )
        fail("raw row/source model or scoring identity mismatch");
    }
  }
  const checked = validateMarginalRosTrainingCohort(input.heldOutSeasons, input.heldOutSeasons);
  equal(checked.provenance.seasons, scope.sourceSeasons, "declared source seasons mismatch");
  if (checked.provenance.evaluationRowsChecksum !== input.rowsChecksum)
    fail("raw rows do not match their pinned checksum");
  return {
    ...input,
    ordered: checked.ordered,
    raw: checked.ordered.flatMap((year) => year.forecasts),
  };
}

function canonicalPreviousPlayer(
  row: FirstPartyRosHeldOutForecast,
  amendment: RosMarginalQualificationScope["identityAmendment"],
) {
  return amendment === "previous-defense-la-to-lar-v1" &&
    row.position === "DST" &&
    row.playerId === "DST:LA"
    ? "DST:LAR"
    : row.playerId;
}

function observed(row: FirstPartyRosHeldOutForecast, playerId = row.playerId) {
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

function prepare(input: RosMarginalQualificationSetInput) {
  object(input, ["forecastSeason", "scope", "candidate", "previous"], ["intervalTraining"]);
  object(input.scope, [
    "sourceSeasons",
    "requiredCells",
    "protocolChecksum",
    "sourceManifestChecksum",
    "fullReportChecksum",
    "identityAmendment",
  ]);
  const scope = input.scope;
  array(scope.requiredCells, 1, 18);
  const requiredCellKeys = scope.requiredCells.map(cellKey);
  if (new Set(requiredCellKeys).size !== requiredCellKeys.length) fail("duplicate required cell");
  array(scope.sourceSeasons, 4, 201);
  let prior = 1999;
  for (const season of scope.sourceSeasons) {
    integer(season, prior + 1, 2200);
    prior = season;
  }
  integer(input.forecastSeason, prior + 1, 2200);
  for (const checksum of [
    scope.protocolChecksum,
    scope.sourceManifestChecksum,
    scope.fullReportChecksum,
  ])
    digest(checksum);
  if (!["none", "previous-defense-la-to-lar-v1"].includes(scope.identityAmendment))
    fail("unsupported identity amendment");
  const candidate = dataset(input.candidate, scope);
  const previous = dataset(input.previous, scope);
  const training =
    input.intervalTraining === undefined ? null : dataset(input.intervalTraining, scope);
  if (candidate.source.scoringProfileKey !== previous.source.scoringProfileKey)
    fail("candidate/previous scoring mismatch");
  if (training !== null) {
    if (
      training.source.modelVersion !== candidate.source.modelVersion ||
      training.source.scoringProfileKey !== candidate.source.scoringProfileKey
    )
      fail("interval training source identity mismatch");
    if (
      training.source.physicalCorpusChecksum === candidate.source.physicalCorpusChecksum ||
      training.source.physicalCorpusChecksum === previous.source.physicalCorpusChecksum
    )
      fail("separate interval training requires a distinct corpus identity");
  }
  const positions = new Set(candidate.raw.map((row) => row.position));
  const key = (row: FirstPartyRosHeldOutForecast, playerId = row.playerId) =>
    canonical([row.position, row.forecastSeason, row.asOfWeek, playerId]);
  const old = new Map<string, FirstPartyRosHeldOutForecast>();
  for (const row of previous.raw.filter((row) => positions.has(row.position))) {
    const identity = key(row, canonicalPreviousPlayer(row, scope.identityAmendment));
    if (old.has(identity)) fail("previous canonical player identity collision");
    old.set(identity, row);
  }
  if (old.size !== candidate.raw.length) fail("all-season benchmark cohort mismatch");
  for (const row of candidate.raw) {
    if (scope.identityAmendment === "previous-defense-la-to-lar-v1" && row.playerId === "DST:LA")
      fail("candidate contains the unamended defense identity");
    const matched = old.get(key(row));
    if (!matched) fail("all-season benchmark cohort mismatch");
    equal(
      observed(row),
      observed(matched, canonicalPreviousPlayer(matched, scope.identityAmendment)),
      "all-season benchmark outcome/schedule mismatch",
    );
  }
  const cells = new Map<string, MarginalIntervalComparisonCell>();
  for (const row of candidate.raw) {
    const cell = { position: row.position, bucket: bucket(row) } as const;
    cells.set(cellKey(cell), cell);
  }
  equal(
    [...cells.keys()].sort(),
    [...requiredCellKeys].sort(),
    "candidate corpus does not cover the exact required cell scope",
  );
  const marginal = evaluateFirstPartyRosMarginalPolicy(candidate.ordered, {
    forecastSeason: input.forecastSeason,
    championOptions: MEAN_OPTIONS,
    ...(training === null ? {} : { intervalTrainingSeasons: training.ordered }),
  });
  const oldPolicy = evaluateFirstPartyRosChampionPolicy(previous.ordered, MEAN_OPTIONS);
  return {
    input,
    candidate,
    previous,
    training,
    marginal,
    oldPolicy,
    cells: [...scope.requiredCells].sort((a, b) => cellKey(a).localeCompare(cellKey(b))),
    requiredSeasons: scope.sourceSeasons.slice(1),
    comparisonSeason: scope.sourceSeasons.at(-1)!,
  };
}

type Prepared = ReturnType<typeof prepare>;

function comparisonRow(
  row: MarginalIntervalEvaluationRow,
  cell: MarginalIntervalComparisonCell,
): MarginalIntervalComparisonRow {
  return {
    playerId: row.playerId,
    position: cell.position,
    forecastSeason: row.forecastSeason,
    asOfWeek: row.asOfWeek,
    windowStartWeek: row.windowStartWeek,
    windowEndWeek: row.windowEndWeek,
    scheduledGames: row.scheduledGames,
    actualPoints: row.actualPoints,
    p15Points: row.p15Points,
    p50Points: row.p50Points,
    p85Points: row.p85Points,
  };
}

function comparisonObservation(row: MarginalIntervalComparisonRow) {
  return [
    row.position,
    row.forecastSeason,
    row.asOfWeek,
    row.playerId,
    row.windowStartWeek,
    row.windowEndWeek,
    row.scheduledGames,
    row.actualPoints,
  ];
}

function orderedComparisonRows(rows: readonly MarginalIntervalComparisonRow[]) {
  return [...rows].sort(
    (a, b) =>
      a.asOfWeek - b.asOfWeek || (a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0),
  );
}

function build(prepared: Prepared, cell: MarginalIntervalComparisonCell) {
  const {
    input,
    candidate,
    previous,
    training,
    marginal,
    oldPolicy,
    requiredSeasons,
    comparisonSeason,
  } = prepared;
  const matches = (row: MarginalIntervalComparisonCell) =>
    row.position === cell.position && row.bucket === cell.bucket;
  if (!prepared.cells.some(matches)) fail("cell is absent from the pinned audit");
  const choice = marginal.livePolicy.choices.find(matches)!;
  const previousChoice = oldPolicy.livePolicy.choices.find(matches)!;
  const strategy = choice.strategy;
  const liveArtifact = choice.intervalArtifacts[strategyKey(strategy)];
  if (
    !liveArtifact ||
    !marginalIntervalArtifactIsValid(liveArtifact) ||
    liveArtifact.fit.state !== "fitted"
  )
    fail("required live interval fit is unavailable");
  equal(
    liveArtifact.fit.priorSeasons,
    input.scope.sourceSeasons,
    "live fit omits declared prior years",
  );
  const seriesKey = marginalIntervalArtifactSeriesKey(liveArtifact.context);
  const historicalArtifacts: { forecastSeason: number; artifact: MarginalIntervalArtifact }[] = [];
  const corrected: MarginalIntervalEvaluationRow[] = [];
  const scoped = (row: FirstPartyRosHeldOutForecast) =>
    row.position === cell.position && bucket(row) === cell.bucket;
  for (const season of requiredSeasons) {
    const artifact = marginal.seasonPolicies
      .find((row) => row.season === season)
      ?.policy.choices.find(matches)?.intervalArtifacts[strategyKey(strategy)];
    if (!artifact || !marginalIntervalArtifactIsValid(artifact) || artifact.fit.state !== "fitted")
      fail("required historical interval fit is unavailable");
    equal(artifact.context, liveArtifact.context, "historical interval context mismatch");
    equal(
      artifact.fit.priorSeasons,
      input.scope.sourceSeasons.filter((year) => year < season),
      "historical fit omits declared prior years",
    );
    if (artifact.fit.forecastSeason !== season) fail("historical fit forecast chronology mismatch");
    historicalArtifacts.push({ forecastSeason: season, artifact });
    const rows = candidate.raw.filter((row) => row.forecastSeason === season && scoped(row));
    if (rows.length < 18 || new Set(rows.map((row) => row.asOfWeek)).size < 3)
      fail("required annual evaluation needs 3 cutoffs and 18 rows");
    const evaluated = marginal.candidates.filter(
      (row) => row.forecastSeason === season && matches(row) && row.strategy === strategy,
    );
    if (evaluated.length !== rows.length) fail("required candidate cohort is incomplete");
    const byIdentity = new Map(evaluated.map((row) => [row.identity, row]));
    for (const raw of rows) {
      const identity = JSON.stringify([
        raw.playerId,
        raw.forecastSeason,
        raw.asOfWeek,
        raw.windowStartWeek,
        raw.windowEndWeek,
        raw.inputChecksum,
      ]);
      const evaluatedRow = byIdentity.get(identity);
      if (
        !evaluatedRow ||
        evaluatedRow.intervalState !== "corrected" ||
        !evaluatedRow.corrected ||
        evaluatedRow.withheldReason !== null ||
        evaluatedRow.calibrationArtifactChecksum !== artifact.artifactChecksum
      )
        fail("required audit interval is withheld or missing its artifact");
      const source = raw[strategyKey(strategy)];
      if (evaluatedRow.predictedMean !== source.meanPoints)
        fail("interval evaluation changed a mean");
      const rawQuantiles = {
        p15Points: source.p15Points,
        p50Points: source.p50Points,
        p85Points: source.p85Points,
      };
      const forecast = {
        seriesKey,
        forecastSeason: raw.forecastSeason,
        asOfWeek: raw.asOfWeek,
        windowStartWeek: raw.windowStartWeek,
        windowEndWeek: raw.windowEndWeek,
        scheduledGames: raw.evidence.availability.scheduledGames,
        ...rawQuantiles,
      };
      const applied = applyMarginalIntervalArtifact(forecast, liveArtifact.context, artifact);
      const row: MarginalIntervalEvaluationRow = {
        ...forecast,
        identity,
        playerId: raw.playerId,
        actualPoints: raw.actualPoints,
        rawQuantiles,
        artifactChecksum: artifact.artifactChecksum,
        trainedThroughSeason: Math.max(...artifact.fit.priorSeasons),
        p15Points: applied.p15Points,
        p50Points: applied.p50Points,
        p85Points: applied.p85Points,
      };
      equal(evaluatedRow.corrected, row, "reconstructed corrected row mismatch");
      equal(
        evaluatedRow.rearrangement,
        applied.rearrangement,
        "reconstructed rearrangement mismatch",
      );
      corrected.push(row);
    }
  }
  const evidence = buildMarginalIntervalEvidence({ seriesKey, rows: corrected });
  equal(
    evidence.perSeason.map((row) => row.forecastSeason),
    requiredSeasons,
    "held-out years were dropped",
  );
  equal(
    evidence,
    choice.intervalEvidence[strategyKey(strategy)],
    "fixed-strategy evidence mismatch",
  );
  const screen = evaluateMarginalIntervalEvidence(evidence);
  const latest = corrected.filter((row) => row.forecastSeason === comparisonSeason);
  const legacyRows = (
    source: Prepared["candidate"],
    legacy: typeof oldPolicy,
    selected: FirstPartyRosStrategy,
    amend: boolean,
  ) => {
    const frozen = legacy.seasonPolicies
      .find((row) => row.season === comparisonSeason)!
      .policy.choices.find(matches)!;
    const artifact = frozen.intervalCalibrationArtifacts[strategyKey(selected)];
    if (
      artifact.state !== "calibrated" ||
      artifact.trainedThroughSeason === null ||
      artifact.trainedThroughSeason >= comparisonSeason
    )
      fail("required prior-only legacy benchmark artifact is unavailable");
    return source.raw
      .filter((row) => row.forecastSeason === comparisonSeason && scoped(row))
      .map((row): MarginalIntervalComparisonRow => {
        const interval = applyFirstPartyRosIntervalCalibration(
          row[strategyKey(selected)],
          artifact,
        );
        if (interval.intervalCalibration !== "split-conformal-cqr")
          fail("legacy comparator is uncalibrated");
        return {
          playerId: amend
            ? canonicalPreviousPlayer(row, input.scope.identityAmendment)
            : row.playerId,
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
      });
  };
  const latestComparisonRows = orderedComparisonRows(latest.map((row) => comparisonRow(row, cell)));
  const comparison = compareMarginalIntervalCell({
    evaluationSeason: comparisonSeason,
    cell,
    candidate: {
      source: { ...candidate.source, policyVersion: FIRST_PARTY_ROS_MARGINAL_POLICY_VERSION },
      rows: latestComparisonRows,
    },
    benchmarks: {
      "same-physics-legacy": {
        source: candidate.source,
        rows: legacyRows(candidate, marginal.legacyEvaluation, strategy, false),
      },
      "previous-deployed": {
        source: previous.source,
        rows: legacyRows(previous, oldPolicy, previousChoice.strategy, true),
      },
    },
  });
  if (
    comparison.cells[0]!.cohortChecksum !==
    sha256Hex(canonical(latestComparisonRows.map(comparisonObservation)))
  )
    fail("comparison observation cohort does not match the reconstructed audit");
  const linkage = evidence.blocks.map((block) => {
    const rows = orderedComparisonRows(
      corrected
        .filter(
          (row) => row.forecastSeason === block.forecastSeason && row.asOfWeek === block.asOfWeek,
        )
        .map((row) => comparisonRow(row, cell)),
    );
    const correctedRowsChecksum = sha256Hex(canonical(rows));
    const observationChecksum = sha256Hex(canonical(rows.map(comparisonObservation)));
    const comparedRows =
      block.forecastSeason === comparisonSeason
        ? latestComparisonRows.filter((row) => row.asOfWeek === block.asOfWeek)
        : null;
    const comparisonCandidateRowsChecksum =
      comparedRows === null ? null : sha256Hex(canonical(comparedRows));
    const matched =
      block.forecastSeason === comparisonSeason
        ? comparison.cells[0]!.blocks.find((row) => row.asOfWeek === block.asOfWeek)
        : null;
    if (
      block.forecastSeason === comparisonSeason &&
      (!matched ||
        matched.samples !== block.samples ||
        matched.windowStartWeek !== block.windowStartWeek ||
        matched.windowEndWeek !== block.windowEndWeek ||
        correctedRowsChecksum !== comparisonCandidateRowsChecksum ||
        observationChecksum !== sha256Hex(canonical(comparedRows!.map(comparisonObservation))))
    )
      fail("latest comparison is not the exact evidence subset");
    return {
      forecastSeason: block.forecastSeason,
      asOfWeek: block.asOfWeek,
      samples: block.samples,
      observationChecksum,
      correctedRowsChecksum,
      comparisonCandidateRowsChecksum,
      evidenceSourceRowsChecksum: block.sourceRowsChecksum,
      comparisonRowsChecksum: matched?.rowsChecksum ?? null,
    };
  });
  const reasons = [
    ...screen.reasons,
    ...comparison.worseThan.map((benchmark) => `wis-worse-than-${benchmark}`),
  ];
  const binding = (value: Prepared["candidate"]) => ({
    source: value.source,
    sourceManifestChecksum: value.sourceManifestChecksum,
    rowsChecksum: value.rowsChecksum,
  });
  const body = {
    schemaVersion: 1,
    qualificationMethod: ROS_MARGINAL_INTERVAL_QUALIFICATION_VERSION,
    state: reasons.length ? "failed-qualification" : "qualified",
    interpretation: "historical-descriptive",
    canAuthorizeRelease: false,
    scope: "final-live-fixed-strategy-cell",
    cell: { position: cell.position, bucket: cell.bucket },
    forecastSeason: input.forecastSeason,
    requiredEvaluationSeasons: [...requiredSeasons],
    comparisonSeason,
    strategy,
    previousStrategy: previousChoice.strategy,
    meanSelectorPolicyVersion: LEGACY_MEAN_POLICY_VERSION,
    meanSelectorOptions: { ...MEAN_OPTIONS },
    meanChoice: choice.meanChoice,
    previousMeanChoice: previousChoice,
    sourceScope: input.scope,
    sources: {
      candidate: binding(candidate),
      previous: binding(previous),
      intervalTraining: training === null ? null : binding(training),
    },
    intervalTraining: marginal.intervalTraining ?? null,
    liveArtifact,
    historicalArtifacts,
    evidence,
    comparison,
    linkage,
    reasons,
  } as const;
  return { ...body, qualificationChecksum: sha256Hex(canonical(body)) };
}

export type RosMarginalIntervalQualification = ReturnType<typeof build>;

/**
 * Rebuild from pinned raw sources; hand-written evidence, strategies or artifacts are never inputs.
 * A qualified interval does not clear any mean, source, availability, convergence or release gate.
 * The validated pipeline/admitted immutable artifact remains responsible for source authenticity.
 */
export function buildRosMarginalIntervalQualification(
  input: RosMarginalQualificationInput,
): RosMarginalIntervalQualification {
  object(input, ["cell", "forecastSeason", "scope", "candidate", "previous"], ["intervalTraining"]);
  cellKey(input.cell);
  const { cell, ...shared } = input;
  return build(prepare(shared), cell);
}

/** All protocol-declared cells, sharing one policy reconstruction. Failed cells are never filtered. */
export function buildRosMarginalIntervalQualificationSet(
  input: RosMarginalQualificationSetInput,
): readonly RosMarginalIntervalQualification[] {
  const prepared = prepare(input);
  return prepared.cells.map((cell) => build(prepared, cell));
}

/** Matching supplied pinned input is stronger than a self-consistent hash, but is not authentication. */
export function rosMarginalIntervalQualificationMatchesInput(
  value: unknown,
  input: RosMarginalQualificationInput,
): boolean {
  try {
    return matchesExpected(value, buildRosMarginalIntervalQualification(input));
  } catch {
    return false;
  }
}

/** Reject missing, extra or duplicate cells; failed numerical receipts still remain valid evidence. */
export function rosMarginalIntervalQualificationSetMatchesInput(
  value: unknown,
  input: RosMarginalQualificationSetInput,
): boolean {
  try {
    array(value, 1, 18);
    array(input.scope.requiredCells, 1, 18);
    if (value.length !== input.scope.requiredCells.length) return false;
    const seen = new Set<string>();
    for (const entry of value) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return false;
      const key = cellKey((entry as { cell: MarginalIntervalComparisonCell }).cell);
      if (seen.has(key)) return false;
      seen.add(key);
    }
    const expected = buildRosMarginalIntervalQualificationSet(input);
    if (value.length !== expected.length) return false;
    const actualByCell = new Map(
      value.map((entry) => [
        cellKey((entry as { cell: MarginalIntervalComparisonCell }).cell),
        entry,
      ]),
    );
    return expected.every((entry) => matchesExpected(actualByCell.get(cellKey(entry.cell)), entry));
  } catch {
    return false;
  }
}
