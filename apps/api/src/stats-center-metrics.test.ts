import type { DerivedNumericMetric } from "@laces-out/league-analytics";
import { describe, expect, it } from "vitest";

import {
  aggregateStatsCenterMetrics,
  buildTeamAirYardsByGame,
  statsCenterTeamGameKey,
  type StatsCenterMetricRow,
} from "./stats-center-metrics.js";

/** Narrows to the withheld variant so a test can assert on the disclosed reason. */
function withheld(metric: DerivedNumericMetric): { readonly reason: string } {
  if (metric.status !== "unavailable") {
    throw new Error("expected a withheld metric, got an available one");
  }
  return metric;
}

function row(
  week: number,
  components: Record<string, number>,
  advanced: Record<string, number | null> = {},
  sourceFantasyPoints: Record<string, number> = { standard: 0, ppr: 0 },
): StatsCenterMetricRow {
  return {
    season: 2025,
    week,
    gameId: `2025_0${week}_AAA_BBB`,
    team: "AAA",
    components,
    advanced,
    sourceFantasyPoints,
  };
}

function aggregate(
  rows: readonly StatsCenterMetricRow[],
  options: {
    readonly teamAirYardsByGame?: ReadonlyMap<string, number>;
    readonly teamTotalsComplete?: boolean;
    readonly targetShare?: number | null;
  } = {},
) {
  return aggregateStatsCenterMetrics({
    rows,
    teamAirYardsByGame: options.teamAirYardsByGame ?? buildTeamAirYardsByGame(rows),
    teamTotalsComplete: options.teamTotalsComplete ?? true,
    targetShare: options.targetShare ?? null,
  });
}

describe("aggregateStatsCenterMetrics", () => {
  it("sums additive components and divides per game by the games that carried the field", () => {
    const result = aggregate([
      row(1, { receiving_yards: 80, receptions: 6 }, {}, { standard: 9.5, ppr: 15.5 }),
      row(2, { receiving_yards: 40, receptions: 4 }, {}, { standard: 5, ppr: 9 }),
    ]);

    expect(result.totals.recYards).toMatchObject({ status: "available", value: 120 });
    expect(result.perGame.recYards).toMatchObject({ status: "available", value: 60 });
    expect(result.totals.receptions).toMatchObject({ value: 10, sampleSize: 2 });
    expect(result.totals.pointsPpr).toMatchObject({ value: 24.5 });
    expect(result.totals.pointsStandard).toMatchObject({ value: 14.5 });
  });

  it("excludes games missing a field rather than treating them as zero", () => {
    const result = aggregate([
      row(1, { receiving_yards: 90 }),
      // Week 2 predates the field, so it must not drag the per-game mean toward zero.
      row(2, { receptions: 3 }),
    ]);

    expect(result.totals.recYards).toMatchObject({ value: 90, sampleSize: 1 });
    expect(result.perGame.recYards).toMatchObject({ value: 90, sampleSize: 1 });
  });

  it("reports a field absent from every row as unavailable with a reason, not zero", () => {
    const result = aggregate([row(1, { receptions: 3 })]);

    expect(result.totals.passYards.status).toBe("unavailable");
    expect(result.totals.passYards.value).toBeNull();
    expect(withheld(result.totals.passYards).reason).toContain("do not carry this field");
    expect(result.perGame.passYards.status).toBe("unavailable");
  });

  it("recomputes PACR from summed yards and air yards instead of averaging per-game ratios", () => {
    // Per-game ratios are 2.0 and 0.0, so an average would report 1.0.
    const result = aggregate([
      row(1, { passing_yards: 100 }, { passingAirYards: 50 }),
      row(2, { passing_yards: 0 }, { passingAirYards: 150 }),
    ]);

    expect(result.ratios.passAirConversionRatio).toMatchObject({
      status: "available",
      value: 0.5,
    });
  });

  it("withholds PACR when air yards total zero rather than dividing by zero", () => {
    const result = aggregate([row(1, { passing_yards: 12 }, { passingAirYards: 0 })]);

    expect(result.ratios.passAirConversionRatio.status).toBe("unavailable");
    expect(withheld(result.ratios.passAirConversionRatio).reason).toContain("no denominator");
  });

  it("derives air-yards share against team totals for the same team games", () => {
    const rows = [row(1, {}, { receivingAirYards: 60 }), row(2, {}, { receivingAirYards: 40 })];
    const teamAirYardsByGame = new Map([
      [statsCenterTeamGameKey(rows[0]!), 200],
      [statsCenterTeamGameKey(rows[1]!), 100],
    ]);
    const result = aggregate(rows, { teamAirYardsByGame });

    expect(result.ratios.airYardsShare.status).toBe("available");
    expect(result.ratios.airYardsShare.value).toBeCloseTo(100 / 300, 10);
  });

  it("withholds air-yards share and WOPR when team coverage is not affirmed", () => {
    const result = aggregate([row(1, {}, { receivingAirYards: 60 })], {
      teamTotalsComplete: false,
      targetShare: 0.25,
    });

    expect(result.ratios.airYardsShare.status).toBe("unavailable");
    expect(withheld(result.ratios.airYardsShare).reason).toContain("complete team-game coverage");
    expect(result.ratios.weightedOpportunityRating.status).toBe("unavailable");
  });

  it("recomputes WOPR from target share and air-yards share", () => {
    const rows = [row(1, {}, { receivingAirYards: 50 })];
    const teamAirYardsByGame = new Map([[statsCenterTeamGameKey(rows[0]!), 200]]);
    const result = aggregate(rows, { teamAirYardsByGame, targetShare: 0.2 });

    expect(result.ratios.airYardsShare.value).toBeCloseTo(0.25, 10);
    expect(result.ratios.weightedOpportunityRating.value).toBeCloseTo(1.5 * 0.2 + 0.7 * 0.25, 10);
  });

  it("withholds WOPR when target share itself is withheld", () => {
    const rows = [row(1, {}, { receivingAirYards: 50 })];
    const teamAirYardsByGame = new Map([[statsCenterTeamGameKey(rows[0]!), 200]]);
    const result = aggregate(rows, { teamAirYardsByGame, targetShare: null });

    expect(result.ratios.weightedOpportunityRating.status).toBe("unavailable");
    expect(withheld(result.ratios.weightedOpportunityRating).reason).toContain("target share");
  });

  it("averages CPOE across the games that stored it rather than summing", () => {
    const result = aggregate([
      row(1, {}, { passingCpoe: 4 }),
      row(2, {}, { passingCpoe: -2 }),
      row(3, {}, { passingCpoe: null }),
    ]);

    expect(result.ratios.completionPercentageOverExpected).toMatchObject({
      status: "available",
      value: 1,
      sampleSize: 2,
    });
  });

  it("withholds CPOE when no included game stored it", () => {
    const result = aggregate([row(1, { receptions: 2 }, { passingCpoe: null })]);

    expect(result.ratios.completionPercentageOverExpected.status).toBe("unavailable");
  });

  it("builds team air-yards totals per team game from every supplied row", () => {
    const rows = [
      row(1, {}, { receivingAirYards: 60 }),
      row(1, {}, { receivingAirYards: 40 }),
      row(1, {}, { receivingAirYards: null }),
    ];
    const totals = buildTeamAirYardsByGame(rows);

    expect(totals.size).toBe(1);
    expect(totals.get(statsCenterTeamGameKey(rows[0]!))).toBe(100);
  });
});
