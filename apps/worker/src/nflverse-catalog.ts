import { dataSources, playerExternalIds, players, syncRuns, type Database } from "@fantasy/db";
import {
  NFLVERSE_ATTRIBUTION,
  NFLVERSE_ATTRIBUTION_URL,
  NFLVERSE_PLAYERS_URL,
  NflversePlayersSource,
} from "@fantasy/source-nflverse";
import { and, eq, lte, sql } from "drizzle-orm";

const sourceKey = "nflverse.players";
const checkIntervalMinutes = 24 * 60;
const claimMinutes = 15;
const chunkSize = 500;
// Increment whenever stored player fields require a full source replay rather than a 304 check.
const catalogSchemaVersion = 2;

export interface CatalogRefreshResult {
  readonly state: "changed" | "unchanged" | "not-due";
  readonly rowsRead: number;
  readonly rowsWritten: number;
  readonly rowsRejected: number;
  readonly checkedAt: string | null;
}

export class NflverseCatalogRefresher {
  readonly #database: Database;
  readonly #source: NflversePlayersSource;
  readonly #now: () => Date;

  constructor(input: {
    readonly database: Database;
    readonly source?: NflversePlayersSource;
    readonly now?: () => Date;
  }) {
    this.#database = input.database;
    this.#source = input.source ?? new NflversePlayersSource();
    this.#now = input.now ?? (() => new Date());
  }

  async refresh(force = false): Promise<CatalogRefreshResult> {
    const now = this.#now();
    const [source] = await this.#database
      .insert(dataSources)
      .values({
        key: sourceKey,
        name: "nflverse player catalog",
        kind: "player_catalog",
        sourceUrl: NFLVERSE_PLAYERS_URL,
        attribution: NFLVERSE_ATTRIBUTION,
        attributionUrl: NFLVERSE_ATTRIBUTION_URL,
        checkIntervalMinutes,
        nextCheckAt: now,
      })
      .onConflictDoUpdate({
        target: dataSources.key,
        set: {
          sourceUrl: NFLVERSE_PLAYERS_URL,
          attribution: NFLVERSE_ATTRIBUTION,
          attributionUrl: NFLVERSE_ATTRIBUTION_URL,
          updatedAt: now,
        },
      })
      .returning();
    if (!source || !source.enabled) {
      return { state: "not-due", rowsRead: 0, rowsWritten: 0, rowsRejected: 0, checkedAt: null };
    }

    const claimUntil = new Date(now.getTime() + claimMinutes * 60_000);
    const claim = await this.#database
      .update(dataSources)
      .set({ nextCheckAt: claimUntil, updatedAt: now })
      .where(
        force
          ? eq(dataSources.id, source.id)
          : and(eq(dataSources.id, source.id), lte(dataSources.nextCheckAt, now)),
      )
      .returning({ id: dataSources.id });
    if (claim.length !== 1) {
      return { state: "not-due", rowsRead: 0, rowsWritten: 0, rowsRejected: 0, checkedAt: null };
    }

    try {
      const storedCatalogSchemaVersion = source.metadata.catalogSchemaVersion;
      const requiresCatalogReplay =
        typeof storedCatalogSchemaVersion !== "number" ||
        storedCatalogSchemaVersion < catalogSchemaVersion;
      const result = await this.#source.check({
        etag: requiresCatalogReplay ? null : source.etag,
        lastModified: requiresCatalogReplay ? null : source.lastModified,
        checksumSha256: requiresCatalogReplay ? null : source.lastChecksum,
      });
      const checkedAt = new Date(result.checkedAt);
      const nextCheckAt = new Date(checkedAt.getTime() + checkIntervalMinutes * 60_000);
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

      let recordsWritten = 0;
      await this.#database.transaction(async (transaction) => {
        const playerIds = new Map<string, string>();
        for (let index = 0; index < result.players.length; index += chunkSize) {
          const batch = result.players.slice(index, index + chunkSize);
          const stored = await transaction
            .insert(players)
            .values(
              batch.map((player) => ({
                gsisId: player.gsisId,
                fullName: player.displayName,
                firstName: player.firstName,
                lastName: player.lastName,
                nflTeam: player.latestTeam,
                primaryPosition: player.position,
                eligiblePositions: [player.position],
                status: player.status,
                birthDate: player.birthDate,
                rookieSeason: player.rookieSeason,
                lastSeason: player.lastSeason,
                updatedAt: checkedAt,
              })),
            )
            .onConflictDoUpdate({
              target: players.gsisId,
              set: {
                fullName: sql`excluded.full_name`,
                firstName: sql`excluded.first_name`,
                lastName: sql`excluded.last_name`,
                nflTeam: sql`excluded.nfl_team`,
                primaryPosition: sql`excluded.primary_position`,
                eligiblePositions: sql`excluded.eligible_positions`,
                status: sql`excluded.status`,
                birthDate: sql`excluded.birth_date`,
                rookieSeason: sql`excluded.rookie_season`,
                lastSeason: sql`excluded.last_season`,
                updatedAt: checkedAt,
              },
            })
            .returning({ id: players.id, gsisId: players.gsisId });
          for (const row of stored) if (row.gsisId) playerIds.set(row.gsisId, row.id);
          recordsWritten += stored.length;
        }

        const externalRows = result.players.flatMap((player) => {
          const playerId = playerIds.get(player.gsisId);
          return player.espnId && playerId
            ? [
                {
                  playerId,
                  source: "espn",
                  externalId: player.espnId,
                  confidence: "1",
                  verified: true,
                },
              ]
            : [];
        });
        for (let index = 0; index < externalRows.length; index += chunkSize) {
          const batch = externalRows.slice(index, index + chunkSize);
          await transaction
            .insert(playerExternalIds)
            .values(batch)
            .onConflictDoUpdate({
              target: [playerExternalIds.source, playerExternalIds.externalId],
              set: {
                playerId: sql`excluded.player_id`,
                confidence: "1",
                verified: true,
              },
            });
          recordsWritten += batch.length;
        }

        await transaction
          .insert(syncRuns)
          .values({
            kind: "player-catalog",
            state: "succeeded",
            idempotencyKey: `${sourceKey}:${result.checksumSha256}`,
            startedAt: now,
            finishedAt: checkedAt,
            recordsRead: result.rowsRead,
            recordsWritten,
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
        rowsWritten: recordsWritten,
        rowsRejected: result.rowsRejected,
        checkedAt: result.checkedAt,
      };
    } catch (error) {
      const failedAt = this.#now();
      const retryMinutes = Math.min(24 * 60, 15 * 2 ** Math.min(source.consecutiveFailures, 6));
      await this.#database
        .update(dataSources)
        .set({
          lastCheckedAt: failedAt,
          nextCheckAt: new Date(failedAt.getTime() + retryMinutes * 60_000),
          consecutiveFailures: source.consecutiveFailures + 1,
          lastErrorAt: failedAt,
          lastErrorCode:
            error instanceof Error && "code" in error ? String(error.code).slice(0, 64) : "UNKNOWN",
          lastErrorDetail:
            error instanceof Error ? error.message.slice(0, 256) : "Player catalog refresh failed",
          updatedAt: failedAt,
        })
        .where(eq(dataSources.id, source.id));
      throw error;
    }
  }
}
