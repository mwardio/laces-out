import { describe, expect, it } from "vitest";

import { ROS_SCORING_PROFILE_KEYS, rosScoringProfile } from "./ros-scoring-profiles.js";
import {
  projectionScoringProfileKeyForPosition,
  projectionScoringRulesFromProfileKey,
} from "./scoring-position-keys.js";
import {
  ESPN_EVERY_N_FLOOR_UNIT_COMPONENTS,
  SCORING_LONG_TOUCHDOWN_COMPONENTS,
  compileProjectionScorer,
  defensePointsAllowedDefinitionForProfile,
  espnEveryNFloorUnitValue,
  normalizeHistoricalPlayerStatComponents,
  scoringDerivedComponentValue,
  scoringWholeGroupSourceExpectation,
  projectionScoringProfileKey,
  projectionScoringProfilesAreCompatible,
  scoreProjectionStatComponents,
  validateProjectionScoringProfile,
  type ProjectionScoringProfile,
} from "./scoring.js";

describe("normalizeHistoricalPlayerStatComponents", () => {
  it("preserves exact long-TD observations without inferring them from explosive plays or game yards", () => {
    for (const { total, fortyPlus, fiftyPlus } of SCORING_LONG_TOUCHDOWN_COMPONENTS) {
      const family = total.replace("_touchdowns", "");
      const missing = normalizeHistoricalPlayerStatComponents({
        [total]: 2,
        [`${family}_yards`]: 250,
        [`${family}_40`]: 3,
      });
      expect(missing[fortyPlus]).toBeUndefined();
      expect(missing[fiftyPlus]).toBeUndefined();
      const observed = { ...missing, [fortyPlus]: 2, [fiftyPlus]: 1 };
      expect(normalizeHistoricalPlayerStatComponents(observed)).toMatchObject(observed);
      expect(
        normalizeHistoricalPlayerStatComponents({
          [total]: 0,
          [fortyPlus]: 0,
          [fiftyPlus]: 0,
        }),
      ).toMatchObject({ [total]: 0, [fortyPlus]: 0, [fiftyPlus]: 0 });
    }
  });

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
        field_goals_missed_0_19: 1,
        field_goals_missed_20_29: 2,
        field_goals_missed_30_39: 3,
        field_goals_missed_50_59: 4,
        field_goals_missed_60_plus: 5,
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
      field_goals_missed_0_39: 6,
      field_goals_missed_50_plus: 9,
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

  it("matches official ESPN negative-yardage every-N zeros without excluding the observation", () => {
    // Primary API observations and numeric provider IDs are recorded in
    // docs/scoring-transform-evidence-2026-09-17.md.
    expect(espnEveryNFloorUnitValue({ rushing_yards: -14 }, "rushing_yards_per_10_units")).toBe(0);
    expect(espnEveryNFloorUnitValue({ receiving_yards: -5 }, "receiving_yards_per_5_units")).toBe(
      0,
    );
    expect(
      espnEveryNFloorUnitValue({ punt_return_yards: -10 }, "punt_return_yards_per_10_units"),
    ).toBe(0);
    expect(espnEveryNFloorUnitValue({ rushing_yards: 99 }, "rushing_yards_per_10_units")).toBe(9);
    expect(
      scoringWholeGroupSourceExpectation(
        { rushing_yards: 0, rushing_yards_nonnegative: 5 },
        "rushing_yards",
      ),
    ).toBe(5);
    expect(
      scoringWholeGroupSourceExpectation({ rushing_yards: 0 }, "rushing_yards"),
    ).toBeUndefined();
  });

  it("preserves signed return yardage without inventing missing count or event observations", () => {
    expect(
      normalizeHistoricalPlayerStatComponents({
        punt_return_yards: -1,
        kickoff_return_yards: 0,
      }),
    ).toMatchObject({
      return_yards: -1,
    });
    const unknown = normalizeHistoricalPlayerStatComponents({});
    expect(unknown).toEqual({});
    expect(
      normalizeHistoricalPlayerStatComponents({ punt_return_yards: -1 }).return_yards,
    ).toBeUndefined();
  });

  it("preserves canonical-only observations and remains idempotent", () => {
    const canonical = {
      fumbles_lost: 1,
      turnovers: 3,
      return_yards: 35,
      passing_yards_400_plus_probability: 1,
      field_goals_made_0_39: 2,
      receiving_yards_nonnegative: 12,
      receiving_yards_per_10_units: 1,
    };
    const first = normalizeHistoricalPlayerStatComponents(canonical);
    expect(first).toMatchObject(canonical);
    expect(first.return_yards_nonnegative).toBe(35);
    expect(first).not.toHaveProperty("receiving_yards");
    expect(normalizeHistoricalPlayerStatComponents(first)).toEqual(first);
  });

  it("derives complete source aggregates without erasing a canonical aggregate from partial sources", () => {
    expect(
      normalizeHistoricalPlayerStatComponents({
        field_goals_made_0_39: 2,
        field_goals_made_20_29: 1,
        fumbles_lost: 1,
        turnovers: 3,
      }),
    ).toMatchObject({ field_goals_made_0_39: 2, fumbles_lost: 1, turnovers: 3 });
    expect(
      normalizeHistoricalPlayerStatComponents({
        field_goals_made_0_39: 9,
        field_goals_made_0_19: 0,
        field_goals_made_20_29: 1,
        field_goals_made_30_39: 1,
        fumbles_lost_total: 1,
        passing_interceptions: 2,
      }),
    ).toMatchObject({ field_goals_made_0_39: 2, fumbles_lost: 1, turnovers: 3 });
  });

  it("counts blocked extra points as misses for both providers without inventing absent attempts", () => {
    // Karty 2025 week 2: nflverse pat_missed=0, pat_blocked=1; ESPN 88 and Yahoo 30 both=1.
    const normalized = normalizeHistoricalPlayerStatComponents({
      extra_points_attempted: 4,
      extra_points_made: 3,
      extra_points_missed: 0,
    });
    expect(normalized.extra_points_missed).toBe(1);
    expect(normalizeHistoricalPlayerStatComponents(normalized)).toEqual(normalized);
    expect(
      normalizeHistoricalPlayerStatComponents({ extra_points_missed: 2 }).extra_points_missed,
    ).toBe(2);
    expect(
      normalizeHistoricalPlayerStatComponents({ extra_points_made: 3 }).extra_points_missed,
    ).toBeUndefined();
    expect(
      normalizeHistoricalPlayerStatComponents({
        extra_points_attempted: 2,
        extra_points_made: 3,
      }).extra_points_missed,
    ).toBeUndefined();
  });

  it("retains inclusive field-goal distance buckets and derives total misses without double counting blocks", () => {
    const normalized = normalizeHistoricalPlayerStatComponents({
      field_goals_attempted: 6,
      field_goals_made: 4,
      field_goals_missed: 0,
      field_goals_blocked: 2,
      field_goals_blocked_30_39: 1,
      field_goals_blocked_40_49: 1,
      field_goals_missed_0_19: 0,
      field_goals_missed_20_29: 0,
      field_goals_missed_30_39: 1,
      field_goals_missed_40_49: 1,
    });
    expect(normalized).toMatchObject({
      field_goals_missed: 2,
      field_goals_missed_0_39: 1,
      field_goals_missed_30_39: 1,
      field_goals_missed_40_49: 1,
    });
    expect(normalizeHistoricalPlayerStatComponents(normalized)).toEqual(normalized);
  });

  it("derives Yahoo positive-only and combined whole-group game totals before averaging", () => {
    const low = normalizeHistoricalPlayerStatComponents({
      rushing_yards: -10,
      punt_return_yards: 14,
      kickoff_return_yards: 14,
      field_goals_total_yards: 39,
    });
    const high = normalizeHistoricalPlayerStatComponents({
      rushing_yards: 10,
      punt_return_yards: 1,
      kickoff_return_yards: 1,
      field_goals_total_yards: 41,
    });
    expect(low.rushing_yards_nonnegative).toBe(0);
    expect(high.rushing_yards_nonnegative).toBe(10);
    expect((low.rushing_yards_nonnegative! + high.rushing_yards_nonnegative!) / 2).toBe(5);
    expect(low.return_yards_per_25_units).toBe(1);
    expect(
      (low.field_goals_total_yards_per_10_units! + high.field_goals_total_yards_per_10_units!) / 2,
    ).toBe(3.5);
    expect(Math.floor((39 + 41) / 2 / 10)).toBe(4);
    expect(scoringDerivedComponentValue({}, "rushing_yards_nonnegative")).toBeUndefined();
    expect(
      scoringDerivedComponentValue({}, "field_goals_total_yards_per_10_units"),
    ).toBeUndefined();
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

describe("compileProjectionScorer", () => {
  it("preserves canonical floating-point addition and cumulative bonus order", () => {
    const profile = {
      id: "order-sensitive",
      rules: [
        { statId: "c", points: -1e16 },
        {
          statId: "b",
          points: 1,
          bonuses: [
            { atLeast: 1, points: 1 },
            { atLeast: 0, points: 1 },
          ],
        },
        { statId: "a", points: 1e16 },
      ],
    };
    const components = { a: 1, b: 1, c: 1 };
    // Each unit addition rounds away before c cancels a. Combining/reordering them yields 2/4.
    expect(compileProjectionScorer(profile)(components)).toBe(0);
    expect(compileProjectionScorer(profile)({})).toBe(1);
  });

  it.each(ROS_SCORING_PROFILE_KEYS)("matches ordinary scoring for %s", (key) => {
    const profile = rosScoringProfile(key).profile;
    const compiled = compileProjectionScorer(profile);
    for (const scale of [0, 0.001, 0.5, 1, 20, 300, 400]) {
      const components = Object.fromEntries(
        profile.rules.map((rule, index) => [rule.statId, scale * (index + 1)]),
      );
      expect(compiled(components)).toBe(scoreProjectionStatComponents(components, profile));
    }
  });

  it("pins nested rule values without caching mutable caller profiles", () => {
    const profile = {
      id: "editable-profile",
      rules: [{ statId: "receptions", points: 1, bonuses: [{ atLeast: 5, points: 2 }] }],
    };
    const compiled = compileProjectionScorer(profile);
    profile.rules[0]!.points = 0.5;
    profile.rules[0]!.bonuses[0]!.points = 4;

    expect(compiled({ receptions: 6 })).toBe(8);
    expect(scoreProjectionStatComponents({ receptions: 6 }, profile)).toBe(7);
  });

  it("rejects invalid profiles at compilation and invalid components on every call", () => {
    expect(() => compileProjectionScorer({ id: "invalid", rules: [] })).toThrow(
      "at least one rule",
    );
    expect(() =>
      compileProjectionScorer({ id: "duplicate", rules: [fullPpr.rules[0]!, fullPpr.rules[0]!] }),
    ).toThrow("duplicate statId");
    const compiled = compileProjectionScorer(fullPpr);
    expect(compiled({ receptions: 1 })).toBe(1);
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => compiled({ receptions: value })).toThrow("must be finite");
      expect(() => compiled({ ignored_stat: value })).toThrow("must be finite");
    }
    expect(() => compiled({ " ": 1 })).toThrow("must not be empty");
    expect(Object.is(compiled({ receptions: -0 }), -0)).toBe(false);
    expect(compiled({ receptions: 2 })).toBe(2);
  });

  it("validates own enumerable components in property order, including unused stat names", () => {
    const compiled = compileProjectionScorer(fullPpr);
    const components = Object.assign(
      Object.create({ inherited_invalid: NaN }) as Record<string, number>,
      {
        receptions: 2,
      },
    );
    Object.defineProperty(components, "hidden_invalid", { value: NaN, enumerable: false });
    expect(compiled(components)).toBe(2);
    expect(
      compiled(Object.assign(Object.create(null) as Record<string, number>, { receptions: 3 })),
    ).toBe(3);
    expect(() => compiled({ unused: NaN, " ": 1 })).toThrow(
      "projection component unused must be finite",
    );
    expect(() => compiled({ " ": 1, unused: NaN })).toThrow(
      "projection component statId must not be empty",
    );
    expect(() => compiled({ unused: NaN, 2: Infinity, 1: NaN })).toThrow(
      "projection component 1 must be finite",
    );
    expect(Object.keys(components)).toEqual(["receptions"]);
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

describe("defense points-allowed definitions", () => {
  it("requires an explicit active definition and gives unspecified legacy rules no default", () => {
    const profile: ProjectionScoringProfile = {
      id: "pa",
      rules: [{ statId: "points_allowed", points: -0.1 }],
    };
    expect(defensePointsAllowedDefinitionForProfile(profile)).toBeNull();
    expect(
      defensePointsAllowedDefinitionForProfile({
        ...profile,
        rules: [{ ...profile.rules[0]!, statDefinition: "yahoo-2022-v1" }],
      }),
    ).toBe("yahoo-2022-v1");
    expect(defensePointsAllowedDefinitionForProfile(fullPpr)).toBeNull();
  });

  it("ignores zero-award rules but treats a nonzero bonus as active", () => {
    expect(
      defensePointsAllowedDefinitionForProfile({
        id: "pa",
        rules: [
          { statId: "points_allowed_0_probability", points: 10, statDefinition: "espn-2019-v1" },
          { statId: "points_allowed_1_6_probability", points: 0 },
          {
            statId: "points_allowed_7_13_probability",
            points: 0,
            statDefinition: "yahoo-2022-v1",
            bonuses: [{ atLeast: 1, points: 0 }],
          },
        ],
      }),
    ).toBe("espn-2019-v1");
    expect(
      defensePointsAllowedDefinitionForProfile({
        id: "pa-bonus",
        rules: [
          {
            statId: "points_allowed",
            points: 0,
            statDefinition: "yahoo-2022-v1",
            bonuses: [{ atLeast: 20, points: -3 }],
          },
        ],
      }),
    ).toBe("yahoo-2022-v1");
    expect(
      defensePointsAllowedDefinitionForProfile({
        id: "inactive",
        rules: [{ statId: "points_allowed", points: 0, statDefinition: "yahoo-2022-v1" }],
      }),
    ).toBeNull();
  });

  it.each([undefined, "espn-2019-v1"] as const)(
    "rejects mixed active PA definitions including legacy %s rules",
    (other) => {
      const profile: ProjectionScoringProfile = {
        id: "conflict",
        rules: [
          { statId: "points_allowed_0_probability", points: 10, statDefinition: "yahoo-2022-v1" },
          {
            statId: "points_allowed_1_6_probability",
            points: 7,
            ...(other === undefined ? {} : { statDefinition: other }),
          },
        ],
      };
      expect(() => defensePointsAllowedDefinitionForProfile(profile)).toThrow(
        "consistent statDefinition",
      );
      expect(() => projectionScoringProfileKey(profile)).toThrow("consistent statDefinition");
      expect(() => compileProjectionScorer(profile)).toThrow("consistent statDefinition");
    },
  );

  it.each([
    { statId: "receptions", points: 1, statDefinition: "yahoo-2022-v1" },
    { statId: "yards_allowed_0_99_probability", points: 1, statDefinition: "espn-2019-v1" },
    { statId: "points_allowed", points: -1, statDefinition: "unknown" },
    { statId: "points_allowed", points: -1, statDefinition: null },
  ])("rejects unsupported definition metadata on $statId", (rule) => {
    expect(() =>
      validateProjectionScoringProfile({
        id: "bad-definition",
        rules: [rule],
      } as ProjectionScoringProfile),
    ).toThrow("Unsupported statDefinition");
  });

  it("retains PA metadata without changing arithmetic on already-bound components", () => {
    for (const statDefinition of ["yahoo-2022-v1", "espn-2019-v1"] as const) {
      expect(
        scoreProjectionStatComponents(
          { points_allowed: 20 },
          { id: "scored", rules: [{ statId: "points_allowed", points: -0.5, statDefinition }] },
        ),
      ).toBe(-10);
    }
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
