import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  createRosterSlots,
  isPlayerEligibleForSlot,
  playerId,
  rosterSlotId,
  type Player,
  type ProjectionValue,
  type RosterSlot,
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

  it("preserves WR1, WR2, and FLEX assignments tied within epsilon", () => {
    const slots = createRosterSlots([
      { type: "WR", count: 2 },
      { type: "FLEX", count: 1 },
    ]);
    const currentAssignments = [
      { playerId: playerId("wr-b"), slotId: slots[0]!.id },
      { playerId: playerId("wr-c"), slotId: slots[1]!.id },
      { playerId: playerId("wr-a"), slotId: slots[2]!.id },
    ];
    const result = optimizeLineup({
      players: ["wr-a", "wr-b", "wr-c", "wr-d"].map((id) => makePlayer(id, ["WR"])),
      slots,
      projections: {
        "wr-a": projection(10),
        "wr-b": projection(10),
        "wr-c": projection(10),
        "wr-d": projection(10 + 5e-10),
      },
      currentAssignments,
    });

    expect(result.assignments.map(({ playerId, slotId }) => ({ playerId, slotId }))).toEqual(
      expect.arrayContaining(currentAssignments),
    );
    expect(result.benchPlayerIds).toEqual([playerId("wr-d")]);
    expect(result.changes).toEqual([]);
  });

  it("uses semantic slot identities across regenerated provider slot-rule IDs", () => {
    const providerSlots = (ids: readonly [string, string, string]): readonly RosterSlot[] => [
      {
        id: rosterSlotId(ids[0]),
        type: "WR",
        label: "WR 1",
        kind: "STARTER",
        eligiblePositions: ["WR"],
      },
      {
        id: rosterSlotId(ids[1]),
        type: "WR",
        label: "WR 2",
        kind: "STARTER",
        eligiblePositions: ["WR"],
      },
      {
        id: rosterSlotId(ids[2]),
        type: "FLEX",
        label: "FLEX",
        kind: "STARTER",
        eligiblePositions: ["RB", "WR", "TE"],
      },
    ];
    const firstSlots = providerSlots(["aaa-rule:1", "bbb-rule:2", "zzz-rule:1"]);
    const refreshedSlots = providerSlots(["zzz-new-rule:1", "yyy-new-rule:2", "aaa-new-rule:1"]);
    const players = ["wr-a", "wr-b", "wr-c"].map((id) => makePlayer(id, ["WR"]));
    const projections = {
      "wr-a": projection(10),
      "wr-b": projection(10),
      "wr-c": projection(10),
    };
    const first = optimizeLineup({ players, slots: firstSlots, projections });
    const refreshed = optimizeLineup({
      players,
      slots: refreshedSlots,
      projections,
      currentAssignments: first.assignments,
    });
    const semanticAssignments = (
      assignments: typeof first.assignments,
      slots: readonly RosterSlot[],
    ) => {
      const labelById = new Map(slots.map((slot) => [slot.id, slot.label]));
      return assignments.map((assignment) => [
        labelById.get(assignment.slotId),
        assignment.playerId,
      ]);
    };

    expect(semanticAssignments(refreshed.assignments, refreshedSlots)).toEqual(
      semanticAssignments(first.assignments, firstSlots),
    );
    expect(refreshed.changes).toEqual([]);
  });

  it("still emits a real bench-to-starter improvement", () => {
    const slots = createRosterSlots([{ type: "QB", count: 1 }]);
    const result = optimizeLineup({
      players: [makePlayer("current", ["QB"]), makePlayer("upgrade", ["QB"])],
      slots,
      projections: { current: projection(10), upgrade: projection(18) },
      currentAssignments: [{ playerId: playerId("current"), slotId: slots[0]!.id }],
    });

    expect(result.assignments[0]!.playerId).toBe(playerId("upgrade"));
    expect(result.changes).toEqual([
      expect.objectContaining({
        slotId: slots[0]!.id,
        removePlayerId: playerId("current"),
        addPlayerId: playerId("upgrade"),
        projectedPointDelta: 8,
      }),
    ]);
  });

  it("preserves a locked starter while improving an unlocked slot", () => {
    const slots = createRosterSlots([{ type: "WR", count: 2 }]);
    const result = optimizeLineup({
      players: [
        makePlayer("locked-low", ["WR"]),
        makePlayer("current", ["WR"]),
        makePlayer("upgrade", ["WR"]),
      ],
      slots,
      projections: {
        "locked-low": projection(5),
        current: projection(10),
        upgrade: projection(18),
      },
      currentAssignments: [
        { playerId: playerId("locked-low"), slotId: slots[0]!.id },
        { playerId: playerId("current"), slotId: slots[1]!.id },
      ],
      locks: [{ playerId: playerId("locked-low"), kind: "STARTER", slotId: slots[0]!.id }],
    });

    expect(result.assignments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          slotId: slots[0]!.id,
          playerId: playerId("locked-low"),
          locked: true,
        }),
        expect.objectContaining({
          slotId: slots[1]!.id,
          playerId: playerId("upgrade"),
          locked: false,
        }),
      ]),
    );
    expect(result.changes).toEqual([
      expect.objectContaining({
        slotId: slots[1]!.id,
        removePlayerId: playerId("current"),
        addPlayerId: playerId("upgrade"),
      }),
    ]);
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
