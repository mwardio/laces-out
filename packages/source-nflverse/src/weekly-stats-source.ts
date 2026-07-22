import { parse } from "csv-parse/sync";

import {
  NFLVERSE_DATA_LICENSE,
  NFLVERSE_DATA_REPOSITORY_URL,
  NflverseDatasetSourceError,
  assertAdmissionQuality,
  assertNflverseSeason,
  checkNflverseCsvRelease,
  type NflverseDatasetState,
  type NflverseFetchLike,
} from "./release-source.js";

export const NFLVERSE_WEEKLY_STATS_SOURCE_KEY = "nflverse.stats-player-week" as const;
export const NFLVERSE_WEEKLY_STATS_ATTRIBUTION =
  "Weekly player stats provided by nflverse (CC BY 4.0)" as const;
export const NFLVERSE_WEEKLY_STATS_ATTRIBUTION_URL = NFLVERSE_DATA_REPOSITORY_URL;

const MAX_RESPONSE_BYTES = 24 * 1024 * 1024;
const MAX_ROWS = 25_000;
const ABSOLUTE_REJECTION_ALLOWANCE = 25;
const MAXIMUM_REJECTION_RATIO = 0.02;

export type NflverseSeasonType = "REG" | "POST";

export interface NflverseWeeklyStatComponents {
  readonly passing_completions: number;
  readonly passing_attempts: number;
  readonly passing_yards: number;
  readonly passing_touchdowns: number;
  readonly passing_interceptions: number;
  readonly passing_two_point_conversions: number;
  readonly passing_first_downs: number;
  readonly sacks_suffered: number;
  readonly sack_yards_lost: number;
  readonly sack_fumbles_lost: number;
  readonly carries: number;
  readonly rushing_yards: number;
  readonly rushing_touchdowns: number;
  readonly rushing_fumbles: number;
  readonly rushing_fumbles_lost: number;
  readonly rushing_two_point_conversions: number;
  readonly rushing_first_downs: number;
  readonly receptions: number;
  readonly targets: number;
  readonly receiving_yards: number;
  readonly receiving_touchdowns: number;
  readonly receiving_fumbles: number;
  readonly receiving_fumbles_lost: number;
  /** Includes sack, rushing, receiving, return, and miscellaneous fumbles lost. */
  readonly fumbles_lost_total: number;
  readonly receiving_two_point_conversions: number;
  readonly receiving_first_downs: number;
  readonly special_teams_touchdowns: number;
  readonly fumble_recovery_touchdowns: number;
  readonly punt_return_yards: number;
  readonly kickoff_return_yards: number;
  readonly field_goals_made: number;
  readonly field_goals_attempted: number;
  readonly field_goals_missed: number;
  readonly field_goals_made_0_19: number;
  readonly field_goals_made_20_29: number;
  readonly field_goals_made_30_39: number;
  readonly field_goals_made_40_49: number;
  readonly field_goals_made_50_59: number;
  readonly field_goals_made_60_plus: number;
  readonly extra_points_made: number;
  readonly extra_points_attempted: number;
  readonly extra_points_missed: number;
}

export interface NflverseWeeklyAdvancedStats {
  readonly passingAirYards: number;
  readonly passingYardsAfterCatch: number;
  readonly passingEpa: number;
  readonly passingCpoe: number | null;
  readonly pacr: number | null;
  readonly rushingEpa: number;
  readonly receivingAirYards: number;
  readonly receivingYardsAfterCatch: number;
  readonly receivingEpa: number;
  readonly targetShare: number | null;
  readonly airYardsShare: number | null;
  readonly wopr: number | null;
}

export interface NflversePlayerWeeklyStats {
  readonly gsisId: string;
  readonly playerName: string;
  readonly displayName: string;
  readonly position: string;
  readonly positionGroup: string | null;
  readonly season: number;
  readonly week: number;
  readonly seasonType: NflverseSeasonType;
  readonly gameId: string;
  readonly team: string;
  readonly opponentTeam: string;
  readonly components: NflverseWeeklyStatComponents;
  readonly advanced: NflverseWeeklyAdvancedStats;
  /** Upstream reference totals; league scoring should be recomputed from components. */
  readonly sourceFantasyPoints: {
    readonly standard: number;
    readonly ppr: number;
  };
}

export interface NflverseWeeklyStatsRejections {
  readonly invalidIdentity: number;
  readonly invalidContext: number;
  readonly invalidStats: number;
  readonly duplicate: number;
}

interface NflverseWeeklyStatsBaseResult {
  readonly checkedAt: string;
  readonly sourceKey: typeof NFLVERSE_WEEKLY_STATS_SOURCE_KEY;
  readonly sourceUrl: string;
  readonly attribution: typeof NFLVERSE_WEEKLY_STATS_ATTRIBUTION;
  readonly attributionUrl: typeof NFLVERSE_WEEKLY_STATS_ATTRIBUTION_URL;
  readonly license: typeof NFLVERSE_DATA_LICENSE;
  readonly season: number;
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly checksumSha256: string | null;
}

export type NflverseWeeklyStatsCheckResult =
  | (NflverseWeeklyStatsBaseResult & {
      readonly state: "changed";
      readonly checksumSha256: string;
      readonly observations: readonly NflversePlayerWeeklyStats[];
      readonly rowsRead: number;
      readonly rowsRejected: number;
      readonly rejections: NflverseWeeklyStatsRejections;
      readonly coveredWeeks: readonly number[];
      readonly coveredSeasonTypes: readonly NflverseSeasonType[];
    })
  | (NflverseWeeklyStatsBaseResult & { readonly state: "unchanged" });

export function buildNflverseWeeklyStatsUrl(season: number): string {
  assertNflverseSeason(season, 1999);
  return `https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_${season}.csv`;
}

function nullableString(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maximum ? normalized : null;
}

function boundedNumber(
  value: unknown,
  minimum: number,
  maximum: number,
  integer = false,
): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) return null;
  return integer && !Number.isInteger(parsed) ? null : Object.is(parsed, -0) ? 0 : parsed;
}

function optionalNumber(value: unknown, minimum: number, maximum: number): number | null {
  if (typeof value === "string" && value.trim() === "") return null;
  return boundedNumber(value, minimum, maximum);
}

function team(value: unknown): string | null {
  const normalized = nullableString(value, 4)?.toUpperCase();
  return normalized && /^[A-Z]{2,4}$/u.test(normalized) ? normalized : null;
}

function position(value: unknown): string | null {
  const normalized = nullableString(value, 12)?.toUpperCase();
  return normalized && /^[A-Z0-9/+.-]{1,12}$/u.test(normalized) ? normalized : null;
}

function parseCsv(body: string): Record<string, string>[] {
  let rows: Record<string, string>[];
  try {
    rows = parse(body, {
      bom: true,
      columns: true,
      skip_empty_lines: true,
      relax_column_count: false,
      max_record_size: 256 * 1024,
    });
  } catch {
    throw new NflverseDatasetSourceError("INVALID_CSV", "nflverse weekly stats are malformed CSV");
  }
  if (rows.length === 0 || rows.length > MAX_ROWS) {
    throw new NflverseDatasetSourceError(
      "INVALID_CSV",
      "nflverse weekly stats row count is invalid",
    );
  }
  const headers = new Set(Object.keys(rows[0] ?? {}));
  for (const required of REQUIRED_COLUMNS) {
    if (!headers.has(required)) {
      throw new NflverseDatasetSourceError(
        "INVALID_CSV",
        `nflverse weekly stats omitted required column ${required}`,
      );
    }
  }
  return rows;
}

const REQUIRED_COLUMNS = [
  "player_id",
  "player_name",
  "player_display_name",
  "position",
  "season",
  "week",
  "season_type",
  "game_id",
  "team",
  "opponent_team",
  "completions",
  "attempts",
  "passing_yards",
  "passing_tds",
  "passing_interceptions",
  "sacks_suffered",
  "sack_yards_lost",
  "sack_fumbles_lost",
  "passing_air_yards",
  "passing_yards_after_catch",
  "passing_first_downs",
  "passing_epa",
  "passing_2pt_conversions",
  "carries",
  "rushing_yards",
  "rushing_tds",
  "rushing_fumbles",
  "rushing_fumbles_lost",
  "rushing_first_downs",
  "rushing_epa",
  "rushing_2pt_conversions",
  "receptions",
  "targets",
  "receiving_yards",
  "receiving_tds",
  "receiving_fumbles",
  "receiving_fumbles_lost",
  "fumbles_lost_total",
  "receiving_air_yards",
  "receiving_yards_after_catch",
  "receiving_first_downs",
  "receiving_epa",
  "receiving_2pt_conversions",
  "special_teams_tds",
  "fumble_recovery_tds",
  "punt_return_yards",
  "kickoff_return_yards",
  "fg_made",
  "fg_att",
  "fg_missed",
  "fg_made_0_19",
  "fg_made_20_29",
  "fg_made_30_39",
  "fg_made_40_49",
  "fg_made_50_59",
  "fg_made_60_",
  "pat_made",
  "pat_att",
  "pat_missed",
  "fantasy_points",
  "fantasy_points_ppr",
] as const;

type RejectionReason = keyof NflverseWeeklyStatsRejections;

function normalizeRow(
  row: Record<string, string>,
  expectedSeason: number,
): { readonly observation: NflversePlayerWeeklyStats | null; readonly reason?: RejectionReason } {
  const gsisId = nullableString(row.player_id, 20);
  const playerName = nullableString(row.player_name, 160);
  const displayName = nullableString(row.player_display_name, 160);
  const playerPosition = position(row.position);
  if (!gsisId || !/^00-\d{7}$/u.test(gsisId) || !playerName || !displayName || !playerPosition) {
    return { observation: null, reason: "invalidIdentity" };
  }

  const season = boundedNumber(row.season, 1999, 2200, true);
  const week = boundedNumber(row.week, 1, 25, true);
  const seasonType = nullableString(row.season_type, 4)?.toUpperCase();
  const gameId = nullableString(row.game_id, 64);
  const playerTeam = team(row.team);
  const opponentTeam = team(row.opponent_team);
  if (
    season !== expectedSeason ||
    week === null ||
    (seasonType !== "REG" && seasonType !== "POST") ||
    !gameId ||
    !/^[A-Za-z0-9_.-]{1,64}$/u.test(gameId) ||
    !playerTeam ||
    !opponentTeam
  ) {
    return { observation: null, reason: "invalidContext" };
  }

  const components: NflverseWeeklyStatComponents = {
    passing_completions: boundedNumber(row.completions, 0, 100, true) ?? Number.NaN,
    passing_attempts: boundedNumber(row.attempts, 0, 150, true) ?? Number.NaN,
    passing_yards: boundedNumber(row.passing_yards, -200, 1_000, true) ?? Number.NaN,
    passing_touchdowns: boundedNumber(row.passing_tds, 0, 20, true) ?? Number.NaN,
    passing_interceptions: boundedNumber(row.passing_interceptions, 0, 20, true) ?? Number.NaN,
    passing_two_point_conversions:
      boundedNumber(row.passing_2pt_conversions, 0, 20, true) ?? Number.NaN,
    passing_first_downs: boundedNumber(row.passing_first_downs, 0, 100, true) ?? Number.NaN,
    sacks_suffered: boundedNumber(row.sacks_suffered, 0, 50, true) ?? Number.NaN,
    sack_yards_lost: boundedNumber(row.sack_yards_lost, -500, 500, true) ?? Number.NaN,
    sack_fumbles_lost: boundedNumber(row.sack_fumbles_lost, 0, 20, true) ?? Number.NaN,
    carries: boundedNumber(row.carries, 0, 100, true) ?? Number.NaN,
    rushing_yards: boundedNumber(row.rushing_yards, -500, 600, true) ?? Number.NaN,
    rushing_touchdowns: boundedNumber(row.rushing_tds, 0, 20, true) ?? Number.NaN,
    rushing_fumbles: boundedNumber(row.rushing_fumbles, 0, 20, true) ?? Number.NaN,
    rushing_fumbles_lost: boundedNumber(row.rushing_fumbles_lost, 0, 20, true) ?? Number.NaN,
    rushing_two_point_conversions:
      boundedNumber(row.rushing_2pt_conversions, 0, 20, true) ?? Number.NaN,
    rushing_first_downs: boundedNumber(row.rushing_first_downs, 0, 100, true) ?? Number.NaN,
    receptions: boundedNumber(row.receptions, 0, 100, true) ?? Number.NaN,
    targets: boundedNumber(row.targets, 0, 100, true) ?? Number.NaN,
    receiving_yards: boundedNumber(row.receiving_yards, -500, 600, true) ?? Number.NaN,
    receiving_touchdowns: boundedNumber(row.receiving_tds, 0, 20, true) ?? Number.NaN,
    receiving_fumbles: boundedNumber(row.receiving_fumbles, 0, 20, true) ?? Number.NaN,
    receiving_fumbles_lost: boundedNumber(row.receiving_fumbles_lost, 0, 20, true) ?? Number.NaN,
    fumbles_lost_total: boundedNumber(row.fumbles_lost_total, 0, 20, true) ?? Number.NaN,
    receiving_two_point_conversions:
      boundedNumber(row.receiving_2pt_conversions, 0, 20, true) ?? Number.NaN,
    receiving_first_downs: boundedNumber(row.receiving_first_downs, 0, 100, true) ?? Number.NaN,
    special_teams_touchdowns: boundedNumber(row.special_teams_tds, 0, 20, true) ?? Number.NaN,
    fumble_recovery_touchdowns: boundedNumber(row.fumble_recovery_tds, 0, 20, true) ?? Number.NaN,
    punt_return_yards: boundedNumber(row.punt_return_yards, -500, 1_000, true) ?? Number.NaN,
    kickoff_return_yards: boundedNumber(row.kickoff_return_yards, -500, 1_500, true) ?? Number.NaN,
    field_goals_made: boundedNumber(row.fg_made, 0, 20, true) ?? Number.NaN,
    field_goals_attempted: boundedNumber(row.fg_att, 0, 20, true) ?? Number.NaN,
    field_goals_missed: boundedNumber(row.fg_missed, 0, 20, true) ?? Number.NaN,
    field_goals_made_0_19: boundedNumber(row.fg_made_0_19, 0, 20, true) ?? Number.NaN,
    field_goals_made_20_29: boundedNumber(row.fg_made_20_29, 0, 20, true) ?? Number.NaN,
    field_goals_made_30_39: boundedNumber(row.fg_made_30_39, 0, 20, true) ?? Number.NaN,
    field_goals_made_40_49: boundedNumber(row.fg_made_40_49, 0, 20, true) ?? Number.NaN,
    field_goals_made_50_59: boundedNumber(row.fg_made_50_59, 0, 20, true) ?? Number.NaN,
    field_goals_made_60_plus: boundedNumber(row.fg_made_60_, 0, 20, true) ?? Number.NaN,
    extra_points_made: boundedNumber(row.pat_made, 0, 20, true) ?? Number.NaN,
    extra_points_attempted: boundedNumber(row.pat_att, 0, 20, true) ?? Number.NaN,
    extra_points_missed: boundedNumber(row.pat_missed, 0, 20, true) ?? Number.NaN,
  };
  const advanced: NflverseWeeklyAdvancedStats = {
    passingAirYards: optionalNumber(row.passing_air_yards, -1_000, 2_000) ?? 0,
    passingYardsAfterCatch: optionalNumber(row.passing_yards_after_catch, -500, 2_000) ?? 0,
    passingEpa: optionalNumber(row.passing_epa, -200, 200) ?? 0,
    passingCpoe: optionalNumber(row.passing_cpoe, -100, 100),
    pacr: optionalNumber(row.pacr, -100, 100),
    rushingEpa: optionalNumber(row.rushing_epa, -200, 200) ?? 0,
    receivingAirYards: optionalNumber(row.receiving_air_yards, -1_000, 2_000) ?? 0,
    receivingYardsAfterCatch: optionalNumber(row.receiving_yards_after_catch, -500, 2_000) ?? 0,
    receivingEpa: optionalNumber(row.receiving_epa, -200, 200) ?? 0,
    targetShare: optionalNumber(row.target_share, 0, 1),
    airYardsShare: optionalNumber(row.air_yards_share, -10, 10),
    wopr: optionalNumber(row.wopr, -10, 10),
  };
  const standard = boundedNumber(row.fantasy_points, -200, 500);
  const ppr = boundedNumber(row.fantasy_points_ppr, -200, 500);
  if (
    Object.values(components).some((value) => !Number.isFinite(value)) ||
    Object.values(advanced).some((value) => value !== null && !Number.isFinite(value)) ||
    standard === null ||
    ppr === null ||
    components.passing_completions > components.passing_attempts ||
    components.receptions > components.targets ||
    components.sack_fumbles_lost > components.fumbles_lost_total ||
    components.rushing_fumbles_lost > components.fumbles_lost_total ||
    components.receiving_fumbles_lost > components.fumbles_lost_total
  ) {
    return { observation: null, reason: "invalidStats" };
  }

  return {
    observation: {
      gsisId,
      playerName,
      displayName,
      position: playerPosition,
      positionGroup: position(row.position_group),
      season,
      week,
      seasonType,
      gameId,
      team: playerTeam,
      opponentTeam,
      components,
      advanced,
      sourceFantasyPoints: { standard, ppr },
    },
  };
}

function parseWeeklyStats(body: string, season: number) {
  const rows = parseCsv(body);
  const observations: NflversePlayerWeeklyStats[] = [];
  const rejectionCounts: Record<RejectionReason, number> = {
    invalidIdentity: 0,
    invalidContext: 0,
    invalidStats: 0,
    duplicate: 0,
  };
  const seen = new Set<string>();
  for (const row of rows) {
    const normalized = normalizeRow(row, season);
    if (!normalized.observation) {
      rejectionCounts[normalized.reason ?? "invalidStats"] += 1;
      continue;
    }
    const key = `${normalized.observation.gameId}:${normalized.observation.gsisId}`;
    if (seen.has(key)) {
      rejectionCounts.duplicate += 1;
      continue;
    }
    seen.add(key);
    observations.push(normalized.observation);
  }
  const rowsRejected = Object.values(rejectionCounts).reduce((sum, count) => sum + count, 0);
  assertAdmissionQuality({
    datasetLabel: "nflverse weekly stats",
    rowsRead: rows.length,
    rowsAccepted: observations.length,
    rowsRejected,
    absoluteRejectionAllowance: ABSOLUTE_REJECTION_ALLOWANCE,
    maximumRejectionRatio: MAXIMUM_REJECTION_RATIO,
  });
  return {
    observations,
    rowsRead: rows.length,
    rowsRejected,
    rejections: rejectionCounts,
    coveredWeeks: [...new Set(observations.map((row) => row.week))].sort((a, b) => a - b),
    coveredSeasonTypes: [...new Set(observations.map((row) => row.seasonType))].sort(),
  };
}

export class NflverseWeeklyStatsSource {
  readonly #fetch: NflverseFetchLike;
  readonly #now: () => Date;

  constructor(options: { readonly fetch?: NflverseFetchLike; readonly now?: () => Date } = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? (() => new Date());
  }

  async check(
    season: number,
    previous: NflverseDatasetState,
  ): Promise<NflverseWeeklyStatsCheckResult> {
    const sourceUrl = buildNflverseWeeklyStatsUrl(season);
    const result = await checkNflverseCsvRelease({
      fetch: this.#fetch,
      now: this.#now,
      sourceUrl,
      previous,
      maximumBytes: MAX_RESPONSE_BYTES,
      datasetLabel: "nflverse weekly stats",
    });
    const base = {
      checkedAt: result.checkedAt,
      sourceKey: NFLVERSE_WEEKLY_STATS_SOURCE_KEY,
      sourceUrl,
      attribution: NFLVERSE_WEEKLY_STATS_ATTRIBUTION,
      attributionUrl: NFLVERSE_WEEKLY_STATS_ATTRIBUTION_URL,
      license: NFLVERSE_DATA_LICENSE,
      season,
      etag: result.etag,
      lastModified: result.lastModified,
      checksumSha256: result.checksumSha256,
    };
    if (result.state === "unchanged") return { state: "unchanged", ...base };
    return {
      state: "changed",
      ...base,
      checksumSha256: result.checksumSha256,
      ...parseWeeklyStats(result.body, season),
    };
  }
}
