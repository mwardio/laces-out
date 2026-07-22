import { describe, expect, it } from "vitest";

import {
  LEAGUE_SCORING_NORMALIZATION_VERSION,
  NFLVERSE_PROJECTION_SCORING_COMPONENTS_V1,
  normalizeLeagueScoringProfile,
  type LeagueScoringNormalizationResult,
  type StoredLeagueScoringRule,
} from "./league-scoring.js";
import { scoreProjectionStatComponents } from "./scoring.js";

function rule(
  providerStatId: string | null,
  statKey: string,
  points: number | string,
  overrides: Partial<StoredLeagueScoringRule> = {},
): StoredLeagueScoringRule {
  return {
    provider: "yahoo",
    providerStatId,
    statKey,
    operation: "multiply",
    points,
    thresholdLow: null,
    thresholdHigh: null,
    ...overrides,
  };
}

function normalized(
  rows: readonly StoredLeagueScoringRule[],
  availableStatIds?: readonly string[],
): LeagueScoringNormalizationResult {
  return normalizeLeagueScoringProfile({
    id: "league-season-1",
    label: "League scoring",
    rows,
    availableStatIds: availableStatIds ?? NFLVERSE_PROJECTION_SCORING_COMPONENTS_V1,
  });
}

function expectAvailable(
  result: LeagueScoringNormalizationResult,
): asserts result is Extract<LeagueScoringNormalizationResult, { state: "available" }> {
  expect(result.state).toBe("available");
  if (result.state !== "available") {
    throw new Error(result.reasons.map((item) => `${item.code}: ${item.message}`).join("\n"));
  }
}

function reasonCodes(result: LeagueScoringNormalizationResult): readonly string[] {
  expect(result.state).toBe("unavailable");
  return result.state === "unavailable" ? result.reasons.map((item) => item.code) : [];
}

describe("normalizeLeagueScoringProfile", () => {
  it("normalizes a common Yahoo standard profile and scores its raw components", () => {
    const result = normalized([
      rule("4", "Passing Yards", "0.04"),
      rule("5", "Passing Touchdowns", "4"),
      rule("6", "Interceptions Thrown", "-2"),
      rule("9", "Rushing Yards", "0.1"),
      rule("10", "Rushing Touchdowns", "6"),
      rule("12", "Receiving Yards", "0.1"),
      rule("13", "Receiving Touchdowns", "6"),
      rule("18", "Fumbles Lost", "-2"),
    ]);
    expectAvailable(result);
    expect(result.profile).toMatchObject({
      id: "league-season-1",
      label: "League scoring",
      version: LEAGUE_SCORING_NORMALIZATION_VERSION,
    });
    expect(result.profile.rules).toEqual(
      expect.arrayContaining([
        { statId: "passing_yards", points: 0.04 },
        { statId: "passing_touchdowns", points: 4 },
        { statId: "passing_interceptions", points: -2 },
        { statId: "fumbles_lost", points: -2 },
      ]),
    );
    expect(
      scoreProjectionStatComponents(
        {
          passing_yards: 250,
          passing_touchdowns: 2,
          passing_interceptions: 1,
          rushing_yards: 20,
        },
        result.profile,
      ),
    ).toBe(18);
  });

  it.each([
    ["standard", 0],
    ["half PPR", 0.5],
    ["full PPR", 1],
  ])("normalizes %s reception scoring without inferring a different value", (_label, points) => {
    const rows = [rule("4", "Passing Yards", 0.04)];
    if (points !== 0) rows.push(rule("11", "Receptions", points));
    const result = normalized(rows);
    expectAvailable(result);
    expect(result.profile.rules.find((item) => item.statId === "receptions")?.points ?? 0).toBe(
      points,
    );
  });

  it.each([4, 6])("preserves an ESPN %i-point passing-touchdown rule", (points) => {
    const result = normalized([
      rule("3", "3", 0.04, { provider: "espn" }),
      rule("4", "4", points, { provider: "espn" }),
    ]);
    expectAvailable(result);
    expect(result.profile.rules).toContainEqual({ statId: "passing_touchdowns", points });
  });

  it("normalizes ESPN interception and aggregate fumble-lost turnovers", () => {
    const result = normalized([
      rule("20", "20", -2, { provider: "espn" }),
      rule("72", "72", -2, { provider: "espn" }),
    ]);
    expectAvailable(result);
    expect(
      scoreProjectionStatComponents({ passing_interceptions: 2, fumbles_lost: 1 }, result.profile),
    ).toBe(-6);
  });

  it("normalizes Yahoo field-goal distance buckets and extra points", () => {
    const result = normalized([
      rule("19", "Field Goals 0-19 Yards", 3),
      rule("20", "Field Goals 20-29 Yards", 3),
      rule("21", "Field Goals 30-39 Yards", 3),
      rule("22", "Field Goals 40-49 Yards", 4),
      rule("23", "Field Goals 50+ Yards", 5),
      rule("29", "Point After Attempt Made", 1),
      rule("30", "Point After Attempt Missed", -1),
    ]);
    expectAvailable(result);
    expect(
      scoreProjectionStatComponents(
        {
          field_goals_made_0_19: 1,
          field_goals_made_20_29: 1,
          field_goals_made_30_39: 1,
          field_goals_made_40_49: 1,
          field_goals_made_50_plus: 1,
          extra_points_made: 2,
          extra_points_missed: 1,
        },
        result.profile,
      ),
    ).toBe(19);
  });

  it("maps aggregate Yahoo and split ESPN player return yardage", () => {
    const yahoo = normalized([rule("14", "Return Yards", 0.04)]);
    expectAvailable(yahoo);
    expect(yahoo.profile.rules).toContainEqual({ statId: "return_yards", points: 0.04 });

    const espn = normalized([
      rule("114", "114", 0.1, { provider: "espn" }),
      rule("115", "115", 0.1, { provider: "espn" }),
    ]);
    expectAvailable(espn);
    expect(
      scoreProjectionStatComponents(
        { kickoff_return_yards: 30, punt_return_yards: 20 },
        espn.profile,
      ),
    ).toBe(5);
  });

  it("scores explicit Yahoo D/ST events and points-allowed probabilities", () => {
    const result = normalized([
      rule("32", "Sacks Recorded", 1),
      rule("33", "Interceptions Made", 2),
      rule("34", "Fumbles Recovered", 2),
      rule("35", "Defensive Touchdowns", 6),
      rule("36", "Safeties", 2),
      rule("37", "Blocked Kicks", 2),
      rule("49", "Kickoff and Punt Return Touchdowns", 6),
      rule("50", "0 Points Allowed", 10),
      rule("51", "1-6 Points Allowed", 7),
      rule("52", "7-13 Points Allowed", 4),
    ]);
    expectAvailable(result);
    expect(result.profile.rules).toContainEqual({
      statId: "points_allowed_1_6_probability",
      points: 7,
    });
    expect(
      scoreProjectionStatComponents(
        {
          defensive_sacks: 3,
          defensive_interceptions: 1,
          defensive_fumble_recoveries: 1,
          defensive_touchdowns: 0.2,
          defensive_safeties: 0.2,
          defensive_blocked_kicks: 0.1,
          special_teams_touchdowns: 0.1,
          points_allowed_0_probability: 0.2,
          points_allowed_1_6_probability: 0.3,
          points_allowed_7_13_probability: 0.5,
        },
        result.profile,
      ),
    ).toBeCloseTo(15.5, 8);
  });

  it("maps ESPN's explicit D/ST events and its distinct points-allowed buckets", () => {
    const result = normalized([
      rule("99", "99", 1, { provider: "espn" }),
      rule("95", "95", 2, { provider: "espn" }),
      rule("96", "96", 2, { provider: "espn" }),
      rule("98", "98", 2, { provider: "espn" }),
      rule("94", "94", 6, { provider: "espn" }),
      rule("97", "97", 2, { provider: "espn" }),
      rule("101", "101", 6, { provider: "espn" }),
      rule("188", "188", 10, { provider: "espn" }),
      rule("189", "189", 7, { provider: "espn" }),
      rule("190", "190", 4, { provider: "espn" }),
      rule("191", "191", 1, { provider: "espn" }),
      rule("192", "192", 0, { provider: "espn" }),
      rule("193", "193", -1, { provider: "espn" }),
      rule("194", "194", -4, { provider: "espn" }),
    ]);
    expectAvailable(result);
    expect(result.profile.rules).toEqual(
      expect.arrayContaining([
        { statId: "defensive_sacks", points: 1 },
        { statId: "defensive_blocked_kicks", points: 2 },
        { statId: "points_allowed_14_17_probability", points: 1 },
        { statId: "points_allowed_28_34_probability", points: -4 },
      ]),
    );
    expect(result.ignoredRules).toContainEqual(
      expect.objectContaining({ rowIndex: 11, category: "zero-point" }),
    );
  });

  it("rejects at-least bonuses until the projection supplies threshold probabilities", () => {
    const result = normalized([
      rule("4", "Passing Yards", 0.04),
      rule("4", "Passing Yards", 3, {
        operation: "bonus",
        thresholdLow: 300,
      }),
      rule("4", "Passing Yards", 2, {
        operation: "at_least_bonus",
        thresholdLow: 400,
      }),
    ]);
    expect(reasonCodes(result)).toEqual(["NONLINEAR_RULE", "NONLINEAR_RULE"]);
    if (result.state === "unavailable") {
      expect(result.reasons[0]?.message).toContain("projected threshold probability");
    }
  });

  it.each([
    {
      name: "bounded bonus",
      row: rule("4", "Passing Yards", 3, {
        operation: "bonus",
        thresholdLow: 300,
        thresholdHigh: 399,
      }),
      code: "NONLINEAR_RULE",
    },
    {
      name: "thresholded multiplier",
      row: rule("4", "Passing Yards", 0.04, { thresholdLow: 300 }),
      code: "NONLINEAR_RULE",
    },
    {
      name: "division operation",
      row: rule("4", "Passing Yards", 25, { operation: "divide" }),
      code: "UNSUPPORTED_OPERATION",
    },
    {
      name: "ESPN per-N yard category",
      row: rule("5", "5", 1, { provider: "espn" }),
      code: "NONLINEAR_RULE",
    },
    {
      name: "Yahoo yards-allowed bracket",
      row: rule("70", "Less Than 100 Total Yards Allowed", 10),
      code: "NONLINEAR_RULE",
    },
  ])("rejects a $name instead of approximating it", ({ row: stored, code }) => {
    expect(reasonCodes(normalized([stored]))).toContain(code);
  });

  it("rejects unknown nonzero rules while retaining unknown zero rules as ignored", () => {
    const rejected = normalized([rule("9999", "Mystery Offensive Metric", 1)]);
    expect(reasonCodes(rejected)).toEqual(["UNKNOWN_NONZERO_RULE"]);
    if (rejected.state === "unavailable") {
      expect(rejected.reasons[0]?.message).toBe(
        "Rule 0 (9999) is a nonzero scoring rule with no exact yahoo mapping.",
      );
    }

    const accepted = normalized([
      rule("4", "Passing Yards", 0.04),
      rule("9999", "Mystery Offensive Metric", 0),
    ]);
    expectAvailable(accepted);
    expect(accepted.ignoredRules).toContainEqual(
      expect.objectContaining({ rowIndex: 1, category: "zero-point" }),
    );
    expect(accepted.warnings.map((warning) => warning.code)).toContain("IGNORED_ZERO_POINT_RULE");
  });

  it.each([
    rule("53:slot:6", "ESPN stat 53 override for TE", 1, { provider: "espn" }),
    rule(null, "Tight End Premium Receptions", 0.5, { provider: "yahoo" }),
  ])("rejects unsupported position-specific scoring overrides", (stored) => {
    expect(reasonCodes(normalized([stored]))).toContain("POSITION_OVERRIDE");
  });

  it("accepts ESPN D/ST slot overrides for a modeled defense component", () => {
    const result = normalized([
      rule("3", "3", 0.04, { provider: "espn" }),
      rule("122", "122", 0, { provider: "espn" }),
      rule("122:slot:16", "ESPN stat 122 override for D/ST", -1, { provider: "espn" }),
    ]);
    expectAvailable(result);
    expect(result.profile.rules).toContainEqual({
      statId: "points_allowed_22_27_probability",
      points: -1,
    });
  });

  it("does not treat arbitrary ESPN slot-16 overrides as global player scoring", () => {
    expect(
      reasonCodes(
        normalized([rule("3:slot:16", "Passing yards override", 0.1, { provider: "espn" })]),
      ),
    ).toContain("POSITION_OVERRIDE");
  });

  it.each([rule("38", "Solo Tackles", 1), rule("106", "106", 1, { provider: "espn" })])(
    "rejects IDP-only scoring rather than silently dropping it",
    (stored) => {
      expect(reasonCodes(normalized([stored]))).toContain("IDP_RULE");
    },
  );

  it("rejects conflicting provider IDs and display names", () => {
    const result = normalized([rule("4", "Receptions", 1)]);
    expect(reasonCodes(result)).toEqual(["CONFLICTING_RULE_IDENTITY"]);
  });

  it("rejects conflicting duplicate canonical aliases instead of double counting", () => {
    const result = normalized([rule("11", "Receptions", 1), rule(null, "Reception", 0.5)]);
    expect(reasonCodes(result)).toContain("DUPLICATE_CANONICAL_RULE");
  });

  it("coalesces identical provider aliases but rejects conflicting values", () => {
    const accepted = normalized([
      rule("15", "Return Touchdowns", 6),
      rule("49", "Special Teams Touchdowns", 6),
    ]);
    expectAvailable(accepted);
    expect(
      accepted.profile.rules.filter((item) => item.statId === "special_teams_touchdowns"),
    ).toEqual([{ statId: "special_teams_touchdowns", points: 6 }]);

    expect(
      reasonCodes(
        normalized([rule("15", "Return Touchdowns", 6), rule("49", "Special Teams Touchdowns", 4)]),
      ),
    ).toContain("DUPLICATE_CANONICAL_RULE");
  });

  it.each([
    [
      "two-point aggregate and split",
      [rule("19", "19", 2, { provider: "espn" }), rule("62", "62", 2, { provider: "espn" })],
    ],
    [
      "fumble-lost aggregate and split",
      [rule("69", "69", -2, { provider: "espn" }), rule("72", "72", -2, { provider: "espn" })],
    ],
    [
      "field-goal aggregate and bucket",
      [rule("83", "83", 3, { provider: "espn" }), rule("77", "77", 4, { provider: "espn" })],
    ],
    [
      "mean points allowed and bracket expectations",
      [
        rule("187", "187", -0.25, { provider: "espn" }),
        rule("188", "188", 10, { provider: "espn" }),
      ],
    ],
  ])("rejects overlapping $0", (_name, rows) => {
    expect(reasonCodes(normalized(rows))).toContain("OVERLAPPING_AGGREGATE_RULES");
  });

  it("requires every nonzero rule's component to be emitted by the projection run", () => {
    const result = normalized([rule("16", "2-Point Conversions", 2)], ["passing_yards"]);
    expect(reasonCodes(result)).toEqual(["COMPONENT_UNAVAILABLE"]);
    if (result.state === "unavailable") {
      expect(result.reasons[0]?.message).toContain("two_point_conversions");
    }
  });

  it("uses exact display names as a disclosed fallback for nonnumeric recovery IDs", () => {
    const result = normalized([rule("PASS_TD", "Passing Touchdown", 4, { provider: "espn" })]);
    expectAvailable(result);
    expect(result.profile.rules).toEqual([{ statId: "passing_touchdowns", points: 4 }]);
    expect(result.warnings.map((warning) => warning.code)).toContain("DISPLAY_NAME_FALLBACK");
  });

  it("reports malformed, empty, mixed-provider, and unsupported-only profiles", () => {
    expect(reasonCodes(normalized([]))).toEqual(["EMPTY_RULES"]);
    expect(
      reasonCodes(
        normalized([rule("4", "Passing Yards", 0.04), rule("3", "3", 0.04, { provider: "espn" })]),
      ),
    ).toContain("MIXED_PROVIDERS");
    expect(reasonCodes(normalized([rule("4", "Passing Yards", "not-a-number")]))).toContain(
      "INVALID_RULE",
    );
    expect(reasonCodes(normalized([rule("138", "Net Punts", 1, { provider: "espn" })]))).toEqual([
      "NO_SUPPORTED_RULES",
    ]);
  });
});
