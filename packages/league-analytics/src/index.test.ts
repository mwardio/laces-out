import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  analyzeLeagueSeason,
  analyzePositionalStrength,
  buildOpponentScout,
  calculatePowerRankings,
  simulatePlayoffOdds,
  type AnalyzeLeagueSeasonInput,
  type SimulatePlayoffOddsInput,
} from "./index.js";

const seasonInput: AnalyzeLeagueSeasonInput = {
  teams: [{ teamId: "A" }, { teamId: "B" }, { teamId: "C" }, { teamId: "D" }],
  weeks: [
    {
      week: 1,
      performances: [
        { teamId: "A", points: 100, optimalLineupPoints: 110 },
        { teamId: "B", points: 90 },
        { teamId: "C", points: 80 },
        { teamId: "D", points: 70 },
      ],
      matchups: [
        { teamAId: "A", teamBId: "B" },
        { teamAId: "C", teamBId: "D" },
      ],
    },
    {
      week: 2,
      performances: [
        { teamId: "A", points: 90, actualLineupPoints: 90, optimalLineupPoints: 100 },
        { teamId: "B", points: 90 },
        { teamId: "C", points: 100 },
      ],
      matchups: [
        { teamAId: "A", teamBId: "C" },
        { teamAId: "B", teamBId: "D" },
      ],
    },
    {
      week: 3,
      performances: [],
      matchups: [
        { teamAId: "A", teamBId: "D" },
        { teamAId: "B", teamBId: "C" },
      ],
    },
  ],
};

describe("analyzeLeagueSeason", () => {
  it("computes weekly and season records, expected wins, luck, points, and lineup efficiency", () => {
    const result = analyzeLeagueSeason(seasonInput);
    const teamA = result.teams.find((team) => team.teamId === "A");

    expect(teamA).toBeDefined();
    expect(teamA?.actualRecord).toMatchObject({ wins: 1, losses: 1, ties: 0, games: 2 });
    expect(teamA?.allPlay).toMatchObject({ wins: 3, losses: 1, ties: 1, games: 5 });
    expect(teamA?.pointsFor).toMatchObject({ total: 190, average: 95, sampleSize: 2 });
    expect(teamA?.pointsAgainst).toMatchObject({ total: 190, average: 95, sampleSize: 2 });
    expect(teamA?.expectedWins.expectedWins).toBeCloseTo(1.25);
    expect(teamA?.expectedWins.actualWinEquivalents).toBe(1);
    expect(teamA?.expectedWins.luckWins).toBeCloseTo(-0.25);
    expect(teamA?.lineupEfficiency).toMatchObject({
      actualPoints: 190,
      optimalPoints: 210,
      eligibleWeeks: 2,
      missingWeeks: [3],
      pointsLeft: 20,
    });
    expect(teamA?.lineupEfficiency.efficiency).toBeCloseTo(190 / 210);
    expect(result.definitions.length).toBeGreaterThan(0);
    expect(result.definitions.every((item) => item.definition.length > 20)).toBe(true);
  });

  it("marks absent scores as missing and incomplete instead of recording a loss", () => {
    const result = analyzeLeagueSeason(seasonInput);
    const teamD = result.teams.find((team) => team.teamId === "D");

    expect(teamD?.missingScoringWeeks).toEqual([2, 3]);
    expect(teamD?.actualRecord).toMatchObject({ wins: 0, losses: 1, games: 1 });
    expect(teamD?.incompleteMatchups).toBe(2);
    expect(teamD?.weekly[1]).toMatchObject({
      week: 2,
      missingScore: true,
      incompleteMatchups: 1,
    });
  });

  it("honors score tie tolerance in head-to-head and all-play records", () => {
    const result = analyzeLeagueSeason({
      teams: [{ teamId: "A" }, { teamId: "B" }],
      tieTolerance: 0.01,
      weeks: [
        {
          week: 1,
          performances: [
            { teamId: "A", points: 100 },
            { teamId: "B", points: 100.005 },
          ],
          matchups: [{ teamAId: "A", teamBId: "B" }],
        },
      ],
    });

    expect(result.teams[0]?.actualRecord).toMatchObject({ ties: 1, games: 1 });
    expect(result.teams[1]?.allPlay).toMatchObject({ ties: 1, games: 1 });
  });

  it("conserves all-play wins and losses for arbitrary finite weekly scores", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -50, max: 250 }), { minLength: 2, maxLength: 12 }),
        (scores) => {
          const result = analyzeLeagueSeason({
            teams: scores.map((_, index) => ({ teamId: `team-${index}` })),
            weeks: [
              {
                week: 1,
                performances: scores.map((points, index) => ({
                  teamId: `team-${index}`,
                  points,
                })),
              },
            ],
          });
          const wins = result.teams.reduce((sum, team) => sum + team.allPlay.wins, 0);
          const losses = result.teams.reduce((sum, team) => sum + team.allPlay.losses, 0);
          const ties = result.teams.reduce((sum, team) => sum + team.allPlay.ties, 0);
          expect(wins).toBe(losses);
          expect(ties % 2).toBe(0);
          expect(result.teams.every((team) => team.allPlay.games === scores.length - 1)).toBe(true);
        },
      ),
    );
  });
});

describe("analyzePositionalStrength", () => {
  it("provides direction-aware percentiles, z-scores, ranks, ties, and coverage", () => {
    const result = analyzePositionalStrength({
      teamIds: ["C", "A", "B"],
      positions: ["QB", "RB"],
      basis: {
        id: "ros-starter-value",
        label: "ROS starter value",
        definition: "Sum of public rest-of-season projected points for likely starters.",
      },
      values: [
        { teamId: "A", position: "QB", value: 30 },
        { teamId: "B", position: "QB", value: 20 },
        { teamId: "C", position: "QB", value: 20 },
        { teamId: "A", position: "RB", value: 10 },
        { teamId: "B", position: "RB", value: 20 },
      ],
    });
    const teamA = result.teams.find((team) => team.teamId === "A");
    const teamC = result.teams.find((team) => team.teamId === "C");
    const aQuarterback = teamA?.entries.find((entry) => entry.position === "QB");
    const cQuarterback = teamC?.entries.find((entry) => entry.position === "QB");

    expect(aQuarterback).toMatchObject({ rank: 1, percentile: 100, tiedTeams: 1 });
    expect(aQuarterback?.strengthZScore).toBeGreaterThan(0);
    expect(cQuarterback).toMatchObject({ rank: 2, percentile: 25, tiedTeams: 2 });
    expect(teamC).toMatchObject({ positionsAvailable: 1, positionsExpected: 2, coverage: 0.5 });
    expect(teamC?.entries.find((entry) => entry.position === "RB")?.status).toBe("missing");
    expect(result.basis.higherIsBetter).toBe(true);
  });

  it("makes a lower raw value a positive strength when lower is better", () => {
    const result = analyzePositionalStrength({
      teamIds: ["A", "B"],
      basis: {
        id: "cost",
        label: "Cost",
        definition: "Projected acquisition cost.",
        higherIsBetter: false,
      },
      values: [
        { teamId: "A", position: "QB", value: 5 },
        { teamId: "B", position: "QB", value: 10 },
      ],
    });

    expect(result.teams.find((team) => team.teamId === "A")?.entries[0]).toMatchObject({
      rank: 1,
      percentile: 100,
      strengthZScore: 1,
    });
  });
});

describe("calculatePowerRankings", () => {
  const teams = [
    {
      teamId: "B",
      previousRank: 1,
      factorValues: {
        "actual-win-percentage": 0.5,
        "all-play-win-percentage": 0.5,
        "points-for-per-week": 100,
        "lineup-efficiency": 0.9,
        "positional-strength-percentile": 50,
      },
    },
    {
      teamId: "A",
      previousRank: 2,
      factorValues: {
        "actual-win-percentage": 0.5,
        "all-play-win-percentage": 0.5,
        "points-for-per-week": 100,
        "lineup-efficiency": 0.9,
        "positional-strength-percentile": 50,
      },
    },
  ] as const;

  it("uses a disclosed deterministic tie-break and reports rank movement", () => {
    const first = calculatePowerRankings({ teams });
    const reordered = calculatePowerRankings({ teams: [...teams].reverse() });

    expect(first).toEqual(reordered);
    expect(first.rankings.map((team) => team.teamId)).toEqual(["A", "B"]);
    expect(first.rankings[0]).toMatchObject({ rank: 1, movement: 1, tiedOnScore: true });
    expect(first.rankings[1]).toMatchObject({ rank: 2, movement: -1, tiedOnScore: true });
  });

  it("renormalizes available factors and exposes each contribution", () => {
    const result = calculatePowerRankings({
      teams: [
        {
          teamId: "A",
          factorValues: {
            "actual-win-percentage": 0.75,
            "all-play-win-percentage": null,
          },
        },
      ],
    });
    const ranking = result.rankings[0];
    const includedWeights =
      ranking?.factors.reduce((sum, factor) => sum + factor.effectiveWeight, 0) ?? 0;

    expect(ranking?.score).toBe(75);
    expect(includedWeights).toBeCloseTo(1);
    expect(ranking?.dataCoverage).toBeCloseTo(0.3);
    expect(
      ranking?.factors.find((factor) => factor.id === "all-play-win-percentage"),
    ).toMatchObject({ included: false, contribution: 0 });
  });
});

describe("buildOpponentScout", () => {
  it("reports raw and direction-aware matchup deltas", () => {
    const result = buildOpponentScout({
      subjectTeamId: "A",
      opponentTeamId: "B",
      metrics: [
        {
          id: "projected-points",
          label: "Projected points",
          definition: "Public consensus projection for the upcoming week.",
          subjectValue: 100,
          opponentValue: 110,
          leagueAverage: 105,
        },
        {
          id: "turnovers",
          label: "Turnovers",
          definition: "Expected turnovers; lower is better.",
          subjectValue: 5,
          opponentValue: 3,
          leagueAverage: 4,
          higherIsBetter: false,
        },
        {
          id: "qb-strength",
          label: "QB strength",
          definition: "ROS projected QB value.",
          subjectValue: null,
          opponentValue: 12,
        },
      ],
    });

    expect(result.metrics[0]).toMatchObject({
      opponentMinusSubject: 10,
      opponentMinusLeague: 5,
      subjectAdvantage: -10,
      opponentStrengthVsLeague: 5,
      edgeOwner: "opponent",
    });
    expect(result.metrics[1]).toMatchObject({
      opponentMinusSubject: -2,
      subjectAdvantage: -2,
      opponentStrengthVsLeague: 1,
      edgeOwner: "opponent",
    });
    expect(result.unavailableMetrics).toEqual(["qb-strength"]);
    expect(result.opponentAdvantages).toEqual(["projected-points", "turnovers"]);
  });
});

describe("simulatePlayoffOdds", () => {
  const input: SimulatePlayoffOddsInput = {
    teams: [
      { teamId: "A", wins: 5, losses: 3, ties: 0, pointsFor: 850, projectedPointsPerWeek: 110 },
      { teamId: "B", wins: 4, losses: 4, ties: 0, pointsFor: 820, projectedPointsPerWeek: 105 },
      { teamId: "C", wins: 4, losses: 4, ties: 0, pointsFor: 800, projectedPointsPerWeek: 100 },
      { teamId: "D", wins: 3, losses: 5, ties: 0, pointsFor: 780, projectedPointsPerWeek: 95 },
    ],
    remainingMatchups: [
      { week: 9, teamAId: "A", teamBId: "D" },
      { week: 9, teamAId: "B", teamBId: "C" },
      { week: 10, teamAId: "A", teamBId: "C" },
      { week: 10, teamAId: "B", teamBId: "D" },
    ],
    playoffTeamCount: 2,
    simulations: 2_000,
    seed: "league-2026-week-8",
    defaultScoringStandardDeviation: 14,
  };

  it("is seeded, deterministic, input-order stable, and bounded", () => {
    const first = simulatePlayoffOdds(input);
    const repeated = simulatePlayoffOdds(input);
    const reordered = simulatePlayoffOdds({
      ...input,
      teams: [...input.teams].reverse(),
      remainingMatchups: [...input.remainingMatchups].reverse().map((matchup) => ({
        week: matchup.week,
        teamAId: matchup.teamBId,
        teamBId: matchup.teamAId,
      })),
    });

    expect(first).toEqual(repeated);
    expect(first).toEqual(reordered);
    for (const team of first.teams) {
      expect(team.playoffProbability).toBeGreaterThanOrEqual(0);
      expect(team.playoffProbability).toBeLessThanOrEqual(1);
      expect(team.seedProbabilities.reduce((sum, seed) => sum + seed.probability, 0)).toBeCloseTo(
        1,
      );
      expect(team.expectedSeed).toBeGreaterThanOrEqual(1);
      expect(team.expectedSeed).toBeLessThanOrEqual(input.teams.length);
    }
    expect(first.teams.reduce((sum, team) => sum + team.playoffProbability, 0)).toBeCloseTo(
      input.playoffTeamCount,
    );
  });

  it("has invariant bounded probabilities for arbitrary seeds", () => {
    fc.assert(
      fc.property(fc.integer(), (seed) => {
        const result = simulatePlayoffOdds({ ...input, simulations: 50, seed });
        expect(
          result.teams.every(
            (team) => team.playoffProbability >= 0 && team.playoffProbability <= 1,
          ),
        ).toBe(true);
      }),
      { numRuns: 20 },
    );
  });

  it("reuses one weekly score and points-for contribution across doubleheaders", () => {
    const result = simulatePlayoffOdds({
      teams: [
        {
          teamId: "A",
          wins: 0,
          losses: 0,
          ties: 0,
          pointsFor: 0,
          projectedPointsPerWeek: 100,
          scoringStandardDeviation: 0,
        },
        {
          teamId: "B",
          wins: 0,
          losses: 0,
          ties: 0,
          pointsFor: 0,
          projectedPointsPerWeek: 90,
          scoringStandardDeviation: 0,
        },
        {
          teamId: "C",
          wins: 0,
          losses: 0,
          ties: 0,
          pointsFor: 0,
          projectedPointsPerWeek: 80,
          scoringStandardDeviation: 0,
        },
      ],
      remainingMatchups: [
        { week: 1, teamAId: "A", teamBId: "B" },
        { week: 1, teamAId: "A", teamBId: "C" },
      ],
      playoffTeamCount: 1,
      simulations: 2,
      seed: 5,
    });

    expect(result.teams.find((team) => team.teamId === "A")).toMatchObject({
      averageFinalWins: 2,
      averageFinalPointsFor: 100,
      playoffProbability: 1,
    });
  });
});
