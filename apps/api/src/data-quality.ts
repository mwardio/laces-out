import {
  dataQualitySourceSchema,
  type DataQualityAvailability,
  type DataQualityDataset,
  type DataQualityResponse,
  type DataQualitySource,
  type UnresolvedIdentityResponse,
  type UnresolvedIdentitySample,
  type UnresolvedIdentityWeek,
} from "@laces-out/contracts";
import {
  dataSources,
  playerInjuryReportObservations,
  playerSnapCountObservations,
  playerWeeklyRosterObservations,
  playerWeeklyStatObservations,
  type Database,
} from "@laces-out/db";
import {
  currentNflSeason,
  isArchivedNflverseSource,
  sourceMatchRateThreshold,
  sourceSeason,
} from "@laces-out/domain";
import { and, asc, count, eq, isNull } from "drizzle-orm";

import {
  admittedSourceContract,
  admittedSourceQuality,
  type AdmittedSourceRow,
} from "./admitted-source.js";

/**
 * Read-side visibility for source identity quality. Ingestion already quarantines an ambiguous
 * match rather than guessing it and records rows read, rejected, and unmatched. This module
 * makes that readable: which sources are below their match-rate threshold, what analysis is
 * therefore withheld, and — for an administrator only — which weeks hold unresolved rows.
 *
 * These rows are immutable historical facts, not a mutable quarantine queue. Nothing here presents
 * them as a work list anyone can clear.
 */

/**
 * Bounded reads, shaped like `SCHEDULE_EDGE_LIMITS` in `apps/api/src/schedule-edge.ts`. Each cap is
 * `n + 1` so that `rows.length >= limit` proves more rows exist. On overflow the section is
 * **withheld** with a stated reason; it is never sliced into a partial answer that reads as
 * complete.
 */
export const DATA_QUALITY_LIMITS = {
  /** `data_sources` rows scanned. ~40 enabled today (5 datasets x 4 seasons, schedules, and ADP). */
  sources: 65,
  /** Grouped (season, week) unresolved counts for one source. */
  unresolvedWeeks: 501,
  /** Redacted unresolved rows returned for one source. */
  sampleRows: 51,
} as const;

export const DATA_QUALITY_ALGORITHM_VERSION = "data-quality-v1";

function boundedReason(limit: number): string {
  return `The bounded read reached its ${limit - 1} row safety limit, so this dataset was withheld.`;
}

export interface UnresolvedIdentityViewInput {
  readonly weeksRead: readonly UnresolvedIdentityWeek[];
  readonly sampleRead: readonly UnresolvedIdentitySample[];
}

export interface UnresolvedIdentityView {
  readonly weeks: DataQualityAvailability & { readonly rows: readonly UnresolvedIdentityWeek[] };
  readonly sample: DataQualityAvailability & { readonly rows: readonly UnresolvedIdentitySample[] };
}

function boundedSection<Row>(
  rows: readonly Row[],
  limit: number,
): DataQualityAvailability & { readonly rows: readonly Row[] } {
  if (rows.length >= limit) {
    return { state: "unavailable", reason: boundedReason(limit), rows: [] };
  }
  return { state: "available", reason: null, rows };
}

/** Pure so the bounding rule is testable without a database. */
export function unresolvedIdentityView(input: UnresolvedIdentityViewInput): UnresolvedIdentityView {
  return {
    weeks: boundedSection(input.weeksRead, DATA_QUALITY_LIMITS.unresolvedWeeks),
    sample: boundedSection(input.sampleRead, DATA_QUALITY_LIMITS.sampleRows),
  };
}

/**
 * The derived surfaces that stop publishing when a dataset is quarantined. Named so a member sees
 * impact instead of a blank panel. Static, because it describes product structure rather than data.
 */
const AFFECTED_ANALYSIS: Readonly<Record<DataQualityDataset, readonly string[]>> = {
  "weekly-stats": ["Schedule Edge", "Stats Center", "Projection Lab"],
  "weekly-rosters": ["Schedule Edge", "Projection Lab"],
  "snap-counts": ["Stats Center"],
  injuries: ["Projection Lab"],
  "team-weekly-stats": ["Projection Lab"],
  schedules: ["Schedule Edge"],
  adp: ["Draft Studio"],
  other: [],
};

const DATASET_PREFIXES: readonly (readonly [string, DataQualityDataset])[] = [
  ["nflverse.stats-player-week.", "weekly-stats"],
  ["nflverse.stats-team-week.", "team-weekly-stats"],
  ["nflverse.weekly-rosters.", "weekly-rosters"],
  ["nflverse.snap-counts.", "snap-counts"],
  ["nflverse.injuries.", "injuries"],
  ["nflverse.schedules.", "schedules"],
  ["ffc.adp.", "adp"],
];

export function datasetForSourceKey(key: string): DataQualityDataset {
  for (const [prefix, dataset] of DATASET_PREFIXES) {
    if (key.startsWith(prefix)) return dataset;
  }
  return "other";
}

export function dataQualitySource(
  row: AdmittedSourceRow,
  activeSeason = currentNflSeason(),
): DataQualitySource {
  const dataset = datasetForSourceKey(row.key);
  const contract = admittedSourceContract(dataset, row.key, row.name, row);
  const quality = admittedSourceQuality(row);
  const threshold = sourceMatchRateThreshold(row.key);
  // Reported against the threshold recorded at ingestion when one is stored, so the surface never
  // claims a source passed a bar that was not in force when the artifact was written.
  const storedMinimum = row.metadata.minimumPublishableMatchRate;
  const minimumMatchRate =
    typeof storedMinimum === "number" && storedMinimum >= 0 && storedMinimum <= 1
      ? storedMinimum
      : threshold.minimumMatchRate;
  return dataQualitySourceSchema.parse({
    key: row.key,
    name: row.name,
    dataset,
    season: sourceSeason(row.metadata),
    lifecycle: isArchivedNflverseSource(row.key, row.metadata, activeSeason)
      ? "archived"
      : "active",
    admission: contract.state,
    matchRate: quality.matchRate,
    minimumMatchRate,
    thresholdRationale: threshold.rationale,
    // A source with no recorded rate has not proved it clears the bar, so it does not claim to.
    meetsThreshold: quality.matchRate !== null && quality.matchRate >= minimumMatchRate,
    rowsRead: quality.rowsRead,
    rowsRejected: quality.rowsRejected,
    rowsUnmatched: quality.rowsUnmatched,
    lastSuccessfulAt: contract.fetchedAt,
    checksumSha256: contract.checksumSha256,
    affectedAnalysis: [...AFFECTED_ANALYSIS[dataset]],
    reason: contract.reason,
  });
}

/** A source is degraded when it is not admitted or its recorded rate is below its threshold. */
export function isDegradedSource(source: DataQualitySource): boolean {
  return source.admission !== "available" || !source.meetsThreshold;
}

export interface DataQualityRepository {
  listSources(limit: number): Promise<readonly AdmittedSourceRow[]>;
  findSource(key: string): Promise<AdmittedSourceRow | undefined>;
  listUnresolvedWeeks(
    dataset: DataQualityDataset,
    sourceId: string,
    season: number,
    limit: number,
  ): Promise<readonly UnresolvedIdentityWeek[]>;
  listUnresolvedSample(
    dataset: DataQualityDataset,
    sourceId: string,
    season: number,
    limit: number,
  ): Promise<readonly UnresolvedIdentitySample[]>;
}

/**
 * Every query pins `source_id` with equality and carries `player_id is null` literally, so
 * PostgreSQL can use the `*_unmatched_idx` partial indexes
 * (`packages/db/src/schema.ts:1819,1941,2005,2086`) instead of scanning four seasons of weekly rows.
 * Changing either predicate silently turns these into sequential scans.
 */
export class DrizzleDataQualityRepository implements DataQualityRepository {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  listSources(limit: number): Promise<readonly AdmittedSourceRow[]> {
    return this.#database
      .select({
        id: dataSources.id,
        key: dataSources.key,
        name: dataSources.name,
        attribution: dataSources.attribution,
        attributionUrl: dataSources.attributionUrl,
        lastSuccessfulAt: dataSources.lastSuccessfulAt,
        lastChecksum: dataSources.lastChecksum,
        metadata: dataSources.metadata,
      })
      .from(dataSources)
      .where(eq(dataSources.enabled, true))
      .orderBy(asc(dataSources.key))
      .limit(limit);
  }

  findSource(key: string): Promise<AdmittedSourceRow | undefined> {
    return this.#database
      .select({
        id: dataSources.id,
        key: dataSources.key,
        name: dataSources.name,
        attribution: dataSources.attribution,
        attributionUrl: dataSources.attributionUrl,
        lastSuccessfulAt: dataSources.lastSuccessfulAt,
        lastChecksum: dataSources.lastChecksum,
        metadata: dataSources.metadata,
      })
      .from(dataSources)
      .where(and(eq(dataSources.key, key), eq(dataSources.enabled, true)))
      .limit(1)
      .then(([row]) => row);
  }

  async listUnresolvedWeeks(
    dataset: DataQualityDataset,
    sourceId: string,
    season: number,
    limit: number,
  ): Promise<readonly UnresolvedIdentityWeek[]> {
    switch (dataset) {
      case "weekly-stats": {
        const table = playerWeeklyStatObservations;
        return this.#database
          .select({ season: table.season, week: table.week, unresolvedRows: count() })
          .from(table)
          .where(
            and(eq(table.sourceId, sourceId), eq(table.season, season), isNull(table.playerId)),
          )
          .groupBy(table.season, table.week)
          .orderBy(asc(table.season), asc(table.week))
          .limit(limit);
      }
      case "weekly-rosters": {
        const table = playerWeeklyRosterObservations;
        return this.#database
          .select({ season: table.season, week: table.week, unresolvedRows: count() })
          .from(table)
          .where(
            and(eq(table.sourceId, sourceId), eq(table.season, season), isNull(table.playerId)),
          )
          .groupBy(table.season, table.week)
          .orderBy(asc(table.season), asc(table.week))
          .limit(limit);
      }
      case "injuries": {
        const table = playerInjuryReportObservations;
        return this.#database
          .select({ season: table.season, week: table.week, unresolvedRows: count() })
          .from(table)
          .where(
            and(eq(table.sourceId, sourceId), eq(table.season, season), isNull(table.playerId)),
          )
          .groupBy(table.season, table.week)
          .orderBy(asc(table.season), asc(table.week))
          .limit(limit);
      }
      case "snap-counts": {
        const table = playerSnapCountObservations;
        return this.#database
          .select({ season: table.season, week: table.week, unresolvedRows: count() })
          .from(table)
          .where(
            and(eq(table.sourceId, sourceId), eq(table.season, season), isNull(table.playerId)),
          )
          .groupBy(table.season, table.week)
          .orderBy(asc(table.season), asc(table.week))
          .limit(limit);
      }
      default:
        // Team stats, schedules, and ADP carry no nullable per-player identity column, so there is
        // no unresolved-identity table to read rather than an empty one to report.
        return [];
    }
  }

  async listUnresolvedSample(
    dataset: DataQualityDataset,
    sourceId: string,
    season: number,
    limit: number,
  ): Promise<readonly UnresolvedIdentitySample[]> {
    switch (dataset) {
      case "weekly-stats": {
        const table = playerWeeklyStatObservations;
        const rows = await this.#database
          .select({
            season: table.season,
            week: table.week,
            externalPlayerId: table.externalPlayerId,
            team: table.team,
          })
          .from(table)
          .where(
            and(eq(table.sourceId, sourceId), eq(table.season, season), isNull(table.playerId)),
          )
          .orderBy(asc(table.week), asc(table.externalPlayerId))
          .limit(limit);
        return rows.map((row) => ({ ...row, position: null }));
      }
      case "weekly-rosters": {
        const table = playerWeeklyRosterObservations;
        // Status and description columns are never selected; see the redaction rule on
        // `unresolvedIdentitySampleSchema`.
        return this.#database
          .select({
            season: table.season,
            week: table.week,
            externalPlayerId: table.externalPlayerId,
            team: table.team,
            position: table.position,
          })
          .from(table)
          .where(
            and(eq(table.sourceId, sourceId), eq(table.season, season), isNull(table.playerId)),
          )
          .orderBy(asc(table.week), asc(table.externalPlayerId))
          .limit(limit);
      }
      case "injuries": {
        const table = playerInjuryReportObservations;
        // Injury and practice free text is health information about a named athlete and is never
        // selected here, whatever the caller's role.
        return this.#database
          .select({
            season: table.season,
            week: table.week,
            externalPlayerId: table.externalPlayerId,
            team: table.team,
            position: table.position,
          })
          .from(table)
          .where(
            and(eq(table.sourceId, sourceId), eq(table.season, season), isNull(table.playerId)),
          )
          .orderBy(asc(table.week), asc(table.externalPlayerId))
          .limit(limit);
      }
      case "snap-counts": {
        const table = playerSnapCountObservations;
        const rows = await this.#database
          .select({
            season: table.season,
            week: table.week,
            externalPlayerId: table.externalPlayerId,
            team: table.team,
          })
          .from(table)
          .where(
            and(eq(table.sourceId, sourceId), eq(table.season, season), isNull(table.playerId)),
          )
          .orderBy(asc(table.week), asc(table.externalPlayerId))
          .limit(limit);
        return rows.map((row) => ({ ...row, position: null }));
      }
      default:
        return [];
    }
  }
}

export class DataQualityService {
  readonly #repository: DataQualityRepository;
  readonly #now: () => Date;

  constructor(repository: DataQualityRepository, now: () => Date = () => new Date()) {
    this.#repository = repository;
    this.#now = now;
  }

  async getSourceQuality(): Promise<DataQualityResponse> {
    const rows = await this.#repository.listSources(DATA_QUALITY_LIMITS.sources);
    const generatedAt = this.#now().toISOString();
    if (rows.length >= DATA_QUALITY_LIMITS.sources) {
      return {
        generatedAt,
        algorithmVersion: DATA_QUALITY_ALGORITHM_VERSION,
        availability: {
          state: "unavailable",
          reason: `The bounded read reached its ${DATA_QUALITY_LIMITS.sources - 1} row safety limit, so source quality was withheld.`,
        },
        sources: [],
        degradedSourceKeys: [],
      };
    }
    const activeSeason = currentNflSeason(this.#now());
    const sources = rows.map((row) => dataQualitySource(row, activeSeason));
    return {
      generatedAt,
      algorithmVersion: DATA_QUALITY_ALGORITHM_VERSION,
      availability: { state: "available", reason: null },
      sources,
      degradedSourceKeys: sources.filter(isDegradedSource).map((source) => source.key),
    };
  }

  async getUnresolvedIdentities(key: string): Promise<UnresolvedIdentityResponse | undefined> {
    const row = await this.#repository.findSource(key);
    if (!row) return undefined;
    const source = dataQualitySource(row, currentNflSeason(this.#now()));
    const generatedAt = this.#now().toISOString();
    if (source.season === null) {
      // Without a recorded season the read cannot pin the partial index, so it is withheld rather
      // than widened into a scan of every season this source has ever written.
      const reason =
        "This source has not recorded the season its latest refresh covered, so the bounded read was withheld.";
      return {
        generatedAt,
        algorithmVersion: DATA_QUALITY_ALGORITHM_VERSION,
        source,
        weeks: { state: "unavailable", reason, rows: [] },
        sample: { state: "unavailable", reason, rows: [] },
      };
    }
    const [weeksRead, sampleRead] = await Promise.all([
      this.#repository.listUnresolvedWeeks(
        source.dataset,
        row.id,
        source.season,
        DATA_QUALITY_LIMITS.unresolvedWeeks,
      ),
      this.#repository.listUnresolvedSample(
        source.dataset,
        row.id,
        source.season,
        DATA_QUALITY_LIMITS.sampleRows,
      ),
    ]);
    const view = unresolvedIdentityView({ weeksRead, sampleRead });
    return {
      generatedAt,
      algorithmVersion: DATA_QUALITY_ALGORITHM_VERSION,
      source,
      weeks: { ...view.weeks, rows: [...view.weeks.rows] },
      sample: { ...view.sample, rows: [...view.sample.rows] },
    };
  }
}
