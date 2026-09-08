import { describe, expect, it } from "vitest";

import { waiverDecisionSectionSchema } from "./index.js";

const add = {
  id: "70000000-0000-4000-8000-000000000001",
  name: "Incoming Player",
  positions: ["WR"],
  nflTeam: "CHI",
  status: "ACTIVE",
  projectedPoints: 12.4,
} as const;

const drop = {
  id: "70000000-0000-4000-8000-000000000002",
  name: "Outgoing Player",
  positions: ["WR"],
  nflTeam: "DET",
  status: "ACTIVE",
  projectedPoints: 8.1,
} as const;

const availableWaivers = {
  state: "available",
  candidateCount: 24,
  evaluatedMoveCount: 312,
  dropCandidates: [drop],
  recommendations: [
    {
      add,
      drop,
      weightedGain: 3.49,
      lineupGain: 1.2,
      faab: null,
      market: null,
      rationale: "Incoming Player for Outgoing Player improves the modeled roster.",
      dropComparisons: [
        {
          dropPlayerId: drop.id,
          weightedGain: 3.49,
          lineupGain: 1.2,
          faab: null,
        },
      ],
    },
  ],
  execution: {
    mode: "provider-required",
    provider: "espn",
    label: "Open ESPN to verify and apply manually",
    url: "https://fantasy.espn.com/football/league?leagueId=123",
  },
  restOfSeason: {
    state: "unavailable",
    reasons: [
      {
        code: "PROJECTIONS_MISSING",
        message: "No admitted rest-of-season projection release is available.",
      },
    ],
  },
  notes: [],
} as const;

describe("waiverDecisionSectionSchema", () => {
  it("accepts a recommendation with its modeled outgoing player", () => {
    expect(waiverDecisionSectionSchema.safeParse(availableWaivers).success).toBe(true);
  });

  it("rejects an add-only recommendation without a modeled drop", () => {
    const addOnly = {
      ...availableWaivers,
      recommendations: [{ ...availableWaivers.recommendations[0], drop: null }],
    };

    expect(waiverDecisionSectionSchema.safeParse(addOnly).success).toBe(false);
  });

  it("keeps comparison IDs tied to the exposed drop candidates", () => {
    const unknownComparison = {
      ...availableWaivers,
      recommendations: [
        {
          ...availableWaivers.recommendations[0],
          dropComparisons: [
            {
              ...availableWaivers.recommendations[0].dropComparisons[0],
              dropPlayerId: "70000000-0000-4000-8000-000000000099",
            },
          ],
        },
      ],
    };

    expect(waiverDecisionSectionSchema.safeParse(unknownComparison).success).toBe(false);
  });

  it("accepts an independent rest-of-season view with its own provenance", () => {
    const withRos = {
      ...availableWaivers,
      restOfSeason: {
        state: "available",
        label: "Rest of season · Weeks 3–18",
        windowStartWeek: 3,
        windowEndWeek: 18,
        projectionSet: {
          id: "60000000-0000-4000-8000-000000000002",
          source: "Laces Out rest-of-season forecast",
          version: "ros-v1",
          horizon: "rest-of-season",
          sourceObservedAt: "2026-09-15T10:00:00.000Z",
          sourceObservedAtStatus: "verified",
          importedAt: "2026-09-15T10:05:00.000Z",
        },
        projectionFreshness: {
          state: "fresh",
          observedAt: "2026-09-15T10:00:00.000Z",
          label: "Updated 2h ago",
        },
        candidateCount: 18,
        evaluatedMoveCount: 216,
        dropCandidates: [drop],
        recommendations: availableWaivers.recommendations,
        notes: ["ROS values are aggregate."],
      },
    } as const;

    expect(waiverDecisionSectionSchema.safeParse(withRos).success).toBe(true);
    expect(
      waiverDecisionSectionSchema.safeParse({
        ...withRos,
        restOfSeason: {
          ...withRos.restOfSeason,
          projectionSet: { ...withRos.restOfSeason.projectionSet, horizon: "week" },
        },
      }).success,
    ).toBe(false);
    expect(
      waiverDecisionSectionSchema.safeParse({
        ...withRos,
        restOfSeason: { ...withRos.restOfSeason, windowStartWeek: 19 },
      }).success,
    ).toBe(false);
    expect(
      waiverDecisionSectionSchema.safeParse({
        ...withRos,
        restOfSeason: {
          ...withRos.restOfSeason,
          recommendations: [
            withRos.restOfSeason.recommendations[0],
            withRos.restOfSeason.recommendations[0],
          ],
        },
      }).success,
    ).toBe(false);
  });

  it("rejects duplicate waiver targets in the weekly view", () => {
    expect(
      waiverDecisionSectionSchema.safeParse({
        ...availableWaivers,
        recommendations: [availableWaivers.recommendations[0], availableWaivers.recommendations[0]],
      }).success,
    ).toBe(false);
  });

  it("rejects ambiguous picker candidates and comparisons that omit the recommended drop", () => {
    const alternateDrop = {
      ...drop,
      id: "70000000-0000-4000-8000-000000000003",
      name: "Alternate Drop",
    } as const;

    expect(
      waiverDecisionSectionSchema.safeParse({
        ...availableWaivers,
        dropCandidates: [drop, drop],
      }).success,
    ).toBe(false);
    expect(
      waiverDecisionSectionSchema.safeParse({
        ...availableWaivers,
        dropCandidates: [drop, alternateDrop],
        recommendations: [
          {
            ...availableWaivers.recommendations[0],
            dropComparisons: [
              {
                dropPlayerId: alternateDrop.id,
                weightedGain: 1,
                lineupGain: 0,
                faab: null,
              },
            ],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("keeps the best-drop comparison and FAAB range consistent with the recommendation", () => {
    expect(
      waiverDecisionSectionSchema.safeParse({
        ...availableWaivers,
        recommendations: [
          {
            ...availableWaivers.recommendations[0],
            dropComparisons: [
              { ...availableWaivers.recommendations[0].dropComparisons[0], weightedGain: 99 },
            ],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      waiverDecisionSectionSchema.safeParse({
        ...availableWaivers,
        recommendations: [
          {
            ...availableWaivers.recommendations[0],
            faab: { low: 8, recommended: 5, high: 3 },
            dropComparisons: [
              {
                ...availableWaivers.recommendations[0].dropComparisons[0],
                faab: { low: 8, recommended: 5, high: 3 },
              },
            ],
          },
        ],
      }).success,
    ).toBe(false);
  });
});
