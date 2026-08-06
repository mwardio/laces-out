import { describe, expect, it } from "vitest";

import { createRosterSlots, playerId, type Player, type ProjectionValue } from "@laces-out/domain";

import { evaluateWaiverMoves, recommendFaabBid } from "./index.js";

const player = (id: string, position: Player["positions"][number]): Player => ({
  id: playerId(id),
  name: id,
  positions: [position],
});
const value = (mean: number): ProjectionValue => ({ floor: mean - 2, mean, ceiling: mean + 3 });

describe("evaluateWaiverMoves", () => {
  const roster = [
    player("qb", "QB"),
    player("rb-good", "RB"),
    player("rb-drop", "RB"),
    player("wr-bench", "WR"),
  ];
  const candidates = [player("rb-add", "RB"), player("wr-add", "WR")];
  const starterSlots = createRosterSlots([
    { type: "QB", count: 1 },
    { type: "RB", count: 1 },
    { type: "FLEX", count: 1 },
  ]);
  const rosterSlots = [...starterSlots, ...createRosterSlots([{ type: "BENCH", count: 1 }])];

  it("ranks the best candidate/drop pair by legal multi-horizon roster impact", () => {
    const result = evaluateWaiverMoves({
      roster,
      candidates,
      starterSlots,
      rosterSlots,
      horizons: [
        { id: "week", label: "This week", weight: 2 },
        { id: "ros", label: "Rest of season", weight: 1 },
      ],
      projectionsByHorizon: {
        week: {
          qb: value(20),
          "rb-good": value(15),
          "rb-drop": value(5),
          "wr-bench": value(8),
          "rb-add": value(13),
          "wr-add": value(10),
        },
        ros: {
          qb: value(200),
          "rb-good": value(150),
          "rb-drop": value(50),
          "wr-bench": value(80),
          "rb-add": value(170),
          "wr-add": value(110),
        },
      },
      benchValueWeight: 0.1,
    });

    expect(result.recommendations[0]).toMatchObject({
      addPlayerId: playerId("rb-add"),
      dropPlayerId: playerId("rb-drop"),
      improvesRoster: true,
    });
    // Dropping the only QB creates an illegal full roster for either add.
    expect(result.allEvaluations).toHaveLength(6);
    expect(result.recommendations[0]!.horizonDeltas).toHaveLength(2);
  });

  it("honors protected players and filters positionally illegal results", () => {
    const result = evaluateWaiverMoves({
      roster: [player("qb", "QB")],
      candidates: [player("rb", "RB")],
      starterSlots: createRosterSlots([{ type: "QB", count: 1 }]),
      rosterSlots: createRosterSlots([{ type: "QB", count: 1 }]),
      protectedPlayerIds: [playerId("qb")],
      horizons: [{ id: "week", label: "Week", weight: 1 }],
      projectionsByHorizon: { week: { qb: value(10), rb: value(20) } },
    });

    expect(result.recommendations).toEqual([]);
    expect(result.diagnostics.map((item) => item.code)).toContain("NO_DROPPABLE_PLAYER");
  });

  it("uses an open roster spot without inventing a drop", () => {
    const result = evaluateWaiverMoves({
      roster: [player("qb", "QB")],
      candidates: [player("rb", "RB")],
      rosterCapacity: 2,
      starterSlots: createRosterSlots([
        { type: "QB", count: 1 },
        { type: "RB", count: 1 },
      ]),
      horizons: [{ id: "week", label: "Week", weight: 1 }],
      projectionsByHorizon: { week: { qb: value(10), rb: value(20) } },
    });

    expect(result.recommendations[0]?.dropPlayerId).toBeNull();
    expect(result.recommendations[0]?.weightedDelta).toBe(20);
  });

  it("deduplicates repeated candidates while surfacing a diagnostic", () => {
    const rb = player("rb", "RB");
    const result = evaluateWaiverMoves({
      roster: [player("qb", "QB")],
      candidates: [rb, rb],
      rosterCapacity: 2,
      starterSlots: createRosterSlots([{ type: "QB", count: 1 }]),
      horizons: [{ id: "week", label: "Week", weight: 1 }],
      projectionsByHorizon: { week: { qb: value(10), rb: value(5) } },
    });

    expect(result.recommendations).toHaveLength(1);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "DUPLICATE_PLAYER", playerId: playerId("rb") }),
    );
  });
});

describe("recommendFaabBid", () => {
  it("returns a bounded range and never exceeds remaining FAAB", () => {
    const recommendation = recommendFaabBid({
      weightedDelta: 50,
      remainingBudget: 17,
      urgency: 1,
      scarcity: 1,
      competition: 1,
    });

    expect(recommendation.recommendedBid).toBeGreaterThan(0);
    expect(recommendation.lowBid).toBeLessThanOrEqual(recommendation.recommendedBid);
    expect(recommendation.highBid).toBeGreaterThanOrEqual(recommendation.recommendedBid);
    expect(recommendation.highBid).toBeLessThanOrEqual(17);
  });

  it("recommends no spend for a non-improving move", () => {
    expect(
      recommendFaabBid({
        weightedDelta: -1,
        remainingBudget: 100,
        urgency: 1,
        scarcity: 1,
        competition: 1,
      }).recommendedBid,
    ).toBe(0);
  });
});
