import { describe, expect, it } from "vitest";

import {
  buildByeWeekLookup,
  deriveTeamScheduleWeeks,
  expandTeamScheduleGames,
  type ScheduleCoverage,
  type ScheduleGameObservation,
} from "./schedule.js";

function game(
  week: number,
  awayTeam: string,
  homeTeam: string,
  overrides: Partial<ScheduleGameObservation> = {},
): ScheduleGameObservation {
  return {
    externalGameId: `2025_${String(week).padStart(2, "0")}_${awayTeam}_${homeTeam}`,
    season: 2025,
    week,
    gameDate: "2025-09-07",
    startTimeEastern: "13:00",
    timeTbd: false,
    kickoffAt: new Date("2025-09-07T17:00:00.000Z"),
    awayTeam,
    homeTeam,
    status: "final",
    neutralSite: false,
    awayRestDays: 7,
    homeRestDays: 7,
    awayScore: 17,
    homeScore: 24,
    ...overrides,
  };
}

function coverage(overrides: Partial<ScheduleCoverage> = {}): ScheduleCoverage {
  return {
    publishable: true,
    coveredWeeks: [1, 2, 3],
    coveredTeams: ["AAA", "BBB", "CCC", "DDD"],
    rowsRejected: 0,
    ...overrides,
  };
}

/** Weeks 1 and 3 pair AAA with BBB; week 2 is AAA's only missing week. */
const GAMES: readonly ScheduleGameObservation[] = [
  game(1, "AAA", "BBB"),
  game(2, "CCC", "DDD"),
  game(3, "BBB", "AAA"),
];

function teamFor(team: string, games = GAMES, cover = coverage()) {
  const result = deriveTeamScheduleWeeks({ season: 2025, games, coverage: cover });
  const found = result.teams.find((entry) => entry.team === team);
  if (!found) throw new Error(`expected a schedule for ${team}`);
  return found;
}

describe("deriveTeamScheduleWeeks", () => {
  it("reports a bye where affirmed coverage leaves a week with no game", () => {
    const team = teamFor("AAA");

    expect(team.weeks.map((week) => week.state)).toEqual(["game", "bye", "game"]);
    expect(team.bye).toEqual({ status: "available", byeWeeks: [2] });
  });

  it("does not assert a bye for a team the coverage omits", () => {
    const team = teamFor("AAA", GAMES, coverage({ coveredTeams: ["BBB", "CCC", "DDD"] }));

    expect(team.weeks.map((week) => week.state)).toEqual(["game", "unknown", "game"]);
    expect(team.bye.status).toBe("unavailable");
    expect(team.bye.byeWeeks).toEqual([]);
    if (team.bye.status !== "unavailable") throw new Error("expected a withheld bye");
    expect(team.bye.reason).toContain("does not affirm coverage for this team");
  });

  it("only derives weeks the coverage affirms", () => {
    const team = teamFor("AAA", GAMES, coverage({ coveredWeeks: [1, 3] }));

    // Week 2 is outside coverage, so it is not a bye and not even reported.
    expect(team.weeks.map((week) => week.week)).toEqual([1, 3]);
    expect(team.bye).toEqual({ status: "available", byeWeeks: [] });
  });

  it("withholds every bye when the read rejected rows", () => {
    const team = teamFor("AAA", GAMES, coverage({ rowsRejected: 3 }));

    expect(team.weeks.every((week) => week.state !== "bye")).toBe(true);
    if (team.bye.status !== "unavailable") throw new Error("expected a withheld bye");
    expect(team.bye.reason).toContain("rejected rows");
  });

  it("withholds every bye when the source is not publishable", () => {
    const result = deriveTeamScheduleWeeks({
      season: 2025,
      games: GAMES,
      coverage: coverage({ publishable: false }),
    });

    expect(result.teams.every((team) => team.weeks.every((week) => week.state !== "bye"))).toBe(
      true,
    );
    expect(result.teams.every((team) => team.bye.status === "unavailable")).toBe(true);
  });

  it("keeps the withheld reason distinguishable from a real bye", () => {
    const unknown = teamFor("AAA", GAMES, coverage({ rowsRejected: 1 })).weeks.find(
      (week) => week.week === 2,
    );

    expect(unknown?.state).toBe("unknown");
    if (unknown?.state !== "unknown") throw new Error("expected an unknown week");
    expect(unknown.reason.length).toBeGreaterThan(0);
  });

  it("resolves opponent, venue, rest, and score from the team's side of the game", () => {
    const week3 = teamFor("AAA").weeks.find((week) => week.week === 3);

    if (week3?.state !== "game") throw new Error("expected a game in week 3");
    expect(week3.game).toMatchObject({
      opponent: "BBB",
      venue: "home",
      teamScore: 24,
      opponentScore: 17,
      restDays: 7,
    });
  });

  it("marks a neutral-site game as neutral for both teams", () => {
    const games = [game(1, "AAA", "BBB", { neutralSite: true })];
    const result = deriveTeamScheduleWeeks({
      season: 2025,
      games,
      coverage: coverage({ coveredWeeks: [1] }),
    });

    for (const team of ["AAA", "BBB"]) {
      const week = result.teams.find((entry) => entry.team === team)?.weeks[0];
      if (week?.state !== "game") throw new Error("expected a game");
      expect(week.game.venue).toBe("neutral");
    }
  });

  it("preserves a TBD kickoff rather than inventing a time", () => {
    const games = [
      game(1, "AAA", "BBB", { timeTbd: true, startTimeEastern: null, kickoffAt: null }),
    ];
    const result = deriveTeamScheduleWeeks({
      season: 2025,
      games,
      coverage: coverage({ coveredWeeks: [1] }),
    });
    const week = result.teams.find((entry) => entry.team === "AAA")?.weeks[0];

    if (week?.state !== "game") throw new Error("expected a game");
    expect(week.game).toMatchObject({ timeTbd: true, startTimeEastern: null, kickoffAt: null });
  });

  it("rejects a duplicated game and a self-matchup", () => {
    expect(() =>
      deriveTeamScheduleWeeks({
        season: 2025,
        games: [game(1, "AAA", "BBB"), game(1, "AAA", "BBB")],
        coverage: coverage(),
      }),
    ).toThrow(/Duplicate schedule game/u);
    expect(() =>
      deriveTeamScheduleWeeks({
        season: 2025,
        games: [game(1, "AAA", "AAA")],
        coverage: coverage(),
      }),
    ).toThrow(/same team twice/u);
  });

  it("rejects games from another season", () => {
    expect(() =>
      deriveTeamScheduleWeeks({
        season: 2025,
        games: [game(1, "AAA", "BBB", { season: 2024 })],
        coverage: coverage(),
      }),
    ).toThrow(/season does not match/u);
  });
});

describe("expandTeamScheduleGames", () => {
  it("emits one row per team per game", () => {
    const rows = expandTeamScheduleGames([game(1, "AAA", "BBB")]);

    expect(rows.map((row) => row.team).sort()).toEqual(["AAA", "BBB"]);
    expect(rows.find((row) => row.team === "AAA")?.game.venue).toBe("away");
    expect(rows.find((row) => row.team === "BBB")?.game.venue).toBe("home");
  });
});

describe("buildByeWeekLookup", () => {
  it("includes only teams with exactly one affirmed bye", () => {
    const result = deriveTeamScheduleWeeks({
      season: 2025,
      games: GAMES,
      coverage: coverage(),
    });
    const lookup = buildByeWeekLookup(result);

    expect(lookup.get("AAA")).toBe(2);
    // CCC and DDD are idle in weeks 1 and 3, which is two byes and therefore ambiguous.
    expect(lookup.has("CCC")).toBe(false);
  });

  it("omits teams whose bye is withheld", () => {
    const result = deriveTeamScheduleWeeks({
      season: 2025,
      games: GAMES,
      coverage: coverage({ rowsRejected: 2 }),
    });

    expect(buildByeWeekLookup(result).size).toBe(0);
  });
});
