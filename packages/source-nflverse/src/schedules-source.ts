import { parse } from "csv-parse/sync";

import {
  NFLVERSE_DATA_LICENSE,
  NFLVERSE_DATA_REPOSITORY_URL,
  NflverseDatasetSourceError,
  assertNflverseSeason,
  checkNflverseCsvRelease,
  type NflverseDatasetState,
  type NflverseFetchLike,
} from "./release-source.js";

export const NFLVERSE_SCHEDULES_SOURCE_KEY = "nflverse.schedules" as const;
export const NFLVERSE_SCHEDULES_URL =
  "https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv" as const;
export const NFLVERSE_SCHEDULES_UPSTREAM_URL =
  "https://github.com/nflverse/nfldata/blob/master/data/games.csv" as const;
export const NFLVERSE_SCHEDULES_ATTRIBUTION =
  "NFL game schedules provided by nflverse (CC BY 4.0)" as const;
export const NFLVERSE_SCHEDULES_ATTRIBUTION_URL = NFLVERSE_DATA_REPOSITORY_URL;

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_ARTIFACT_ROWS = 20_000;
const MAX_RECORD_BYTES = 64 * 1024;

export type NflverseScheduleSeasonType = "REG" | "POST";
export type NflverseScheduleGameType = "REG" | "WC" | "DIV" | "CON" | "SB" | "POST";
export type NflverseScheduleStatus = "scheduled" | "final";
export type NflverseScheduleVenue = "home" | "neutral";

export interface NflverseScheduleGame {
  readonly gameId: string;
  readonly season: number;
  readonly week: number;
  readonly seasonType: NflverseScheduleSeasonType;
  /** Preserves the upstream playoff round while `seasonType` supports REG/POST filtering. */
  readonly gameType: NflverseScheduleGameType;
  /** NFL season-local calendar date in YYYY-MM-DD form. */
  readonly gameDate: string;
  /** Scheduled kickoff clock time in US Eastern time, or null while the time is TBD. */
  readonly startTimeEastern: string | null;
  readonly timeTbd: boolean;
  readonly awayTeam: string;
  readonly homeTeam: string;
  readonly awayScore: number | null;
  readonly homeScore: number | null;
  readonly awayRestDays: number | null;
  readonly homeRestDays: number | null;
  readonly venue: NflverseScheduleVenue;
  /** Derived only from the score pair; this source is not a live in-game status feed. */
  readonly status: NflverseScheduleStatus;
}

export interface NflverseTeamScheduleGame {
  readonly gameId: string;
  readonly season: number;
  readonly week: number;
  readonly seasonType: NflverseScheduleSeasonType;
  readonly gameType: NflverseScheduleGameType;
  readonly gameDate: string;
  readonly startTimeEastern: string | null;
  readonly timeTbd: boolean;
  readonly team: string;
  readonly opponentTeam: string;
  readonly side: "away" | "home";
  readonly isNeutralSite: boolean;
  readonly teamScore: number | null;
  readonly opponentScore: number | null;
  readonly teamRestDays: number | null;
  readonly opponentRestDays: number | null;
  readonly status: NflverseScheduleStatus;
}

export interface NflverseScheduleRejections {
  readonly invalidContext: number;
  readonly invalidTeams: number;
  readonly invalidTiming: number;
  readonly invalidResult: number;
  readonly duplicate: number;
  readonly teamWeekConflict: number;
}

export interface NflverseScheduleCheckOptions {
  /** Defaults to both. Use a context-specific persisted source state for each distinct selection. */
  readonly seasonTypes?: readonly NflverseScheduleSeasonType[];
}

export interface NflverseSchedulesState extends NflverseDatasetState {
  /** Prevents a checksum from one season/filter context suppressing another context's parse. */
  readonly selectionKey?: string | null;
}

interface NflverseScheduleBaseResult {
  readonly checkedAt: string;
  readonly sourceKey: typeof NFLVERSE_SCHEDULES_SOURCE_KEY;
  readonly sourceUrl: typeof NFLVERSE_SCHEDULES_URL;
  readonly upstreamUrl: typeof NFLVERSE_SCHEDULES_UPSTREAM_URL;
  readonly attribution: typeof NFLVERSE_SCHEDULES_ATTRIBUTION;
  readonly attributionUrl: typeof NFLVERSE_SCHEDULES_ATTRIBUTION_URL;
  readonly license: typeof NFLVERSE_DATA_LICENSE;
  readonly season: number;
  readonly requestedSeasonTypes: readonly NflverseScheduleSeasonType[];
  /** Stable key for keeping conditional-request state isolated by season/filter context. */
  readonly selectionKey: string;
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly checksumSha256: string | null;
}

export type NflverseSchedulesCheckResult =
  | (NflverseScheduleBaseResult & {
      readonly state: "changed";
      readonly checksumSha256: string;
      readonly games: readonly NflverseScheduleGame[];
      /** Two rows per game, ready for team/opponent joins and missing-week bye detection. */
      readonly teamGames: readonly NflverseTeamScheduleGame[];
      readonly artifactRowsRead: number;
      readonly rowsRead: number;
      readonly rowsRejected: number;
      readonly rejections: NflverseScheduleRejections;
      readonly coveredWeeks: readonly number[];
      readonly coveredSeasonTypes: readonly NflverseScheduleSeasonType[];
      readonly coveredTeams: readonly string[];
    })
  | (NflverseScheduleBaseResult & { readonly state: "unchanged" });

const REQUIRED_COLUMNS = [
  "game_id",
  "season",
  "game_type",
  "week",
  "gameday",
  "gametime",
  "away_team",
  "away_score",
  "home_team",
  "home_score",
  "location",
  "away_rest",
  "home_rest",
] as const;

type RejectionReason = keyof NflverseScheduleRejections;

function nullableString(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (normalized === "" || normalized.toUpperCase() === "NA") return null;
  return normalized.length <= maximum ? normalized : null;
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number | null {
  const normalized = nullableString(value, 32);
  if (!normalized || !/^-?\d+$/u.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function optionalInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): { readonly valid: boolean; readonly value: number | null } {
  if (nullableString(value, 32) === null) return { valid: true, value: null };
  const parsed = boundedInteger(value, minimum, maximum);
  return { valid: parsed !== null, value: parsed };
}

function normalizeTeam(value: unknown): string | null {
  const normalized = nullableString(value, 4)?.toUpperCase();
  return normalized && /^[A-Z]{2,4}$/u.test(normalized) ? normalized : null;
}

function normalizeGameType(value: unknown): {
  readonly gameType: NflverseScheduleGameType;
  readonly seasonType: NflverseScheduleSeasonType;
} | null {
  const normalized = nullableString(value, 8)?.toUpperCase();
  if (normalized === "REG") return { gameType: "REG", seasonType: "REG" };
  if (
    normalized === "WC" ||
    normalized === "DIV" ||
    normalized === "CON" ||
    normalized === "SB" ||
    normalized === "POST"
  ) {
    return { gameType: normalized, seasonType: "POST" };
  }
  return null;
}

function normalizeDate(value: unknown): string | null {
  const normalized = nullableString(value, 10);
  if (!normalized || !/^\d{4}-\d{2}-\d{2}$/u.test(normalized)) return null;
  const [year, month, day] = normalized.split("-").map(Number);
  const date = new Date(Date.UTC(year ?? 0, (month ?? 0) - 1, day));
  if (
    Number.isNaN(date.getTime()) ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return normalized;
}

function normalizeTime(value: unknown): {
  readonly valid: boolean;
  readonly value: string | null;
} {
  const normalized = nullableString(value, 5);
  if (normalized === null) return { valid: true, value: null };
  return /^([01]\d|2[0-3]):[0-5]\d$/u.test(normalized)
    ? { valid: true, value: normalized }
    : { valid: false, value: null };
}

function parseCsv(body: string): Record<string, string>[] {
  let rows: Record<string, string>[];
  try {
    rows = parse(body, {
      bom: true,
      columns: true,
      skip_empty_lines: true,
      relax_column_count: false,
      max_record_size: MAX_RECORD_BYTES,
    });
  } catch {
    throw new NflverseDatasetSourceError("INVALID_CSV", "nflverse schedules are malformed CSV");
  }
  if (rows.length === 0 || rows.length > MAX_ARTIFACT_ROWS) {
    throw new NflverseDatasetSourceError(
      "INVALID_CSV",
      "nflverse schedule artifact row count is invalid",
    );
  }
  const headers = new Set(Object.keys(rows[0] ?? {}));
  for (const required of REQUIRED_COLUMNS) {
    if (!headers.has(required)) {
      throw new NflverseDatasetSourceError(
        "INVALID_CSV",
        `nflverse schedules omitted required column ${required}`,
      );
    }
  }
  return rows;
}

function normalizeRow(
  row: Record<string, string>,
  expectedSeason: number,
): { readonly game: NflverseScheduleGame | null; readonly reason?: RejectionReason } {
  const gameId = nullableString(row.game_id, 64);
  const season = boundedInteger(row.season, 1999, 2200);
  const week = boundedInteger(row.week, 1, 25);
  const gameType = normalizeGameType(row.game_type);
  if (
    season !== expectedSeason ||
    !gameId ||
    !/^[A-Za-z0-9_.-]{1,64}$/u.test(gameId) ||
    week === null ||
    !gameType
  ) {
    return { game: null, reason: "invalidContext" };
  }

  const awayTeam = normalizeTeam(row.away_team);
  const homeTeam = normalizeTeam(row.home_team);
  if (!awayTeam || !homeTeam || awayTeam === homeTeam) {
    return { game: null, reason: "invalidTeams" };
  }

  const gameDate = normalizeDate(row.gameday);
  const time = normalizeTime(row.gametime);
  const venueRaw = nullableString(row.location, 16)?.toUpperCase();
  const venue = venueRaw === "HOME" ? "home" : venueRaw === "NEUTRAL" ? "neutral" : null;
  if (!gameDate || !time.valid || !venue) {
    return { game: null, reason: "invalidTiming" };
  }

  const awayScore = optionalInteger(row.away_score, 0, 100);
  const homeScore = optionalInteger(row.home_score, 0, 100);
  const awayRestDays = optionalInteger(row.away_rest, 0, 30);
  const homeRestDays = optionalInteger(row.home_rest, 0, 30);
  if (
    !awayScore.valid ||
    !homeScore.valid ||
    (awayScore.value === null) !== (homeScore.value === null) ||
    !awayRestDays.valid ||
    !homeRestDays.valid
  ) {
    return { game: null, reason: "invalidResult" };
  }

  return {
    game: {
      gameId,
      season,
      week,
      seasonType: gameType.seasonType,
      gameType: gameType.gameType,
      gameDate,
      startTimeEastern: time.value,
      timeTbd: time.value === null,
      awayTeam,
      homeTeam,
      awayScore: awayScore.value,
      homeScore: homeScore.value,
      awayRestDays: awayRestDays.value,
      homeRestDays: homeRestDays.value,
      venue,
      status: awayScore.value === null ? "scheduled" : "final",
    },
  };
}

export function expandNflverseTeamScheduleGames(
  games: readonly NflverseScheduleGame[],
): readonly NflverseTeamScheduleGame[] {
  return games.flatMap((game) => [
    {
      gameId: game.gameId,
      season: game.season,
      week: game.week,
      seasonType: game.seasonType,
      gameType: game.gameType,
      gameDate: game.gameDate,
      startTimeEastern: game.startTimeEastern,
      timeTbd: game.timeTbd,
      team: game.awayTeam,
      opponentTeam: game.homeTeam,
      side: "away" as const,
      isNeutralSite: game.venue === "neutral",
      teamScore: game.awayScore,
      opponentScore: game.homeScore,
      teamRestDays: game.awayRestDays,
      opponentRestDays: game.homeRestDays,
      status: game.status,
    },
    {
      gameId: game.gameId,
      season: game.season,
      week: game.week,
      seasonType: game.seasonType,
      gameType: game.gameType,
      gameDate: game.gameDate,
      startTimeEastern: game.startTimeEastern,
      timeTbd: game.timeTbd,
      team: game.homeTeam,
      opponentTeam: game.awayTeam,
      side: "home" as const,
      isNeutralSite: game.venue === "neutral",
      teamScore: game.homeScore,
      opponentScore: game.awayScore,
      teamRestDays: game.homeRestDays,
      opponentRestDays: game.awayRestDays,
      status: game.status,
    },
  ]);
}

function normalizeSeasonTypes(
  requested: readonly NflverseScheduleSeasonType[] | undefined,
): readonly NflverseScheduleSeasonType[] {
  const values = requested ?? ["REG", "POST"];
  if (
    values.length === 0 ||
    values.some((value) => value !== "REG" && value !== "POST") ||
    new Set(values).size !== values.length
  ) {
    throw new NflverseDatasetSourceError(
      "INVALID_CONTEXT",
      "Schedule season types must be a non-empty, unique REG/POST selection",
    );
  }
  return [...values].sort();
}

function parseSchedules(
  body: string,
  season: number,
  requestedSeasonTypes: readonly NflverseScheduleSeasonType[],
) {
  const artifactRows = parseCsv(body);
  const seasonRows = artifactRows.filter(
    (row) => boundedInteger(row.season, 1999, 2200) === season,
  );
  if (seasonRows.length === 0) {
    throw new NflverseDatasetSourceError(
      "NOT_AVAILABLE",
      `nflverse schedules do not contain season ${season}`,
    );
  }

  const games: NflverseScheduleGame[] = [];
  const rejectionCounts: Record<RejectionReason, number> = {
    invalidContext: 0,
    invalidTeams: 0,
    invalidTiming: 0,
    invalidResult: 0,
    duplicate: 0,
    teamWeekConflict: 0,
  };
  const seenGames = new Set<string>();
  const seenTeamWeeks = new Set<string>();
  let rowsRead = 0;

  for (const row of seasonRows) {
    const normalizedType = normalizeGameType(row.game_type);
    if (normalizedType && !requestedSeasonTypes.includes(normalizedType.seasonType)) continue;
    rowsRead += 1;
    const normalized = normalizeRow(row, season);
    if (!normalized.game) {
      rejectionCounts[normalized.reason ?? "invalidContext"] += 1;
      continue;
    }
    if (seenGames.has(normalized.game.gameId)) {
      rejectionCounts.duplicate += 1;
      continue;
    }
    const awayKey = `${normalized.game.seasonType}:${normalized.game.week}:${normalized.game.awayTeam}`;
    const homeKey = `${normalized.game.seasonType}:${normalized.game.week}:${normalized.game.homeTeam}`;
    if (seenTeamWeeks.has(awayKey) || seenTeamWeeks.has(homeKey)) {
      rejectionCounts.teamWeekConflict += 1;
      continue;
    }
    seenGames.add(normalized.game.gameId);
    seenTeamWeeks.add(awayKey);
    seenTeamWeeks.add(homeKey);
    games.push(normalized.game);
  }

  const rowsRejected = Object.values(rejectionCounts).reduce((sum, count) => sum + count, 0);
  if (rowsRead === 0) {
    throw new NflverseDatasetSourceError(
      "NOT_AVAILABLE",
      `nflverse schedules do not contain the requested ${requestedSeasonTypes.join("/")} games for ${season}`,
    );
  }
  // Schedule rows are low-volume, structurally critical projection inputs. Unlike bulk player
  // stats, a partially rejected schedule is not safe to publish as a last-known-good replacement.
  if (rowsRejected > 0) {
    throw new NflverseDatasetSourceError(
      "QUALITY_THRESHOLD",
      `nflverse schedules rejected ${rowsRejected} of ${rowsRead} selected rows`,
    );
  }
  if (games.length === 0) {
    throw new NflverseDatasetSourceError(
      "NOT_AVAILABLE",
      `nflverse schedules do not contain the requested ${requestedSeasonTypes.join("/")} games for ${season}`,
    );
  }

  games.sort(
    (left, right) =>
      left.week - right.week ||
      left.gameDate.localeCompare(right.gameDate) ||
      left.gameId.localeCompare(right.gameId),
  );
  const teamGames = expandNflverseTeamScheduleGames(games);
  return {
    games,
    teamGames,
    artifactRowsRead: artifactRows.length,
    rowsRead,
    rowsRejected,
    rejections: rejectionCounts,
    coveredWeeks: [...new Set(games.map((game) => game.week))].sort((a, b) => a - b),
    coveredSeasonTypes: [...new Set(games.map((game) => game.seasonType))].sort(),
    coveredTeams: [...new Set(teamGames.map((game) => game.team))].sort(),
  };
}

export class NflverseSchedulesSource {
  readonly #fetch: NflverseFetchLike;
  readonly #now: () => Date;

  constructor(options: { readonly fetch?: NflverseFetchLike; readonly now?: () => Date } = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? (() => new Date());
  }

  async check(
    season: number,
    previous: NflverseSchedulesState,
    options: NflverseScheduleCheckOptions = {},
  ): Promise<NflverseSchedulesCheckResult> {
    assertNflverseSeason(season, 1999);
    const requestedSeasonTypes = normalizeSeasonTypes(options.seasonTypes);
    const selectionKey = `${season}:${requestedSeasonTypes.join("+")}`;
    const contextPrevious: NflverseDatasetState =
      previous.selectionKey === selectionKey
        ? previous
        : { etag: null, lastModified: null, checksumSha256: null };
    const result = await checkNflverseCsvRelease({
      fetch: this.#fetch,
      now: this.#now,
      sourceUrl: NFLVERSE_SCHEDULES_URL,
      previous: contextPrevious,
      maximumBytes: MAX_RESPONSE_BYTES,
      datasetLabel: "nflverse schedules",
    });
    const base = {
      checkedAt: result.checkedAt,
      sourceKey: NFLVERSE_SCHEDULES_SOURCE_KEY,
      sourceUrl: NFLVERSE_SCHEDULES_URL,
      upstreamUrl: NFLVERSE_SCHEDULES_UPSTREAM_URL,
      attribution: NFLVERSE_SCHEDULES_ATTRIBUTION,
      attributionUrl: NFLVERSE_SCHEDULES_ATTRIBUTION_URL,
      license: NFLVERSE_DATA_LICENSE,
      season,
      requestedSeasonTypes,
      selectionKey,
      etag: result.etag,
      lastModified: result.lastModified,
      checksumSha256: result.checksumSha256,
    };
    if (result.state === "unchanged") return { state: "unchanged", ...base };
    return {
      state: "changed",
      ...base,
      checksumSha256: result.checksumSha256,
      ...parseSchedules(result.body, season, requestedSeasonTypes),
    };
  }
}
