import { describe, expect, it } from "vitest";

import { createRosterSlots, draftEventId, playerId, teamId, type Player } from "@fantasy/domain";

import {
  analyzeDraft,
  DRAFT_ANALYZER_ALGORITHM_VERSION,
  type AuctionDraftConfig,
  type DraftAnalysisMarket,
  type DraftAnalysisProjectionSet,
  type DraftEvent,
  type SnakeDraftConfig,
} from "./index.js";

const teamA = teamId("team-a");
const teamB = teamId("team-b");
const qbA = playerId("qb-a");
const qbB = playerId("qb-b");
const rbA = playerId("rb-a");
const rbB = playerId("rb-b");
const players: readonly Player[] = [
  { id: qbA, name: "Quarterback A", positions: ["QB"] },
  { id: qbB, name: "Quarterback B", positions: ["QB"] },
  { id: rbA, name: "Running Back A", positions: ["RB"] },
  { id: rbB, name: "Running Back B", positions: ["RB"] },
];
const rosterSlots = createRosterSlots([
  { type: "QB", count: 1 },
  { type: "RB", count: 1 },
]);
const snakeConfig: SnakeDraftConfig = {
  mode: "SNAKE",
  teams: [
    { id: teamA, name: "Alpha", rosterSlots },
    { id: teamB, name: "Bravo", rosterSlots },
  ],
  players,
  pickOrder: [teamA, teamB, teamB, teamA],
};
const snakeEvents: readonly DraftEvent[] = [
  {
    id: draftEventId("snake-1"),
    type: "SNAKE_PLAYER_SELECTED",
    teamId: teamA,
    playerId: qbA,
    overallPick: 1,
  },
  {
    id: draftEventId("snake-2"),
    type: "SNAKE_PLAYER_SELECTED",
    teamId: teamB,
    playerId: qbB,
    overallPick: 2,
  },
  {
    id: draftEventId("snake-3"),
    type: "SNAKE_PLAYER_SELECTED",
    teamId: teamB,
    playerId: rbB,
    overallPick: 3,
  },
  {
    id: draftEventId("snake-4"),
    type: "SNAKE_PLAYER_SELECTED",
    teamId: teamA,
    playerId: rbA,
    overallPick: 4,
  },
];
const snakeMarket: DraftAnalysisMarket = {
  admissionStatus: "ADMITTED",
  source: "admitted-test-market",
  sourceVersion: "2026-07-21",
  asOf: "2026-07-21T12:00:00Z",
  players: [
    { playerId: qbA, adp: 5, tier: 2 },
    { playerId: qbB, adp: 1, tier: 1 },
    { playerId: rbA, adp: 2, tier: 1 },
    { playerId: rbB, adp: 3, tier: 1 },
  ],
};
const projections: DraftAnalysisProjectionSet = {
  source: "league-scored-test-projections",
  sourceVersion: "v1",
  asOf: "2026-07-21T12:00:00Z",
  horizon: "REST_OF_SEASON",
  scoringProfileId: "league-ppr-v1",
  players: [
    { playerId: qbA, projectedPoints: 300 },
    { playerId: qbB, projectedPoints: 320 },
    { playerId: rbA, projectedPoints: 210 },
    { playerId: rbB, projectedPoints: 180 },
  ],
};

describe("snake draft analyzer", () => {
  it("reports transparent reach, roster-need, opportunity-cost, and missed-alternative factors", () => {
    const report = analyzeDraft({
      config: snakeConfig,
      events: snakeEvents,
      market: snakeMarket,
      projections,
      leagueScoringProfileId: "league-ppr-v1",
    });

    expect(report).toMatchObject({
      algorithmVersion: DRAFT_ANALYZER_ALGORITHM_VERSION,
      mode: "SNAKE",
      draftStatus: "COMPLETE",
      projectionAvailability: { status: "AVAILABLE", scoringProfileId: "league-ppr-v1" },
    });
    expect(report.teams.map((team) => team.teamId)).toEqual([teamA, teamB]);
    const alpha = report.teams[0]!;
    expect(alpha.mode).toBe("SNAKE");
    if (alpha.mode !== "SNAKE") throw new Error("Expected snake analysis");
    expect(alpha.roster).toMatchObject({
      coveredStarterSlots: 2,
      openRosterSlots: 0,
      openStarterSlots: [],
    });
    expect(alpha.selections[0]).toMatchObject({
      playerId: qbA,
      market: {
        adp: 5,
        pickVsAdp: -4,
        classification: "REACH",
        classificationThresholdPicks: 2,
      },
      rosterNeed: {
        starterCoverageBefore: 0,
        starterCoverageAfter: 1,
        filledOpenStarterSlot: true,
      },
      opportunityCost: {
        selectedTier: 2,
        bestAvailableTier: 1,
        tierGap: 1,
        bestAvailableAdp: 1,
        adpCost: 4,
      },
    });
    expect(alpha.selections[0]!.missedAlternatives[0]).toMatchObject({
      playerId: qbB,
      adpAdvantage: 4,
      outcome: "DRAFTED_LATER_BY_OPPONENT",
      laterOverallPick: 2,
      laterTeamId: teamB,
    });
    expect(alpha.marketSummary).toMatchObject({
      status: "AVAILABLE",
      coveredSelections: 2,
      reaches: 1,
      values: 1,
    });
    expect(alpha.teamStrength).toMatchObject({
      status: "AVAILABLE",
      projectedStarterPoints: 510,
      projectedRosterPoints: 510,
      leagueRank: 1,
      rankedTeamCount: 2,
    });
  });

  it("is repeatable and independent of market and projection row order", () => {
    const input = {
      config: snakeConfig,
      events: snakeEvents,
      market: snakeMarket,
      projections,
      leagueScoringProfileId: "league-ppr-v1",
    } as const;
    const first = analyzeDraft(input);
    expect(analyzeDraft(input)).toEqual(first);
    expect(
      analyzeDraft({
        ...input,
        market: { ...snakeMarket, players: [...snakeMarket.players].reverse() },
        projections: { ...projections, players: [...projections.players].reverse() },
      }),
    ).toEqual(first);
  });
});

describe("auction draft analyzer", () => {
  const config: AuctionDraftConfig = {
    mode: "AUCTION",
    minimumBid: 1,
    teams: [
      { id: teamA, name: "Alpha", rosterSlots, budget: 20 },
      { id: teamB, name: "Bravo", rosterSlots, budget: 20 },
    ],
    players,
  };
  const events: readonly DraftEvent[] = [
    {
      id: draftEventId("auction-1"),
      type: "AUCTION_PLAYER_SOLD",
      teamId: teamA,
      playerId: qbA,
      price: 10,
    },
    {
      id: draftEventId("auction-2"),
      type: "AUCTION_PLAYER_SOLD",
      teamId: teamB,
      playerId: qbB,
      price: 5,
    },
    {
      id: draftEventId("auction-3"),
      type: "AUCTION_PLAYER_SOLD",
      teamId: teamB,
      playerId: rbB,
      price: 15,
    },
    {
      id: draftEventId("auction-4"),
      type: "AUCTION_PLAYER_SOLD",
      teamId: teamA,
      playerId: rbA,
      price: 10,
    },
  ];
  const market: DraftAnalysisMarket = {
    admissionStatus: "ADMITTED",
    source: "admitted-auction-market",
    sourceVersion: "2026-07-21",
    asOf: "2026-07-21T12:00:00Z",
    players: [
      { playerId: qbA, auctionValue: 8 },
      { playerId: qbB, auctionValue: 15 },
      { playerId: rbA, auctionValue: 10 },
      { playerId: rbB, auctionValue: 7 },
    ],
  };

  it("reports paid-vs-baseline value, budget pace, max-bid legality, and hindsight alternatives", () => {
    const report = analyzeDraft({
      config,
      events,
      market,
      projections,
      leagueScoringProfileId: "league-ppr-v1",
    });
    const alpha = report.teams[0]!;
    expect(alpha.mode).toBe("AUCTION");
    if (alpha.mode !== "AUCTION") throw new Error("Expected auction analysis");
    expect(alpha.purchases[0]).toMatchObject({
      playerId: qbA,
      price: 10,
      market: {
        baselineValue: 8,
        surplus: -2,
        classification: "OVERPAY",
        classificationThresholdDollars: 1,
      },
      legality: {
        maximumLegalBidBeforePurchase: 19,
        withinMaximumBid: true,
        remainingBudgetBeforePurchase: 20,
        openSlotsBeforePurchase: 2,
      },
      missedAlternatives: [
        {
          playerId: qbB,
          baselineValue: 15,
          laterPrice: 5,
          valueAtLaterPrice: 10,
          surplusAdvantage: 12,
          laterTeamId: teamB,
        },
      ],
    });
    expect(alpha.budget).toMatchObject({
      initialBudget: 20,
      spent: 20,
      remainingBudget: 0,
      maximumLegalBid: 0,
      rosterFillRate: 1,
      budgetSpentRate: 1,
      paceDelta: 0,
    });
    expect(alpha.marketEfficiency).toEqual({
      status: "AVAILABLE",
      baselineValueAcquired: 18,
      spent: 20,
      surplus: -2,
      baselineValuePerDollar: 0.9,
    });
  });

  it("withholds aggregate efficiency when any purchase lacks a baseline", () => {
    const report = analyzeDraft({
      config,
      events,
      market: { ...market, players: market.players.filter((row) => row.playerId !== rbA) },
    });
    const alpha = report.teams[0]!;
    if (alpha.mode !== "AUCTION") throw new Error("Expected auction analysis");
    expect(alpha.marketEfficiency).toMatchObject({
      status: "PARTIAL",
      coveredPurchases: 1,
      totalPurchases: 2,
    });
  });
});

describe("draft analyzer data and invariant boundaries", () => {
  it("returns explicit no-data sections for every team without turning ADP into points", () => {
    const report = analyzeDraft({ config: snakeConfig, events: [] });

    expect(report.projectionAvailability).toMatchObject({
      status: "UNAVAILABLE",
      reason: "NO_PROJECTIONS",
    });
    expect(report.teams).toHaveLength(2);
    for (const team of report.teams) {
      expect(team.teamStrength).toMatchObject({
        status: "UNAVAILABLE",
        reason: "NO_PROJECTIONS",
      });
      expect(team.roster).toMatchObject({ rosteredPlayers: 0, openRosterSlots: 2 });
      expect(team.warnings.map((warning) => warning.code)).toContain("NO_ADMITTED_MARKET_BASELINE");
    }
  });

  it("rejects incompatible scoring and incomplete player coverage instead of publishing strength", () => {
    const mismatched = analyzeDraft({
      config: snakeConfig,
      events: snakeEvents.slice(0, 1),
      projections,
      leagueScoringProfileId: "league-standard-v1",
    });
    expect(mismatched.projectionAvailability).toMatchObject({
      status: "UNAVAILABLE",
      reason: "INCOMPATIBLE_SCORING_PROFILE",
    });
    expect(mismatched.teams[0]!.teamStrength).toMatchObject({
      status: "UNAVAILABLE",
      reason: "INCOMPATIBLE_SCORING_PROFILE",
    });

    const incomplete = analyzeDraft({
      config: snakeConfig,
      events: snakeEvents,
      projections: {
        ...projections,
        players: projections.players.filter((row) => row.playerId !== rbA),
      },
      leagueScoringProfileId: "league-ppr-v1",
    });
    expect(incomplete.teams[0]!.teamStrength).toMatchObject({
      status: "UNAVAILABLE",
      reason: "MISSING_PLAYER_PROJECTIONS",
      missingPlayerIds: [rbA],
    });
  });

  it("delegates event-stream invariants and validates source input", () => {
    const wrongTurn: DraftEvent = {
      id: draftEventId("wrong-turn"),
      type: "SNAKE_PLAYER_SELECTED",
      teamId: teamB,
      playerId: qbB,
      overallPick: 1,
    };
    expect(() => analyzeDraft({ config: snakeConfig, events: [wrongTurn] })).toThrowError(
      expect.objectContaining({ code: "WRONG_PICK" }),
    );
    expect(() =>
      analyzeDraft({
        config: snakeConfig,
        events: [],
        market: {
          ...snakeMarket,
          players: [snakeMarket.players[0]!, snakeMarket.players[0]!],
        },
      }),
    ).toThrow(/repeats player/);
    expect(() =>
      analyzeDraft({
        config: snakeConfig,
        events: [],
        market: { ...snakeMarket, admissionStatus: "UNREVIEWED" as "ADMITTED" },
      }),
    ).toThrow(/source-admitted/);
  });
});
