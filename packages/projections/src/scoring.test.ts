import { describe, expect, it } from "vitest";

import {
  normalizeHistoricalPlayerStatComponents,
  projectionScoringProfileKey,
  projectionScoringProfilesAreCompatible,
  scoreProjectionStatComponents,
  validateProjectionScoringProfile,
  type ProjectionScoringProfile,
} from "./scoring.js";

describe("normalizeHistoricalPlayerStatComponents", () => {
  it("adds the canonical aggregate fields used by league scoring without dropping source fields", () => {
    expect(
      normalizeHistoricalPlayerStatComponents({
        receptions: 4,
        fumbles_lost_total: 1,
        passing_interceptions: 2,
        passing_two_point_conversions: 1,
        rushing_two_point_conversions: 2,
        receiving_two_point_conversions: 1,
        punt_return_yards: 18,
        kickoff_return_yards: 32,
        special_teams_touchdowns: 1,
      }),
    ).toMatchObject({
      receptions: 4,
      fumbles_lost: 1,
      turnovers: 3,
      two_point_conversions: 4,
      return_yards: 50,
      return_touchdowns: 1,
    });
  });

  it("treats absent or non-finite aggregate inputs as zero", () => {
    expect(
      normalizeHistoricalPlayerStatComponents({
        fumbles_lost_total: Number.NaN,
        punt_return_yards: -1,
      }),
    ).toMatchObject({
      fumbles_lost: 0,
      turnovers: 0,
      two_point_conversions: 0,
      return_yards: 0,
      return_touchdowns: 0,
    });
  });
});

const standard: ProjectionScoringProfile = {
  id: "standard",
  rules: [
    { statId: "rushing_yards", points: 0.1 },
    { statId: "receiving_yards", points: 0.1 },
    { statId: "rushing_touchdowns", points: 6 },
  ],
};

const halfPpr: ProjectionScoringProfile = {
  id: "half-ppr",
  rules: [...standard.rules, { statId: "receptions", points: 0.5 }],
};

const fullPpr: ProjectionScoringProfile = {
  id: "ppr",
  rules: [...standard.rules, { statId: "receptions", points: 1 }],
};

describe("scoreProjectionStatComponents", () => {
  const statLine = {
    rushing_yards: 80,
    receiving_yards: 40,
    rushing_touchdowns: 1,
    receptions: 6,
    ignored_stat: 100,
  };

  it("scores standard, half-PPR, and PPR leagues from the same raw components", () => {
    expect(scoreProjectionStatComponents(statLine, standard)).toBe(18);
    expect(scoreProjectionStatComponents(statLine, halfPpr)).toBe(21);
    expect(scoreProjectionStatComponents(statLine, fullPpr)).toBe(24);
  });

  it("applies cumulative threshold bonuses deterministically", () => {
    const profile: ProjectionScoringProfile = {
      id: "passing-bonuses",
      rules: [
        {
          statId: "passing_yards",
          points: 0.04,
          bonuses: [
            { atLeast: 400, points: 2 },
            { atLeast: 300, points: 3 },
          ],
        },
        { statId: "interceptions", points: -2 },
      ],
    };

    expect(scoreProjectionStatComponents({ passing_yards: 425, interceptions: 1 }, profile)).toBe(
      20,
    );
  });

  it("rejects invalid profiles and non-finite component values", () => {
    expect(() =>
      validateProjectionScoringProfile({
        id: "duplicate",
        rules: [
          { statId: "receptions", points: 1 },
          { statId: "receptions", points: 0.5 },
        ],
      }),
    ).toThrow("duplicate statId");
    expect(() => scoreProjectionStatComponents({ receptions: Number.NaN }, fullPpr)).toThrow(
      "must be finite",
    );
  });
});

describe("projection scoring profile compatibility", () => {
  it("uses scoring behavior rather than profile metadata or source rule order", () => {
    const equivalentPpr: ProjectionScoringProfile = {
      id: "provider-specific-name",
      version: "2026-07-21",
      rules: [...fullPpr.rules].reverse(),
    };

    expect(projectionScoringProfilesAreCompatible(fullPpr, equivalentPpr)).toBe(true);
    expect(projectionScoringProfileKey(fullPpr)).toBe(projectionScoringProfileKey(equivalentPpr));
    expect(projectionScoringProfilesAreCompatible(fullPpr, halfPpr)).toBe(false);
  });
});
