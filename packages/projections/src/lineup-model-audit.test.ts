import { describe, expect, it } from "vitest";
import {
  auditLineupChallenger,
  auditLineupProduction,
  lineupChallengerComponents,
} from "./lineup-model-audit.js";
import {
  runFirstPartyProjectionBacktest,
  type FirstPartyBacktestPrediction,
  type FirstPartyWeeklyStatLine,
} from "./first-party.js";

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
    expect(result).not.toHaveProperty("finalPolicyPointCalibration");
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

describe("locked production lineup diagnostics", () => {
  const profile = { id: "yards", rules: [{ statId: "receiving_yards", points: 0.1 }] };
  const makePrediction = (
    playerId: string,
    week: number,
    actualPoints = 10,
  ): FirstPartyBacktestPrediction => ({
    playerId,
    position: "WR",
    season: 2025,
    week,
    predicted: { receiving_yards: actualPoints * 10 },
    baseline: { receiving_yards: 80 },
    actual: { receiving_yards: actualPoints * 10 },
    floor: { receiving_yards: 0 },
    ceiling: { receiving_yards: 200 },
    trainingRows: 100,
    calibrationRows: 100,
  });
  const makeHistory = (
    predictions: readonly FirstPartyBacktestPrediction[],
  ): FirstPartyWeeklyStatLine[] =>
    predictions.map((row) => ({
      playerId: row.playerId,
      position: row.position,
      season: row.season,
      week: row.week,
      team: "DEN",
      played: true,
      components: row.actual,
    }));
  const report = (
    predictions: readonly FirstPartyBacktestPrediction[],
    history = makeHistory(predictions),
  ) =>
    auditLineupProduction({
      history,
      profile,
      backtest: { ...runFirstPartyProjectionBacktest([]), predictions },
    });

  it("never backfills early forecasts with the strategy selected after later outcomes", () => {
    const predictions = Array.from({ length: 9 }, (_, week) =>
      Array.from({ length: 16 }, (_, player) =>
        makePrediction(`player-${player}`, week + 1, 10 + (player % 2)),
      ),
    ).flat();
    const result = report(predictions);
    expect(result.finalLivePolicy.WR?.strategy).toBe("first-party-model");
    expect(result.byWeek["2025:1"]?.candidateMae).toBe(2.5);
    expect(result.byWeek["2025:1"]?.candidateMae).toBe(result.byWeek["2025:1"]?.baselineMae);
    expect(result.byWeek["2025:9"]?.candidateMae).toBe(0);
    expect(result.byWeek["2025:9"]?.baselineRankAccuracy).toBe(0.5);
    expect(result.byWeek["2025:9"]?.candidateRankAccuracy).toBe(1);
    expect(result.byWeek["2025:9"]?.candidateRegret).toBe(0);
    const prefix = predictions.filter((row) => row.week < 9);
    const short = report(prefix);
    for (let week = 1; week < 9; week++)
      expect(result.byWeek[`2025:${week}`]).toEqual(short.byWeek[`2025:${week}`]);
  });

  it("reports omitted cold starts separately and counts only prior played games for sparse cohorts", () => {
    const prediction = makePrediction("experienced", 3);
    const history = [
      ...makeHistory([makePrediction("experienced", 1)]),
      { ...makeHistory([makePrediction("experienced", 2)])[0]!, played: false },
      ...makeHistory([prediction, makePrediction("rookie", 3)]),
    ];
    const result = report([prediction], history);
    expect(result.historyCohorts["0"]).toMatchObject({
      observedOutcomeRows: 1,
      predictedRows: 0,
      omittedOutcomeRows: 1,
      candidateMae: null,
      baselineMae: null,
    });
    expect(result.historyCohorts["1-3"]).toMatchObject({
      observedOutcomeRows: 1,
      predictedRows: 1,
      omittedOutcomeRows: 0,
    });
    expect(result.overall.samples).toBe(1);
    expect(result.overall.candidateRankAccuracy).toBeNull();
    expect(result.overall.comparisonPairs).toBe(0);
  });

  it("fails on absent or duplicate outcomes instead of silently miscounting cohorts", () => {
    const prediction = makePrediction("runner", 1);
    expect(() => report([prediction], [])).toThrow(/absent/);
    expect(() =>
      report([prediction], [...makeHistory([prediction]), ...makeHistory([prediction])]),
    ).toThrow(/Duplicate historical lineup outcome/);
    expect(() => report([prediction, prediction], makeHistory([prediction]))).toThrow(
      /Duplicate historical lineup prediction/,
    );
  });

  it("treats floating-point noise as tied fantasy scores for rank and regret", () => {
    const result = report([makePrediction("left", 1, 9), makePrediction("right", 1, 9 + 1e-12)]);
    expect(result.overall).toMatchObject({
      comparisonPairs: 1,
      rankedPairs: 0,
      baselineRegret: 0,
      candidateRegret: 0,
      candidateRankAccuracy: null,
    });
  });
});
