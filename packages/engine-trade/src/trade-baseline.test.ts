import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";

import {
  createRosterSlots,
  playerId,
  teamId,
  type Player,
  type ProjectionValue,
} from "@laces-out/domain";
import * as lineupEngine from "@laces-out/engine-lineup";

import {
  createTradeEvaluator,
  evaluateTrade,
  rankTradePackages,
  type EvaluateTradeInput,
  type TradePackage,
} from "./index.js";

type Context = Omit<EvaluateTradeInput, "sendsFromA" | "sendsFromB">;

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

function context(scores = [10, 25, 20, 25, 20, 10]): Context {
  const slots = createRosterSlots([
    { type: "QB", count: 1 },
    { type: "RB", count: 1 },
    { type: "BENCH", count: 1 },
  ]);
  const rosterA = [player("aq", "QB"), player("ar", "RB"), player("ar2", "RB")];
  const rosterB = [player("bq", "QB"), player("bq2", "QB"), player("br", "RB")];
  const rows = [...rosterA, ...rosterB].map((row, i) => [row.id, projection(scores[i]!)] as const);
  return {
    teamA: {
      teamId: teamId("a"),
      name: "A",
      roster: rosterA,
      starterSlots: slots.filter((slot) => slot.kind === "STARTER"),
      rosterSlots: slots,
    },
    teamB: {
      teamId: teamId("b"),
      name: "B",
      roster: rosterB,
      starterSlots: slots.filter((slot) => slot.kind === "STARTER"),
      rosterSlots: slots,
    },
    horizons: [
      { id: "week", label: "Week", weight: 0.7, metric: "floor" },
      { id: "ros", label: "ROS", weight: 0.3, metric: "ceiling" },
    ],
    projectionsByHorizon: {
      week: Object.fromEntries(rows),
      ros: new Map(rows.map(([id, value]) => [id, projection(value.mean * 1.8)])),
    },
    benchValueWeight: 0.23,
  };
}

const packages: readonly TradePackage[] = [
  { sendsFromA: [playerId("ar2")], sendsFromB: [playerId("bq2")] },
  { sendsFromA: [playerId("ar")], sendsFromB: [playerId("br")] },
  { sendsFromA: [playerId("ar2")], sendsFromB: [playerId("bq2"), playerId("br")] },
  { sendsFromA: [playerId("ar"), playerId("ar2")], sendsFromB: [playerId("bq2")] },
];

function outcome(evaluate: () => unknown): unknown {
  try {
    return { value: evaluate() };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { error: { name: error.name, message: error.message } };
  }
}

afterEach(() => vi.restoreAllMocks());

describe("createTradeEvaluator", () => {
  it("preserves exact package results across weighted horizons and generated projection ties", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -10, max: 50 }), { minLength: 6, maxLength: 6 }),
        (scores) => {
          const input = context(scores);
          const evaluate = createTradeEvaluator(input);
          for (const tradePackage of [...packages, ...packages.toReversed()]) {
            expect(evaluate(tradePackage)).toEqual(evaluateTrade({ ...input, ...tradePackage }));
          }
        },
      ),
      { seed: 918_2026, numRuns: 35 },
    );
  });

  it("evaluates each original roster once per horizon and keeps resulting-roster work", () => {
    const optimize = vi.spyOn(lineupEngine, "optimizeLineup");
    const input = context();
    const evaluate = createTradeEvaluator(input);
    expect(optimize).not.toHaveBeenCalled();
    evaluate(packages[0]!);
    expect(optimize).toHaveBeenCalledTimes(8);
    optimize.mockClear();
    evaluate(packages[1]!);
    expect(optimize).toHaveBeenCalledTimes(4);
    const otherRequest = createTradeEvaluator(input);
    optimize.mockClear();
    otherRequest(packages[0]!);
    expect(optimize).toHaveBeenCalledTimes(8);
  });

  it("keeps invalid-package diagnostics and validation order before and after warmup", () => {
    const input = context();
    const evaluate = createTradeEvaluator(input);
    const optimize = vi.spyOn(lineupEngine, "optimizeLineup");
    const invalid: TradePackage[] = [
      { sendsFromA: [], sendsFromB: [playerId("bq")] },
      { sendsFromA: [playerId("missing-a")], sendsFromB: [playerId("missing-b")] },
      { sendsFromA: [playerId("ar"), playerId("ar")], sendsFromB: [playerId("br")] },
    ];
    for (const tradePackage of invalid) {
      expect(outcome(() => evaluate(tradePackage))).toEqual(
        outcome(() => evaluateTrade({ ...input, ...tradePackage })),
      );
    }
    expect(optimize).not.toHaveBeenCalled();
    evaluate(packages[0]!);
    for (const tradePackage of invalid) {
      expect(outcome(() => evaluate(tradePackage))).toEqual(
        outcome(() => evaluateTrade({ ...input, ...tradePackage })),
      );
    }
  });

  it("does not share baselines when matching team IDs have different context", () => {
    const input = context();
    const original = createTradeEvaluator(input);
    const first = original(packages[0]!);
    const changed: Context[] = [
      context([100, 25, 20, 25, 20, 10]),
      { ...input, benchValueWeight: 0.9 },
      { ...input, horizons: [{ id: "week", label: "Changed horizon", weight: 1, metric: "mean" }] },
      { ...input, teamA: { ...input.teamA, starterSlots: [] } },
      {
        ...input,
        teamA: {
          ...input.teamA,
          roster: input.teamA.roster.map((row) => ({ ...row, positions: ["QB"] })),
        },
      },
      {
        ...input,
        teamA: { ...input.teamA, protectedPlayerIds: input.teamA.roster.map((row) => row.id) },
      },
      { ...input, protectIncomingPlayers: false },
    ];
    for (const revised of changed) {
      const evaluate = createTradeEvaluator(revised);
      for (const tradePackage of packages) {
        expect(evaluate(tradePackage)).toEqual(evaluateTrade({ ...revised, ...tradePackage }));
      }
    }
    expect(createTradeEvaluator(changed[0]!)(packages[0]!)).not.toEqual(first);
    expect(original(packages[0]!)).toEqual(first);
  });

  it("preserves lazy invalid-context behavior including an empty ranked search", () => {
    const input = context();
    const invalid: Context[] = [
      { ...input, benchValueWeight: -1 },
      { ...input, teamB: { ...input.teamB, teamId: input.teamA.teamId } },
      { ...input, horizons: [] },
      { ...input, horizons: [input.horizons[0]!, input.horizons[0]!] },
      { ...input, horizons: [{ id: "missing", label: "Missing", weight: 1 }] },
      { ...input, horizons: [{ id: "week", label: "Bad weight", weight: NaN }] },
      { ...input, teamA: { ...input.teamA, rosterCapacity: -1 } },
      {
        ...input,
        teamA: { ...input.teamA, roster: [...input.teamA.roster, input.teamA.roster[0]!] },
      },
      {
        ...input,
        teamB: { ...input.teamB, roster: [...input.teamB.roster, input.teamA.roster[0]!] },
      },
    ];
    for (const revised of invalid) {
      expect(rankTradePackages(revised, [])).toEqual([]);
      const evaluate = createTradeEvaluator(revised);
      for (const tradePackage of packages) {
        expect(outcome(() => evaluate(tradePackage))).toEqual(
          outcome(() => evaluateTrade({ ...revised, ...tradePackage })),
        );
      }
    }
  });

  it("caches an illegal baseline without bypassing constrained bench legality", () => {
    const slots = createRosterSlots([
      { type: "QB", count: 1 },
      { type: "FLEX", count: 1 },
      { type: "BENCH", count: 1, eligiblePositions: ["RB"] },
    ]);
    const input: Context = {
      teamA: {
        teamId: teamId("a"),
        name: "A",
        roster: [player("aq", "QB"), player("ar", "RB"), player("aw", "WR")],
        starterSlots: slots.filter((slot) => slot.kind === "STARTER"),
        rosterSlots: slots,
      },
      teamB: {
        teamId: teamId("b"),
        name: "B",
        roster: [player("bq", "QB"), player("br", "RB"), player("bw", "WR")],
        starterSlots: slots.filter((slot) => slot.kind === "STARTER"),
        rosterSlots: slots,
      },
      horizons: [{ id: "week", label: "Week", weight: 1 }],
      projectionsByHorizon: {
        week: Object.fromEntries(
          Object.entries({ aq: 10, ar: 100, aw: 90, bq: 10, br: 5, bw: 110 }).map(
            ([id, points]) => [id, projection(points)],
          ),
        ),
      },
    };
    const tradePackage = { sendsFromA: [playerId("aw")], sendsFromB: [playerId("bw")] };
    const expected = evaluateTrade({ ...input, ...tradePackage });
    expect(expected.diagnostics[0]?.code).toBe("ILLEGAL_RESULTING_ROSTER");
    const evaluate = createTradeEvaluator(input);
    const optimize = vi.spyOn(lineupEngine, "optimizeLineup");
    expect(evaluate(tradePackage)).toEqual(expected);
    expect(optimize).toHaveBeenCalledTimes(4);
    optimize.mockClear();
    expect(evaluate(tradePackage)).toEqual(expected);
    expect(optimize).toHaveBeenCalledTimes(2);
  });
});
