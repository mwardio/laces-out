import { createHash } from "node:crypto";

import { NFL_TEAMS } from "@laces-out/domain";
import {
  defensePointsAllowedDefinitionForProfile,
  evaluateFirstPartyRosConvergence,
  rosProfileDefinitionFromKey,
  type FirstPartyRosConvergenceSummary,
  type FirstPartyRosHeldOutForecast,
  type ProjectionDefensePointsAllowedDefinition,
} from "@laces-out/projections";

import {
  historicalRosBucket,
  historicalRosChecksum,
  historicalRosConvergenceChecksum,
} from "./first-party-ros-backtest.js";
import { ROS_HISTORICAL_ACTUAL_DEFINITION_VERSION } from "./ros-historical-corpus.js";

export const ROS_DERIVED_EVALUATION_VERSION =
  "corrected-observed-truth-fixed-forecast-comparison-v1";
const PLAYER_ACTUALS = "complete-player-ledger-actuals-v1";
const SOURCE_SEMANTICS =
  "sources identify corrected observed truth; original forecast source identities are retained in the comparison manifest";
const SHA = /^[a-f0-9]{64}$/u;
const POSITIONS = ["QB", "RB", "WR", "TE", "K", "DST"] as const;
const SEASONS = [2022, 2023, 2024, 2025];
const SOURCE_FIELDS = [
  "weeklyStatsChecksum",
  "playerWeeklyRawChecksum",
  "playerTouchdownPlayByPlayChecksum",
  "teamWeeklyStatsChecksum",
  "weeklyRosterChecksum",
  "injuryChecksum",
  "snapChecksum",
  "scheduleChecksum",
];
const MANIFEST_KEYS = [
  "version",
  "profile",
  "legacyProfileDigest",
  "pointsAllowedDefinition",
  "observedActualDefinitionVersion",
  "observedSources",
  "nonDstFragmentIdentity",
  "originalCandidateReportSha256",
  "originalPreviousReportSha256",
  "nativeTrainingReportSha256",
  "originalCandidatePhysicalCorpus",
  "originalPreviousPhysicalCorpus",
  "correctedDstPhysicalCorpus",
  "originalCandidateForecastSources",
  "originalPreviousForecastSources",
  "correctedDstForecastSources",
  "candidateRowsChecksum",
  "previousRowsChecksum",
  "convergenceBindings",
  "originalAuditMembershipPreserved",
  "originalPreviousRawPredictionsPreserved",
  "previousSelectionAndCalibrationRecomputedAgainstCorrectedObservations",
  "noSimulation",
  "canAuthorizeRelease",
];

export interface RosDerivedEvaluationInput {
  readonly comparisonManifestJson: string;
  readonly comparisonManifestChecksum: string;
  readonly originalCandidateReportJson: string;
  readonly originalCandidateReportChecksum: string;
  readonly originalPreviousReportJson: string;
  readonly originalPreviousReportChecksum: string;
}

export interface RosDerivedEvaluationLineage {
  readonly version: typeof ROS_DERIVED_EVALUATION_VERSION;
  readonly comparisonManifestIdentity: string;
  readonly comparisonManifestChecksum: string;
  readonly originalCandidateReportChecksum: string;
  readonly originalPreviousReportChecksum: string;
  readonly intervalTrainingReportChecksum: string;
  readonly originalCandidatePhysicalCorpus: string;
  readonly originalPreviousPhysicalCorpus: string;
  readonly correctedDstPhysicalCorpus: string;
  readonly nonDstFragmentIdentity: string;
  readonly pointsAllowedDefinition: ProjectionDefensePointsAllowedDefinition;
  readonly observedActualDefinitionVersion: typeof PLAYER_ACTUALS;
  readonly observedSources: readonly Readonly<Record<string, unknown>>[];
  readonly originalCandidateForecastSources: readonly Readonly<Record<string, unknown>>[];
  readonly originalPreviousForecastSources: readonly Readonly<Record<string, unknown>>[];
  readonly correctedDstForecastSources: readonly Readonly<Record<string, unknown>>[];
  readonly candidateRowsChecksum: string;
  readonly previousRowsChecksum: string;
}

function fail(message: string): never {
  throw new Error(`Derived ROS evaluation: ${message}`);
}
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("missing object");
  return value as Record<string, unknown>;
}
function array(value: unknown, count: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length !== count) fail(`expected ${count} entries`);
  return value;
}
function sha(value: unknown): string {
  if (typeof value !== "string" || !SHA.test(value)) fail("invalid SHA256");
  return value;
}
const bytesHash = (value: string) => createHash("sha256").update(value).digest("hex");
function same(left: unknown, right: unknown, label: string): void {
  if (historicalRosChecksum(left) !== historicalRosChecksum(right)) fail(label);
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  same(Object.keys(value).sort(), [...keys].sort(), "unexpected envelope fields");
}
function pin(
  text: string,
  checksum: string,
  maximumBytes = 64 * 1_024 * 1_024,
): Record<string, unknown> {
  if (
    typeof text !== "string" ||
    Buffer.byteLength(text) > maximumBytes ||
    bytesHash(text) !== sha(checksum)
  )
    fail("report byte pin mismatch or size exceeded");
  const value: unknown = JSON.parse(text);
  let nodes = 0;
  function bounded(input: unknown, depth: number): void {
    if (++nodes > 4_000_000 || depth > 24) fail("report JSON complexity exceeded");
    if (typeof input === "number" && !Number.isFinite(input)) fail("nonfinite report number");
    if (input !== null && typeof input === "object") {
      const values = Object.values(input);
      if (values.length > 20_000) fail("report collection exceeded bounds");
      for (const child of values) bounded(child, depth + 1);
    }
  }
  bounded(value, 0);
  return record(value);
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function without(value: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
}
function sources(value: unknown): readonly Record<string, unknown>[] {
  const rows = array(value, 7).map(record);
  same(
    rows.map((row) => row.season),
    [2019, 2020, 2021, 2022, 2023, 2024, 2025],
    "source seasons changed",
  );
  for (const row of rows) for (const key of SOURCE_FIELDS) sha(row[key]);
  return rows;
}
function canonicalPlayer(player: string): string {
  return player === "DST:LA" ? "DST:LAR" : player;
}
function rowId(row: FirstPartyRosHeldOutForecast): string {
  return `${row.forecastSeason}:${row.asOfWeek}:${row.position}:${canonicalPlayer(row.playerId)}`;
}
function stratum(row: FirstPartyRosHeldOutForecast): string {
  return `${row.forecastSeason}:${row.position}:${historicalRosBucket(row.windowStartWeek, row.windowEndWeek)}`;
}
function rows(
  report: Record<string, unknown>,
  training: boolean,
  model: "v12" | "v13",
): readonly FirstPartyRosHeldOutForecast[] {
  const count = training ? 2176 : 3264;
  const raw = array(
    record(report.diagnostics).candidateForecasts,
    count,
  ) as unknown as readonly FirstPartyRosHeldOutForecast[];
  const summary = record(report.report);
  const scope = record(report.validationScope);
  same(scope.positions, training ? ["DST"] : POSITIONS, "evaluation position scope changed");
  if (
    scope.completePortfolio !== !training ||
    summary.forecasts !== count ||
    summary.playersPerPosition !== (training ? 32 : 8) ||
    summary.skippedForecasts !== 0
  )
    fail("incomplete locked cohort");
  same(summary.seasons, SEASONS, "held-out seasons changed");
  const profile = record(report.identityAudit).scoringProfileKey;
  if (typeof profile !== "string") fail("missing report scoring identity");
  rosProfileDefinitionFromKey(profile);
  const identities = new Set<string>();
  const groups = new Map<string, Set<string>>();
  for (const row of raw) {
    if (
      !POSITIONS.includes(row.position) ||
      (training && row.position !== "DST") ||
      typeof row.playerId !== "string" ||
      !SEASONS.includes(row.forecastSeason) ||
      !Number.isInteger(row.asOfWeek) ||
      row.asOfWeek < 1 ||
      row.asOfWeek > 17 ||
      row.windowStartWeek !== row.asOfWeek + 1 ||
      row.windowEndWeek !== 18 ||
      row.trainedThroughSeason !== row.forecastSeason - 1 ||
      row.scoringProfileKey !== profile ||
      typeof row.actualPoints !== "number" ||
      !Number.isFinite(row.actualPoints)
    )
      fail("forecast scope, identity or label mismatch");
    if (
      row.contextualModelVersion !==
        `laces-ros-distribution-${model}:contextual:laces-weekly-components-v15` ||
      row.recencyModelVersion !==
        `laces-ros-distribution-${model}:availability-aware-recency:laces-weekly-components-v15`
    )
      fail("physical forecast model changed");
    if (
      (row.position === "DST") !== row.playerId.startsWith("DST:") ||
      (row.position === "DST" &&
        !NFL_TEAMS.some((team) => canonicalPlayer(row.playerId) === `DST:${team}`))
    )
      fail("unknown defense identity");
    sha(row.inputChecksum);
    const identity = rowId(row);
    if (identities.has(identity)) fail("duplicate canonical forecast identity");
    identities.add(identity);
    const group = `${row.forecastSeason}:${row.asOfWeek}:${row.position}`;
    const players = groups.get(group) ?? new Set<string>();
    players.add(canonicalPlayer(row.playerId));
    groups.set(group, players);
    record(row.evidence);
    record(row.evidence.availability);
    record(row.evidence.coverage);
    record(row.evidence.convergence);
    const availability = row.evidence.availability;
    if (
      !Number.isInteger(availability.scheduledGames) ||
      availability.scheduledGames < 1 ||
      availability.scheduledGames > Math.min(17, 18 - row.asOfWeek) ||
      !Number.isInteger(availability.actualGames) ||
      availability.actualGames < 0 ||
      availability.actualGames > availability.scheduledGames
    )
      fail("invalid observed game support");
    for (const expected of [
      availability.contextualExpectedGames,
      availability.recencyExpectedGames,
    ])
      if (
        typeof expected !== "number" ||
        !Number.isFinite(expected) ||
        expected < 0 ||
        expected > availability.scheduledGames
      )
        fail("invalid expected game support");
    for (const name of ["contextual", "recency"] as const) {
      const coverage = row.evidence.coverage[name];
      const convergence = row.evidence.convergence[name];
      if (
        typeof coverage !== "number" ||
        !Number.isFinite(coverage) ||
        coverage < 0 ||
        coverage > 1 ||
        (convergence.state !== "converged" && convergence.state !== "unstable")
      )
        fail("invalid raw forecast evidence");
      sha(convergence.diagnosticChecksum);
    }
    for (const candidate of [row.contextual, row.recency]) {
      record(candidate);
      for (const metric of ["meanPoints", "p15Points", "p50Points", "p85Points"] as const)
        if (typeof candidate[metric] !== "number" || !Number.isFinite(candidate[metric]))
          fail("invalid raw forecast value");
    }
  }
  if (
    groups.size !== 4 * 17 * (training ? 1 : 6) ||
    [...groups.values()].some((players) => players.size !== (training ? 32 : 8))
  )
    fail("missing original position/cutoff population");
  return raw;
}
function physical(row: FirstPartyRosHeldOutForecast): Record<string, unknown> {
  return without(record(row), ["scoringProfileKey", "actualPoints"]);
}
function truth(row: FirstPartyRosHeldOutForecast) {
  return {
    identity: rowId(row),
    windowStartWeek: row.windowStartWeek,
    windowEndWeek: row.windowEndWeek,
    scheduledGames: row.evidence.availability.scheduledGames,
    actualGames: row.evidence.availability.actualGames,
    actualPoints: row.actualPoints,
  };
}
function stripConvergence(row: FirstPartyRosHeldOutForecast) {
  return { ...row, evidence: without(record(row.evidence), ["convergence"]) };
}
function profileKey(report: Record<string, unknown>): string {
  const key = record(report.identityAudit).scoringProfileKey;
  if (typeof key !== "string") fail("missing scoring profile");
  return key;
}

function validateConvergence(
  manifest: Record<string, unknown>,
  candidate: Record<string, unknown>,
  candidateRows: readonly FirstPartyRosHeldOutForecast[],
  scoringProfileKey: string,
): void {
  const samples = new Map<string, FirstPartyRosHeldOutForecast>();
  for (const row of candidateRows.filter((row) => row.position === "DST")) {
    const key = stratum(row);
    const previous = samples.get(key);
    if (
      !previous ||
      historicalRosChecksum(row.inputChecksum).localeCompare(
        historicalRosChecksum(previous.inputChecksum),
      ) < 0
    )
      samples.set(key, row);
  }
  if (samples.size !== 12) fail("missing deterministic DST convergence strata");
  const bindings = array(manifest.convergenceBindings, 24).map(record);
  const seen = new Set<string>();
  const physicalKeys = new Set<string>();
  const audit = array(record(candidate.report).convergenceAudit, 144).map(record);
  for (const binding of bindings) {
    exactKeys(binding, ["stratum", "strategy", "physicalKey", "manifestChecksum", "diagnostic"]);
    const strategy = binding.strategy;
    if (
      typeof binding.stratum !== "string" ||
      (strategy !== "contextual" && strategy !== "availability-aware-recency")
    )
      fail("invalid convergence binding");
    const sample = samples.get(binding.stratum);
    const id = `${binding.stratum}:${strategy}`;
    if (!sample || seen.has(id)) fail("duplicate or unknown convergence binding");
    seen.add(id);
    const key = record(binding.physicalKey);
    exactKeys(key, ["modelVersion", "identity"]);
    if (key.modelVersion !== "laces-ros-distribution-v13" || physicalKeys.has(sha(key.identity)))
      fail("invalid or duplicate convergence physical key");
    physicalKeys.add(sha(key.identity));
    sha(binding.manifestChecksum);
    const diagnostic = record(binding.diagnostic);
    const metrics = array(diagnostic.metrics, 5).map(record);
    const expectedMetrics = ["expectedGames", "meanPoints", "p15Points", "p50Points", "p85Points"];
    same(
      metrics.map((metric) => metric.metric),
      expectedMetrics,
      "convergence metric scope changed",
    );
    const shared = { seedHash: sha(diagnostic.seedHash), scoringProfileKey };
    const release = {
      ...shared,
      scenarioCount: 12_288,
      ...Object.fromEntries(metrics.map((metric) => [String(metric.metric), metric.releaseValue])),
    } as unknown as FirstPartyRosConvergenceSummary;
    const reference = {
      ...shared,
      scenarioCount: 16_384,
      ...Object.fromEntries(
        metrics.map((metric) => [String(metric.metric), metric.referenceValue]),
      ),
    } as unknown as FirstPartyRosConvergenceSummary;
    const reconstructed = evaluateFirstPartyRosConvergence({ position: "DST", release, reference });
    same(diagnostic, reconstructed, "convergence diagnostic does not reconstruct");
    const name = strategy === "contextual" ? "contextual" : "recency";
    same(
      without(record(release), ["seedHash", "scoringProfileKey", "scenarioCount", "expectedGames"]),
      sample[name],
      "convergence release predictions differ from selected sample",
    );
    if (
      release.expectedGames !==
      sample.evidence.availability[
        name === "contextual" ? "contextualExpectedGames" : "recencyExpectedGames"
      ]
    )
      fail("convergence availability differs from selected sample");
    const bucket = historicalRosBucket(sample.windowStartWeek, sample.windowEndWeek);
    const diagnosticChecksum = historicalRosConvergenceChecksum({
      season: sample.forecastSeason,
      position: "DST",
      bucket,
      strategy,
      diagnostics: [reconstructed],
    });
    for (const row of candidateRows.filter((row) => stratum(row) === binding.stratum))
      same(
        row.evidence.convergence[name],
        { state: reconstructed.state, diagnosticChecksum },
        "DST row convergence differs from authenticated stratum",
      );
    const matching = audit.filter(
      (entry) =>
        entry.season === sample.forecastSeason &&
        entry.position === "DST" &&
        entry.bucket === bucket &&
        entry.strategy === strategy,
    );
    if (matching.length !== 1) fail("missing or duplicate DST convergence audit");
    same(
      matching[0],
      {
        season: sample.forecastSeason,
        position: "DST",
        bucket,
        strategy,
        state: reconstructed.state,
        worstMetric: reconstructed.worstMetric,
        worstToleranceRatio: reconstructed.worstToleranceRatio,
      },
      "DST convergence audit differs from binding",
    );
  }
}

/**
 * Pure report integrity boundary, not external authorization or physical-byte certification.
 * Callers still authenticate retained files/proof dependencies and run unchanged numerical gates.
 * Returned original policy evidence must be evaluated frozen, not refitted on corrected labels.
 */
export function validateRosDerivedEvaluation(options: {
  readonly input: RosDerivedEvaluationInput;
  readonly candidateReportJson: string;
  readonly candidateReportChecksum: string;
  readonly previousReportJson: string;
  readonly previousReportChecksum: string;
  readonly intervalTrainingReportJson: string;
  readonly intervalTrainingReportChecksum: string;
}): {
  readonly originalCandidateReport: Readonly<Record<string, unknown>>;
  readonly originalPreviousReport: Readonly<Record<string, unknown>>;
  readonly lineage: RosDerivedEvaluationLineage;
} {
  const input = options.input;
  const envelope = pin(
    input.comparisonManifestJson,
    input.comparisonManifestChecksum,
    2 * 1_024 * 1_024,
  );
  exactKeys(envelope, ["identity", "payload"]);
  const manifest = record(envelope.payload);
  exactKeys(manifest, MANIFEST_KEYS);
  const identity = sha(envelope.identity);
  if (
    historicalRosChecksum(manifest) !== identity ||
    manifest.version !== ROS_DERIVED_EVALUATION_VERSION
  )
    fail("comparison manifest identity or version mismatch");
  for (const flag of [
    "originalAuditMembershipPreserved",
    "originalPreviousRawPredictionsPreserved",
    "previousSelectionAndCalibrationRecomputedAgainstCorrectedObservations",
    "noSimulation",
  ])
    if (manifest[flag] !== true) fail(`missing ${flag}`);
  if (
    manifest.canAuthorizeRelease !== false ||
    manifest.observedActualDefinitionVersion !== PLAYER_ACTUALS
  )
    fail("unsupported certification or claimed release authority");
  const definition = manifest.pointsAllowedDefinition;
  if (definition !== "yahoo-2022-v1" && definition !== "espn-2019-v1")
    fail("unknown observed points-allowed definition");
  const originalCandidate = pin(
    input.originalCandidateReportJson,
    input.originalCandidateReportChecksum,
  );
  const originalPrevious = pin(
    input.originalPreviousReportJson,
    input.originalPreviousReportChecksum,
  );
  const candidate = pin(options.candidateReportJson, options.candidateReportChecksum);
  const previous = pin(options.previousReportJson, options.previousReportChecksum);
  const training = pin(options.intervalTrainingReportJson, options.intervalTrainingReportChecksum);
  if (
    manifest.originalCandidateReportSha256 !== input.originalCandidateReportChecksum ||
    manifest.originalPreviousReportSha256 !== input.originalPreviousReportChecksum ||
    manifest.nativeTrainingReportSha256 !== options.intervalTrainingReportChecksum
  )
    fail("original or training report pin mismatch");
  for (const [field, value] of [
    ["originalCandidatePhysicalCorpus", originalCandidate.outcomeCorpusIdentity],
    ["originalPreviousPhysicalCorpus", originalPrevious.outcomeCorpusIdentity],
    ["correctedDstPhysicalCorpus", training.outcomeCorpusIdentity],
  ] as const)
    if (sha(manifest[field]) !== sha(value)) fail("physical corpus pin mismatch");
  if (
    new Set([
      manifest.originalCandidatePhysicalCorpus,
      manifest.originalPreviousPhysicalCorpus,
      manifest.correctedDstPhysicalCorpus,
    ]).size !== 3
  )
    fail("physical corpus roles overlap");
  sha(manifest.nonDstFragmentIdentity);
  const observedSources = sources(manifest.observedSources);
  const originalCandidateSources = sources(originalCandidate.sources);
  const originalPreviousSources = sources(originalPrevious.sources);
  same(
    manifest.originalCandidateForecastSources,
    originalCandidateSources,
    "original candidate forecast sources changed",
  );
  same(
    manifest.originalPreviousForecastSources,
    originalPreviousSources,
    "original previous forecast sources changed",
  );
  same(
    originalCandidateSources,
    originalPreviousSources,
    "original physical source lineage differs",
  );
  same(
    manifest.correctedDstForecastSources,
    observedSources,
    "corrected DST forecast sources differ from truth",
  );
  for (const [index, source] of observedSources.entries())
    same(
      without(source, ["teamWeeklyStatsChecksum"]),
      without(originalCandidateSources[index]!, ["teamWeeklyStatsChecksum"]),
      "uncertified non-DST source changes",
    );
  for (const report of [candidate, previous, training])
    same(sources(report.sources), observedSources, "corrected observed source audit mismatch");
  if (
    training.actualDefinitionVersion !== ROS_HISTORICAL_ACTUAL_DEFINITION_VERSION ||
    training.pointsAllowedDefinition !== definition
  )
    fail("native training observed truth is unavailable");
  const profile = profileKey(candidate);
  const parsedProfile = rosProfileDefinitionFromKey(profile);
  const requestedDefinition = defensePointsAllowedDefinitionForProfile(parsedProfile.profile);
  if (
    manifest.profile !== profile ||
    profileKey(previous) !== profile ||
    profileKey(training) !== profile ||
    (requestedDefinition !== null && requestedDefinition !== definition)
  )
    fail("corrected scoring or provider identity mismatch");
  const originalProfile = profileKey(originalCandidate);
  if (
    originalProfile !== profileKey(originalPrevious) ||
    manifest.legacyProfileDigest !== bytesHash(originalProfile)
  )
    fail("original scoring identity changed");
  const numericRules = (key: string) =>
    rosProfileDefinitionFromKey(key).profile.rules.map((rule) =>
      without(record(rule), ["statDefinition"]),
    );
  same(numericRules(originalProfile), numericRules(profile), "numeric scoring rules changed");
  for (const [report, role] of [
    [candidate, "candidate"],
    [previous, "retained-v12"],
  ] as const) {
    if (
      report.actualDefinitionVersion !== PLAYER_ACTUALS ||
      report.pointsAllowedDefinition !== definition ||
      report.canAuthorizeRelease !== false
    )
      fail("derived report certification or authority mismatch");
    same(
      report.correctedComparison,
      {
        version: ROS_DERIVED_EVALUATION_VERSION,
        manifestIdentity: identity,
        role,
        sourceSemantics: SOURCE_SEMANTICS,
        actualDefinitionVersion: PLAYER_ACTUALS,
      },
      "derived report role or manifest link mismatch",
    );
    if (
      report.outcomeCorpusIdentity !==
      historicalRosChecksum({
        kind: "derived-corrected-observation-evaluation",
        role,
        manifestIdentity: identity,
      })
    )
      fail("derived report identity mismatch");
  }
  const originalCandidateRows = rows(originalCandidate, false, "v13");
  const originalPreviousRows = rows(originalPrevious, false, "v12");
  const candidateRows = rows(candidate, false, "v13");
  const previousRows = rows(previous, false, "v12");
  const trainingRows = rows(training, true, "v13");
  const trainingById = new Map(trainingRows.map((row) => [rowId(row), row]));
  same(
    originalCandidateRows.map(rowId),
    originalPreviousRows.map(rowId),
    "original ordered candidate/previous populations differ",
  );
  same(
    candidateRows.map(rowId),
    originalCandidateRows.map(rowId),
    "candidate audit membership or order changed",
  );
  same(
    previousRows.map(rowId),
    originalPreviousRows.map(rowId),
    "previous audit membership or order changed",
  );
  if (
    manifest.candidateRowsChecksum !== historicalRosChecksum(candidateRows) ||
    manifest.previousRowsChecksum !== historicalRosChecksum(previousRows)
  )
    fail("derived raw row commitment mismatch");
  for (const [index, row] of candidateRows.entries()) {
    const original = originalCandidateRows[index]!;
    const previousRow = previousRows[index]!;
    const previousOriginal = originalPreviousRows[index]!;
    same(
      physical(previousRow),
      physical(previousOriginal),
      "previous physical forecast/evidence changed",
    );
    same(truth(previousRow), truth(row), "candidate and previous observed truth differ");
    if (row.position === "DST") {
      const native = trainingById.get(rowId(row));
      if (!native) fail("candidate DST missing from complete native training");
      same(
        stripConvergence(row),
        stripConvergence(native),
        "candidate DST differs from native training forecast",
      );
    } else {
      same(physical(row), physical(original), "non-DST forecast/evidence changed");
      if (
        row.actualPoints !== original.actualPoints ||
        previousRow.actualPoints !== previousOriginal.actualPoints
      )
        fail("non-DST numerical actual changed");
    }
  }
  validateConvergence(manifest, candidate, candidateRows, profile);
  return freeze({
    originalCandidateReport: originalCandidate,
    originalPreviousReport: originalPrevious,
    lineage: {
      version: ROS_DERIVED_EVALUATION_VERSION,
      comparisonManifestIdentity: identity,
      comparisonManifestChecksum: input.comparisonManifestChecksum,
      originalCandidateReportChecksum: input.originalCandidateReportChecksum,
      originalPreviousReportChecksum: input.originalPreviousReportChecksum,
      intervalTrainingReportChecksum: options.intervalTrainingReportChecksum,
      originalCandidatePhysicalCorpus: sha(manifest.originalCandidatePhysicalCorpus),
      originalPreviousPhysicalCorpus: sha(manifest.originalPreviousPhysicalCorpus),
      correctedDstPhysicalCorpus: sha(manifest.correctedDstPhysicalCorpus),
      nonDstFragmentIdentity: sha(manifest.nonDstFragmentIdentity),
      pointsAllowedDefinition: definition,
      observedActualDefinitionVersion: PLAYER_ACTUALS,
      observedSources,
      originalCandidateForecastSources: originalCandidateSources,
      originalPreviousForecastSources: originalPreviousSources,
      correctedDstForecastSources: observedSources,
      candidateRowsChecksum: sha(manifest.candidateRowsChecksum),
      previousRowsChecksum: sha(manifest.previousRowsChecksum),
    },
  });
}
