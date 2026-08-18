import { describe, expect, it } from "vitest";

import { rosScoringProfile } from "./ros-scoring-profiles.js";
import {
  projectionScoringProfileKeyForPosition,
  projectionScoringRulesFromProfileKey,
} from "./scoring-position-keys.js";
import {
  ESPN_EVERY_N_FLOOR_UNIT_COMPONENTS,
  espnEveryNFloorUnitValue,
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
        passing_yards: 405,
        rushing_yards: 145,
        receiving_yards: 205,
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
      passing_yards_300_399_probability: 0,
      passing_yards_400_plus_probability: 1,
      rushing_yards_100_199_probability: 1,
      rushing_yards_200_plus_probability: 0,
      receiving_yards_100_199_probability: 0,
      receiving_yards_200_plus_probability: 1,
      fumbles_lost: 1,
      turnovers: 3,
      two_point_conversions: 4,
      return_yards: 50,
      return_touchdowns: 1,
    });
  });

  it("derives mutually exclusive ESPN yardage-game indicators at exact boundaries", () => {
    expect(
      normalizeHistoricalPlayerStatComponents({
        passing_yards: 399.99,
        rushing_yards: 200,
        receiving_yards: 100,
      }),
    ).toMatchObject({
      passing_yards_300_399_probability: 1,
      passing_yards_400_plus_probability: 0,
      rushing_yards_100_199_probability: 0,
      rushing_yards_200_plus_probability: 1,
      receiving_yards_100_199_probability: 1,
      receiving_yards_200_plus_probability: 0,
    });
  });

  it("derives exact whole-unit counts for every supported ESPN every-N category", () => {
    const historical = {
      passing_attempts: 47,
      passing_completions: 31,
      passing_yards: 287,
      carries: 17,
      rushing_yards: 143,
      receptions: 9,
      receiving_yards: 126,
      kickoff_return_yards: 64,
      punt_return_yards: 29,
    };
    const normalized = normalizeHistoricalPlayerStatComponents(historical);

    for (const { component, source, divisor } of ESPN_EVERY_N_FLOOR_UNIT_COMPONENTS) {
      const raw =
        source === "passing_incompletions"
          ? historical.passing_attempts - historical.passing_completions
          : historical[source as keyof typeof historical];
      expect(normalized[component], component).toBe(Math.floor(raw / divisor));
      expect(espnEveryNFloorUnitValue(historical, component), component).toBe(
        Math.floor(raw / divisor),
      );
    }
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

describe("projectionScoringProfileKeyForPosition", () => {
  const league: ProjectionScoringProfile = {
    id: "league-season-1",
    rules: [
      { statId: "passing_yards", points: 0.04 },
      { statId: "passing_touchdowns", points: 4 },
      { statId: "passing_two_point_conversions", points: 2 },
      { statId: "receptions", points: 1 },
      { statId: "receiving_yards", points: 0.1 },
      { statId: "field_goals_made_50_59", points: 5 },
      { statId: "special_teams_touchdowns", points: 6 },
      { statId: "defensive_sacks", points: 1 },
    ],
  };

  function withRules(...rules: ProjectionScoringProfile["rules"]): ProjectionScoringProfile {
    const replaced = new Set(rules.map((item) => item.statId));
    return {
      ...league,
      rules: [...league.rules.filter((item) => !replaced.has(item.statId)), ...rules],
    };
  }

  const offensePositions = ["QB", "RB", "WR", "TE", "K"] as const;

  it("ignores rules outside the position's own vocabulary", () => {
    const differentDefense = withRules({ statId: "defensive_sacks", points: 2 });
    for (const position of offensePositions) {
      expect(projectionScoringProfileKeyForPosition(differentDefense, position)).toBe(
        projectionScoringProfileKeyForPosition(league, position),
      );
    }
    expect(projectionScoringProfileKeyForPosition(differentDefense, "DST")).not.toBe(
      projectionScoringProfileKeyForPosition(league, "DST"),
    );
  });

  it("separates positions by their real component vocabularies", () => {
    const differentPassingTouchdowns = withRules({ statId: "passing_touchdowns", points: 6 });
    expect(projectionScoringProfileKeyForPosition(differentPassingTouchdowns, "QB")).not.toBe(
      projectionScoringProfileKeyForPosition(league, "QB"),
    );
    // `passing_touchdowns` is only in QB's vocabulary — RB/WR/TE never receive passing volume.
    for (const position of ["RB", "WR", "TE", "K", "DST"] as const) {
      expect(projectionScoringProfileKeyForPosition(differentPassingTouchdowns, position)).toBe(
        projectionScoringProfileKeyForPosition(league, position),
      );
    }

    const differentTwoPoint = withRules({ statId: "passing_two_point_conversions", points: 4 });
    for (const position of ["QB", "RB", "WR", "TE"] as const) {
      expect(projectionScoringProfileKeyForPosition(differentTwoPoint, position)).not.toBe(
        projectionScoringProfileKeyForPosition(league, position),
      );
    }
    for (const position of ["K", "DST"] as const) {
      expect(projectionScoringProfileKeyForPosition(differentTwoPoint, position)).toBe(
        projectionScoringProfileKeyForPosition(league, position),
      );
    }
  });

  it("drops zero-point no-op rules on either side of a comparison", () => {
    const withNoop = withRules({ statId: "carries", points: 0 });
    for (const position of [...offensePositions, "DST"] as const) {
      expect(projectionScoringProfileKeyForPosition(withNoop, position)).toBe(
        projectionScoringProfileKeyForPosition(league, position),
      );
    }

    const withNegativeZero = withRules({ statId: "carries", points: -0 });
    expect(projectionScoringProfileKeyForPosition(withNegativeZero, "RB")).toBe(
      projectionScoringProfileKeyForPosition(league, "RB"),
    );

    const withZeroPointBonus = withRules({
      statId: "carries",
      points: 0,
      bonuses: [{ atLeast: 20, points: 2 }],
    });
    expect(projectionScoringProfileKeyForPosition(withZeroPointBonus, "RB")).not.toBe(
      projectionScoringProfileKeyForPosition(league, "RB"),
    );
  });

  it("is sensitive to every effective rule inside the vocabulary", () => {
    for (const statId of ["receptions", "receiving_yards", "special_teams_touchdowns"]) {
      const changed = withRules({ statId, points: 3 });
      expect(projectionScoringProfileKeyForPosition(changed, "WR")).not.toBe(
        projectionScoringProfileKeyForPosition(league, "WR"),
      );
    }
    const removed: ProjectionScoringProfile = {
      ...league,
      rules: league.rules.filter((item) => item.statId !== "receptions"),
    };
    expect(projectionScoringProfileKeyForPosition(removed, "WR")).not.toBe(
      projectionScoringProfileKeyForPosition(league, "WR"),
    );
  });

  it("yields an empty key for a position the profile prices nothing for", () => {
    const defenseOnly: ProjectionScoringProfile = {
      id: "defense-only",
      rules: [{ statId: "defensive_sacks", points: 1 }],
    };
    expect(projectionScoringProfileKeyForPosition(defenseOnly, "QB")).toBe("[]");
    expect(projectionScoringProfileKeyForPosition(defenseOnly, "DST")).not.toBe("[]");
  });

  it("recovers a rule list from a stored whole-profile key and reproduces its position keys", () => {
    const catalog = rosScoringProfile("full-ppr");
    const recovered: ProjectionScoringProfile = {
      id: "admitted-artifact",
      rules: projectionScoringRulesFromProfileKey(catalog.scoringProfileKey),
    };

    expect(projectionScoringProfileKey(recovered)).toBe(catalog.scoringProfileKey);
    for (const position of [...offensePositions, "DST"] as const) {
      expect(projectionScoringProfileKeyForPosition(recovered, position)).toBe(
        projectionScoringProfileKeyForPosition(catalog.profile, position),
      );
    }

    // The catalog key carries a zero-point rule; position keys must not inherit that unreachability.
    expect(catalog.scoringProfileKey).toContain(
      '"statId":"points_allowed_21_27_probability","points":0',
    );
    expect(projectionScoringProfileKeyForPosition(catalog.profile, "DST")).not.toContain(
      "points_allowed_21_27_probability",
    );
  });

  it("refuses a key that is not a canonical rule list", () => {
    expect(() => projectionScoringRulesFromProfileKey("not json")).toThrow(
      "not a canonical scoring profile key",
    );
    expect(() => projectionScoringRulesFromProfileKey("{}")).toThrow(
      "not a canonical scoring profile key",
    );
    expect(() => projectionScoringRulesFromProfileKey('[{"statId":"receptions"}]')).toThrow(
      "not a canonical scoring profile key",
    );
    expect(() =>
      projectionScoringRulesFromProfileKey(
        '[{"statId":"receptions","points":1,"bonuses":[]},{"statId":"receptions","points":2,"bonuses":[]}]',
      ),
    ).toThrow("duplicate statId");
  });

  it("refuses a key it cannot reproduce byte for byte", () => {
    const canonical = projectionScoringProfileKey(league);
    expect(projectionScoringRulesFromProfileKey(canonical)).toHaveLength(league.rules.length);

    // A field this code does not know about would be silently shed, producing a false match later.
    const withUnknownField = canonical.replace(
      '{"statId":"defensive_sacks","points":1,"bonuses":[]}',
      '{"statId":"defensive_sacks","points":1,"bonuses":[],"multiplierCap":400}',
    );
    expect(withUnknownField).not.toBe(canonical);
    expect(() => projectionScoringRulesFromProfileKey(withUnknownField)).toThrow(
      "not a canonical scoring profile key",
    );

    const unsorted = JSON.stringify(
      (JSON.parse(canonical) as { statId: string }[]).slice().reverse(),
    );
    expect(() => projectionScoringRulesFromProfileKey(unsorted)).toThrow(
      "not a canonical scoring profile key",
    );

    const negativeZero = canonical.replace(
      '{"statId":"defensive_sacks","points":1,"bonuses":[]}',
      '{"statId":"defensive_sacks","points":-0,"bonuses":[]}',
    );
    expect(() => projectionScoringRulesFromProfileKey(negativeZero)).toThrow(
      "not a canonical scoring profile key",
    );
  });
});
