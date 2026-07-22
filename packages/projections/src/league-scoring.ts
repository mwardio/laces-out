import type { ProjectionScoringBonus, ProjectionScoringProfile } from "./scoring.js";

export const LEAGUE_SCORING_NORMALIZATION_VERSION = "league-scoring-map-v1" as const;

export const LEAGUE_SCORING_MAP_PROVENANCE = {
  version: LEAGUE_SCORING_NORMALIZATION_VERSION,
  yahoo: {
    statCategoriesUrl: "https://football.fantasysports.yahoo.com/f1/details/stat_categories",
    helpUrl: "https://help.yahoo.com/kb/SLN6490.html",
    note: "Yahoo stat IDs are checked against exact Yahoo display-name aliases when both are present.",
  },
  espn: {
    scoringHelpUrl: "https://support.espn.com/hc/en-us/articles/360003914032-Scoring-Formats",
    note: "ESPN numeric IDs are undocumented transport identifiers and remain a versioned, fail-closed map.",
  },
} as const;

export type LeagueScoringProvider = "yahoo" | "espn";

export interface StoredLeagueScoringRule {
  readonly provider: string;
  /** Provider display name when known; persistence falls back to the provider ID. */
  readonly statKey: string;
  readonly providerStatId: string | null;
  readonly operation: string;
  readonly points: number | string;
  readonly thresholdLow?: number | string | null;
  readonly thresholdHigh?: number | string | null;
}

export interface NormalizeLeagueScoringInput {
  readonly id: string;
  readonly label?: string;
  readonly version?: string;
  readonly rows: readonly StoredLeagueScoringRule[];
  /** Exact canonical components emitted by this run; missing stats must never silently score zero. */
  readonly availableStatIds: ReadonlySet<string> | readonly string[];
}

export type LeagueScoringUnsupportedCode =
  | "EMPTY_RULES"
  | "INVALID_PROVIDER"
  | "MIXED_PROVIDERS"
  | "INVALID_RULE"
  | "UNSUPPORTED_OPERATION"
  | "NONLINEAR_RULE"
  | "POSITION_OVERRIDE"
  | "UNKNOWN_NONZERO_RULE"
  | "UNSUPPORTED_PLAYER_RULE"
  | "IDP_RULE"
  | "COMPONENT_UNAVAILABLE"
  | "CONFLICTING_RULE_IDENTITY"
  | "DUPLICATE_CANONICAL_RULE"
  | "DUPLICATE_BONUS_THRESHOLD"
  | "OVERLAPPING_AGGREGATE_RULES"
  | "NO_SUPPORTED_RULES";

export interface LeagueScoringUnsupportedReason {
  readonly code: LeagueScoringUnsupportedCode;
  readonly message: string;
  readonly rowIndex: number | null;
  readonly provider: string | null;
  readonly providerStatId: string | null;
  readonly statKey: string | null;
}

export type IgnoredLeagueScoringCategory =
  "zero-point" | "team-defense" | "individual-defense" | "other-position";

export interface IgnoredLeagueScoringRule {
  readonly rowIndex: number;
  readonly category: IgnoredLeagueScoringCategory;
  readonly reason: string;
  readonly rule: StoredLeagueScoringRule;
}

export type LeagueScoringWarningCode =
  | "IGNORED_ZERO_POINT_RULE"
  | "DEFENSE_RULES_SEPARATED"
  | "IDP_RULES_IGNORED"
  | "OTHER_POSITION_RULES_IGNORED"
  | "DISPLAY_NAME_FALLBACK";

export interface LeagueScoringWarning {
  readonly code: LeagueScoringWarningCode;
  readonly message: string;
}

interface LeagueScoringNormalizationBase {
  readonly provider: LeagueScoringProvider | null;
  readonly mappingVersion: typeof LEAGUE_SCORING_NORMALIZATION_VERSION;
  readonly warnings: readonly LeagueScoringWarning[];
  readonly ignoredRules: readonly IgnoredLeagueScoringRule[];
  readonly provenance: {
    readonly mappingVersion: typeof LEAGUE_SCORING_NORMALIZATION_VERSION;
    readonly inputRuleCount: number;
    readonly provider: LeagueScoringProvider | null;
  };
}

export type LeagueScoringNormalizationResult =
  | (LeagueScoringNormalizationBase & {
      readonly state: "available";
      readonly profile: ProjectionScoringProfile;
    })
  | (LeagueScoringNormalizationBase & {
      readonly state: "unavailable";
      readonly reasons: readonly LeagueScoringUnsupportedReason[];
    });

type PlayerMapping = { readonly kind: "player"; readonly statId: string };
type IgnoredMapping = {
  readonly kind: "ignored";
  readonly category: Exclude<IgnoredLeagueScoringCategory, "zero-point">;
  readonly reason: string;
};
type UnsupportedMapping = {
  readonly kind: "unsupported";
  readonly code: "UNSUPPORTED_PLAYER_RULE" | "IDP_RULE" | "NONLINEAR_RULE";
  readonly reason: string;
};
type Mapping = PlayerMapping | IgnoredMapping | UnsupportedMapping;

function player(statId: string): PlayerMapping {
  return { kind: "player", statId };
}

const OTHER_POSITION: IgnoredMapping = {
  kind: "ignored",
  category: "other-position",
  reason: "This scoring rule applies only to a separately modeled position.",
};
const NONLINEAR: UnsupportedMapping = {
  kind: "unsupported",
  code: "NONLINEAR_RULE",
  reason:
    "The provider category is nonlinear or thresholded and cannot be reconstructed from a projected total.",
};
const IDP_UNSUPPORTED: UnsupportedMapping = {
  kind: "unsupported",
  code: "IDP_RULE",
  reason:
    "The provider category applies to individual defensive players, which this projection profile cannot score safely.",
};
const UNSUPPORTED_DEFENSE: UnsupportedMapping = {
  kind: "unsupported",
  code: "UNSUPPORTED_PLAYER_RULE",
  reason: "The team-defense category has no matching projection component.",
};

/** Yahoo NFL transport IDs used by the league settings response. */
export const YAHOO_PLAYER_SCORING_STAT_ID_MAP_V1: Readonly<Record<string, string>> = {
  "1": "passing_attempts",
  "2": "passing_completions",
  "4": "passing_yards",
  "5": "passing_touchdowns",
  "6": "passing_interceptions",
  "8": "carries",
  "9": "rushing_yards",
  "10": "rushing_touchdowns",
  "11": "receptions",
  "12": "receiving_yards",
  "13": "receiving_touchdowns",
  "14": "return_yards",
  "15": "special_teams_touchdowns",
  "16": "two_point_conversions",
  "17": "fumbles",
  "18": "fumbles_lost",
  "19": "field_goals_made_0_19",
  "20": "field_goals_made_20_29",
  "21": "field_goals_made_30_39",
  "22": "field_goals_made_40_49",
  "23": "field_goals_made_50_plus",
  "24": "field_goals_missed",
  "29": "extra_points_made",
  "30": "extra_points_missed",
  "31": "points_allowed",
  "32": "defensive_sacks",
  "33": "defensive_interceptions",
  "34": "defensive_fumble_recoveries",
  "35": "defensive_touchdowns",
  "36": "defensive_safeties",
  "37": "defensive_blocked_kicks",
  "49": "special_teams_touchdowns",
  "50": "points_allowed_0_probability",
  "51": "points_allowed_1_6_probability",
  "52": "points_allowed_7_13_probability",
  "53": "points_allowed_14_20_probability",
  "54": "points_allowed_21_27_probability",
  "55": "points_allowed_28_34_probability",
  "56": "points_allowed_35_plus_probability",
  "57": "fumble_recovery_touchdowns",
};

const YAHOO_IDP_STAT_IDS = new Set([
  "38",
  "39",
  "40",
  "41",
  "42",
  "43",
  "44",
  "45",
  "46",
  "47",
  "48",
]);
const YAHOO_YARDS_ALLOWED_BUCKET_IDS = new Set([
  "70",
  "71",
  "72",
  "73",
  "74",
  "75",
  "76",
  "77",
  "78",
  "79",
  "80",
  "81",
]);

/** Direct, per-unit ESPN scoring IDs only. Bucket and per-N IDs are intentionally excluded. */
export const ESPN_PLAYER_SCORING_STAT_ID_MAP_V1: Readonly<Record<string, string>> = {
  "0": "passing_attempts",
  "1": "passing_completions",
  "3": "passing_yards",
  "4": "passing_touchdowns",
  "19": "passing_two_point_conversions",
  "20": "passing_interceptions",
  "23": "carries",
  "24": "rushing_yards",
  "25": "rushing_touchdowns",
  "26": "rushing_two_point_conversions",
  "41": "receptions",
  "42": "receiving_yards",
  "43": "receiving_touchdowns",
  "44": "receiving_two_point_conversions",
  "53": "receptions",
  "58": "targets",
  "62": "two_point_conversions",
  "63": "fumble_recovery_touchdowns",
  "64": "sacks_suffered",
  "65": "passing_fumbles",
  "66": "rushing_fumbles",
  "67": "receiving_fumbles",
  "68": "fumbles",
  "69": "passing_fumbles_lost",
  "70": "rushing_fumbles_lost",
  "71": "receiving_fumbles_lost",
  "72": "fumbles_lost",
  "73": "turnovers",
  "74": "field_goals_made_50_plus",
  "75": "field_goals_attempted_50_plus",
  "76": "field_goals_missed_50_plus",
  "77": "field_goals_made_40_49",
  "78": "field_goals_attempted_40_49",
  "79": "field_goals_missed_40_49",
  "80": "field_goals_made_0_39",
  "81": "field_goals_attempted_0_39",
  "82": "field_goals_missed_0_39",
  "83": "field_goals_made",
  "84": "field_goals_attempted",
  "85": "field_goals_missed",
  "86": "extra_points_made",
  "87": "extra_points_attempted",
  "88": "extra_points_missed",
  "89": "points_allowed_0_probability",
  "90": "points_allowed_1_6_probability",
  "91": "points_allowed_7_13_probability",
  "92": "points_allowed_14_17_probability",
  "93": "special_teams_touchdowns",
  "94": "defensive_touchdowns",
  "95": "defensive_interceptions",
  "96": "defensive_fumble_recoveries",
  "97": "defensive_blocked_kicks",
  "98": "defensive_safeties",
  "99": "defensive_sacks",
  "101": "special_teams_touchdowns",
  "102": "special_teams_touchdowns",
  "103": "defensive_touchdowns",
  "104": "defensive_touchdowns",
  "105": "return_touchdowns",
  "114": "kickoff_return_yards",
  "115": "punt_return_yards",
  "120": "points_allowed",
  "121": "points_allowed_18_21_probability",
  "122": "points_allowed_22_27_probability",
  "123": "points_allowed_28_34_probability",
  "124": "points_allowed_35_45_probability",
  "125": "points_allowed_46_plus_probability",
  "127": "yards_allowed",
  "187": "points_allowed",
  "188": "points_allowed_0_probability",
  "189": "points_allowed_1_6_probability",
  "190": "points_allowed_7_13_probability",
  "191": "points_allowed_14_17_probability",
  "192": "points_allowed_18_21_probability",
  "193": "points_allowed_22_27_probability",
  "194": "points_allowed_28_34_probability",
  "195": "points_allowed_35_45_probability",
  "196": "points_allowed_46_plus_probability",
  "198": "field_goals_made_50_59",
  "199": "field_goals_attempted_50_59",
  "200": "field_goals_missed_50_59",
  "201": "field_goals_made_60_plus",
  "202": "field_goals_attempted_60_plus",
  "203": "field_goals_missed_60_plus",
  "211": "passing_first_downs",
  "212": "rushing_first_downs",
  "213": "receiving_first_downs",
};

const TEAM_DEFENSE_SCORING_COMPONENTS = new Set([
  "defensive_sacks",
  "defensive_interceptions",
  "defensive_fumble_recoveries",
  "defensive_safeties",
  "defensive_touchdowns",
  "defensive_blocked_kicks",
  "special_teams_touchdowns",
  "points_allowed",
  "yards_allowed",
  "points_allowed_0_probability",
  "points_allowed_1_6_probability",
  "points_allowed_7_13_probability",
  "points_allowed_14_17_probability",
  "points_allowed_18_21_probability",
  "points_allowed_22_27_probability",
  "points_allowed_28_34_probability",
  "points_allowed_35_45_probability",
  "points_allowed_46_plus_probability",
]);

const ESPN_NONLINEAR_STAT_IDS = new Set([
  "2",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "11",
  "12",
  "13",
  "14",
  "15",
  "16",
  "17",
  "18",
  "21",
  "22",
  "27",
  "28",
  "29",
  "30",
  "31",
  "32",
  "33",
  "34",
  "35",
  "36",
  "37",
  "38",
  "39",
  "40",
  "45",
  "46",
  "47",
  "48",
  "49",
  "50",
  "51",
  "52",
  "54",
  "55",
  "56",
  "57",
  "59",
  "60",
  "61",
  "100",
  "116",
  "117",
  "118",
  "119",
  "126",
  "128",
  "129",
  "130",
  "131",
  "132",
  "133",
  "134",
  "135",
  "136",
  "137",
  "175",
  "176",
  "177",
  "178",
  "179",
  "180",
  "181",
  "182",
  "183",
  "184",
  "185",
  "186",
  "197",
  "210",
  "214",
  "215",
  "216",
  "217",
]);

const ESPN_IGNORED_STAT_IDS = new Map<string, IgnoredMapping>([
  ...Array.from({ length: 37 }, (_, index) => String(index + 138)).map(
    (id): [string, IgnoredMapping] => [id, OTHER_POSITION],
  ),
]);
const ESPN_IDP_STAT_IDS = new Set(["106", "107", "108", "109", "110", "111", "112", "113"]);
const ESPN_UNSUPPORTED_DEFENSE_STAT_IDS = new Set(["204", "205", "206", "207", "208", "209"]);

function normalizeName(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/&/gu, " and ")
    .replace(/[^a-z0-9]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

/** Exact normalized display-name aliases shared by Yahoo and recovery imports. */
export const PLAYER_SCORING_DISPLAY_NAME_MAP_V1: Readonly<Record<string, string>> = {
  "passing attempts": "passing_attempts",
  "pass attempts": "passing_attempts",
  "each pass attempted": "passing_attempts",
  completions: "passing_completions",
  "pass completions": "passing_completions",
  "each pass completed": "passing_completions",
  "passing yards": "passing_yards",
  "pass yds": "passing_yards",
  "passing touchdowns": "passing_touchdowns",
  "passing touchdown": "passing_touchdowns",
  "td pass": "passing_touchdowns",
  "pass td": "passing_touchdowns",
  "interceptions thrown": "passing_interceptions",
  "times sacked": "sacks_suffered",
  "rushing attempts": "carries",
  "rush attempts": "carries",
  "rushing yards": "rushing_yards",
  "rush yds": "rushing_yards",
  "rushing touchdowns": "rushing_touchdowns",
  "rushing touchdown": "rushing_touchdowns",
  "rush td": "rushing_touchdowns",
  receptions: "receptions",
  reception: "receptions",
  "each reception": "receptions",
  "receiving targets": "targets",
  targets: "targets",
  "receiving yards": "receiving_yards",
  "rec yds": "receiving_yards",
  "receiving touchdowns": "receiving_touchdowns",
  "receiving touchdown": "receiving_touchdowns",
  "rec td": "receiving_touchdowns",
  "2 point conversion": "two_point_conversions",
  "2 point conversions": "two_point_conversions",
  "two point conversion": "two_point_conversions",
  "two point conversions": "two_point_conversions",
  fumble: "fumbles",
  fumbles: "fumbles",
  "fumble lost": "fumbles_lost",
  "fumbles lost": "fumbles_lost",
  "offensive fumble return touchdowns": "fumble_recovery_touchdowns",
  "offensive fumble return touchdown": "fumble_recovery_touchdowns",
  "field goal 0 19 yards": "field_goals_made_0_19",
  "field goals 0 19 yards": "field_goals_made_0_19",
  "field goal 20 29 yards": "field_goals_made_20_29",
  "field goals 20 29 yards": "field_goals_made_20_29",
  "field goal 30 39 yards": "field_goals_made_30_39",
  "field goals 30 39 yards": "field_goals_made_30_39",
  "field goal 40 49 yards": "field_goals_made_40_49",
  "field goals 40 49 yards": "field_goals_made_40_49",
  "field goal 50 yards": "field_goals_made_50_plus",
  "field goals 50 yards": "field_goals_made_50_plus",
  "field goal missed": "field_goals_missed",
  "field goals missed": "field_goals_missed",
  "point after attempt made": "extra_points_made",
  "pat made": "extra_points_made",
  "point after attempt missed": "extra_points_missed",
  "pat missed": "extra_points_missed",
  "points allowed": "points_allowed",
  "0 points allowed": "points_allowed_0_probability",
  "1 6 points allowed": "points_allowed_1_6_probability",
  "7 13 points allowed": "points_allowed_7_13_probability",
  "14 17 points allowed": "points_allowed_14_17_probability",
  "14 20 points allowed": "points_allowed_14_20_probability",
  "18 21 points allowed": "points_allowed_18_21_probability",
  "21 27 points allowed": "points_allowed_21_27_probability",
  "22 27 points allowed": "points_allowed_22_27_probability",
  "28 34 points allowed": "points_allowed_28_34_probability",
  "35 points allowed": "points_allowed_35_plus_probability",
  "35 45 points allowed": "points_allowed_35_45_probability",
  "46 points allowed": "points_allowed_46_plus_probability",
  "sacks recorded": "defensive_sacks",
  "interceptions made": "defensive_interceptions",
  "fumbles recovered": "defensive_fumble_recoveries",
  safeties: "defensive_safeties",
  "blocked kicks": "defensive_blocked_kicks",
  "defensive touchdowns": "defensive_touchdowns",
  "kickoff and punt return touchdowns": "special_teams_touchdowns",
  "defensive yards allowed": "yards_allowed",
  "yards allowed": "yards_allowed",
};

const IGNORED_DISPLAY_NAMES = new Map<string, IgnoredMapping>([
  ...["punts", "punt yards", "head coach wins"].map((name): [string, IgnoredMapping] => [
    name,
    OTHER_POSITION,
  ]),
]);

const IDP_DISPLAY_NAMES = new Set([
  "solo tackles",
  "assisted tackles",
  "passes defended",
  "fumbles forced",
  "tackles for loss",
]);

const UNSUPPORTED_DISPLAY_NAMES = new Set([
  "incomplete passes",
  "passing completion pct",
  "passing yards per game",
  "rushing yards per attempt",
  "rushing yards per game",
  "receiving yards per catch",
  "receiving yards per game",
  "passing pick six",
  "passing 40 yd cmp",
  "passing 40 yd td",
  "receiving 40 yd rec",
  "receiving 40 yd td",
  "rushing 40 yd att",
  "4th down stops",
  "3 and outs forced",
]);

export const NFLVERSE_PROJECTION_SCORING_COMPONENTS_V1 = new Set([
  ...Object.values(YAHOO_PLAYER_SCORING_STAT_ID_MAP_V1),
  ...Object.values(ESPN_PLAYER_SCORING_STAT_ID_MAP_V1),
]);

const AGGREGATE_OVERLAPS: ReadonlyArray<{
  readonly aggregate: string;
  readonly parts: readonly string[];
}> = [
  {
    aggregate: "two_point_conversions",
    parts: [
      "passing_two_point_conversions",
      "rushing_two_point_conversions",
      "receiving_two_point_conversions",
    ],
  },
  {
    aggregate: "fumbles",
    parts: ["passing_fumbles", "rushing_fumbles", "receiving_fumbles"],
  },
  {
    aggregate: "fumbles_lost",
    parts: ["passing_fumbles_lost", "rushing_fumbles_lost", "receiving_fumbles_lost"],
  },
  {
    aggregate: "turnovers",
    parts: ["passing_interceptions", "fumbles_lost"],
  },
  {
    aggregate: "return_yards",
    parts: ["kickoff_return_yards", "punt_return_yards"],
  },
  {
    aggregate: "field_goals_made",
    parts: [
      "field_goals_made_0_19",
      "field_goals_made_20_29",
      "field_goals_made_30_39",
      "field_goals_made_40_49",
      "field_goals_made_50_plus",
      "field_goals_made_50_59",
      "field_goals_made_60_plus",
      "field_goals_made_0_39",
    ],
  },
  {
    aggregate: "field_goals_made_0_39",
    parts: ["field_goals_made_0_19", "field_goals_made_20_29", "field_goals_made_30_39"],
  },
  {
    aggregate: "field_goals_made_50_plus",
    parts: ["field_goals_made_50_59", "field_goals_made_60_plus"],
  },
  {
    aggregate: "return_touchdowns",
    parts: ["defensive_touchdowns", "special_teams_touchdowns"],
  },
  {
    aggregate: "points_allowed",
    parts: [
      "points_allowed_0_probability",
      "points_allowed_1_6_probability",
      "points_allowed_7_13_probability",
      "points_allowed_14_17_probability",
      "points_allowed_14_20_probability",
      "points_allowed_18_21_probability",
      "points_allowed_21_27_probability",
      "points_allowed_22_27_probability",
      "points_allowed_28_34_probability",
      "points_allowed_35_plus_probability",
      "points_allowed_35_45_probability",
      "points_allowed_46_plus_probability",
    ],
  },
];

function decimal(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const normalized = value.trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/u.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function ruleIdentity(row: StoredLeagueScoringRule): string {
  return row.providerStatId?.trim() || row.statKey.trim() || "unknown";
}

function reason(
  code: LeagueScoringUnsupportedCode,
  message: string,
  rowIndex: number | null,
  row?: StoredLeagueScoringRule,
): LeagueScoringUnsupportedReason {
  return {
    code,
    message,
    rowIndex,
    provider: row?.provider ?? null,
    providerStatId: row?.providerStatId ?? null,
    statKey: row?.statKey ?? null,
  };
}

function mappingFromName(statKey: string): Mapping | null {
  const normalized = normalizeName(statKey);
  const playerStatId = PLAYER_SCORING_DISPLAY_NAME_MAP_V1[normalized];
  if (playerStatId) return player(playerStatId);
  const ignored = IGNORED_DISPLAY_NAMES.get(normalized);
  if (ignored) return ignored;
  if (IDP_DISPLAY_NAMES.has(normalized)) return IDP_UNSUPPORTED;
  if (UNSUPPORTED_DISPLAY_NAMES.has(normalized)) return NONLINEAR;
  return null;
}

function mappingFromProviderId(
  provider: LeagueScoringProvider,
  providerStatId: string,
): Mapping | null {
  const normalized = providerStatId.trim();
  if (provider === "yahoo") {
    const playerStatId = YAHOO_PLAYER_SCORING_STAT_ID_MAP_V1[normalized];
    if (playerStatId) return player(playerStatId);
    if (YAHOO_IDP_STAT_IDS.has(normalized)) return IDP_UNSUPPORTED;
    if (YAHOO_YARDS_ALLOWED_BUCKET_IDS.has(normalized)) return NONLINEAR;
    return null;
  }
  const playerStatId = ESPN_PLAYER_SCORING_STAT_ID_MAP_V1[normalized];
  if (playerStatId) return player(playerStatId);
  if (ESPN_NONLINEAR_STAT_IDS.has(normalized)) return NONLINEAR;
  if (ESPN_IDP_STAT_IDS.has(normalized)) return IDP_UNSUPPORTED;
  if (ESPN_UNSUPPORTED_DEFENSE_STAT_IDS.has(normalized)) return UNSUPPORTED_DEFENSE;
  return ESPN_IGNORED_STAT_IDS.get(normalized) ?? null;
}

function sameMapping(left: Mapping, right: Mapping): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "player" && right.kind === "player") return left.statId === right.statId;
  if (left.kind === "ignored" && right.kind === "ignored") {
    return left.category === right.category;
  }
  return left.kind === "unsupported" && right.kind === "unsupported" && left.code === right.code;
}

function positionOverride(row: StoredLeagueScoringRule): {
  readonly ignored?: IgnoredMapping;
  readonly unsupported: boolean;
  readonly baseProviderStatId?: string;
} | null {
  const providerId = row.providerStatId?.trim() ?? "";
  const match = /^(\d+):slot:(\d+)$/u.exec(providerId);
  if (match) {
    const baseProviderStatId = match[1];
    const slotId = match[2];
    const baseComponent = baseProviderStatId
      ? ESPN_PLAYER_SCORING_STAT_ID_MAP_V1[baseProviderStatId]
      : undefined;
    if (
      row.provider.trim().toLowerCase() === "espn" &&
      slotId === "16" &&
      baseProviderStatId !== undefined &&
      baseComponent &&
      TEAM_DEFENSE_SCORING_COMPONENTS.has(baseComponent)
    ) {
      return { unsupported: false, baseProviderStatId };
    }
    return { unsupported: true };
  }
  const name = normalizeName(row.statKey);
  if (/\btight end\b|\bte premium\b|\boverride for te\b/u.test(name)) {
    return { unsupported: true };
  }
  return null;
}

function warningForCategory(category: IgnoredLeagueScoringCategory): LeagueScoringWarning {
  if (category === "zero-point") {
    return {
      code: "IGNORED_ZERO_POINT_RULE",
      message: "Zero-point rules were retained as ignored provenance and do not affect scoring.",
    };
  }
  if (category === "team-defense") {
    return {
      code: "DEFENSE_RULES_SEPARATED",
      message: "Team D/ST rules were separated for the dedicated defense projection profile.",
    };
  }
  if (category === "individual-defense") {
    return {
      code: "IDP_RULES_IGNORED",
      message: "IDP-only rules were excluded from the offensive-player projection profile.",
    };
  }
  return {
    code: "OTHER_POSITION_RULES_IGNORED",
    message: "Rules for separately modeled positions were excluded from this projection profile.",
  };
}

function addWarning(warnings: LeagueScoringWarning[], warning: LeagueScoringWarning): void {
  if (!warnings.some((candidate) => candidate.code === warning.code)) warnings.push(warning);
}

interface MutableCanonicalRule {
  points: number | null;
  bonuses: ProjectionScoringBonus[];
  rowIndices: number[];
}

export function normalizeLeagueScoringProfile(
  input: NormalizeLeagueScoringInput,
): LeagueScoringNormalizationResult {
  const reasons: LeagueScoringUnsupportedReason[] = [];
  const warnings: LeagueScoringWarning[] = [];
  const ignoredRules: IgnoredLeagueScoringRule[] = [];
  const providers = new Set<LeagueScoringProvider>();

  if (input.id.trim() === "") {
    reasons.push(reason("INVALID_RULE", "Scoring profile ID must not be empty.", null));
  }
  if (input.rows.length === 0) {
    reasons.push(reason("EMPTY_RULES", "No stored league scoring rules were available.", null));
  }
  for (const [rowIndex, row] of input.rows.entries()) {
    const provider = row.provider.trim().toLowerCase();
    if (provider !== "yahoo" && provider !== "espn") {
      reasons.push(
        reason(
          "INVALID_PROVIDER",
          `Rule ${rowIndex} has unsupported provider ${row.provider || "(empty)"}.`,
          rowIndex,
          row,
        ),
      );
      continue;
    }
    providers.add(provider);
  }
  if (providers.size > 1) {
    reasons.push(
      reason(
        "MIXED_PROVIDERS",
        "A scoring profile cannot combine Yahoo and ESPN rule identities.",
        null,
      ),
    );
  }
  const provider = providers.size === 1 ? ([...providers][0] ?? null) : null;
  const available = new Set(input.availableStatIds);
  const canonical = new Map<string, MutableCanonicalRule>();

  if (provider !== null && reasons.every((item) => item.code !== "MIXED_PROVIDERS")) {
    for (const [rowIndex, row] of input.rows.entries()) {
      if (row.provider.trim().toLowerCase() !== provider) continue;
      const points = decimal(row.points);
      if (points === null) {
        reasons.push(
          reason(
            "INVALID_RULE",
            `Rule ${rowIndex} (${ruleIdentity(row)}) has invalid points.`,
            rowIndex,
            row,
          ),
        );
        continue;
      }
      if (points === 0) {
        ignoredRules.push({
          rowIndex,
          category: "zero-point",
          reason: "The rule awards zero points.",
          rule: row,
        });
        addWarning(warnings, warningForCategory("zero-point"));
        continue;
      }

      const override = positionOverride(row);
      if (override?.unsupported) {
        reasons.push(
          reason(
            "POSITION_OVERRIDE",
            `Rule ${rowIndex} (${ruleIdentity(row)}) has a position-specific override or TE premium.`,
            rowIndex,
            row,
          ),
        );
        continue;
      }
      if (override?.ignored) {
        ignoredRules.push({
          rowIndex,
          category: override.ignored.category,
          reason: override.ignored.reason,
          rule: row,
        });
        addWarning(warnings, warningForCategory(override.ignored.category));
        continue;
      }

      const providerMapping = row.providerStatId
        ? mappingFromProviderId(provider, override?.baseProviderStatId ?? row.providerStatId)
        : null;
      const nameMapping = mappingFromName(row.statKey);
      if (providerMapping && nameMapping && !sameMapping(providerMapping, nameMapping)) {
        reasons.push(
          reason(
            "CONFLICTING_RULE_IDENTITY",
            `Rule ${rowIndex} provider ID and display name resolve to different scoring categories.`,
            rowIndex,
            row,
          ),
        );
        continue;
      }
      const mapping = providerMapping ?? nameMapping;
      if (!mapping) {
        reasons.push(
          reason(
            "UNKNOWN_NONZERO_RULE",
            `Rule ${rowIndex} (${ruleIdentity(row)}) is a nonzero scoring rule with no exact ${provider} mapping.`,
            rowIndex,
            row,
          ),
        );
        continue;
      }
      if (!providerMapping && nameMapping && row.providerStatId?.trim()) {
        addWarning(warnings, {
          code: "DISPLAY_NAME_FALLBACK",
          message:
            "At least one unknown provider ID was resolved by an exact provider display name.",
        });
      }
      if (mapping.kind === "ignored") {
        ignoredRules.push({
          rowIndex,
          category: mapping.category,
          reason: mapping.reason,
          rule: row,
        });
        addWarning(warnings, warningForCategory(mapping.category));
        continue;
      }
      if (mapping.kind === "unsupported") {
        reasons.push(
          reason(
            mapping.code,
            `Rule ${rowIndex} (${ruleIdentity(row)}) is ${mapping.reason}`,
            rowIndex,
            row,
          ),
        );
        continue;
      }
      if (!available.has(mapping.statId)) {
        reasons.push(
          reason(
            "COMPONENT_UNAVAILABLE",
            `Rule ${rowIndex} requires projection component ${mapping.statId}, which this run does not provide.`,
            rowIndex,
            row,
          ),
        );
        continue;
      }

      const operation = normalizeName(row.operation).replace(/ /gu, "-");
      const thresholdLow = decimal(row.thresholdLow);
      const thresholdHigh = decimal(row.thresholdHigh);
      const hasLow =
        row.thresholdLow !== null && row.thresholdLow !== undefined && row.thresholdLow !== "";
      const hasHigh =
        row.thresholdHigh !== null && row.thresholdHigh !== undefined && row.thresholdHigh !== "";
      if ((hasLow && thresholdLow === null) || (hasHigh && thresholdHigh === null)) {
        reasons.push(
          reason(
            "INVALID_RULE",
            `Rule ${rowIndex} (${ruleIdentity(row)}) has an invalid threshold.`,
            rowIndex,
            row,
          ),
        );
        continue;
      }

      const entry = canonical.get(mapping.statId) ?? {
        points: null,
        bonuses: [],
        rowIndices: [],
      };
      if (operation === "multiply") {
        if (hasLow || hasHigh) {
          reasons.push(
            reason(
              "NONLINEAR_RULE",
              `Rule ${rowIndex} (${ruleIdentity(row)}) applies thresholds to a per-unit rule.`,
              rowIndex,
              row,
            ),
          );
          continue;
        }
        if (entry.points !== null) {
          if (entry.points === points) {
            entry.rowIndices.push(rowIndex);
            canonical.set(mapping.statId, entry);
            continue;
          }
          reasons.push(
            reason(
              "DUPLICATE_CANONICAL_RULE",
              `Rules ${entry.rowIndices.join(", ")} and ${rowIndex} both score ${mapping.statId}.`,
              rowIndex,
              row,
            ),
          );
          continue;
        }
        entry.points = points;
      } else if (operation === "bonus" || operation === "at-least-bonus") {
        reasons.push(
          reason(
            "NONLINEAR_RULE",
            `Rule ${rowIndex} (${ruleIdentity(row)}) is a threshold bonus; expected bonus points require a projected threshold probability.`,
            rowIndex,
            row,
          ),
        );
        continue;
      } else {
        reasons.push(
          reason(
            "UNSUPPORTED_OPERATION",
            `Rule ${rowIndex} (${ruleIdentity(row)}) uses unsupported operation ${row.operation}.`,
            rowIndex,
            row,
          ),
        );
        continue;
      }
      entry.rowIndices.push(rowIndex);
      canonical.set(mapping.statId, entry);
    }
  }

  for (const overlap of AGGREGATE_OVERLAPS) {
    if (!canonical.has(overlap.aggregate)) continue;
    const presentParts = overlap.parts.filter((part) => canonical.has(part));
    if (presentParts.length === 0) continue;
    reasons.push(
      reason(
        "OVERLAPPING_AGGREGATE_RULES",
        `${overlap.aggregate} overlaps with ${presentParts.join(", ")}; applying both would double count.`,
        null,
      ),
    );
  }

  const profileRules = [...canonical.entries()]
    .filter(([, rule]) => rule.points !== null || rule.bonuses.length > 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([statId, rule]) => ({
      statId,
      points: rule.points ?? 0,
      ...(rule.bonuses.length === 0
        ? {}
        : {
            bonuses: [...rule.bonuses].sort(
              (left, right) => left.atLeast - right.atLeast || left.points - right.points,
            ),
          }),
    }));
  if (input.rows.length > 0 && profileRules.length === 0 && reasons.length === 0) {
    reasons.push(
      reason(
        "NO_SUPPORTED_RULES",
        "No nonzero QB/RB/WR/TE/K or team D/ST scoring rules remained after normalization.",
        null,
      ),
    );
  }

  const base: LeagueScoringNormalizationBase = {
    provider,
    mappingVersion: LEAGUE_SCORING_NORMALIZATION_VERSION,
    warnings,
    ignoredRules,
    provenance: {
      mappingVersion: LEAGUE_SCORING_NORMALIZATION_VERSION,
      inputRuleCount: input.rows.length,
      provider,
    },
  };
  if (reasons.length > 0) return { state: "unavailable", reasons, ...base };
  return {
    state: "available",
    profile: {
      id: input.id,
      ...(input.label === undefined ? {} : { label: input.label }),
      version: input.version ?? LEAGUE_SCORING_NORMALIZATION_VERSION,
      rules: profileRules,
    },
    ...base,
  };
}
