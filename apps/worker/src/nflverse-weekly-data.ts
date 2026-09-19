import { createHash } from "node:crypto";

import {
  dataSources,
  playerInjuryReportObservations,
  playerExternalIds,
  playerSnapCountObservations,
  playerWeeklyRosterObservations,
  teamWeeklyStatObservations,
  playerWeeklyStatObservations,
  players,
  syncRuns,
  type Database,
  type JsonPrimitive,
} from "@laces-out/db";
import { emitChangeEvents } from "@laces-out/change-events";
import { isReusableArchivedSourceArtifact, sourceMatchRateThreshold } from "@laces-out/domain";

import {
  buildInjuryChangeDrafts,
  playerWeekKey,
  type InjuryChangeEventRepository,
  type InjuryReportStatus,
} from "./injury-change-events.js";
import {
  NFLVERSE_DATA_LICENSE,
  NFLVERSE_SNAP_COUNTS_ATTRIBUTION,
  NFLVERSE_SNAP_COUNTS_ATTRIBUTION_URL,
  NFLVERSE_INJURIES_ATTRIBUTION,
  NFLVERSE_INJURIES_ATTRIBUTION_URL,
  NFLVERSE_TEAM_WEEKLY_STATS_ATTRIBUTION,
  NFLVERSE_TEAM_WEEKLY_STATS_ATTRIBUTION_URL,
  NFLVERSE_TEAM_WEEKLY_STATS_COMPONENT_SCHEMA,
  NFLVERSE_WEEKLY_ROSTERS_ATTRIBUTION,
  NFLVERSE_WEEKLY_ROSTERS_ATTRIBUTION_URL,
  NFLVERSE_WEEKLY_STATS_ATTRIBUTION,
  NFLVERSE_WEEKLY_STATS_ATTRIBUTION_URL,
  NFLVERSE_WEEKLY_STATS_COMPONENT_SCHEMA,
  NflverseDatasetSourceError,
  NflverseInjuriesSource,
  NflverseSnapCountsSource,
  NflverseTeamWeeklyStatsSource,
  NflverseWeeklyRostersSource,
  NflverseWeeklyStatsSource,
  NflversePlayByPlaySource,
  snapshotNflversePlayByPlay,
  NFLVERSE_DEFENSE_SCORING_EVENTS_VERSION,
  type NflversePlayByPlayLoader,
  buildNflverseSnapCountsUrl,
  buildNflverseInjuriesUrl,
  buildNflverseTeamWeeklyStatsUrl,
  buildNflverseWeeklyRostersUrl,
  buildNflverseWeeklyStatsUrl,
  weeklyRostersIdentityKey,
  type NflversePlayerSnapCount,
  type NflversePlayerInjuryReport,
  type NflversePlayerWeeklyStats,
  type NflverseWeeklyRosterPlayer,
} from "@laces-out/source-nflverse";
import { and, eq, inArray, lte } from "drizzle-orm";

import { currentNflSeason } from "./nfl-season.js";
import { resolveNflverseRosterIdentities } from "./nflverse-roster-identities.js";

// Active-season artifacts are checked during the game-aware near-lock sweep. Completed seasons
// are admitted once and reused until an operator forces a refresh or a parser/schema release
// requires a replay.
const currentSeasonCheckIntervalMinutes = 30;
const historicalCheckIntervalMinutes = 24 * 60;
const claimMinutes = 45;
const chunkSize = 500;
// v3 added exact kicker distance components and play-by-play-derived fourth-down stops. v4 makes
// normalized player-week checksums schema-aware. Each player/team component contract now has
// its own replay marker and checksum identity, so a new team component need not replay all datasets.
const sourceSchemaVersion = 4;
const rosterIdentityVersion = 1;
const fantasyRosterPositions = new Set(["QB", "RB", "FB", "WR", "TE", "K"]);

export interface WeeklyDataRefreshResult {
  readonly sourceKey: string;
  readonly state: "changed" | "unchanged" | "not-due" | "not-available";
  readonly rowsRead: number;
  readonly rowsWritten: number;
  readonly rowsRejected: number;
  readonly rowsUnmatched: number;
  readonly checkedAt: string | null;
}

interface SourceRow {
  readonly id: string;
  readonly enabled: boolean;
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly lastChecksum: string | null;
  readonly consecutiveFailures: number;
  readonly metadata: Record<string, JsonPrimitive>;
}

function hasPlayByPlayCapture(metadata: SourceRow["metadata"]): boolean {
  return (
    typeof metadata.playByPlayChecksumSha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(metadata.playByPlayChecksumSha256)
  );
}

interface DatasetDescriptor {
  readonly key: string;
  readonly name: string;
  readonly kind: string;
  readonly sourceUrl: string;
  readonly attribution: string;
  readonly attributionUrl: string;
  readonly season: number;
  readonly checkIntervalMinutes: number;
}

function datasetCheckIntervalMinutes(season: number, now: Date): number {
  return season === currentNflSeason(now)
    ? currentSeasonCheckIntervalMinutes
    : historicalCheckIntervalMinutes;
}

function weeklyStatsDescriptor(season: number, now: Date): DatasetDescriptor {
  return {
    key: `nflverse.stats-player-week.${season}`,
    name: `nflverse ${season} weekly player stats`,
    kind: "weekly_stats",
    sourceUrl: buildNflverseWeeklyStatsUrl(season),
    attribution: NFLVERSE_WEEKLY_STATS_ATTRIBUTION,
    attributionUrl: NFLVERSE_WEEKLY_STATS_ATTRIBUTION_URL,
    season,
    checkIntervalMinutes: datasetCheckIntervalMinutes(season, now),
  };
}

function snapCountsDescriptor(season: number, now: Date): DatasetDescriptor {
  return {
    key: `nflverse.snap-counts.${season}`,
    name: `nflverse ${season} snap counts`,
    kind: "snap_counts",
    sourceUrl: buildNflverseSnapCountsUrl(season),
    attribution: NFLVERSE_SNAP_COUNTS_ATTRIBUTION,
    attributionUrl: NFLVERSE_SNAP_COUNTS_ATTRIBUTION_URL,
    season,
    checkIntervalMinutes: datasetCheckIntervalMinutes(season, now),
  };
}

function teamWeeklyStatsDescriptor(season: number, now: Date): DatasetDescriptor {
  return {
    key: `nflverse.stats-team-week.${season}`,
    name: `nflverse ${season} weekly team stats`,
    kind: "weekly_team_stats",
    sourceUrl: buildNflverseTeamWeeklyStatsUrl(season),
    attribution: NFLVERSE_TEAM_WEEKLY_STATS_ATTRIBUTION,
    attributionUrl: NFLVERSE_TEAM_WEEKLY_STATS_ATTRIBUTION_URL,
    season,
    checkIntervalMinutes: datasetCheckIntervalMinutes(season, now),
  };
}

function weeklyRostersDescriptor(season: number, now: Date): DatasetDescriptor {
  return {
    key: `nflverse.weekly-rosters.${season}`,
    name: `nflverse ${season} weekly rosters`,
    kind: "weekly_rosters",
    sourceUrl: buildNflverseWeeklyRostersUrl(season),
    attribution: NFLVERSE_WEEKLY_ROSTERS_ATTRIBUTION,
    attributionUrl: NFLVERSE_WEEKLY_ROSTERS_ATTRIBUTION_URL,
    season,
    checkIntervalMinutes: datasetCheckIntervalMinutes(season, now),
  };
}

function injuriesDescriptor(season: number, now: Date): DatasetDescriptor {
  return {
    key: `nflverse.injuries.${season}`,
    name: `nflverse ${season} injury reports`,
    kind: "injury_reports",
    sourceUrl: buildNflverseInjuriesUrl(season),
    attribution: NFLVERSE_INJURIES_ATTRIBUTION,
    attributionUrl: NFLVERSE_INJURIES_ATTRIBUTION_URL,
    season,
    checkIntervalMinutes: datasetCheckIntervalMinutes(season, now),
  };
}

async function claimSource(
  database: Database,
  descriptor: DatasetDescriptor,
  force: boolean,
  now: Date,
): Promise<SourceRow | null> {
  const [source] = await database
    .insert(dataSources)
    .values({
      key: descriptor.key,
      name: descriptor.name,
      kind: descriptor.kind,
      sourceUrl: descriptor.sourceUrl,
      attribution: descriptor.attribution,
      attributionUrl: descriptor.attributionUrl,
      checkIntervalMinutes: descriptor.checkIntervalMinutes,
      nextCheckAt: now,
      metadata: {
        sourceSchemaVersion,
        season: descriptor.season,
        license: NFLVERSE_DATA_LICENSE,
        availability: "pending",
      },
    })
    .onConflictDoUpdate({
      target: dataSources.key,
      set: {
        name: descriptor.name,
        kind: descriptor.kind,
        sourceUrl: descriptor.sourceUrl,
        attribution: descriptor.attribution,
        attributionUrl: descriptor.attributionUrl,
        checkIntervalMinutes: descriptor.checkIntervalMinutes,
        updatedAt: now,
      },
    })
    .returning({
      id: dataSources.id,
      enabled: dataSources.enabled,
      etag: dataSources.etag,
      lastModified: dataSources.lastModified,
      lastChecksum: dataSources.lastChecksum,
      consecutiveFailures: dataSources.consecutiveFailures,
      metadata: dataSources.metadata,
    });
  if (!source?.enabled) return null;
  // A force/reconciliation request bypasses freshness, never another refresh's live claim.
  const claimedAt =
    typeof source.metadata.refreshClaimedAt === "string"
      ? Date.parse(source.metadata.refreshClaimedAt)
      : Number.NaN;
  if (claimedAt > now.getTime() - claimMinutes * 60_000) return null;
  const pairedStats = descriptor.kind === "weekly_stats" || descriptor.kind === "weekly_team_stats";
  const replay =
    source.metadata.sourceSchemaVersion !== sourceSchemaVersion ||
    (source.metadata.availability === "available" &&
      ((descriptor.kind === "weekly_stats" &&
        source.metadata.playerWeeklyComponentSchema !== NFLVERSE_WEEKLY_STATS_COMPONENT_SCHEMA) ||
        (descriptor.kind === "weekly_team_stats" &&
          (source.metadata.teamWeeklyComponentSchema !==
            NFLVERSE_TEAM_WEEKLY_STATS_COMPONENT_SCHEMA ||
            source.metadata.teamWeeklyScoringEventsVersion !==
              NFLVERSE_DEFENSE_SCORING_EVENTS_VERSION)) ||
        (pairedStats && !hasPlayByPlayCapture(source.metadata))));
  const stableMetadata = { ...source.metadata };
  delete stableMetadata.refreshClaimedAt;
  const stableSource = { ...source, metadata: stableMetadata };
  if (
    !force &&
    !replay &&
    isReusableArchivedSourceArtifact({
      sourceKey: descriptor.key,
      metadata: stableMetadata,
      lastChecksum: source.lastChecksum,
      activeSeason: currentNflSeason(now),
      sourceSchemaVersion,
    })
  ) {
    return null;
  }
  const claimed = await database
    .update(dataSources)
    .set({
      nextCheckAt: new Date(now.getTime() + claimMinutes * 60_000),
      metadata: { ...stableMetadata, refreshClaimedAt: now.toISOString() },
      updatedAt: now,
    })
    .where(
      and(
        eq(dataSources.id, source.id),
        // Protect the interval between reading the claim marker and acquiring it.
        eq(dataSources.metadata, source.metadata),
        force || replay ? undefined : lte(dataSources.nextCheckAt, now),
      ),
    )
    .returning({ id: dataSources.id });
  return claimed.length === 1 ? stableSource : null;
}

function sourceState(source: SourceRow, playerWeekly = false, teamWeekly = false) {
  const replay =
    source.metadata.sourceSchemaVersion !== sourceSchemaVersion ||
    (playerWeekly &&
      source.metadata.playerWeeklyComponentSchema !== NFLVERSE_WEEKLY_STATS_COMPONENT_SCHEMA) ||
    (teamWeekly &&
      (source.metadata.teamWeeklyComponentSchema !== NFLVERSE_TEAM_WEEKLY_STATS_COMPONENT_SCHEMA ||
        source.metadata.teamWeeklyScoringEventsVersion !==
          NFLVERSE_DEFENSE_SCORING_EVENTS_VERSION)) ||
    ((playerWeekly || teamWeekly) && !hasPlayByPlayCapture(source.metadata));
  return {
    etag: replay ? null : source.etag,
    lastModified: replay ? null : source.lastModified,
    checksumSha256: replay ? null : source.lastChecksum,
  };
}

async function recordUnavailable(
  database: Database,
  source: SourceRow,
  descriptor: DatasetDescriptor,
  checkedAt: Date,
): Promise<void> {
  await database
    .update(dataSources)
    .set({
      lastCheckedAt: checkedAt,
      nextCheckAt: new Date(checkedAt.getTime() + descriptor.checkIntervalMinutes * 60_000),
      consecutiveFailures: 0,
      lastErrorAt: null,
      lastErrorCode: null,
      lastErrorDetail: null,
      metadata: {
        ...source.metadata,
        sourceSchemaVersion,
        season: descriptor.season,
        license: NFLVERSE_DATA_LICENSE,
        availability: "not-published",
      },
      updatedAt: checkedAt,
    })
    .where(eq(dataSources.id, source.id));
}

async function recordFailure(
  database: Database,
  source: SourceRow,
  descriptor: DatasetDescriptor,
  failedAt: Date,
  error: unknown,
): Promise<void> {
  const retryMinutes = Math.min(
    descriptor.checkIntervalMinutes,
    15 * 2 ** Math.min(source.consecutiveFailures, 6),
  );
  await database
    .update(dataSources)
    .set({
      lastCheckedAt: failedAt,
      nextCheckAt: new Date(failedAt.getTime() + retryMinutes * 60_000),
      consecutiveFailures: source.consecutiveFailures + 1,
      lastErrorAt: failedAt,
      lastErrorCode:
        error instanceof Error && "code" in error ? String(error.code).slice(0, 64) : "UNKNOWN",
      lastErrorDetail:
        error instanceof Error ? error.message.slice(0, 256) : "nflverse data refresh failed",
      // Clear the in-flight marker while retaining the last completed artifact for audit.
      metadata: source.metadata,
      updatedAt: failedAt,
    })
    .where(eq(dataSources.id, source.id));
}

function resultForUnavailable(key: string, checkedAt: Date): WeeklyDataRefreshResult {
  return {
    sourceKey: key,
    state: "not-available",
    rowsRead: 0,
    rowsWritten: 0,
    rowsRejected: 0,
    rowsUnmatched: 0,
    checkedAt: checkedAt.toISOString(),
  };
}

/** Exported for tests: proves the stored artifact carries the registry threshold and quality state. */
export function datasetMetadata(input: {
  readonly sourceKey: string;
  readonly previous: SourceRow["metadata"];
  readonly season: number;
  readonly rowsRead: number;
  readonly rowsRejected: number;
  readonly rowsUnmatched: number;
  readonly coveredWeeks: readonly number[];
  readonly coveredSeasonTypes: readonly string[];
}): Record<string, JsonPrimitive> {
  const matchRate =
    input.rowsRead > 0 ? (input.rowsRead - input.rowsUnmatched) / input.rowsRead : 0;
  // The stored key name stays `minimumPublishableMatchRate` because it is part of the persisted
  // artifact that `apps/api/src/admitted-source.ts` and the Data Health job already read.
  const { minimumMatchRate: minimumPublishableMatchRate } = sourceMatchRateThreshold(
    input.sourceKey,
  );
  const publishable = matchRate >= minimumPublishableMatchRate;
  return {
    ...input.previous,
    sourceSchemaVersion,
    ...(input.sourceKey.startsWith("nflverse.stats-player-week.")
      ? { playerWeeklyComponentSchema: NFLVERSE_WEEKLY_STATS_COMPONENT_SCHEMA }
      : {}),
    ...(input.sourceKey.startsWith("nflverse.stats-team-week.")
      ? {
          teamWeeklyComponentSchema: NFLVERSE_TEAM_WEEKLY_STATS_COMPONENT_SCHEMA,
          teamWeeklyScoringEventsVersion: NFLVERSE_DEFENSE_SCORING_EVENTS_VERSION,
        }
      : {}),
    season: input.season,
    license: NFLVERSE_DATA_LICENSE,
    availability: "available",
    rowsRead: input.rowsRead,
    rowsRejected: input.rowsRejected,
    rowsUnmatched: input.rowsUnmatched,
    matchRate,
    publishable,
    minimumPublishableMatchRate,
    // Written beside `publishable` so the quarter-hour Data Health job and the projection rails read
    // the same vocabulary. Both signals now agree for every source.
    qualityState: publishable ? "publishable" : "degraded",
    coveredWeeks: input.coveredWeeks.join(","),
    coveredSeasonTypes: input.coveredSeasonTypes.join(","),
  };
}

export function uniqueSeasonWindow(currentSeason: number): readonly number[] {
  if (!Number.isSafeInteger(currentSeason) || currentSeason < 2012 || currentSeason > 2200) {
    throw new RangeError("NFL data season must be between 2012 and 2200");
  }
  // Three completed seasons provide enough rolling folds, rostered-DNP outcomes, and opponent
  // samples for calibrated first-party projections. The current season is included for every
  // newly completed week.
  return [currentSeason - 3, currentSeason - 2, currentSeason - 1, currentSeason];
}

/** Bounded so one artifact refresh cannot fan out an unbounded number of drafts. */
const MAX_ADMITTED_INJURY_OBSERVATIONS = 500;
const MAX_INJURY_DRAFTS_PER_EMIT = 200;

/** The genuinely new rows the ingestion's `onConflictDoNothing().returning(...)` handed back. */
interface AdmittedInjuryObservation {
  readonly playerId: string | null;
  readonly season: number;
  readonly week: number;
  readonly stateKey: string;
  readonly reportStatus: InjuryReportStatus | null;
  readonly practiceStatus: string | null;
  readonly fetchedAt: Date;
}

export class NflverseWeeklyDataRefresher {
  readonly #database: Database;
  readonly #weeklyStatsSource: NflverseWeeklyStatsSource;
  readonly #snapCountsSource: NflverseSnapCountsSource;
  readonly #teamWeeklyStatsSource: NflverseTeamWeeklyStatsSource;
  readonly #weeklyRostersSource: NflverseWeeklyRostersSource;
  readonly #injuriesSource: NflverseInjuriesSource;
  readonly #playByPlaySource: NflversePlayByPlayLoader;
  readonly #now: () => Date;
  /** Absent in an existing fake-database test; emitting is then a stated no-op. */
  readonly #changeEvents: InjuryChangeEventRepository | undefined;
  readonly #onChangeEventError: (error: unknown) => void;

  constructor(input: {
    readonly database: Database;
    readonly weeklyStatsSource?: NflverseWeeklyStatsSource;
    readonly snapCountsSource?: NflverseSnapCountsSource;
    readonly teamWeeklyStatsSource?: NflverseTeamWeeklyStatsSource;
    readonly weeklyRostersSource?: NflverseWeeklyRostersSource;
    readonly injuriesSource?: NflverseInjuriesSource;
    readonly playByPlaySource?: NflversePlayByPlayLoader;
    readonly changeEvents?: InjuryChangeEventRepository;
    readonly onChangeEventError?: (error: unknown) => void;
    readonly now?: () => Date;
  }) {
    this.#database = input.database;
    this.#changeEvents = input.changeEvents;
    this.#onChangeEventError = input.onChangeEventError ?? (() => undefined);
    this.#weeklyStatsSource = input.weeklyStatsSource ?? new NflverseWeeklyStatsSource();
    this.#snapCountsSource = input.snapCountsSource ?? new NflverseSnapCountsSource();
    this.#teamWeeklyStatsSource =
      input.teamWeeklyStatsSource ?? new NflverseTeamWeeklyStatsSource();
    this.#weeklyRostersSource = input.weeklyRostersSource ?? new NflverseWeeklyRostersSource();
    this.#injuriesSource = input.injuriesSource ?? new NflverseInjuriesSource();
    this.#playByPlaySource = input.playByPlaySource ?? new NflversePlayByPlaySource();
    this.#now = input.now ?? (() => new Date());
  }

  async refreshWeeklyStats(
    season: number,
    force = false,
    playByPlay?: NflversePlayByPlayLoader,
  ): Promise<WeeklyDataRefreshResult> {
    const now = this.#now();
    const descriptor = weeklyStatsDescriptor(season, now);
    const source = await claimSource(this.#database, descriptor, force, now);
    if (!source) {
      return {
        sourceKey: descriptor.key,
        state: "not-due",
        rowsRead: 0,
        rowsWritten: 0,
        rowsRejected: 0,
        rowsUnmatched: 0,
        checkedAt: null,
      };
    }
    try {
      const result = await this.#weeklyStatsSource.check(
        season,
        sourceState(source, true),
        playByPlay,
      );
      const checkedAt = new Date(result.checkedAt);
      const nextCheckAt = new Date(checkedAt.getTime() + descriptor.checkIntervalMinutes * 60_000);
      if (result.state === "unchanged") {
        await this.#database
          .update(dataSources)
          .set({
            lastCheckedAt: checkedAt,
            lastSuccessfulAt: checkedAt,
            nextCheckAt,
            etag: result.etag,
            lastModified: result.lastModified,
            lastChecksum: result.checksumSha256,
            consecutiveFailures: 0,
            lastErrorAt: null,
            lastErrorCode: null,
            lastErrorDetail: null,
            metadata: {
              ...source.metadata,
              sourceSchemaVersion,
              playerWeeklyComponentSchema: NFLVERSE_WEEKLY_STATS_COMPONENT_SCHEMA,
              playerWeeklyChecksumSha256: result.playerWeeklyChecksumSha256 ?? null,
              playByPlayChecksumSha256: result.playByPlayChecksumSha256 ?? null,
              playByPlaySourceUrl: result.playByPlaySourceUrl ?? null,
              season,
              license: NFLVERSE_DATA_LICENSE,
              availability: "available",
            },
            updatedAt: checkedAt,
          })
          .where(eq(dataSources.id, source.id));
        return {
          sourceKey: descriptor.key,
          state: "unchanged",
          rowsRead: 0,
          rowsWritten: 0,
          rowsRejected: 0,
          rowsUnmatched: 0,
          checkedAt: result.checkedAt,
        };
      }

      const identityRows = await this.#database
        .select({ id: players.id, externalId: players.gsisId })
        .from(players);
      const identity = new Map(
        identityRows.flatMap((row) =>
          row.externalId ? ([[row.externalId, row.id]] as const) : [],
        ),
      );
      const resolved = result.observations.map((observation) => ({
        observation,
        playerId: identity.get(observation.gsisId) ?? null,
      }));
      const rowsUnmatched = resolved.filter((row) => !row.playerId).length;
      let rowsWritten = 0;
      await this.#database.transaction(async (transaction) => {
        const idempotencyKey = `${descriptor.key}:${result.checksumSha256}:v${sourceSchemaVersion}`;
        const [createdRun] = await transaction
          .insert(syncRuns)
          .values({
            kind: "weekly-stats",
            state: "running",
            idempotencyKey,
            startedAt: now,
            recordsRead: result.rowsRead,
            artifactChecksum: result.checksumSha256,
          })
          .onConflictDoNothing({ target: syncRuns.idempotencyKey })
          .returning({ id: syncRuns.id });
        const [existingRun] = createdRun
          ? [createdRun]
          : await transaction
              .select({ id: syncRuns.id })
              .from(syncRuns)
              .where(eq(syncRuns.idempotencyKey, idempotencyKey))
              .limit(1);
        const sourceSyncRunId = existingRun?.id;
        if (!sourceSyncRunId) {
          throw new Error("nflverse weekly-stats ingestion run could not be established");
        }
        for (let index = 0; index < resolved.length; index += chunkSize) {
          const inserted = await transaction
            .insert(playerWeeklyStatObservations)
            .values(
              resolved.slice(index, index + chunkSize).map(({ observation, playerId }) => ({
                sourceId: source.id,
                sourceSyncRunId,
                externalPlayerId: observation.gsisId,
                playerId,
                season: observation.season,
                week: observation.week,
                seasonType: observation.seasonType,
                gameId: observation.gameId,
                team: observation.team,
                opponentTeam: observation.opponentTeam,
                components: { ...observation.components },
                advanced: { ...observation.advanced },
                sourceFantasyPoints: { ...observation.sourceFantasyPoints },
                fetchedAt: checkedAt,
                inputChecksum: result.checksumSha256,
              })),
            )
            .onConflictDoNothing()
            .returning({ id: playerWeeklyStatObservations.id });
          rowsWritten += inserted.length;
        }
        await transaction
          .update(syncRuns)
          .set({ state: "succeeded", finishedAt: checkedAt, recordsWritten: rowsWritten })
          .where(eq(syncRuns.id, sourceSyncRunId));
        await transaction
          .update(dataSources)
          .set({
            lastCheckedAt: checkedAt,
            lastChangedAt: checkedAt,
            lastSuccessfulAt: checkedAt,
            nextCheckAt,
            etag: result.etag,
            lastModified: result.lastModified,
            lastChecksum: result.checksumSha256,
            consecutiveFailures: 0,
            lastErrorAt: null,
            lastErrorCode: null,
            lastErrorDetail: null,
            metadata: {
              ...datasetMetadata({
                sourceKey: descriptor.key,
                previous: source.metadata,
                season,
                rowsRead: result.rowsRead,
                rowsRejected: result.rowsRejected,
                rowsUnmatched,
                coveredWeeks: result.coveredWeeks,
                coveredSeasonTypes: result.coveredSeasonTypes,
              }),
              playerWeeklyChecksumSha256: result.playerWeeklyChecksumSha256 ?? null,
              playByPlayChecksumSha256: result.playByPlayChecksumSha256 ?? null,
              playByPlaySourceUrl: result.playByPlaySourceUrl ?? null,
            },
            updatedAt: checkedAt,
          })
          .where(eq(dataSources.id, source.id));
      });
      return {
        sourceKey: descriptor.key,
        state: "changed",
        rowsRead: result.rowsRead,
        rowsWritten,
        rowsRejected: result.rowsRejected,
        rowsUnmatched,
        checkedAt: result.checkedAt,
      };
    } catch (error) {
      const failedAt = this.#now();
      if (error instanceof NflverseDatasetSourceError && error.code === "NOT_AVAILABLE") {
        await recordUnavailable(this.#database, source, descriptor, failedAt);
        return resultForUnavailable(descriptor.key, failedAt);
      }
      await recordFailure(this.#database, source, descriptor, failedAt, error);
      throw error;
    }
  }

  async refreshSnapCounts(season: number, force = false): Promise<WeeklyDataRefreshResult> {
    const now = this.#now();
    const descriptor = snapCountsDescriptor(season, now);
    const source = await claimSource(this.#database, descriptor, force, now);
    if (!source) {
      return {
        sourceKey: descriptor.key,
        state: "not-due",
        rowsRead: 0,
        rowsWritten: 0,
        rowsRejected: 0,
        rowsUnmatched: 0,
        checkedAt: null,
      };
    }
    try {
      const result = await this.#snapCountsSource.check(season, sourceState(source));
      const checkedAt = new Date(result.checkedAt);
      const nextCheckAt = new Date(checkedAt.getTime() + descriptor.checkIntervalMinutes * 60_000);
      if (result.state === "unchanged") {
        await this.#database
          .update(dataSources)
          .set({
            lastCheckedAt: checkedAt,
            lastSuccessfulAt: checkedAt,
            nextCheckAt,
            etag: result.etag,
            lastModified: result.lastModified,
            lastChecksum: result.checksumSha256,
            consecutiveFailures: 0,
            lastErrorAt: null,
            lastErrorCode: null,
            lastErrorDetail: null,
            metadata: {
              ...source.metadata,
              sourceSchemaVersion,
              season,
              license: NFLVERSE_DATA_LICENSE,
              availability: "available",
            },
            updatedAt: checkedAt,
          })
          .where(eq(dataSources.id, source.id));
        return {
          sourceKey: descriptor.key,
          state: "unchanged",
          rowsRead: 0,
          rowsWritten: 0,
          rowsRejected: 0,
          rowsUnmatched: 0,
          checkedAt: result.checkedAt,
        };
      }

      const identityRows = await this.#database
        .select({ externalId: playerExternalIds.externalId, playerId: playerExternalIds.playerId })
        .from(playerExternalIds)
        .where(eq(playerExternalIds.source, "pfr"));
      const identity = new Map(identityRows.map((row) => [row.externalId, row.playerId]));
      const resolved = result.observations.map((observation) => ({
        observation,
        playerId: identity.get(observation.pfrPlayerId) ?? null,
      }));
      const rowsUnmatched = resolved.filter((row) => !row.playerId).length;
      let rowsWritten = 0;
      await this.#database.transaction(async (transaction) => {
        const idempotencyKey = `${descriptor.key}:${result.checksumSha256}:v${sourceSchemaVersion}`;
        const [createdRun] = await transaction
          .insert(syncRuns)
          .values({
            kind: "snap-counts",
            state: "running",
            idempotencyKey,
            startedAt: now,
            recordsRead: result.rowsRead,
            artifactChecksum: result.checksumSha256,
          })
          .onConflictDoNothing({ target: syncRuns.idempotencyKey })
          .returning({ id: syncRuns.id });
        const [existingRun] = createdRun
          ? [createdRun]
          : await transaction
              .select({ id: syncRuns.id })
              .from(syncRuns)
              .where(eq(syncRuns.idempotencyKey, idempotencyKey))
              .limit(1);
        const sourceSyncRunId = existingRun?.id;
        if (!sourceSyncRunId) {
          throw new Error("nflverse snap-count ingestion run could not be established");
        }
        for (let index = 0; index < resolved.length; index += chunkSize) {
          const inserted = await transaction
            .insert(playerSnapCountObservations)
            .values(
              resolved.slice(index, index + chunkSize).map(({ observation, playerId }) => ({
                sourceId: source.id,
                sourceSyncRunId,
                externalPlayerId: observation.pfrPlayerId,
                playerId,
                season: observation.season,
                week: observation.week,
                seasonType: observation.seasonType,
                gameType: observation.gameType,
                gameId: observation.gameId,
                pfrGameId: observation.pfrGameId,
                team: observation.team,
                opponentTeam: observation.opponentTeam,
                offenseSnaps: observation.offense.snaps,
                offenseShare: String(observation.offense.share),
                defenseSnaps: observation.defense.snaps,
                defenseShare: String(observation.defense.share),
                specialTeamsSnaps: observation.specialTeams.snaps,
                specialTeamsShare: String(observation.specialTeams.share),
                fetchedAt: checkedAt,
                inputChecksum: result.checksumSha256,
              })),
            )
            .onConflictDoNothing()
            .returning({ id: playerSnapCountObservations.id });
          rowsWritten += inserted.length;
        }
        await transaction
          .update(syncRuns)
          .set({ state: "succeeded", finishedAt: checkedAt, recordsWritten: rowsWritten })
          .where(eq(syncRuns.id, sourceSyncRunId));
        await transaction
          .update(dataSources)
          .set({
            lastCheckedAt: checkedAt,
            lastChangedAt: checkedAt,
            lastSuccessfulAt: checkedAt,
            nextCheckAt,
            etag: result.etag,
            lastModified: result.lastModified,
            lastChecksum: result.checksumSha256,
            consecutiveFailures: 0,
            lastErrorAt: null,
            lastErrorCode: null,
            lastErrorDetail: null,
            metadata: datasetMetadata({
              sourceKey: descriptor.key,
              previous: source.metadata,
              season,
              rowsRead: result.rowsRead,
              rowsRejected: result.rowsRejected,
              rowsUnmatched,
              coveredWeeks: result.coveredWeeks,
              coveredSeasonTypes: result.coveredSeasonTypes,
            }),
            updatedAt: checkedAt,
          })
          .where(eq(dataSources.id, source.id));
      });
      return {
        sourceKey: descriptor.key,
        state: "changed",
        rowsRead: result.rowsRead,
        rowsWritten,
        rowsRejected: result.rowsRejected,
        rowsUnmatched,
        checkedAt: result.checkedAt,
      };
    } catch (error) {
      const failedAt = this.#now();
      if (error instanceof NflverseDatasetSourceError && error.code === "NOT_AVAILABLE") {
        await recordUnavailable(this.#database, source, descriptor, failedAt);
        return resultForUnavailable(descriptor.key, failedAt);
      }
      await recordFailure(this.#database, source, descriptor, failedAt, error);
      throw error;
    }
  }

  async refreshWeeklyRosters(season: number, force = false): Promise<WeeklyDataRefreshResult> {
    const now = this.#now();
    const descriptor = weeklyRostersDescriptor(season, now);
    const source = await claimSource(this.#database, descriptor, force, now);
    if (!source) {
      return {
        sourceKey: descriptor.key,
        state: "not-due",
        rowsRead: 0,
        rowsWritten: 0,
        rowsRejected: 0,
        rowsUnmatched: 0,
        checkedAt: null,
      };
    }
    try {
      // Roster selection binds normalized identity as well as source bytes. A schema migration or
      // explicit repair replays unchanged bytes into a new immutable selection; a normal 304
      // keeps the existing selection checksum rather than replacing it with the raw checksum.
      const replayIdentities =
        force ||
        source.metadata.sourceSchemaVersion !== sourceSchemaVersion ||
        source.metadata.rosterIdentityVersion !== rosterIdentityVersion;
      const result = await this.#weeklyRostersSource.check(season, {
        etag: replayIdentities ? null : source.etag,
        lastModified: replayIdentities ? null : source.lastModified,
        checksumSha256: replayIdentities
          ? null
          : typeof source.metadata.rawRosterChecksum === "string"
            ? source.metadata.rawRosterChecksum
            : null,
      });
      const checkedAt = new Date(result.checkedAt);
      const nextCheckAt = new Date(checkedAt.getTime() + descriptor.checkIntervalMinutes * 60_000);
      if (result.state === "unchanged") {
        await this.#database
          .update(dataSources)
          .set({
            lastCheckedAt: checkedAt,
            lastSuccessfulAt: checkedAt,
            nextCheckAt,
            etag: result.etag,
            lastModified: result.lastModified,
            lastChecksum: source.lastChecksum,
            consecutiveFailures: 0,
            lastErrorAt: null,
            lastErrorCode: null,
            lastErrorDetail: null,
            metadata: {
              ...source.metadata,
              sourceSchemaVersion,
              season,
              license: NFLVERSE_DATA_LICENSE,
              availability: "available",
            },
            updatedAt: checkedAt,
          })
          .where(eq(dataSources.id, source.id));
        return {
          sourceKey: descriptor.key,
          state: "unchanged",
          rowsRead: 0,
          rowsWritten: 0,
          rowsRejected: 0,
          rowsUnmatched: 0,
          checkedAt: result.checkedAt,
        };
      }

      const identity = await resolveNflverseRosterIdentities(
        this.#database,
        result.observations,
        checkedAt,
      );
      const resolved = result.observations.map((observation) => ({
        observation,
        externalPlayerId: weeklyRosterIdentityKey(observation),
        playerId: identity.get(observation) ?? null,
      }));
      const selectionChecksum = createHash("sha256")
        .update(
          JSON.stringify({
            schema: "nflverse-roster-identities-v1",
            rawChecksum: result.checksumSha256,
            identities: resolved.map((row) => [row.externalPlayerId, row.playerId]),
          }),
        )
        .digest("hex");
      const modelEligible = resolved.filter(({ observation }) =>
        fantasyRosterPositions.has(observation.position),
      );
      const rowsUnmatched = modelEligible.filter((row) => !row.playerId).length;
      const matchRate =
        modelEligible.length > 0
          ? (modelEligible.length - rowsUnmatched) / modelEligible.length
          : 0;
      // Rosters override `datasetMetadata`'s rate with a model-eligible denominator so bench
      // long-snappers do not depress it, but they are gated by the same registry threshold.
      const rosterPublishable =
        matchRate >= sourceMatchRateThreshold(descriptor.key).minimumMatchRate;
      let rowsWritten = 0;
      await this.#database.transaction(async (transaction) => {
        const idempotencyKey = `${descriptor.key}:${selectionChecksum}:v${sourceSchemaVersion}`;
        const [createdRun] = await transaction
          .insert(syncRuns)
          .values({
            kind: "weekly-rosters",
            state: "running",
            idempotencyKey,
            startedAt: now,
            recordsRead: result.rowsRead,
            artifactChecksum: selectionChecksum,
          })
          .onConflictDoNothing({ target: syncRuns.idempotencyKey })
          .returning({ id: syncRuns.id });
        const [storedRun] = createdRun
          ? [createdRun]
          : await transaction
              .select({ id: syncRuns.id })
              .from(syncRuns)
              .where(eq(syncRuns.idempotencyKey, idempotencyKey))
              .limit(1);
        if (!storedRun) {
          throw new Error("nflverse weekly-roster ingestion run could not be established");
        }
        for (let index = 0; index < resolved.length; index += chunkSize) {
          const inserted = await transaction
            .insert(playerWeeklyRosterObservations)
            .values(
              resolved
                .slice(index, index + chunkSize)
                .map(({ observation, externalPlayerId, playerId }) => ({
                  sourceId: source.id,
                  sourceSyncRunId: storedRun.id,
                  externalPlayerId,
                  playerId,
                  season: observation.season,
                  week: observation.week,
                  team: observation.team,
                  position: observation.position,
                  rosterStatus: observation.status,
                  statusDescription: observation.statusDescriptionAbbr,
                  fetchedAt: checkedAt,
                  inputChecksum: selectionChecksum,
                })),
            )
            .onConflictDoNothing()
            .returning({ id: playerWeeklyRosterObservations.id });
          rowsWritten += inserted.length;
        }
        await transaction
          .update(syncRuns)
          .set({ state: "succeeded", finishedAt: checkedAt, recordsWritten: rowsWritten })
          .where(eq(syncRuns.id, storedRun.id));
        await transaction
          .update(dataSources)
          .set({
            lastCheckedAt: checkedAt,
            lastChangedAt: checkedAt,
            lastSuccessfulAt: checkedAt,
            nextCheckAt,
            etag: result.etag,
            lastModified: result.lastModified,
            lastChecksum: selectionChecksum,
            consecutiveFailures: 0,
            lastErrorAt: null,
            lastErrorCode: null,
            lastErrorDetail: null,
            metadata: {
              ...datasetMetadata({
                sourceKey: descriptor.key,
                previous: source.metadata,
                season,
                rowsRead: result.rowsRead,
                rowsRejected: result.rowsRejected,
                rowsUnmatched,
                coveredWeeks: result.coveredWeeks,
                coveredSeasonTypes: result.coveredSeasonTypes,
              }),
              matchRate,
              rosterIdentityVersion,
              rawRosterChecksum: result.checksumSha256,
              matchDenominator: modelEligible.length,
              publishable: rosterPublishable,
              qualityState: rosterPublishable ? "publishable" : "degraded",
            },
            updatedAt: checkedAt,
          })
          .where(eq(dataSources.id, source.id));
      });
      return {
        sourceKey: descriptor.key,
        state: "changed",
        rowsRead: result.rowsRead,
        rowsWritten,
        rowsRejected: result.rowsRejected,
        rowsUnmatched,
        checkedAt: result.checkedAt,
      };
    } catch (error) {
      const failedAt = this.#now();
      if (error instanceof NflverseDatasetSourceError && error.code === "NOT_AVAILABLE") {
        await recordUnavailable(this.#database, source, descriptor, failedAt);
        return resultForUnavailable(descriptor.key, failedAt);
      }
      await recordFailure(this.#database, source, descriptor, failedAt, error);
      throw error;
    }
  }

  async refreshInjuries(season: number, force = false): Promise<WeeklyDataRefreshResult> {
    const now = this.#now();
    const descriptor = injuriesDescriptor(season, now);
    const source = await claimSource(this.#database, descriptor, force, now);
    if (!source) {
      return {
        sourceKey: descriptor.key,
        state: "not-due",
        rowsRead: 0,
        rowsWritten: 0,
        rowsRejected: 0,
        rowsUnmatched: 0,
        checkedAt: null,
      };
    }
    try {
      const result = await this.#injuriesSource.check(season, sourceState(source));
      const checkedAt = new Date(result.checkedAt);
      const nextCheckAt = new Date(checkedAt.getTime() + descriptor.checkIntervalMinutes * 60_000);
      if (result.state === "unchanged") {
        await this.#database
          .update(dataSources)
          .set({
            lastCheckedAt: checkedAt,
            lastSuccessfulAt: checkedAt,
            nextCheckAt,
            etag: result.etag,
            lastModified: result.lastModified,
            lastChecksum: result.checksumSha256,
            consecutiveFailures: 0,
            lastErrorAt: null,
            lastErrorCode: null,
            lastErrorDetail: null,
            metadata: {
              ...source.metadata,
              sourceSchemaVersion,
              season,
              license: NFLVERSE_DATA_LICENSE,
              availability: "available",
            },
            updatedAt: checkedAt,
          })
          .where(eq(dataSources.id, source.id));
        return {
          sourceKey: descriptor.key,
          state: "unchanged",
          rowsRead: 0,
          rowsWritten: 0,
          rowsRejected: 0,
          rowsUnmatched: 0,
          checkedAt: result.checkedAt,
        };
      }

      const identityRows = await this.#database
        .select({ id: players.id, externalId: players.gsisId, fullName: players.fullName })
        .from(players);
      const identity = new Map(
        identityRows.flatMap((row) =>
          row.externalId ? ([[row.externalId, row.id]] as const) : [],
        ),
      );
      const playerNames = new Map(identityRows.map((row) => [row.id, row.fullName] as const));
      const resolved = result.observations.map((observation) => ({
        observation,
        playerId: identity.get(observation.gsisId) ?? null,
      }));
      const rowsUnmatched = resolved.filter((row) => !row.playerId).length;
      let rowsWritten = 0;
      // Collected across chunks so the change-event emit below reacts to genuinely new rows only.
      const admitted: AdmittedInjuryObservation[] = [];
      let admittedRunId: string | null = null;
      await this.#database.transaction(async (transaction) => {
        const idempotencyKey = `${descriptor.key}:${result.checksumSha256}:v${sourceSchemaVersion}`;
        const [createdRun] = await transaction
          .insert(syncRuns)
          .values({
            kind: "injury-reports",
            state: "running",
            idempotencyKey,
            startedAt: now,
            recordsRead: result.rowsRead,
            artifactChecksum: result.checksumSha256,
          })
          .onConflictDoNothing({ target: syncRuns.idempotencyKey })
          .returning({ id: syncRuns.id });
        const [storedRun] = createdRun
          ? [createdRun]
          : await transaction
              .select({ id: syncRuns.id })
              .from(syncRuns)
              .where(eq(syncRuns.idempotencyKey, idempotencyKey))
              .limit(1);
        if (!storedRun) {
          throw new Error("nflverse injury-report ingestion run could not be established");
        }
        for (let index = 0; index < resolved.length; index += chunkSize) {
          const inserted = await transaction
            .insert(playerInjuryReportObservations)
            .values(
              resolved.slice(index, index + chunkSize).map(({ observation, playerId }) => ({
                sourceId: source.id,
                sourceSyncRunId: storedRun.id,
                externalPlayerId: observation.gsisId,
                playerId,
                season: observation.season,
                week: observation.week,
                seasonType: observation.seasonType,
                gameType: observation.gameType,
                team: observation.team,
                position: observation.position,
                reportPrimaryInjury: observation.report.primaryInjury,
                reportSecondaryInjury: observation.report.secondaryInjury,
                reportStatus: observation.report.status,
                practicePrimaryInjury: observation.practice.primaryInjury,
                practiceSecondaryInjury: observation.practice.secondaryInjury,
                practiceStatus: observation.practice.status,
                sourceModifiedAt:
                  observation.dateModified === null ? null : new Date(observation.dateModified),
                stateKey: injuryReportStateKey(observation),
                fetchedAt: checkedAt,
                inputChecksum: result.checksumSha256,
              })),
            )
            .onConflictDoNothing()
            .returning({
              playerId: playerInjuryReportObservations.playerId,
              season: playerInjuryReportObservations.season,
              week: playerInjuryReportObservations.week,
              stateKey: playerInjuryReportObservations.stateKey,
              reportStatus: playerInjuryReportObservations.reportStatus,
              practiceStatus: playerInjuryReportObservations.practiceStatus,
              fetchedAt: playerInjuryReportObservations.fetchedAt,
            });
          rowsWritten += inserted.length;
          for (const row of inserted) {
            if (admitted.length >= MAX_ADMITTED_INJURY_OBSERVATIONS) break;
            admitted.push(row as AdmittedInjuryObservation);
          }
        }
        admittedRunId = storedRun.id;
        await transaction
          .update(syncRuns)
          .set({ state: "succeeded", finishedAt: checkedAt, recordsWritten: rowsWritten })
          .where(eq(syncRuns.id, storedRun.id));
        await transaction
          .update(dataSources)
          .set({
            lastCheckedAt: checkedAt,
            lastChangedAt: checkedAt,
            lastSuccessfulAt: checkedAt,
            nextCheckAt,
            etag: result.etag,
            lastModified: result.lastModified,
            lastChecksum: result.checksumSha256,
            consecutiveFailures: 0,
            lastErrorAt: null,
            lastErrorCode: null,
            lastErrorDetail: null,
            metadata: datasetMetadata({
              sourceKey: descriptor.key,
              previous: source.metadata,
              season,
              rowsRead: result.rowsRead,
              rowsRejected: result.rowsRejected,
              rowsUnmatched,
              coveredWeeks: result.coveredWeeks,
              coveredSeasonTypes: result.coveredSeasonTypes,
            }),
            updatedAt: checkedAt,
          })
          .where(eq(dataSources.id, source.id));
      });
      // Deliberately outside the ingestion transaction: a change-event failure must never roll back
      // admitted observations.
      await this.#emitInjuryChangeEvents(admitted, admittedRunId, playerNames, checkedAt);
      return {
        sourceKey: descriptor.key,
        state: "changed",
        rowsRead: result.rowsRead,
        rowsWritten,
        rowsRejected: result.rowsRejected,
        rowsUnmatched,
        checkedAt: result.checkedAt,
      };
    } catch (error) {
      const failedAt = this.#now();
      if (error instanceof NflverseDatasetSourceError && error.code === "NOT_AVAILABLE") {
        await recordUnavailable(this.#database, source, descriptor, failedAt);
        return resultForUnavailable(descriptor.key, failedAt);
      }
      await recordFailure(this.#database, source, descriptor, failedAt, error);
      throw error;
    }
  }

  /**
   * One private change event per rostering member for each genuinely new injury state. Failures are
   * logged-and-swallowed by the caller's contract: the observations are already admitted, and an
   * observability surface must not undo an ingestion.
   */
  async #emitInjuryChangeEvents(
    admitted: readonly AdmittedInjuryObservation[],
    syncRunId: string | null,
    playerNames: ReadonlyMap<string, string>,
    now: Date,
  ): Promise<void> {
    if (!this.#changeEvents || admitted.length === 0 || syncRunId === null) return;
    try {
      const byWeek = new Map<string, AdmittedInjuryObservation[]>();
      for (const row of admitted) {
        if (row.playerId === null) continue;
        const key = `${row.season}:${row.week}`;
        byWeek.set(key, [...(byWeek.get(key) ?? []), row]);
      }
      for (const rows of byWeek.values()) {
        const first = rows[0];
        if (!first) continue;
        const playerIds = [...new Set(rows.flatMap((row) => (row.playerId ? [row.playerId] : [])))];
        const rosteringByPlayer = await this.#changeEvents.listRosteringMembers(playerIds);
        if (rosteringByPlayer.size === 0) continue;
        const priorStateKeyByPlayerWeek = new Map(
          [
            ...(await this.#changeEvents.listPriorStateKeys(
              playerIds,
              first.season,
              first.week,
              syncRunId,
            )),
          ].map(([playerId, stateKey]) => [
            playerWeekKey(playerId, first.season, first.week),
            stateKey,
          ]),
        );
        const drafts = buildInjuryChangeDrafts({
          observations: rows.map((row) => ({
            playerId: row.playerId,
            playerName: (row.playerId && playerNames.get(row.playerId)) || "Unknown player",
            season: row.season,
            week: row.week,
            stateKey: row.stateKey,
            reportStatus: row.reportStatus,
            practiceStatus: row.practiceStatus,
            fetchedAt: row.fetchedAt,
          })),
          priorStateKeyByPlayerWeek,
          rosteringByPlayer,
        });
        for (let index = 0; index < drafts.length; index += MAX_INJURY_DRAFTS_PER_EMIT) {
          await emitChangeEvents(
            this.#database,
            drafts.slice(index, index + MAX_INJURY_DRAFTS_PER_EMIT),
            now,
          );
        }
      }
    } catch (error) {
      this.#onChangeEventError(error);
    }
  }

  async refreshTeamWeeklyStats(
    season: number,
    force = false,
    playByPlay?: NflversePlayByPlayLoader,
  ): Promise<WeeklyDataRefreshResult> {
    const now = this.#now();
    const descriptor = teamWeeklyStatsDescriptor(season, now);
    const source = await claimSource(this.#database, descriptor, force, now);
    if (!source) {
      return {
        sourceKey: descriptor.key,
        state: "not-due",
        rowsRead: 0,
        rowsWritten: 0,
        rowsRejected: 0,
        rowsUnmatched: 0,
        checkedAt: null,
      };
    }
    try {
      const result = await this.#teamWeeklyStatsSource.check(
        season,
        sourceState(source, false, true),
        playByPlay,
      );
      const checkedAt = new Date(result.checkedAt);
      const nextCheckAt = new Date(checkedAt.getTime() + descriptor.checkIntervalMinutes * 60_000);
      if (result.state === "unchanged") {
        await this.#database
          .update(dataSources)
          .set({
            lastCheckedAt: checkedAt,
            lastSuccessfulAt: checkedAt,
            nextCheckAt,
            etag: result.etag,
            lastModified: result.lastModified,
            lastChecksum: result.checksumSha256,
            consecutiveFailures: 0,
            lastErrorAt: null,
            lastErrorCode: null,
            lastErrorDetail: null,
            metadata: {
              ...source.metadata,
              sourceSchemaVersion,
              teamWeeklyComponentSchema: NFLVERSE_TEAM_WEEKLY_STATS_COMPONENT_SCHEMA,
              teamWeeklyScoringEventsVersion: result.defenseScoringEventsVersion,
              teamWeeklyChecksumSha256: result.teamWeeklyChecksumSha256,
              season,
              license: NFLVERSE_DATA_LICENSE,
              availability: "available",
            },
            updatedAt: checkedAt,
          })
          .where(eq(dataSources.id, source.id));
        return {
          sourceKey: descriptor.key,
          state: "unchanged",
          rowsRead: 0,
          rowsWritten: 0,
          rowsRejected: 0,
          rowsUnmatched: 0,
          checkedAt: result.checkedAt,
        };
      }

      let rowsWritten = 0;
      await this.#database.transaction(async (transaction) => {
        const idempotencyKey = `${descriptor.key}:${result.checksumSha256}:v${sourceSchemaVersion}`;
        const [createdRun] = await transaction
          .insert(syncRuns)
          .values({
            kind: "weekly-team-stats",
            state: "running",
            idempotencyKey,
            startedAt: now,
            recordsRead: result.rowsRead,
            artifactChecksum: result.checksumSha256,
          })
          .onConflictDoNothing({ target: syncRuns.idempotencyKey })
          .returning({ id: syncRuns.id });
        const [storedRun] = createdRun
          ? [createdRun]
          : await transaction
              .select({ id: syncRuns.id })
              .from(syncRuns)
              .where(eq(syncRuns.idempotencyKey, idempotencyKey))
              .limit(1);
        if (!storedRun) {
          throw new Error("nflverse weekly-team-stats ingestion run could not be established");
        }
        for (let index = 0; index < result.observations.length; index += chunkSize) {
          const inserted = await transaction
            .insert(teamWeeklyStatObservations)
            .values(
              result.observations.slice(index, index + chunkSize).map((observation) => ({
                sourceId: source.id,
                sourceSyncRunId: storedRun.id,
                externalTeamId: observation.team,
                season: observation.season,
                week: observation.week,
                seasonType: observation.seasonType,
                gameId: observation.gameId,
                team: observation.team,
                opponentTeam: observation.opponentTeam,
                components: {
                  ...observation.components,
                  advanced_passing_epa: observation.advanced.passing_epa,
                  advanced_passing_cpoe: observation.advanced.passing_cpoe ?? 0,
                  advanced_rushing_epa: observation.advanced.rushing_epa,
                  advanced_receiving_epa: observation.advanced.receiving_epa,
                },
                fetchedAt: checkedAt,
                inputChecksum: result.checksumSha256,
              })),
            )
            .onConflictDoNothing()
            .returning({ id: teamWeeklyStatObservations.id });
          rowsWritten += inserted.length;
        }
        await transaction
          .update(syncRuns)
          .set({ state: "succeeded", finishedAt: checkedAt, recordsWritten: rowsWritten })
          .where(eq(syncRuns.id, storedRun.id));
        await transaction
          .update(dataSources)
          .set({
            lastCheckedAt: checkedAt,
            lastChangedAt: checkedAt,
            lastSuccessfulAt: checkedAt,
            nextCheckAt,
            etag: result.etag,
            lastModified: result.lastModified,
            lastChecksum: result.checksumSha256,
            consecutiveFailures: 0,
            lastErrorAt: null,
            lastErrorCode: null,
            lastErrorDetail: null,
            metadata: {
              ...datasetMetadata({
                sourceKey: descriptor.key,
                previous: source.metadata,
                season,
                rowsRead: result.rowsRead,
                rowsRejected: result.rowsRejected,
                rowsUnmatched: 0,
                coveredWeeks: result.coveredWeeks,
                coveredSeasonTypes: result.coveredSeasonTypes,
              }),
              teamWeeklyChecksumSha256: result.teamWeeklyChecksumSha256,
              teamWeeklyScoringEventsVersion: result.defenseScoringEventsVersion,
              playByPlaySourceUrl: result.playByPlaySourceUrl,
              playByPlayChecksumSha256: result.playByPlayChecksumSha256,
            },
            updatedAt: checkedAt,
          })
          .where(eq(dataSources.id, source.id));
      });
      return {
        sourceKey: descriptor.key,
        state: "changed",
        rowsRead: result.rowsRead,
        rowsWritten,
        rowsRejected: result.rowsRejected,
        rowsUnmatched: 0,
        checkedAt: result.checkedAt,
      };
    } catch (error) {
      const failedAt = this.#now();
      if (error instanceof NflverseDatasetSourceError && error.code === "NOT_AVAILABLE") {
        await recordUnavailable(this.#database, source, descriptor, failedAt);
        return resultForUnavailable(descriptor.key, failedAt);
      }
      await recordFailure(this.#database, source, descriptor, failedAt, error);
      throw error;
    }
  }

  /** Keep player events and D/ST on one PBP capture, including independently due archives. */
  async refreshWeeklyStatsPair(
    season: number,
    force = false,
  ): Promise<{
    readonly weeklyStats: WeeklyDataRefreshResult;
    readonly teamWeeklyStats: WeeklyDataRefreshResult;
  }> {
    const playByPlay = snapshotNflversePlayByPlay(this.#playByPlaySource, season);
    const attempts = await Promise.allSettled([
      this.refreshWeeklyStats(season, force, playByPlay),
      this.refreshTeamWeeklyStats(season, force, playByPlay),
    ]);
    const failed = attempts.filter((attempt) => attempt.status === "rejected");
    if (failed.length > 0)
      throw new AggregateError(
        failed.map((attempt) => attempt.reason as unknown),
        `${failed.length} nflverse paired weekly dataset refreshes failed`,
      );
    const playerAttempt = attempts[0];
    const teamAttempt = attempts[1];
    if (playerAttempt.status !== "fulfilled" || teamAttempt.status !== "fulfilled")
      throw new Error("Paired weekly refresh did not complete");
    let weeklyStats = playerAttempt.value;
    let teamWeeklyStats = teamAttempt.value;
    const keys = [`nflverse.stats-player-week.${season}`, `nflverse.stats-team-week.${season}`];
    const mismatch = async () => {
      const sources = await this.#database
        .select({ key: dataSources.key, metadata: dataSources.metadata })
        .from(dataSources)
        .where(inArray(dataSources.key, keys));
      const player = sources.find((source) => source.key === keys[0]);
      const team = sources.find((source) => source.key === keys[1]);
      // Missing/not-published datasets keep their normal unavailable state and retry clock.
      if (
        player?.metadata.availability !== "available" ||
        team?.metadata.availability !== "available"
      )
        return false;
      return (
        !hasPlayByPlayCapture(player.metadata) ||
        !hasPlayByPlayCapture(team.metadata) ||
        player.metadata.playByPlayChecksumSha256 !== team.metadata.playByPlayChecksumSha256
      );
    };
    if (await mismatch()) {
      const playerChecked = weeklyStats.state === "changed" || weeklyStats.state === "unchanged";
      const teamChecked =
        teamWeeklyStats.state === "changed" || teamWeeklyStats.state === "unchanged";
      // Usually one independent source clock skipped its counterpart. If neither refreshed,
      // recover a pre-existing archived mismatch once, using this same lazy snapshot.
      if (!playerChecked || teamChecked)
        weeklyStats = await this.refreshWeeklyStats(season, true, playByPlay);
      if (!teamChecked || playerChecked)
        teamWeeklyStats = await this.refreshTeamWeeklyStats(season, true, playByPlay);
      if (await mismatch())
        throw new NflverseDatasetSourceError(
          "UPSTREAM",
          "nflverse player and team PBP captures remain inconsistent; a source may still be refreshing. Retry is required.",
          true,
        );
    }
    return { weeklyStats, teamWeeklyStats };
  }

  async refreshCurrentWindow(
    currentSeason: number,
    force = false,
  ): Promise<Readonly<Record<string, WeeklyDataRefreshResult>>> {
    const results: Record<string, WeeklyDataRefreshResult> = {};
    const errors: unknown[] = [];
    for (const season of uniqueSeasonWindow(currentSeason)) {
      try {
        const paired = await this.refreshWeeklyStatsPair(season, force);
        results[`weeklyStats${season}`] = paired.weeklyStats;
        results[`teamWeeklyStats${season}`] = paired.teamWeeklyStats;
      } catch (error) {
        errors.push(error);
      }
      for (const [label, refresh] of [
        [`snapCounts${season}`, () => this.refreshSnapCounts(season, force)],
        [`weeklyRosters${season}`, () => this.refreshWeeklyRosters(season, force)],
        [`injuries${season}`, () => this.refreshInjuries(season, force)],
      ] as const) {
        try {
          results[label] = await refresh();
        } catch (error) {
          errors.push(error);
        }
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, `${errors.length} nflverse weekly dataset refreshes failed`);
    }
    return results;
  }
}

export function weeklyStatsIdentityKey(observation: NflversePlayerWeeklyStats): string {
  return observation.gsisId;
}

export function snapCountsIdentityKey(observation: NflversePlayerSnapCount): string {
  return observation.pfrPlayerId;
}

export function weeklyRosterIdentityKey(observation: NflverseWeeklyRosterPlayer): string {
  const identity = weeklyRostersIdentityKey(observation);
  if (!identity) throw new TypeError("Weekly roster observation requires a stable player identity");
  return identity;
}

export function injuryReportStateKey(observation: NflversePlayerInjuryReport): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        observation.report.primaryInjury,
        observation.report.secondaryInjury,
        observation.report.status,
        observation.practice.primaryInjury,
        observation.practice.secondaryInjury,
        observation.practice.status,
        observation.dateModified,
      ]),
      "utf8",
    )
    .digest("hex");
}
