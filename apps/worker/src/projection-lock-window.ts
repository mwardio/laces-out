import { dataSources, nflScheduleObservations, type Database } from "@laces-out/db";
import { and, eq } from "drizzle-orm";

const DEFAULT_LEAD_MINUTES = 130;
const DEFAULT_FINAL_CHECK_MINUTES = 10;

export interface ProjectionLockWindowGame {
  readonly kickoffAt: Date | null;
  readonly status: "scheduled" | "in-progress" | "final" | "postponed" | "cancelled";
}

export interface ProjectionLockWindowState {
  readonly active: boolean;
  readonly forceFinalCheck: boolean;
  readonly nextKickoffAt: string | null;
}

/**
 * Activates frequent projection checks only before a known, unresolved kickoff. Postponed,
 * cancelled, in-progress, final, and unknown-time games never keep the near-lock cron hot.
 */
export function projectionLockWindowState(
  games: readonly ProjectionLockWindowGame[],
  now: Date,
  leadMinutes = DEFAULT_LEAD_MINUTES,
  finalCheckMinutes = DEFAULT_FINAL_CHECK_MINUTES,
): ProjectionLockWindowState {
  if (!Number.isFinite(now.getTime()))
    throw new TypeError("Projection lock-window time is invalid");
  if (!Number.isSafeInteger(leadMinutes) || leadMinutes < 30 || leadMinutes > 360) {
    throw new RangeError("Projection lock-window lead must be between 30 and 360 minutes");
  }
  if (
    !Number.isSafeInteger(finalCheckMinutes) ||
    finalCheckMinutes < 1 ||
    finalCheckMinutes > leadMinutes
  ) {
    throw new RangeError("Projection final-check window must fit inside the lock window");
  }
  const upcoming = games
    .filter((game) => game.status === "scheduled" && game.kickoffAt !== null)
    .map((game) => game.kickoffAt as Date)
    .filter((kickoffAt) => kickoffAt.getTime() > now.getTime())
    .sort((left, right) => left.getTime() - right.getTime());
  const nextKickoff = upcoming[0];
  if (!nextKickoff) return { active: false, forceFinalCheck: false, nextKickoffAt: null };
  const minutesToKickoff = (nextKickoff.getTime() - now.getTime()) / 60_000;
  return {
    active: minutesToKickoff <= leadMinutes,
    forceFinalCheck: minutesToKickoff <= finalCheckMinutes,
    nextKickoffAt: nextKickoff.toISOString(),
  };
}

/** Reads only the current immutable schedule artifact selected by its data-source checksum. */
export class ProjectionLockWindowService {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  async check(season: number, now = new Date()): Promise<ProjectionLockWindowState> {
    if (!Number.isSafeInteger(season) || season < 2000 || season > 2200) {
      throw new RangeError("Projection lock-window season must be between 2000 and 2200");
    }
    const [source] = await this.#database
      .select({ id: dataSources.id, checksum: dataSources.lastChecksum })
      .from(dataSources)
      .where(eq(dataSources.key, `nflverse.schedules.${season}`))
      .limit(1);
    if (!source?.checksum) {
      return { active: false, forceFinalCheck: false, nextKickoffAt: null };
    }
    const games = await this.#database
      .select({
        kickoffAt: nflScheduleObservations.kickoffAt,
        status: nflScheduleObservations.status,
      })
      .from(nflScheduleObservations)
      .where(
        and(
          eq(nflScheduleObservations.sourceId, source.id),
          eq(nflScheduleObservations.inputChecksum, source.checksum),
          eq(nflScheduleObservations.season, season),
          eq(nflScheduleObservations.seasonType, "REG"),
        ),
      );
    return projectionLockWindowState(games, now);
  }
}
