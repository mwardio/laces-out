import { describe, expect, it } from "vitest";

import {
  createRosterSlots,
  playerId,
  teamId,
  type Player,
  type ProjectionValue,
} from "@laces-out/domain";

import { evaluateTrade, rankTradePackages, type TradeTeamContext } from "./index.js";

const player = (id: string, position: Player["positions"][number]): Player => ({
  id: playerId(id),
  name: id,
  positions: [position],
});
const projection = (mean: number): ProjectionValue => ({
  floor: mean - 2,
  mean,
  ceiling: mean + 3,
});
const slots = createRosterSlots([
  { type: "QB", count: 1 },
  { type: "RB", count: 1 },
  { type: "BENCH", count: 1 },
]);
const starters = slots.filter((slot) => slot.kind === "STARTER");
const teamA: TradeTeamContext = {
  teamId: teamId("a"),
  name: "A",
  roster: [player("a-qb-low", "QB"), player("a-rb-one", "RB"), player("a-rb-two", "RB")],
  starterSlots: starters,
  rosterSlots: slots,
};
const teamB: TradeTeamContext = {
  teamId: teamId("b"),
  name: "B",
  roster: [player("b-qb-one", "QB"), player("b-qb-two", "QB"), player("b-rb-low", "RB")],
  starterSlots: starters,
  rosterSlots: slots,
};
const projections = {
  "a-qb-low": projection(10),
  "a-rb-one": projection(25),
  "a-rb-two": projection(20),
  "b-qb-one": projection(25),
  "b-qb-two": projection(20),
  "b-rb-low": projection(10),
};
const baseInput = {
  teamA,
  teamB,
  horizons: [{ id: "ros", label: "Rest of season", weight: 1 }],
  projectionsByHorizon: { ros: projections },
} as const;

describe("evaluateTrade", () => {
  it("recognizes a needs-based trade that improves both legal lineups", () => {
    const result = evaluateTrade({
      ...baseInput,
      sendsFromA: [playerId("a-rb-two")],
      sendsFromB: [playerId("b-qb-two")],
    });

    expect(result.legal).toBe(true);
    expect(result.mutuallyBeneficial).toBe(true);
    expect(result.teamA?.weightedDelta).toBeGreaterThan(0);
    expect(result.teamB?.weightedDelta).toBeGreaterThan(0);
    expect(result.teamA?.forcedDropPlayerIds).toEqual([]);
  });

  it("optimizes and exposes the forced drop on the side receiving two players", () => {
    const result = evaluateTrade({
      ...baseInput,
      sendsFromA: [playerId("a-rb-two")],
      sendsFromB: [playerId("b-qb-two"), playerId("b-rb-low")],
    });

    expect(result.legal).toBe(true);
    expect(result.teamA?.forcedDropPlayerIds).toEqual([playerId("a-qb-low")]);
    expect(result.teamA?.resultingRosterPlayerIds).not.toContain(playerId("a-qb-low"));
    expect(result.teamB?.forcedDropPlayerIds).toEqual([]);
  });

  it("returns an honest illegal result when protection prevents required drops", () => {
    const result = evaluateTrade({
      ...baseInput,
      teamA: {
        ...teamA,
        protectedPlayerIds: teamA.roster.map((item) => item.id),
      },
      sendsFromA: [playerId("a-rb-two")],
      sendsFromB: [playerId("b-qb-two"), playerId("b-rb-low")],
    });

    // The sent player leaves before the forced-drop decision; the two remaining
    // incumbents are protected and incoming players are protected by default.
    expect(result.legal).toBe(false);
    expect(result.diagnostics[0]?.code).toBe("NO_LEGAL_FORCED_DROP");
  });

  it("rejects players that are not owned by the sending side", () => {
    const result = evaluateTrade({
      ...baseInput,
      sendsFromA: [playerId("b-qb-one")],
      sendsFromB: [playerId("b-qb-two")],
    });

    expect(result.legal).toBe(false);
    expect(result.diagnostics[0]).toMatchObject({ code: "UNKNOWN_TRADED_PLAYER" });
  });

  it("rejects corrupt inputs where both teams claim the same player", () => {
    const result = evaluateTrade({
      ...baseInput,
      teamB: { ...teamB, roster: [...teamB.roster, teamA.roster[0]!] },
      sendsFromA: [playerId("a-rb-two")],
      sendsFromB: [playerId("b-qb-two")],
    });

    expect(result.legal).toBe(false);
    expect(result.diagnostics[0]?.code).toBe("INVALID_TRADE");
  });
});

describe("rankTradePackages", () => {
  it("places mutually beneficial packages ahead of one-sided packages", () => {
    const ranked = rankTradePackages(baseInput, [
      { sendsFromA: [playerId("a-rb-one")], sendsFromB: [playerId("b-rb-low")] },
      { sendsFromA: [playerId("a-rb-two")], sendsFromB: [playerId("b-qb-two")] },
    ]);

    expect(ranked[0]?.mutuallyBeneficial).toBe(true);
  });
});
