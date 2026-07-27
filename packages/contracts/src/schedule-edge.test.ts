import { describe, expect, it } from "vitest";

import { scheduleEdgeMatrixResponseSchema, scheduleEdgeResponseSchema } from "./index.js";

const available = { state: "available", reason: null } as const;
const algorithm = {
  version: "schedule-edge-v1",
  inputHash: "a".repeat(64),
  evidenceChecksum: "e".repeat(64),
  validationStatus: "descriptive-only",
} as const;
const window = {
  startWeek: 6,
  endWeek: 9,
  label: "Weeks 6–9",
  source: "request",
} as const;
const source = {
  dataset: "schedule",
  state: "available",
  key: "nflverse.schedules.2026",
  name: "NFL schedule",
  attribution: "nflverse",
  attributionUrl: "https://github.com/nflverse/nflverse-data",
  fetchedAt: "2026-07-27T15:00:00.000Z",
  checksumSha256: "b".repeat(64),
  coveredWeeks: Array.from({ length: 18 }, (_, index) => index + 1),
  quality: { rowsRead: 272, rowsRejected: 0, rowsUnmatched: 0, matchRate: 1 },
  reason: null,
} as const;
const definitions = {
  matchup: "League-scored, opponent-adjusted fantasy points allowed.",
  scheduleStrength: "The equal-weight mean of available matchup percentiles.",
  confidence: "Input support, not certainty about a player's result.",
  byeFeasibility: "Whether the current roster can fill every starter slot after affirmed byes.",
} as const;

function memberFixture() {
  return {
    generatedAt: "2026-07-27T15:30:00.000Z",
    algorithm,
    league: {
      id: "00000000-0000-4000-8000-000000000001",
      leagueSeasonId: "00000000-0000-4000-8000-000000000002",
      name: "North Loop Auction",
      provider: "espn",
      season: 2026,
      currentWeek: 6,
      claimedTeam: {
        id: "00000000-0000-4000-8000-000000000003",
        name: "Fourth & Long",
      },
    },
    windows: {
      selected: window,
      playoff: {
        startWeek: 15,
        endWeek: 17,
        label: "Weeks 15–17",
        source: "fallback",
      },
    },
    availability: {
      schedule: available,
      scoring: available,
      matchups: available,
      roster: available,
      projections: available,
      byeFeasibility: available,
    },
    scoring: { profileKeyHash: "c".repeat(64), warnings: [] },
    findings: [],
    roster: [],
    byeWeeks: [],
    sources: [source],
    definitions,
  };
}

function matrixFixture() {
  const member = memberFixture();
  return {
    generatedAt: member.generatedAt,
    algorithm,
    league: {
      id: member.league.id,
      leagueSeasonId: member.league.leagueSeasonId,
      name: member.league.name,
      season: member.league.season,
    },
    windows: member.windows,
    availability: {
      schedule: available,
      scoring: available,
      matchups: available,
    },
    scoring: { profileKeyHash: "c".repeat(64), warnings: [] },
    teams: [],
    sources: [source],
    definitions,
  };
}

describe("Schedule Edge contracts", () => {
  it("accepts bounded member and matrix envelopes", () => {
    expect(scheduleEdgeResponseSchema.safeParse(memberFixture()).success).toBe(true);
    expect(scheduleEdgeMatrixResponseSchema.safeParse(matrixFixture()).success).toBe(true);
  });

  it("keeps member-only roster data out of the matrix envelope", () => {
    const matrix = { ...matrixFixture(), roster: [] };
    expect(scheduleEdgeMatrixResponseSchema.safeParse(matrix).success).toBe(false);
  });

  it("bounds findings and validates deterministic hashes", () => {
    const member = memberFixture();
    const finding = {
      id: "bye-gap:8",
      kind: "bye-gap",
      severity: "critical",
      title: "Week 8 leaves a starter slot open",
      detail: "The current roster cannot fill every starter slot after affirmed byes.",
      week: 8,
      playerId: null,
      href: "/decisions",
      factors: ["Two likely starters are on an affirmed bye."],
    } as const;
    expect(
      scheduleEdgeResponseSchema.safeParse({
        ...member,
        findings: [finding, finding, finding, finding],
      }).success,
    ).toBe(false);
    expect(
      scheduleEdgeResponseSchema.safeParse({
        ...member,
        algorithm: { ...algorithm, inputHash: "not-a-sha256" },
      }).success,
    ).toBe(false);
  });

  it("requires locked evidence before publishing descriptive or validated analysis", () => {
    const member = memberFixture();
    expect(
      scheduleEdgeResponseSchema.safeParse({
        ...member,
        algorithm: { ...algorithm, evidenceChecksum: null },
      }).success,
    ).toBe(false);
    expect(
      scheduleEdgeResponseSchema.safeParse({
        ...member,
        algorithm: {
          ...algorithm,
          evidenceChecksum: null,
          validationStatus: "withheld",
        },
      }).success,
    ).toBe(true);
  });

  it("rejects directional language from descriptive-only responses", () => {
    const member = memberFixture();
    const directionalStrength = {
      state: "available",
      averagePercentile: 80,
      rank: 2,
      teamsRanked: 32,
      favorableWeeks: 1,
      neutralWeeks: 0,
      difficultWeeks: 0,
      byeWeeks: 0,
      unknownWeeks: 0,
      confidence: "high",
      weeks: [
        {
          week: 6,
          state: "game",
          opponent: "BUF",
          percentile: 80,
          label: "favorable",
          confidence: "high",
          reason: null,
        },
      ],
      reason: null,
    } as const;
    const directionalRoster = {
      playerId: "00000000-0000-4000-8000-000000000004",
      name: "Sample Player",
      primaryPosition: "QB",
      eligiblePositions: ["QB"],
      nflTeam: "MIA",
      status: "ACTIVE",
      isLikelyStarter: true,
      currentSlot: "QB",
      next: {
        week: 6,
        state: "game",
        opponent: "BUF",
        kickoffAt: null,
        reason: null,
      },
      matchup: {
        state: "available",
        percentile: 80,
        label: "favorable",
        confidence: "high",
        rawPointsAllowed: 22,
        adjustedPointsAllowed: 21,
        leagueAveragePoints: 18,
        pointDifferential: 3,
        currentGames: 6,
        priorGames: 0,
        incompleteGames: 0,
        reason: null,
      },
      selectedWindow: directionalStrength,
      playoffWindow: directionalStrength,
      projection: null,
    } as const;
    expect(
      scheduleEdgeResponseSchema.safeParse({
        ...member,
        roster: [directionalRoster],
      }).success,
    ).toBe(false);
    expect(
      scheduleEdgeResponseSchema.safeParse({
        ...member,
        findings: [
          {
            id: "favorable-window:sample",
            kind: "favorable-window",
            severity: "edge",
            title: "A favorable window",
            detail: "Directional language must remain gated.",
            week: null,
            playerId: null,
            href: null,
            factors: [],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      scheduleEdgeMatrixResponseSchema.safeParse({
        ...matrixFixture(),
        teams: [
          {
            team: "MIA",
            positions: [
              {
                position: "QB",
                selectedWindow: directionalStrength,
                playoffWindow: directionalStrength,
              },
            ],
          },
        ],
      }).success,
    ).toBe(false);
  });
});
