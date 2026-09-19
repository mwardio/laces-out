import { createHash } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { link, mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { assertRosCacheHeadroom, rosCacheCompressedWriteBudget } from "./ros-cache-disk-space.js";
import path from "node:path";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";

import {
  FIRST_PARTY_ROS_MODEL_VERSION,
  FIRST_PARTY_ROS_OUTCOME_SCHEMA_VERSION,
  defensePointsAllowedDefinitionForProfile,
  isDefensePointsAllowedStatId,
  type FirstPartyRosHeldOutForecast,
  type ProjectionDefensePointsAllowedDefinition,
  type ProjectionScoringProfile,
  type ProjectionStatComponents,
} from "@laces-out/projections";

import type {
  HistoricalRosBacktestOptions,
  HistoricalRosBacktestReport,
} from "./first-party-ros-backtest.js";
import type { RosHistoricalCoverageReport } from "./ros-data-coverage.js";
import type { RosOutcomeCacheKey } from "./ros-outcome-cache.js";
import {
  ROS_HISTORICAL_CORPUS_BUILD_PROTOCOL,
  hasCurrentRosHistoricalCoverageThresholds,
  hasRosHistoricalCorpusReleaseThresholds,
  isCompatibleRosHistoricalCorpusBuildProtocol,
  isRetainedV12RosHistoricalCorpusBuildProtocol,
  RETAINED_V12_ROS_HISTORICAL_CORPUS_BUILD_PROTOCOL,
  type RosHistoricalCorpusBuildProvenance,
  type RetainedV12RosHistoricalCorpusBuildProvenance,
} from "./ros-historical-corpus-protocol.js";

export const ROS_HISTORICAL_CORPUS_SCHEMA_VERSION = "ros-historical-corpus-v2";
// Actual observation/completeness semantics are independent of simulated football and its cache.
// This does not certify provider-specific scoring definitions (for example points allowed).
export const ROS_HISTORICAL_ACTUAL_DEFINITION_VERSION = "observed-weekly-components-complete-v1";
// The locked 6,000-forecast scope can carry ~150 actual component keys per forecast (~30 MiB
// before forecast metadata). Bound the complete legitimate manifest, not just small fixtures.
export const ROS_HISTORICAL_CORPUS_MAXIMUM_BYTES = 64 * 1_024 * 1_024;
const MAXIMUM_COMPRESSED_BYTES = ROS_HISTORICAL_CORPUS_MAXIMUM_BYTES + 64 * 1_024;
const SHA256 = /^[a-f0-9]{64}$/u;
const POSITIONS = new Set(["QB", "RB", "WR", "TE", "K", "DST"]);

export interface RosHistoricalCorpusForecast {
  readonly forecast: Omit<
    FirstPartyRosHeldOutForecast,
    "evidence" | "contextual" | "recency" | "actualPoints" | "scoringProfileKey"
  >;
  readonly contextualKey: RosOutcomeCacheKey;
  readonly recencyKey: RosOutcomeCacheKey;
  readonly actualComponents: ProjectionStatComponents;
  readonly coverage: { readonly contextual: number; readonly recency: number };
  readonly actualGames: number;
  readonly scheduledGames: number;
}

/** An immutable evaluation manifest, not an admission artifact and never scored forecasts. */
export interface RosHistoricalCorpus {
  readonly schemaVersion: typeof ROS_HISTORICAL_CORPUS_SCHEMA_VERSION;
  // Absent only on retained archives. Never infer current provenance from component key presence.
  readonly actualDefinitionVersion?: typeof ROS_HISTORICAL_ACTUAL_DEFINITION_VERSION;
  /** Missing only on retained archives; binds both DST football inputs and observed labels. */
  readonly pointsAllowedDefinition?: ProjectionDefensePointsAllowedDefinition;
  readonly buildProtocol:
    RosHistoricalCorpusBuildProvenance | RetainedV12RosHistoricalCorpusBuildProvenance;
  readonly modelVersion: string;
  readonly outcomeSchemaVersion: string;
  readonly weeklyModelVersion: string;
  readonly productionBasis: string;
  readonly sourceChecksums: Readonly<Record<string, string>>;
  readonly sourceAudit: readonly Readonly<Record<string, string | number>>[];
  readonly coverage: RosHistoricalCoverageReport;
  readonly options: Required<HistoricalRosBacktestOptions>;
  readonly seasons: readonly number[];
  readonly skippedForecasts: number;
  readonly kickerFamilyAudit: HistoricalRosBacktestReport["kickerFamilyAudit"];
  readonly forecasts: readonly RosHistoricalCorpusForecast[];
}

export type RosHistoricalCorpusLookup =
  | { readonly state: "missing" }
  | {
      readonly state: "corrupt";
      readonly reason: "invalid_manifest" | "checksum_mismatch" | "limits_exceeded";
    }
  | { readonly state: "hit"; readonly identity: string; readonly corpus: RosHistoricalCorpus };

export interface RosHistoricalCorpusStore {
  read(
    identity: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<RosHistoricalCorpusLookup>;
  write(
    corpus: RosHistoricalCorpus,
    options?: { readonly signal?: AbortSignal },
  ): Promise<{ readonly state: "written" | "existing"; readonly identity: string }>;
}

export class RosHistoricalCorpusError extends Error {
  constructor(readonly code: "invalid_manifest" | "limits_exceeded" | "existing_entry_corrupt") {
    super(`ROS historical corpus ${code}`);
    this.name = "RosHistoricalCorpusError";
  }
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown, minimum: number, maximum: number): value is number =>
  Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
const string = (value: unknown, maximum = 256): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= maximum;
const checksum = (value: string) => createHash("sha256").update(value).digest("hex");
const rate = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
const digest = (value: unknown): value is string => typeof value === "string" && SHA256.test(value);
const integers = (
  value: unknown,
  minimum: number,
  maximum: number,
  maximumLength: number,
): value is number[] =>
  Array.isArray(value) &&
  value.length <= maximumLength &&
  value.every((item) => integer(item, minimum, maximum)) &&
  new Set(value).size === value.length;
const strings = (value: unknown, maximumLength = 128): value is string[] =>
  Array.isArray(value) && value.length <= maximumLength && value.every((item) => string(item));

/** Bounded canonical JSON also rejects dates, typed arrays, cycles, undefined and NaN. */
function canonical(value: unknown, maximumBytes: number): string {
  let bytes = 0;
  let nodes = 0;
  const ancestors = new Set<object>();
  const visit = (item: unknown, depth: number): string => {
    nodes += 1;
    if (depth > 20 || nodes > 8_000_000) throw new RosHistoricalCorpusError("limits_exceeded");
    let result: string;
    if (item === null || typeof item === "boolean") result = JSON.stringify(item);
    else if (typeof item === "number" && Number.isFinite(item)) result = JSON.stringify(item);
    else if (typeof item === "string") {
      if (Buffer.byteLength(item) > maximumBytes - bytes)
        throw new RosHistoricalCorpusError("limits_exceeded");
      result = JSON.stringify(item);
    } else if (typeof item === "object" && item !== null) {
      if (ancestors.has(item)) throw new RosHistoricalCorpusError("invalid_manifest");
      ancestors.add(item);
      if (Array.isArray(item)) {
        if (item.length > 10_000) throw new RosHistoricalCorpusError("limits_exceeded");
        result = `[${Array.from(item, (child) => visit(child, depth + 1)).join(",")}]`;
        bytes += item.length + 2;
      } else {
        if (
          Object.getPrototypeOf(item) !== Object.prototype &&
          Object.getPrototypeOf(item) !== null
        )
          throw new RosHistoricalCorpusError("invalid_manifest");
        const keys = Object.keys(item).sort();
        if (keys.length > 1_024) throw new RosHistoricalCorpusError("limits_exceeded");
        result = `{${keys.map((key) => `${visit(key, depth + 1)}:${visit((item as Record<string, unknown>)[key], depth + 1)}`).join(",")}}`;
        bytes += keys.length * 2 + 2;
      }
      ancestors.delete(item);
      if (bytes > maximumBytes) throw new RosHistoricalCorpusError("limits_exceeded");
      return result;
    } else throw new RosHistoricalCorpusError("invalid_manifest");
    bytes += Buffer.byteLength(result);
    if (bytes > maximumBytes) throw new RosHistoricalCorpusError("limits_exceeded");
    return result;
  };
  const result = visit(value, 0);
  if (Buffer.byteLength(result) > maximumBytes)
    throw new RosHistoricalCorpusError("limits_exceeded");
  return result;
}

function validCoverage(value: unknown): value is RosHistoricalCoverageReport {
  if (
    !object(value) ||
    !["qualified", "insufficient"].includes(String(value.state)) ||
    !object(value.thresholds) ||
    !hasCurrentRosHistoricalCoverageThresholds(value.thresholds) ||
    !integers(value.heldOutSeasonsRequested, 2009, 2200, 12) ||
    !integers(value.fullyHeldOutSeasons, 2009, 2200, 12) ||
    !integer(value.completeAsOfBatches, 0, 216) ||
    !integer(value.totalAsOfBatches, 0, 216) ||
    value.completeAsOfBatches > value.totalAsOfBatches ||
    !strings(value.reasons) ||
    !Array.isArray(value.seasons) ||
    value.seasons.length > 12
  )
    return false;
  const thresholds = value.thresholds;
  if (
    ![
      "minimumHeldOutSeasons",
      "minimumAsOfBatches",
      "minimumPriorSeasons",
      "minimumPlayersPerPosition",
      "maximumSeasons",
      "maximumFacts",
    ].every((name) => integer(thresholds[name], 1, 10_000_000)) ||
    !rate(thresholds.minimumRosterMatchRate) ||
    !rate(thresholds.minimumSnapMatchRate)
  )
    return false;
  for (const season of value.seasons) {
    if (
      !object(season) ||
      !integer(season.season, 2009, 2200) ||
      !integers(season.priorSeasons, 2009, 2200, 12) ||
      !integers(season.expectedWeeks, 1, 18, 18) ||
      !integer(season.eligibleAsOfWeeks, 0, 18) ||
      !integer(season.completeAsOfWeeks, 0, 18) ||
      typeof season.fullyHeldOut !== "boolean" ||
      !strings(season.reasons) ||
      !Array.isArray(season.priorSeasonCoverage) ||
      season.priorSeasonCoverage.length > 12 ||
      !Array.isArray(season.weeks) ||
      season.weeks.length > 18
    )
      return false;
    for (const prior of season.priorSeasonCoverage) {
      if (
        !object(prior) ||
        !integer(prior.season, 2009, season.season - 1) ||
        ![
          "weeklyStatRows",
          "weeklyRosterRows",
          "injuryRows",
          "snapRows",
          "scheduleGames",
          "completedScheduleGames",
        ].every((name) => integer(prior[name], 0, 10_000_000)) ||
        typeof prior.complete !== "boolean" ||
        !strings(prior.missingDatasets)
      )
        return false;
    }
    for (const week of season.weeks) {
      if (
        !object(week) ||
        !integer(week.targetWeek, 1, 18) ||
        !integer(week.asOfWeek, 0, 17) ||
        !["scheduleGames", "completedScheduleGames", "injuryBatchRows"].every((name) =>
          integer(week[name], 0, 100_000),
        ) ||
        typeof week.complete !== "boolean" ||
        !strings(week.reasons) ||
        !Array.isArray(week.positions) ||
        week.positions.length > 5
      )
        return false;
      for (const position of week.positions) {
        if (
          !object(position) ||
          !["QB", "RB", "WR", "TE", "K"].includes(String(position.position)) ||
          ![
            "outcomePlayers",
            "priorStatPlayers",
            "priorRosterPlayers",
            "priorSnapPlayers",
            "priorInjuryReports",
            "rosterMatches",
            "snapMatches",
          ].every((name) => integer(position[name], 0, 100_000)) ||
          ![position.rosterMatchRate, position.snapMatchRate].every(
            (item) => item === null || rate(item),
          ) ||
          !strings(position.missingRosterPlayerIds, 25) ||
          !strings(position.missingSnapPlayerIds, 25) ||
          typeof position.complete !== "boolean" ||
          !strings(position.reasons)
        )
          return false;
      }
    }
  }
  return true;
}

function validateCorpus(value: unknown, retainedV12 = false): asserts value is RosHistoricalCorpus {
  const invalid = () => {
    throw new RosHistoricalCorpusError("invalid_manifest");
  };
  if (
    !object(value) ||
    value.schemaVersion !== ROS_HISTORICAL_CORPUS_SCHEMA_VERSION ||
    (Object.hasOwn(value, "actualDefinitionVersion") &&
      value.actualDefinitionVersion !== ROS_HISTORICAL_ACTUAL_DEFINITION_VERSION) ||
    (Object.hasOwn(value, "pointsAllowedDefinition") &&
      value.pointsAllowedDefinition !== "yahoo-2022-v1" &&
      value.pointsAllowedDefinition !== "espn-2019-v1") ||
    !(retainedV12
      ? isRetainedV12RosHistoricalCorpusBuildProtocol(value.buildProtocol)
      : isCompatibleRosHistoricalCorpusBuildProtocol(value.buildProtocol)) ||
    value.modelVersion !==
      (retainedV12
        ? RETAINED_V12_ROS_HISTORICAL_CORPUS_BUILD_PROTOCOL.modelVersion
        : FIRST_PARTY_ROS_MODEL_VERSION) ||
    value.outcomeSchemaVersion !== FIRST_PARTY_ROS_OUTCOME_SCHEMA_VERSION ||
    value.weeklyModelVersion !== ROS_HISTORICAL_CORPUS_BUILD_PROTOCOL.weeklyModelVersion ||
    value.productionBasis !== ROS_HISTORICAL_CORPUS_BUILD_PROTOCOL.productionBasis ||
    !object(value.sourceChecksums) ||
    !Array.isArray(value.sourceAudit) ||
    value.sourceAudit.length > 12 ||
    !object(value.options) ||
    !integers(value.seasons, 2009, 2200, 12) ||
    !integer(value.skippedForecasts, 0, 1_000_000) ||
    !Array.isArray(value.kickerFamilyAudit) ||
    value.kickerFamilyAudit.length > 12 ||
    !Array.isArray(value.forecasts) ||
    value.forecasts.length > 6_000 ||
    !validCoverage(value.coverage)
  )
    invalid();
  // The checks above establish the record shape. Aliases preserve that narrowing in callbacks.
  const corpus = value as RosHistoricalCorpus;
  const sources = Object.entries(corpus.sourceChecksums);
  if (
    sources.length === 0 ||
    sources.length > 256 ||
    sources.some(([name, sum]) => !string(name) || !digest(sum))
  )
    invalid();
  const sourceDigests = new Set(sources.map(([, sum]) => sum));
  for (const row of corpus.sourceAudit) {
    if (
      !object(row) ||
      !integer(row.season, 2009, 2200) ||
      !integer(row.unresolvedSnapRows, 0, 1_000_000)
    )
      invalid();
    for (const name of [
      "weeklyStatsChecksum",
      "teamWeeklyStatsChecksum",
      "weeklyRosterChecksum",
      "injuryChecksum",
      "snapChecksum",
      "scheduleChecksum",
    ])
      if (!digest(row[name]) || !sourceDigests.has(row[name])) invalid();
    if (
      Object.values(row).some(
        (item) => typeof item !== "string" && (typeof item !== "number" || !Number.isFinite(item)),
      )
    )
      invalid();
  }
  const options = corpus.options;
  if (
    !hasRosHistoricalCorpusReleaseThresholds(options) ||
    !integers(options.heldOutSeasons, 2009, 2200, 12) ||
    !integers(options.asOfWeeks, 0, 17, 18) ||
    !Array.isArray(options.positions) ||
    options.positions.length === 0 ||
    options.positions.length > 6 ||
    new Set(options.positions).size !== options.positions.length ||
    options.positions.some(
      (position: unknown) => typeof position !== "string" || !POSITIONS.has(position),
    ) ||
    ![
      "playersPerPosition",
      "maximumForecasts",
      "minimumPortfolioForecasts",
      "minimumPortfolioBatches",
      "minimumCellSamples",
      "minimumCellCutoffs",
      "minimumCellBatches",
      "minimumCellSeasons",
    ].every((name) => integer((options as unknown as Record<string, unknown>)[name], 1, 100_000)) ||
    corpus.forecasts.length > options.maximumForecasts ||
    corpus.seasons.some(
      (season) =>
        !options.heldOutSeasons.includes(season) ||
        !corpus.coverage.fullyHeldOutSeasons.includes(season),
    )
  )
    invalid();
  const forecastIds = new Set<string>();
  for (const row of corpus.forecasts) {
    if (
      !object(row) ||
      !object(row.forecast) ||
      !object(row.actualComponents) ||
      !object(row.coverage) ||
      !integer(row.scheduledGames, 0, 18) ||
      !integer(row.actualGames, 0, 18) ||
      row.actualGames > row.scheduledGames ||
      !rate(row.coverage.contextual) ||
      !rate(row.coverage.recency)
    )
      invalid();
    const forecast = row.forecast;
    if (
      !string(forecast.playerId) ||
      !POSITIONS.has(forecast.position) ||
      !corpus.seasons.includes(forecast.forecastSeason) ||
      !options.positions.includes(forecast.position) ||
      !integer(forecast.asOfWeek, 0, 17) ||
      !options.asOfWeeks.includes(forecast.asOfWeek) ||
      !integer(forecast.windowStartWeek, forecast.asOfWeek + 1, 18) ||
      !integer(forecast.windowEndWeek, forecast.windowStartWeek, 18) ||
      !integer(forecast.trainedThroughSeason, 2008, forecast.forecastSeason - 1) ||
      !digest(forecast.inputChecksum) ||
      forecast.intervalMethodVersion !==
        ROS_HISTORICAL_CORPUS_BUILD_PROTOCOL.intervalMethodVersion ||
      forecast.contextualModelVersion !==
        `${corpus.modelVersion}:contextual:${corpus.buildProtocol.weeklyComponentModelVersion}` ||
      forecast.recencyModelVersion !==
        `${corpus.modelVersion}:availability-aware-recency:${corpus.buildProtocol.weeklyComponentModelVersion}` ||
      ["scoringProfileKey", "contextual", "recency", "actualPoints", "evidence"].some((name) =>
        Object.hasOwn(forecast, name),
      )
    )
      invalid();
    const id = `${forecast.forecastSeason}:${forecast.asOfWeek}:${forecast.position}:${forecast.playerId}`;
    if (forecastIds.has(id)) invalid();
    forecastIds.add(id);
    for (const key of [row.contextualKey, row.recencyKey])
      if (!object(key) || key.modelVersion !== corpus.modelVersion || !digest(key.identity))
        invalid();
    if (row.contextualKey.identity === row.recencyKey.identity) invalid();
    const components = Object.entries(row.actualComponents);
    if (
      (components.length === 0 && row.actualGames > 0) ||
      components.length > 512 ||
      components.some(
        ([name, amount]) => !/^[a-z][a-z0-9_]{0,127}$/u.test(name) || !Number.isFinite(amount),
      )
    )
      invalid();
  }
  for (const audit of corpus.kickerFamilyAudit) {
    if (
      !object(audit) ||
      !corpus.seasons.includes(audit.season) ||
      !["within-bounds", "out-of-bounds"].includes(audit.state) ||
      !object(audit.dispersion) ||
      !object(audit.fitted) ||
      !object(audit.fitted.evidence)
    )
      invalid();
    if (
      Object.values(audit.dispersion).some(
        (amount) => typeof amount !== "number" || !Number.isFinite(amount),
      )
    )
      invalid();
    for (const name of ["fgEventDispersion", "xpDispersion", "centerVolatility"])
      if (
        typeof (audit.fitted as unknown as Record<string, unknown>)[name] !== "number" ||
        !Number.isFinite((audit.fitted as unknown as Record<string, number>)[name])
      )
        invalid();
  }
}

/** Legacy bytes remain readable, but cannot supply current observed-outcome evidence. */
export function requireCurrentRosHistoricalActualDefinition(corpus: RosHistoricalCorpus): void {
  if (
    !Object.hasOwn(corpus, "actualDefinitionVersion") ||
    corpus.actualDefinitionVersion !== ROS_HISTORICAL_ACTUAL_DEFINITION_VERSION
  )
    throw new TypeError(
      "ROS historical actual definition is missing or unsupported; corrected-source recapture required",
    );
}

/** Unspecified active PA rules cannot select evidence. No priced PA imposes no definition. */
export function rosHistoricalProfilePointsAllowedDefinition(
  profile: ProjectionScoringProfile,
): ProjectionDefensePointsAllowedDefinition | null {
  const definition = defensePointsAllowedDefinitionForProfile(profile);
  if (
    definition === null &&
    profile.rules.some(
      (rule) =>
        isDefensePointsAllowedStatId(rule.statId) &&
        (rule.points !== 0 || (rule.bonuses ?? []).some((bonus) => bonus.points !== 0)),
    )
  )
    throw new TypeError(
      "ROS historical active points-allowed scoring requires an explicit definition",
    );
  return definition;
}

/** Explicit provenance is required even for profiles that do not price points allowed. */
export function requireRosHistoricalPointsAllowedDefinition(
  corpus: RosHistoricalCorpus,
  profile?: ProjectionScoringProfile,
): ProjectionDefensePointsAllowedDefinition {
  const definition = corpus.pointsAllowedDefinition;
  if (
    !Object.hasOwn(corpus, "pointsAllowedDefinition") ||
    (definition !== "yahoo-2022-v1" && definition !== "espn-2019-v1")
  )
    throw new TypeError(
      "ROS historical points-allowed definition is missing or unsupported; corrected-source recapture required",
    );
  const requested =
    profile === undefined ? null : rosHistoricalProfilePointsAllowedDefinition(profile);
  if (requested !== null && requested !== definition)
    throw new TypeError(
      "ROS historical points-allowed definition does not match the scoring profile",
    );
  return definition;
}

/** Canonical content identity includes source/model/config/observed outcomes and all cache refs. */
export function rosHistoricalCorpusIdentity(corpus: RosHistoricalCorpus): string {
  validateCorpus(corpus);
  return checksum(canonical(corpus, ROS_HISTORICAL_CORPUS_MAXIMUM_BYTES));
}

/** Own a bounded validated snapshot before asynchronous scoring or user-supplied callbacks. */
export function snapshotRosHistoricalCorpus(corpus: RosHistoricalCorpus): RosHistoricalCorpus {
  validateCorpus(corpus);
  return JSON.parse(canonical(corpus, ROS_HISTORICAL_CORPUS_MAXIMUM_BYTES)) as RosHistoricalCorpus;
}

export function retainedV12RosHistoricalCorpusIdentity(corpus: RosHistoricalCorpus): string {
  validateCorpus(corpus, true);
  return checksum(canonical(corpus, ROS_HISTORICAL_CORPUS_MAXIMUM_BYTES));
}

export function snapshotRetainedV12RosHistoricalCorpus(
  corpus: RosHistoricalCorpus,
): RosHistoricalCorpus {
  validateCorpus(corpus, true);
  return JSON.parse(canonical(corpus, ROS_HISTORICAL_CORPUS_MAXIMUM_BYTES)) as RosHistoricalCorpus;
}

export function createRosHistoricalCorpusStore(options: {
  readonly directory: string;
  readonly maximumBytes?: number;
}): RosHistoricalCorpusStore {
  return createCorpusStore(options, false);
}

/** Explicit historical reader: it exposes no writer and rejects all current/unknown models. */
export function createRetainedV12RosHistoricalCorpusReader(options: {
  readonly directory: string;
  readonly maximumBytes?: number;
}): Pick<RosHistoricalCorpusStore, "read"> {
  const store = createCorpusStore(options, true);
  return { read: (identity, readOptions) => store.read(identity, readOptions) };
}

function createCorpusStore(
  options: {
    readonly directory: string;
    readonly maximumBytes?: number;
  },
  retainedV12: boolean,
): RosHistoricalCorpusStore {
  const maximumBytes = options.maximumBytes ?? ROS_HISTORICAL_CORPUS_MAXIMUM_BYTES;
  if (!integer(maximumBytes, 1, ROS_HISTORICAL_CORPUS_MAXIMUM_BYTES))
    throw new RosHistoricalCorpusError("limits_exceeded");
  const file = (identity: string) => {
    if (!digest(identity)) throw new RosHistoricalCorpusError("invalid_manifest");
    return path.join(options.directory, `${identity}.ros-corpus.json.gz`);
  };
  const read: RosHistoricalCorpusStore["read"] = async (identity, readOptions = {}) => {
    const { signal } = readOptions;
    signal?.throwIfAborted();
    let handle;
    try {
      handle = await open(file(identity), constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return { state: "missing" };
      if (code === "ELOOP") return { state: "corrupt", reason: "invalid_manifest" };
      throw error;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) return { state: "corrupt", reason: "invalid_manifest" };
      if (stat.size > MAXIMUM_COMPRESSED_BYTES)
        return { state: "corrupt", reason: "limits_exceeded" };
      const chunks: Buffer[] = [];
      let compressedBytes = 0;
      let bytes = 0;
      await pipeline(
        handle.createReadStream({ autoClose: false }),
        new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            compressedBytes += chunk.length;
            if (compressedBytes > MAXIMUM_COMPRESSED_BYTES)
              callback(new RosHistoricalCorpusError("limits_exceeded"));
            else callback(null, chunk);
          },
        }),
        createGunzip(),
        new Writable({
          write(chunk: Buffer, _encoding, callback) {
            bytes += chunk.length;
            if (bytes > maximumBytes + 256)
              callback(new RosHistoricalCorpusError("limits_exceeded"));
            else {
              chunks.push(chunk);
              callback();
            }
          },
        }),
        { signal },
      );
      signal?.throwIfAborted();
      const envelope: unknown = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
      if (!object(envelope) || envelope.identity !== identity || !object(envelope.corpus))
        return { state: "corrupt", reason: "invalid_manifest" };
      const serialized = canonical(envelope.corpus, maximumBytes);
      if (checksum(serialized) !== identity)
        return { state: "corrupt", reason: "checksum_mismatch" };
      validateCorpus(envelope.corpus, retainedV12);
      return { state: "hit", identity, corpus: envelope.corpus };
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof RosHistoricalCorpusError)
        return {
          state: "corrupt",
          reason: error.code === "limits_exceeded" ? "limits_exceeded" : "invalid_manifest",
        };
      if (
        error instanceof SyntaxError ||
        ["Z_DATA_ERROR", "Z_BUF_ERROR", "ERR_STREAM_PREMATURE_CLOSE"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        return { state: "corrupt", reason: "invalid_manifest" };
      throw error;
    } finally {
      await handle.close();
    }
  };
  const write: RosHistoricalCorpusStore["write"] = async (corpus, writeOptions = {}) => {
    if (retainedV12) throw new RosHistoricalCorpusError("invalid_manifest");
    const { signal } = writeOptions;
    signal?.throwIfAborted();
    validateCorpus(corpus);
    requireCurrentRosHistoricalActualDefinition(corpus);
    requireRosHistoricalPointsAllowedDefinition(corpus);
    const serialized = canonical(corpus, maximumBytes);
    const identity = checksum(serialized);
    const envelope = `{"identity":${JSON.stringify(identity)},"corpus":${serialized}}`;
    await mkdir(options.directory, { recursive: true, mode: 0o700 });
    await assertRosCacheHeadroom(
      options.directory,
      rosCacheCompressedWriteBudget(Buffer.byteLength(envelope)),
      signal,
    );
    const temporary = await mkdtemp(path.join(options.directory, ".ros-corpus-partial-"));
    try {
      const destination = path.join(temporary, "corpus.gz");
      let compressedBytes = 0;
      await pipeline(
        Readable.from([envelope]),
        createGzip({ level: 1 }),
        new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            compressedBytes += chunk.length;
            if (compressedBytes > MAXIMUM_COMPRESSED_BYTES)
              callback(new RosHistoricalCorpusError("limits_exceeded"));
            else callback(null, chunk);
          },
        }),
        createWriteStream(destination, { flags: "wx", mode: 0o600 }),
        { signal },
      );
      const handle = await open(destination, "r+");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      signal?.throwIfAborted();
      try {
        await link(destination, file(identity));
        return { state: "written", identity };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = await read(identity, { ...(signal ? { signal } : {}) });
        if (existing.state !== "hit") throw new RosHistoricalCorpusError("existing_entry_corrupt");
        return { state: "existing", identity };
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  };
  return { read, write };
}
