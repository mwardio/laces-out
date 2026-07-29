import { describe, expect, it } from "vitest";

import { firstPartyTeamDefenseProjectionComponents } from "./first-party.js";
import {
  ESPN_PLAYER_SCORING_STAT_ID_MAP_V1,
  LEAGUE_SCORING_NORMALIZATION_VERSION,
  LEAGUE_SCORING_POSITIONS,
  NFLVERSE_PROJECTION_SCORING_COMPONENTS_V1,
  leagueScoringPositionComponents,
  normalizeLeagueScoringProfile,
  type LeagueScoringNormalizationResult,
  type LeagueScoringPosition,
  type LeagueScoringUnsupportedReason,
  type StoredLeagueScoringRule,
} from "./league-scoring.js";
import { rosAvailableProjectionStatIds } from "./ros-scoring-profiles.js";
import { projectionScoringProfileKeyForPosition } from "./scoring-position-keys.js";
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

/** Strips a `":slot:<id>"` suffix so an override's reason can be traced to its base provider ID. */
function baseProviderStatId(providerStatId: string | null): string {
  return (providerStatId ?? "").replace(/:slot:\d+$/u, "");
}

/**
 * The numeric base provider stat IDs (sorted ascending, duplicates preserved) behind every reason
 * of `code` — proves each failure is traceable to a specific stat ID, not just a generic bucket.
 */
function baseStatIdsOf(reasons: readonly LeagueScoringUnsupportedReason[], code: string): number[] {
  return reasons
    .filter((item) => item.code === code)
    .map((item) => Number(baseProviderStatId(item.providerStatId)))
    .sort((left, right) => left - right);
}

function supportFor(result: LeagueScoringNormalizationResult, position: LeagueScoringPosition) {
  const support = result.positions.find((item) => item.position === position);
  if (support === undefined) throw new Error(`No position support reported for ${position}`);
  return support;
}

function supportedPositions(
  result: LeagueScoringNormalizationResult,
): readonly LeagueScoringPosition[] {
  return result.positions.filter((item) => item.supported).map((item) => item.position);
}

function positionReasonCodes(
  result: LeagueScoringNormalizationResult,
  position: LeagueScoringPosition,
): readonly string[] {
  return supportFor(result, position).reasons.map((item) => item.code);
}

/**
 * Sanitized, faithful transcriptions of the three real synced ESPN leagues' `scoring_rules` rows
 * (provider stat IDs, operations, and points only — no league/team/member data). All three carry an
 * identical 27-row D/ST `:slot:16` override set; league A additionally carries 6 bare nonlinear
 * per-N-yard rules (17, 18, 37, 38, 56, 57) the other two leagues lack.
 */
const ESPN_LEAGUE_A_ROWS: readonly StoredLeagueScoringRule[] = [
  rule("101", "101", 6, { provider: "espn" }),
  rule("101:slot:16", "ESPN stat 101 override for D/ST", 6, { provider: "espn" }),
  rule("102", "102", 6, { provider: "espn" }),
  rule("102:slot:16", "ESPN stat 102 override for D/ST", 6, { provider: "espn" }),
  rule("103", "103", 6, { provider: "espn" }),
  rule("103:slot:16", "ESPN stat 103 override for D/ST", 6, { provider: "espn" }),
  rule("104", "104", 6, { provider: "espn" }),
  rule("104:slot:16", "ESPN stat 104 override for D/ST", 6, { provider: "espn" }),
  rule("123", "123", 0, { provider: "espn" }),
  rule("123:slot:16", "ESPN stat 123 override for D/ST", -1, { provider: "espn" }),
  rule("124", "124", 0, { provider: "espn" }),
  rule("124:slot:16", "ESPN stat 124 override for D/ST", -3, { provider: "espn" }),
  rule("125", "125", 0, { provider: "espn" }),
  rule("125:slot:16", "ESPN stat 125 override for D/ST", -5, { provider: "espn" }),
  rule("128", "128", 0, { provider: "espn" }),
  rule("128:slot:16", "ESPN stat 128 override for D/ST", 5, { provider: "espn" }),
  rule("129", "129", 0, { provider: "espn" }),
  rule("129:slot:16", "ESPN stat 129 override for D/ST", 3, { provider: "espn" }),
  rule("130", "130", 0, { provider: "espn" }),
  rule("130:slot:16", "ESPN stat 130 override for D/ST", 2, { provider: "espn" }),
  rule("132", "132", 0, { provider: "espn" }),
  rule("132:slot:16", "ESPN stat 132 override for D/ST", -1, { provider: "espn" }),
  rule("133", "133", 0, { provider: "espn" }),
  rule("133:slot:16", "ESPN stat 133 override for D/ST", -3, { provider: "espn" }),
  rule("134", "134", 0, { provider: "espn" }),
  rule("134:slot:16", "ESPN stat 134 override for D/ST", -5, { provider: "espn" }),
  rule("135", "135", 0, { provider: "espn" }),
  rule("135:slot:16", "ESPN stat 135 override for D/ST", -6, { provider: "espn" }),
  rule("136", "136", 0, { provider: "espn" }),
  rule("136:slot:16", "ESPN stat 136 override for D/ST", -7, { provider: "espn" }),
  rule("17", "17", 1, { provider: "espn" }),
  rule("18", "18", 3, { provider: "espn" }),
  rule("19", "19", 2, { provider: "espn" }),
  rule("198", "198", 5, { provider: "espn" }),
  rule("20", "20", -2, { provider: "espn" }),
  rule("201", "201", 6, { provider: "espn" }),
  rule("206", "206", 2, { provider: "espn" }),
  rule("206:slot:16", "ESPN stat 206 override for D/ST", 2, { provider: "espn" }),
  rule("209", "209", 1, { provider: "espn" }),
  rule("209:slot:16", "ESPN stat 209 override for D/ST", 1, { provider: "espn" }),
  rule("24", "24", 0.1, { provider: "espn" }),
  rule("25", "25", 6, { provider: "espn" }),
  rule("26", "26", 2, { provider: "espn" }),
  rule("3", "3", 0.04, { provider: "espn" }),
  rule("37", "37", 1, { provider: "espn" }),
  rule("38", "38", 3, { provider: "espn" }),
  rule("4", "4", 6, { provider: "espn" }),
  rule("42", "42", 0.1, { provider: "espn" }),
  rule("43", "43", 6, { provider: "espn" }),
  rule("44", "44", 2, { provider: "espn" }),
  rule("53", "53", 1, { provider: "espn" }),
  rule("56", "56", 1, { provider: "espn" }),
  rule("57", "57", 3, { provider: "espn" }),
  rule("63", "63", 6, { provider: "espn" }),
  rule("72", "72", -2, { provider: "espn" }),
  rule("77", "77", 4, { provider: "espn" }),
  rule("80", "80", 3, { provider: "espn" }),
  rule("85", "85", -1, { provider: "espn" }),
  rule("86", "86", 1, { provider: "espn" }),
  rule("89", "89", 0, { provider: "espn" }),
  rule("89:slot:16", "ESPN stat 89 override for D/ST", 5, { provider: "espn" }),
  rule("90", "90", 0, { provider: "espn" }),
  rule("90:slot:16", "ESPN stat 90 override for D/ST", 4, { provider: "espn" }),
  rule("91", "91", 0, { provider: "espn" }),
  rule("91:slot:16", "ESPN stat 91 override for D/ST", 3, { provider: "espn" }),
  rule("92", "92", 0, { provider: "espn" }),
  rule("92:slot:16", "ESPN stat 92 override for D/ST", 1, { provider: "espn" }),
  rule("93", "93", 6, { provider: "espn" }),
  rule("93:slot:16", "ESPN stat 93 override for D/ST", 6, { provider: "espn" }),
  rule("95", "95", 0, { provider: "espn" }),
  rule("95:slot:16", "ESPN stat 95 override for D/ST", 2, { provider: "espn" }),
  rule("96", "96", 0, { provider: "espn" }),
  rule("96:slot:16", "ESPN stat 96 override for D/ST", 2, { provider: "espn" }),
  rule("97", "97", 0, { provider: "espn" }),
  rule("97:slot:16", "ESPN stat 97 override for D/ST", 2, { provider: "espn" }),
  rule("98", "98", 0, { provider: "espn" }),
  rule("98:slot:16", "ESPN stat 98 override for D/ST", 2, { provider: "espn" }),
  rule("99", "99", 0, { provider: "espn" }),
  rule("99:slot:16", "ESPN stat 99 override for D/ST", 1, { provider: "espn" }),
];

const ESPN_LEAGUE_B_ROWS: readonly StoredLeagueScoringRule[] = [
  rule("101", "101", 6, { provider: "espn" }),
  rule("101:slot:16", "ESPN stat 101 override for D/ST", 6, { provider: "espn" }),
  rule("102", "102", 6, { provider: "espn" }),
  rule("102:slot:16", "ESPN stat 102 override for D/ST", 6, { provider: "espn" }),
  rule("103", "103", 6, { provider: "espn" }),
  rule("103:slot:16", "ESPN stat 103 override for D/ST", 6, { provider: "espn" }),
  rule("104", "104", 6, { provider: "espn" }),
  rule("104:slot:16", "ESPN stat 104 override for D/ST", 6, { provider: "espn" }),
  rule("123", "123", 0, { provider: "espn" }),
  rule("123:slot:16", "ESPN stat 123 override for D/ST", -1, { provider: "espn" }),
  rule("124", "124", 0, { provider: "espn" }),
  rule("124:slot:16", "ESPN stat 124 override for D/ST", -3, { provider: "espn" }),
  rule("125", "125", 0, { provider: "espn" }),
  rule("125:slot:16", "ESPN stat 125 override for D/ST", -5, { provider: "espn" }),
  rule("128", "128", 0, { provider: "espn" }),
  rule("128:slot:16", "ESPN stat 128 override for D/ST", 5, { provider: "espn" }),
  rule("129", "129", 0, { provider: "espn" }),
  rule("129:slot:16", "ESPN stat 129 override for D/ST", 3, { provider: "espn" }),
  rule("130", "130", 0, { provider: "espn" }),
  rule("130:slot:16", "ESPN stat 130 override for D/ST", 2, { provider: "espn" }),
  rule("132", "132", 0, { provider: "espn" }),
  rule("132:slot:16", "ESPN stat 132 override for D/ST", -1, { provider: "espn" }),
  rule("133", "133", 0, { provider: "espn" }),
  rule("133:slot:16", "ESPN stat 133 override for D/ST", -3, { provider: "espn" }),
  rule("134", "134", 0, { provider: "espn" }),
  rule("134:slot:16", "ESPN stat 134 override for D/ST", -5, { provider: "espn" }),
  rule("135", "135", 0, { provider: "espn" }),
  rule("135:slot:16", "ESPN stat 135 override for D/ST", -6, { provider: "espn" }),
  rule("136", "136", 0, { provider: "espn" }),
  rule("136:slot:16", "ESPN stat 136 override for D/ST", -7, { provider: "espn" }),
  rule("19", "19", 2, { provider: "espn" }),
  rule("198", "198", 5, { provider: "espn" }),
  rule("20", "20", -2, { provider: "espn" }),
  rule("201", "201", 5, { provider: "espn" }),
  rule("206", "206", 2, { provider: "espn" }),
  rule("206:slot:16", "ESPN stat 206 override for D/ST", 2, { provider: "espn" }),
  rule("209", "209", 1, { provider: "espn" }),
  rule("209:slot:16", "ESPN stat 209 override for D/ST", 1, { provider: "espn" }),
  rule("24", "24", 0.1, { provider: "espn" }),
  rule("25", "25", 6, { provider: "espn" }),
  rule("26", "26", 2, { provider: "espn" }),
  rule("3", "3", 0.04, { provider: "espn" }),
  rule("4", "4", 4, { provider: "espn" }),
  rule("42", "42", 0.1, { provider: "espn" }),
  rule("43", "43", 6, { provider: "espn" }),
  rule("44", "44", 2, { provider: "espn" }),
  rule("63", "63", 6, { provider: "espn" }),
  rule("72", "72", -2, { provider: "espn" }),
  rule("77", "77", 4, { provider: "espn" }),
  rule("80", "80", 3, { provider: "espn" }),
  rule("85", "85", -1, { provider: "espn" }),
  rule("86", "86", 1, { provider: "espn" }),
  rule("88", "88", -1, { provider: "espn" }),
  rule("89", "89", 0, { provider: "espn" }),
  rule("89:slot:16", "ESPN stat 89 override for D/ST", 5, { provider: "espn" }),
  rule("90", "90", 0, { provider: "espn" }),
  rule("90:slot:16", "ESPN stat 90 override for D/ST", 4, { provider: "espn" }),
  rule("91", "91", 0, { provider: "espn" }),
  rule("91:slot:16", "ESPN stat 91 override for D/ST", 3, { provider: "espn" }),
  rule("92", "92", 0, { provider: "espn" }),
  rule("92:slot:16", "ESPN stat 92 override for D/ST", 1, { provider: "espn" }),
  rule("93", "93", 6, { provider: "espn" }),
  rule("93:slot:16", "ESPN stat 93 override for D/ST", 6, { provider: "espn" }),
  rule("95", "95", 0, { provider: "espn" }),
  rule("95:slot:16", "ESPN stat 95 override for D/ST", 2, { provider: "espn" }),
  rule("96", "96", 0, { provider: "espn" }),
  rule("96:slot:16", "ESPN stat 96 override for D/ST", 2, { provider: "espn" }),
  rule("97", "97", 0, { provider: "espn" }),
  rule("97:slot:16", "ESPN stat 97 override for D/ST", 2, { provider: "espn" }),
  rule("98", "98", 0, { provider: "espn" }),
  rule("98:slot:16", "ESPN stat 98 override for D/ST", 2, { provider: "espn" }),
  rule("99", "99", 0, { provider: "espn" }),
  rule("99:slot:16", "ESPN stat 99 override for D/ST", 1, { provider: "espn" }),
];

const ESPN_LEAGUE_C_ROWS: readonly StoredLeagueScoringRule[] = [
  rule("101", "101", 6, { provider: "espn" }),
  rule("101:slot:16", "ESPN stat 101 override for D/ST", 6, { provider: "espn" }),
  rule("102", "102", 6, { provider: "espn" }),
  rule("102:slot:16", "ESPN stat 102 override for D/ST", 6, { provider: "espn" }),
  rule("103", "103", 6, { provider: "espn" }),
  rule("103:slot:16", "ESPN stat 103 override for D/ST", 6, { provider: "espn" }),
  rule("104", "104", 6, { provider: "espn" }),
  rule("104:slot:16", "ESPN stat 104 override for D/ST", 6, { provider: "espn" }),
  rule("123", "123", 0, { provider: "espn" }),
  rule("123:slot:16", "ESPN stat 123 override for D/ST", -1, { provider: "espn" }),
  rule("124", "124", 0, { provider: "espn" }),
  rule("124:slot:16", "ESPN stat 124 override for D/ST", -3, { provider: "espn" }),
  rule("125", "125", 0, { provider: "espn" }),
  rule("125:slot:16", "ESPN stat 125 override for D/ST", -5, { provider: "espn" }),
  rule("128", "128", 0, { provider: "espn" }),
  rule("128:slot:16", "ESPN stat 128 override for D/ST", 5, { provider: "espn" }),
  rule("129", "129", 0, { provider: "espn" }),
  rule("129:slot:16", "ESPN stat 129 override for D/ST", 3, { provider: "espn" }),
  rule("130", "130", 0, { provider: "espn" }),
  rule("130:slot:16", "ESPN stat 130 override for D/ST", 2, { provider: "espn" }),
  rule("132", "132", 0, { provider: "espn" }),
  rule("132:slot:16", "ESPN stat 132 override for D/ST", -1, { provider: "espn" }),
  rule("133", "133", 0, { provider: "espn" }),
  rule("133:slot:16", "ESPN stat 133 override for D/ST", -3, { provider: "espn" }),
  rule("134", "134", 0, { provider: "espn" }),
  rule("134:slot:16", "ESPN stat 134 override for D/ST", -5, { provider: "espn" }),
  rule("135", "135", 0, { provider: "espn" }),
  rule("135:slot:16", "ESPN stat 135 override for D/ST", -6, { provider: "espn" }),
  rule("136", "136", 0, { provider: "espn" }),
  rule("136:slot:16", "ESPN stat 136 override for D/ST", -7, { provider: "espn" }),
  rule("19", "19", 2, { provider: "espn" }),
  rule("198", "198", 5, { provider: "espn" }),
  rule("20", "20", -2, { provider: "espn" }),
  rule("201", "201", 5, { provider: "espn" }),
  rule("206", "206", 2, { provider: "espn" }),
  rule("206:slot:16", "ESPN stat 206 override for D/ST", 2, { provider: "espn" }),
  rule("209", "209", 1, { provider: "espn" }),
  rule("209:slot:16", "ESPN stat 209 override for D/ST", 1, { provider: "espn" }),
  rule("24", "24", 0.1, { provider: "espn" }),
  rule("25", "25", 6, { provider: "espn" }),
  rule("26", "26", 2, { provider: "espn" }),
  rule("3", "3", 0.04, { provider: "espn" }),
  rule("4", "4", 4, { provider: "espn" }),
  rule("42", "42", 0.1, { provider: "espn" }),
  rule("43", "43", 6, { provider: "espn" }),
  rule("44", "44", 2, { provider: "espn" }),
  rule("63", "63", 6, { provider: "espn" }),
  rule("72", "72", -2, { provider: "espn" }),
  rule("77", "77", 4, { provider: "espn" }),
  rule("80", "80", 3, { provider: "espn" }),
  rule("85", "85", -1, { provider: "espn" }),
  rule("86", "86", 1, { provider: "espn" }),
  rule("89", "89", 0, { provider: "espn" }),
  rule("89:slot:16", "ESPN stat 89 override for D/ST", 5, { provider: "espn" }),
  rule("90", "90", 0, { provider: "espn" }),
  rule("90:slot:16", "ESPN stat 90 override for D/ST", 4, { provider: "espn" }),
  rule("91", "91", 0, { provider: "espn" }),
  rule("91:slot:16", "ESPN stat 91 override for D/ST", 3, { provider: "espn" }),
  rule("92", "92", 0, { provider: "espn" }),
  rule("92:slot:16", "ESPN stat 92 override for D/ST", 1, { provider: "espn" }),
  rule("93", "93", 6, { provider: "espn" }),
  rule("93:slot:16", "ESPN stat 93 override for D/ST", 6, { provider: "espn" }),
  rule("95", "95", 0, { provider: "espn" }),
  rule("95:slot:16", "ESPN stat 95 override for D/ST", 2, { provider: "espn" }),
  rule("96", "96", 0, { provider: "espn" }),
  rule("96:slot:16", "ESPN stat 96 override for D/ST", 2, { provider: "espn" }),
  rule("97", "97", 0, { provider: "espn" }),
  rule("97:slot:16", "ESPN stat 97 override for D/ST", 2, { provider: "espn" }),
  rule("98", "98", 0, { provider: "espn" }),
  rule("98:slot:16", "ESPN stat 98 override for D/ST", 2, { provider: "espn" }),
  rule("99", "99", 0, { provider: "espn" }),
  rule("99:slot:16", "ESPN stat 99 override for D/ST", 1, { provider: "espn" }),
];

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
    [
      "mean yards allowed and bracket expectations",
      [
        rule("127", "127", -0.02, { provider: "espn" }),
        rule("128", "128", 5, { provider: "espn" }),
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

  describe("WP1: evidence-true D/ST override diagnostics", () => {
    it.each([
      {
        name: "a nonlinear base stat with no per-unit component",
        row: rule("137:slot:16", "ESPN stat 137 override for D/ST", 5, { provider: "espn" }),
        code: "NONLINEAR_RULE",
        messageIncludes: "137",
      },
      {
        // 206/209 left this table when the de minimis zero criterion mapped them; their
        // offense/defense-specific variants did not, and no league in scope carries one.
        name: "an unpriceable defense-specific two-point-return base stat",
        row: rule("205:slot:16", "ESPN stat 205 override for D/ST", 2, { provider: "espn" }),
        code: "UNSUPPORTED_PLAYER_RULE",
        messageIncludes:
          'an ESPN "Defensive 2pt Return" rule (stat 205); no ingested source carries defensive two-point returns',
      },
      {
        name: "an unpriceable defense-specific one-point-safety base stat",
        row: rule("208:slot:16", "ESPN stat 208 override for D/ST", 1, { provider: "espn" }),
        code: "UNSUPPORTED_PLAYER_RULE",
        messageIncludes:
          'an ESPN "Defensive 1pt Safety" rule (stat 208); no ingested source carries one-point safeties',
      },
      {
        name: "an IDP base stat",
        row: rule("106:slot:16", "ESPN stat 106 override for D/ST", 1, { provider: "espn" }),
        code: "IDP_RULE",
        messageIncludes: "individual defensive players",
      },
      {
        name: "a genuinely unmapped base stat",
        row: rule("9999:slot:16", "ESPN stat 9999 override for D/ST", 1, { provider: "espn" }),
        code: "POSITION_OVERRIDE",
        messageIncludes: "position-specific override",
      },
    ])(
      "classifies a rejected ESPN slot-16 override of $name on the base ID's own merits",
      ({ row: stored, code, messageIncludes }) => {
        const result = normalized([stored]);
        expect(reasonCodes(result)).toEqual([code]);
        if (result.state === "unavailable") {
          expect(result.reasons[0]?.message).toContain(messageIncludes);
          expect(result.reasons[0]?.providerStatId).toBe(stored.providerStatId);
        }
      },
    );

    it("does not reclassify a non-16 slot override even when its base stat is nonlinear", () => {
      const result = normalized([
        rule("137:slot:6", "ESPN stat 137 override for TE", 5, { provider: "espn" }),
      ]);
      expect(reasonCodes(result)).toEqual(["POSITION_OVERRIDE"]);
    });

    it("accepts an ESPN D/ST slot-16 override of a yards-allowed bracket as its mapped tier probability", () => {
      const result = normalized([
        rule("3", "3", 0.04, { provider: "espn" }),
        rule("128", "128", 0, { provider: "espn" }),
        rule("128:slot:16", "ESPN stat 128 override for D/ST", 5, { provider: "espn" }),
      ]);
      expectAvailable(result);
      expect(result.profile.rules).toContainEqual({
        statId: "yards_allowed_0_99_probability",
        points: 5,
      });
    });

    it("does not reclassify a non-espn provider's slot-16-shaped override", () => {
      const result = normalized([
        rule("128:slot:16", "128 override for D/ST", 5, { provider: "yahoo" }),
      ]);
      expect(reasonCodes(result)).toEqual(["POSITION_OVERRIDE"]);
    });

    it("still accepts an ESPN D/ST slot-16 override of a modeled defense component", () => {
      const result = normalized([
        rule("3", "3", 0.04, { provider: "espn" }),
        rule("99", "99", 0, { provider: "espn" }),
        rule("99:slot:16", "ESPN stat 99 override for D/ST", 1, { provider: "espn" }),
      ]);
      expectAvailable(result);
      expect(result.profile.rules).toContainEqual({ statId: "defensive_sacks", points: 1 });
    });

    it("still rejects a non-16 slot override as POSITION_OVERRIDE", () => {
      expect(
        reasonCodes(
          normalized([rule("53:slot:6", "ESPN stat 53 override for TE", 1, { provider: "espn" })]),
        ),
      ).toEqual(["POSITION_OVERRIDE"]);
    });

    it("normalizes the sanitized real-league rule set espn-league-a to available with K and D/ST supported", () => {
      // Pre-WP3 this whole league was `unavailable` (17/18/37/38/56/57 fell all six positions
      // pessimistically). WP3 narrows those six bare per-N-yard bonuses to only the positions their
      // base component belongs to, which withholds QB/RB/WR/TE and leaves K. WP2 mapped the
      // yards-allowed ladder (128-136), and the de minimis zero criterion then mapped this league's
      // last two D/ST blockers (206/209), so D/ST joins K with ZERO remaining reasons. This
      // assertion is the inverse of the one it replaces, and that inversion is the point of the work.
      const result = normalizeLeagueScoringProfile({
        id: "espn-league-a",
        rows: ESPN_LEAGUE_A_ROWS,
        availableStatIds: rosAvailableProjectionStatIds(),
      });
      expectAvailable(result);
      expect(supportedPositions(result)).toEqual(["K", "DST"]);

      const dst = supportFor(result, "DST");
      expect(dst.supported).toBe(true);
      expect(dst.reasons).toEqual([]);
      // The two de minimis rules are priced, not withheld: they reach the emitted profile as real
      // components at the league's own point values.
      expect(result.profile.rules).toContainEqual({
        statId: "defensive_two_point_returns",
        points: 2,
      });
      expect(result.profile.rules).toContainEqual({ statId: "one_point_safeties", points: 1 });
    });
  });

  /**
   * WP2 — position-scoped support. The three-league fixtures are the load-bearing evidence: leagues
   * B and C failed only on D/ST-scoped rules, so five positions became legitimately supported at
   * WP2 (these cases asserted whole-league `unavailable` before it). With the de minimis zero
   * criterion mapping 206/209, the last two D/ST blockers are gone and B and C become the first
   * fully-supported leagues in the repo — all six positions. League A's six bare ESPN per-N-yard
   * bonuses still withhold QB/RB/WR/TE, so it lands on K + D/ST.
   */
  describe("WP2: position-scoped support", () => {
    it.each([
      { name: "espn-league-b", rows: ESPN_LEAGUE_B_ROWS },
      { name: "espn-league-c", rows: ESPN_LEAGUE_C_ROWS },
    ])("supports all six positions for $name with no remaining D/ST reason", ({ name, rows }) => {
      const result = normalizeLeagueScoringProfile({
        id: name,
        rows,
        availableStatIds: rosAvailableProjectionStatIds(),
      });
      expectAvailable(result);
      expect(supportedPositions(result)).toEqual(["QB", "RB", "WR", "TE", "K", "DST"]);

      const defense = supportFor(result, "DST");
      expect(defense.supported).toBe(true);
      expect(defense.reasons).toEqual([]);

      // D/ST is supported, so its own rules now reach the emitted profile — the exact inversion of
      // the pre-flip assertion, which required them to be absent.
      const statIds = result.profile.rules.map((item) => item.statId);
      expect(statIds.filter((statId) => statId.startsWith("points_allowed")).sort()).toEqual([
        "points_allowed_0_probability",
        "points_allowed_14_17_probability",
        "points_allowed_1_6_probability",
        "points_allowed_28_34_probability",
        "points_allowed_35_45_probability",
        "points_allowed_46_plus_probability",
        "points_allowed_7_13_probability",
      ]);
      expect(statIds.filter((statId) => statId.startsWith("yards_allowed")).sort()).toEqual([
        "yards_allowed_0_99_probability",
        "yards_allowed_100_199_probability",
        "yards_allowed_200_299_probability",
        "yards_allowed_350_399_probability",
        "yards_allowed_400_449_probability",
        "yards_allowed_450_499_probability",
        "yards_allowed_500_549_probability",
        "yards_allowed_550_plus_probability",
      ]);
      expect(statIds).toContain("defensive_sacks");
      expect(statIds).toContain("defensive_touchdowns");
      expect(statIds).toEqual(
        expect.arrayContaining([
          "defensive_two_point_returns",
          "one_point_safeties",
          "special_teams_touchdowns",
          "passing_yards",
          "passing_touchdowns",
          "rushing_yards",
          "receiving_yards",
          "fumble_recovery_touchdowns",
          "field_goals_made_50_59",
          "extra_points_made",
        ]),
      );

      // With every position supported, nothing is excluded for scoring only unsupported positions.
      expect(
        result.ignoredRules.filter((item) => item.category === "unsupported-position"),
      ).toEqual([]);
      expect(result.warnings.map((warning) => warning.code)).not.toContain(
        "UNSUPPORTED_POSITION_RULES_EXCLUDED",
      );
    });

    it("scores an offense line identically whether or not D/ST rules are in the profile", () => {
      const result = normalizeLeagueScoringProfile({
        id: "espn-league-b",
        rows: ESPN_LEAGUE_B_ROWS,
        availableStatIds: rosAvailableProjectionStatIds(),
      });
      expectAvailable(result);
      const quarterback = {
        passing_yards: 275,
        passing_touchdowns: 2,
        passing_interceptions: 1,
        rushing_yards: 18,
        fumbles_lost: 1,
      };
      // The league now prices D/ST, so the direction of this check inverts: strip every rule only
      // D/ST can score and the offense line must come out at the same number.
      const defenseOnly = new Set(
        [...leagueScoringPositionComponents("DST")].filter(
          (component) => !leagueScoringPositionComponents("QB").has(component),
        ),
      );
      const withoutDefense = {
        ...result.profile,
        rules: result.profile.rules.filter((item) => !defenseOnly.has(item.statId)),
      };
      expect(result.profile.rules.length).toBeGreaterThan(withoutDefense.rules.length);
      expect(scoreProjectionStatComponents(quarterback, withoutDefense)).toBeCloseTo(16.8, 8);
      expect(scoreProjectionStatComponents(quarterback, result.profile)).toBe(
        scoreProjectionStatComponents(quarterback, withoutDefense),
      );
    });

    it("fails every position when an unknown nonzero rule cannot be attributed", () => {
      const result = normalized([
        rule("4", "Passing Yards", 0.04),
        rule("9999", "Mystery Offensive Metric", 1),
      ]);
      expect(reasonCodes(result)).toEqual(["UNKNOWN_NONZERO_RULE"]);
      expect(supportedPositions(result)).toEqual([]);
      for (const position of LEAGUE_SCORING_POSITIONS) {
        expect(positionReasonCodes(result, position)).toEqual(["UNKNOWN_NONZERO_RULE"]);
      }
    });

    it("withholds a position the league defines no scoring for", () => {
      const result = normalized([
        rule("4", "Passing Yards", 0.04),
        rule("9", "Rushing Yards", 0.1),
        rule("11", "Receptions", 1),
      ]);
      expectAvailable(result);
      expect(supportedPositions(result)).toEqual(["QB", "RB", "WR", "TE"]);
      expect(positionReasonCodes(result, "K")).toEqual(["NO_SUPPORTED_RULES"]);
      expect(supportFor(result, "K").reasons[0]?.message).toContain("K");
      expect(positionReasonCodes(result, "DST")).toEqual(["NO_SUPPORTED_RULES"]);
      expect(supportFor(result, "QB").reasons).toEqual([]);
    });

    it.each([
      {
        name: "a Yahoo yards-allowed bracket",
        rows: [
          rule("4", "Passing Yards", 0.04),
          rule("11", "Receptions", 1),
          rule("70", "Less Than 100 Total Yards Allowed", 10),
        ],
        code: "NONLINEAR_RULE",
      },
      {
        // 205, not 206: the generic 206 is now a mapped de minimis component, while the
        // defense-specific variant stays unsupported with its own reason.
        name: "an ESPN unsupported team-defense stat",
        rows: [
          rule("3", "3", 0.04, { provider: "espn" }),
          rule("53", "53", 1, { provider: "espn" }),
          rule("205", "205", 2, { provider: "espn" }),
        ],
        code: "UNSUPPORTED_PLAYER_RULE",
      },
    ])("scopes $name to D/ST alone", ({ rows, code }) => {
      const result = normalized(rows);
      expectAvailable(result);
      expect(supportedPositions(result)).toEqual(["QB", "RB", "WR", "TE"]);
      expect(positionReasonCodes(result, "DST")).toEqual([code]);
      expect(positionReasonCodes(result, "K")).toEqual(["NO_SUPPORTED_RULES"]);
    });

    it("excludes rules only an unsupported position can score and records them as ignored", () => {
      const result = normalized([
        rule("4", "Passing Yards", 0.04),
        rule("32", "Sacks Recorded", 1),
        rule("49", "Kickoff and Punt Return Touchdowns", 6),
        rule("70", "Less Than 100 Total Yards Allowed", 10),
      ]);
      expectAvailable(result);
      expect(supportFor(result, "DST").supported).toBe(false);
      expect(result.profile.rules.map((item) => item.statId)).toEqual([
        "passing_yards",
        "special_teams_touchdowns",
      ]);
      expect(result.ignoredRules).toContainEqual(
        expect.objectContaining({ rowIndex: 1, category: "unsupported-position" }),
      );
      expect(result.warnings.map((warning) => warning.code)).toContain(
        "UNSUPPORTED_POSITION_RULES_EXCLUDED",
      );
    });

    /**
     * A component no modeled position projects (ESPN 79/82 -> `field_goals_missed_40_49`/`_0_39`)
     * cannot be attributed, so it fails all six positions. Neither of the two lenient alternatives
     * is acceptable: retaining it while K's own rules are excluded would price a kicker at its
     * penalties alone, and dropping it silently would publish numbers that ignore a rule the league
     * really scores.
     */
    it("fails every position on a rule no modeled position can price", () => {
      const result = normalized(
        [
          rule("3", "3", 0.04, { provider: "espn" }),
          rule("77", "77", 4, { provider: "espn" }),
          rule("80", "80", 3, { provider: "espn" }),
          rule("79", "79", -1, { provider: "espn" }),
          rule("82", "82", -1, { provider: "espn" }),
          rule("74", "74", 5, { provider: "espn", thresholdLow: 50 }),
        ],
        [...rosAvailableProjectionStatIds(), "field_goals_missed_40_49", "field_goals_missed_0_39"],
      );
      expect(reasonCodes(result)).toEqual([
        "NONLINEAR_RULE",
        "UNATTRIBUTABLE_COMPONENT",
        "UNATTRIBUTABLE_COMPONENT",
      ]);
      expect(supportedPositions(result)).toEqual([]);
      for (const position of LEAGUE_SCORING_POSITIONS) {
        expect(positionReasonCodes(result, position)).toContain("UNATTRIBUTABLE_COMPONENT");
      }
      if (result.state === "unavailable") {
        const unattributable = result.reasons.filter(
          (item) => item.code === "UNATTRIBUTABLE_COMPONENT",
        );
        expect(unattributable.map((item) => item.providerStatId)).toEqual(["82", "79"]);
        expect(unattributable[0]?.message).toContain("field_goals_missed_0_39");
        expect(unattributable[0]?.message).toContain("no modeled position");
      }
      expect(
        result.ignoredRules.filter((item) => item.category === "unsupported-position"),
      ).toEqual([]);
    });

    /**
     * The schedule-edge shape: that surface's available set carries components no first-party
     * position vocabulary owns (first downs, split fumbles, `turnovers`, `sacks_suffered`). Such a
     * league normalized as `available` and was scored before position scoping; it is withheld now,
     * with the offending component named.
     */
    it("withholds a league whose rule maps to a component outside every position vocabulary", () => {
      const result = normalizeLeagueScoringProfile({
        id: "league-season-1",
        rows: [
          rule("3", "3", 0.04, { provider: "espn" }),
          rule("211", "211", 1, { provider: "espn" }),
        ],
        availableStatIds: ["passing_yards", "passing_first_downs"],
      });
      expect(reasonCodes(result)).toEqual(["UNATTRIBUTABLE_COMPONENT"]);
      expect(supportedPositions(result)).toEqual([]);
      if (result.state === "unavailable") {
        expect(result.reasons[0]?.message).toContain("passing_first_downs");
        expect(result.reasons[0]?.providerStatId).toBe("211");
        expect(result.reasons[0]?.rowIndex).toBe(1);
      }
      for (const position of LEAGUE_SCORING_POSITIONS) {
        expect(positionReasonCodes(result, position)).toEqual(["UNATTRIBUTABLE_COMPONENT"]);
      }
    });

    it("never returns an unavailable result without a stated reason", () => {
      const componentIds = Object.keys(ESPN_PLAYER_SCORING_STAT_ID_MAP_V1);
      const probes: readonly (readonly StoredLeagueScoringRule[])[] = [
        // every ESPN transport ID on its own, mapped or not
        ...Array.from({ length: 260 }, (_unused, id) => [
          rule(String(id), String(id), 1, { provider: "espn" }),
        ]),
        // every mapped component paired with an orphan component and with an unknown rule
        ...componentIds.flatMap((id) => [
          [rule(id, id, 1, { provider: "espn" }), rule("211", "211", 1, { provider: "espn" })],
          [rule(id, id, 1, { provider: "espn" }), rule("9999", "9999", 1, { provider: "espn" })],
        ]),
      ];
      for (const rows of probes) {
        const result = normalized(rows);
        const identity = rows.map((row) => row.providerStatId).join("+");
        if (result.state === "unavailable") {
          expect(`${identity}: ${result.reasons.length}`).not.toBe(`${identity}: 0`);
          expect(supportedPositions(result)).toEqual([]);
        } else {
          expect(`${identity}: ${supportedPositions(result).length}`).not.toBe(`${identity}: 0`);
          expect(result.profile.rules.length).toBeGreaterThan(0);
        }
        for (const item of result.positions) {
          expect(item.supported).toBe(item.reasons.length === 0);
        }
      }
    });

    it("reports all six positions in a fixed order on both branches", () => {
      const available = normalized([rule("4", "Passing Yards", 0.04)]);
      const unavailable = normalized([]);
      for (const result of [available, unavailable]) {
        expect(result.positions.map((item) => item.position)).toEqual([
          ...LEAGUE_SCORING_POSITIONS,
        ]);
      }
      expect(supportedPositions(unavailable)).toEqual([]);
      expect(positionReasonCodes(unavailable, "TE")).toEqual(["EMPTY_RULES"]);
    });
  });

  /**
   * WP3 — evidence-recorded ESPN nonlinear stat ID attribution. `ESPN_NONLINEAR_STAT_ID_BASE_COMPONENTS`
   * narrows a `NONLINEAR_RULE` failure to the positions whose vocabulary owns the ID's base
   * component (vocabulary intersection GOVERNS — never a hardcoded position list), instead of the
   * pessimistic ALL-positions default every other nonlinear ID still gets.
   */
  describe("WP3: evidence-recorded nonlinear stat ID attribution", () => {
    it("normalizes espn-league-a to available with K and D/ST supported, narrowing each yardage bonus to the positions whose vocabulary owns its base component", () => {
      const result = normalizeLeagueScoringProfile({
        id: "espn-league-a",
        rows: ESPN_LEAGUE_A_ROWS,
        availableStatIds: rosAvailableProjectionStatIds(),
      });
      expectAvailable(result);
      expect(supportedPositions(result)).toEqual(["K", "DST"]);

      // QB: passing bonuses (17/18) AND rushing bonuses (37/38) — QB's vocabulary owns both.
      expect(baseStatIdsOf(supportFor(result, "QB").reasons, "NONLINEAR_RULE")).toEqual([
        17, 18, 37, 38,
      ]);
      // RB/WR/TE: rushing (37/38) and receiving (56/57) bonuses only — their vocabulary has no
      // passing_yards, so the QB-only passing bonuses (17/18) never attribute here even though
      // they are among espn-league-a's bare nonlinear rules.
      for (const position of ["RB", "WR", "TE"] as const) {
        const nonlinearIds = baseStatIdsOf(supportFor(result, position).reasons, "NONLINEAR_RULE");
        expect(nonlinearIds).toEqual([37, 38, 56, 57]);
        expect(nonlinearIds).not.toContain(17);
        expect(nonlinearIds).not.toContain(18);
      }
      // K: none of the six bare bonuses attribute to K (its vocabulary has no yardage components).
      expect(supportFor(result, "K").reasons).toEqual([]);
      // D/ST: unaffected by this table's QB/RB/WR/TE entries; with the 128-136 ladder mapped by
      // WP2 and 206/209 mapped by the de minimis zero criterion, it has no reason left at all.
      expect(supportFor(result, "DST").reasons).toEqual([]);

      // Reason messages state the mechanism and stay traceable to the provider stat ID.
      const qbReasons = supportFor(result, "QB").reasons;
      expect(qbReasons.find((item) => item.providerStatId === "17")?.message).toContain(
        "per-game yardage bonus on passing_yards",
      );
      expect(qbReasons.find((item) => item.providerStatId === "17")?.message).toContain(
        "cannot be reconstructed from a projected weekly total",
      );
      expect(qbReasons.find((item) => item.providerStatId === "37")?.message).toContain(
        "per-game yardage bonus on rushing_yards",
      );
      // Every D/ST row is an accepted rule now — the 128:slot:16 bracket override (mapped + in the
      // defense scoring set since WP2) and the 206/209 pair (mapped by the de minimis zero
      // criterion) alike — so D/ST carries no reason row at all.
      const dstReasons = supportFor(result, "DST").reasons;
      for (const providerStatId of ["128:slot:16", "206", "206:slot:16", "209", "209:slot:16"]) {
        expect(
          dstReasons.some((item) => item.providerStatId === providerStatId),
          providerStatId,
        ).toBe(false);
      }

      // Only rules a SUPPORTED position can score survive into the profile: K's kicking rules and
      // D/ST's own, while passing/rushing/receiving-yardage rules (owned solely by the withheld
      // QB/RB/WR/TE) still do not leak in.
      expect([...result.profile.rules.map((item) => item.statId)].sort()).toEqual(
        [
          "defensive_blocked_kicks",
          "defensive_fumble_recoveries",
          "defensive_interceptions",
          "defensive_sacks",
          "defensive_safeties",
          "defensive_touchdowns",
          "defensive_two_point_returns",
          "extra_points_made",
          "field_goals_made_0_39",
          "field_goals_made_40_49",
          "field_goals_made_50_59",
          "field_goals_made_60_plus",
          "field_goals_missed",
          "one_point_safeties",
          "points_allowed_0_probability",
          "points_allowed_14_17_probability",
          "points_allowed_1_6_probability",
          "points_allowed_28_34_probability",
          "points_allowed_35_45_probability",
          "points_allowed_46_plus_probability",
          "points_allowed_7_13_probability",
          "special_teams_touchdowns",
          "yards_allowed_0_99_probability",
          "yards_allowed_100_199_probability",
          "yards_allowed_200_299_probability",
          "yards_allowed_350_399_probability",
          "yards_allowed_400_449_probability",
          "yards_allowed_450_499_probability",
          "yards_allowed_500_549_probability",
          "yards_allowed_550_plus_probability",
        ].sort(),
      );
      expect(result.profile.rules).not.toContainEqual(
        expect.objectContaining({ statId: "passing_yards" }),
      );
    });

    it("keeps an ESPN nonlinear ID with no recorded base component pessimistically attributed to all six positions", () => {
      const result = normalized([rule("45", "45", 1, { provider: "espn" })]);
      expect(reasonCodes(result)).toEqual(["NONLINEAR_RULE"]);
      expect(supportedPositions(result)).toEqual([]);
      for (const position of LEAGUE_SCORING_POSITIONS) {
        expect(positionReasonCodes(result, position)).toContain("NONLINEAR_RULE");
      }
    });

    it("prices a bare yards-allowed bracket ID arriving with nonzero points as a mapped D/ST tier probability", () => {
      // Inverted at WP2: before the 128-136 mapping this was a D/ST-scoped NONLINEAR_RULE; a bare
      // 128 with nonzero points is now a mapped, priceable D/ST rule, so a league with no other
      // D/ST failure (no 206/209 rows here) flips D/ST to supported.
      const result = normalized([
        rule("3", "3", 0.04, { provider: "espn" }),
        rule("128", "128", 5, { provider: "espn" }),
      ]);
      expectAvailable(result);
      expect(supportedPositions(result)).toEqual(["QB", "DST"]);
      expect(result.profile.rules).toContainEqual({
        statId: "yards_allowed_0_99_probability",
        points: 5,
      });
      expect(positionReasonCodes(result, "RB")).toEqual(["NO_SUPPORTED_RULES"]);
    });
  });

  /**
   * WP2 Steps 1 & 5 — D/ST vocabulary drift guards. The slot-16 acceptance set and the DST
   * position vocabulary are both `new Set(firstPartyTeamDefenseProjectionComponents())` by
   * construction now, so what remains to pin is (a) that every ESPN-mapped defense-family
   * component is one the engine actually produces (a mapped-but-unproduced component would strand
   * every `:slot:16` override at the reject branch, since acceptance requires BOTH the map entry
   * and set membership), and (b) that the availability unions expose the nine yards components, so
   * `COMPONENT_UNAVAILABLE` can never fire on a rule the run does emit. The worker's own union
   * (`firstPartyAvailableProjectionComponents`) is pinned byte-equal to
   * `rosAvailableProjectionStatIds` in
   * `apps/worker/src/first-party-ros-scoring-profile-selection.test.ts`, and the decisions
   * package's fan-out is exercised in `packages/decisions/src/managed-projection-profile.test.ts`
   * — a package test cannot import either workspace without a cross-workspace cycle.
   */
  describe("WP2: one D/ST component vocabulary", () => {
    const YARDS_ALLOWED_LADDER: ReadonlyArray<readonly [string, string]> = [
      ["128", "yards_allowed_0_99_probability"],
      ["129", "yards_allowed_100_199_probability"],
      ["130", "yards_allowed_200_299_probability"],
      ["131", "yards_allowed_300_349_probability"],
      ["132", "yards_allowed_350_399_probability"],
      ["133", "yards_allowed_400_449_probability"],
      ["134", "yards_allowed_450_499_probability"],
      ["135", "yards_allowed_500_549_probability"],
      ["136", "yards_allowed_550_plus_probability"],
    ];

    it("maps 128-136 to the evidence-established ladder in order, each producible by the defense projector", () => {
      const engine = new Set(firstPartyTeamDefenseProjectionComponents());
      for (const [statId, component] of YARDS_ALLOWED_LADDER) {
        expect(ESPN_PLAYER_SCORING_STAT_ID_MAP_V1[statId], statId).toBe(component);
        expect(engine.has(component), component).toBe(true);
      }
    });

    it("keeps every ESPN defense-family mapped component inside the engine's defense vocabulary", () => {
      const engine = new Set(firstPartyTeamDefenseProjectionComponents());
      const defenseFamily = Object.values(ESPN_PLAYER_SCORING_STAT_ID_MAP_V1).filter(
        (component) =>
          component.startsWith("defensive_") ||
          component.startsWith("points_allowed") ||
          component.startsWith("yards_allowed") ||
          component === "special_teams_touchdowns",
      );
      expect(defenseFamily.length).toBeGreaterThan(0);
      for (const component of defenseFamily) {
        expect(engine.has(component), component).toBe(true);
      }
    });

    it("derives the DST position vocabulary from the engine, byte-for-byte", () => {
      expect([...leagueScoringPositionComponents("DST")].sort()).toEqual(
        [...firstPartyTeamDefenseProjectionComponents()].sort(),
      );
    });

    it("exposes the nine yards-allowed tier components through the ROS availability union", () => {
      const available = new Set(rosAvailableProjectionStatIds());
      for (const [, component] of YARDS_ALLOWED_LADDER) {
        expect(available.has(component), component).toBe(true);
      }
    });
  });

  /**
   * The de minimis zero model — `docs/dst-stat-id-evidence-2026-07-29.md` §4. ESPN 206 ("2pt
   * Return") and 209 ("1pt Safety") are mapped and priced at a constant zero because publicly
   * citable occurrence data bounds each one's expected fantasy points below 0.01 per team-week at
   * the leagues' own point values. What these tests hold down is that the zero is a MODEL and not a
   * hole: the rules are mapped, carried, attributed to D/ST alone, and contribute exactly 0.
   */
  describe("de minimis zero components (206 / 209)", () => {
    const DE_MINIMIS: ReadonlyArray<readonly [string, string, number]> = [
      ["206", "defensive_two_point_returns", 2],
      ["209", "one_point_safeties", 1],
    ];

    it("maps each de minimis ID to a component the defense projector actually emits", () => {
      const engine = new Set(firstPartyTeamDefenseProjectionComponents());
      const available = new Set(rosAvailableProjectionStatIds());
      for (const [statId, component] of DE_MINIMIS) {
        expect(ESPN_PLAYER_SCORING_STAT_ID_MAP_V1[statId], statId).toBe(component);
        // One vocabulary: engine membership is what the `:slot:16` acceptance gate and the DST
        // position vocabulary are both derived from, and the availability union follows it, so a
        // mapped-but-unproduced component could never reach a caller.
        expect(engine.has(component), component).toBe(true);
        expect(available.has(component), component).toBe(true);
        expect(leagueScoringPositionComponents("DST").has(component), component).toBe(true);
      }
    });

    it.each(DE_MINIMIS.map(([statId, component, points]) => ({ statId, component, points })))(
      "prices a bare ESPN $statId rule as $component and scopes it to D/ST",
      ({ statId, component, points }) => {
        const result = normalized([
          rule("3", "3", 0.04, { provider: "espn" }),
          rule(statId, statId, points, { provider: "espn" }),
        ]);
        expectAvailable(result);
        expect(supportedPositions(result)).toEqual(["QB", "DST"]);
        expect(result.profile.rules).toContainEqual({ statId: component, points });
      },
    );

    it.each(DE_MINIMIS.map(([statId, component, points]) => ({ statId, component, points })))(
      "accepts an ESPN $statId :slot:16 override as $component",
      ({ statId, component, points }) => {
        const result = normalized([
          rule("3", "3", 0.04, { provider: "espn" }),
          rule(`${statId}:slot:16`, `ESPN stat ${statId} override for D/ST`, points, {
            provider: "espn",
          }),
        ]);
        expectAvailable(result);
        expect(supportFor(result, "DST").supported).toBe(true);
        expect(supportFor(result, "DST").reasons).toEqual([]);
        expect(result.profile.rules).toContainEqual({ statId: component, points });
      },
    );

    it("keeps 204/205/207/208 unsupported with their own per-ID reasons", () => {
      // The criterion is per-component and evidence-gated: only the two IDs with a recorded bound
      // were mapped. The offense/defense-specific variants have no bound and no league in scope, so
      // they must still fail closed — a category-wide amnesty would be the failure mode here.
      for (const statId of ["204", "205", "207", "208"]) {
        expect(ESPN_PLAYER_SCORING_STAT_ID_MAP_V1[statId], statId).toBeUndefined();
        const result = normalized([
          rule("3", "3", 0.04, { provider: "espn" }),
          rule(statId, statId, 2, { provider: "espn" }),
        ]);
        expect(positionReasonCodes(result, "DST"), statId).toEqual(["UNSUPPORTED_PLAYER_RULE"]);
        expect(supportFor(result, "DST").reasons[0]?.message, statId).toContain(`stat ${statId}`);
      }
    });

    it("contributes exactly zero to a scored line at any point value", () => {
      // Scoring isolation. The projector emits both components at a constant 0, so a league that
      // prices them cannot get a different number from one that does not — which is precisely what
      // makes the disclosed model claim safe to ship.
      const result = normalizeLeagueScoringProfile({
        id: "espn-league-b",
        rows: ESPN_LEAGUE_B_ROWS,
        availableStatIds: rosAvailableProjectionStatIds(),
      });
      expectAvailable(result);
      const defenseLine = {
        defensive_sacks: 2.4,
        defensive_interceptions: 0.9,
        points_allowed_14_17_probability: 0.31,
        yards_allowed_350_399_probability: 0.22,
        special_teams_touchdowns: 0.05,
        defensive_two_point_returns: 0,
        one_point_safeties: 0,
      };
      const withoutDeMinimis = {
        ...result.profile,
        rules: result.profile.rules.filter(
          (item) =>
            item.statId !== "defensive_two_point_returns" && item.statId !== "one_point_safeties",
        ),
      };
      expect(result.profile.rules.length - withoutDeMinimis.rules.length).toBe(2);
      expect(scoreProjectionStatComponents(defenseLine, result.profile)).toBe(
        scoreProjectionStatComponents(defenseLine, withoutDeMinimis),
      );
      // And an exaggerated price cannot move it either: 0 x anything is 0.
      const exaggerated = {
        ...result.profile,
        rules: result.profile.rules.map((item) =>
          item.statId === "defensive_two_point_returns" || item.statId === "one_point_safeties"
            ? { ...item, points: 1000 }
            : item,
        ),
      };
      expect(scoreProjectionStatComponents(defenseLine, exaggerated)).toBe(
        scoreProjectionStatComponents(defenseLine, withoutDeMinimis),
      );
    });

    /**
     * WP0's per-cell identity is what keeps the ROS rail publishing when a league's WHOLE profile
     * key moves. The flip moves it for all three leagues, so the load-bearing pin is that no
     * SUPPORTED rail position's scoped key moved with it: D/ST-only components are outside every
     * QB/RB/WR/TE/K vocabulary, so their arrival cannot change what any rail position is scored on.
     *
     * League A's QB/RB/WR/TE keys DO move, from `"[]"` to `special_teams_touchdowns` — that rule is
     * shared with D/ST, so it stops being excluded once D/ST is supported. It is inert: those four
     * positions are unsupported for league A before and after, and `matchFirstPartyRosPositions`
     * withholds an unsupported position without ever comparing keys (and never reads `"[]"` as a
     * match anyway).
     */
    it("leaves every supported rail position's scoped scoring key byte-identical across the flip", () => {
      const preFlipSupportedKeys: Readonly<Record<string, Readonly<Record<string, string>>>> = {
        "espn-league-a": {
          K: '[{"statId":"extra_points_made","points":1,"bonuses":[]},{"statId":"field_goals_made_0_39","points":3,"bonuses":[]},{"statId":"field_goals_made_40_49","points":4,"bonuses":[]},{"statId":"field_goals_made_50_59","points":5,"bonuses":[]},{"statId":"field_goals_made_60_plus","points":6,"bonuses":[]},{"statId":"field_goals_missed","points":-1,"bonuses":[]}]',
        },
        "espn-league-b": {
          QB: '[{"statId":"fumble_recovery_touchdowns","points":6,"bonuses":[]},{"statId":"fumbles_lost","points":-2,"bonuses":[]},{"statId":"passing_interceptions","points":-2,"bonuses":[]},{"statId":"passing_touchdowns","points":4,"bonuses":[]},{"statId":"passing_two_point_conversions","points":2,"bonuses":[]},{"statId":"passing_yards","points":0.04,"bonuses":[]},{"statId":"receiving_two_point_conversions","points":2,"bonuses":[]},{"statId":"rushing_touchdowns","points":6,"bonuses":[]},{"statId":"rushing_two_point_conversions","points":2,"bonuses":[]},{"statId":"rushing_yards","points":0.1,"bonuses":[]},{"statId":"special_teams_touchdowns","points":6,"bonuses":[]}]',
          RB: '[{"statId":"fumble_recovery_touchdowns","points":6,"bonuses":[]},{"statId":"fumbles_lost","points":-2,"bonuses":[]},{"statId":"passing_two_point_conversions","points":2,"bonuses":[]},{"statId":"receiving_touchdowns","points":6,"bonuses":[]},{"statId":"receiving_two_point_conversions","points":2,"bonuses":[]},{"statId":"receiving_yards","points":0.1,"bonuses":[]},{"statId":"rushing_touchdowns","points":6,"bonuses":[]},{"statId":"rushing_two_point_conversions","points":2,"bonuses":[]},{"statId":"rushing_yards","points":0.1,"bonuses":[]},{"statId":"special_teams_touchdowns","points":6,"bonuses":[]}]',
          WR: '[{"statId":"fumble_recovery_touchdowns","points":6,"bonuses":[]},{"statId":"fumbles_lost","points":-2,"bonuses":[]},{"statId":"passing_two_point_conversions","points":2,"bonuses":[]},{"statId":"receiving_touchdowns","points":6,"bonuses":[]},{"statId":"receiving_two_point_conversions","points":2,"bonuses":[]},{"statId":"receiving_yards","points":0.1,"bonuses":[]},{"statId":"rushing_touchdowns","points":6,"bonuses":[]},{"statId":"rushing_two_point_conversions","points":2,"bonuses":[]},{"statId":"rushing_yards","points":0.1,"bonuses":[]},{"statId":"special_teams_touchdowns","points":6,"bonuses":[]}]',
          TE: '[{"statId":"fumble_recovery_touchdowns","points":6,"bonuses":[]},{"statId":"fumbles_lost","points":-2,"bonuses":[]},{"statId":"passing_two_point_conversions","points":2,"bonuses":[]},{"statId":"receiving_touchdowns","points":6,"bonuses":[]},{"statId":"receiving_two_point_conversions","points":2,"bonuses":[]},{"statId":"receiving_yards","points":0.1,"bonuses":[]},{"statId":"rushing_touchdowns","points":6,"bonuses":[]},{"statId":"rushing_two_point_conversions","points":2,"bonuses":[]},{"statId":"rushing_yards","points":0.1,"bonuses":[]},{"statId":"special_teams_touchdowns","points":6,"bonuses":[]}]',
          K: '[{"statId":"extra_points_made","points":1,"bonuses":[]},{"statId":"extra_points_missed","points":-1,"bonuses":[]},{"statId":"field_goals_made_0_39","points":3,"bonuses":[]},{"statId":"field_goals_made_40_49","points":4,"bonuses":[]},{"statId":"field_goals_made_50_59","points":5,"bonuses":[]},{"statId":"field_goals_made_60_plus","points":5,"bonuses":[]},{"statId":"field_goals_missed","points":-1,"bonuses":[]}]',
        },
        "espn-league-c": {
          QB: '[{"statId":"fumble_recovery_touchdowns","points":6,"bonuses":[]},{"statId":"fumbles_lost","points":-2,"bonuses":[]},{"statId":"passing_interceptions","points":-2,"bonuses":[]},{"statId":"passing_touchdowns","points":4,"bonuses":[]},{"statId":"passing_two_point_conversions","points":2,"bonuses":[]},{"statId":"passing_yards","points":0.04,"bonuses":[]},{"statId":"receiving_two_point_conversions","points":2,"bonuses":[]},{"statId":"rushing_touchdowns","points":6,"bonuses":[]},{"statId":"rushing_two_point_conversions","points":2,"bonuses":[]},{"statId":"rushing_yards","points":0.1,"bonuses":[]},{"statId":"special_teams_touchdowns","points":6,"bonuses":[]}]',
          RB: '[{"statId":"fumble_recovery_touchdowns","points":6,"bonuses":[]},{"statId":"fumbles_lost","points":-2,"bonuses":[]},{"statId":"passing_two_point_conversions","points":2,"bonuses":[]},{"statId":"receiving_touchdowns","points":6,"bonuses":[]},{"statId":"receiving_two_point_conversions","points":2,"bonuses":[]},{"statId":"receiving_yards","points":0.1,"bonuses":[]},{"statId":"rushing_touchdowns","points":6,"bonuses":[]},{"statId":"rushing_two_point_conversions","points":2,"bonuses":[]},{"statId":"rushing_yards","points":0.1,"bonuses":[]},{"statId":"special_teams_touchdowns","points":6,"bonuses":[]}]',
          WR: '[{"statId":"fumble_recovery_touchdowns","points":6,"bonuses":[]},{"statId":"fumbles_lost","points":-2,"bonuses":[]},{"statId":"passing_two_point_conversions","points":2,"bonuses":[]},{"statId":"receiving_touchdowns","points":6,"bonuses":[]},{"statId":"receiving_two_point_conversions","points":2,"bonuses":[]},{"statId":"receiving_yards","points":0.1,"bonuses":[]},{"statId":"rushing_touchdowns","points":6,"bonuses":[]},{"statId":"rushing_two_point_conversions","points":2,"bonuses":[]},{"statId":"rushing_yards","points":0.1,"bonuses":[]},{"statId":"special_teams_touchdowns","points":6,"bonuses":[]}]',
          TE: '[{"statId":"fumble_recovery_touchdowns","points":6,"bonuses":[]},{"statId":"fumbles_lost","points":-2,"bonuses":[]},{"statId":"passing_two_point_conversions","points":2,"bonuses":[]},{"statId":"receiving_touchdowns","points":6,"bonuses":[]},{"statId":"receiving_two_point_conversions","points":2,"bonuses":[]},{"statId":"receiving_yards","points":0.1,"bonuses":[]},{"statId":"rushing_touchdowns","points":6,"bonuses":[]},{"statId":"rushing_two_point_conversions","points":2,"bonuses":[]},{"statId":"rushing_yards","points":0.1,"bonuses":[]},{"statId":"special_teams_touchdowns","points":6,"bonuses":[]}]',
          K: '[{"statId":"extra_points_made","points":1,"bonuses":[]},{"statId":"field_goals_made_0_39","points":3,"bonuses":[]},{"statId":"field_goals_made_40_49","points":4,"bonuses":[]},{"statId":"field_goals_made_50_59","points":5,"bonuses":[]},{"statId":"field_goals_made_60_plus","points":5,"bonuses":[]},{"statId":"field_goals_missed","points":-1,"bonuses":[]}]',
        },
      };

      for (const [name, rows] of [
        ["espn-league-a", ESPN_LEAGUE_A_ROWS],
        ["espn-league-b", ESPN_LEAGUE_B_ROWS],
        ["espn-league-c", ESPN_LEAGUE_C_ROWS],
      ] as const) {
        const result = normalizeLeagueScoringProfile({
          id: name,
          rows,
          availableStatIds: rosAvailableProjectionStatIds(),
        });
        expectAvailable(result);
        const expectedKeys = preFlipSupportedKeys[name] ?? {};
        const supported = new Set(supportedPositions(result));
        for (const position of ["QB", "RB", "WR", "TE", "K"] as const) {
          const expectedKey = expectedKeys[position];
          if (expectedKey === undefined) {
            // Unsupported before AND after; the rail withholds it on support, never on key.
            expect(supported.has(position), `${name}/${position}`).toBe(false);
            continue;
          }
          expect(supported.has(position), `${name}/${position}`).toBe(true);
          expect(
            projectionScoringProfileKeyForPosition(result.profile, position),
            `${name}/${position}`,
          ).toBe(expectedKey);
        }
        // D/ST is the cell that legitimately moved, and it moved from nothing to something.
        expect(supported.has("DST"), name).toBe(true);
        expect(projectionScoringProfileKeyForPosition(result.profile, "DST")).toContain(
          "defensive_two_point_returns",
        );
      }
    });
  });
});
