import { describe, expect, it, vi } from "vitest";

import {
  StatsCenterService,
  type StatsCenterQuery,
  type StatsCenterRepository,
  type StatsCenterSourceRow,
  type StatsCenterWeeklyRow,
} from "./stats-center.js";

const PLAYER_ID = "10000000-0000-4000-8000-000000000001";
const TEAMMATE_ID = "10000000-0000-4000-8000-000000000002";
const CHECKSUM = "a".repeat(64);

function source(
  dataset: "stats-player-week" | "snap-counts",
  metadata: StatsCenterSourceRow["metadata"] = {},
): StatsCenterSourceRow {
  return {
    id: dataset === "stats-player-week" ? "stats-source" : "snap-source",
    key: `nflverse.${dataset}.2025`,
    name: dataset === "stats-player-week" ? "Weekly player stats" : "Snap counts",
    attribution: "Data provided by nflverse (CC BY 4.0)",
    attributionUrl: "https://github.com/nflverse/nflverse-data",
    lastSuccessfulAt: new Date("2026-01-02T03:04:05.000Z"),
    lastChecksum: CHECKSUM,
    metadata: {
      publishable: true,
      rowsRead: 2,
      rowsRejected: 0,
      rowsUnmatched: 1,
      matchRate: 0.5,
      coveredWeeks: "1",
      ...metadata,
    },
  };
}

function weeklyRow(overrides: Partial<StatsCenterWeeklyRow> = {}): StatsCenterWeeklyRow {
  return {
    externalPlayerId: "00-0000001",
    playerId: PLAYER_ID,
    playerName: "Steady Runner",
    position: "RB",
    season: 2025,
    week: 1,
    gameId: "2025_01_AAA_BBB",
    team: "AAA",
    opponentTeam: "BBB",
    components: { targets: 4, carries: 12, rushing_yards: 63, receiving_yards: 25 },
    advanced: { receivingAirYards: 20, rushingEpa: 1.5 },
    sourceFantasyPoints: { standard: 8.8, ppr: 12.8 },
    ...overrides,
  };
}

function query(overrides: Partial<StatsCenterQuery> = {}): StatsCenterQuery {
  return {
    season: 2025,
    weekFrom: null,
    weekTo: null,
    position: null,
    team: null,
    search: "",
    sort: "opportunities",
    scoring: "ppr",
    recentWindow: 4,
    recentWeightDecay: 0.75,
    limit: 50,
    ...overrides,
  };
}

function repository(): StatsCenterRepository {
  return {
    findSource: (key) =>
      Promise.resolve(
        key.includes("stats-player-week")
          ? source("stats-player-week")
          : source("snap-counts", { rowsRead: 1, rowsUnmatched: 0, matchRate: 1 }),
      ),
    listWeeklyStats: () =>
      Promise.resolve([
        weeklyRow(),
        weeklyRow({
          externalPlayerId: "00-0000002",
          playerId: null,
          playerName: null,
          position: null,
          components: { targets: 6, carries: 0 },
          advanced: { receivingAirYards: 30 },
          sourceFantasyPoints: { standard: 4, ppr: 7 },
        }),
      ]),
    findPlayer: (playerId) =>
      Promise.resolve(
        playerId === PLAYER_ID
          ? {
              playerId: PLAYER_ID,
              fullName: "Steady Runner",
              primaryPosition: "RB",
              nflTeam: "AAA",
              status: "active",
              rookieSeason: 2023,
            }
          : undefined,
      ),
    listPlayerTeams: () => Promise.resolve(["AAA"]),
    listSnapCounts: () =>
      Promise.resolve([
        {
          externalPlayerId: "RunnSt00",
          playerId: PLAYER_ID,
          playerName: "Steady Runner",
          position: "RB",
          season: 2025,
          week: 1,
          gameId: "2025_01_AAA_BBB",
          team: "AAA",
          opponentTeam: "BBB",
          offenseSnaps: 54,
          offenseShare: "0.75000",
        },
      ]),
  };
}

describe("StatsCenterService", () => {
  it("derives admitted opportunity leaders while excluding unresolved identities", async () => {
    const service = new StatsCenterService(
      repository(),
      () => new Date("2026-01-03T00:00:00.000Z"),
    );
    const result = await service.getPlayers(
      "user",
      query({ weekFrom: 1, weekTo: 1, position: "RB", search: "runner", limit: 25 }),
    );

    expect(result.generatedAt).toBe("2026-01-03T00:00:00.000Z");
    expect(result.totalMatched).toBe(1);
    expect(result.players[0]).toMatchObject({
      playerId: PLAYER_ID,
      targets: 4,
      carries: 12,
      opportunities: 16,
      targetShare: 0.4,
      offensiveSnaps: 54,
      offensiveSnapShare: 0.75,
    });
    expect(result.players.some((player) => player.playerId.includes("unmatched"))).toBe(false);
    expect(result.sources[0]).toMatchObject({
      state: "available",
      checksumSha256: CHECKSUM,
      quality: { rowsUnmatched: 1, matchRate: 0.5 },
    });
    expect(result.availability.redZone).toMatchObject({ state: "unavailable" });
  });

  it("surfaces summed production and recomputed shares alongside usage", async () => {
    const result = await new StatsCenterService(repository()).getPlayers("user", query());
    const player = result.players.find((row) => row.playerId === PLAYER_ID);

    expect(player?.totals.rushYards).toBe(63);
    expect(player?.totals.recYards).toBe(25);
    expect(player?.totals.pointsPpr).toBe(12.8);
    expect(player?.perGame.rushYards).toBe(63);
    // The teammate row contributes 30 of the team's 50 air yards for the same game.
    expect(player?.ratios.airYardsShare).toBeCloseTo(20 / 50, 10);
    expect(player?.ratios.weightedOpportunityRating).toBeCloseTo(1.5 * 0.4 + 0.7 * 0.4, 10);
  });

  it("scores boom and bust from the requested source scoring and discloses the caveat", async () => {
    const result = await new StatsCenterService(repository()).getPlayers(
      "user",
      query({ scoring: "ppr" }),
    );
    const player = result.players.find((row) => row.playerId === PLAYER_ID);

    // 12.8 PPR points sits between the RB bust (8) and boom (20) thresholds.
    expect(player?.boomBust).toMatchObject({
      status: "available",
      games: 1,
      booms: 0,
      busts: 0,
      neutral: 1,
      threshold: { boomAtOrAbove: 20, bustAtOrBelow: 8 },
    });
    expect(result.definitions.boomBust).toContain("not any league's rules");
    expect(result.definitions.boomBust).toContain("PPR");
    // The upstream definition describes league-scored thresholds; composing the two claimed
    // league scoring and disclaimed it in one sentence.
    expect(result.definitions.boomBust).not.toContain("league-scored");
  });

  it("reports the trend block the derivation already computes", async () => {
    const result = await new StatsCenterService(repository()).getPlayers(
      "user",
      query({ recentWindow: 2, recentWeightDecay: 0.5 }),
    );
    const player = result.players.find((row) => row.playerId === PLAYER_ID);

    expect(player?.trend.opportunitiesPerGame).toMatchObject({
      status: "available",
      seasonAverage: 16,
      recentWeightedAverage: 16,
      absoluteChange: 0,
    });
    expect(result.filters.recentWindow).toBe(2);
    expect(result.filters.recentWeightDecay).toBe(0.5);
  });

  it("narrows the query window instead of filtering rows after the read", async () => {
    const listWeeklyStats = vi.fn(() => Promise.resolve([weeklyRow()]));
    const repo: StatsCenterRepository = { ...repository(), listWeeklyStats };
    await new StatsCenterService(repo).getPlayers(
      "user",
      query({ weekFrom: 5, weekTo: 9, team: "det" }),
    );

    expect(listWeeklyStats).toHaveBeenCalledWith(
      "stats-source",
      CHECKSUM,
      { season: 2025, weekFrom: 5, weekTo: 9, teams: ["DET"] },
      expect.any(Number),
    );
  });

  it("keeps position and search out of the read so share denominators stay complete", async () => {
    const listWeeklyStats = vi.fn(() =>
      Promise.resolve([
        weeklyRow(),
        weeklyRow({
          externalPlayerId: "00-0000003",
          playerId: TEAMMATE_ID,
          playerName: "Slot Guy",
          position: "WR",
          components: { targets: 6, carries: 0 },
          advanced: { receivingAirYards: 30 },
        }),
      ]),
    );
    const repo: StatsCenterRepository = { ...repository(), listWeeklyStats };
    const result = await new StatsCenterService(repo).getPlayers("user", query({ position: "RB" }));

    // Only the running back is returned, but his share still divides by both players' rows.
    expect(result.players).toHaveLength(1);
    expect(result.players[0]?.targetShare).toBeCloseTo(4 / 10, 10);
    // The read itself stayed unfiltered by position, which is what keeps the denominator whole.
    expect(listWeeklyStats).toHaveBeenCalledWith(
      "stats-source",
      CHECKSUM,
      { season: 2025, weekFrom: null, weekTo: null, teams: null },
      expect.any(Number),
    );
  });

  it("fails closed on a source that is not publishable", async () => {
    const listWeeklyStats = vi.fn(() => Promise.resolve([]));
    const repo: StatsCenterRepository = {
      ...repository(),
      findSource: (key) =>
        Promise.resolve(
          key.includes("stats-player-week")
            ? source("stats-player-week", { publishable: false })
            : undefined,
        ),
      listWeeklyStats,
    };
    const result = await new StatsCenterService(repo).getPlayers(
      "user",
      query({ sort: "targets" }),
    );

    expect(listWeeklyStats).not.toHaveBeenCalled();
    expect(result.sources.map((item) => item.state)).toEqual(["quarantined", "unavailable"]);
    expect(result.availability.targets).toMatchObject({ state: "unavailable" });
    expect(result.players).toEqual([]);
    // A withheld dataset withholds every derived metric with the same reason.
    expect(result.metrics.every((metric) => metric.state === "unavailable")).toBe(true);
  });

  it("withholds target share, air-yards share, and WOPR when rows were rejected", async () => {
    const repo: StatsCenterRepository = {
      ...repository(),
      findSource: (key) =>
        Promise.resolve(
          key.includes("stats-player-week")
            ? source("stats-player-week", { rowsRejected: 1 })
            : source("snap-counts", { rowsRead: 1, rowsUnmatched: 0, matchRate: 1 }),
        ),
    };
    const result = await new StatsCenterService(repo).getPlayers(
      "user",
      query({ sort: "targetShare" }),
    );

    expect(result.availability.targetShare).toMatchObject({ state: "unavailable" });
    expect(result.players[0]?.targetShare).toBeNull();
    expect(result.players[0]?.ratios.airYardsShare).toBeNull();
    expect(result.players[0]?.ratios.weightedOpportunityRating).toBeNull();
    const airYardsShare = result.metrics.find((metric) => metric.id === "airYardsShare");
    expect(airYardsShare?.state).toBe("unavailable");
    expect(airYardsShare?.reason).toContain("complete team-game coverage");
  });

  it("reports a metric the admitted rows do not carry as withheld rather than zero", async () => {
    const result = await new StatsCenterService(repository()).getPlayers("user", query());
    const passYards = result.metrics.find((metric) => metric.id === "passYards");

    expect(passYards?.state).toBe("unavailable");
    expect(passYards?.reason).toContain("do not carry this field");
    expect(result.players[0]?.totals.passYards).toBeNull();
  });

  it("returns undefined for a player identity that does not exist", async () => {
    const result = await new StatsCenterService(repository()).getPlayer(
      "user",
      TEAMMATE_ID,
      query(),
    );

    expect(result).toBeUndefined();
  });

  it("scopes a player read to the teams he appeared for, not to his own rows", async () => {
    const listWeeklyStats = vi.fn(() => Promise.resolve([weeklyRow()]));
    const listPlayerTeams = vi.fn(() => Promise.resolve(["AAA", "CCC"]));
    const repo: StatsCenterRepository = { ...repository(), listWeeklyStats, listPlayerTeams };
    await new StatsCenterService(repo).getPlayer("user", PLAYER_ID, query());

    expect(listWeeklyStats).toHaveBeenCalledWith(
      "stats-source",
      CHECKSUM,
      { season: 2025, weekFrom: null, weekTo: null, teams: ["AAA", "CCC"] },
      expect.any(Number),
    );
  });

  it("builds a game log with the player's identity header", async () => {
    const result = await new StatsCenterService(repository()).getPlayer("user", PLAYER_ID, query());

    expect(result?.player).toEqual({
      playerId: PLAYER_ID,
      name: "Steady Runner",
      position: "RB",
      team: "AAA",
      status: "active",
      rookieSeason: 2023,
    });
    expect(result?.gameLog).toHaveLength(1);
    expect(result?.gameLog[0]).toMatchObject({
      week: 1,
      opponentTeam: "BBB",
      targets: 4,
      carries: 12,
      opportunities: 16,
      points: 12.8,
      bye: false,
    });
    expect(result?.summary.playerId).toBe(PLAYER_ID);
  });

  it("marks an affirmed bye week in the game log", async () => {
    const service = new StatsCenterService(repository(), () => new Date(), {
      byeWeekLookup: () => Promise.resolve(new Map([["AAA", 7]])),
    });
    const result = await service.getPlayer("user", PLAYER_ID, query());
    const bye = result?.gameLog.find((entry) => entry.bye);

    expect(bye).toMatchObject({ week: 7, gameId: null, opponentTeam: null, points: null });
    // The log stays ordered so the bye reads as a gap in the right place.
    expect(result?.gameLog.map((entry) => entry.week)).toEqual([1, 7]);
  });

  it("omits a bye outside the requested week range", async () => {
    const service = new StatsCenterService(repository(), () => new Date(), {
      byeWeekLookup: () => Promise.resolve(new Map([["AAA", 7]])),
    });
    const result = await service.getPlayer("user", PLAYER_ID, query({ weekFrom: 1, weekTo: 4 }));

    expect(result?.gameLog.some((entry) => entry.bye)).toBe(false);
  });

  it("keeps the profile readable when the bye lookup fails", async () => {
    const service = new StatsCenterService(repository(), () => new Date(), {
      byeWeekLookup: () => Promise.reject(new Error("schedule unavailable")),
    });
    const result = await service.getPlayer("user", PLAYER_ID, query());

    expect(result?.gameLog).toHaveLength(1);
    expect(result?.gameLog.some((entry) => entry.bye)).toBe(false);
  });

  it("reports an empty summary rather than failing when no rows cover the player", async () => {
    const repo: StatsCenterRepository = {
      ...repository(),
      listPlayerTeams: () => Promise.resolve([]),
      listWeeklyStats: () => Promise.resolve([]),
      listSnapCounts: () => Promise.resolve([]),
    };
    const result = await new StatsCenterService(repo).getPlayer("user", PLAYER_ID, query());

    expect(result?.summary).toMatchObject({ games: 0, targets: null, opportunities: null });
    expect(result?.summary.boomBust.reason).toContain("No admitted weekly rows");
    expect(result?.gameLog).toEqual([]);
  });

  it("sorts by a derived metric when one is requested", async () => {
    const listWeeklyStats = vi.fn(() =>
      Promise.resolve([
        weeklyRow({ components: { targets: 4, carries: 12, rushing_yards: 10 } }),
        weeklyRow({
          externalPlayerId: "00-0000004",
          playerId: TEAMMATE_ID,
          playerName: "Big Back",
          components: { targets: 1, carries: 20, rushing_yards: 140 },
        }),
      ]),
    );
    const repo: StatsCenterRepository = { ...repository(), listWeeklyStats };
    const result = await new StatsCenterService(repo).getPlayers(
      "user",
      query({ sort: "rushYards" }),
    );

    expect(result.players.map((player) => player.name)).toEqual(["Big Back", "Steady Runner"]);
  });
});
