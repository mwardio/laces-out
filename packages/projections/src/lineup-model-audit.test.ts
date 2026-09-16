import { describe, expect, it } from "vitest";
import { auditLineupChallenger, lineupChallengerComponents } from "./lineup-model-audit.js";
import type { FirstPartyWeeklyStatLine } from "./first-party.js";

const target = { playerId: "runner", position: "RB", season: 2026, week: 2, team: "DEN" };
const baseline = {
  carries: 12,
  rushing_yards: 48,
  rushing_touchdowns: 1,
  targets: 4,
  receptions: 3,
  receiving_yards: 24,
  receiving_touchdowns: 0.5,
};
const line = (
  playerId: string,
  season: number,
  week: number,
  carryShare: number,
  touchdowns: number,
): FirstPartyWeeklyStatLine => ({
  playerId,
  position: "RB",
  season,
  week,
  team: "DEN",
  played: true,
  carryShare,
  targetShare: 0.1,
  components: {
    carries: carryShare * 30,
    rushing_touchdowns: touchdowns,
    targets: 4,
    receiving_touchdowns: 0.1,
  },
});
const history = [
  line("runner", 2025, 17, 0.7, 2),
  line("runner", 2025, 18, 0.7, 1),
  line("runner", 2026, 1, 0.1, 0),
  line("peer", 2026, 1, 0.5, 0.3),
];

describe("offline lineup challengers", () => {
  it("retains the baseline and refuses promotion from a favorable but tiny sample", () => {
    const result = auditLineupChallenger({
      variant: "role-and-touchdowns",
      profile: {
        id: "standard",
        rules: [
          { statId: "rushing_yards", points: 0.1 },
          { statId: "rushing_touchdowns", points: 6 },
        ],
      },
      history: [...history, line("runner", 2026, 2, 0.1, 0)],
      predictions: [
        {
          playerId: "runner",
          position: "RB",
          season: 2026,
          week: 2,
          predicted: baseline,
          baseline,
          actual: { ...baseline, rushing_touchdowns: 0 },
          floor: baseline,
          ceiling: baseline,
          trainingRows: history.length,
          calibrationRows: 0,
        },
      ],
    });
    expect(result.overall.improvement).toBeGreaterThan(0.02);
    expect(result.clearsResearchGate).toBe(false);
    expect(result.championPolicy.RB?.strategy).toBe("recency-only");
    expect(result.rollingPointCalibration.overall.mae).toBeCloseTo(6);
    expect(result.rollingPointCalibration.overall.intervalCoverage).toBeNull();
    expect(result.promotion).toContain("disabled");
  });
  it("reacts to a new-season role within the existing bounded multiplier", () => {
    const projected = lineupChallengerComponents({
      variant: "recent-role",
      target,
      history,
      baseline,
    });
    expect(projected.carries).toBeCloseTo(12 * 0.65);
    expect(projected.rushing_yards).toBeCloseTo(48 * 0.65);
    expect(projected.targets).toBeCloseTo(4);
  });
  it("shrinks touchdown rates toward position opportunity rates without reducing yards", () => {
    const projected = lineupChallengerComponents({
      variant: "regressed-touchdowns",
      target,
      history,
      baseline,
    });
    expect(projected.rushing_touchdowns).toBeLessThan(baseline.rushing_touchdowns);
    expect(projected.receiving_touchdowns).toBeLessThan(baseline.receiving_touchdowns);
    expect(projected.rushing_yards).toBe(baseline.rushing_yards);
  });
  it("excludes target/future weeks and known DNP training rows", () => {
    const expected = lineupChallengerComponents({
      variant: "role-and-touchdowns",
      target,
      history,
      baseline,
    });
    const contaminated = [
      ...history,
      line("runner", 2026, 2, 1, 20),
      line("peer", 2026, 3, 1, 40),
      { ...line("runner", 2026, 1, 0, 0), played: false },
    ];
    const projected = lineupChallengerComponents({
      variant: "role-and-touchdowns",
      target,
      history: contaminated.reverse(),
      baseline,
    });
    for (const [key, value] of Object.entries(expected))
      expect(projected[key]).toBeCloseTo(value, 12);
  });
  it("preserves unsupported positions, players without history, and zero projections", () => {
    expect(
      lineupChallengerComponents({
        variant: "role-and-touchdowns",
        target: { ...target, position: "QB" },
        history,
        baseline,
      }),
    ).toBe(baseline);
    expect(
      lineupChallengerComponents({
        variant: "role-and-touchdowns",
        target: { ...target, playerId: "rookie" },
        history,
        baseline,
      }),
    ).toBe(baseline);
    const zero = Object.fromEntries(Object.keys(baseline).map((key) => [key, 0]));
    expect(
      lineupChallengerComponents({
        variant: "role-and-touchdowns",
        target,
        history,
        baseline: zero,
      }),
    ).toEqual(zero);
  });
});
