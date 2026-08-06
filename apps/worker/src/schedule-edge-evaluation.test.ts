import {
  type ScheduleEdgeGamePositionTotal,
  type ScheduleEdgeGamePositionTotalsResult,
  type ScheduleEdgePolicy,
} from "@laces-out/league-analytics";
import { describe, expect, it } from "vitest";

import { evaluateScheduleEdgeHistory } from "./schedule-edge-evaluation.js";

const policy: ScheduleEdgePolicy = {
  version: "test-equal-v1",
  labelsEnabled: false,
  validatedPositions: [],
  offenseShrinkageGames: 2,
  defenseShrinkageGames: 1,
  priorSeasonPseudoGames: 2,
  highConfidenceGames: 4,
  minimumCurrentSeasonGamesForLabel: 1,
  recencyDecay: null,
  allowPriorOnlyLabels: false,
  minimumPointDifferentialByPosition: { QB: 1, RB: 1, WR: 1, TE: 1 },
};
const evidenceChecksum = "e".repeat(64);

function totals(
  overrides: readonly ScheduleEdgeGamePositionTotal[] = [],
): ScheduleEdgeGamePositionTotalsResult {
  const positions = ["QB", "RB", "WR", "TE"] as const;
  const defenses = [
    { team: "EAS", points: 24 },
    { team: "AVG", points: 16 },
    { team: "HRD", points: 8 },
  ] as const;
  const offenses = ["AAA", "BBB", "CCC"] as const;
  const rows: ScheduleEdgeGamePositionTotal[] = [];
  for (const season of [2022, 2023, 2024, 2025]) {
    for (let week = 1; week <= 4; week += 1) {
      for (const [defenseIndex, defense] of defenses.entries()) {
        const offenseTeam = offenses[(defenseIndex + week) % offenses.length]!;
        for (const position of positions) {
          rows.push({
            season,
            week,
            gameId: `${season}_${week}_${offenseTeam}_${defense.team}`,
            offenseTeam,
            defenseTeam: defense.team,
            position,
            status: "available",
            points: defense.points + (position === "QB" ? 2 : position === "TE" ? -2 : 0),
            rosterPlayers: 3,
            scoredPlayers: 2,
            zeroStatPlayers: 1,
            unmatchedRosterRows: 0,
            unmatchedStatRows: 0,
            reasons: [],
          });
        }
      }
    }
  }
  const combined = [...rows, ...overrides];
  return {
    positions,
    scoringProfileKey: "test-profile",
    totals: combined,
    completeSlices: combined.filter((row) => row.status === "available").length,
    incompleteSlices: combined.filter((row) => row.status === "unavailable").length,
    definition: "Frozen test totals.",
  };
}

function evaluationProfile(name: "standard" | "half-ppr" | "full-ppr", inputTotals = totals()) {
  return {
    name,
    evidenceChecksum,
    totals: inputTotals,
    playerGames: inputTotals.totals.flatMap((row) =>
      row.status === "available" && row.points !== null
        ? [
            {
              season: row.season,
              week: row.week,
              gameId: row.gameId,
              playerId: `${row.position}-${row.offenseTeam}`,
              offenseTeam: row.offenseTeam,
              defenseTeam: row.defenseTeam,
              position: row.position,
              points: row.points,
            },
          ]
        : [],
    ),
  };
}

describe("Schedule Edge historical evaluation", () => {
  it("walks held-out weeks forward and validates consistently ordered evidence", () => {
    const result = evaluateScheduleEdgeHistory({
      profiles: [evaluationProfile("full-ppr")],
      candidates: [{ id: "adjusted-equal", estimator: "opponent-adjusted", policy }],
      heldOutSeasons: [2023, 2024, 2025],
      minimumSamplesPerCell: 20,
      minimumDirectionalSamplesPerCell: 5,
      minimumOrderedSeasons: 2,
      minimumRankCorrelation: 0,
      minimumBucketSpread: 1,
    });

    expect(result.selectedCandidateId).toBe("adjusted-equal");
    expect(result.leakagePolicy.defenseInputs).toBe("strictly-before-target-week");
    expect(result.evidenceChecksum).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.positionGates).toHaveLength(4);
    expect(result.positionGates.every((gate) => gate.state === "validated")).toBe(true);
    expect(result.cells.every((cell) => cell.orderedSeasons === 3)).toBe(true);
  });

  it("does not let a future season change held-out metrics", () => {
    const baseline = totals();
    const future: ScheduleEdgeGamePositionTotal = {
      season: 2026,
      week: 1,
      gameId: "2026_future",
      offenseTeam: "AAA",
      defenseTeam: "EAS",
      position: "QB",
      status: "available",
      points: 1_000,
      rosterPlayers: 3,
      scoredPlayers: 3,
      zeroStatPlayers: 0,
      unmatchedRosterRows: 0,
      unmatchedStatRows: 0,
      reasons: [],
    };
    const run = (inputTotals: ScheduleEdgeGamePositionTotalsResult) =>
      evaluateScheduleEdgeHistory({
        profiles: [evaluationProfile("standard", inputTotals)],
        candidates: [{ id: "equal", estimator: "opponent-adjusted", policy }],
        heldOutSeasons: [2023, 2024, 2025],
        minimumSamplesPerCell: 1,
        minimumOrderedSeasons: 1,
      });

    expect(run(totals([future])).cells).toEqual(run(baseline).cells);
  });

  it("fails closed when the evidence is not strong enough", () => {
    const result = evaluateScheduleEdgeHistory({
      profiles: [evaluationProfile("half-ppr")],
      candidates: [{ id: "equal", estimator: "opponent-adjusted", policy }],
      heldOutSeasons: [2023, 2024, 2025],
      minimumSamplesPerCell: 10_000,
      minimumOrderedSeasons: 3,
    });
    expect(result.positionGates.every((gate) => gate.state === "descriptive-only")).toBe(true);
    expect(result.positionGates[0]?.reasons[0]).toContain("fewer than");
  });

  it("rejects duplicate policy identities", () => {
    expect(() =>
      evaluateScheduleEdgeHistory({
        profiles: [evaluationProfile("standard")],
        candidates: [
          { id: "duplicate", estimator: "raw", policy },
          { id: "duplicate", estimator: "opponent-adjusted", policy },
        ],
        heldOutSeasons: [2023],
        minimumOrderedSeasons: 1,
      }),
    ).toThrow(/candidate IDs must be unique/u);
  });
});
