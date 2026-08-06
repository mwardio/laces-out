import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  createRosterSlots,
  isPlayerEligibleForSlot,
  playerId,
  rosterSlotId,
  type Player,
  type ProjectionValue,
} from "@laces-out/domain";

import { optimizeLineup } from "./index.js";

const makePlayer = (id: string, positions: Player["positions"]): Player => ({
  id: playerId(id),
  name: id,
  positions,
});

const projection = (mean: number): ProjectionValue => ({
  floor: mean - 3,
  mean,
  ceiling: mean + 5,
});

describe("optimizeLineup", () => {
  it("finds the global flex optimum rather than making a greedy slot choice", () => {
    const players = [
      makePlayer("te-elite", ["TE"]),
      makePlayer("te-low", ["TE"]),
      makePlayer("rb", ["RB"]),
    ];
    const result = optimizeLineup({
      players,
      slots: createRosterSlots([
        { type: "TE", count: 1 },
        { type: "FLEX", count: 1 },
      ]),
      projections: {
        "te-elite": projection(20),
        "te-low": projection(2),
        rb: projection(19),
      },
    });

    expect(result.feasible).toBe(true);
    expect(result.projectedPoints).toBe(39);
    expect(result.assignments.map((assignment) => assignment.playerId)).toEqual([
      playerId("rb"),
      playerId("te-elite"),
    ]);
  });

  it("honors exact starter and bench locks", () => {
    const slots = createRosterSlots([{ type: "QB", count: 1 }]);
    const result = optimizeLineup({
      players: [makePlayer("low", ["QB"]), makePlayer("high", ["QB"])],
      slots,
      projections: { low: projection(10), high: projection(30) },
      locks: [
        { playerId: playerId("low"), kind: "STARTER", slotId: slots[0]!.id },
        { playerId: playerId("high"), kind: "BENCH" },
      ],
    });

    expect(result.assignments[0]).toMatchObject({ playerId: playerId("low"), locked: true });
    expect(result.benchPlayerIds).toContain(playerId("high"));
  });

  it("returns explicit diagnostics for contradictory locks", () => {
    const slots = createRosterSlots([{ type: "QB", count: 1 }]);
    const result = optimizeLineup({
      players: [makePlayer("qb", ["QB"]), makePlayer("rb", ["RB"])],
      slots,
      projections: {},
      locks: [
        { playerId: playerId("qb"), kind: "STARTER", slotId: slots[0]!.id },
        { playerId: playerId("rb"), kind: "STARTER", slotId: slots[0]!.id },
      ],
    });

    expect(result.feasible).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "CONFLICTING_SLOT_LOCK",
    );
  });

  it("fills a legal slot even when every projection is negative", () => {
    const result = optimizeLineup({
      players: [makePlayer("qb", ["QB"])],
      slots: createRosterSlots([{ type: "QB", count: 1 }]),
      projections: { qb: projection(-2) },
    });

    expect(result.feasible).toBe(true);
    expect(result.projectedPoints).toBe(-2);
  });

  it("is deterministic for tied projections", () => {
    const input = {
      players: [makePlayer("b", ["QB"]), makePlayer("a", ["QB"])],
      slots: createRosterSlots([{ type: "QB", count: 1 }]),
      projections: { a: projection(10), b: projection(10) },
    } as const;

    expect(optimizeLineup(input).assignments[0]!.playerId).toBe(playerId("a"));
    expect(optimizeLineup(input)).toEqual(optimizeLineup(input));
  });

  it("always returns unique, eligible assignments for arbitrary scores", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -20, max: 50 }), { minLength: 4, maxLength: 12 }),
        (scores) => {
          const positions = ["QB", "RB", "WR", "TE"] as const;
          const players = scores.map((score, index) =>
            makePlayer(`p-${index}`, [positions[index % positions.length]!]),
          );
          const projections = Object.fromEntries(
            scores.map((score, index) => [`p-${index}`, projection(score)]),
          );
          const slots = createRosterSlots([
            { type: "QB", count: 1 },
            { type: "RB", count: 1 },
            { type: "WR", count: 1 },
            { type: "FLEX", count: 1 },
          ]);
          const result = optimizeLineup({ players, projections, slots });
          const byPlayerId = new Map(players.map((player) => [player.id, player]));
          const bySlotId = new Map(slots.map((slot) => [slot.id, slot]));

          expect(new Set(result.assignments.map((item) => item.playerId)).size).toBe(
            result.assignments.length,
          );
          for (const assignment of result.assignments) {
            expect(
              isPlayerEligibleForSlot(
                byPlayerId.get(assignment.playerId)!,
                bySlotId.get(assignment.slotId)!,
              ),
            ).toBe(true);
          }
        },
      ),
    );
  });

  it("reports an unfillable slot without fabricating a player", () => {
    const result = optimizeLineup({
      players: [makePlayer("rb", ["RB"])],
      slots: [
        {
          id: rosterSlotId("QB-1"),
          type: "QB",
          label: "QB",
          kind: "STARTER",
          eligiblePositions: ["QB"],
        },
      ],
      projections: { rb: projection(10) },
    });

    expect(result.feasible).toBe(false);
    expect(result.assignments).toEqual([]);
    expect(result.diagnostics.at(-1)?.code).toBe("UNFILLED_SLOT");
  });
});
