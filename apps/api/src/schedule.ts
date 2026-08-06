import type {
  ScheduleByesResponse,
  ScheduleGame,
  ScheduleResponse,
  ScheduleSource,
  TeamScheduleEntry,
  TeamScheduleWeekEntry,
} from "@laces-out/contracts";
import { nflScheduleObservations, type Database } from "@laces-out/db";
import {
  buildByeWeekLookup,
  deriveTeamScheduleWeeks,
  type ScheduleCoverage,
  type ScheduleGameObservation,
  type TeamSchedule,
  type TeamScheduleResult,
} from "@laces-out/league-analytics";
import { and, asc, eq } from "drizzle-orm";

import {
  admittedSourceContract,
  metadataCoveredTeams,
  selectAdmittedSource,
  type AdmittedSourceRow,
} from "./admitted-source.js";
import { canonicalNflTeamCode } from "./nfl-team-code.js";

/** One season of regular-season games is a few hundred rows, so the bound is generous. */
const SCHEDULE_ROW_LIMIT = 1_001;
const TEAM_PATTERN = /^[A-Z]{2,4}$/u;

export interface ScheduleQuery {
  readonly season: number;
  readonly week: number | null;
  readonly team: string | null;
}

export type ScheduleSourceRow = AdmittedSourceRow;

export interface ScheduleObservationRow {
  readonly externalGameId: string;
  readonly season: number;
  readonly week: number;
  readonly gameDate: string;
  readonly startTimeEastern: string | null;
  readonly timeTbd: boolean;
  readonly kickoffAt: Date | null;
  readonly awayTeam: string;
  readonly homeTeam: string;
  readonly status: ScheduleGameObservation["status"];
  readonly neutralSite: boolean;
  readonly awayRestDays: number | null;
  readonly homeRestDays: number | null;
  readonly awayScore: number | null;
  readonly homeScore: number | null;
}

export interface ScheduleRepository {
  findSource(key: string): Promise<ScheduleSourceRow | undefined>;
  listGames(
    sourceId: string,
    checksum: string,
    season: number,
    limit: number,
  ): Promise<readonly ScheduleObservationRow[]>;
}

export class DrizzleScheduleRepository implements ScheduleRepository {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  findSource(key: string): Promise<ScheduleSourceRow | undefined> {
    return selectAdmittedSource(this.#database, key);
  }

  /**
   * Reads the whole regular season even when one week is requested. Bye detection compares a
   * team's weeks against the covered range, so narrowing the read to a single week would
   * remove the very rows that prove a team played elsewhere.
   */
  async listGames(
    sourceId: string,
    checksum: string,
    season: number,
    limit: number,
  ): Promise<readonly ScheduleObservationRow[]> {
    return this.#database
      .select({
        externalGameId: nflScheduleObservations.externalGameId,
        season: nflScheduleObservations.season,
        week: nflScheduleObservations.week,
        gameDate: nflScheduleObservations.gameDate,
        startTimeEastern: nflScheduleObservations.startTimeEastern,
        timeTbd: nflScheduleObservations.timeTbd,
        kickoffAt: nflScheduleObservations.kickoffAt,
        awayTeam: nflScheduleObservations.awayTeam,
        homeTeam: nflScheduleObservations.homeTeam,
        status: nflScheduleObservations.status,
        neutralSite: nflScheduleObservations.neutralSite,
        awayRestDays: nflScheduleObservations.awayRestDays,
        homeRestDays: nflScheduleObservations.homeRestDays,
        awayScore: nflScheduleObservations.awayScore,
        homeScore: nflScheduleObservations.homeScore,
      })
      .from(nflScheduleObservations)
      .where(
        and(
          eq(nflScheduleObservations.sourceId, sourceId),
          eq(nflScheduleObservations.inputChecksum, checksum),
          eq(nflScheduleObservations.season, season),
          eq(nflScheduleObservations.seasonType, "REG"),
        ),
      )
      .orderBy(
        asc(nflScheduleObservations.week),
        asc(nflScheduleObservations.gameDate),
        asc(nflScheduleObservations.externalGameId),
      )
      .limit(limit);
  }
}

function sourceContract(
  key: string,
  source: ScheduleSourceRow | undefined,
  boundExceeded: boolean,
): ScheduleSource {
  const base = admittedSourceContract("schedule", key, "NFL schedule", source);
  return {
    dataset: "schedule",
    state: boundExceeded ? "unavailable" : base.state,
    key: base.key,
    name: base.name,
    attribution: base.attribution,
    attributionUrl: base.attributionUrl,
    fetchedAt: base.fetchedAt,
    checksumSha256: base.checksumSha256,
    coveredWeeks: base.coveredWeeks,
    coveredTeams: source
      ? [...new Set(metadataCoveredTeams(source.metadata).map(canonicalNflTeamCode))]
      : [],
    quality: { rowsRead: base.quality.rowsRead, rowsRejected: base.quality.rowsRejected },
    reason: boundExceeded
      ? "The schedule for this season exceeded the safe query bound."
      : base.reason,
  };
}

function gameContract(row: ScheduleObservationRow): ScheduleGame {
  return {
    gameId: row.externalGameId,
    week: row.week,
    gameDate: row.gameDate,
    startTimeEastern: row.startTimeEastern,
    timeTbd: row.timeTbd,
    kickoffAt: row.kickoffAt?.toISOString() ?? null,
    awayTeam: canonicalNflTeamCode(row.awayTeam),
    homeTeam: canonicalNflTeamCode(row.homeTeam),
    status: row.status,
    neutralSite: row.neutralSite,
    awayScore: row.awayScore,
    homeScore: row.homeScore,
  };
}

function weekContract(entry: TeamSchedule["weeks"][number]): TeamScheduleWeekEntry {
  if (entry.state === "game") {
    return {
      week: entry.week,
      state: "game",
      reason: null,
      opponent: entry.game.opponent,
      venue: entry.game.venue,
      gameId: entry.game.externalGameId,
      kickoffAt: entry.game.kickoffAt?.toISOString() ?? null,
      timeTbd: entry.game.timeTbd,
      status: entry.game.status,
      restDays: entry.game.restDays,
      teamScore: entry.game.teamScore,
      opponentScore: entry.game.opponentScore,
    };
  }
  return {
    week: entry.week,
    state: entry.state,
    reason: entry.state === "unknown" ? entry.reason : null,
    opponent: null,
    venue: null,
    gameId: null,
    kickoffAt: null,
    timeTbd: false,
    status: null,
    restDays: null,
    teamScore: null,
    opponentScore: null,
  };
}

function teamContract(team: TeamSchedule): TeamScheduleEntry {
  return {
    team: team.team,
    weeks: team.weeks.map(weekContract),
    bye: {
      status: team.bye.status,
      byeWeeks: [...team.bye.byeWeeks],
      reason: team.bye.status === "unavailable" ? team.bye.reason : null,
    },
  };
}

export class ScheduleService {
  readonly #repository: ScheduleRepository;
  readonly #now: () => Date;

  constructor(repository: ScheduleRepository, now: () => Date = () => new Date()) {
    this.#repository = repository;
    this.#now = now;
  }

  async #load(season: number): Promise<{
    readonly source: ScheduleSource;
    readonly games: readonly ScheduleObservationRow[];
    readonly derived: TeamScheduleResult;
  }> {
    const key = `nflverse.schedules.${season}`;
    const sourceRow = await this.#repository.findSource(key);
    const admitted = admittedSourceContract("schedule", key, "NFL schedule", sourceRow);
    const games =
      admitted.state === "available" && sourceRow?.lastChecksum
        ? await this.#repository.listGames(
            sourceRow.id,
            sourceRow.lastChecksum,
            season,
            SCHEDULE_ROW_LIMIT,
          )
        : [];
    const boundExceeded = games.length >= SCHEDULE_ROW_LIMIT;
    const usable = boundExceeded ? [] : games;
    const source = sourceContract(key, sourceRow, boundExceeded);
    const coverage: ScheduleCoverage = {
      publishable: source.state === "available",
      coveredWeeks: source.coveredWeeks,
      coveredTeams: source.coveredTeams,
      rowsRejected: source.quality.rowsRejected,
    };
    const derived = deriveTeamScheduleWeeks({
      season,
      games: usable.map((row): ScheduleGameObservation => ({
        externalGameId: row.externalGameId,
        season: row.season,
        week: row.week,
        gameDate: row.gameDate,
        startTimeEastern: row.startTimeEastern,
        timeTbd: row.timeTbd,
        kickoffAt: row.kickoffAt,
        awayTeam: canonicalNflTeamCode(row.awayTeam),
        homeTeam: canonicalNflTeamCode(row.homeTeam),
        status: row.status,
        neutralSite: row.neutralSite,
        awayRestDays: row.awayRestDays,
        homeRestDays: row.homeRestDays,
        awayScore: row.awayScore,
        homeScore: row.homeScore,
      })),
      coverage,
    });
    return { source, games: usable, derived };
  }

  async getSchedule(query: ScheduleQuery): Promise<ScheduleResponse> {
    const team = query.team ? canonicalNflTeamCode(query.team) : null;
    if (team && !TEAM_PATTERN.test(team)) throw new Error("Invalid schedule team filter");
    const { source, games, derived } = await this.#load(query.season);
    const visibleGames = games.filter(
      (row) =>
        (query.week === null || row.week === query.week) &&
        (team === null ||
          canonicalNflTeamCode(row.awayTeam) === team ||
          canonicalNflTeamCode(row.homeTeam) === team),
    );
    const visibleTeams = derived.teams
      .filter((entry) => team === null || entry.team === team)
      .map(teamContract)
      .map((entry) =>
        query.week === null
          ? entry
          : { ...entry, weeks: entry.weeks.filter((week) => week.week === query.week) },
      );

    return {
      generatedAt: this.#now().toISOString(),
      filters: { season: query.season, week: query.week, team },
      source,
      games: visibleGames.map(gameContract),
      teams: visibleTeams,
      definitions: derived.definitions,
    };
  }

  /** The team-to-bye map other surfaces join on, with no response envelope around it. */
  async byeWeekLookup(season: number): Promise<ReadonlyMap<string, number>> {
    const { derived } = await this.#load(season);
    return buildByeWeekLookup(derived);
  }

  async getByeWeeks(season: number): Promise<ScheduleByesResponse> {
    const { source, derived } = await this.#load(season);
    const lookup = buildByeWeekLookup(derived);
    const byeWeeks: Record<string, number> = {};
    for (const [team, week] of lookup) byeWeeks[team] = week;
    const withheld = derived.teams.flatMap((team) =>
      lookup.has(team.team)
        ? []
        : [
            {
              team: team.team,
              reason:
                team.bye.status === "unavailable"
                  ? team.bye.reason
                  : team.bye.byeWeeks.length === 0
                    ? "The admitted schedule shows no idle week for this team."
                    : "The admitted schedule shows more than one idle week, so a single bye is ambiguous.",
            },
          ],
    );

    return {
      generatedAt: this.#now().toISOString(),
      season,
      source,
      byeWeeks,
      withheld,
      definition: derived.definitions.bye,
    };
  }
}
