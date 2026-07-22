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

export const NFLVERSE_SNAP_COUNTS_SOURCE_KEY = "nflverse.snap-counts" as const;
export const NFLVERSE_SNAP_COUNTS_ATTRIBUTION =
  "Snap counts provided by nflverse from Pro Football Reference (CC BY 4.0)" as const;
export const NFLVERSE_SNAP_COUNTS_ATTRIBUTION_URL = NFLVERSE_DATA_REPOSITORY_URL;

const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;
const MAX_ROWS = 75_000;
const ABSOLUTE_REJECTION_ALLOWANCE = 25;
const MAXIMUM_REJECTION_RATIO = 0.02;

export type NflverseSnapGameType = "REG" | "WC" | "DIV" | "CON" | "SB";

export interface NflversePlayerSnapCount {
  readonly gameId: string;
  readonly pfrGameId: string;
  readonly season: number;
  readonly seasonType: NflverseSeasonType;
  readonly gameType: NflverseSnapGameType;
  readonly week: number;
  readonly playerName: string;
  readonly pfrPlayerId: string;
  readonly position: string;
  readonly team: string;
  readonly opponentTeam: string;
  readonly offense: { readonly snaps: number; readonly share: number };
  readonly defense: { readonly snaps: number; readonly share: number };
  readonly specialTeams: { readonly snaps: number; readonly share: number };
}

export interface NflverseSnapCountRejections {
  readonly invalidIdentity: number;
  readonly invalidContext: number;
  readonly invalidCounts: number;
  readonly duplicate: number;
}

interface NflverseSnapCountsBaseResult {
  readonly checkedAt: string;
  readonly sourceKey: typeof NFLVERSE_SNAP_COUNTS_SOURCE_KEY;
  readonly sourceUrl: string;
  readonly attribution: typeof NFLVERSE_SNAP_COUNTS_ATTRIBUTION;
  readonly attributionUrl: typeof NFLVERSE_SNAP_COUNTS_ATTRIBUTION_URL;
  readonly license: typeof NFLVERSE_DATA_LICENSE;
  readonly season: number;
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly checksumSha256: string | null;
}

export type NflverseSnapCountsCheckResult =
  | (NflverseSnapCountsBaseResult & {
      readonly state: "changed";
      readonly checksumSha256: string;
      readonly observations: readonly NflversePlayerSnapCount[];
      readonly rowsRead: number;
      readonly rowsRejected: number;
      readonly rejections: NflverseSnapCountRejections;
      readonly coveredWeeks: readonly number[];
      readonly coveredSeasonTypes: readonly NflverseSeasonType[];
    })
  | (NflverseSnapCountsBaseResult & { readonly state: "unchanged" });

export function buildNflverseSnapCountsUrl(season: number): string {
  assertNflverseSeason(season, 2012);
  return `https://github.com/nflverse/nflverse-data/releases/download/snap_counts/snap_counts_${season}.csv`;
}

function nullableString(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maximum ? normalized : null;
}

function integer(value: unknown, minimum: number, maximum: number): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function share(value: unknown): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1
    ? Object.is(parsed, -0)
      ? 0
      : parsed
    : null;
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
      max_record_size: 64 * 1024,
    });
  } catch {
    throw new NflverseDatasetSourceError("INVALID_CSV", "nflverse snap counts are malformed CSV");
  }
  if (rows.length === 0 || rows.length > MAX_ROWS) {
    throw new NflverseDatasetSourceError("INVALID_CSV", "nflverse snap-count row count is invalid");
  }
  const headers = new Set(Object.keys(rows[0] ?? {}));
  for (const required of REQUIRED_COLUMNS) {
    if (!headers.has(required)) {
      throw new NflverseDatasetSourceError(
        "INVALID_CSV",
        `nflverse snap counts omitted required column ${required}`,
      );
    }
  }
  return rows;
}

const REQUIRED_COLUMNS = [
  "game_id",
  "pfr_game_id",
  "season",
  "game_type",
  "week",
  "player",
  "pfr_player_id",
  "position",
  "team",
  "opponent",
  "offense_snaps",
  "offense_pct",
  "defense_snaps",
  "defense_pct",
  "st_snaps",
  "st_pct",
] as const;

type RejectionReason = keyof NflverseSnapCountRejections;

function normalizeRow(
  row: Record<string, string>,
  expectedSeason: number,
): { readonly observation: NflversePlayerSnapCount | null; readonly reason?: RejectionReason } {
  const playerName = nullableString(row.player, 160);
  const pfrPlayerId = nullableString(row.pfr_player_id, 20);
  const playerPosition = position(row.position);
  if (
    !playerName ||
    !pfrPlayerId ||
    !/^[A-Za-z0-9.-]{1,20}$/u.test(pfrPlayerId) ||
    !playerPosition
  ) {
    return { observation: null, reason: "invalidIdentity" };
  }

  const season = integer(row.season, 2012, 2200);
  const week = integer(row.week, 1, 25);
  const gameType = nullableString(row.game_type, 4)?.toUpperCase();
  const gameId = nullableString(row.game_id, 64);
  const pfrGameId = nullableString(row.pfr_game_id, 32);
  const playerTeam = team(row.team);
  const opponentTeam = team(row.opponent);
  if (
    season !== expectedSeason ||
    week === null ||
    (gameType !== "REG" &&
      gameType !== "WC" &&
      gameType !== "DIV" &&
      gameType !== "CON" &&
      gameType !== "SB") ||
    !gameId ||
    !/^[A-Za-z0-9_.-]{1,64}$/u.test(gameId) ||
    !pfrGameId ||
    !/^[A-Za-z0-9_.-]{1,32}$/u.test(pfrGameId) ||
    !playerTeam ||
    !opponentTeam
  ) {
    return { observation: null, reason: "invalidContext" };
  }

  const offenseSnaps = integer(row.offense_snaps, 0, 250);
  const offenseShare = share(row.offense_pct);
  const defenseSnaps = integer(row.defense_snaps, 0, 250);
  const defenseShare = share(row.defense_pct);
  const specialTeamsSnaps = integer(row.st_snaps, 0, 250);
  const specialTeamsShare = share(row.st_pct);
  if (
    offenseSnaps === null ||
    offenseShare === null ||
    defenseSnaps === null ||
    defenseShare === null ||
    specialTeamsSnaps === null ||
    specialTeamsShare === null ||
    (offenseSnaps === 0 && offenseShare !== 0) ||
    (defenseSnaps === 0 && defenseShare !== 0) ||
    (specialTeamsSnaps === 0 && specialTeamsShare !== 0)
  ) {
    return { observation: null, reason: "invalidCounts" };
  }

  return {
    observation: {
      gameId,
      pfrGameId,
      season,
      seasonType: gameType === "REG" ? "REG" : "POST",
      gameType,
      week,
      playerName,
      pfrPlayerId,
      position: playerPosition,
      team: playerTeam,
      opponentTeam,
      offense: { snaps: offenseSnaps, share: offenseShare },
      defense: { snaps: defenseSnaps, share: defenseShare },
      specialTeams: { snaps: specialTeamsSnaps, share: specialTeamsShare },
    },
  };
}

function parseSnapCounts(body: string, season: number) {
  const rows = parseCsv(body);
  const observations: NflversePlayerSnapCount[] = [];
  const rejectionCounts: Record<RejectionReason, number> = {
    invalidIdentity: 0,
    invalidContext: 0,
    invalidCounts: 0,
    duplicate: 0,
  };
  const seen = new Set<string>();
  for (const row of rows) {
    const normalized = normalizeRow(row, season);
    if (!normalized.observation) {
      rejectionCounts[normalized.reason ?? "invalidCounts"] += 1;
      continue;
    }
    const key = `${normalized.observation.gameId}:${normalized.observation.pfrPlayerId}:${normalized.observation.team}`;
    if (seen.has(key)) {
      rejectionCounts.duplicate += 1;
      continue;
    }
    seen.add(key);
    observations.push(normalized.observation);
  }
  const rowsRejected = Object.values(rejectionCounts).reduce((sum, count) => sum + count, 0);
  assertAdmissionQuality({
    datasetLabel: "nflverse snap counts",
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

export class NflverseSnapCountsSource {
  readonly #fetch: NflverseFetchLike;
  readonly #now: () => Date;

  constructor(options: { readonly fetch?: NflverseFetchLike; readonly now?: () => Date } = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? (() => new Date());
  }

  async check(
    season: number,
    previous: NflverseDatasetState,
  ): Promise<NflverseSnapCountsCheckResult> {
    const sourceUrl = buildNflverseSnapCountsUrl(season);
    const result = await checkNflverseCsvRelease({
      fetch: this.#fetch,
      now: this.#now,
      sourceUrl,
      previous,
      maximumBytes: MAX_RESPONSE_BYTES,
      datasetLabel: "nflverse snap counts",
    });
    const base = {
      checkedAt: result.checkedAt,
      sourceKey: NFLVERSE_SNAP_COUNTS_SOURCE_KEY,
      sourceUrl,
      attribution: NFLVERSE_SNAP_COUNTS_ATTRIBUTION,
      attributionUrl: NFLVERSE_SNAP_COUNTS_ATTRIBUTION_URL,
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
      ...parseSnapCounts(result.body, season),
    };
  }
}
