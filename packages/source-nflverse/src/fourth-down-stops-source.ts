import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";

import { parse } from "csv-parse";

import {
  NFLVERSE_DATA_LICENSE,
  NFLVERSE_DATA_REPOSITORY_URL,
  NflverseDatasetSourceError,
  assertAdmissionQuality,
  assertNflverseSeason,
  checkNflverseReleaseResponse,
  type NflverseDatasetState,
  type NflverseFetchLike,
} from "./release-source.js";

export const NFLVERSE_FOURTH_DOWN_STOPS_SOURCE_KEY =
  "nflverse.play-by-play.fourth-down-stops" as const;
export const NFLVERSE_FOURTH_DOWN_STOPS_ATTRIBUTION =
  "Fourth-down outcomes derived from nflverse play-by-play (CC BY 4.0)" as const;
export const NFLVERSE_FOURTH_DOWN_STOPS_ATTRIBUTION_URL = NFLVERSE_DATA_REPOSITORY_URL;

const MAX_COMPRESSED_BYTES = 64 * 1024 * 1024;
const MAX_ROWS = 100_000;
const MAX_COLUMNS = 400;
const MAX_RECORD_BYTES = 512 * 1024;
const EMPTY_STATE: NflverseDatasetState = {
  etag: null,
  lastModified: null,
  checksumSha256: null,
};
const REQUIRED_COLUMNS = [
  "play_id",
  "game_id",
  "season",
  "home_team",
  "away_team",
  "season_type",
  "week",
  "defteam",
  "fourth_down_failed",
] as const;

export type NflverseFourthDownSeasonType = "REG" | "POST";

export interface NflverseFourthDownStopObservation {
  readonly season: number;
  readonly week: number;
  readonly seasonType: NflverseFourthDownSeasonType;
  readonly gameId: string;
  readonly team: string;
  readonly opponentTeam: string;
  readonly fourthDownStops: number;
}

export interface NflverseFourthDownStopsResult {
  readonly checkedAt: string;
  readonly sourceKey: typeof NFLVERSE_FOURTH_DOWN_STOPS_SOURCE_KEY;
  readonly sourceUrl: string;
  readonly attribution: typeof NFLVERSE_FOURTH_DOWN_STOPS_ATTRIBUTION;
  readonly attributionUrl: typeof NFLVERSE_FOURTH_DOWN_STOPS_ATTRIBUTION_URL;
  readonly license: typeof NFLVERSE_DATA_LICENSE;
  readonly season: number;
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly checksumSha256: string;
  readonly observations: readonly NflverseFourthDownStopObservation[];
  readonly rowsRead: number;
  readonly rowsRejected: number;
  readonly coveredGames: number;
}

export interface NflverseFourthDownStopsLoader {
  load(season: number): Promise<NflverseFourthDownStopsResult>;
}

export function buildNflverseFourthDownStopsUrl(season: number): string {
  assertNflverseSeason(season, 1999);
  return `https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_${season}.csv.gz`;
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number | null {
  if (typeof value !== "string" || !/^-?\d+$/u.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function boundedText(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maximum ? normalized : null;
}

function team(value: unknown): string | null {
  const normalized = boundedText(value, 4)?.toUpperCase();
  return normalized && /^[A-Z]{2,4}$/u.test(normalized) ? normalized : null;
}

function failedFourthDown(value: unknown): 0 | 1 | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  if (normalized === "" || normalized === "NA" || normalized === "0") return 0;
  return normalized === "1" ? 1 : null;
}

async function parseFourthDownStops(
  response: Response,
  season: number,
): Promise<{
  readonly checksumSha256: string;
  readonly observations: readonly NflverseFourthDownStopObservation[];
  readonly rowsRead: number;
  readonly rowsRejected: number;
  readonly coveredGames: number;
}> {
  if (!response.body) {
    throw new NflverseDatasetSourceError(
      "INVALID_CSV",
      "nflverse play-by-play returned an empty compressed response",
    );
  }
  const checksum = createHash("sha256");
  let compressedBytes = 0;
  const reader = response.body.getReader();
  const compressed = Readable.from(
    (async function* () {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          compressedBytes += value.byteLength;
          if (compressedBytes > MAX_COMPRESSED_BYTES) {
            throw new NflverseDatasetSourceError(
              "TOO_LARGE",
              `nflverse play-by-play exceeds its ${MAX_COMPRESSED_BYTES}-byte response limit`,
            );
          }
          checksum.update(value);
          yield value;
        }
      } finally {
        reader.releaseLock();
      }
    })(),
  );

  let headers: readonly string[] = [];
  const gunzip = createGunzip();
  const parser = parse({
    bom: true,
    columns: (input: string[]) => {
      headers = input;
      const unique = new Set(input);
      if (
        input.length === 0 ||
        input.length > MAX_COLUMNS ||
        input.some((column) => column.trim() === "") ||
        unique.size !== input.length
      ) {
        throw new NflverseDatasetSourceError(
          "INVALID_CSV",
          "nflverse play-by-play contains invalid or duplicate headers",
        );
      }
      for (const required of REQUIRED_COLUMNS) {
        if (!unique.has(required)) {
          throw new NflverseDatasetSourceError(
            "INVALID_CSV",
            `nflverse play-by-play omitted required column ${required}`,
          );
        }
      }
      return input;
    },
    skip_empty_lines: true,
    relax_column_count: false,
    max_record_size: MAX_RECORD_BYTES,
  });
  compressed.on("error", (error) => gunzip.destroy(error));
  gunzip.on("error", (error) => parser.destroy(error));
  compressed.pipe(gunzip).pipe(parser);

  const games = new Map<
    string,
    {
      readonly seasonType: NflverseFourthDownSeasonType;
      readonly week: number;
      readonly homeTeam: string;
      readonly awayTeam: string;
      readonly stops: Map<string, number>;
    }
  >();
  const seenPlays = new Set<string>();
  let rowsRead = 0;
  let rowsRejected = 0;
  try {
    for await (const value of parser) {
      rowsRead += 1;
      if (rowsRead > MAX_ROWS) {
        throw new NflverseDatasetSourceError(
          "TOO_LARGE",
          `nflverse play-by-play exceeds its ${MAX_ROWS}-row limit`,
        );
      }
      const row = value as Record<string, string>;
      const rowSeason = boundedInteger(row.season, 1999, 2200);
      const week = boundedInteger(row.week, 1, 25);
      const seasonType = boundedText(row.season_type, 4)?.toUpperCase();
      const gameId = boundedText(row.game_id, 64);
      const playId = boundedText(row.play_id, 32);
      const homeTeam = team(row.home_team);
      const awayTeam = team(row.away_team);
      const failed = failedFourthDown(row.fourth_down_failed);
      const defense = team(row.defteam);
      if (
        rowSeason !== season ||
        week === null ||
        (seasonType !== "REG" && seasonType !== "POST") ||
        !gameId ||
        !/^[A-Za-z0-9_.-]{1,64}$/u.test(gameId) ||
        !playId ||
        !/^\d+(?:\.\d+)?$/u.test(playId) ||
        !homeTeam ||
        !awayTeam ||
        homeTeam === awayTeam ||
        failed === null ||
        (failed === 1 && (!defense || (defense !== homeTeam && defense !== awayTeam)))
      ) {
        rowsRejected += 1;
        continue;
      }
      const playKey = `${gameId}:${playId}`;
      if (seenPlays.has(playKey)) {
        rowsRejected += 1;
        continue;
      }
      seenPlays.add(playKey);
      const existing = games.get(gameId);
      if (
        existing &&
        (existing.week !== week ||
          existing.seasonType !== seasonType ||
          existing.homeTeam !== homeTeam ||
          existing.awayTeam !== awayTeam)
      ) {
        rowsRejected += 1;
        continue;
      }
      const game = existing ?? {
        seasonType,
        week,
        homeTeam,
        awayTeam,
        stops: new Map([
          [homeTeam, 0],
          [awayTeam, 0],
        ]),
      };
      games.set(gameId, game);
      if (failed === 1 && defense) {
        game.stops.set(defense, (game.stops.get(defense) ?? 0) + 1);
      }
    }
  } catch (error) {
    if (error instanceof NflverseDatasetSourceError) throw error;
    throw new NflverseDatasetSourceError(
      "INVALID_CSV",
      "nflverse play-by-play is not a valid gzip CSV artifact",
    );
  }
  if (headers.length === 0) {
    throw new NflverseDatasetSourceError(
      "INVALID_CSV",
      "nflverse play-by-play omitted its header row",
    );
  }
  assertAdmissionQuality({
    datasetLabel: "nflverse play-by-play",
    rowsRead,
    rowsAccepted: rowsRead - rowsRejected,
    rowsRejected,
    absoluteRejectionAllowance: 0,
    maximumRejectionRatio: 0,
  });

  const observations = [...games.entries()]
    .flatMap(([gameId, game]): NflverseFourthDownStopObservation[] => [
      {
        season,
        week: game.week,
        seasonType: game.seasonType,
        gameId,
        team: game.awayTeam,
        opponentTeam: game.homeTeam,
        fourthDownStops: game.stops.get(game.awayTeam) ?? 0,
      },
      {
        season,
        week: game.week,
        seasonType: game.seasonType,
        gameId,
        team: game.homeTeam,
        opponentTeam: game.awayTeam,
        fourthDownStops: game.stops.get(game.homeTeam) ?? 0,
      },
    ])
    .sort(
      (left, right) =>
        left.week - right.week ||
        left.seasonType.localeCompare(right.seasonType) ||
        left.team.localeCompare(right.team) ||
        left.gameId.localeCompare(right.gameId),
    );
  if (observations.length === 0) {
    throw new NflverseDatasetSourceError(
      "INVALID_CSV",
      "nflverse play-by-play contained no covered games",
    );
  }
  return {
    checksumSha256: checksum.digest("hex"),
    observations,
    rowsRead,
    rowsRejected,
    coveredGames: games.size,
  };
}

export class NflverseFourthDownStopsSource implements NflverseFourthDownStopsLoader {
  readonly #fetch: NflverseFetchLike;
  readonly #now: () => Date;

  constructor(options: { readonly fetch?: NflverseFetchLike; readonly now?: () => Date } = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? (() => new Date());
  }

  async load(season: number): Promise<NflverseFourthDownStopsResult> {
    const sourceUrl = buildNflverseFourthDownStopsUrl(season);
    const release = await checkNflverseReleaseResponse({
      fetch: this.#fetch,
      now: this.#now,
      sourceUrl,
      previous: EMPTY_STATE,
      maximumBytes: MAX_COMPRESSED_BYTES,
      datasetLabel: "nflverse play-by-play",
      accept: "application/gzip, application/octet-stream;q=0.9",
      timeoutMs: 60_000,
    });
    if (release.state === "unchanged") {
      throw new NflverseDatasetSourceError(
        "UPSTREAM",
        "nflverse play-by-play unexpectedly returned an unconditioned 304 response",
        true,
      );
    }
    const parsed = await parseFourthDownStops(release.response, season);
    return {
      checkedAt: release.checkedAt,
      sourceKey: NFLVERSE_FOURTH_DOWN_STOPS_SOURCE_KEY,
      sourceUrl,
      attribution: NFLVERSE_FOURTH_DOWN_STOPS_ATTRIBUTION,
      attributionUrl: NFLVERSE_FOURTH_DOWN_STOPS_ATTRIBUTION_URL,
      license: NFLVERSE_DATA_LICENSE,
      season,
      etag: release.etag,
      lastModified: release.lastModified,
      ...parsed,
    };
  }
}
