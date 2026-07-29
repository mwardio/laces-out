import {
  adpObservations,
  dataSources,
  playerExternalIds,
  players,
  syncRuns,
  type AdpScoringFormat,
  type Database,
  type JsonPrimitive,
} from "@fantasy/db";
import { sourceMatchRateThreshold } from "@fantasy/domain";
import {
  FFC_ADP_DOCUMENTATION_URL,
  FFC_ATTRIBUTION,
  FFC_ATTRIBUTION_URL,
  FfcAdpSource,
  buildFfcAdpUrl,
  type FfcAdpContext,
  type FfcAdpPlayer,
  type FfcScoringFormat,
} from "@fantasy/source-ffc";
import { and, eq, lte, sql } from "drizzle-orm";

const checkIntervalMinutes = 24 * 60;
const claimMinutes = 30;
const chunkSize = 500;
const sourceSchemaVersion = 2;

export interface FfcAdpRefreshResult {
  readonly sourceKey: string;
  readonly state: "changed" | "unchanged" | "not-due";
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

function databaseScoringFormat(format: FfcScoringFormat): AdpScoringFormat {
  switch (format) {
    case "standard":
    case "half-ppr":
    case "ppr":
      return format;
    case "2qb":
    case "dynasty":
    case "rookie":
      throw new Error(`FFC ${format} is not a comparable redraft scoring format`);
  }
}

function internalPosition(position: FfcAdpPlayer["position"]): string {
  if (position === "DEF") return "DST";
  if (position === "PK") return "K";
  return position;
}

/** Exported so a test can prove every admitted context resolves a registered threshold. */
export function ffcAdpSourceKey(context: FfcAdpContext): string {
  const position = context.position ? `.${context.position.toLowerCase()}` : "";
  return `ffc.adp.${context.season}.${context.scoringFormat}.${context.teams}${position}`;
}

export function defaultFfcAdpContexts(season: number): readonly FfcAdpContext[] {
  if (!Number.isSafeInteger(season) || season < 2007 || season > 2200) {
    throw new RangeError("FFC ADP season must be between 2007 and 2200");
  }
  return (["standard", "half-ppr", "ppr"] as const).flatMap((scoringFormat) =>
    ([8, 10, 12, 14] as const).map((teams) => ({
      season,
      teams,
      scoringFormat,
      position: null,
    })),
  );
}

async function claimSource(
  database: Database,
  context: FfcAdpContext,
  force: boolean,
  now: Date,
): Promise<SourceRow | null> {
  const key = ffcAdpSourceKey(context);
  const [source] = await database
    .insert(dataSources)
    .values({
      key,
      name: `Fantasy Football Calculator ${context.teams}-team ${context.scoringFormat.toUpperCase()} ADP`,
      kind: "adp",
      sourceUrl: buildFfcAdpUrl(context).toString(),
      attribution: FFC_ATTRIBUTION,
      attributionUrl: FFC_ATTRIBUTION_URL,
      checkIntervalMinutes,
      nextCheckAt: now,
      metadata: {
        sourceSchemaVersion,
        documentationUrl: FFC_ADP_DOCUMENTATION_URL,
        season: context.season,
        teams: context.teams,
        scoringFormat: context.scoringFormat,
        position: context.position,
      },
    })
    .onConflictDoUpdate({
      target: dataSources.key,
      set: {
        name: `Fantasy Football Calculator ${context.teams}-team ${context.scoringFormat.toUpperCase()} ADP`,
        kind: "adp",
        sourceUrl: buildFfcAdpUrl(context).toString(),
        attribution: FFC_ATTRIBUTION,
        attributionUrl: FFC_ATTRIBUTION_URL,
        checkIntervalMinutes,
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
  const claim = await database
    .update(dataSources)
    .set({
      nextCheckAt: new Date(now.getTime() + claimMinutes * 60_000),
      updatedAt: now,
    })
    .where(
      force
        ? eq(dataSources.id, source.id)
        : and(eq(dataSources.id, source.id), lte(dataSources.nextCheckAt, now)),
    )
    .returning({ id: dataSources.id });
  return claim.length === 1 ? source : null;
}

async function recordFailure(
  database: Database,
  source: SourceRow,
  failedAt: Date,
  error: unknown,
): Promise<void> {
  const retryMinutes = Math.min(
    checkIntervalMinutes,
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
        error instanceof Error ? error.message.slice(0, 256) : "FFC ADP refresh failed",
      updatedAt: failedAt,
    })
    .where(eq(dataSources.id, source.id));
}

function identityKey(name: string, position: string, team?: string): string {
  const normalizedName = name.normalize("NFKC").trim().toLocaleLowerCase("en-US");
  return `${normalizedName}|${position.trim().toUpperCase()}|${team?.trim().toUpperCase() ?? ""}`;
}

export function buildUniqueFfcIdentity(
  rows: readonly {
    readonly id: string;
    readonly fullName: string;
    readonly primaryPosition: string;
    readonly nflTeam: string | null;
  }[],
): {
  readonly teamAware: ReadonlyMap<string, string>;
  readonly namePosition: ReadonlyMap<string, string>;
} {
  function uniqueMap(keys: (row: (typeof rows)[number]) => readonly string[]) {
    const candidates = new Map<string, string | null>();
    for (const row of rows) {
      for (const key of keys(row)) {
        const existing = candidates.get(key);
        candidates.set(key, existing === undefined || existing === row.id ? row.id : null);
      }
    }
    return new Map([...candidates].flatMap(([key, id]) => (id ? ([[key, id]] as const) : [])));
  }
  return {
    teamAware: uniqueMap((row) =>
      row.nflTeam ? [identityKey(row.fullName, row.primaryPosition, row.nflTeam)] : [],
    ),
    namePosition: uniqueMap((row) => [identityKey(row.fullName, row.primaryPosition)]),
  };
}

async function identityMaps(database: Database) {
  const [canonicalRows, ffcRows] = await Promise.all([
    database
      .select({
        id: players.id,
        fullName: players.fullName,
        primaryPosition: players.primaryPosition,
        nflTeam: players.nflTeam,
      })
      .from(players),
    database
      .select({ externalId: playerExternalIds.externalId, playerId: playerExternalIds.playerId })
      .from(playerExternalIds)
      .where(eq(playerExternalIds.source, "ffc")),
  ]);
  return {
    external: new Map(ffcRows.map((row) => [row.externalId, row.playerId])),
    ...buildUniqueFfcIdentity(canonicalRows),
  };
}

function resolvePlayer(
  identity: Awaited<ReturnType<typeof identityMaps>>,
  player: FfcAdpPlayer,
): { readonly playerId: string | null; readonly confidence: string } {
  const external = identity.external.get(player.ffcPlayerId);
  if (external) return { playerId: external, confidence: "0.9500" };
  const position = internalPosition(player.position);
  const teamAware = identity.teamAware.get(identityKey(player.name, position, player.nflTeam));
  if (teamAware) return { playerId: teamAware, confidence: "0.8500" };
  return {
    playerId: identity.namePosition.get(identityKey(player.name, position)) ?? null,
    confidence: "0.7500",
  };
}

function metadataDate(metadata: Record<string, JsonPrimitive>): string | null {
  const value = metadata.asOfDate;
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value) ? value : null;
}

export class FfcAdpRefresher {
  readonly #database: Database;
  readonly #source: FfcAdpSource;
  readonly #now: () => Date;

  constructor(input: {
    readonly database: Database;
    readonly source?: FfcAdpSource;
    readonly now?: () => Date;
  }) {
    this.#database = input.database;
    this.#source = input.source ?? new FfcAdpSource();
    this.#now = input.now ?? (() => new Date());
  }

  async refresh(context: FfcAdpContext, force = false): Promise<FfcAdpRefreshResult> {
    const key = ffcAdpSourceKey(context);
    const now = this.#now();
    const source = await claimSource(this.#database, context, force, now);
    if (!source) {
      return {
        sourceKey: key,
        state: "not-due",
        rowsRead: 0,
        rowsWritten: 0,
        rowsRejected: 0,
        rowsUnmatched: 0,
        checkedAt: null,
      };
    }
    try {
      const requiresReplay = source.metadata.sourceSchemaVersion !== sourceSchemaVersion;
      const result = await this.#source.check(context, {
        etag: requiresReplay ? null : source.etag,
        lastModified: requiresReplay ? null : source.lastModified,
        checksumSha256: requiresReplay ? null : source.lastChecksum,
        asOfDate: requiresReplay ? null : metadataDate(source.metadata),
      });
      const fetchedAt = new Date(result.fetchedAt);
      const nextCheckAt = new Date(fetchedAt.getTime() + checkIntervalMinutes * 60_000);
      if (result.state === "unchanged") {
        await this.#database
          .update(dataSources)
          .set({
            lastCheckedAt: fetchedAt,
            lastSuccessfulAt: fetchedAt,
            nextCheckAt,
            etag: result.etag,
            lastModified: result.lastModified,
            lastChecksum: result.checksumSha256,
            consecutiveFailures: 0,
            lastErrorAt: null,
            lastErrorCode: null,
            lastErrorDetail: null,
            updatedAt: fetchedAt,
          })
          .where(eq(dataSources.id, source.id));
        return {
          sourceKey: key,
          state: "unchanged",
          rowsRead: 0,
          rowsWritten: 0,
          rowsRejected: 0,
          rowsUnmatched: 0,
          checkedAt: result.fetchedAt,
        };
      }

      const scoringFormat = databaseScoringFormat(context.scoringFormat);
      const identity = await identityMaps(this.#database);
      const ordered = [...result.players].sort(
        (left, right) => left.adp - right.adp || left.ffcPlayerId.localeCompare(right.ffcPlayerId),
      );
      const positionRanks = new Map<string, number>();
      const resolved = ordered.map((player, index) => {
        const position = internalPosition(player.position);
        const positionRank = (positionRanks.get(position) ?? 0) + 1;
        positionRanks.set(position, positionRank);
        return {
          player,
          position,
          positionRank,
          sourceRank: index + 1,
          ...resolvePlayer(identity, player),
        };
      });
      const sourceAsOf = new Date(`${result.asOfDate}T00:00:00.000Z`);
      const rowsUnmatched = resolved.filter((row) => !row.playerId).length;
      const matchRate =
        result.rowsRead > 0 ? (result.rowsRead - rowsUnmatched) / result.rowsRead : 0;
      // The stored key name stays `minimumPublishableMatchRate` because it is part of the persisted
      // artifact that `apps/api/src/admitted-source.ts` and the Data Health job already read.
      const { minimumMatchRate: minimumPublishableMatchRate } = sourceMatchRateThreshold(key);
      const publishable = matchRate >= minimumPublishableMatchRate;
      let rowsWritten = 0;
      await this.#database.transaction(async (transaction) => {
        const idempotencyKey = `${key}:${result.checksumSha256}:v${sourceSchemaVersion}`;
        const [createdRun] = await transaction
          .insert(syncRuns)
          .values({
            kind: "adp",
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
        if (!sourceSyncRunId) throw new Error("FFC ADP ingestion run could not be established");
        for (let index = 0; index < resolved.length; index += chunkSize) {
          const batch = resolved.slice(index, index + chunkSize);
          const inserted = await transaction
            .insert(adpObservations)
            .values(
              batch.map(({ player, playerId, position, positionRank, sourceRank }) => ({
                sourceId: source.id,
                sourceSyncRunId,
                externalPlayerId: player.ffcPlayerId,
                playerId,
                season: context.season,
                scoringFormat,
                teamCount: context.teams,
                rosterFormat: "one-qb" as const,
                positionFilter: context.position ? internalPosition(context.position) : null,
                overallAdp: String(player.adp),
                sourceRank,
                positionRank,
                standardDeviation: String(player.standardDeviation),
                sampleSize: player.timesDrafted,
                sourceAsOf,
                fetchedAt,
                inputChecksum: result.checksumSha256,
                context: {
                  sourceScoringFormat: context.scoringFormat,
                  rounds: result.rounds,
                  totalDrafts: result.totalDrafts,
                  windowStartDate: result.windowStartDate,
                  adpFormatted: player.adpFormatted,
                  highPick: player.highPick,
                  lowPick: player.lowPick,
                  byeWeek: player.byeWeek,
                  position,
                },
              })),
            )
            .onConflictDoNothing()
            .returning({ id: adpObservations.id });
          rowsWritten += inserted.length;
        }
        const aliases = resolved.flatMap(({ player, playerId, confidence }) =>
          playerId
            ? [
                {
                  playerId,
                  source: "ffc",
                  externalId: player.ffcPlayerId,
                  season: context.season,
                  confidence,
                  verified: false,
                },
              ]
            : [],
        );
        for (let index = 0; index < aliases.length; index += chunkSize) {
          await transaction
            .insert(playerExternalIds)
            .values(aliases.slice(index, index + chunkSize))
            .onConflictDoUpdate({
              target: [playerExternalIds.source, playerExternalIds.externalId],
              set: {
                playerId: sql`excluded.player_id`,
                season: context.season,
                confidence: sql`excluded.confidence`,
                verified: false,
              },
            });
        }
        await transaction
          .update(syncRuns)
          .set({ state: "succeeded", finishedAt: fetchedAt, recordsWritten: rowsWritten })
          .where(eq(syncRuns.id, sourceSyncRunId));
        await transaction
          .update(dataSources)
          .set({
            lastCheckedAt: fetchedAt,
            lastChangedAt: fetchedAt,
            lastSuccessfulAt: fetchedAt,
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
              asOfDate: result.asOfDate,
              windowStartDate: result.windowStartDate,
              rounds: result.rounds,
              totalDrafts: result.totalDrafts,
              rowsRead: result.rowsRead,
              rowsRejected: result.rowsRejected,
              rowsUnmatched,
              matchRate,
              publishable,
              minimumPublishableMatchRate,
              // Written beside `publishable` so the quarter-hour Data Health job and the projection
              // rails read the same vocabulary. Both signals now agree for every source.
              qualityState: publishable ? "publishable" : "degraded",
            },
            updatedAt: fetchedAt,
          })
          .where(eq(dataSources.id, source.id));
      });
      return {
        sourceKey: key,
        state: "changed",
        rowsRead: result.rowsRead,
        rowsWritten,
        rowsRejected: result.rowsRejected,
        rowsUnmatched,
        checkedAt: result.fetchedAt,
      };
    } catch (error) {
      await recordFailure(this.#database, source, this.#now(), error);
      throw error;
    }
  }

  async refreshDefaultContexts(
    season: number,
    force = false,
  ): Promise<readonly FfcAdpRefreshResult[]> {
    const results: FfcAdpRefreshResult[] = [];
    const errors: unknown[] = [];
    for (const context of defaultFfcAdpContexts(season)) {
      try {
        results.push(await this.refresh(context, force));
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, `${errors.length} FFC ADP context refreshes failed`);
    }
    return results;
  }
}
