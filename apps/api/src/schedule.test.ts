import { describe, expect, it, vi } from "vitest";

import {
  ScheduleService,
  type ScheduleObservationRow,
  type ScheduleRepository,
  type ScheduleSourceRow,
} from "./schedule.js";

const CHECKSUM = "c".repeat(64);

function source(metadata: ScheduleSourceRow["metadata"] = {}): ScheduleSourceRow {
  return {
    id: "schedule-source",
    key: "nflverse.schedules.2025",
    name: "NFL schedule",
    attribution: "NFL game schedules provided by nflverse (CC BY 4.0)",
    attributionUrl: "https://github.com/nflverse/nflverse-data",
    lastSuccessfulAt: new Date("2026-01-02T03:04:05.000Z"),
    lastChecksum: CHECKSUM,
    metadata: {
      publishable: true,
      rowsRead: 3,
      rowsRejected: 0,
      coveredWeeks: "1,2,3",
      coveredTeams: "AAA,BBB,CCC,DDD",
      ...metadata,
    },
  };
}

function game(
  week: number,
  awayTeam: string,
  homeTeam: string,
  overrides: Partial<ScheduleObservationRow> = {},
): ScheduleObservationRow {
  return {
    externalGameId: `2025_0${week}_${awayTeam}_${homeTeam}`,
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
    awayScore: 20,
    homeScore: 27,
    ...overrides,
  };
}

const GAMES: readonly ScheduleObservationRow[] = [
  game(1, "AAA", "BBB"),
  game(2, "CCC", "DDD"),
  game(3, "BBB", "AAA"),
];

function repository(overrides: Partial<ScheduleRepository> = {}): ScheduleRepository {
  return {
    findSource: () => Promise.resolve(source()),
    listGames: () => Promise.resolve(GAMES),
    ...overrides,
  };
}

function service(repo: ScheduleRepository = repository()): ScheduleService {
  return new ScheduleService(repo, () => new Date("2026-07-25T00:00:00.000Z"));
}

describe("ScheduleService", () => {
  it("returns the season's games with provenance", async () => {
    const result = await service().getSchedule("user", {
      season: 2025,
      week: null,
      team: null,
    });

    expect(result.generatedAt).toBe("2026-07-25T00:00:00.000Z");
    expect(result.games).toHaveLength(3);
    expect(result.source).toMatchObject({
      dataset: "schedule",
      state: "available",
      checksumSha256: CHECKSUM,
      coveredWeeks: [1, 2, 3],
      coveredTeams: ["AAA", "BBB", "CCC", "DDD"],
    });
  });

  it("derives a bye where coverage affirms the team and the week", async () => {
    const result = await service().getSchedule("user", {
      season: 2025,
      week: null,
      team: "AAA",
    });
    const team = result.teams[0];

    expect(result.teams).toHaveLength(1);
    expect(team?.weeks.map((week) => week.state)).toEqual(["game", "bye", "game"]);
    expect(team?.bye).toEqual({ status: "available", byeWeeks: [2], reason: null });
  });

  it("resolves the team's own side of a game", async () => {
    const result = await service().getSchedule("user", { season: 2025, week: 3, team: "AAA" });

    expect(result.teams[0]?.weeks[0]).toMatchObject({
      week: 3,
      state: "game",
      opponent: "BBB",
      venue: "home",
      teamScore: 27,
      opponentScore: 20,
      restDays: 7,
    });
  });

  it("reports a TBD kickoff as TBD instead of inventing a time", async () => {
    const repo = repository({
      listGames: () =>
        Promise.resolve([
          game(1, "AAA", "BBB", { timeTbd: true, startTimeEastern: null, kickoffAt: null }),
        ]),
      findSource: () => Promise.resolve(source({ coveredWeeks: "1" })),
    });
    const result = await service(repo).getSchedule("user", {
      season: 2025,
      week: 1,
      team: null,
    });

    expect(result.games[0]).toMatchObject({
      timeTbd: true,
      startTimeEastern: null,
      kickoffAt: null,
    });
  });

  it("does not read games when the source has not cleared admission", async () => {
    const listGames = vi.fn(() => Promise.resolve(GAMES));
    const repo = repository({
      findSource: () => Promise.resolve(source({ publishable: false })),
      listGames,
    });
    const result = await service(repo).getSchedule("user", {
      season: 2025,
      week: null,
      team: null,
    });

    expect(listGames).not.toHaveBeenCalled();
    expect(result.source.state).toBe("quarantined");
    expect(result.games).toEqual([]);
    expect(result.teams.every((team) => team.bye.status === "unavailable")).toBe(true);
  });

  it("withholds byes when the schedule read rejected rows", async () => {
    const repo = repository({ findSource: () => Promise.resolve(source({ rowsRejected: 2 })) });
    const result = await service(repo).getSchedule("user", {
      season: 2025,
      week: null,
      team: "AAA",
    });
    const team = result.teams[0];

    expect(team?.weeks.some((week) => week.state === "bye")).toBe(false);
    expect(team?.bye.status).toBe("unavailable");
    expect(team?.bye.reason).toContain("rejected rows");
    const unknownWeek = team?.weeks.find((week) => week.state === "unknown");
    expect(unknownWeek?.reason).toContain("rejected rows");
  });

  it("filters to one week while keeping the full season read for bye detection", async () => {
    const listGames = vi.fn(() => Promise.resolve(GAMES));
    const repo = repository({ listGames });
    const result = await service(repo).getSchedule("user", {
      season: 2025,
      week: 2,
      team: "AAA",
    });

    // The read is season-wide; only the response is narrowed.
    expect(listGames).toHaveBeenCalledWith("schedule-source", CHECKSUM, 2025, expect.any(Number));
    expect(result.games).toEqual([]);
    expect(result.teams[0]?.weeks).toHaveLength(1);
    expect(result.teams[0]?.weeks[0]).toMatchObject({ week: 2, state: "bye" });
  });

  it("rejects a team filter that is not an abbreviation", async () => {
    await expect(
      service().getSchedule("user", { season: 2025, week: null, team: "not-a-team" }),
    ).rejects.toThrow(/Invalid schedule team filter/u);
  });
});

describe("ScheduleService.getByeWeeks", () => {
  it("maps only teams with exactly one affirmed bye and explains the rest", async () => {
    const result = await service().getByeWeeks("user", 2025);

    expect(result.byeWeeks).toEqual({ AAA: 2, BBB: 2 });
    // CCC and DDD are idle in two covered weeks, so a single bye is ambiguous.
    expect(result.withheld.map((entry) => entry.team).sort()).toEqual(["CCC", "DDD"]);
    expect(result.withheld[0]?.reason).toContain("more than one idle week");
    expect(result.definition).toContain("not by itself evidence of a bye");
  });

  it("returns no bye map at all when the source is withheld", async () => {
    const repo = repository({ findSource: () => Promise.resolve(source({ publishable: false })) });
    const result = await service(repo).getByeWeeks("user", 2025);

    expect(result.byeWeeks).toEqual({});
    expect(result.withheld).toHaveLength(4);
    expect(result.withheld[0]?.reason).toContain("has not cleared admission");
  });
});
