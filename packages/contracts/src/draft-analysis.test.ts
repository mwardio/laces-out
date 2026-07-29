import { describe, expect, it } from "vitest";

import { draftAnalysisResponseSchema } from "./draft-analysis.js";

const snakeTeam = {
  mode: "SNAKE",
  teamId: "40000000-0000-4000-8000-000000000001",
  name: "Alpha",
  roster: {
    rosteredPlayers: 1,
    totalRosterSlots: 2,
    openRosterSlots: 1,
    starterSlots: 1,
    coveredStarterSlots: 1,
    openStarterSlots: [],
    primaryPositionCounts: [{ position: "QB", count: 1 }],
    warnings: [],
  },
  selections: [
    {
      eventId: "manual:6f1c",
      acquisition: "SNAKE_PICK",
      playerId: "50000000-0000-4000-8000-000000000001",
      playerName: "Quarterback A",
      overallPick: 1,
      market: {
        status: "AVAILABLE",
        adp: 5,
        pickVsAdp: -4,
        classification: "REACH",
        classificationThresholdPicks: 2,
      },
      rosterNeed: {
        starterCoverageBefore: 0,
        starterCoverageAfter: 1,
        filledOpenStarterSlot: true,
      },
      opportunityCost: {
        selectedTier: null,
        bestAvailableTier: null,
        tierGap: null,
        bestAvailableAdp: 1,
        adpCost: 4,
      },
      missedAlternatives: [],
      warnings: [],
    },
  ],
  marketSummary: {
    status: "AVAILABLE",
    coveredSelections: 1,
    totalSelections: 1,
    averagePickVsAdp: -4,
    values: 0,
    reaches: 1,
  },
  teamStrength: {
    status: "UNAVAILABLE",
    reason: "NO_PROJECTIONS",
    missingPlayerIds: [],
    message: "No league-scored projection set was supplied.",
  },
  warnings: [],
} as const;

const response = {
  draftId: "30000000-0000-4000-8000-000000000001",
  sequence: 1,
  generatedAt: "2026-08-24T18:05:00.000Z",
  algorithmVersion: "draft-analyzer-v1",
  inputChecksum: "a".repeat(64),
  mode: "SNAKE",
  draftStatus: "IN_PROGRESS",
  market: {
    state: "available",
    source: {
      key: "ffc.adp.2026.ppr.12",
      name: "Fantasy Football Calculator ADP",
      attribution: "Fantasy Football Calculator",
      attributionUrl: "https://fantasyfootballcalculator.com",
      sourceAsOf: "2026-08-23T00:00:00.000Z",
      fetchedAt: "2026-08-23T06:00:00.000Z",
      checksumSha256: "b".repeat(64),
      stale: false,
      matchRate: 0.97,
    },
    coveredPlayers: 1,
    poolPlayers: 2,
    droppedRows: { notInPool: 220, duplicate: 0, invalidAdp: 0 },
    auctionValuesPublished: false,
  },
  projections: {
    state: "unavailable",
    reason: "NO_COMPATIBLE_SET",
    detail:
      "No full-season projection set scored under league:ppr-v3 was published before this draft started.",
    candidatesConsidered: 0,
  },
  teams: [snakeTeam],
  warnings: [
    {
      code: "PROJECTIONS_UNAVAILABLE",
      message:
        "No full-season projection set scored under league:ppr-v3 was published before this draft started.",
    },
  ],
};

describe("draftAnalysisResponseSchema", () => {
  it("accepts a snake report whose projections are unavailable", () => {
    const result = draftAnalysisResponseSchema.safeParse(response);
    expect(result.success).toBe(true);
  });

  it("rejects an auction team inside a snake-mode report", () => {
    const mixed = {
      ...response,
      teams: [{ ...snakeTeam, mode: "AUCTION" }],
    };

    expect(draftAnalysisResponseSchema.safeParse(mixed).success).toBe(false);
  });

  it("rejects an unrecognized field so a service change cannot ship unvalidated data", () => {
    const extra = { ...response, grade: "B+" };

    expect(draftAnalysisResponseSchema.safeParse(extra).success).toBe(false);
  });

  it("rejects a checksum that is not a sha256 hex digest", () => {
    const bad = { ...response, inputChecksum: "not-a-checksum" };

    expect(draftAnalysisResponseSchema.safeParse(bad).success).toBe(false);
  });
});
