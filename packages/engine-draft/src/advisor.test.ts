import { createRosterSlots, playerId, type Position } from "@laces-out/domain";
import { describe, expect, it } from "vitest";

import {
  deriveReplacementLevels,
  generateAuctionDollarValues,
  recommendAuctionNominations,
  recommendDraftPlayers,
  type DraftAdvisorPlayer,
} from "./index.js";

function candidate(
  id: string,
  position: Position,
  projectedPoints: number,
  extra: Partial<DraftAdvisorPlayer> = {},
): DraftAdvisorPlayer {
  return {
    playerId: playerId(id),
    name: id,
    positions: [position],
    projectedPoints,
    ...extra,
  };
}

describe("draft advisor", () => {
  const teamSlots = createRosterSlots([
    { type: "QB", count: 1 },
    { type: "RB", count: 1 },
    { type: "WR", count: 1 },
    { type: "FLEX", count: 1 },
    { type: "BENCH", count: 2 },
  ]);
  const leagueSlots = Array.from({ length: 2 }, (_, team) =>
    teamSlots
      .filter((slot) => slot.kind === "STARTER")
      .map((slot) => ({ ...slot, id: `${team}-${slot.id}` as typeof slot.id })),
  ).flat();

  it("derives dedicated and flex replacement demand without selecting a player twice", () => {
    const levels = deriveReplacementLevels(
      [
        candidate("qb-1", "QB", 300),
        candidate("qb-2", "QB", 280),
        candidate("qb-3", "QB", 250),
        candidate("rb-1", "RB", 260),
        candidate("rb-2", "RB", 240),
        candidate("rb-3", "RB", 220),
        candidate("rb-4", "RB", 200),
        candidate("wr-1", "WR", 250),
        candidate("wr-2", "WR", 230),
        candidate("wr-3", "WR", 210),
        candidate("wr-4", "WR", 190),
      ],
      leagueSlots,
    );
    expect(levels.find((level) => level.position === "QB")).toMatchObject({
      starterDemand: 2,
      projectedPoints: 250,
    });
    expect(
      (levels.find((level) => level.position === "RB")?.starterDemand ?? 0) +
        (levels.find((level) => level.position === "WR")?.starterDemand ?? 0),
    ).toBe(6);
  });

  it("ranks value, open starter need, tier cliffs, wait risk, and uncertainty transparently", () => {
    const recommendations = recommendDraftPlayers({
      availablePlayers: [
        candidate("rb-top", "RB", 260, {
          tier: 1,
          availabilityAtNextPick: 0.1,
          confidence: 0.95,
        }),
        candidate("rb-next", "RB", 220, { tier: 2 }),
        candidate("wr-top", "WR", 250, { tier: 1, risk: 0.8 }),
        candidate("wr-next", "WR", 225, { tier: 2 }),
        candidate("qb-next", "QB", 240),
      ],
      userRoster: [candidate("my-qb", "QB", 280)],
      userRosterSlots: teamSlots,
      leagueStarterSlots: leagueSlots,
      replacementLevels: new Map<Position, number>([
        ["QB", 230],
        ["RB", 200],
        ["WR", 200],
      ]),
      limit: 3,
    });
    expect(recommendations[0]).toMatchObject({ playerId: playerId("rb-top"), rank: 1 });
    expect(recommendations[0]?.factors.rosterNeedBonus).toBeGreaterThan(0);
    expect(recommendations[0]?.factors.tierUrgencyBonus).toBeGreaterThan(0);
    expect(recommendations[0]?.reasons).toContain("Unlikely to remain available at the next pick");
    expect(
      recommendations.find((recommendation) => recommendation.playerId === playerId("wr-top"))
        ?.factors.riskPenalty,
    ).toBeGreaterThan(0);
  });

  it("rejects rostered players in the available pool", () => {
    const player = candidate("same", "RB", 10);
    expect(() =>
      recommendDraftPlayers({
        availablePlayers: [player],
        userRoster: [player],
        userRosterSlots: teamSlots,
        leagueStarterSlots: leagueSlots,
      }),
    ).toThrow("already on the user's roster");
  });
});

describe("auction value generation", () => {
  it("allocates the exact league budget while preserving minimum bids", () => {
    const values = generateAuctionDollarValues({
      players: [
        { playerId: playerId("a"), valueOverReplacement: 30 },
        { playerId: playerId("b"), valueOverReplacement: 20 },
        { playerId: playerId("c"), valueOverReplacement: 10 },
        { playerId: playerId("d"), valueOverReplacement: 0 },
        { playerId: playerId("e"), valueOverReplacement: -2 },
      ],
      teams: [
        { budget: 20, rosterSlots: 2 },
        { budget: 20, rosterSlots: 2 },
      ],
      minimumBid: 1,
    });
    expect(values.filter((value) => value.draftable)).toHaveLength(4);
    expect(values.reduce((total, value) => total + value.dollarValue, 0)).toBe(40);
    expect(values.find((value) => value.playerId === playerId("e"))).toMatchObject({
      dollarValue: 0,
      draftable: false,
    });
  });

  it("separates target nominations from price-draining nominations", () => {
    expect(
      recommendAuctionNominations([
        { playerId: playerId("target"), dollarValue: 30, expectedMarketPrice: 22 },
        { playerId: playerId("drain"), dollarValue: 10, expectedMarketPrice: 25 },
      ]),
    ).toEqual([
      expect.objectContaining({ playerId: playerId("drain"), strategy: "drain", rank: 1 }),
      expect.objectContaining({ playerId: playerId("target"), strategy: "target", rank: 2 }),
    ]);
  });
});
