import { createHash } from "node:crypto";
import { NFL_TEAMS } from "@laces-out/domain";
import {
  applyFirstPartyRosIntervalCalibration,
  buildMarginalIntervalEvidence,
  compareMarginalIntervalCell,
  compareMarginalIntervalPortfolio,
  evaluateFirstPartyRosMarginalPolicy,
  evaluateMarginalIntervalEvidence,
  defensePointsAllowedDefinitionForProfile,
  isDefensePointsAllowedStatId,
  rosProfileDefinitionFromKey,
  type FirstPartyRosHeldOutForecast,
  type FirstPartyRosStrategy,
  type MarginalIntervalComparison,
  type MarginalIntervalComparisonCell,
  type MarginalIntervalComparisonRow,
  type MarginalIntervalEvaluationRow,
  type MarginalRosCandidateEvaluation,
  type ProjectionDefensePointsAllowedDefinition,
} from "@laces-out/projections";
import {
  LOCAL_ROS_DEVELOPMENT_VERSION,
  LOCAL_ROS_DEFENSE_RANK_VERSION,
  localRosDefenseRanksChecksum,
  type LocalRosDefenseRanks,
  type LocalRosDefenseRankRow,
  evaluateLocalRosDevelopment,
  type LocalRosCandidateEvaluation,
} from "../../../packages/projections/src/local-ros-development.js";
import { LOCAL_ROS_INTERVAL_VERSION } from "../../../packages/projections/src/local-ros-interval-calibration.js";
import { historicalRosCalibrationBlockers } from "./first-party-ros-backtest.js";
import { parsePinnedRosMarginalDevelopmentInputs } from "./ros-marginal-development.js";
import type { RosDerivedEvaluationInput } from "./ros-derived-evaluation.js";

export const ROS_LOCAL_DEVELOPMENT_VERSION = "pinned-full-portfolio-local-development-v2";
export const ROS_LOCAL_EVIDENCE_VERSION = "local-prior-fit-marginal-evidence-v2";
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

export interface RosLocalDevelopmentInput {
  readonly candidateReportJson: string;
  readonly candidateReportChecksum: string;
  readonly previousReportJson: string;
  readonly previousReportChecksum: string;
  readonly intervalTrainingReportJson: string;
  readonly intervalTrainingReportChecksum: string;
  readonly derivedEvaluation?: RosDerivedEvaluationInput;
  /** Exact frozen text, including whitespace; code/build pins belong to the execution manifest. */
  readonly protocolText: string;
  readonly protocolChecksum: string;
  readonly sourceManifestChecksum: string;
  readonly scoringProfileKey: string;
  readonly rankSidecarJson: string;
  readonly rankSidecarChecksum: string;
  readonly specificationText: string;
  readonly specificationChecksum: string;
  readonly rankAmendmentJson?: string;
  readonly rankAmendmentChecksum?: string;
}
function fail(reason: string): never {
  throw new Error(`Local ROS development: ${reason}`);
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

export const LOCAL_ROS_RANK_SIDECAR_VERSION = "authenticated-full32-historical-rank-sidecar-v1";
const REFERENCE_PRODUCTION_BASIS = "fixed-reference-production-loss-v1";
const SELECTION_VERSION = "football-activity-reference-quantiles-return-specialists-v1";
interface RankBinding {
  readonly season: number;
  readonly asOfWeek: number;
  readonly canonicalTeam: string;
  readonly trainingInputChecksum: string;
  readonly auditInputChecksum: string | null;
}
interface RankProfile {
  readonly scoringProfileKey: string;
  readonly scoringProfileDigest: string;
  readonly candidateReportChecksum: string;
  readonly trainingReportChecksum: string;
  readonly bindings: readonly RankBinding[];
}
export interface LocalRosRankSidecar {
  readonly version: typeof LOCAL_ROS_RANK_SIDECAR_VERSION;
  readonly canAuthorizeRelease: false;
  readonly featureVersion: typeof LOCAL_ROS_DEFENSE_RANK_VERSION;
  readonly referenceProductionBasis: typeof REFERENCE_PRODUCTION_BASIS;
  readonly selectionVersion: typeof SELECTION_VERSION;
  readonly sourceRevision: string;
  readonly extractorSourceChecksum: string;
  readonly sourceManifestChecksum: string;
  readonly modelIdentity: {
    readonly contextualModelVersion: string;
    readonly recencyModelVersion: string;
    readonly intervalMethodVersion: string;
  };
  readonly ranks: LocalRosDefenseRanks;
  readonly profiles: readonly RankProfile[];
}
export interface LocalRosRankReportPair {
  readonly scoringProfileKey: string;
  readonly candidateReportJson: string;
  readonly candidateReportChecksum: string;
  readonly trainingReportJson: string;
  readonly trainingReportChecksum: string;
}
export const CORRECTED_LOCAL_ROS_RANK_SIDECAR_VERSION =
  "authenticated-provider-full32-historical-rank-sidecar-v2";
interface CorrectedRankProfile extends RankProfile {
  readonly originalScoringProfileKey: string;
  readonly originalScoringProfileDigest: string;
  readonly comparisonManifestChecksum: string;
  readonly pointsAllowedDefinition: ProjectionDefensePointsAllowedDefinition;
  readonly sourceManifestChecksum: string;
  readonly modelIdentity: LocalRosRankSidecar["modelIdentity"];
  readonly ranks: LocalRosDefenseRanks;
}
export interface CorrectedLocalRosRankSidecar {
  readonly version: typeof CORRECTED_LOCAL_ROS_RANK_SIDECAR_VERSION;
  readonly canAuthorizeRelease: false;
  readonly featureVersion: typeof LOCAL_ROS_DEFENSE_RANK_VERSION;
  readonly referenceProductionBasis: typeof REFERENCE_PRODUCTION_BASIS;
  readonly selectionVersion: typeof SELECTION_VERSION;
  readonly sourceRevision: string;
  readonly extractorSourceChecksum: string;
  readonly amendmentChecksum: string;
  readonly specificationChecksum: string;
  readonly profiles: readonly CorrectedRankProfile[];
}
type AnyLocalRosRankSidecar = LocalRosRankSidecar | CorrectedLocalRosRankSidecar;
export interface CorrectedLocalRosRankReportPair extends LocalRosRankReportPair {
  readonly originalScoringProfileKey: string;
  readonly comparisonManifestChecksum: string;
}
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail("missing rank object");
  return value as Record<string, unknown>;
}
function digest(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) fail("invalid rank checksum");
  return value;
}
function pinned(value: string, checksum: string, maximumBytes = 64 * 1024 * 1024): unknown {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value) > maximumBytes ||
    hash(value) !== digest(checksum)
  )
    fail("rank/specification byte pin mismatch");
  return JSON.parse(value) as unknown;
}
function rankIdentity(row: { season: number; asOfWeek: number; canonicalTeam: string }): string {
  return JSON.stringify([row.season, row.asOfWeek, row.canonicalTeam]);
}
function metadataReport(text: string, checksum: string, expectedRows: number) {
  const report = record(pinned(text, checksum));
  const raw = record(report.diagnostics).candidateForecasts;
  if (
    !Array.isArray(raw) ||
    raw.length !== expectedRows ||
    Object.keys(raw).length !== raw.length ||
    record(report.report).skippedForecasts !== 0
  )
    fail("rank report population is incomplete");
  const rows = raw
    .map((value: unknown) => record(value))
    .filter((row) => row.position === "DST")
    .map((row) => {
      if (
        typeof row.playerId !== "string" ||
        !row.playerId.startsWith("DST:") ||
        !NFL_TEAMS.some((team) => `DST:${team}` === row.playerId) ||
        !PRIOR_SEASONS.some((year) => year === row.forecastSeason) ||
        !Number.isSafeInteger(row.asOfWeek) ||
        Number(row.asOfWeek) < 1 ||
        Number(row.asOfWeek) > 17 ||
        row.windowStartWeek !== Number(row.asOfWeek) + 1 ||
        row.windowEndWeek !== 18
      )
        fail("rank report forecast metadata invalid");
      return {
        season: Number(row.forecastSeason),
        asOfWeek: Number(row.asOfWeek),
        canonicalTeam: row.playerId.slice(4),
        inputChecksum: digest(row.inputChecksum),
        scoringProfileKey: row.scoringProfileKey,
        contextualModelVersion: row.contextualModelVersion,
        recencyModelVersion: row.recencyModelVersion,
        intervalMethodVersion: row.intervalMethodVersion,
      };
    });
  const model = record(report.identityAudit);
  const modelIdentity = {
    contextualModelVersion: model.contextualModelVersion,
    recencyModelVersion: model.recencyModelVersion,
    intervalMethodVersion: model.intervalMethodVersion,
  };
  if (
    Object.values(modelIdentity).some(
      (value) => typeof value !== "string" || !value || value.length > 256,
    )
  )
    fail("rank report model identity invalid");
  if (
    rows.some(
      (row) =>
        row.scoringProfileKey !== model.scoringProfileKey ||
        row.contextualModelVersion !== modelIdentity.contextualModelVersion ||
        row.recencyModelVersion !== modelIdentity.recencyModelVersion ||
        row.intervalMethodVersion !== modelIdentity.intervalMethodVersion,
    )
  )
    fail("rank report row/model identity mismatch");
  return {
    rows,
    modelIdentity: modelIdentity as LocalRosRankSidecar["modelIdentity"],
    scoringProfileKey: model.scoringProfileKey,
    scoringProfileDigest: digest(record(report.scoringProfile).digest),
    sourceManifestChecksum: hash(canonical(report.sources)),
  };
}

/**
 * Metadata-only reconstruction. Report bytes contain outcomes, but this function never reads an
 * outcome or fits a model. Authentication binds supplied byte pins, not an external signature;
 * the execution manifest must independently pin these reports and the frozen selector source.
 */
export function buildLocalRosDefenseRankSidecar(input: {
  readonly profiles: readonly LocalRosRankReportPair[];
  readonly sourceRevision: string;
  readonly extractorSourceChecksum: string;
}): LocalRosRankSidecar {
  if (
    !/^[a-f0-9]{40}$/u.test(input.sourceRevision) ||
    input.profiles.length !== 9 ||
    new Set(input.profiles.map((p) => p.scoringProfileKey)).size !== 9
  )
    fail("rank sidecar requires nine distinct profiles and an exact source revision");
  digest(input.extractorSourceChecksum);
  let commonRows: LocalRosDefenseRankRow[] | null = null;
  let commonModel: LocalRosRankSidecar["modelIdentity"] | null = null;
  let commonSource: string | null = null;
  const profiles = input.profiles.map((profile): RankProfile => {
    const audit = metadataReport(
      profile.candidateReportJson,
      profile.candidateReportChecksum,
      3264,
    );
    const training = metadataReport(
      profile.trainingReportJson,
      profile.trainingReportChecksum,
      2176,
    );
    if (
      audit.rows.length !== 544 ||
      training.rows.length !== 2176 ||
      audit.scoringProfileKey !== profile.scoringProfileKey ||
      training.scoringProfileKey !== profile.scoringProfileKey ||
      audit.scoringProfileDigest !== training.scoringProfileDigest ||
      audit.scoringProfileDigest !== hash(profile.scoringProfileKey) ||
      canonical(audit.modelIdentity) !== canonical(training.modelIdentity) ||
      audit.sourceManifestChecksum !== training.sourceManifestChecksum
    )
      fail("rank audit/training profile or source mismatch");
    if (
      commonModel !== null &&
      (canonical(commonModel) !== canonical(training.modelIdentity) ||
        commonSource !== training.sourceManifestChecksum)
    )
      fail("rank cross-profile model/source mismatch");
    commonModel = training.modelIdentity;
    commonSource = training.sourceManifestChecksum;
    const ranks: LocalRosDefenseRankRow[] = [];
    const bindings: RankBinding[] = [];
    for (const season of PRIOR_SEASONS)
      for (let asOfWeek = 1; asOfWeek <= 17; asOfWeek += 1) {
        // Filter preserves the authenticated replay order; sorting teams here would fabricate rank.
        const full = training.rows.filter(
          (row) => row.season === season && row.asOfWeek === asOfWeek,
        );
        const original = audit.rows.filter(
          (row) => row.season === season && row.asOfWeek === asOfWeek,
        );
        if (
          full.length !== 32 ||
          new Set(full.map((row) => row.canonicalTeam)).size !== 32 ||
          original.length !== 8 ||
          new Set(original.map((row) => row.canonicalTeam)).size !== 8
        )
          fail("rank cutoff requires full32 and original eight unique teams");
        const ordered = full.map((row) => row.canonicalTeam);
        const selected = new Set(original.map((row) => row.canonicalTeam));
        if (
          canonical(ordered.filter((team) => selected.has(team))) !==
          canonical(original.map((row) => row.canonicalTeam))
        )
          fail("rank original audit is not an ordered full32 subsequence");
        const orderedUniverseChecksum = hash(JSON.stringify(ordered));
        full.forEach((row, index) => {
          ranks.push({
            season,
            asOfWeek,
            canonicalTeam: row.canonicalTeam,
            ordinalRank: index + 1,
            orderedUniverseChecksum,
          });
          bindings.push({
            season,
            asOfWeek,
            canonicalTeam: row.canonicalTeam,
            trainingInputChecksum: row.inputChecksum,
            auditInputChecksum:
              original.find((entry) => entry.canonicalTeam === row.canonicalTeam)?.inputChecksum ??
              null,
          });
        });
      }
    if (commonRows !== null && canonical(commonRows) !== canonical(ranks))
      fail("rank order differs across scoring profiles");
    commonRows = ranks;
    return {
      scoringProfileKey: profile.scoringProfileKey,
      scoringProfileDigest: audit.scoringProfileDigest,
      candidateReportChecksum: profile.candidateReportChecksum,
      trainingReportChecksum: profile.trainingReportChecksum,
      bindings,
    };
  });
  if (commonRows === null || commonModel === null || commonSource === null)
    fail("rank sidecar has no profiles");
  if (new Set(profiles.map((profile) => profile.scoringProfileDigest)).size !== 9)
    fail("rank sidecar requires nine distinct profile digests");
  return {
    version: LOCAL_ROS_RANK_SIDECAR_VERSION,
    canAuthorizeRelease: false,
    featureVersion: LOCAL_ROS_DEFENSE_RANK_VERSION,
    referenceProductionBasis: REFERENCE_PRODUCTION_BASIS,
    selectionVersion: SELECTION_VERSION,
    sourceRevision: input.sourceRevision,
    extractorSourceChecksum: input.extractorSourceChecksum,
    sourceManifestChecksum: commonSource,
    modelIdentity: commonModel,
    ranks: {
      featureVersion: LOCAL_ROS_DEFENSE_RANK_VERSION,
      checksum: localRosDefenseRanksChecksum(commonRows),
      rows: commonRows,
    },
    profiles,
  };
}
function denseArray(value: unknown): boolean {
  return Array.isArray(value) && Object.keys(value).length === value.length;
}
function numericRankScoringKey(key: string): string {
  const rules = rosProfileDefinitionFromKey(key).profile.rules;
  return canonical(
    rules.map(({ statDefinition, ...numeric }) => {
      if (
        statDefinition !== undefined &&
        (!isDefensePointsAllowedStatId(numeric.statId) ||
          (statDefinition !== "yahoo-2022-v1" && statDefinition !== "espn-2019-v1"))
      )
        fail("rank scoring definition annotation invalid");
      return numeric;
    }),
  );
}

/** Metadata-only corrected ranks; all providers retain their own authenticated source order. */
export function buildCorrectedLocalRosDefenseRankSidecar(input: {
  readonly profiles: readonly CorrectedLocalRosRankReportPair[];
  readonly sourceRevision: string;
  readonly extractorSourceChecksum: string;
  readonly amendmentChecksum: string;
  readonly specificationChecksum: string;
}): CorrectedLocalRosRankSidecar {
  if (
    !/^[a-f0-9]{40}$/u.test(input.sourceRevision) ||
    input.profiles.length !== 9 ||
    new Set(input.profiles.map((p) => p.scoringProfileKey)).size !== 9 ||
    new Set(input.profiles.map((p) => p.originalScoringProfileKey)).size !== 9
  )
    fail("corrected rank sidecar requires nine distinct original/current profiles");
  digest(input.extractorSourceChecksum);
  digest(input.amendmentChecksum);
  digest(input.specificationChecksum);
  const profiles = input.profiles.map((profile): CorrectedRankProfile => {
    const audit = metadataReport(
      profile.candidateReportJson,
      profile.candidateReportChecksum,
      3264,
    );
    const training = metadataReport(
      profile.trainingReportJson,
      profile.trainingReportChecksum,
      2176,
    );
    const definition = defensePointsAllowedDefinitionForProfile(
      rosProfileDefinitionFromKey(profile.scoringProfileKey).profile,
    );
    if (
      definition === null ||
      audit.rows.length !== 544 ||
      training.rows.length !== 2176 ||
      audit.scoringProfileKey !== profile.scoringProfileKey ||
      training.scoringProfileKey !== profile.scoringProfileKey ||
      audit.scoringProfileDigest !== training.scoringProfileDigest ||
      audit.scoringProfileDigest !== hash(profile.scoringProfileKey) ||
      canonical(audit.modelIdentity) !== canonical(training.modelIdentity) ||
      audit.sourceManifestChecksum !== training.sourceManifestChecksum ||
      numericRankScoringKey(profile.originalScoringProfileKey) !==
        numericRankScoringKey(profile.scoringProfileKey)
    )
      fail("corrected rank profile, numerical scoring or source mismatch");
    const ranks: LocalRosDefenseRankRow[] = [];
    const bindings: RankBinding[] = [];
    for (const season of PRIOR_SEASONS)
      for (let asOfWeek = 1; asOfWeek <= 17; asOfWeek += 1) {
        const full = training.rows.filter((r) => r.season === season && r.asOfWeek === asOfWeek);
        const original = audit.rows.filter((r) => r.season === season && r.asOfWeek === asOfWeek);
        if (
          full.length !== 32 ||
          new Set(full.map((r) => r.canonicalTeam)).size !== 32 ||
          original.length !== 8 ||
          new Set(original.map((r) => r.canonicalTeam)).size !== 8 ||
          original.some(
            (r) =>
              !full.some(
                (f) => f.canonicalTeam === r.canonicalTeam && f.inputChecksum === r.inputChecksum,
              ),
          )
        )
          fail("corrected rank requires complete full32 and exact original audit joins");
        const orderedUniverseChecksum = hash(JSON.stringify(full.map((r) => r.canonicalTeam)));
        full.forEach((row, index) => {
          ranks.push({
            season,
            asOfWeek,
            canonicalTeam: row.canonicalTeam,
            ordinalRank: index + 1,
            orderedUniverseChecksum,
          });
          bindings.push({
            season,
            asOfWeek,
            canonicalTeam: row.canonicalTeam,
            trainingInputChecksum: row.inputChecksum,
            auditInputChecksum:
              original.find((r) => r.canonicalTeam === row.canonicalTeam)?.inputChecksum ?? null,
          });
        });
      }
    return {
      scoringProfileKey: profile.scoringProfileKey,
      scoringProfileDigest: audit.scoringProfileDigest,
      originalScoringProfileKey: profile.originalScoringProfileKey,
      originalScoringProfileDigest: hash(profile.originalScoringProfileKey),
      comparisonManifestChecksum: digest(profile.comparisonManifestChecksum),
      pointsAllowedDefinition: definition,
      candidateReportChecksum: profile.candidateReportChecksum,
      trainingReportChecksum: profile.trainingReportChecksum,
      sourceManifestChecksum: training.sourceManifestChecksum,
      modelIdentity: training.modelIdentity,
      ranks: {
        featureVersion: LOCAL_ROS_DEFENSE_RANK_VERSION,
        checksum: localRosDefenseRanksChecksum(ranks),
        rows: ranks,
      },
      bindings,
    };
  });
  const sidecar: CorrectedLocalRosRankSidecar = {
    version: CORRECTED_LOCAL_ROS_RANK_SIDECAR_VERSION,
    canAuthorizeRelease: false,
    featureVersion: LOCAL_ROS_DEFENSE_RANK_VERSION,
    referenceProductionBasis: REFERENCE_PRODUCTION_BASIS,
    selectionVersion: SELECTION_VERSION,
    sourceRevision: input.sourceRevision,
    extractorSourceChecksum: input.extractorSourceChecksum,
    amendmentChecksum: input.amendmentChecksum,
    specificationChecksum: input.specificationChecksum,
    profiles,
  };
  validateCorrectedRankSidecar(sidecar);
  return sidecar;
}
function validateCorrectedRankSidecar(sidecar: CorrectedLocalRosRankSidecar): void {
  digest(sidecar.amendmentChecksum);
  digest(sidecar.specificationChecksum);
  if (
    !denseArray(sidecar.profiles) ||
    sidecar.profiles.length !== 9 ||
    new Set(sidecar.profiles.map((p) => p.scoringProfileKey)).size !== 9 ||
    new Set(sidecar.profiles.map((p) => p.originalScoringProfileDigest)).size !== 9
  )
    fail("corrected rank profiles incomplete");
  const providerOrders = new Map<string, string>();
  for (const profile of sidecar.profiles) {
    digest(profile.candidateReportChecksum);
    digest(profile.trainingReportChecksum);
    digest(profile.sourceManifestChecksum);
    digest(profile.comparisonManifestChecksum);
    if (
      profile.scoringProfileDigest !== hash(profile.scoringProfileKey) ||
      profile.originalScoringProfileDigest !== hash(profile.originalScoringProfileKey) ||
      numericRankScoringKey(profile.originalScoringProfileKey) !==
        numericRankScoringKey(profile.scoringProfileKey) ||
      defensePointsAllowedDefinitionForProfile(
        rosProfileDefinitionFromKey(profile.scoringProfileKey).profile,
      ) !== profile.pointsAllowedDefinition ||
      !["yahoo-2022-v1", "espn-2019-v1"].includes(profile.pointsAllowedDefinition) ||
      profile.ranks.featureVersion !== LOCAL_ROS_DEFENSE_RANK_VERSION ||
      !denseArray(profile.ranks.rows) ||
      profile.ranks.rows.length !== 2176 ||
      profile.ranks.checksum !== localRosDefenseRanksChecksum(profile.ranks.rows) ||
      !denseArray(profile.bindings) ||
      profile.bindings.length !== 2176 ||
      new Set(profile.bindings.map(rankIdentity)).size !== 2176 ||
      profile.bindings.filter((b) => b.auditInputChecksum !== null).length !== 544
    )
      fail("corrected rank identity, population or numerical scoring mismatch");
    profile.bindings.forEach((binding, index) => {
      digest(binding.trainingInputChecksum);
      if (
        binding.auditInputChecksum !== null &&
        digest(binding.auditInputChecksum) !== binding.trainingInputChecksum
      )
        fail("corrected audit input differs from native training");
      if (rankIdentity(binding) !== rankIdentity(profile.ranks.rows[index]!))
        fail("corrected rank binding order mismatch");
    });
    const key = profile.pointsAllowedDefinition;
    const value = canonical({
      ranks: profile.ranks,
      source: profile.sourceManifestChecksum,
      model: profile.modelIdentity,
    });
    if (providerOrders.has(key) && providerOrders.get(key) !== value)
      fail("corrected rank order or source differs within provider");
    providerOrders.set(key, value);
  }
}
function readRankSidecar(text: string, checksum: string): AnyLocalRosRankSidecar {
  const raw = record(pinned(text, checksum, 16 * 1024 * 1024));
  if (
    (raw.version !== LOCAL_ROS_RANK_SIDECAR_VERSION &&
      raw.version !== CORRECTED_LOCAL_ROS_RANK_SIDECAR_VERSION) ||
    raw.canAuthorizeRelease !== false ||
    raw.featureVersion !== LOCAL_ROS_DEFENSE_RANK_VERSION ||
    raw.referenceProductionBasis !== REFERENCE_PRODUCTION_BASIS ||
    raw.selectionVersion !== SELECTION_VERSION ||
    typeof raw.sourceRevision !== "string" ||
    !/^[a-f0-9]{40}$/u.test(raw.sourceRevision)
  )
    fail("rank sidecar metadata mismatch");
  digest(raw.extractorSourceChecksum);
  if (raw.version === CORRECTED_LOCAL_ROS_RANK_SIDECAR_VERSION) {
    const sidecar = raw as unknown as CorrectedLocalRosRankSidecar;
    validateCorrectedRankSidecar(sidecar);
    return sidecar;
  }
  digest(raw.sourceManifestChecksum);
  const sidecar = raw as unknown as LocalRosRankSidecar;
  if (
    !denseArray(sidecar.profiles) ||
    sidecar.profiles.length !== 9 ||
    new Set(sidecar.profiles.map((profile) => profile.scoringProfileKey)).size !== 9 ||
    new Set(sidecar.profiles.map((profile) => profile.scoringProfileDigest)).size !== 9 ||
    !denseArray(sidecar.ranks.rows) ||
    sidecar.ranks.rows.length !== 2176 ||
    sidecar.ranks.checksum !== localRosDefenseRanksChecksum(sidecar.ranks.rows)
  )
    fail("rank sidecar profiles/population/checksum mismatch");
  for (const profile of sidecar.profiles) {
    digest(profile.scoringProfileDigest);
    digest(profile.candidateReportChecksum);
    digest(profile.trainingReportChecksum);
    if (
      typeof profile.scoringProfileKey !== "string" ||
      profile.scoringProfileKey.length > 65_536 ||
      hash(profile.scoringProfileKey) !== profile.scoringProfileDigest
    )
      fail("rank profile key/digest mismatch");
    if (
      !denseArray(profile.bindings) ||
      profile.bindings.length !== 2176 ||
      new Set(profile.bindings.map(rankIdentity)).size !== 2176 ||
      profile.bindings.filter((binding: RankBinding) => binding.auditInputChecksum !== null)
        .length !== 544
    )
      fail("rank sidecar bindings incomplete");
    profile.bindings.forEach((binding: RankBinding, index: number) => {
      digest(binding.trainingInputChecksum);
      if (binding.auditInputChecksum !== null) digest(binding.auditInputChecksum);
      if (rankIdentity(binding) !== rankIdentity(sidecar.ranks.rows[index]!))
        fail("rank sidecar binding/order mismatch");
    });
  }
  return sidecar;
}
function verifyRankProfile(
  sidecar: AnyLocalRosRankSidecar,
  audit: readonly FirstPartyRosHeldOutForecast[],
  training: readonly FirstPartyRosHeldOutForecast[],
  input: RosLocalDevelopmentInput,
  derived: ReturnType<typeof parsePinnedRosMarginalDevelopmentInputs>["derivedEvaluation"],
): LocalRosDefenseRanks {
  const profile = sidecar.profiles.find(
    (entry) => entry.scoringProfileKey === input.scoringProfileKey,
  );
  const metadata =
    sidecar.version === CORRECTED_LOCAL_ROS_RANK_SIDECAR_VERSION
      ? (profile as CorrectedRankProfile | undefined)
      : sidecar;
  if (
    !profile ||
    !metadata ||
    profile.candidateReportChecksum !== input.candidateReportChecksum ||
    profile.trainingReportChecksum !== input.intervalTrainingReportChecksum ||
    metadata.sourceManifestChecksum !== input.sourceManifestChecksum
  )
    fail("rank sidecar report/source binding mismatch");
  if (sidecar.version === CORRECTED_LOCAL_ROS_RANK_SIDECAR_VERSION) {
    const corrected = profile as CorrectedRankProfile;
    if (
      derived === null ||
      corrected.comparisonManifestChecksum !== derived.lineage.comparisonManifestChecksum ||
      corrected.pointsAllowedDefinition !== derived.lineage.pointsAllowedDefinition ||
      corrected.originalScoringProfileKey !==
        record(derived.originalCandidateReport.identityAudit).scoringProfileKey ||
      input.rankAmendmentJson === undefined ||
      input.rankAmendmentChecksum === undefined ||
      input.rankAmendmentChecksum !== sidecar.amendmentChecksum ||
      input.specificationChecksum !== sidecar.specificationChecksum
    )
      fail("corrected rank requires exact derived source and amendment binding");
    const amendment = record(
      pinned(input.rankAmendmentJson, input.rankAmendmentChecksum, 1024 * 1024),
    );
    if (
      amendment.version !== "corrected-provider-rank-metadata-amendment-v1" ||
      amendment.state !== "frozen-before-corrected-profile-results" ||
      amendment.originalSpecificationSha256 !== input.specificationChecksum ||
      amendment.methodUnchanged !== LOCAL_ROS_INTERVAL_VERSION ||
      amendment.noOutcomeFitting !== true ||
      amendment.noSimulation !== true ||
      amendment.canAuthorizeRelease !== false ||
      canonical(amendment.originalProfileDigests) !==
        canonical(sidecar.profiles.map((p) => p.originalScoringProfileDigest))
    )
      fail("corrected rank amendment or original specification mismatch");
  } else if (
    derived !== null ||
    input.rankAmendmentJson !== undefined ||
    input.rankAmendmentChecksum !== undefined
  ) {
    fail("corrected evaluation requires provider-bound rank sidecar");
  }
  const expected = new Map(profile.bindings.map((row) => [rankIdentity(row), row]));
  for (const [rows, field] of [
    [audit.filter((row) => row.position === "DST"), "auditInputChecksum"],
    [training, "trainingInputChecksum"],
  ] as const) {
    for (const row of rows) {
      const binding = expected.get(
        rankIdentity({
          season: row.forecastSeason,
          asOfWeek: row.asOfWeek,
          canonicalTeam: row.playerId.slice(4),
        }),
      );
      if (
        !binding ||
        binding[field] !== row.inputChecksum ||
        row.contextualModelVersion !== metadata.modelIdentity.contextualModelVersion ||
        row.recencyModelVersion !== metadata.modelIdentity.recencyModelVersion ||
        row.intervalMethodVersion !== metadata.modelIdentity.intervalMethodVersion
      )
        fail("rank sidecar forecast input/model join mismatch");
    }
  }
  // Recheck the current profile's authenticated saved order against the sidecar, not only row IDs.
  for (const season of PRIOR_SEASONS)
    for (let cutoff = 1; cutoff <= 17; cutoff += 1) {
      const ordered = training
        .filter((row) => row.forecastSeason === season && row.asOfWeek === cutoff)
        .map((row) => row.playerId.slice(4));
      const ranks = metadata.ranks.rows.filter(
        (row) => row.season === season && row.asOfWeek === cutoff,
      );
      if (canonical(ordered) !== canonical(ranks.map((row) => row.canonicalTeam)))
        fail("rank sidecar current report order mismatch");
    }
  return metadata.ranks;
}
function verifySpecification(
  text: string,
  checksum: string,
  sidecar: AnyLocalRosRankSidecar,
): void {
  const specification = record(pinned(text, checksum, 1024 * 1024));
  if (
    specification.version !== "ros-local-residual-candidate-spec-v2" ||
    specification.method !== LOCAL_ROS_INTERVAL_VERSION ||
    specification.canAuthorizeRelease !== false ||
    specification.canAuthorizeHistoricalExecution !== false ||
    canonical(record(specification.population).scoringProfiles) !==
      canonical(
        sidecar.version === CORRECTED_LOCAL_ROS_RANK_SIDECAR_VERSION
          ? sidecar.profiles.map((profile) => profile.originalScoringProfileDigest)
          : sidecar.profiles.map((profile) => profile.scoringProfileDigest),
      )
  )
    fail("local specification/version/profile order mismatch");
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
type Local = ReturnType<typeof evaluateLocalRosDevelopment>;
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
function localRow(
  row: LocalRosCandidateEvaluation,
  kind: "corrected" | "legacy" | "raw",
): MarginalIntervalComparisonRow {
  if (kind === "corrected" && row.correction === null)
    fail(`required local row unavailable:${row.identity}`);
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
function rowDiagnostics(rows: readonly LocalRosCandidateEvaluation[]) {
  const weighted = (value: (row: LocalRosCandidateEvaluation) => number): number | null => {
    if (rows.length === 0) return null;
    const seasons = new Map<number, Map<number, LocalRosCandidateEvaluation[]>>();
    for (const row of rows) {
      const cutoffs =
        seasons.get(row.forecastSeason) ?? new Map<number, LocalRosCandidateEvaluation[]>();
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
    extrapolatedRows: rows.filter((row) => row.applicationSupport?.extrapolated).length,
    rearrangedRows: rows.filter((row) => row.correction?.rearrangement.crossed).length,
    maximumRearrangementMovement: Math.max(
      0,
      ...rows.map((row) => row.correction?.rearrangement.maximumMovement ?? 0),
    ),
  };
}

function localMeasurement(
  rows: readonly LocalRosCandidateEvaluation[],
  seriesKey: string,
  evaluation: Local,
) {
  const fits = new Map(
    evaluation.seasonFits.flatMap((year) =>
      year.scopes.map((cell) => [cell.fit.checksum, cell.fit] as const),
    ),
  );
  const scored: MarginalIntervalEvaluationRow[] = [];
  const unavailable: { identity: string; failure: LocalRosCandidateEvaluation["failure"] }[] = [];
  for (const row of rows) {
    if (row.correction === null) {
      unavailable.push({ identity: row.identity, failure: row.failure });
      continue;
    }
    const fit = fits.get(row.fitChecksum);
    if (!fit || fit.state !== "fitted" || fit.forecastSeason !== row.forecastSeason)
      fail("local fit/forecast binding failed");
    const requiredPrior = PRIOR_SEASONS.filter((year) => year < row.forecastSeason);
    if (canonical(fit.priorSeasons) !== canonical(requiredPrior))
      fail("local historical fit omits a declared prior season");
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
    version: ROS_LOCAL_EVIDENCE_VERSION,
    calibrationVersion: LOCAL_ROS_INTERVAL_VERSION,
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

/** Closed six-suffix supersession, only after this local cell passes all required scores. */
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
export function buildRosLocalDevelopmentReport(input: RosLocalDevelopmentInput) {
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
    parsed.intervalTraining === null ||
    parsed.training === null ||
    parsed.composite === null ||
    parsed.intervalTraining.heldOutSeasons.flatMap((year) => year.forecasts).length !== 4896
  )
    fail("complete 4896-row training composition is required");
  const sidecar = readRankSidecar(input.rankSidecarJson, input.rankSidecarChecksum);
  const ranks = verifyRankProfile(
    sidecar,
    parsed.candidate.raw,
    parsed.training.raw,
    input,
    parsed.derivedEvaluation,
  );
  verifySpecification(input.specificationText, input.specificationChecksum, sidecar);
  const trainingOptions = { intervalTrainingSeasons: parsed.intervalTraining.heldOutSeasons };
  const evaluation = evaluateLocalRosDevelopment(parsed.candidate.heldOutSeasons, {
    forecastSeason: 2026,
    defenseRanks: ranks,
    ...trainingOptions,
  });
  if (canonical(evaluation.legacyEvaluation) !== canonical(parsed.candidate.legacy))
    fail("local adapter changed frozen mean choices or evidence");
  const unconditional = evaluateFirstPartyRosMarginalPolicy(parsed.candidate.heldOutSeasons, {
    forecastSeason: 2026,
    championOptions: parsed.candidate.options,
    ...trainingOptions,
  });
  if (canonical(unconditional.legacyEvaluation) !== canonical(parsed.candidate.legacy))
    fail("unconditional comparator changed frozen mean choices");
  const source = { ...parsed.candidate.source, policyVersion: LOCAL_ROS_DEVELOPMENT_VERSION };
  const reasons: string[] = [];
  const cells = CELLS.map((cell) => {
    const choice = parsed.candidate.legacy.livePolicy.choices.find((candidate) =>
      sameCell(candidate, cell),
    )!;
    const previousChoice = parsed.previous.legacy.livePolicy.choices.find((candidate) =>
      sameCell(candidate, cell),
    )!;
    const strategies = STRATEGIES.map((strategy) => {
      const fit = evaluation.liveFits.scopes.find(
        (candidate) =>
          candidate.context.position === cell.position && candidate.context.strategy === strategy,
      )!;
      const rows = evaluation.candidates.filter(
        (row) =>
          sameCell(row, cell) &&
          row.strategy === strategy &&
          EVALUATED_SEASONS.some((year) => row.forecastSeason === year),
      );
      const evidence = localMeasurement(rows, fit.seriesKey, evaluation);
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
        candidate: { source, rows: latest.map((row) => localRow(row, "corrected")) },
        benchmarks: {
          "same-physics-legacy": {
            source: parsed.candidate.source,
            rows: latest.map((row) => localRow(row, "legacy")),
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
      candidate: { source, rows: selected.map((row) => localRow(row, "corrected")) },
      benchmarks: {
        "same-physics-raw": {
          source: { ...parsed.candidate.source, policyVersion: "uncalibrated-raw-v1" },
          rows: selected.map((row) => localRow(row, "raw")),
        },
        "same-physics-legacy": {
          source: parsed.candidate.source,
          rows: selected.map((row) => localRow(row, "legacy")),
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
    const local = localMeasurement(
      latest,
      `additional-local-selected:${cellKey(cell)}`,
      evaluation,
    );
    const fixed = unconditionalMeasurement(
      unconditional.selected.filter((row) => sameCell(row, cell) && row.forecastSeason === 2025),
      `additional-unconditional-selected:${cellKey(cell)}`,
    );
    return {
      ...cell,
      complete: local.unavailable.length === 0 && fixed.complete,
      localWis: local.measurement.overall.metrics?.wis ?? null,
      unconditionalWis: fixed.measurement.overall.metrics?.wis ?? null,
    };
  });
  const additionalComplete = additionalCells.every(
    (cell) => cell.complete && cell.localWis !== null && cell.unconditionalWis !== null,
  );
  const payload = {
    schemaVersion: 1,
    version: ROS_LOCAL_DEVELOPMENT_VERSION,
    validationMode: "local-interval-development-only",
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
      specificationText: input.specificationText,
      specificationChecksum: input.specificationChecksum,
      rankSidecarChecksum: input.rankSidecarChecksum,
      rankSidecar: sidecar,
      ...(input.rankAmendmentJson === undefined
        ? {}
        : {
            rankAmendmentJson: input.rankAmendmentJson,
            rankAmendmentChecksum: input.rankAmendmentChecksum,
          }),
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
    localDevelopment: {
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
        localWis: additionalComplete
          ? additionalCells.reduce((total, cell) => total + cell.localWis!, 0) / CELLS.length
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
