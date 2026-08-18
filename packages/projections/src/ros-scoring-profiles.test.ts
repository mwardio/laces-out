import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { normalizeLeagueScoringProfile, type StoredLeagueScoringRule } from "./league-scoring.js";
import {
  ROS_SCORING_PROFILE_KEYS,
  rosAvailableProjectionStatIds,
  rosScoringProfile,
  rosScoringProfileCatalog,
} from "./ros-scoring-profiles.js";
import { projectionScoringProfileKeyForPosition } from "./scoring-position-keys.js";
import { projectionScoringProfileKey, scoreProjectionStatComponents } from "./scoring.js";

describe("rosScoringProfileCatalog", () => {
  it("keeps the three legacy redraft profiles first, in fixed order", () => {
    expect([...ROS_SCORING_PROFILE_KEYS].slice(0, 3)).toEqual(["full-ppr", "half-ppr", "standard"]);
    expect(
      rosScoringProfileCatalog()
        .slice(0, 3)
        .map((entry) => entry.key),
    ).toEqual(["full-ppr", "half-ppr", "standard"]);
  });

  it("covers every admitted profile shape in fixed order — order is load bearing", () => {
    expect([...ROS_SCORING_PROFILE_KEYS]).toEqual([
      "full-ppr",
      "half-ppr",
      "standard",
      "espn-standard-2pt",
      "espn-standard-2pt-nxm",
      "espn-ppr-yardage-bonus-6pt-pass",
    ]);
    expect(rosScoringProfileCatalog().map((entry) => entry.key)).toEqual([
      ...ROS_SCORING_PROFILE_KEYS,
    ]);
  });

  it("pins the three legacy profiles' scoringProfileKey strings verbatim", () => {
    // These are the byte-frozen identities: apps/web/src/app/methodology/evidence.ts publishes
    // sha256 digests of these exact strings as ROS evidence. A change here means the admitted
    // profile's semantic key changed shape, which must be fixed rather than re-pinned.
    expect(rosScoringProfile("full-ppr").scoringProfileKey).toBe(
      '[{"statId":"defensive_blocked_kicks","points":2,"bonuses":[]},{"statId":"defensive_fumble_recoveries","points":2,"bonuses":[]},{"statId":"defensive_interceptions","points":2,"bonuses":[]},{"statId":"defensive_sacks","points":1,"bonuses":[]},{"statId":"defensive_safeties","points":2,"bonuses":[]},{"statId":"defensive_touchdowns","points":6,"bonuses":[]},{"statId":"extra_points_made","points":1,"bonuses":[]},{"statId":"field_goals_made_0_39","points":3,"bonuses":[]},{"statId":"field_goals_made_40_49","points":4,"bonuses":[]},{"statId":"field_goals_made_50_plus","points":5,"bonuses":[]},{"statId":"field_goals_missed","points":-1,"bonuses":[]},{"statId":"fumbles_lost","points":-2,"bonuses":[]},{"statId":"passing_interceptions","points":-2,"bonuses":[]},{"statId":"passing_touchdowns","points":4,"bonuses":[]},{"statId":"passing_yards","points":0.04,"bonuses":[]},{"statId":"points_allowed_0_probability","points":10,"bonuses":[]},{"statId":"points_allowed_14_20_probability","points":1,"bonuses":[]},{"statId":"points_allowed_1_6_probability","points":7,"bonuses":[]},{"statId":"points_allowed_21_27_probability","points":0,"bonuses":[]},{"statId":"points_allowed_28_34_probability","points":-1,"bonuses":[]},{"statId":"points_allowed_35_plus_probability","points":-4,"bonuses":[]},{"statId":"points_allowed_7_13_probability","points":4,"bonuses":[]},{"statId":"receiving_touchdowns","points":6,"bonuses":[]},{"statId":"receiving_yards","points":0.1,"bonuses":[]},{"statId":"receptions","points":1,"bonuses":[]},{"statId":"rushing_touchdowns","points":6,"bonuses":[]},{"statId":"rushing_yards","points":0.1,"bonuses":[]},{"statId":"special_teams_touchdowns","points":6,"bonuses":[]}]',
    );
    expect(rosScoringProfile("half-ppr").scoringProfileKey).toBe(
      '[{"statId":"defensive_blocked_kicks","points":2,"bonuses":[]},{"statId":"defensive_fumble_recoveries","points":2,"bonuses":[]},{"statId":"defensive_interceptions","points":2,"bonuses":[]},{"statId":"defensive_sacks","points":1,"bonuses":[]},{"statId":"defensive_safeties","points":2,"bonuses":[]},{"statId":"defensive_touchdowns","points":6,"bonuses":[]},{"statId":"extra_points_made","points":1,"bonuses":[]},{"statId":"field_goals_made_0_39","points":3,"bonuses":[]},{"statId":"field_goals_made_40_49","points":4,"bonuses":[]},{"statId":"field_goals_made_50_plus","points":5,"bonuses":[]},{"statId":"field_goals_missed","points":-1,"bonuses":[]},{"statId":"fumbles_lost","points":-2,"bonuses":[]},{"statId":"passing_interceptions","points":-2,"bonuses":[]},{"statId":"passing_touchdowns","points":4,"bonuses":[]},{"statId":"passing_yards","points":0.04,"bonuses":[]},{"statId":"points_allowed_0_probability","points":10,"bonuses":[]},{"statId":"points_allowed_14_20_probability","points":1,"bonuses":[]},{"statId":"points_allowed_1_6_probability","points":7,"bonuses":[]},{"statId":"points_allowed_21_27_probability","points":0,"bonuses":[]},{"statId":"points_allowed_28_34_probability","points":-1,"bonuses":[]},{"statId":"points_allowed_35_plus_probability","points":-4,"bonuses":[]},{"statId":"points_allowed_7_13_probability","points":4,"bonuses":[]},{"statId":"receiving_touchdowns","points":6,"bonuses":[]},{"statId":"receiving_yards","points":0.1,"bonuses":[]},{"statId":"receptions","points":0.5,"bonuses":[]},{"statId":"rushing_touchdowns","points":6,"bonuses":[]},{"statId":"rushing_yards","points":0.1,"bonuses":[]},{"statId":"special_teams_touchdowns","points":6,"bonuses":[]}]',
    );
    expect(rosScoringProfile("standard").scoringProfileKey).toBe(
      '[{"statId":"defensive_blocked_kicks","points":2,"bonuses":[]},{"statId":"defensive_fumble_recoveries","points":2,"bonuses":[]},{"statId":"defensive_interceptions","points":2,"bonuses":[]},{"statId":"defensive_sacks","points":1,"bonuses":[]},{"statId":"defensive_safeties","points":2,"bonuses":[]},{"statId":"defensive_touchdowns","points":6,"bonuses":[]},{"statId":"extra_points_made","points":1,"bonuses":[]},{"statId":"field_goals_made_0_39","points":3,"bonuses":[]},{"statId":"field_goals_made_40_49","points":4,"bonuses":[]},{"statId":"field_goals_made_50_plus","points":5,"bonuses":[]},{"statId":"field_goals_missed","points":-1,"bonuses":[]},{"statId":"fumbles_lost","points":-2,"bonuses":[]},{"statId":"passing_interceptions","points":-2,"bonuses":[]},{"statId":"passing_touchdowns","points":4,"bonuses":[]},{"statId":"passing_yards","points":0.04,"bonuses":[]},{"statId":"points_allowed_0_probability","points":10,"bonuses":[]},{"statId":"points_allowed_14_20_probability","points":1,"bonuses":[]},{"statId":"points_allowed_1_6_probability","points":7,"bonuses":[]},{"statId":"points_allowed_21_27_probability","points":0,"bonuses":[]},{"statId":"points_allowed_28_34_probability","points":-1,"bonuses":[]},{"statId":"points_allowed_35_plus_probability","points":-4,"bonuses":[]},{"statId":"points_allowed_7_13_probability","points":4,"bonuses":[]},{"statId":"receiving_touchdowns","points":6,"bonuses":[]},{"statId":"receiving_yards","points":0.1,"bonuses":[]},{"statId":"receptions","points":0,"bonuses":[]},{"statId":"rushing_touchdowns","points":6,"bonuses":[]},{"statId":"rushing_yards","points":0.1,"bonuses":[]},{"statId":"special_teams_touchdowns","points":6,"bonuses":[]}]',
    );
  });

  it("differs only in reception points", () => {
    const reception = { receptions: 1 };
    expect(scoreProjectionStatComponents(reception, rosScoringProfile("full-ppr").profile)).toBe(1);
    expect(scoreProjectionStatComponents(reception, rosScoringProfile("half-ppr").profile)).toBe(
      0.5,
    );
    expect(scoreProjectionStatComponents(reception, rosScoringProfile("standard").profile)).toBe(0);

    const rushing = { rushing_yards: 100, rushing_touchdowns: 1 };
    for (const key of ROS_SCORING_PROFILE_KEYS) {
      expect(scoreProjectionStatComponents(rushing, rosScoringProfile(key).profile)).toBe(16);
    }
  });

  it("gives every profile a distinct semantic key and a distinct sha256 digest", () => {
    const keys = new Set(
      ROS_SCORING_PROFILE_KEYS.map((key) =>
        projectionScoringProfileKey(rosScoringProfile(key).profile),
      ),
    );
    const digests = new Set(ROS_SCORING_PROFILE_KEYS.map((key) => rosScoringProfile(key).digest));

    expect(keys.size).toBe(ROS_SCORING_PROFILE_KEYS.length);
    expect(digests.size).toBe(ROS_SCORING_PROFILE_KEYS.length);
    for (const digest of digests) expect(digest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("derives the digest from the semantic key rather than a transcribed literal", () => {
    for (const key of ROS_SCORING_PROFILE_KEYS) {
      const entry = rosScoringProfile(key);
      expect(entry.scoringProfileKey).toBe(projectionScoringProfileKey(entry.profile));
      expect(entry.digest).toBe(createHash("sha256").update(entry.scoringProfileKey).digest("hex"));
    }
  });

  it("pins the full-PPR digest already published as ROS evidence", () => {
    // apps/web/src/app/methodology/evidence.ts:61 publishes this digest for the admitted artifact.
    // A change here would mean the catalog altered the admitted profile, which must be fixed rather
    // than re-pinned.
    expect(rosScoringProfile("full-ppr").digest).toBe(
      "dd74455ddb551d53f68ba9420f4446aebf63e3e8ea34efd24119cc780c47a484",
    );
  });

  it("keeps every profile independently valid and stably labelled", () => {
    for (const entry of rosScoringProfileCatalog()) {
      expect(entry.profile.id).toBe(`laces-out-historical-ros-${entry.key}`);
      expect(entry.label.length).toBeGreaterThan(0);
    }
    // Rule count of 28 is a shape fact of the byte-frozen trio specifically (27 shared rules plus
    // one reception rule), not a catalog-wide invariant — the ESPN-shaped entries carry a different
    // rule count entirely (see the "ESPN-shaped catalog entries" suite below).
    for (const key of ["full-ppr", "half-ppr", "standard"] as const) {
      expect(rosScoringProfile(key).profile.rules).toHaveLength(28);
    }
    expect(rosScoringProfileCatalog().map((entry) => entry.label)).toEqual([
      "Full PPR",
      "Half PPR",
      "Standard (non-PPR)",
      "Standard + 2-pt, split kicker brackets, XP-missed penalty",
      "Standard + 2-pt, split kicker brackets, no XP-missed penalty",
      "Full PPR + yardage-game bonuses, 6-pt passing TD",
    ]);
  });

  it("rejects an unknown profile key rather than falling back", () => {
    expect(() => rosScoringProfile("super-flex" as never)).toThrow(/unknown ros scoring profile/iu);
  });
});

/**
 * The catalog profiles are not hand-derived from source data. This suite runs the real normalizer
 * over the same rows and asserts the catalog key equals its output. That equality check is the
 * specification; the entries in ros-scoring-profiles.ts exist only to satisfy it.
 */
describe("ESPN-shaped catalog entries", () => {
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

  // Verbatim copies of ESPN_LEAGUE_B_ROWS / ESPN_LEAGUE_C_ROWS from league-scoring.test.ts (kept
  // local, not imported, so this file never executes that file's suite as a module side effect). If
  // the two ever diverge, resync by diffing against league-scoring.test.ts.
  const ESPN_STANDARD_2PT_SOURCE_ROWS: readonly StoredLeagueScoringRule[] = [
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

  const ESPN_STANDARD_2PT_NXM_SOURCE_ROWS: readonly StoredLeagueScoringRule[] = [
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

  // League A is the no-XP-miss source shape plus Full PPR, six-point passing touchdowns, a
  // six-point 60-plus field goal, and ESPN's mutually exclusive yardage-game categories.
  const ESPN_PPR_YARDAGE_BONUS_6PT_PASS_SOURCE_ROWS: readonly StoredLeagueScoringRule[] = [
    ...ESPN_STANDARD_2PT_NXM_SOURCE_ROWS.map((stored) =>
      stored.providerStatId === "4"
        ? { ...stored, points: 6 }
        : stored.providerStatId === "201"
          ? { ...stored, points: 6 }
          : stored,
    ),
    rule("17", "17", 1, { provider: "espn" }),
    rule("18", "18", 3, { provider: "espn" }),
    rule("37", "37", 1, { provider: "espn" }),
    rule("38", "38", 3, { provider: "espn" }),
    rule("53", "53", 1, { provider: "espn" }),
    rule("56", "56", 1, { provider: "espn" }),
    rule("57", "57", 3, { provider: "espn" }),
  ];

  /** The positions the ROS rail releases — the scope compared by per-cell identity. */
  const RAIL_POSITIONS = ["QB", "RB", "WR", "TE", "K", "DST"] as const;

  /**
   * These ESPN profiles are exact transcriptions of the current league shapes. Their semantic
   * identities include D/ST because the live rail now models and publishes all six positions.
   * Changing either digest requires a new held-out validation report and a new admitted artifact.
   */
  it.each([
    {
      key: "espn-standard-2pt" as const,
      rows: ESPN_STANDARD_2PT_SOURCE_ROWS,
      frozenDigest: "6a2ce8c94a3733673f17056d2ffafc27dca00c1ab93d17ce58a1bdce9b6d6843",
    },
    {
      key: "espn-standard-2pt-nxm" as const,
      rows: ESPN_STANDARD_2PT_NXM_SOURCE_ROWS,
      frozenDigest: "d0e49cad7fbbdf20552427d107bea2cd9a6c2f735b4d67745d5e5ca9e85832eb",
    },
    {
      key: "espn-ppr-yardage-bonus-6pt-pass" as const,
      rows: ESPN_PPR_YARDAGE_BONUS_6PT_PASS_SOURCE_ROWS,
      frozenDigest: "e6c8565a7d77ef3678fe792b51868eadac7c60951ebc7309f508e1298db0c80a",
    },
  ])(
    "matches the $key source rows at every rail position, with its digest byte-frozen",
    ({ key, rows, frozenDigest }) => {
      const result = normalizeLeagueScoringProfile({
        id: `${key}-fixture`,
        rows,
        availableStatIds: rosAvailableProjectionStatIds(),
      });
      expect(result.state).toBe("available");
      if (result.state !== "available") throw new Error("unreachable — asserted above");

      const entry = rosScoringProfile(key);
      expect(entry.digest).toBe(frozenDigest);

      // What the gate actually compares: each rail position's scoped key, byte-equal.
      for (const position of RAIL_POSITIONS) {
        expect(projectionScoringProfileKeyForPosition(result.profile, position), position).toBe(
          projectionScoringProfileKeyForPosition(entry.profile, position),
        );
        expect(projectionScoringProfileKeyForPosition(entry.profile, position), position).not.toBe(
          "[]",
        );
      }
      // The whole semantic identity is exact too, including D/ST rules.
      const wholeKey = projectionScoringProfileKey(result.profile);
      expect(wholeKey).toBe(entry.scoringProfileKey);
      expect(projectionScoringProfileKeyForPosition(entry.profile, "DST")).not.toBe("[]");
    },
  );

  it("carries no zero-point rules in any ESPN-shaped entry", () => {
    for (const key of [
      "espn-standard-2pt",
      "espn-standard-2pt-nxm",
      "espn-ppr-yardage-bonus-6pt-pass",
    ] as const) {
      for (const rule of rosScoringProfile(key).profile.rules) {
        expect(rule.points).not.toBe(0);
      }
    }
  });

  it("differs between the two new entries only by the missed-extra-point penalty rule", () => {
    const withPenalty = new Map(
      rosScoringProfile("espn-standard-2pt").profile.rules.map((item) => [
        item.statId,
        item.points,
      ]),
    );
    const withoutPenalty = new Map(
      rosScoringProfile("espn-standard-2pt-nxm").profile.rules.map((item) => [
        item.statId,
        item.points,
      ]),
    );

    expect(withPenalty.has("extra_points_missed")).toBe(true);
    expect(withoutPenalty.has("extra_points_missed")).toBe(false);

    withPenalty.delete("extra_points_missed");
    expect(withPenalty).toEqual(withoutPenalty);
  });
});
