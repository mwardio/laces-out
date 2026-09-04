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
      rosterSlots: createRosterSlots([
        { type: "QB", count: 1 },
        { type: "RB", count: 1 },
        { type: "BENCH", count: 1 },
      ]),
      horizons: [{ id: "week", label: "Week", weight: 1 }],
      projectionsByHorizon: { week: { qb: value(10), rb: value(20) } },
    });

    expect(result.recommendations[0]?.dropPlayerId).toBeNull();
    expect(result.recommendations[0]?.weightedDelta).toBe(20);
  });

  it("preserves unlocked open-roster evaluations when the lineup is still incomplete", () => {
    const result = evaluateWaiverMoves({
      roster: [player("qb", "QB")],
      candidates: [player("wr", "WR")],
      rosterCapacity: 3,
      starterSlots: createRosterSlots([
        { type: "QB", count: 1 },
        { type: "RB", count: 1 },
      ]),
      horizons: [{ id: "week", label: "Week", weight: 1 }],
      projectionsByHorizon: { week: { qb: value(10), wr: value(20) } },
    });

    expect(result.recommendations[0]).toMatchObject({
      addPlayerId: playerId("wr"),
      dropPlayerId: null,
      improvesRoster: true,
    });
  });

  it("models an explicit replacement when the caller requires a drop", () => {
    const result = evaluateWaiverMoves({
      roster: [player("qb-current", "QB")],
      candidates: [player("qb-add", "QB")],
      rosterCapacity: 2,
      rosterSlots: createRosterSlots([
        { type: "QB", count: 1 },
        { type: "BENCH", count: 1 },
      ]),
      starterSlots: createRosterSlots([{ type: "QB", count: 1 }]),
      requireDrop: true,
      horizons: [{ id: "week", label: "Week", weight: 1 }],
      projectionsByHorizon: {
        week: { "qb-current": value(10), "qb-add": value(20) },
      },
    });

    expect(result.recommendations[0]).toMatchObject({
      addPlayerId: playerId("qb-add"),
      dropPlayerId: playerId("qb-current"),
      weightedDelta: 10,
      improvesRoster: true,
    });
    expect(result.recommendations[0]?.horizonDeltas[0]?.lineupDelta).toBe(10);
    expect(result.recommendations[0]?.explanation).toContain("qb-add for qb-current");
  });

  it("does not use spare capacity to bypass protected players when a drop is required", () => {
    const result = evaluateWaiverMoves({
      roster: [player("qb-current", "QB")],
      candidates: [player("qb-add", "QB")],
      rosterCapacity: 2,
      starterSlots: createRosterSlots([{ type: "QB", count: 1 }]),
      protectedPlayerIds: [playerId("qb-current")],
      requireDrop: true,
      horizons: [{ id: "week", label: "Week", weight: 1 }],
      projectionsByHorizon: {
        week: { "qb-current": value(10), "qb-add": value(20) },
      },
    });

    expect(result.recommendations).toEqual([]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "NO_DROPPABLE_PLAYER" }),
    );
  });

  it("keeps stored lineup locks fixed while scoring the add/drop impact", () => {
    const lockedFlex = player("locked-flex", "RB");
    const currentRb = player("rb-current", "RB");
    const benchQb = player("qb-bench", "QB");
    const receiver = player("wr-add", "WR");
    const starterSlots = createRosterSlots([
      { type: "RB", count: 1 },
      { type: "FLEX", count: 1 },
    ]);
    const flexSlot = starterSlots.find((slot) => slot.type === "FLEX");
    if (!flexSlot) throw new Error("expected a flex slot");

    const result = evaluateWaiverMoves({
      roster: [lockedFlex, currentRb, benchQb],
      candidates: [receiver],
      rosterCapacity: 3,
      rosterSlots: [...starterSlots, ...createRosterSlots([{ type: "BENCH", count: 1 }])],
      starterSlots,
      requireDrop: true,
      lineupLocks: [{ playerId: lockedFlex.id, kind: "STARTER", slotId: flexSlot.id }],
      horizons: [{ id: "week", label: "Week", weight: 1 }],
      projectionsByHorizon: {
        week: {
          "locked-flex": value(15),
          "rb-current": value(10),
          "qb-bench": value(1),
          "wr-add": value(20),
        },
      },
    });

    expect(result.recommendations[0]).toMatchObject({
      addPlayerId: receiver.id,
      dropPlayerId: benchQb.id,
      improvesRoster: true,
    });
    expect(result.recommendations[0]?.horizonDeltas[0]?.lineupDelta).toBe(0);
    expect(result.recommendations[0]?.weightedDelta).toBeCloseTo(1.9);
  });

  it("rejects a move that cannot fill the locked post-transaction lineup", () => {
    const lockedFlex = player("locked-flex", "RB");
    const droppableRb = player("rb-drop", "RB");
    const lockedBench = player("qb-bench", "QB");
    const receiver = player("wr-add", "WR");
    const starterSlots = createRosterSlots([
      { type: "RB", count: 1 },
      { type: "FLEX", count: 1 },
    ]);
    const flexSlot = starterSlots.find((slot) => slot.type === "FLEX");
    if (!flexSlot) throw new Error("expected a flex slot");

    const result = evaluateWaiverMoves({
      roster: [lockedFlex, droppableRb, lockedBench],
      candidates: [receiver],
      rosterCapacity: 3,
      rosterSlots: [...starterSlots, ...createRosterSlots([{ type: "BENCH", count: 1 }])],
      starterSlots,
      requireDrop: true,
      lineupLocks: [
        { playerId: lockedFlex.id, kind: "STARTER", slotId: flexSlot.id },
        { playerId: lockedBench.id, kind: "BENCH" },
      ],
      horizons: [{ id: "week", label: "Week", weight: 1 }],
      projectionsByHorizon: {
        week: {
          "locked-flex": value(15),
          "rb-drop": value(10),
          "qb-bench": value(1),
          "wr-add": value(1_000),
        },
      },
    });

    expect(result.recommendations).toEqual([]);
    expect(result.allEvaluations).toEqual([]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "ILLEGAL_RESULTING_ROSTER", playerId: receiver.id }),
    );
  });

  it("rejects a locked lineup whose residual player cannot occupy the constrained bench", () => {
    const quarterback = player("qb", "QB");
    const lockedFlex = player("locked-flex", "RB");
    const droppableRb = player("rb-drop", "RB");
    const receiver = player("wr-add", "WR");
    const starterSlots = createRosterSlots([
      { type: "QB", count: 1 },
      { type: "FLEX", count: 1 },
    ]);
    const flexSlot = starterSlots.find((slot) => slot.type === "FLEX");
    if (!flexSlot) throw new Error("expected a flex slot");

    const result = evaluateWaiverMoves({
      roster: [quarterback, lockedFlex, droppableRb],
      candidates: [receiver],
      rosterCapacity: 3,
      rosterSlots: [
        ...starterSlots,
        ...createRosterSlots([{ type: "BENCH", count: 1, eligiblePositions: ["RB"] }]),
      ],
      starterSlots,
      requireDrop: true,
      protectedPlayerIds: [quarterback.id],
      lineupLocks: [{ playerId: lockedFlex.id, kind: "STARTER", slotId: flexSlot.id }],
      horizons: [{ id: "week", label: "Week", weight: 1 }],
      projectionsByHorizon: {
        week: {
          qb: value(10),
          "locked-flex": value(15),
          "rb-drop": value(1),
          "wr-add": value(100),
        },
      },
    });

    expect(result.recommendations).toEqual([]);
    expect(result.allEvaluations).toEqual([]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "ILLEGAL_RESULTING_ROSTER", playerId: receiver.id }),
    );
  });

  it("requires the optimized lineup and constrained bench to share one legal assignment", () => {
    const quarterback = player("qb", "QB");
    const runningBack = player("rb", "RB");
    const currentReceiver = player("wr-current", "WR");
    const candidate = player("wr-add", "WR");
    const starterSlots = createRosterSlots([
      { type: "QB", count: 1 },
      { type: "FLEX", count: 1 },
    ]);

    const result = evaluateWaiverMoves({
      roster: [quarterback, runningBack, currentReceiver],
      candidates: [candidate],
      rosterCapacity: 3,
      rosterSlots: [
        ...starterSlots,
        ...createRosterSlots([{ type: "BENCH", count: 1, eligiblePositions: ["RB"] }]),
      ],
      starterSlots,
      requireDrop: true,
      protectedPlayerIds: [quarterback.id, runningBack.id],
      horizons: [{ id: "week", label: "Week", weight: 1 }],
      projectionsByHorizon: {
        week: {
          qb: value(10),
          rb: value(100),
          "wr-current": value(110),
          "wr-add": value(90),
        },
      },
    });

    expect(result.recommendations).toEqual([]);
    expect(result.allEvaluations).toEqual([]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "ILLEGAL_RESULTING_ROSTER", playerId: candidate.id }),
    );
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
