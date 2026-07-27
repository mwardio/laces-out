import { scheduleEdgeMatrixResponseSchema, scheduleEdgeResponseSchema } from "@fantasy/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  ScheduleEdgeService,
  resolveScheduleEdgeWindows,
  type ScheduleEdgeRepository,
  type ScheduleEdgeScheduleRow,
  type ScheduleEdgeSourceRow,
  type ScheduleEdgeWeeklyRosterRow,
  type ScheduleEdgeWeeklyStatRow,
} from "./schedule-edge.js";

const LEAGUE_ID = "20000000-0000-4000-8000-000000000001";
const SEASON_ID = "30000000-0000-4000-8000-000000000001";
const TEAM_ID = "40000000-0000-4000-8000-000000000001";
const ROSTER_ID = "50000000-0000-4000-8000-000000000001";
const PLAYER_ID = "60000000-0000-4000-8000-000000000001";
const BACKUP_ID = "60000000-0000-4000-8000-000000000002";
const PROJECTION_ID = "70000000-0000-4000-8000-000000000001";
const CHECKSUM = "a".repeat(64);

function source(key: string): ScheduleEdgeSourceRow {
  return {
    id: `source:${key}`,
    key,
    name: key,
    attribution: "nflverse",
    attributionUrl: "https://github.com/nflverse",
    lastSuccessfulAt: new Date("2026-09-15T10:00:00.000Z"),
    lastChecksum: CHECKSUM,
    metadata: {
      publishable: true,
      coveredWeeks: "1,2,3,4,5,6",
      coveredTeams: "BUF,MIA,NE,NYJ",
      rowsRead: 10,
      rowsRejected: 0,
      rowsUnmatched: 0,
      matchRate: 1,
    },
  };
}

const currentSchedule: ScheduleEdgeScheduleRow[] = [
  {
    gameId: "2026-01-MIA-NE",
    season: 2026,
    week: 1,
    gameDate: "2026-09-10",
    startTimeEastern: "20:20",
    timeTbd: false,
    kickoffAt: new Date("2026-09-11T00:20:00.000Z"),
    awayTeam: "MIA",
    homeTeam: "NE",
    status: "final",
    neutralSite: false,
    awayRestDays: 7,
    homeRestDays: 7,
    awayScore: 24,
    homeScore: 17,
  },
  ...[3, 4, 5].map((week): ScheduleEdgeScheduleRow => ({
    gameId: `2026-${week}-MIA-BUF`,
    season: 2026,
    week,
    gameDate: `2026-10-${week + 1}`,
    startTimeEastern: "13:00",
    timeTbd: false,
    kickoffAt: new Date(`2026-10-0${week + 1}T17:00:00.000Z`),
    awayTeam: "MIA",
    homeTeam: "BUF",
    status: "scheduled",
    neutralSite: false,
    awayRestDays: 7,
    homeRestDays: 7,
    awayScore: null,
    homeScore: null,
  })),
  {
    gameId: "2026-06-BUF-NYJ",
    season: 2026,
    week: 6,
    gameDate: "2026-10-11",
    startTimeEastern: "13:00",
    timeTbd: false,
    kickoffAt: new Date("2026-10-11T17:00:00.000Z"),
    awayTeam: "BUF",
    homeTeam: "NYJ",
    status: "scheduled",
    neutralSite: false,
    awayRestDays: 7,
    homeRestDays: 7,
    awayScore: null,
    homeScore: null,
  },
];

function finalGame(season: number): ScheduleEdgeScheduleRow {
  return {
    ...currentSchedule[0]!,
    gameId: `${season}-01-MIA-NE`,
    season,
    gameDate: `${season}-09-10`,
    kickoffAt: new Date(`${season}-09-11T00:20:00.000Z`),
  };
}

function weeklyStats(season: number): ScheduleEdgeWeeklyStatRow[] {
  return [
    {
      externalPlayerId: `${season}:mia-qb`,
      playerId: PLAYER_ID,
      season,
      week: 1,
      gameId: `${season}-01-MIA-NE`,
      team: "MIA",
      opponentTeam: "NE",
      components: { passing_yards: 250 },
    },
    {
      externalPlayerId: `${season}:ne-qb`,
      playerId: "60000000-0000-4000-8000-000000000003",
      season,
      week: 1,
      gameId: `${season}-01-MIA-NE`,
      team: "NE",
      opponentTeam: "MIA",
      components: { passing_yards: 225 },
    },
  ];
}

function weeklyRosters(season: number): ScheduleEdgeWeeklyRosterRow[] {
  return weeklyStats(season).map((row) => ({
    externalPlayerId: row.externalPlayerId,
    playerId: row.playerId,
    season,
    week: 1,
    team: row.team,
    position: "QB",
    rosterStatus: "ACT",
    statusDescription: null,
  }));
}

function repository(): ScheduleEdgeRepository {
  return {
    findMembership: (_userId, leagueId) =>
      Promise.resolve(
        leagueId === LEAGUE_ID
          ? {
              leagueId: LEAGUE_ID,
              leagueName: "Test League",
              role: "manager",
              claimedFantasyTeamId: TEAM_ID,
            }
          : undefined,
      ),
    findLatestSeason: () =>
      Promise.resolve({
        id: SEASON_ID,
        provider: "espn",
        season: 2026,
        currentWeek: 3,
        settings: {
          playoffTeamCount: 6,
          operationalRules: {
            regularSeasonMatchupPeriods: 14,
            playoffMatchupPeriodLength: 1,
          },
        },
        lastSyncedAt: new Date("2026-09-15T10:00:00.000Z"),
      }),
    findTeam: () => Promise.resolve({ id: TEAM_ID, name: "Fourth & Long" }),
    findLatestRosterSnapshot: () =>
      Promise.resolve({
        id: ROSTER_ID,
        effectiveAt: new Date("2026-09-15T10:00:00.000Z"),
      }),
    listRosterEntries: () =>
      Promise.resolve([
        {
          playerId: PLAYER_ID,
          name: "Miami Starter",
          primaryPosition: "QB",
          eligiblePositions: ["QB"],
          nflTeam: "MIA",
          status: "ACTIVE",
          slotCode: "QB",
          isStarter: true,
        },
        {
          playerId: BACKUP_ID,
          name: "Buffalo Backup",
          primaryPosition: "QB",
          eligiblePositions: ["QB"],
          nflTeam: "BUF",
          status: "ACTIVE",
          slotCode: "BE",
          isStarter: false,
        },
      ]),
    listSlotRules: () =>
      Promise.resolve([
        {
          id: "slot-rule",
          slotCode: "QB",
          count: 1,
          eligiblePositions: ["QB"],
          isStarter: true,
        },
      ]),
    listScoringRules: () =>
      Promise.resolve([
        {
          statKey: "3",
          operation: "multiply",
          points: "0.04",
          thresholdLow: null,
          thresholdHigh: null,
          providerStatId: "3",
        },
      ]),
    findSource: (key) => Promise.resolve(source(key)),
    listScheduleGames: (_sourceId, _checksum, season) =>
      Promise.resolve(season === 2026 ? currentSchedule : [finalGame(2025)]),
    listWeeklyStats: (_sourceId, _checksum, season) => Promise.resolve(weeklyStats(season)),
    listWeeklyRosters: (_sourceId, _checksum, season) => Promise.resolve(weeklyRosters(season)),
    listProjectionSets: () =>
      Promise.resolve([
        {
          id: PROJECTION_ID,
          createdByUserId: "10000000-0000-4000-8000-000000000001",
          visibility: "private",
          source: "user-csv",
          version: "1",
          season: 2026,
          week: 3,
          horizon: "week",
          windowStartWeek: 3,
          windowEndWeek: 3,
          fetchedAt: new Date("2026-09-15T08:00:00.000Z"),
          createdAt: new Date("2026-09-15T08:05:00.000Z"),
          inputChecksum: `sha256:${CHECKSUM}`,
          metadata: {},
        },
      ]),
    listProjectionRows: (_setIds, playerIds) =>
      Promise.resolve(
        playerIds.includes(PLAYER_ID)
          ? [{ projectionSetId: PROJECTION_ID, playerId: PLAYER_ID, meanPoints: "18.5" }]
          : [],
      ),
  };
}

describe("resolveScheduleEdgeWindows", () => {
  it("starts the default research window at the current week", () => {
    expect(
      resolveScheduleEdgeWindows(
        6,
        {},
        {
          startWeek: null,
          endWeek: null,
          playoffStartWeek: null,
          playoffEndWeek: null,
        },
      ),
    ).toEqual({
      selected: {
        startWeek: 6,
        endWeek: 9,
        label: "Weeks 6–9",
        source: "current-week",
      },
      playoff: {
        startWeek: 15,
        endWeek: 17,
        label: "Weeks 15–17",
        source: "fallback",
      },
    });
  });

  it("uses complete, bounded provider playoff rules", () => {
    expect(
      resolveScheduleEdgeWindows(
        4,
        {
          playoffTeamCount: 6,
          operationalRules: {
            regularSeasonMatchupPeriods: 14,
            playoffMatchupPeriodLength: 1,
          },
        },
        {
          startWeek: null,
          endWeek: null,
          playoffStartWeek: null,
          playoffEndWeek: null,
        },
      ).playoff,
    ).toEqual({
      startWeek: 15,
      endWeek: 17,
      label: "Weeks 15–17",
      source: "provider",
    });
  });

  it("does not infer a provider playoff window from partial or impossible rules", () => {
    for (const settings of [
      {
        playoffTeamCount: 6,
        operationalRules: { regularSeasonMatchupPeriods: 14 },
      },
      {
        playoffTeamCount: 16,
        operationalRules: {
          regularSeasonMatchupPeriods: 16,
          playoffMatchupPeriodLength: 2,
        },
      },
    ]) {
      expect(
        resolveScheduleEdgeWindows(4, settings, {
          startWeek: null,
          endWeek: null,
          playoffStartWeek: null,
          playoffEndWeek: null,
        }).playoff.source,
      ).toBe("fallback");
    }
  });

  it("honors explicit member windows", () => {
    expect(
      resolveScheduleEdgeWindows(
        6,
        {},
        {
          startWeek: 10,
          endWeek: 12,
          playoffStartWeek: 14,
          playoffEndWeek: 18,
        },
      ),
    ).toEqual({
      selected: {
        startWeek: 10,
        endWeek: 12,
        label: "Weeks 10–12",
        source: "request",
      },
      playoff: {
        startWeek: 14,
        endWeek: 18,
        label: "Weeks 14–18",
        source: "request",
      },
    });
  });

  it("labels the Week 1 preseason default as a fallback, not a provider current week", () => {
    for (const currentWeek of [null, 0, 19]) {
      expect(
        resolveScheduleEdgeWindows(
          currentWeek,
          {},
          {
            startWeek: null,
            endWeek: null,
            playoffStartWeek: null,
            playoffEndWeek: null,
          },
        ).selected,
      ).toEqual({
        startWeek: 1,
        endWeek: 4,
        label: "Weeks 1–4",
        source: "fallback",
      });
    }
  });
});

describe("ScheduleEdgeService", () => {
  it("assembles a bounded member response and passes only claimed-roster IDs to projections", async () => {
    const base = repository();
    const listProjectionRows = vi.fn(
      (...args: Parameters<ScheduleEdgeRepository["listProjectionRows"]>) =>
        base.listProjectionRows(...args),
    );
    const service = new ScheduleEdgeService(
      { ...base, listProjectionRows },
      () => new Date("2026-09-16T12:00:00.000Z"),
    );
    const response = await service.getRosterEdge(
      "10000000-0000-4000-8000-000000000001",
      LEAGUE_ID,
      {
        startWeek: 3,
        endWeek: 6,
        playoffStartWeek: null,
        playoffEndWeek: null,
      },
    );

    expect(() => scheduleEdgeResponseSchema.parse(response)).not.toThrow();
    expect(response).toMatchObject({
      league: {
        id: LEAGUE_ID,
        claimedTeam: { id: TEAM_ID, name: "Fourth & Long" },
      },
      algorithm: { validationStatus: "descriptive-only" },
      availability: {
        scoring: { state: "available" },
        roster: { state: "available" },
        byeFeasibility: { state: "available" },
      },
    });
    expect(response?.roster.map((player) => player.playerId)).toEqual([PLAYER_ID, BACKUP_ID]);
    expect(
      response?.roster.find((player) => player.playerId === PLAYER_ID)?.projection,
    ).toMatchObject({ weeklyPoints: 18.5, rosPoints: null });
    for (const player of response?.roster ?? []) {
      if (player.matchup.state === "available") {
        expect(player.matchup.confidence).toBe("low");
      }
      expect(
        player.selectedWindow.weeks
          .filter((week) => week.state === "game" && week.confidence !== "unavailable")
          .every((week) => week.confidence === "low"),
      ).toBe(true);
    }
    expect(listProjectionRows).toHaveBeenCalledWith([PROJECTION_ID], [PLAYER_ID, BACKUP_ID], 161);
    expect(response?.byeWeeks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          week: 6,
          status: "thin",
          affectedPlayers: [expect.objectContaining({ playerId: PLAYER_ID })],
        }),
      ]),
    );
    const linkedFindings = response?.findings.filter((finding) => finding.href !== null) ?? [];
    expect(linkedFindings.length).toBeGreaterThan(0);
    expect(linkedFindings.every((finding) => finding.href?.startsWith("/decisions?league="))).toBe(
      true,
    );
  });

  it("keeps the matrix member-independent and does not read a roster or private projections", async () => {
    const base = repository();
    const listRosterEntries = vi.fn(
      (...args: Parameters<ScheduleEdgeRepository["listRosterEntries"]>) =>
        base.listRosterEntries(...args),
    );
    const listProjectionSets = vi.fn(
      (...args: Parameters<ScheduleEdgeRepository["listProjectionSets"]>) =>
        base.listProjectionSets(...args),
    );
    const service = new ScheduleEdgeService(
      { ...base, listRosterEntries, listProjectionSets },
      () => new Date("2026-09-16T12:00:00.000Z"),
    );
    const first = await service.getMatrix("10000000-0000-4000-8000-000000000001", LEAGUE_ID, {
      startWeek: 3,
      endWeek: 6,
      playoffStartWeek: null,
      playoffEndWeek: null,
    });
    const second = await service.getMatrix("10000000-0000-4000-8000-000000000002", LEAGUE_ID, {
      startWeek: 3,
      endWeek: 6,
      playoffStartWeek: null,
      playoffEndWeek: null,
    });

    expect(() => scheduleEdgeMatrixResponseSchema.parse(first)).not.toThrow();
    expect(first?.algorithm.inputHash).toBe(second?.algorithm.inputHash);
    expect(first?.teams).toHaveLength(32);
    expect(listRosterEntries).not.toHaveBeenCalled();
    expect(listProjectionSets).not.toHaveBeenCalled();
  });

  it("stops at membership and preserves the unknown-league boundary", async () => {
    const base = repository();
    const findLatestSeason = vi.fn(
      (...args: Parameters<ScheduleEdgeRepository["findLatestSeason"]>) =>
        base.findLatestSeason(...args),
    );
    const service = new ScheduleEdgeService(
      { ...base, findLatestSeason },
      () => new Date("2026-09-16T12:00:00.000Z"),
    );

    await expect(
      service.getRosterEdge(
        "10000000-0000-4000-8000-000000000001",
        "20000000-0000-4000-8000-000000000099",
        {
          startWeek: null,
          endWeek: null,
          playoffStartWeek: null,
          playoffEndWeek: null,
        },
      ),
    ).resolves.toBeUndefined();
    expect(findLatestSeason).not.toHaveBeenCalled();
  });

  it("fails closed on preseason week state while retaining prior-season context", async () => {
    const base = repository();
    const findLatestSeason = vi.fn(
      async (...args: Parameters<ScheduleEdgeRepository["findLatestSeason"]>) => {
        const season = await base.findLatestSeason(...args);
        return season ? { ...season, currentWeek: null } : undefined;
      },
    );
    const listWeeklyStats = vi.fn(
      (...args: Parameters<ScheduleEdgeRepository["listWeeklyStats"]>) =>
        base.listWeeklyStats(...args),
    );
    const listProjectionSets = vi.fn(
      (...args: Parameters<ScheduleEdgeRepository["listProjectionSets"]>) =>
        base.listProjectionSets(...args),
    );
    const service = new ScheduleEdgeService(
      { ...base, findLatestSeason, listWeeklyStats, listProjectionSets },
      () => new Date("2026-07-27T12:00:00.000Z"),
    );

    const response = await service.getRosterEdge(
      "10000000-0000-4000-8000-000000000001",
      LEAGUE_ID,
      {
        startWeek: null,
        endWeek: null,
        playoffStartWeek: null,
        playoffEndWeek: null,
      },
    );

    expect(() => scheduleEdgeResponseSchema.parse(response)).not.toThrow();
    expect(response).toMatchObject({
      league: { currentWeek: null },
      windows: {
        selected: { startWeek: 1, endWeek: 4, source: "fallback" },
      },
      algorithm: {
        evidenceChecksum: "db143047024981db6afdf598d7f3eed3585cba62fa57e3f3dfd952d4ad19bdf6",
        validationStatus: "descriptive-only",
      },
      availability: {
        projections: { state: "unavailable" },
      },
    });
    expect(listProjectionSets).not.toHaveBeenCalled();
    expect(listWeeklyStats).toHaveBeenCalledTimes(1);
    expect(listWeeklyStats.mock.calls[0]?.[2]).toBe(2025);
    expect(
      response?.findings.some(
        (finding) => finding.kind === "favorable-window" || finding.kind === "difficult-window",
      ),
    ).toBe(false);
    for (const player of response?.roster ?? []) {
      expect(player.matchup.label).toBe("unavailable");
      expect(player.selectedWindow.favorableWeeks).toBe(0);
      expect(player.selectedWindow.neutralWeeks).toBe(0);
      expect(player.selectedWindow.difficultWeeks).toBe(0);
      expect(player.selectedWindow.weeks.every((week) => week.label === "unavailable")).toBe(true);
    }
  });
});
