import { createHash } from "node:crypto";

import {
  firstPartyProjectionComponentsForPosition,
  firstPartyTeamDefenseProjectionComponents,
} from "./first-party.js";
import { projectionScoringProfileKey, type ProjectionScoringProfile } from "./scoring.js";

/** Player positions the rest-of-season rail models. Mirrors the worker's supported set. */
const ROS_SUPPORTED_POSITIONS = ["QB", "RB", "WR", "TE", "K", "DST"] as const;

/**
 * The common redraft scoring profiles the rest-of-season rail can be validated for. Order is fixed
 * and load bearing: reports, status responses, and operator output all enumerate in this order. The
 * first three are the historically admitted PPR/half-PPR/standard trio; the two ESPN-shaped entries
 * are appended after them and exist purely for WHOLE-KEY league matching — see
 * `ESPN_STANDARD_2PT_RULES` / `ESPN_STANDARD_2PT_NXM_RULES` below.
 */
export const ROS_SCORING_PROFILE_KEYS = [
  "full-ppr",
  "half-ppr",
  "standard",
  "espn-standard-2pt",
  "espn-standard-2pt-nxm",
  "espn-ppr-yardage-bonus-6pt-pass",
] as const;

export type RosScoringProfileKey = (typeof ROS_SCORING_PROFILE_KEYS)[number];

export interface RosScoringProfileEntry {
  readonly key: RosScoringProfileKey;
  /** Plain-language name safe to render in product copy. */
  readonly label: string;
  readonly profile: ProjectionScoringProfile;
  /** Canonical semantic key — full JSON, not a digest. This is what admission compares. */
  readonly scoringProfileKey: string;
  /** sha256 of `scoringProfileKey`, for display and provenance where the full key is too long. */
  readonly digest: string;
}

/**
 * Every rule the three profiles share. Reception points are the only permitted difference, so the
 * profiles cannot silently drift apart on any other stat.
 */
const SHARED_RULES: readonly ProjectionScoringProfile["rules"][number][] = [
  { statId: "passing_yards", points: 0.04 },
  { statId: "passing_touchdowns", points: 4 },
  { statId: "passing_interceptions", points: -2 },
  { statId: "rushing_yards", points: 0.1 },
  { statId: "rushing_touchdowns", points: 6 },
  { statId: "receiving_yards", points: 0.1 },
  { statId: "receiving_touchdowns", points: 6 },
  { statId: "fumbles_lost", points: -2 },
  { statId: "field_goals_made_0_39", points: 3 },
  { statId: "field_goals_made_40_49", points: 4 },
  { statId: "field_goals_made_50_plus", points: 5 },
  { statId: "field_goals_missed", points: -1 },
  { statId: "extra_points_made", points: 1 },
  { statId: "defensive_sacks", points: 1 },
  { statId: "defensive_interceptions", points: 2 },
  { statId: "defensive_fumble_recoveries", points: 2 },
  { statId: "defensive_safeties", points: 2 },
  { statId: "defensive_touchdowns", points: 6 },
  { statId: "defensive_blocked_kicks", points: 2 },
  { statId: "special_teams_touchdowns", points: 6 },
  { statId: "points_allowed_0_probability", points: 10 },
  { statId: "points_allowed_1_6_probability", points: 7 },
  { statId: "points_allowed_7_13_probability", points: 4 },
  { statId: "points_allowed_14_20_probability", points: 1 },
  { statId: "points_allowed_21_27_probability", points: 0 },
  { statId: "points_allowed_28_34_probability", points: -1 },
  { statId: "points_allowed_35_plus_probability", points: -4 },
];

/** The three profiles built from `SHARED_RULES` plus a reception rate. Byte-frozen — see above. */
type LegacyRosScoringProfileKey = "full-ppr" | "half-ppr" | "standard";

const RECEPTION_POINTS: Readonly<Record<LegacyRosScoringProfileKey, number>> = {
  "full-ppr": 1,
  "half-ppr": 0.5,
  standard: 0,
};

const LABELS: Readonly<Record<RosScoringProfileKey, string>> = {
  "full-ppr": "Full PPR",
  "half-ppr": "Half PPR",
  standard: "Standard (non-PPR)",
  "espn-standard-2pt": "Standard + 2-pt, split kicker brackets, XP-missed penalty",
  "espn-standard-2pt-nxm": "Standard + 2-pt, split kicker brackets, no XP-missed penalty",
  "espn-ppr-yardage-bonus-6pt-pass": "Full PPR + yardage-game bonuses, 6-pt passing TD",
};

function finalizeEntry(
  key: RosScoringProfileKey,
  rules: readonly ProjectionScoringProfile["rules"][number][],
): RosScoringProfileEntry {
  const profile: ProjectionScoringProfile = {
    id: `laces-out-historical-ros-${key}`,
    version: "1",
    rules,
  };
  const scoringProfileKey = projectionScoringProfileKey(profile);
  return {
    key,
    label: LABELS[key],
    profile,
    scoringProfileKey,
    digest: createHash("sha256").update(scoringProfileKey).digest("hex"),
  };
}

function buildLegacyEntry(key: LegacyRosScoringProfileKey): RosScoringProfileEntry {
  return finalizeEntry(key, [
    ...SHARED_RULES,
    { statId: "receptions", points: RECEPTION_POINTS[key] },
  ]);
}

/**
 * Rules observed in ESPN league shapes measured 2026-07-28: standard offense scoring (no PPR
 * credit) plus 2-point-conversion credit for all three skill positions, ESPN's split 50-59 /
 * 60-plus kicker brackets in place of a single 50-plus bracket, and a penalty for a missed extra
 * point. Standalone by design (no `SHARED_RULES` reuse), so this list and its sibling below can
 * diverge from the PPR/half-PPR/standard trio, and from each other, without any shared array to
 * keep in sync. Contains only stat IDs and points; no zero-point rules.
 */
const ESPN_STANDARD_DST_RULES: readonly ProjectionScoringProfile["rules"][number][] = [
  { statId: "defensive_sacks", points: 1 },
  { statId: "defensive_interceptions", points: 2 },
  { statId: "defensive_fumble_recoveries", points: 2 },
  { statId: "defensive_safeties", points: 2 },
  { statId: "defensive_touchdowns", points: 6 },
  { statId: "defensive_blocked_kicks", points: 2 },
  { statId: "defensive_two_point_returns", points: 2 },
  { statId: "one_point_safeties", points: 1 },
  { statId: "points_allowed_0_probability", points: 5 },
  { statId: "points_allowed_1_6_probability", points: 4 },
  { statId: "points_allowed_7_13_probability", points: 3 },
  { statId: "points_allowed_14_17_probability", points: 1 },
  { statId: "points_allowed_28_34_probability", points: -1 },
  { statId: "points_allowed_35_45_probability", points: -3 },
  { statId: "points_allowed_46_plus_probability", points: -5 },
  { statId: "yards_allowed_0_99_probability", points: 5 },
  { statId: "yards_allowed_100_199_probability", points: 3 },
  { statId: "yards_allowed_200_299_probability", points: 2 },
  { statId: "yards_allowed_350_399_probability", points: -1 },
  { statId: "yards_allowed_400_449_probability", points: -3 },
  { statId: "yards_allowed_450_499_probability", points: -5 },
  { statId: "yards_allowed_500_549_probability", points: -6 },
  { statId: "yards_allowed_550_plus_probability", points: -7 },
];

const ESPN_STANDARD_2PT_RULES: readonly ProjectionScoringProfile["rules"][number][] = [
  { statId: "passing_yards", points: 0.04 },
  { statId: "passing_touchdowns", points: 4 },
  { statId: "passing_interceptions", points: -2 },
  { statId: "passing_two_point_conversions", points: 2 },
  { statId: "rushing_yards", points: 0.1 },
  { statId: "rushing_touchdowns", points: 6 },
  { statId: "rushing_two_point_conversions", points: 2 },
  { statId: "receiving_yards", points: 0.1 },
  { statId: "receiving_touchdowns", points: 6 },
  { statId: "receiving_two_point_conversions", points: 2 },
  { statId: "fumbles_lost", points: -2 },
  { statId: "fumble_recovery_touchdowns", points: 6 },
  { statId: "field_goals_made_0_39", points: 3 },
  { statId: "field_goals_made_40_49", points: 4 },
  { statId: "field_goals_made_50_59", points: 5 },
  { statId: "field_goals_made_60_plus", points: 5 },
  { statId: "field_goals_missed", points: -1 },
  { statId: "extra_points_made", points: 1 },
  { statId: "extra_points_missed", points: -1 },
  { statId: "special_teams_touchdowns", points: 6 },
  ...ESPN_STANDARD_DST_RULES,
];

/**
 * Same ESPN league-shape evidence as `ESPN_STANDARD_2PT_RULES` (measured 2026-07-28), for a shape
 * that carries no missed-extra-point penalty rule. Written out standalone rather than derived from
 * the sibling list above, so the two never share an array to drift apart from.
 */
const ESPN_STANDARD_2PT_NXM_RULES: readonly ProjectionScoringProfile["rules"][number][] = [
  { statId: "passing_yards", points: 0.04 },
  { statId: "passing_touchdowns", points: 4 },
  { statId: "passing_interceptions", points: -2 },
  { statId: "passing_two_point_conversions", points: 2 },
  { statId: "rushing_yards", points: 0.1 },
  { statId: "rushing_touchdowns", points: 6 },
  { statId: "rushing_two_point_conversions", points: 2 },
  { statId: "receiving_yards", points: 0.1 },
  { statId: "receiving_touchdowns", points: 6 },
  { statId: "receiving_two_point_conversions", points: 2 },
  { statId: "fumbles_lost", points: -2 },
  { statId: "fumble_recovery_touchdowns", points: 6 },
  { statId: "field_goals_made_0_39", points: 3 },
  { statId: "field_goals_made_40_49", points: 4 },
  { statId: "field_goals_made_50_59", points: 5 },
  { statId: "field_goals_made_60_plus", points: 5 },
  { statId: "field_goals_missed", points: -1 },
  { statId: "extra_points_made", points: 1 },
  { statId: "special_teams_touchdowns", points: 6 },
  ...ESPN_STANDARD_DST_RULES,
];

/**
 * Exact scoring shape observed in the ESPN league whose 300/400 passing-yard and 100/200
 * rushing/receiving-yard game bonuses motivated the probability-component model. Its other
 * differences from the no-XP-miss ESPN shape are Full PPR, six-point passing touchdowns, and a
 * six-point 60-plus field-goal bracket. This profile is intentionally cataloged separately: code
 * support alone must not let a league borrow evidence admitted under a merely similar profile.
 */
const ESPN_PPR_YARDAGE_BONUS_6PT_PASS_RULES: readonly ProjectionScoringProfile["rules"][number][] =
  [
    ...ESPN_STANDARD_2PT_NXM_RULES.filter(
      (rule) => !["passing_touchdowns", "field_goals_made_60_plus"].includes(rule.statId),
    ),
    { statId: "passing_touchdowns", points: 6 },
    { statId: "passing_yards_300_399_probability", points: 1 },
    { statId: "passing_yards_400_plus_probability", points: 3 },
    { statId: "rushing_yards_100_199_probability", points: 1 },
    { statId: "rushing_yards_200_plus_probability", points: 3 },
    { statId: "receptions", points: 1 },
    { statId: "receiving_yards_100_199_probability", points: 1 },
    { statId: "receiving_yards_200_plus_probability", points: 3 },
    { statId: "field_goals_made_60_plus", points: 6 },
  ];

const CATALOG: readonly RosScoringProfileEntry[] = [
  ...(["full-ppr", "half-ppr", "standard"] as const).map(buildLegacyEntry),
  finalizeEntry("espn-standard-2pt", ESPN_STANDARD_2PT_RULES),
  finalizeEntry("espn-standard-2pt-nxm", ESPN_STANDARD_2PT_NXM_RULES),
  finalizeEntry("espn-ppr-yardage-bonus-6pt-pass", ESPN_PPR_YARDAGE_BONUS_6PT_PASS_RULES),
];

const BY_KEY = new Map<string, RosScoringProfileEntry>(
  CATALOG.map((entry) => [entry.key, entry] as const),
);

export function rosScoringProfileCatalog(): readonly RosScoringProfileEntry[] {
  return CATALOG;
}

export function isRosScoringProfileKey(value: unknown): value is RosScoringProfileKey {
  return typeof value === "string" && BY_KEY.has(value);
}

/**
 * Resolves a named profile. Throws on an unknown key — there is deliberately no nearest-match or
 * default fallback, because a league must never receive a set scored under a merely similar profile.
 */
export function rosScoringProfile(key: RosScoringProfileKey): RosScoringProfileEntry {
  const entry = BY_KEY.get(key);
  if (!entry) {
    throw new RangeError(
      `Unknown ROS scoring profile: ${String(key)}. Known profiles: ${ROS_SCORING_PROFILE_KEYS.join(", ")}`,
    );
  }
  return entry;
}

/**
 * Stat components the first-party rest-of-season rail can actually produce. League scoring
 * normalization uses this to decide whether a league's rules map onto something the model emits.
 *
 * Composed from the same building blocks the worker uses, so the two cannot disagree about what is
 * available; `apps/worker/src/first-party-ros-scoring-profile-selection.test.ts` pins the equality.
 */
export function rosAvailableProjectionStatIds(): readonly string[] {
  return [
    ...new Set([
      ...ROS_SUPPORTED_POSITIONS.flatMap((position) =>
        firstPartyProjectionComponentsForPosition(position),
      ),
      "field_goals_made_50_plus",
      ...firstPartyTeamDefenseProjectionComponents(),
    ]),
  ].sort();
}
