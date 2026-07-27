import { describe, expect, it } from "vitest";

import {
  calculatePositionFantasyPointsAllowed,
  derivePlayerOpportunityMetrics,
  type DerivePlayerOpportunityMetricsInput,
  type WeeklyPlayerStatObservation,
} from "./opportunity.js";

const weeklyStats: readonly WeeklyPlayerStatObservation[] = [
  {
    playerId: "player-a",
    season: 2025,
    week: 1,
    gameId: "game-1",
    team: "AAA",
    opponentTeam: "BBB",
    position: "RB",
    targets: 4,
    carries: 6,
    fantasyPoints: 10,
  },
  {
    playerId: "teammate-a",
    season: 2025,
    week: 1,
    gameId: "game-1",
    team: "AAA",
    opponentTeam: "BBB",
    position: "WR",
    targets: 6,
    carries: 0,
    fantasyPoints: 8,
  },
  {
    playerId: "player-a",
    season: 2025,
    week: 2,
    gameId: "game-2",
    team: "AAA",
    opponentTeam: "CCC",
    position: "RB",
    targets: 8,
    carries: 2,
    fantasyPoints: 24,
  },
  {
    playerId: "teammate-a",
    season: 2025,
    week: 2,
    gameId: "game-2",
    team: "AAA",
    opponentTeam: "CCC",
    position: "WR",
    targets: 8,
    carries: 0,
    fantasyPoints: 12,
  },
];

const opportunityInput: DerivePlayerOpportunityMetricsInput = {
  season: 2025,
  weeklyStats,
  snapCounts: [
    {
      playerId: "player-a",
      season: 2025,
      week: 1,
      gameId: "game-1",
      team: "AAA",
      opponentTeam: "BBB",
      offenseSnaps: 50,
      offenseSnapShare: 0.5,
    },
    {
      playerId: "player-a",
      season: 2025,
      week: 2,
      gameId: "game-2",
      team: "AAA",
      opponentTeam: "CCC",
      offenseSnaps: 60,
      offenseSnapShare: 0.75,
    },
  ],
  playerIds: ["player-a"],
  teamTargetTotalsComplete: true,
  recentWindow: 2,
  recentWeightDecay: 0.5,
  boomBustThresholdsByPosition: { RB: { boomAtOrAbove: 20, bustAtOrBelow: 12 } },
};

describe("derivePlayerOpportunityMetrics", () => {
  it("derives counts, shares, snap usage, recent weighting, and caller-defined boom/bust", () => {
    const result = derivePlayerOpportunityMetrics(opportunityInput);
    const player = result.players[0];

    expect(player?.totals.targets).toMatchObject({ status: "available", value: 12 });
    expect(player?.totals.carries).toMatchObject({ status: "available", value: 8 });
    expect(player?.totals.opportunities).toMatchObject({ status: "available", value: 20 });
    expect(player?.totals.offenseSnaps).toMatchObject({ status: "available", value: 110 });
    expect(player?.rates.targetShare.value).toBeCloseTo(12 / 26);
    expect(player?.rates.offenseSnapShare).toMatchObject({ status: "available", value: 0.625 });
    expect(player?.weekly.map((week) => week.targetShare)).toEqual([0.4, 0.5]);

    expect(player?.recentTrend.targetShare).toMatchObject({
      status: "available",
      seasonAverage: 0.45,
      recentSampleSize: 2,
    });
    expect(player?.recentTrend.targetShare.recentWeightedAverage).toBeCloseTo(
      (0.5 + 0.4 * 0.5) / 1.5,
    );
    expect(player?.boomBust).toMatchObject({
      status: "available",
      games: 2,
      booms: 1,
      busts: 1,
      neutral: 0,
      boomRate: 0.5,
      bustRate: 0.5,
      averagePoints: 17,
      populationStandardDeviation: 7,
    });
    expect(player?.redZone).toMatchObject({ status: "unavailable" });
    expect(player?.redZone.reason).toContain("do not contain red-zone");
  });

  it("does not fabricate target share from incomplete coverage or a zero denominator", () => {
    const partial = derivePlayerOpportunityMetrics({
      ...opportunityInput,
      teamTargetTotalsComplete: false,
    }).players[0];
    expect(partial?.rates.targetShare).toMatchObject({
      status: "unavailable",
      value: null,
    });
    expect(partial?.recentTrend.targetShare).toMatchObject({ status: "unavailable" });

    const zero = derivePlayerOpportunityMetrics({
      season: 2025,
      teamTargetTotalsComplete: true,
      playerIds: ["zero"],
      weeklyStats: [
        {
          playerId: "zero",
          season: 2025,
          week: 1,
          gameId: "zero-game",
          team: "AAA",
          opponentTeam: "BBB",
          position: "WR",
          targets: 0,
          carries: 0,
          fantasyPoints: 0,
        },
      ],
    }).players[0];
    expect(zero?.totals.opportunities).toMatchObject({ status: "available", value: 0 });
    expect(zero?.rates.targetShare).toMatchObject({ status: "unavailable", value: null });
  });

  it("returns explicit unavailable metrics for a requested player with no data", () => {
    const player = derivePlayerOpportunityMetrics({
      season: 2025,
      weeklyStats: [],
      snapCounts: [],
      playerIds: ["missing-player"],
      teamTargetTotalsComplete: true,
    }).players[0];

    expect(player).toMatchObject({ playerId: "missing-player", statGames: 0, snapGames: 0 });
    expect(player?.totals.targets).toMatchObject({ status: "unavailable", value: null });
    expect(player?.rates.offenseSnapShare).toMatchObject({ status: "unavailable", value: null });
    expect(player?.boomBust).toMatchObject({ status: "unavailable", games: 0 });
  });

  it("is invariant to stat, snap, and requested-player input order", () => {
    const first = derivePlayerOpportunityMetrics(opportunityInput);
    const reordered = derivePlayerOpportunityMetrics({
      ...opportunityInput,
      weeklyStats: [...weeklyStats].reverse(),
      snapCounts: [...(opportunityInput.snapCounts ?? [])].reverse(),
      playerIds: ["player-a"],
    });
    expect(reordered).toEqual(first);
  });

  it("rejects duplicate observations and overlapping boom/bust thresholds", () => {
    expect(() =>
      derivePlayerOpportunityMetrics({
        ...opportunityInput,
        weeklyStats: [weeklyStats[0]!, weeklyStats[0]!],
      }),
    ).toThrow(/Duplicate weekly stat row/u);
    expect(() =>
      derivePlayerOpportunityMetrics({
        ...opportunityInput,
        boomBustThresholdsByPosition: { RB: { boomAtOrAbove: 10, bustAtOrBelow: 11 } },
      }),
    ).toThrow(/must be below/u);
  });
});

const fpaRows: readonly WeeklyPlayerStatObservation[] = [
  {
    playerId: "rb-1",
    season: 2025,
    week: 1,
    gameId: "fpa-1",
    team: "AAA",
    opponentTeam: "DEF1",
    position: "RB",
    targets: 2,
    carries: 10,
    fantasyPoints: 20,
  },
  {
    playerId: "rb-2",
    season: 2025,
    week: 1,
    gameId: "fpa-1",
    team: "AAA",
    opponentTeam: "DEF1",
    position: "RB",
    targets: 1,
    carries: 4,
    fantasyPoints: 10,
  },
  {
    playerId: "wr-1",
    season: 2025,
    week: 1,
    gameId: "fpa-1",
    team: "AAA",
    opponentTeam: "DEF1",
    position: "WR",
    targets: 5,
    carries: 0,
    fantasyPoints: 5,
  },
  {
    playerId: "rb-3",
    season: 2025,
    week: 1,
    gameId: "fpa-2",
    team: "BBB",
    opponentTeam: "DEF2",
    position: "RB",
    targets: 2,
    carries: 8,
    fantasyPoints: 10,
  },
  {
    playerId: "wr-2",
    season: 2025,
    week: 1,
    gameId: "fpa-2",
    team: "BBB",
    opponentTeam: "DEF2",
    position: "WR",
    targets: 8,
    carries: 0,
    fantasyPoints: 15,
  },
];

describe("calculatePositionFantasyPointsAllowed", () => {
  it("sums by defensive opponent/position and applies explicit early-season shrinkage", () => {
    const result = calculatePositionFantasyPointsAllowed({
      season: 2025,
      weeklyStats: fpaRows,
      positions: ["RB", "WR"],
      datasetCompleteness: "complete",
      shrinkageGames: 4,
      priorPositionAverages: { RB: 20, WR: 10 },
    });
    const def1Rb = result.entries.find(
      (entry) => entry.opponentTeam === "DEF1" && entry.position === "RB",
    );
    const def2Rb = result.entries.find(
      (entry) => entry.opponentTeam === "DEF2" && entry.position === "RB",
    );

    expect(result.status).toBe("available");
    expect(def1Rb).toMatchObject({
      status: "available",
      games: 1,
      rawPointsPerGame: 30,
      baselinePointsPerGame: 20,
      baselineSource: "provided-prior",
      observedWeight: 0.2,
      shrinkageWeight: 0.8,
      shrunkPointsPerGame: 22,
    });
    expect(def2Rb?.shrunkPointsPerGame).toBe(18);
  });

  it("falls back transparently to the current-sample positional league average", () => {
    const result = calculatePositionFantasyPointsAllowed({
      season: 2025,
      weeklyStats: fpaRows,
      positions: ["RB"],
      datasetCompleteness: "complete",
      shrinkageGames: 1,
    });
    const def1 = result.entries.find((entry) => entry.opponentTeam === "DEF1");
    expect(def1).toMatchObject({
      baselineSource: "current-sample-league-average",
      baselinePointsPerGame: 20,
      rawPointsPerGame: 30,
      shrunkPointsPerGame: 25,
    });
  });

  it("keeps real zero-point games available without dividing by zero", () => {
    const result = calculatePositionFantasyPointsAllowed({
      season: 2025,
      weeklyStats: [
        {
          playerId: "rb-zero",
          season: 2025,
          week: 1,
          gameId: "zero-game",
          team: "AAA",
          opponentTeam: "DEF",
          position: "RB",
          targets: 0,
          carries: 0,
          fantasyPoints: 0,
        },
      ],
      positions: ["RB"],
      datasetCompleteness: "complete",
      shrinkageGames: 0,
    });
    expect(result.entries[0]).toMatchObject({
      status: "available",
      rawPointsPerGame: 0,
      shrunkPointsPerGame: 0,
      observedWeight: 1,
      shrinkageWeight: 0,
    });
  });

  it("refuses partial datasets and returns an honest no-data result", () => {
    const partial = calculatePositionFantasyPointsAllowed({
      season: 2025,
      weeklyStats: fpaRows,
      datasetCompleteness: "partial",
    });
    expect(partial).toMatchObject({ status: "unavailable", entries: [] });
    expect(partial.reason).toContain("partial rows would understate");

    const empty = calculatePositionFantasyPointsAllowed({
      season: 2025,
      weeklyStats: [],
      positions: ["RB"],
      datasetCompleteness: "complete",
    });
    expect(empty).toMatchObject({ status: "unavailable", entries: [] });
    expect(empty.reason).toContain("No weekly stat observations");
  });

  it("marks an opponent/position incomplete when a relevant point total is missing", () => {
    const result = calculatePositionFantasyPointsAllowed({
      season: 2025,
      weeklyStats: fpaRows.map((row) =>
        row.playerId === "rb-1" ? { ...row, fantasyPoints: null } : row,
      ),
      positions: ["RB"],
      datasetCompleteness: "complete",
      priorPositionAverages: { RB: 20 },
    });
    expect(result.entries.find((entry) => entry.opponentTeam === "DEF1")).toMatchObject({
      status: "unavailable",
      games: 0,
      incompleteGames: 1,
      rawPointsPerGame: null,
    });
  });

  it("never turns an empty position slice into an observed zero", () => {
    const result = calculatePositionFantasyPointsAllowed({
      season: 2025,
      weeklyStats: fpaRows.filter((row) => row.position === "RB"),
      positions: ["RB", "TE"],
      datasetCompleteness: "complete",
      priorPositionAverages: { RB: 20, TE: 8 },
    });

    expect(result.entries.filter((entry) => entry.position === "TE")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "unavailable",
          games: 0,
          rawPointsPerGame: null,
          shrunkPointsPerGame: null,
        }),
      ]),
    );
  });

  it("is invariant to observation and requested-position order", () => {
    const first = calculatePositionFantasyPointsAllowed({
      season: 2025,
      weeklyStats: fpaRows,
      positions: ["RB", "WR"],
      datasetCompleteness: "complete",
      priorPositionAverages: { RB: 20, WR: 10 },
    });
    const reordered = calculatePositionFantasyPointsAllowed({
      season: 2025,
      weeklyStats: [...fpaRows].reverse(),
      positions: ["WR", "RB"],
      datasetCompleteness: "complete",
      priorPositionAverages: { WR: 10, RB: 20 },
    });
    expect(reordered).toEqual(first);
  });
});
