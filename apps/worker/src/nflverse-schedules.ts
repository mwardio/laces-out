import { createHash } from "node:crypto";

import {
  dataSources,
  nflScheduleObservations,
  syncRuns,
  type Database,
  type JsonPrimitive,
  type NflScheduleGameStatus,
} from "@fantasy/db";
import {
  NFLVERSE_DATA_LICENSE,
  NFLVERSE_SCHEDULES_ATTRIBUTION,
  NFLVERSE_SCHEDULES_ATTRIBUTION_URL,
  NFLVERSE_SCHEDULES_URL,
  NflverseSchedulesSource,
  type NflverseScheduleGame,
} from "@fantasy/source-nflverse";
import { currentNflSeason, isReusableArchivedSourceArtifact } from "@fantasy/domain";
import { and, eq, lte } from "drizzle-orm";

// Runs beneath the hourly projection sweep. The buffer prevents request/runtime drift from
// skipping the next conditional schedule check.
const checkIntervalMinutes = 45;
const claimMinutes = 30;
const chunkSize = 500;
const sourceSchemaVersion = 2;

export interface ScheduleRefreshResult {
  readonly sourceKey: string;
  readonly state: "changed" | "unchanged" | "not-due";
  readonly rowsRead: number;
  readonly rowsWritten: number;
  readonly rowsRejected: number;
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

function sourceKey(season: number): string {
  return `nflverse.schedules.${season}`;
}

function stableGame(game: NflverseScheduleGame): string {
  return JSON.stringify([
    game.gameId,
    game.season,
    game.week,
    game.seasonType,
    game.gameType,
    game.gameDate,
    game.startTimeEastern,
    game.timeTbd,
    game.awayTeam,
    game.homeTeam,
    game.awayScore,
    game.homeScore,
    game.awayRestDays,
    game.homeRestDays,
    game.venue,
    game.status,
  ]);
}

/** Hashes only the selected season rows, so an unrelated historical correction is a no-op. */
export function scheduleSelectionChecksum(games: readonly NflverseScheduleGame[]): string {
  const ordered = [...games].sort((left, right) => left.gameId.localeCompare(right.gameId));
  return createHash("sha256").update(ordered.map(stableGame).join("\n"), "utf8").digest("hex");
}

/**
 * Fails closed when a modern regular-season ledger cannot prove every team-week assignment.
 * The sole exception is the canceled Buffalo-Cincinnati game in 2022: that admitted ledger has
 * 271 games, no BUF-CIN row or Week 17 assignment for either club, BUF and CIN each appearing
 * 16 times, and every other team appearing 17 times.
 */
export function assertCompleteModernRegularSeasonSchedule(
  season: number,
  games: readonly NflverseScheduleGame[],
): void {
  if (season < 2021) return;
  const regular = games.filter((game) => game.season === season && game.seasonType === "REG");
  const weeks = new Set(regular.map((game) => game.week));
  const gamesByTeam = new Map<string, number>();
  const teamWeeks = new Set<string>();
  let duplicateTeamWeek = false;
  let selfMatchup = false;
  for (const game of regular) {
    if (game.awayTeam === game.homeTeam) selfMatchup = true;
    for (const team of [game.awayTeam, game.homeTeam]) {
      const teamWeek = `${team}:${game.week}`;
      if (teamWeeks.has(teamWeek)) duplicateTeamWeek = true;
      teamWeeks.add(teamWeek);
    }
    gamesByTeam.set(game.awayTeam, (gamesByTeam.get(game.awayTeam) ?? 0) + 1);
    gamesByTeam.set(game.homeTeam, (gamesByTeam.get(game.homeTeam) ?? 0) + 1);
  }
  const completeWeeks =
    weeks.size === 18 &&
    Array.from({ length: 18 }, (_, index) => index + 1).every((week) => weeks.has(week));
  const known2022Cancellation =
    season === 2022 &&
    regular.length === 271 &&
    gamesByTeam.get("BUF") === 16 &&
    gamesByTeam.get("CIN") === 16 &&
    !teamWeeks.has("BUF:17") &&
    !teamWeeks.has("CIN:17") &&
    !regular.some(
      (game) =>
        (game.awayTeam === "BUF" && game.homeTeam === "CIN") ||
        (game.awayTeam === "CIN" && game.homeTeam === "BUF"),
    ) &&
    [...gamesByTeam.entries()].every(
      ([team, gamesPlayed]) => gamesPlayed === (team === "BUF" || team === "CIN" ? 16 : 17),
    );
  const completeTeams =
    gamesByTeam.size === 32 &&
    (known2022Cancellation ||
      [...gamesByTeam.values()].every((gamesPlayed) => gamesPlayed === 17)) &&
    !duplicateTeamWeek &&
    !selfMatchup;
  if ((!known2022Cancellation && regular.length !== 272) || !completeWeeks || !completeTeams) {
    throw new Error(
      `Incomplete ${season} regular-season schedule: ${regular.length} games, ${weeks.size} weeks, ${gamesByTeam.size} teams`,
    );
  }
}

/** Converts nflverse's local US-Eastern wall clock to a UTC instant without host-timezone drift. */
export function nflEasternKickoffAt(
  game: Pick<NflverseScheduleGame, "gameDate" | "startTimeEastern" | "timeTbd">,
): Date | null {
  if (game.timeTbd || game.startTimeEastern === null) return null;
  const [year, month, day] = game.gameDate.split("-").map(Number);
  const [hour, minute] = game.startTimeEastern.split(":").map(Number);
  if ([year, month, day, hour, minute].some((value) => value === undefined)) return null;
  const wallClockUtc = Date.UTC(year as number, (month as number) - 1, day, hour, minute);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(wallClockUtc));
  const part = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((candidate) => candidate.type === type)?.value);
  const easternAtGuess = Date.UTC(
    part("year"),
    part("month") - 1,
    part("day"),
    part("hour"),
    part("minute"),
  );
  return new Date(wallClockUtc - (easternAtGuess - wallClockUtc));
}

// The nflverse schedule artifact exposes only `scheduled` or `final`, deriving finality purely
// from score presence (see remaining weekly-production risks). If
// upstream ever published an in-progress score through this same feed, that score-derived "final"
// would otherwise be trusted the instant it appeared.
const CONSERVATIVE_FINAL_ELAPSED_MS = 4 * 60 * 60 * 1000;

/**
 * Downgrades a score-derived "final" to "in-progress" until a conservative floor elapses since
 * kickoff, so a prematurely published in-progress score can never be mistaken for a completed
 * game. An unknown kickoff falls back to trusting the score-derived status alone, the only
 * completeness signal this feed provides.
 */
export function conservativeScheduleStatus(
  game: Pick<NflverseScheduleGame, "status">,
  kickoffAt: Date | null,
  now: Date,
): NflScheduleGameStatus {
  if (game.status !== "final" || kickoffAt === null) return game.status;
  return now.getTime() - kickoffAt.getTime() >= CONSERVATIVE_FINAL_ELAPSED_MS
    ? "final"
    : "in-progress";
}

function metadataChecksum(metadata: SourceRow["metadata"]): string | null {
  const value = metadata.artifactChecksumSha256;
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value) ? value : null;
}

export class NflverseScheduleRefresher {
  readonly #database: Database;
  readonly #source: NflverseSchedulesSource;
  readonly #now: () => Date;

  constructor(input: {
    readonly database: Database;
    readonly source?: NflverseSchedulesSource;
    readonly now?: () => Date;
  }) {
    this.#database = input.database;
    this.#source = input.source ?? new NflverseSchedulesSource();
    this.#now = input.now ?? (() => new Date());
  }

  async refresh(season: number, force = false): Promise<ScheduleRefreshResult> {
    if (!Number.isSafeInteger(season) || season < 1999 || season > 2200) {
      throw new RangeError("NFL schedule season must be between 1999 and 2200");
    }
    const now = this.#now();
    const key = sourceKey(season);
    const [source] = await this.#database
      .insert(dataSources)
      .values({
        key,
        name: `nflverse ${season} NFL schedule`,
        kind: "nfl_schedule",
        sourceUrl: NFLVERSE_SCHEDULES_URL,
        attribution: NFLVERSE_SCHEDULES_ATTRIBUTION,
        attributionUrl: NFLVERSE_SCHEDULES_ATTRIBUTION_URL,
        checkIntervalMinutes,
        nextCheckAt: now,
        metadata: {
          sourceSchemaVersion,
          season,
          license: NFLVERSE_DATA_LICENSE,
          availability: "pending",
        },
      })
      .onConflictDoUpdate({
        target: dataSources.key,
        set: {
          name: `nflverse ${season} NFL schedule`,
          kind: "nfl_schedule",
          sourceUrl: NFLVERSE_SCHEDULES_URL,
          attribution: NFLVERSE_SCHEDULES_ATTRIBUTION,
          attributionUrl: NFLVERSE_SCHEDULES_ATTRIBUTION_URL,
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
    if (!source?.enabled) return this.#notDue(key);
    const stableMetadata = { ...source.metadata };
    delete stableMetadata.refreshClaimedAt;
    const stableSource = { ...source, metadata: stableMetadata };
    if (
      !force &&
      isReusableArchivedSourceArtifact({
        sourceKey: key,
        metadata: stableMetadata,
        lastChecksum: source.lastChecksum,
        activeSeason: currentNflSeason(now),
        sourceSchemaVersion,
      })
    ) {
      return this.#notDue(key);
    }

    const claimed = await this.#database
      .update(dataSources)
      .set({
        nextCheckAt: new Date(now.getTime() + claimMinutes * 60_000),
        metadata: { ...stableMetadata, refreshClaimedAt: now.toISOString() },
        updatedAt: now,
      })
      .where(
        force
          ? eq(dataSources.id, source.id)
          : and(eq(dataSources.id, source.id), lte(dataSources.nextCheckAt, now)),
      )
      .returning({ id: dataSources.id });
    if (claimed.length !== 1) return this.#notDue(key);

    try {
      const selectionKey = `${season}:REG`;
      const source = stableSource;
      const schemaReplay = source.metadata.sourceSchemaVersion !== sourceSchemaVersion;
      const result = await this.#source.check(
        season,
        {
          etag: schemaReplay ? null : source.etag,
          lastModified: schemaReplay ? null : source.lastModified,
          checksumSha256: schemaReplay ? null : metadataChecksum(source.metadata),
          selectionKey: schemaReplay ? null : selectionKey,
        },
        { seasonTypes: ["REG"] },
      );
      const checkedAt = new Date(result.checkedAt);
      const nextCheckAt = new Date(checkedAt.getTime() + checkIntervalMinutes * 60_000);
      if (result.state === "unchanged") {
        await this.#database
          .update(dataSources)
          .set({
            lastCheckedAt: checkedAt,
            lastSuccessfulAt: checkedAt,
            nextCheckAt,
            etag: result.etag,
            lastModified: result.lastModified,
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
              selectionKey: result.selectionKey,
              artifactChecksumSha256: result.checksumSha256,
            },
            updatedAt: checkedAt,
          })
          .where(eq(dataSources.id, source.id));
        return {
          sourceKey: key,
          state: "unchanged",
          rowsRead: 0,
          rowsWritten: 0,
          rowsRejected: 0,
          checkedAt: result.checkedAt,
        };
      }

      assertCompleteModernRegularSeasonSchedule(season, result.games);
      const inputChecksum = scheduleSelectionChecksum(result.games);
      let rowsWritten = 0;
      await this.#database.transaction(async (transaction) => {
        const idempotencyKey = `${key}:${inputChecksum}:v${sourceSchemaVersion}`;
        const [createdRun] = await transaction
          .insert(syncRuns)
          .values({
            kind: "nfl-schedule",
            state: "running",
            idempotencyKey,
            startedAt: now,
            recordsRead: result.rowsRead,
            artifactChecksum: inputChecksum,
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
        if (!storedRun) throw new Error("nflverse schedule ingestion run could not be established");

        for (let index = 0; index < result.games.length; index += chunkSize) {
          const inserted = await transaction
            .insert(nflScheduleObservations)
            .values(
              result.games.slice(index, index + chunkSize).map((game) => {
                const kickoffAt = nflEasternKickoffAt(game);
                return {
                  sourceId: source.id,
                  sourceSyncRunId: storedRun.id,
                  externalGameId: game.gameId,
                  season: game.season,
                  week: game.week,
                  seasonType: game.seasonType,
                  gameDate: game.gameDate,
                  startTimeEastern: game.startTimeEastern,
                  timeTbd: game.timeTbd,
                  kickoffAt,
                  awayTeam: game.awayTeam,
                  homeTeam: game.homeTeam,
                  status: conservativeScheduleStatus(game, kickoffAt, checkedAt),
                  neutralSite: game.venue === "neutral",
                  awayRestDays: game.awayRestDays,
                  homeRestDays: game.homeRestDays,
                  awayScore: game.awayScore,
                  homeScore: game.homeScore,
                  sourceAsOf: checkedAt,
                  fetchedAt: checkedAt,
                  inputChecksum,
                };
              }),
            )
            .onConflictDoNothing()
            .returning({ id: nflScheduleObservations.id });
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
            ...(inputChecksum === source.lastChecksum ? {} : { lastChangedAt: checkedAt }),
            lastSuccessfulAt: checkedAt,
            nextCheckAt,
            etag: result.etag,
            lastModified: result.lastModified,
            lastChecksum: inputChecksum,
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
              publishable: true,
              selectionKey: result.selectionKey,
              artifactChecksumSha256: result.checksumSha256,
              rowsRead: result.rowsRead,
              rowsRejected: result.rowsRejected,
              coveredWeeks: result.coveredWeeks.join(","),
              coveredTeams: result.coveredTeams.join(","),
              coveredSeasonTypes: result.coveredSeasonTypes.join(","),
            },
            updatedAt: checkedAt,
          })
          .where(eq(dataSources.id, source.id));
      });
      return {
        sourceKey: key,
        state: inputChecksum === source.lastChecksum ? "unchanged" : "changed",
        rowsRead: result.rowsRead,
        rowsWritten,
        rowsRejected: result.rowsRejected,
        checkedAt: result.checkedAt,
      };
    } catch (error) {
      const failedAt = this.#now();
      const retryMinutes = Math.min(
        checkIntervalMinutes,
        15 * 2 ** Math.min(stableSource.consecutiveFailures, 6),
      );
      await this.#database
        .update(dataSources)
        .set({
          lastCheckedAt: failedAt,
          nextCheckAt: new Date(failedAt.getTime() + retryMinutes * 60_000),
          consecutiveFailures: stableSource.consecutiveFailures + 1,
          lastErrorAt: failedAt,
          lastErrorCode:
            error instanceof Error && "code" in error ? String(error.code).slice(0, 64) : "UNKNOWN",
          lastErrorDetail:
            error instanceof Error
              ? error.message.slice(0, 256)
              : "nflverse schedule refresh failed",
          metadata: stableSource.metadata,
          updatedAt: failedAt,
        })
        .where(eq(dataSources.id, stableSource.id));
      throw error;
    }
  }

  #notDue(key: string): ScheduleRefreshResult {
    return {
      sourceKey: key,
      state: "not-due",
      rowsRead: 0,
      rowsWritten: 0,
      rowsRejected: 0,
      checkedAt: null,
    };
  }
}
