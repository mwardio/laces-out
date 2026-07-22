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
import type { NflverseSeasonType } from "./weekly-stats-source.js";

export const NFLVERSE_WEEKLY_ROSTERS_SOURCE_KEY = "nflverse.weekly-rosters" as const;
export const NFLVERSE_WEEKLY_ROSTERS_ATTRIBUTION =
  "Weekly NFL rosters provided by nflverse (CC BY 4.0)" as const;
export const NFLVERSE_WEEKLY_ROSTERS_ATTRIBUTION_URL = NFLVERSE_DATA_REPOSITORY_URL;

const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_ROWS = 100_000;
const ABSOLUTE_REJECTION_ALLOWANCE = 25;
const MAXIMUM_REJECTION_RATIO = 0.02;
const MINIMUM_TEAM_WEEK_PLAYERS = 40;
const EXPECTED_SEASON_TEAMS = 32;

export type NflverseRosterGameType = "REG" | "WC" | "DIV" | "CON" | "SB";
export type NflverseRosterStatusCategory =
  | "active"
  | "inactive"
  | "reserve"
  | "practice-squad"
  | "suspended"
  | "exempt"
  | "unavailable"
  | "other";

export interface NflverseWeeklyRosterPlayer {
  readonly season: number;
  readonly week: number;
  readonly seasonType: NflverseSeasonType;
  readonly gameType: NflverseRosterGameType;
  readonly team: string;
  readonly position: string;
  readonly depthChartPosition: string | null;
  readonly ngsPosition: string | null;
  readonly jerseyNumber: number | null;
  readonly status: string;
  readonly statusCategory: NflverseRosterStatusCategory;
  readonly statusDescriptionAbbr: string | null;
  readonly fullName: string;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly footballName: string | null;
  readonly gsisId: string | null;
  readonly esbId: string | null;
  readonly gsisItId: string | null;
  readonly smartId: string | null;
  readonly espnId: string | null;
  readonly yahooId: string | null;
  readonly sleeperId: string | null;
  readonly sportradarId: string | null;
  readonly rotowireId: string | null;
  readonly pffId: string | null;
  readonly pfrId: string | null;
  readonly fantasyDataId: string | null;
  readonly yearsExperience: number | null;
  readonly entryYear: number | null;
  readonly rookieYear: number | null;
  readonly draftClub: string | null;
  readonly draftNumber: number | null;
}

export interface NflverseWeeklyRosterWeekCoverage {
  readonly week: number;
  readonly seasonType: NflverseSeasonType;
  readonly gameType: NflverseRosterGameType;
  readonly teams: number;
  readonly players: number;
  readonly minimumPlayersPerTeam: number;
}

export interface NflverseWeeklyRosterRejections {
  readonly invalidIdentity: number;
  readonly invalidContext: number;
  readonly invalidStatus: number;
  readonly invalidDetails: number;
  readonly duplicate: number;
}

interface NflverseWeeklyRostersBaseResult {
  readonly checkedAt: string;
  readonly sourceKey: typeof NFLVERSE_WEEKLY_ROSTERS_SOURCE_KEY;
  readonly sourceUrl: string;
  readonly attribution: typeof NFLVERSE_WEEKLY_ROSTERS_ATTRIBUTION;
  readonly attributionUrl: typeof NFLVERSE_WEEKLY_ROSTERS_ATTRIBUTION_URL;
  readonly license: typeof NFLVERSE_DATA_LICENSE;
  readonly season: number;
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly checksumSha256: string | null;
}

export type NflverseWeeklyRostersCheckResult =
  | (NflverseWeeklyRostersBaseResult & {
      readonly state: "changed";
      readonly checksumSha256: string;
      readonly observations: readonly NflverseWeeklyRosterPlayer[];
      readonly rowsRead: number;
      readonly rowsRejected: number;
      readonly rejections: NflverseWeeklyRosterRejections;
      readonly coveredWeeks: readonly number[];
      readonly coveredSeasonTypes: readonly NflverseSeasonType[];
      readonly coveredTeams: readonly string[];
      readonly weekCoverage: readonly NflverseWeeklyRosterWeekCoverage[];
    })
  | (NflverseWeeklyRostersBaseResult & { readonly state: "unchanged" });

export function buildNflverseWeeklyRostersUrl(season: number): string {
  assertNflverseSeason(season, 2002);
  return `https://github.com/nflverse/nflverse-data/releases/download/weekly_rosters/roster_weekly_${season}.csv`;
}

function nullableString(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maximum ? normalized : null;
}

function requiredCode(value: unknown, maximum: number): string | null {
  const normalized = nullableString(value, maximum)?.toUpperCase();
  return normalized && /^[A-Z0-9]+(?:[._/+-][A-Z0-9]+)*$/u.test(normalized) ? normalized : null;
}

function optionalCode(value: unknown, maximum: number): string | null | undefined {
  if (typeof value !== "string" || value.trim() === "") return null;
  return requiredCode(value, maximum) ?? undefined;
}

function team(value: unknown): string | null {
  const normalized = nullableString(value, 4)?.toUpperCase();
  return normalized && /^[A-Z]{2,4}$/u.test(normalized) ? normalized : null;
}

function optionalTeam(value: unknown): string | null | undefined {
  if (typeof value !== "string" || value.trim() === "") return null;
  return team(value) ?? undefined;
}

function optionalInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): number | null | undefined {
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : undefined;
}

function optionalIdentifier(
  value: unknown,
  maximum: number,
  pattern: RegExp,
  transform: (value: string) => string = (input) => input,
): string | null | undefined {
  if (typeof value !== "string" || value.trim() === "") return null;
  const normalized = value.trim();
  return normalized.length <= maximum && pattern.test(normalized)
    ? transform(normalized)
    : undefined;
}

function rosterStatusCategory(status: string): NflverseRosterStatusCategory {
  switch (status) {
    case "ACT":
      return "active";
    case "INA":
      return "inactive";
    case "RES":
      return "reserve";
    case "DEV":
      return "practice-squad";
    case "SUS":
      return "suspended";
    case "EXE":
      return "exempt";
    case "CUT":
    case "NWT":
    case "RET":
    case "TRC":
    case "TRD":
    case "TRT":
      return "unavailable";
    default:
      return "other";
  }
}

function parseCsv(body: string): Record<string, string>[] {
  let rows: Record<string, string>[];
  try {
    rows = parse(body, {
      bom: true,
      columns: true,
      skip_empty_lines: true,
      relax_column_count: false,
      max_record_size: 128 * 1024,
    });
  } catch {
    throw new NflverseDatasetSourceError(
      "INVALID_CSV",
      "nflverse weekly rosters are malformed CSV",
    );
  }
  if (rows.length === 0 || rows.length > MAX_ROWS) {
    throw new NflverseDatasetSourceError(
      "INVALID_CSV",
      "nflverse weekly roster row count is invalid",
    );
  }
  const headers = new Set(Object.keys(rows[0] ?? {}));
  for (const required of REQUIRED_COLUMNS) {
    if (!headers.has(required)) {
      throw new NflverseDatasetSourceError(
        "INVALID_CSV",
        `nflverse weekly rosters omitted required column ${required}`,
      );
    }
  }
  return rows;
}

const REQUIRED_COLUMNS = [
  "season",
  "team",
  "position",
  "depth_chart_position",
  "jersey_number",
  "status",
  "full_name",
  "first_name",
  "last_name",
  "gsis_id",
  "espn_id",
  "sportradar_id",
  "yahoo_id",
  "rotowire_id",
  "pff_id",
  "pfr_id",
  "fantasy_data_id",
  "sleeper_id",
  "years_exp",
  "ngs_position",
  "week",
  "game_type",
  "status_description_abbr",
  "football_name",
  "esb_id",
  "gsis_it_id",
  "smart_id",
  "entry_year",
  "rookie_year",
  "draft_club",
  "draft_number",
] as const;

type RejectionReason = keyof NflverseWeeklyRosterRejections;

function normalizeRow(
  row: Record<string, string>,
  expectedSeason: number,
): { readonly observation: NflverseWeeklyRosterPlayer | null; readonly reason?: RejectionReason } {
  const fullName = nullableString(row.full_name, 160);
  const playerPosition = requiredCode(row.position, 12);
  const gsisId = optionalIdentifier(row.gsis_id, 20, /^00-\d{7}$/u);
  const esbId = optionalIdentifier(row.esb_id, 32, /^[A-Za-z0-9.-]+$/u);
  const gsisItId = optionalIdentifier(row.gsis_it_id, 20, /^\d+$/u);
  const smartId = optionalIdentifier(
    row.smart_id,
    36,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu,
    (value) => value.toLowerCase(),
  );
  const espnId = optionalIdentifier(row.espn_id, 32, /^[A-Za-z0-9.-]+$/u);
  const yahooId = optionalIdentifier(row.yahoo_id, 32, /^[A-Za-z0-9.-]+$/u);
  const sleeperId = optionalIdentifier(row.sleeper_id, 64, /^[A-Za-z0-9._-]+$/u);
  const sportradarId = optionalIdentifier(row.sportradar_id, 64, /^[A-Za-z0-9.-]+$/u);
  const rotowireId = optionalIdentifier(row.rotowire_id, 32, /^[A-Za-z0-9.-]+$/u);
  const pffId = optionalIdentifier(row.pff_id, 32, /^[A-Za-z0-9.-]+$/u);
  const pfrId = optionalIdentifier(row.pfr_id, 32, /^[A-Za-z0-9.-]+$/u);
  const fantasyDataId = optionalIdentifier(row.fantasy_data_id, 32, /^[A-Za-z0-9.-]+$/u);
  const identifiers = [
    gsisId,
    esbId,
    gsisItId,
    smartId,
    espnId,
    yahooId,
    sleeperId,
    sportradarId,
    rotowireId,
    pffId,
    pfrId,
    fantasyDataId,
  ];
  if (
    !fullName ||
    !playerPosition ||
    identifiers.some((identifier) => identifier === undefined) ||
    (!gsisId && !esbId && !smartId)
  ) {
    return { observation: null, reason: "invalidIdentity" };
  }

  const season = optionalInteger(row.season, 2002, 2200);
  const week = optionalInteger(row.week, 1, 25);
  const gameType = requiredCode(row.game_type, 4);
  const playerTeam = team(row.team);
  if (
    season !== expectedSeason ||
    week === null ||
    week === undefined ||
    !playerTeam ||
    (gameType !== "REG" &&
      gameType !== "WC" &&
      gameType !== "DIV" &&
      gameType !== "CON" &&
      gameType !== "SB")
  ) {
    return { observation: null, reason: "invalidContext" };
  }

  const status = requiredCode(row.status, 8);
  const statusDescriptionAbbr = optionalCode(row.status_description_abbr, 8);
  if (!status || statusDescriptionAbbr === undefined) {
    return { observation: null, reason: "invalidStatus" };
  }

  const depthChartPosition = optionalCode(row.depth_chart_position, 12);
  const ngsPosition = optionalCode(row.ngs_position, 20);
  const jerseyNumber = optionalInteger(row.jersey_number, 0, 99);
  const yearsExperience = optionalInteger(row.years_exp, 0, 80);
  const entryYear = optionalInteger(row.entry_year, 1900, 2200);
  const rookieYear = optionalInteger(row.rookie_year, 1900, 2200);
  const draftClub = optionalTeam(row.draft_club);
  const draftNumber = optionalInteger(row.draft_number, 1, 400);
  if (
    depthChartPosition === undefined ||
    ngsPosition === undefined ||
    jerseyNumber === undefined ||
    yearsExperience === undefined ||
    entryYear === undefined ||
    rookieYear === undefined ||
    draftClub === undefined ||
    draftNumber === undefined
  ) {
    return { observation: null, reason: "invalidDetails" };
  }

  return {
    observation: {
      season,
      week,
      seasonType: gameType === "REG" ? "REG" : "POST",
      gameType,
      team: playerTeam,
      position: playerPosition,
      depthChartPosition,
      ngsPosition,
      jerseyNumber,
      status,
      statusCategory: rosterStatusCategory(status),
      statusDescriptionAbbr: statusDescriptionAbbr ?? null,
      fullName,
      firstName: nullableString(row.first_name, 80),
      lastName: nullableString(row.last_name, 80),
      footballName: nullableString(row.football_name, 80),
      gsisId: gsisId ?? null,
      esbId: esbId ?? null,
      gsisItId: gsisItId ?? null,
      smartId: smartId ?? null,
      espnId: espnId ?? null,
      yahooId: yahooId ?? null,
      sleeperId: sleeperId ?? null,
      sportradarId: sportradarId ?? null,
      rotowireId: rotowireId ?? null,
      pffId: pffId ?? null,
      pfrId: pfrId ?? null,
      fantasyDataId: fantasyDataId ?? null,
      yearsExperience,
      entryYear,
      rookieYear,
      draftClub,
      draftNumber,
    },
  };
}

export function weeklyRostersIdentityKey(player: NflverseWeeklyRosterPlayer): string | null {
  return player.gsisId ?? player.esbId ?? player.smartId;
}

function assertCompleteArtifact(
  season: number,
  observations: readonly NflverseWeeklyRosterPlayer[],
): {
  readonly coveredWeeks: readonly number[];
  readonly coveredSeasonTypes: readonly NflverseSeasonType[];
  readonly coveredTeams: readonly string[];
  readonly weekCoverage: readonly NflverseWeeklyRosterWeekCoverage[];
} {
  const coveredWeeks = [...new Set(observations.map((row) => row.week))].sort(
    (left, right) => left - right,
  );
  const coveredTeams = [...new Set(observations.map((row) => row.team))].sort((left, right) =>
    left.localeCompare(right),
  );
  if (
    coveredWeeks[0] !== 1 ||
    coveredWeeks.some((week, index) => week !== index + 1) ||
    coveredTeams.length !== EXPECTED_SEASON_TEAMS ||
    !observations.some((row) => row.gameType === "REG")
  ) {
    throw new NflverseDatasetSourceError(
      "QUALITY_THRESHOLD",
      `nflverse weekly rosters failed season ${season} coverage validation`,
    );
  }

  let reachedPostseason = false;
  const weekCoverage: NflverseWeeklyRosterWeekCoverage[] = [];
  for (const week of coveredWeeks) {
    const rows = observations.filter((row) => row.week === week);
    const gameTypes = [...new Set(rows.map((row) => row.gameType))];
    if (gameTypes.length !== 1) {
      throw new NflverseDatasetSourceError(
        "QUALITY_THRESHOLD",
        `nflverse weekly rosters mixed game types in week ${week}`,
      );
    }
    const gameType = gameTypes[0];
    if (!gameType) {
      throw new NflverseDatasetSourceError(
        "QUALITY_THRESHOLD",
        `nflverse weekly rosters omitted week ${week}`,
      );
    }
    if (gameType === "REG" && reachedPostseason) {
      throw new NflverseDatasetSourceError(
        "QUALITY_THRESHOLD",
        `nflverse weekly rosters returned to regular season after the postseason`,
      );
    }
    reachedPostseason ||= gameType !== "REG";

    const teams = [...new Set(rows.map((row) => row.team))];
    const teamCounts = teams.map(
      (selectedTeam) => rows.filter((row) => row.team === selectedTeam).length,
    );
    const minimumPlayersPerTeam = Math.min(...teamCounts);
    const expectedPlayoffTeams: Partial<Record<NflverseRosterGameType, number>> = {
      // The seventh playoff seed was added for the 2020 season. Earlier Wild Card rounds had
      // four games (eight rostered teams); 2020 onward has six games (twelve teams).
      WC: season >= 2020 ? 12 : 8,
      DIV: 8,
      CON: 4,
      SB: 2,
    };
    const teamCountIsValid =
      gameType === "REG"
        ? teams.length >= 26 && teams.length <= 32 && teams.length % 2 === 0
        : teams.length === expectedPlayoffTeams[gameType];
    if (!teamCountIsValid || minimumPlayersPerTeam < MINIMUM_TEAM_WEEK_PLAYERS) {
      throw new NflverseDatasetSourceError(
        "QUALITY_THRESHOLD",
        `nflverse weekly rosters have incomplete team coverage in week ${week}`,
      );
    }
    weekCoverage.push({
      week,
      seasonType: gameType === "REG" ? "REG" : "POST",
      gameType,
      teams: teams.length,
      players: rows.length,
      minimumPlayersPerTeam,
    });
  }

  return {
    coveredWeeks,
    coveredSeasonTypes: (["REG", "POST"] as const).filter((seasonType) =>
      observations.some((row) => row.seasonType === seasonType),
    ),
    coveredTeams,
    weekCoverage,
  };
}

function parseWeeklyRosters(body: string, season: number) {
  const rows = parseCsv(body);
  const observations: NflverseWeeklyRosterPlayer[] = [];
  const rejectionCounts: Record<RejectionReason, number> = {
    invalidIdentity: 0,
    invalidContext: 0,
    invalidStatus: 0,
    invalidDetails: 0,
    duplicate: 0,
  };
  const seen = new Set<string>();
  for (const row of rows) {
    const normalized = normalizeRow(row, season);
    if (!normalized.observation) {
      rejectionCounts[normalized.reason ?? "invalidDetails"] += 1;
      continue;
    }
    // Historical releases can legitimately report more than one roster status for the same player
    // and team in a week. Preserve those transitions because the artifact provides no timestamp
    // with which to choose a winner; reject only an exact repeated status observation.
    const key = `${normalized.observation.season}:${normalized.observation.week}:${normalized.observation.gameType}:${normalized.observation.team}:${weeklyRostersIdentityKey(normalized.observation)}:${normalized.observation.status}:${normalized.observation.statusDescriptionAbbr}`;
    if (seen.has(key)) {
      rejectionCounts.duplicate += 1;
      continue;
    }
    seen.add(key);
    observations.push(normalized.observation);
  }
  const rowsRejected = Object.values(rejectionCounts).reduce((sum, count) => sum + count, 0);
  try {
    assertAdmissionQuality({
      datasetLabel: "nflverse weekly rosters",
      rowsRead: rows.length,
      rowsAccepted: observations.length,
      rowsRejected,
      absoluteRejectionAllowance: ABSOLUTE_REJECTION_ALLOWANCE,
      maximumRejectionRatio: MAXIMUM_REJECTION_RATIO,
    });
  } catch (error) {
    if (error instanceof NflverseDatasetSourceError && error.code === "QUALITY_THRESHOLD") {
      throw new NflverseDatasetSourceError(
        error.code,
        `${error.message}; rejection breakdown ${JSON.stringify(rejectionCounts)}`,
        error.retryable,
      );
    }
    throw error;
  }
  const coverage = assertCompleteArtifact(season, observations);
  observations.sort(
    (left, right) =>
      left.week - right.week ||
      left.gameType.localeCompare(right.gameType) ||
      left.team.localeCompare(right.team) ||
      left.fullName.localeCompare(right.fullName) ||
      (weeklyRostersIdentityKey(left) ?? "").localeCompare(weeklyRostersIdentityKey(right) ?? "") ||
      left.status.localeCompare(right.status) ||
      (left.statusDescriptionAbbr ?? "").localeCompare(right.statusDescriptionAbbr ?? ""),
  );
  return {
    observations,
    rowsRead: rows.length,
    rowsRejected,
    rejections: rejectionCounts,
    ...coverage,
  };
}

export class NflverseWeeklyRostersSource {
  readonly #fetch: NflverseFetchLike;
  readonly #now: () => Date;

  constructor(options: { readonly fetch?: NflverseFetchLike; readonly now?: () => Date } = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? (() => new Date());
  }

  async check(
    season: number,
    previous: NflverseDatasetState,
  ): Promise<NflverseWeeklyRostersCheckResult> {
    const sourceUrl = buildNflverseWeeklyRostersUrl(season);
    const result = await checkNflverseCsvRelease({
      fetch: this.#fetch,
      now: this.#now,
      sourceUrl,
      previous,
      maximumBytes: MAX_RESPONSE_BYTES,
      datasetLabel: "nflverse weekly rosters",
    });
    const base = {
      checkedAt: result.checkedAt,
      sourceKey: NFLVERSE_WEEKLY_ROSTERS_SOURCE_KEY,
      sourceUrl,
      attribution: NFLVERSE_WEEKLY_ROSTERS_ATTRIBUTION,
      attributionUrl: NFLVERSE_WEEKLY_ROSTERS_ATTRIBUTION_URL,
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
      ...parseWeeklyRosters(result.body, season),
    };
  }
}
