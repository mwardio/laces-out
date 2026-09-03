import { describe, expect, it } from "vitest";

import {
  assignPlayersToRosterSlots,
  canonicalNflTeamCode,
  createProjection,
  createRosterSlots,
  isPlayerEligibleForSlot,
  playerId,
  type Player,
} from "./index.js";

const player = (id: string, positions: Player["positions"]): Player => ({
  id: playerId(id),
  name: id,
  positions,
});

describe("domain roster rules", () => {
  it("expands roster rules and recognizes flex eligibility", () => {
    const slots = createRosterSlots([
      { type: "QB", count: 1 },
      { type: "FLEX", count: 2 },
      { type: "BENCH", count: 3 },
    ]);

    expect(slots).toHaveLength(6);
    expect(isPlayerEligibleForSlot(player("rb", ["RB"]), slots[1]!)).toBe(true);
    expect(isPlayerEligibleForSlot(player("qb", ["QB"]), slots[1]!)).toBe(false);
  });

  it("uses matching rather than greedy assignment for multi-position players", () => {
    const slots = createRosterSlots([
      { type: "RB", count: 1 },
      { type: "FLEX", count: 1 },
    ]);
    const result = assignPlayersToRosterSlots(
      [player("flex-only", ["WR"]), player("rb", ["RB"])],
      slots,
    );

    expect(result.feasible).toBe(true);
    expect(result.assignments).toHaveLength(2);
  });

  it("reports players that cannot fit", () => {
    const result = assignPlayersToRosterSlots(
      [player("qb-1", ["QB"]), player("qb-2", ["QB"])],
      createRosterSlots([{ type: "QB", count: 1 }]),
    );

    expect(result.feasible).toBe(false);
    expect(result.unassignedPlayerIds).toEqual([playerId("qb-2")]);
  });
});

describe("domain value validation", () => {
  it("rejects ambiguous IDs and incoherent projections", () => {
    expect(() => playerId(" player ")).toThrow(/without surrounding whitespace/);
    expect(() =>
      createProjection({
        playerId: playerId("p1"),
        horizon: "week-1",
        asOf: "2026-09-01T00:00:00Z",
        source: "test",
        floor: 12,
        mean: 10,
        ceiling: 20,
      }),
    ).toThrow(/floor <= mean <= ceiling/);
  });
});

describe("NFL team identity", () => {
  it("normalizes nflverse's Rams alias into the app's canonical code", () => {
    expect(canonicalNflTeamCode("LA")).toBe("LAR");
    expect(canonicalNflTeamCode(" lar ")).toBe("LAR");
    expect(canonicalNflTeamCode("DET")).toBe("DET");
  });
});
