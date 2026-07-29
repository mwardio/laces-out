import { scheduleEdgeMatrixResponseSchema, scheduleEdgeResponseSchema } from "@fantasy/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  ScheduleEdgeService,
  resolveScheduleEdgeWindows,
  type ScheduleEdgeRepository,
  type ScheduleEdgeScheduleRow,
  type ScheduleEdgeScoringRuleRow,
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
const WR_ID = "60000000-0000-4000-8000-000000000005";
const PROJECTION_ID = "70000000-0000-4000-8000-000000000001";
const CHECKSUM = "a".repeat(64);

function espnRule(
  providerStatId: string,
  points: string,
  statKey = providerStatId,
): ScheduleEdgeScoringRuleRow {
  return {
    statKey,
    operation: "multiply",
    points,
    thresholdLow: null,
    thresholdHigh: null,
    providerStatId,
  };
}

/**
 * A sanitized shape of the real synced "Garagely" ESPN league, matching
 * `packages/projections/src/league-scoring.test.ts`'s `ESPN_LEAGUE_B_ROWS`/`ESPN_LEAGUE_C_ROWS`:
 * ordinary offense (passing/rushing/receiving yards), a kicker rule, and a D/ST-only failure.
 * QB/RB/WR/TE all normalize to supported — D/ST and K fall outside `WEEKLY_SCORING_COMPONENTS`
 * entirely, so schedule-edge's `normalizeScoring` withholds them regardless of league content;
 * that is out of scope here (D/ST is not a schedule-edge position; K's own withholding is
 * covered elsewhere in the plan).
 */
function garagelyShapedScoringRules(): readonly ScheduleEdgeScoringRuleRow[] {
  return [
    espnRule("3", "0.04"), // passing_yards -> QB
    espnRule("24", "0.1"), // rushing_yards -> QB/RB/WR/TE
    espnRule("42", "0.1"), // receiving_yards -> RB/WR/TE
    espnRule("86", "1"), // extra_points_made -> K (unattainable here; harmless)
    espnRule("206", "2"), // team-defense-only category -> D/ST (harmless here)
  ];
}

/**
 * A sanitized shape of the real synced "FF 2025" ESPN league: the same offense rules as Garagely,
 * plus its six bare per-game yardage-bonus IDs (17/18 passing, 37/38 rushing, 56/57 receiving).
 * Each bonus is evidence-attributed to the positions whose vocabulary owns its base component,
 * which collectively spans QB (17/18/37/38) and RB/WR/TE (37/38/56/57) — one bad rule
 * per position is enough to withhold it, so all four schedule-edge positions end up unsupported
 * even though the base linear rules would otherwise have supported them.
 */
function ff2025ShapedScoringRules(): readonly ScheduleEdgeScoringRuleRow[] {
  return [
    ...garagelyShapedScoringRules(),
    espnRule("17", "1"), // per-game passing-yardage bonus -> QB
    espnRule("18", "3"), // per-game passing-yardage bonus -> QB
    espnRule("37", "1"), // per-game rushing-yardage bonus -> QB/RB/WR/TE
    espnRule("38", "3"), // per-game rushing-yardage bonus -> QB/RB/WR/TE
    espnRule("56", "1"), // per-game receiving-yardage bonus -> RB/WR/TE
    espnRule("57", "3"), // per-game receiving-yardage bonus -> RB/WR/TE
  ];
}

/**
 * A contrived league whose only fatal rule is a per-game receiving-yardage bonus (id 56). Its base
 * component, `receiving_yards`, is owned by RB/WR/TE in this codebase's component vocabulary (a
 * pass-catching back shares the exact receiving stat list WR/TE use — see
 * `packages/projections/src/first-party.ts`'s `POSITION_COMPONENTS`), so there is no real provider
 * rule that fails WR/TE alone without RB. This is the closest achievable "some but not all"
 * split: QB stays supported (passing_yards only), RB/WR/TE are all withheld together, which still
 * fully exercises the partial-availability and per-position ratings-withholding path this task is
 * about.
 */
function receivingBonusOnlyScoringRules(): readonly ScheduleEdgeScoringRuleRow[] {
  return [
    espnRule("3", "0.04"), // passing_yards -> QB
    espnRule("56", "1"), // per-game receiving-yardage bonus -> RB/WR/TE
  ];
}

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
    listScoringRules: () => Promise.resolve(garagelyShapedScoringRules()),
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
  it("explains why projections are unavailable when managed weekly scoring is unsupported", async () => {
    const base = repository();
    const findManagedProjectionProfile = vi.fn(() => Promise.resolve({ key: null, positions: [] }));
    const service = new ScheduleEdgeService(
      {
        ...base,
        listProjectionSets: () => Promise.resolve([]),
        findManagedProjectionProfile,
      },
      () => new Date("2026-09-16T12:00:00.000Z"),
    );

    const response = await service.getRosterEdge(
      "10000000-0000-4000-8000-000000000001",
      LEAGUE_ID,
      { startWeek: 3, endWeek: 6, playoffStartWeek: null, playoffEndWeek: null },
    );

    expect(() => scheduleEdgeResponseSchema.parse(response)).not.toThrow();
    expect(response?.availability.projections.state).toBe("unavailable");
    expect(response?.availability.projections.reason).toContain("managed weekly projections");
    expect(findManagedProjectionProfile).toHaveBeenCalledWith(SEASON_ID);
  });

  // The match-rate threshold must gate admission, not merely render a badge. A
  // weekly-stats source that fell below its threshold is quarantined by `admittedSourceContract`,
  // so Schedule Edge must never read a stat row from it or derive an opponent rating with it.
  it("withholds matchup ratings when the weekly-stats source is below its match-rate threshold", async () => {
    const base = repository();
    const listWeeklyStats = vi.fn(
      (...args: Parameters<ScheduleEdgeRepository["listWeeklyStats"]>) =>
        base.listWeeklyStats(...args),
    );
    const service = new ScheduleEdgeService(
      {
        ...base,
        findSource: (key) => {
          const row = source(key);
          return Promise.resolve(
            key.startsWith("nflverse.stats-player-week.")
              ? {
                  ...row,
                  metadata: {
                    ...row.metadata,
                    matchRate: 0.82,
                    rowsUnmatched: 2,
                    publishable: false,
                  },
                }
              : row,
          );
        },
        listWeeklyStats,
      },
      () => new Date("2026-09-16T12:00:00.000Z"),
    );

    const response = await service.getRosterEdge(
      "10000000-0000-4000-8000-000000000001",
      LEAGUE_ID,
      { startWeek: 3, endWeek: 6, playoffStartWeek: null, playoffEndWeek: null },
    );

    expect(() => scheduleEdgeResponseSchema.parse(response)).not.toThrow();
    // The threshold reaches the read itself: no stat row is loaded from a quarantined source.
    expect(listWeeklyStats).not.toHaveBeenCalled();
    const stats = response?.sources.find((item) => item.dataset === "weekly-stats");
    expect(stats?.state).toBe("quarantined");
    expect(stats?.checksumSha256).toBeNull();
    expect(stats?.reason).toMatch(/identity-quality/u);
    // And no derived rating is published from it.
    expect(response?.availability.matchups).toMatchObject({ state: "unavailable" });
    for (const player of response?.roster ?? []) {
      expect(player.matchup.label).toBe("unavailable");
    }
  });

  // `normalizeLeagueScoringProfile` carries per-position support, not just a whole-league state.
  // `scoringAvailability`/`matchupAvailability` must
  // gate on QB/RB/WR/TE support, and `computeAnalysis` must compute ratings only for supported
  // positions, letting an unsupported position fall back to the existing per-rating
  // "unavailable" + reason contract instead of a fabricated, incomplete score.
  describe("per-position scoring support", () => {
    it("reports scoring available with all four positions supported for a Garagely-shaped rule set", async () => {
      const service = new ScheduleEdgeService(
        repository(),
        () => new Date("2026-09-16T12:00:00.000Z"),
      );

      const response = await service.getRosterEdge(
        "10000000-0000-4000-8000-000000000001",
        LEAGUE_ID,
        { startWeek: 3, endWeek: 6, playoffStartWeek: null, playoffEndWeek: null },
      );

      expect(() => scheduleEdgeResponseSchema.parse(response)).not.toThrow();
      expect(response?.availability.scoring).toEqual({ state: "available", reason: null });
      // Matchups behave as before per-position withholding: a claimed QB with an admitted
      // week-1 opponent still gets a real rating, not a generic withheld fallback.
      expect(response?.roster.some((player) => player.matchup.state === "available")).toBe(true);
    });

    it("withholds every schedule-edge position and names them when scoring is FF-2025-shaped (six per-game yardage bonuses)", async () => {
      const base = repository();
      const service = new ScheduleEdgeService(
        { ...base, listScoringRules: () => Promise.resolve(ff2025ShapedScoringRules()) },
        () => new Date("2026-09-16T12:00:00.000Z"),
      );

      const response = await service.getRosterEdge(
        "10000000-0000-4000-8000-000000000001",
        LEAGUE_ID,
        { startWeek: 3, endWeek: 6, playoffStartWeek: null, playoffEndWeek: null },
      );

      expect(() => scheduleEdgeResponseSchema.parse(response)).not.toThrow();
      expect(response?.availability.scoring.state).toBe("unavailable");
      for (const position of ["QB", "RB", "WR", "TE"]) {
        expect(response?.availability.scoring.reason).toContain(position);
      }
      expect(response?.availability.matchups.state).toBe("unavailable");
      // No position was ever attempted (ratings stay absent), so every roster rating falls back
      // to the existing per-rating "unavailable" + reason contract — never an approximated score.
      for (const player of response?.roster ?? []) {
        expect(player.matchup.state).toBe("unavailable");
        expect(player.matchup.reason).toBeTruthy();
      }
    });

    it("withholds only RB/WR/TE (partial) when a per-game receiving-yardage bonus fails them but not QB", async () => {
      const base = repository();
      // Both on Buffalo, whose week-3 (the default `nextWeek`) opponent is Miami: week 1's
      // admitted final game (NE offense vs. MIA defense) gives QB a real defense-vs-QB rating for
      // Miami, independent of Buffalo's own (unplayed, "scheduled") game history.
      const rosterRows = [
        {
          playerId: PLAYER_ID,
          name: "Buffalo Starter",
          primaryPosition: "QB",
          eligiblePositions: ["QB"],
          nflTeam: "BUF",
          status: "ACTIVE",
          slotCode: "QB",
          isStarter: true,
        },
        {
          playerId: WR_ID,
          name: "Buffalo Wideout",
          primaryPosition: "WR",
          eligiblePositions: ["WR"],
          nflTeam: "BUF",
          status: "ACTIVE",
          slotCode: "BE",
          isStarter: false,
        },
      ];
      // A real week-1 WR performance (receiving_yards only — no passing_yards, the one rule that
      // survives WR's withholding), so this test can tell "withheld" apart from "approximated at
      // zero": with `receivingBonusOnlyScoringRules()`'s emitted profile pricing only
      // passing_yards, scoring this row with the whole-league profile (the pre-fix behavior)
      // would silently produce an "available" rating worth 0 points rather than withholding it.
      const weeklyStatsWithWr = (season: number): ScheduleEdgeWeeklyStatRow[] => [
        ...weeklyStats(season),
        {
          externalPlayerId: `${season}:mia-wr`,
          playerId: "60000000-0000-4000-8000-000000000006",
          season,
          week: 1,
          gameId: `${season}-01-MIA-NE`,
          team: "MIA",
          opponentTeam: "NE",
          components: { receiving_yards: 80 },
        },
        {
          externalPlayerId: `${season}:ne-wr`,
          playerId: "60000000-0000-4000-8000-000000000007",
          season,
          week: 1,
          gameId: `${season}-01-MIA-NE`,
          team: "NE",
          opponentTeam: "MIA",
          components: { receiving_yards: 65 },
        },
      ];
      const weeklyRostersWithWr = (season: number): ScheduleEdgeWeeklyRosterRow[] => [
        ...weeklyRosters(season),
        {
          externalPlayerId: `${season}:mia-wr`,
          playerId: "60000000-0000-4000-8000-000000000006",
          season,
          week: 1,
          team: "MIA",
          position: "WR",
          rosterStatus: "ACT",
          statusDescription: null,
        },
        {
          externalPlayerId: `${season}:ne-wr`,
          playerId: "60000000-0000-4000-8000-000000000007",
          season,
          week: 1,
          team: "NE",
          position: "WR",
          rosterStatus: "ACT",
          statusDescription: null,
        },
      ];
      const service = new ScheduleEdgeService(
        {
          ...base,
          listScoringRules: () => Promise.resolve(receivingBonusOnlyScoringRules()),
          listRosterEntries: () => Promise.resolve(rosterRows),
          listWeeklyStats: (_sourceId, _checksum, season) =>
            Promise.resolve(weeklyStatsWithWr(season)),
          listWeeklyRosters: (_sourceId, _checksum, season) =>
            Promise.resolve(weeklyRostersWithWr(season)),
        },
        () => new Date("2026-09-16T12:00:00.000Z"),
      );

      const response = await service.getRosterEdge(
        "10000000-0000-4000-8000-000000000001",
        LEAGUE_ID,
        { startWeek: 3, endWeek: 6, playoffStartWeek: null, playoffEndWeek: null },
      );

      expect(() => scheduleEdgeResponseSchema.parse(response)).not.toThrow();
      expect(response?.availability.scoring.state).toBe("partial");
      expect(response?.availability.scoring.reason).toContain("RB");
      expect(response?.availability.scoring.reason).toContain("WR");
      expect(response?.availability.scoring.reason).toContain("TE");
      expect(response?.availability.scoring.reason).not.toContain("QB withheld");

      const qb = response?.roster.find((player) => player.playerId === PLAYER_ID);
      const wr = response?.roster.find((player) => player.playerId === WR_ID);
      // QB's rules survived, so its admitted week-1 opponent still produces a real rating —
      // exercising the code path that would previously have been dead behind a whole-league gate.
      expect(qb?.matchup.state).toBe("available");
      // WR has real week-1 receiving evidence, but the position itself is withheld, so it must
      // fall back to the existing per-rating "unavailable" + reason contract rather than an
      // approximated (silently zeroed) score built from QB's surviving rule alone.
      expect(wr?.matchup.state).toBe("unavailable");
      expect(wr?.matchup.reason).toBeTruthy();
    });
  });
});
