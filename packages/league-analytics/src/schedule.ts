import { assertUniqueStrings, sortedUniqueNumbers } from "./shared.js";

export type ScheduleGameStatus = "scheduled" | "in-progress" | "final" | "postponed" | "cancelled";

/** A stored schedule observation, shaped as the admitted row rather than the fetch payload. */
export interface ScheduleGameObservation {
  readonly externalGameId: string;
  readonly season: number;
  readonly week: number;
  readonly gameDate: string;
  readonly startTimeEastern: string | null;
  readonly timeTbd: boolean;
  readonly kickoffAt: Date | null;
  readonly awayTeam: string;
  readonly homeTeam: string;
  readonly status: ScheduleGameStatus;
  readonly neutralSite: boolean;
  readonly awayRestDays: number | null;
  readonly homeRestDays: number | null;
  readonly awayScore: number | null;
  readonly homeScore: number | null;
}

/**
 * What the admitted artifact affirms about its own completeness. A missing game row is only
 * evidence of a bye when the team and week are both inside affirmed coverage and the read
 * rejected nothing; otherwise the absence is equally consistent with a partial ingest.
 */
export interface ScheduleCoverage {
  readonly publishable: boolean;
  readonly coveredWeeks: readonly number[];
  readonly coveredTeams: readonly string[];
  readonly rowsRejected: number | null;
}

export interface TeamScheduleGame {
  readonly externalGameId: string;
  readonly week: number;
  readonly gameDate: string;
  readonly startTimeEastern: string | null;
  readonly timeTbd: boolean;
  readonly kickoffAt: Date | null;
  readonly opponent: string;
  readonly venue: "home" | "away" | "neutral";
  readonly status: ScheduleGameStatus;
  readonly restDays: number | null;
  readonly teamScore: number | null;
  readonly opponentScore: number | null;
}

export type TeamScheduleWeek =
  | { readonly state: "game"; readonly week: number; readonly game: TeamScheduleGame }
  | { readonly state: "bye"; readonly week: number }
  | { readonly state: "unknown"; readonly week: number; readonly reason: string };

export type TeamByeSummary =
  | { readonly status: "available"; readonly byeWeeks: readonly number[] }
  | {
      readonly status: "unavailable";
      readonly byeWeeks: readonly number[];
      readonly reason: string;
    };

export interface TeamSchedule {
  readonly team: string;
  readonly weeks: readonly TeamScheduleWeek[];
  readonly bye: TeamByeSummary;
}

export interface TeamScheduleResult {
  readonly season: number;
  readonly coveredWeeks: readonly number[];
  readonly teams: readonly TeamSchedule[];
  readonly definitions: {
    readonly bye: string;
    readonly venue: string;
  };
}

const BYE_DEFINITION =
  "A bye is reported only where the admitted schedule covers both the team and the week and the source read rejected no rows. Any other missing game is reported as unknown, because an absent row is not by itself evidence of a bye.";
const VENUE_DEFINITION =
  "Venue is home, away, or neutral, taken from the stored neutral-site flag rather than inferred from the teams.";

const TEAM_PATTERN = /^[A-Z]{2,4}$/u;

function validate(games: readonly ScheduleGameObservation[], season: number): void {
  if (!Number.isInteger(season) || season < 1999 || season > 2200) {
    throw new RangeError("season must be an integer between 1999 and 2200");
  }
  const seen = new Set<string>();
  for (const game of games) {
    if (game.season !== season) throw new Error("schedule game season does not match the input");
    if (!Number.isInteger(game.week) || game.week < 1 || game.week > 25) {
      throw new RangeError("schedule game week must be an integer between 1 and 25");
    }
    if (!TEAM_PATTERN.test(game.awayTeam) || !TEAM_PATTERN.test(game.homeTeam)) {
      throw new Error("schedule game teams must be uppercase abbreviations");
    }
    if (game.awayTeam === game.homeTeam) {
      throw new Error("a schedule game cannot list the same team twice");
    }
    if (seen.has(game.externalGameId)) {
      throw new Error(`Duplicate schedule game ${game.externalGameId}`);
    }
    seen.add(game.externalGameId);
  }
}

function teamGame(game: ScheduleGameObservation, team: "home" | "away"): TeamScheduleGame {
  const isHome = team === "home";
  return {
    externalGameId: game.externalGameId,
    week: game.week,
    gameDate: game.gameDate,
    startTimeEastern: game.startTimeEastern,
    timeTbd: game.timeTbd,
    kickoffAt: game.kickoffAt,
    opponent: isHome ? game.awayTeam : game.homeTeam,
    venue: game.neutralSite ? "neutral" : isHome ? "home" : "away",
    status: game.status,
    restDays: isHome ? game.homeRestDays : game.awayRestDays,
    teamScore: isHome ? game.homeScore : game.awayScore,
    opponentScore: isHome ? game.awayScore : game.homeScore,
  };
}

/** Two rows per game, which is the shape team-centric reads and bye detection both need. */
export function expandTeamScheduleGames(
  games: readonly ScheduleGameObservation[],
): readonly { readonly team: string; readonly game: TeamScheduleGame }[] {
  return games.flatMap((game) => [
    { team: game.homeTeam, game: teamGame(game, "home") },
    { team: game.awayTeam, game: teamGame(game, "away") },
  ]);
}

export interface DeriveTeamScheduleWeeksInput {
  readonly season: number;
  readonly games: readonly ScheduleGameObservation[];
  readonly coverage: ScheduleCoverage;
  /** Restricts the output to these teams; defaults to every team the coverage affirms. */
  readonly teams?: readonly string[];
}

export function deriveTeamScheduleWeeks(input: DeriveTeamScheduleWeeksInput): TeamScheduleResult {
  const { season, games, coverage } = input;
  validate(games, season);
  assertUniqueStrings([...coverage.coveredTeams], "coveredTeams");

  const coveredWeeks = sortedUniqueNumbers([...coverage.coveredWeeks]);
  const coveredTeams = new Set(coverage.coveredTeams);
  const readIsClean = coverage.rowsRejected === 0;
  const gamesByTeam = new Map<string, TeamScheduleGame[]>();
  for (const { team, game } of expandTeamScheduleGames(games)) {
    const existing = gamesByTeam.get(team);
    if (existing) existing.push(game);
    else gamesByTeam.set(team, [game]);
  }

  const requestedTeams = input.teams
    ? [...new Set(input.teams.map((team) => team.toUpperCase()))]
    : [...new Set([...coveredTeams, ...gamesByTeam.keys()])];
  const teams = requestedTeams.sort((left, right) => left.localeCompare(right));

  // One withholding reason serves every week for a team, so compute it once.
  const withholdReason = (team: string): string | null => {
    if (!coverage.publishable) {
      return "The admitted schedule has not cleared admission, so no bye can be asserted.";
    }
    if (!readIsClean) {
      return "The schedule read rejected rows, so a missing game cannot be distinguished from a bye.";
    }
    if (!coveredTeams.has(team)) {
      return "The admitted schedule does not affirm coverage for this team.";
    }
    return null;
  };

  return {
    season,
    coveredWeeks,
    teams: teams.map((team): TeamSchedule => {
      const teamGames = new Map(
        (gamesByTeam.get(team) ?? []).map((game) => [game.week, game] as const),
      );
      const reason = withholdReason(team);
      const weeks = coveredWeeks.map((week): TeamScheduleWeek => {
        const game = teamGames.get(week);
        if (game) return { state: "game", week, game };
        if (reason) return { state: "unknown", week, reason };
        return { state: "bye", week };
      });
      const byeWeeks = weeks.flatMap((entry) => (entry.state === "bye" ? [entry.week] : []));
      return {
        team,
        weeks,
        bye: reason
          ? { status: "unavailable", byeWeeks, reason }
          : { status: "available", byeWeeks },
      };
    }),
    definitions: { bye: BYE_DEFINITION, venue: VENUE_DEFINITION },
  };
}

/**
 * A team-to-bye lookup for consumers that only need the number, such as a draft board.
 * Teams whose bye cannot be affirmed are absent rather than defaulted.
 */
export function buildByeWeekLookup(result: TeamScheduleResult): ReadonlyMap<string, number> {
  const lookup = new Map<string, number>();
  for (const team of result.teams) {
    // Exactly one affirmed bye is the only unambiguous answer to "what is the bye week".
    if (team.bye.status === "available" && team.bye.byeWeeks.length === 1) {
      lookup.set(team.team, team.bye.byeWeeks[0]!);
    }
  }
  return lookup;
}
