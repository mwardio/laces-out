import {
  dataSources,
  playerExternalIds,
  playerMarketObservations,
  playerSourceObservations,
  players,
  syncRuns,
  type Database,
} from "@laces-out/db";
import {
  SLEEPER_ATTRIBUTION,
  SLEEPER_ATTRIBUTION_URL,
  SLEEPER_PLAYERS_URL,
  SLEEPER_TRENDS_URL,
  SleeperPlayersSource,
  SleeperTrendsSource,
} from "@laces-out/source-sleeper";
import { and, eq, inArray, lt, lte, sql } from "drizzle-orm";

const catalogSourceKey = "sleeper.players";
const trendsSourceKey = "sleeper.trends";
// Injury, practice, and availability signals directly affect start/sit projections. The daily
// shared-data refresh keeps the catalog warm before the nightly forecast; conditional requests
// keep game-day lock-window checks and explicit on-demand refreshes cheap.
/**
 * Sleeper documents the players endpoint as a cache-locally, at-most-daily read. A 2026-07-27
 * review moved this from 30 to 60 minutes: still short of that guidance, but halving the request
 * rate against a source whose catalog changes slowly. Conditional revalidation keeps the ordinary
 * cost a 304 rather than a ~15 MB transfer.
 */
const catalogCheckIntervalMinutes = 60;
const trendsCheckIntervalMinutes = 60;
const claimMinutes = 15;
const chunkSize = 500;
const catalogSchemaVersion = 3;
const marketRetentionDays = 90;

export interface SleeperRefreshResult {
  readonly state: "changed" | "unchanged" | "not-due";
  readonly rowsRead: number;
  readonly rowsWritten: number;
  readonly rowsRejected: number;
  readonly checkedAt: string | null;
}

export function sleeperPlayerCrosswalkRows(input: {
  readonly playerId: string | null;
  readonly sleeperId: string;
  readonly espnId: string | null;
  readonly yahooId: string | null;
  readonly confidence: string;
}) {
  if (!input.playerId) return [];
  return [
    {
      playerId: input.playerId,
      source: "sleeper",
      externalId: input.sleeperId,
      confidence: input.confidence,
      verified: false,
    },
    ...(input.espnId
      ? [
          {
            playerId: input.playerId,
            source: "sleeper-espn",
            externalId: input.espnId,
            confidence: input.confidence,
            verified: false,
          },
        ]
      : []),
    ...(input.yahooId
      ? [
          {
            playerId: input.playerId,
            source: "sleeper-yahoo",
            externalId: input.yahooId,
            confidence: input.confidence,
            verified: false,
          },
        ]
      : []),
  ];
}

type SleeperCrosswalkRow = ReturnType<typeof sleeperPlayerCrosswalkRows>[number];

/**
 * Produces one unambiguous row per provider alias before a batched upsert.
 *
 * Sleeper can temporarily expose the same ESPN or Yahoo identifier on multiple catalog entries
 * (for example, an obsolete record and its replacement). PostgreSQL cannot update the same
 * conflict target twice in one INSERT, and choosing either player would silently corrupt the
 * crosswalk. Exact duplicates collapse; conflicting aliases are withheld until the provider data
 * becomes unambiguous.
 */
export function uniqueSleeperPlayerCrosswalkRows(
  rows: readonly SleeperCrosswalkRow[],
): readonly SleeperCrosswalkRow[] {
  const candidates = new Map<string, SleeperCrosswalkRow | null>();
  for (const row of rows) {
    const key = `${row.source}:${row.externalId}`;
    const existing = candidates.get(key);
    if (existing === undefined) {
      candidates.set(key, row);
      continue;
    }
    if (existing === null) continue;
    if (existing.playerId !== row.playerId) {
      candidates.set(key, null);
      continue;
    }
    if (Number(row.confidence) > Number(existing.confidence)) candidates.set(key, row);
  }
  return [...candidates.values()].flatMap((row) => (row === null ? [] : [row]));
}

interface SourceRow {
  readonly id: string;
  readonly enabled: boolean;
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly lastChecksum: string | null;
  readonly consecutiveFailures: number;
  readonly metadata: Record<string, string | number | boolean | null>;
}

async function claimSource(
  database: Database,
  input: {
    readonly key: string;
    readonly name: string;
    readonly kind: string;
    readonly sourceUrl: string;
    readonly checkIntervalMinutes: number;
    readonly metadata?: Record<string, string | number | boolean | null>;
    readonly force: boolean;
    readonly now: Date;
  },
): Promise<SourceRow | null> {
  const [source] = await database
    .insert(dataSources)
    .values({
      key: input.key,
      name: input.name,
      kind: input.kind,
      sourceUrl: input.sourceUrl,
      attribution: SLEEPER_ATTRIBUTION,
      attributionUrl: SLEEPER_ATTRIBUTION_URL,
      checkIntervalMinutes: input.checkIntervalMinutes,
      // Use the worker's claim clock instead of a slightly later database default so a newly
      // registered source is eligible for its first check immediately.
      nextCheckAt: input.now,
      metadata: input.metadata ?? {},
    })
    .onConflictDoUpdate({
      target: dataSources.key,
      set: {
        name: input.name,
        kind: input.kind,
        sourceUrl: input.sourceUrl,
        attribution: SLEEPER_ATTRIBUTION,
        attributionUrl: SLEEPER_ATTRIBUTION_URL,
        checkIntervalMinutes: input.checkIntervalMinutes,
        updatedAt: input.now,
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
  const stableMetadata = { ...source.metadata };
  delete stableMetadata.refreshClaimedAt;
  const stableSource = { ...source, metadata: stableMetadata };
  const claimUntil = new Date(input.now.getTime() + claimMinutes * 60_000);
  const claim = await database
    .update(dataSources)
    .set({
      nextCheckAt: claimUntil,
      metadata: { ...stableMetadata, refreshClaimedAt: input.now.toISOString() },
      updatedAt: input.now,
    })
    .where(
      input.force
        ? eq(dataSources.id, source.id)
        : and(eq(dataSources.id, source.id), lte(dataSources.nextCheckAt, input.now)),
    )
    .returning({ id: dataSources.id });
  return claim.length === 1 ? stableSource : null;
}

async function recordFailure(
  database: Database,
  source: SourceRow,
  failedAt: Date,
  error: unknown,
): Promise<void> {
  const retryMinutes = Math.min(24 * 60, 15 * 2 ** Math.min(source.consecutiveFailures, 6));
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
        error instanceof Error ? error.message.slice(0, 256) : "Sleeper data refresh failed",
      metadata: source.metadata,
      updatedAt: failedAt,
    })
    .where(eq(dataSources.id, source.id));
}

function exactIdentityKey(fullName: string, primaryPosition: string): string {
  return `${fullName.normalize("NFKC").trim().toLocaleLowerCase("en-US")}|${primaryPosition.trim().toUpperCase()}`;
}

export function buildUniqueExactPlayerIdentity(
  rows: readonly {
    readonly id: string;
    readonly fullName: string;
    readonly primaryPosition: string;
  }[],
): ReadonlyMap<string, string> {
  const candidates = new Map<string, string | null>();
  for (const row of rows) {
    const key = exactIdentityKey(row.fullName, row.primaryPosition);
    const existing = candidates.get(key);
    candidates.set(key, existing === undefined || existing === row.id ? row.id : null);
  }
  return new Map(
    [...candidates].flatMap(([key, playerId]) => (playerId ? ([[key, playerId]] as const) : [])),
  );
}

async function playerIdentityMaps(database: Database) {
  const [canonicalRows, externalRows] = await Promise.all([
    database
      .select({
        id: players.id,
        gsisId: players.gsisId,
        fullName: players.fullName,
        primaryPosition: players.primaryPosition,
      })
      .from(players),
    database
      .select({
        playerId: playerExternalIds.playerId,
        source: playerExternalIds.source,
        externalId: playerExternalIds.externalId,
      })
      .from(playerExternalIds)
      .where(inArray(playerExternalIds.source, ["sleeper", "espn", "yahoo"])),
  ]);
  return {
    gsis: new Map(canonicalRows.flatMap((row) => (row.gsisId ? [[row.gsisId, row.id]] : []))),
    external: new Map(externalRows.map((row) => [`${row.source}:${row.externalId}`, row.playerId])),
    exact: buildUniqueExactPlayerIdentity(canonicalRows),
  };
}

function resolvePlayer(
  identity: Awaited<ReturnType<typeof playerIdentityMaps>>,
  player: {
    readonly sleeperId: string;
    readonly gsisId: string | null;
    readonly espnId: string | null;
    readonly yahooId: string | null;
    readonly displayName: string;
    readonly position: string;
  },
): { readonly playerId: string | null; readonly confidence: string } {
  const gsis = player.gsisId ? identity.gsis.get(player.gsisId) : undefined;
  if (gsis) return { playerId: gsis, confidence: "1.0000" };
  const sleeper = identity.external.get(`sleeper:${player.sleeperId}`);
  if (sleeper) return { playerId: sleeper, confidence: "0.9500" };
  const espn = player.espnId ? identity.external.get(`espn:${player.espnId}`) : undefined;
  if (espn) return { playerId: espn, confidence: "0.9500" };
  const yahoo = player.yahooId ? identity.external.get(`yahoo:${player.yahooId}`) : undefined;
  if (yahoo) return { playerId: yahoo, confidence: "0.9000" };
  const exactKey = exactIdentityKey(player.displayName, player.position);
  return { playerId: identity.exact.get(exactKey) ?? null, confidence: "0.8000" };
}

export class SleeperDataRefresher {
  readonly #database: Database;
  readonly #playersSource: SleeperPlayersSource;
  readonly #trendsSource: SleeperTrendsSource;
  readonly #now: () => Date;

  constructor(input: {
    readonly database: Database;
    readonly playersSource?: SleeperPlayersSource;
    readonly trendsSource?: SleeperTrendsSource;
    readonly now?: () => Date;
  }) {
    this.#database = input.database;
    this.#playersSource = input.playersSource ?? new SleeperPlayersSource();
    this.#trendsSource = input.trendsSource ?? new SleeperTrendsSource();
    this.#now = input.now ?? (() => new Date());
  }

  async refreshCatalog(force = false): Promise<SleeperRefreshResult> {
    const now = this.#now();
    const source = await claimSource(this.#database, {
      key: catalogSourceKey,
      name: "Sleeper player status",
      kind: "player_status",
      sourceUrl: SLEEPER_PLAYERS_URL,
      checkIntervalMinutes: catalogCheckIntervalMinutes,
      metadata: { catalogSchemaVersion },
      force,
      now,
    });
    if (!source) {
      return { state: "not-due", rowsRead: 0, rowsWritten: 0, rowsRejected: 0, checkedAt: null };
    }

    try {
      const storedSchemaVersion = source.metadata.catalogSchemaVersion;
      const replay =
        typeof storedSchemaVersion !== "number" || storedSchemaVersion < catalogSchemaVersion;
      const result = await this.#playersSource.check({
        etag: replay ? null : source.etag,
        lastModified: replay ? null : source.lastModified,
        checksumSha256: replay ? null : source.lastChecksum,
      });
      const checkedAt = new Date(result.checkedAt);
      const nextCheckAt = new Date(checkedAt.getTime() + catalogCheckIntervalMinutes * 60_000);
      const metadata = { ...source.metadata, catalogSchemaVersion };
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
            metadata,
            updatedAt: checkedAt,
          })
          .where(eq(dataSources.id, source.id));
        return {
          state: "unchanged",
          rowsRead: 0,
          rowsWritten: 0,
          rowsRejected: 0,
          checkedAt: result.checkedAt,
        };
      }

      const identity = await playerIdentityMaps(this.#database);
      const resolved = result.players.map((player) => ({
        player,
        ...resolvePlayer(identity, player),
      }));
      let rowsWritten = 0;
      await this.#database.transaction(async (transaction) => {
        for (let index = 0; index < resolved.length; index += chunkSize) {
          const batch = resolved.slice(index, index + chunkSize);
          await transaction
            .insert(playerSourceObservations)
            .values(
              batch.map(({ player, playerId }) => ({
                sourceId: source.id,
                externalPlayerId: player.sleeperId,
                playerId,
                gsisId: player.gsisId,
                fullName: player.displayName,
                nflTeam: player.nflTeam,
                primaryPosition: player.position,
                eligiblePositions: [...player.eligiblePositions],
                status: player.status,
                injuryStatus: player.injuryStatus,
                practiceParticipation: player.practiceParticipation,
                depthChartPosition: player.depthChartPosition,
                depthChartOrder: player.depthChartOrder,
                observedAt: checkedAt,
                updatedAt: checkedAt,
              })),
            )
            .onConflictDoUpdate({
              target: [
                playerSourceObservations.sourceId,
                playerSourceObservations.externalPlayerId,
              ],
              set: {
                playerId: sql`excluded.player_id`,
                gsisId: sql`excluded.gsis_id`,
                fullName: sql`excluded.full_name`,
                nflTeam: sql`excluded.nfl_team`,
                primaryPosition: sql`excluded.primary_position`,
                eligiblePositions: sql`excluded.eligible_positions`,
                status: sql`excluded.status`,
                injuryStatus: sql`excluded.injury_status`,
                practiceParticipation: sql`excluded.practice_participation`,
                depthChartPosition: sql`excluded.depth_chart_position`,
                depthChartOrder: sql`excluded.depth_chart_order`,
                observedAt: checkedAt,
                updatedAt: checkedAt,
              },
            });
          rowsWritten += batch.length;
        }

        const crosswalkIds = uniqueSleeperPlayerCrosswalkRows(
          resolved.flatMap(({ player, playerId, confidence }) =>
            sleeperPlayerCrosswalkRows({
              playerId,
              sleeperId: player.sleeperId,
              espnId: player.espnId,
              yahooId: player.yahooId,
              confidence,
            }),
          ),
        );
        for (let index = 0; index < crosswalkIds.length; index += chunkSize) {
          const batch = crosswalkIds.slice(index, index + chunkSize);
          await transaction
            .insert(playerExternalIds)
            .values(batch)
            .onConflictDoUpdate({
              target: [playerExternalIds.source, playerExternalIds.externalId],
              set: {
                playerId: sql`excluded.player_id`,
                confidence: sql`excluded.confidence`,
                verified: false,
              },
            });
          rowsWritten += batch.length;
        }

        await transaction
          .insert(syncRuns)
          .values({
            kind: "player-status",
            state: "succeeded",
            idempotencyKey: `${catalogSourceKey}:${result.checksumSha256}`,
            startedAt: now,
            finishedAt: checkedAt,
            recordsRead: result.rowsRead,
            recordsWritten: rowsWritten,
            artifactChecksum: result.checksumSha256,
          })
          .onConflictDoNothing({ target: syncRuns.idempotencyKey });
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
            metadata,
            updatedAt: checkedAt,
          })
          .where(eq(dataSources.id, source.id));
      });
      return {
        state: "changed",
        rowsRead: result.rowsRead,
        rowsWritten,
        rowsRejected: result.rowsRejected,
        checkedAt: result.checkedAt,
      };
    } catch (error) {
      await recordFailure(this.#database, source, this.#now(), error);
      throw error;
    }
  }

  async refreshTrends(force = false): Promise<SleeperRefreshResult> {
    const now = this.#now();
    const source = await claimSource(this.#database, {
      key: trendsSourceKey,
      name: "Sleeper waiver trends",
      kind: "market_signal",
      sourceUrl: SLEEPER_TRENDS_URL,
      checkIntervalMinutes: trendsCheckIntervalMinutes,
      metadata: { lookbackHours: 24, limitPerSignal: 50 },
      force,
      now,
    });
    if (!source) {
      return { state: "not-due", rowsRead: 0, rowsWritten: 0, rowsRejected: 0, checkedAt: null };
    }

    try {
      const result = await this.#trendsSource.check(source.lastChecksum);
      const checkedAt = new Date(result.checkedAt);
      const nextCheckAt = new Date(checkedAt.getTime() + trendsCheckIntervalMinutes * 60_000);
      const identityRows = await this.#database
        .select({ externalId: playerExternalIds.externalId, playerId: playerExternalIds.playerId })
        .from(playerExternalIds)
        .where(eq(playerExternalIds.source, "sleeper"));
      const identity = new Map(identityRows.map((row) => [row.externalId, row.playerId]));
      await this.#database.transaction(async (transaction) => {
        await transaction.insert(playerMarketObservations).values(
          result.trends.map((trend) => ({
            sourceId: source.id,
            externalPlayerId: trend.sleeperId,
            playerId: identity.get(trend.sleeperId) ?? null,
            signal: trend.signal,
            lookbackHours: result.lookbackHours,
            rank: trend.rank,
            count: trend.count,
            observedAt: checkedAt,
          })),
        );
        await transaction
          .delete(playerMarketObservations)
          .where(
            and(
              eq(playerMarketObservations.sourceId, source.id),
              lt(
                playerMarketObservations.observedAt,
                new Date(checkedAt.getTime() - marketRetentionDays * 86_400_000),
              ),
            ),
          );
        await transaction
          .insert(syncRuns)
          .values({
            kind: "market-signal",
            state: "succeeded",
            idempotencyKey: `${trendsSourceKey}:${result.checkedAt}`,
            startedAt: now,
            finishedAt: checkedAt,
            recordsRead: result.rowsRead,
            recordsWritten: result.trends.length,
            artifactChecksum: result.checksumSha256,
          })
          .onConflictDoNothing({ target: syncRuns.idempotencyKey });
        await transaction
          .update(dataSources)
          .set({
            lastCheckedAt: checkedAt,
            ...(result.state === "changed" ? { lastChangedAt: checkedAt } : {}),
            lastSuccessfulAt: checkedAt,
            nextCheckAt,
            lastChecksum: result.checksumSha256,
            consecutiveFailures: 0,
            lastErrorAt: null,
            lastErrorCode: null,
            lastErrorDetail: null,
            updatedAt: checkedAt,
          })
          .where(eq(dataSources.id, source.id));
      });
      return {
        state: result.state,
        rowsRead: result.rowsRead,
        rowsWritten: result.trends.length,
        rowsRejected: result.rowsRejected,
        checkedAt: result.checkedAt,
      };
    } catch (error) {
      await recordFailure(this.#database, source, this.#now(), error);
      throw error;
    }
  }
}
