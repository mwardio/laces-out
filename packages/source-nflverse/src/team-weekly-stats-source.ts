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

export const NFLVERSE_TEAM_WEEKLY_STATS_SOURCE_KEY = "nflverse.stats-team-week" as const;
export const NFLVERSE_TEAM_WEEKLY_STATS_ATTRIBUTION =
  "Weekly team stats provided by nflverse (CC BY 4.0)" as const;
export const NFLVERSE_TEAM_WEEKLY_STATS_ATTRIBUTION_URL = NFLVERSE_DATA_REPOSITORY_URL;

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_ROWS = 2_000;
const MAX_COLUMNS = 256;
const MAX_RECORD_BYTES = 128 * 1024;
// The release has older rows, but the complete defensive component set required by this adapter
// first passes reciprocal-game and field-level admission in 2011. Earlier seasons must not be
// mistaken for equivalent model input.
const EARLIEST_COMPLETE_COMPONENT_SEASON = 2011;

export type NflverseTeamWeeklySeasonType = "REG" | "POST";

type ComponentSpec = readonly [
  upstreamColumn: string,
  minimum: number,
  maximum: number,
  integer: boolean,
];

/**
 * The names on the left are the provider-neutral component vocabulary used by Laces Out. The
 * names on the right are pinned to nflverse's official `stats_team_week` schema. Keeping this map
 * explicit makes a removed or renamed upstream field a hard schema failure instead of silently
 * changing model inputs.
 */
const COMPONENT_SPECS = {
  passing_completions: ["completions", 0, 100, true],
  passing_attempts: ["attempts", 0, 150, true],
  passing_yards: ["passing_yards", -500, 1_500, true],
  passing_touchdowns: ["passing_tds", 0, 20, true],
  passing_interceptions: ["passing_interceptions", 0, 20, true],
  sacks_suffered: ["sacks_suffered", 0, 50, true],
  sack_yards_lost: ["sack_yards_lost", -500, 500, true],
  sack_fumbles: ["sack_fumbles", 0, 50, true],
  sack_fumbles_lost: ["sack_fumbles_lost", 0, 50, true],
  passing_first_downs: ["passing_first_downs", 0, 100, true],
  passing_two_point_conversions: ["passing_2pt_conversions", 0, 20, true],
  carries: ["carries", 0, 150, true],
  rushing_yards: ["rushing_yards", -500, 1_000, true],
  rushing_touchdowns: ["rushing_tds", 0, 20, true],
  rushing_fumbles: ["rushing_fumbles", 0, 50, true],
  rushing_fumbles_lost: ["rushing_fumbles_lost", 0, 50, true],
  rushing_first_downs: ["rushing_first_downs", 0, 100, true],
  rushing_two_point_conversions: ["rushing_2pt_conversions", 0, 20, true],
  receptions: ["receptions", 0, 150, true],
  targets: ["targets", 0, 150, true],
  receiving_yards: ["receiving_yards", -500, 1_500, true],
  receiving_touchdowns: ["receiving_tds", 0, 20, true],
  receiving_fumbles: ["receiving_fumbles", 0, 50, true],
  receiving_fumbles_lost: ["receiving_fumbles_lost", 0, 50, true],
  receiving_first_downs: ["receiving_first_downs", 0, 100, true],
  receiving_two_point_conversions: ["receiving_2pt_conversions", 0, 20, true],
  offensive_fumbles_total: ["fumbles_total", 0, 100, true],
  offensive_fumbles_lost: ["fumbles_lost_total", 0, 100, true],
  defensive_tackles_for_loss: ["def_tackles_for_loss", 0, 100, true],
  defensive_tackles_for_loss_yards: ["def_tackles_for_loss_yards", -500, 500, true],
  defensive_fumbles_forced: ["def_fumbles_forced", 0, 50, true],
  // nflverse can represent shared defensive sacks fractionally before team aggregation.
  defensive_sacks: ["def_sacks", 0, 50, false],
  defensive_sack_yards: ["def_sack_yards", -500, 500, true],
  defensive_qb_hits: ["def_qb_hits", 0, 100, true],
  defensive_interceptions: ["def_interceptions", 0, 30, true],
  defensive_interception_return_yards: ["def_interception_yards", -500, 1_000, true],
  defensive_passes_defended: ["def_pass_defended", 0, 100, true],
  defensive_touchdowns: ["def_tds", 0, 20, true],
  defensive_safeties: ["def_safeties", 0, 10, true],
  defensive_fumbles_recovered: ["fumble_recovery_opp", 0, 50, true],
  defensive_fumble_recovery_yards: ["fumble_recovery_yards_opp", -500, 1_000, true],
  fumble_recovery_touchdowns: ["fumble_recovery_tds", 0, 20, true],
  special_teams_touchdowns: ["special_teams_tds", 0, 20, true],
  punt_returns: ["punt_returns", 0, 50, true],
  punt_return_yards: ["punt_return_yards", -500, 1_500, true],
  kickoff_returns: ["kickoff_returns", 0, 50, true],
  kickoff_return_yards: ["kickoff_return_yards", -500, 2_000, true],
  field_goals_made: ["fg_made", 0, 20, true],
  field_goals_attempted: ["fg_att", 0, 20, true],
  field_goals_missed: ["fg_missed", 0, 20, true],
  field_goals_blocked: ["fg_blocked", 0, 20, true],
  field_goals_made_0_19: ["fg_made_0_19", 0, 20, true],
  field_goals_made_20_29: ["fg_made_20_29", 0, 20, true],
  field_goals_made_30_39: ["fg_made_30_39", 0, 20, true],
  field_goals_made_40_49: ["fg_made_40_49", 0, 20, true],
  field_goals_made_50_59: ["fg_made_50_59", 0, 20, true],
  field_goals_made_60_plus: ["fg_made_60_", 0, 20, true],
  field_goals_missed_0_19: ["fg_missed_0_19", 0, 20, true],
  field_goals_missed_20_29: ["fg_missed_20_29", 0, 20, true],
  field_goals_missed_30_39: ["fg_missed_30_39", 0, 20, true],
  field_goals_missed_40_49: ["fg_missed_40_49", 0, 20, true],
  field_goals_missed_50_59: ["fg_missed_50_59", 0, 20, true],
  field_goals_missed_60_plus: ["fg_missed_60_", 0, 20, true],
  extra_points_made: ["pat_made", 0, 20, true],
  extra_points_attempted: ["pat_att", 0, 20, true],
  extra_points_missed: ["pat_missed", 0, 20, true],
  extra_points_blocked: ["pat_blocked", 0, 20, true],
  punts_attempted: ["pt_att", 0, 50, true],
  punts_blocked: ["pt_blocked", 0, 20, true],
  punting_yards: ["pt_yards", -500, 5_000, true],
  punts_inside_20: ["pt_inside_20", 0, 50, true],
  punt_touchbacks: ["pt_touchback", 0, 50, true],
  punt_return_yards_allowed: ["pt_return_yards", -500, 2_000, true],
  punt_return_touchdowns_allowed: ["pt_return_tds", 0, 20, true],
} as const satisfies Record<string, ComponentSpec>;

type StoredComponentName = keyof typeof COMPONENT_SPECS;
export type NflverseTeamWeeklyStatComponents = Readonly<
  Record<StoredComponentName | "total_offensive_yards", number>
>;

export interface NflverseTeamWeeklyAdvancedStats {
  readonly passing_epa: number;
  readonly passing_cpoe: number | null;
  readonly rushing_epa: number;
  readonly receiving_epa: number;
}

export interface NflverseTeamWeeklyStats {
  readonly season: number;
  readonly week: number;
  readonly seasonType: NflverseTeamWeeklySeasonType;
  readonly gameId: string;
  readonly team: string;
  readonly opponentTeam: string;
  readonly components: NflverseTeamWeeklyStatComponents;
  readonly advanced: NflverseTeamWeeklyAdvancedStats;
}

export interface NflverseTeamWeeklyStatsRejections {
  readonly invalidContext: number;
  readonly invalidStats: number;
  readonly duplicate: number;
  readonly teamWeekConflict: number;
  readonly gamePairMismatch: number;
}

interface NflverseTeamWeeklyStatsBaseResult {
  readonly checkedAt: string;
  readonly sourceKey: typeof NFLVERSE_TEAM_WEEKLY_STATS_SOURCE_KEY;
  readonly sourceUrl: string;
  readonly attribution: typeof NFLVERSE_TEAM_WEEKLY_STATS_ATTRIBUTION;
  readonly attributionUrl: typeof NFLVERSE_TEAM_WEEKLY_STATS_ATTRIBUTION_URL;
  readonly license: typeof NFLVERSE_DATA_LICENSE;
  readonly season: number;
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly checksumSha256: string | null;
}

export type NflverseTeamWeeklyStatsCheckResult =
  | (NflverseTeamWeeklyStatsBaseResult & {
      readonly state: "changed";
      readonly checksumSha256: string;
      readonly observations: readonly NflverseTeamWeeklyStats[];
      readonly rowsRead: number;
      readonly rowsRejected: number;
      readonly rejections: NflverseTeamWeeklyStatsRejections;
      readonly coveredWeeks: readonly number[];
      readonly coveredSeasonTypes: readonly NflverseTeamWeeklySeasonType[];
      readonly coveredTeams: readonly string[];
    })
  | (NflverseTeamWeeklyStatsBaseResult & { readonly state: "unchanged" });

const CONTEXT_COLUMNS = [
  "season",
  "week",
  "team",
  "season_type",
  "game_id",
  "opponent_team",
] as const;
const ADVANCED_COLUMNS = ["passing_epa", "passing_cpoe", "rushing_epa", "receiving_epa"] as const;
const REQUIRED_COLUMNS = [
  ...CONTEXT_COLUMNS,
  ...Object.values(COMPONENT_SPECS).map(([column]) => column),
  ...ADVANCED_COLUMNS,
] as const;

type RejectionReason = keyof NflverseTeamWeeklyStatsRejections;

export function buildNflverseTeamWeeklyStatsUrl(season: number): string {
  assertNflverseSeason(season, EARLIEST_COMPLETE_COMPONENT_SEASON);
  return `https://github.com/nflverse/nflverse-data/releases/download/stats_team/stats_team_week_${season}.csv`;
}

function nullableString(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (normalized === "" || normalized.toUpperCase() === "NA") return null;
  return normalized.length <= maximum ? normalized : null;
}

function boundedNumber(
  value: unknown,
  minimum: number,
  maximum: number,
  integer: boolean,
): number | null {
  const normalized = nullableString(value, 64);
  if (normalized === null) return null;
  const parsed = Number(normalized);
  if (
    !Number.isFinite(parsed) ||
    parsed < minimum ||
    parsed > maximum ||
    (integer && !Number.isInteger(parsed))
  ) {
    return null;
  }
  return Object.is(parsed, -0) ? 0 : parsed;
}

function optionalNumber(
  value: unknown,
  minimum: number,
  maximum: number,
): { readonly valid: boolean; readonly value: number | null } {
  if (nullableString(value, 64) === null) return { valid: true, value: null };
  const parsed = boundedNumber(value, minimum, maximum, false);
  return { valid: parsed !== null, value: parsed };
}

function team(value: unknown): string | null {
  const normalized = nullableString(value, 4)?.toUpperCase();
  return normalized && /^[A-Z]{2,4}$/u.test(normalized) ? normalized : null;
}

function parseCsv(body: string): readonly Record<string, string>[] {
  let records: string[][];
  try {
    records = parse(body, {
      bom: true,
      columns: false,
      skip_empty_lines: true,
      relax_column_count: false,
      max_record_size: MAX_RECORD_BYTES,
    });
  } catch {
    throw new NflverseDatasetSourceError(
      "INVALID_CSV",
      "nflverse team weekly stats are malformed CSV",
    );
  }
  if (records.length < 2 || records.length - 1 > MAX_ROWS) {
    throw new NflverseDatasetSourceError(
      "INVALID_CSV",
      "nflverse team weekly stats row count is invalid",
    );
  }
  const headers = records[0] ?? [];
  const uniqueHeaders = new Set(headers);
  if (
    headers.length === 0 ||
    headers.length > MAX_COLUMNS ||
    headers.some((header) => header.trim() === "") ||
    uniqueHeaders.size !== headers.length
  ) {
    throw new NflverseDatasetSourceError(
      "INVALID_CSV",
      "nflverse team weekly stats contain invalid or duplicate headers",
    );
  }
  for (const required of REQUIRED_COLUMNS) {
    if (!uniqueHeaders.has(required)) {
      throw new NflverseDatasetSourceError(
        "INVALID_CSV",
        `nflverse team weekly stats omitted required column ${required}`,
      );
    }
  }
  return records
    .slice(1)
    .map((record) =>
      Object.fromEntries(headers.map((header, index) => [header, record[index] ?? ""])),
    );
}

function normalizeComponents(row: Record<string, string>): NflverseTeamWeeklyStatComponents | null {
  const parsed: Partial<Record<StoredComponentName, number>> = {};
  for (const [component, [column, minimum, maximum, integer]] of Object.entries(
    COMPONENT_SPECS,
  ) as [StoredComponentName, ComponentSpec][]) {
    const value = boundedNumber(row[column], minimum, maximum, integer);
    if (value === null) return null;
    parsed[component] = value;
  }
  const components = parsed as Record<StoredComponentName, number>;
  const madeFieldGoals =
    components.field_goals_made_0_19 +
    components.field_goals_made_20_29 +
    components.field_goals_made_30_39 +
    components.field_goals_made_40_49 +
    components.field_goals_made_50_59 +
    components.field_goals_made_60_plus;
  const missedFieldGoals =
    components.field_goals_missed_0_19 +
    components.field_goals_missed_20_29 +
    components.field_goals_missed_30_39 +
    components.field_goals_missed_40_49 +
    components.field_goals_missed_50_59 +
    components.field_goals_missed_60_plus;
  if (
    components.passing_completions > components.passing_attempts ||
    components.receptions > components.targets ||
    components.sack_fumbles_lost > components.sack_fumbles ||
    components.rushing_fumbles_lost > components.rushing_fumbles ||
    components.receiving_fumbles_lost > components.receiving_fumbles ||
    components.offensive_fumbles_lost > components.offensive_fumbles_total ||
    madeFieldGoals !== components.field_goals_made ||
    missedFieldGoals !== components.field_goals_missed ||
    components.field_goals_made + components.field_goals_missed + components.field_goals_blocked !==
      components.field_goals_attempted ||
    components.extra_points_made +
      components.extra_points_missed +
      components.extra_points_blocked !==
      components.extra_points_attempted
  ) {
    return null;
  }
  // An officially blocked punt is not necessarily credited as a punt attempt. nflverse therefore
  // legitimately contains games with pt_blocked > pt_att (for example LAC in 2021 Week 11).
  return {
    ...components,
    // NFL team/DST yards allowed use net passing yards. nflverse exposes QB passing yards and
    // sack yardage separately, with `sack_yards_lost` represented as a negative value.
    total_offensive_yards:
      components.passing_yards + components.sack_yards_lost + components.rushing_yards,
  };
}

function normalizeRow(
  row: Record<string, string>,
  expectedSeason: number,
): { readonly observation: NflverseTeamWeeklyStats | null; readonly reason?: RejectionReason } {
  const season = boundedNumber(row.season, EARLIEST_COMPLETE_COMPONENT_SEASON, 2200, true);
  const week = boundedNumber(row.week, 1, 25, true);
  const seasonType = nullableString(row.season_type, 4)?.toUpperCase();
  const gameId = nullableString(row.game_id, 64);
  const rowTeam = team(row.team);
  const opponentTeam = team(row.opponent_team);
  if (
    season !== expectedSeason ||
    week === null ||
    (seasonType !== "REG" && seasonType !== "POST") ||
    !gameId ||
    !/^[A-Za-z0-9_.-]{1,64}$/u.test(gameId) ||
    !rowTeam ||
    !opponentTeam ||
    rowTeam === opponentTeam
  ) {
    return { observation: null, reason: "invalidContext" };
  }

  const components = normalizeComponents(row);
  const passingEpa = boundedNumber(row.passing_epa, -500, 500, false);
  const passingCpoe = optionalNumber(row.passing_cpoe, -100, 100);
  const rushingEpa = boundedNumber(row.rushing_epa, -500, 500, false);
  const receivingEpa = boundedNumber(row.receiving_epa, -500, 500, false);
  if (
    !components ||
    passingEpa === null ||
    !passingCpoe.valid ||
    rushingEpa === null ||
    receivingEpa === null
  ) {
    return { observation: null, reason: "invalidStats" };
  }
  return {
    observation: {
      season,
      week,
      seasonType,
      gameId,
      team: rowTeam,
      opponentTeam,
      components,
      advanced: {
        passing_epa: passingEpa,
        passing_cpoe: passingCpoe.value,
        rushing_epa: rushingEpa,
        receiving_epa: receivingEpa,
      },
    },
  };
}

function parseTeamWeeklyStats(body: string, season: number) {
  const rows = parseCsv(body);
  const observations: NflverseTeamWeeklyStats[] = [];
  const rejectionCounts: Record<RejectionReason, number> = {
    invalidContext: 0,
    invalidStats: 0,
    duplicate: 0,
    teamWeekConflict: 0,
    gamePairMismatch: 0,
  };
  const seenGameTeams = new Set<string>();
  const seenTeamWeeks = new Set<string>();

  for (const row of rows) {
    const normalized = normalizeRow(row, season);
    if (!normalized.observation) {
      rejectionCounts[normalized.reason ?? "invalidStats"] += 1;
      continue;
    }
    const gameTeamKey = `${normalized.observation.gameId}:${normalized.observation.team}`;
    if (seenGameTeams.has(gameTeamKey)) {
      rejectionCounts.duplicate += 1;
      continue;
    }
    const teamWeekKey = `${normalized.observation.seasonType}:${normalized.observation.week}:${normalized.observation.team}`;
    if (seenTeamWeeks.has(teamWeekKey)) {
      rejectionCounts.teamWeekConflict += 1;
      continue;
    }
    seenGameTeams.add(gameTeamKey);
    seenTeamWeeks.add(teamWeekKey);
    observations.push(normalized.observation);
  }

  const byGame = new Map<string, NflverseTeamWeeklyStats[]>();
  for (const observation of observations) {
    byGame.set(observation.gameId, [...(byGame.get(observation.gameId) ?? []), observation]);
  }
  const rejectedGameIds = new Set<string>();
  for (const [gameId, gameRows] of byGame) {
    const [first, second] = gameRows;
    if (
      gameRows.length !== 2 ||
      !first ||
      !second ||
      first.season !== second.season ||
      first.week !== second.week ||
      first.seasonType !== second.seasonType ||
      first.team !== second.opponentTeam ||
      first.opponentTeam !== second.team
    ) {
      rejectionCounts.gamePairMismatch += gameRows.length;
      rejectedGameIds.add(gameId);
    }
  }
  const admitted = observations.filter((observation) => !rejectedGameIds.has(observation.gameId));
  const rowsRejected = Object.values(rejectionCounts).reduce((sum, count) => sum + count, 0);
  // A missing or malformed team row corrupts both opponent adjustment and DST results. Unlike a
  // large player feed, no partial team-week artifact is safe to publish.
  assertAdmissionQuality({
    datasetLabel: "nflverse team weekly stats",
    rowsRead: rows.length,
    rowsAccepted: admitted.length,
    rowsRejected,
    absoluteRejectionAllowance: 0,
    maximumRejectionRatio: 0,
  });

  admitted.sort(
    (left, right) =>
      left.week - right.week ||
      left.seasonType.localeCompare(right.seasonType) ||
      left.team.localeCompare(right.team) ||
      left.gameId.localeCompare(right.gameId),
  );
  return {
    observations: admitted,
    rowsRead: rows.length,
    rowsRejected,
    rejections: rejectionCounts,
    coveredWeeks: [...new Set(admitted.map((row) => row.week))].sort((left, right) => left - right),
    coveredSeasonTypes: (["REG", "POST"] as const).filter((type) =>
      admitted.some((row) => row.seasonType === type),
    ),
    coveredTeams: [...new Set(admitted.map((row) => row.team))].sort((left, right) =>
      left.localeCompare(right),
    ),
  };
}

export class NflverseTeamWeeklyStatsSource {
  readonly #fetch: NflverseFetchLike;
  readonly #now: () => Date;

  constructor(options: { readonly fetch?: NflverseFetchLike; readonly now?: () => Date } = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? (() => new Date());
  }

  async check(
    season: number,
    previous: NflverseDatasetState,
  ): Promise<NflverseTeamWeeklyStatsCheckResult> {
    const sourceUrl = buildNflverseTeamWeeklyStatsUrl(season);
    const result = await checkNflverseCsvRelease({
      fetch: this.#fetch,
      now: this.#now,
      sourceUrl,
      previous,
      maximumBytes: MAX_RESPONSE_BYTES,
      datasetLabel: "nflverse team weekly stats",
    });
    const base = {
      checkedAt: result.checkedAt,
      sourceKey: NFLVERSE_TEAM_WEEKLY_STATS_SOURCE_KEY,
      sourceUrl,
      attribution: NFLVERSE_TEAM_WEEKLY_STATS_ATTRIBUTION,
      attributionUrl: NFLVERSE_TEAM_WEEKLY_STATS_ATTRIBUTION_URL,
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
      ...parseTeamWeeklyStats(result.body, season),
    };
  }
}
