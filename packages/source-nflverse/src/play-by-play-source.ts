import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";

import { parse } from "csv-parse";

import {
  NFLVERSE_DEFENSE_SCORING_EVENT_COLUMNS,
  defenseScoringRowsChecksum,
  extractNflverseDefenseScoringEvents,
  type DefenseScoringRow,
} from "./defense-scoring-events.js";
import {
  NFLVERSE_FOURTH_DOWN_STOPS_SOURCE_KEY,
  NFLVERSE_FOURTH_DOWN_STOPS_ATTRIBUTION,
  type NflverseFourthDownSeasonType,
  type NflverseFourthDownStopObservation,
  type NflverseFourthDownStopsLoader,
} from "./fourth-down-stops-source.js";

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

export const NFLVERSE_PLAY_BY_PLAY_SOURCE_KEY = "nflverse.play-by-play.football-events" as const;
export const NFLVERSE_PLAY_BY_PLAY_ATTRIBUTION =
  "Football events derived from nflverse play-by-play (CC BY 4.0)" as const;
export const NFLVERSE_PLAY_BY_PLAY_ATTRIBUTION_URL = NFLVERSE_DATA_REPOSITORY_URL;

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
  "play_type",
  "two_point_attempt",
  "play_deleted",
  "pass_touchdown",
  "rush_touchdown",
  "passer_player_id",
  "receiver_player_id",
  "rusher_player_id",
  "td_player_id",
  "passing_yards",
  "receiving_yards",
  "rushing_yards",
  "lateral_receiver_player_id",
  "lateral_rusher_player_id",
  "lateral_receiving_yards",
  "lateral_rushing_yards",
  ...NFLVERSE_DEFENSE_SCORING_EVENT_COLUMNS,
] as const;

export type NflverseDefenseScoringEvents = ReturnType<typeof extractNflverseDefenseScoringEvents>;

export interface NflversePlayerTouchdownObservation {
  readonly gsisId: string;
  readonly season: number;
  readonly week: number;
  readonly seasonType: "REG" | "POST";
  readonly gameId: string;
  readonly passing_touchdowns: number;
  readonly rushing_touchdowns: number;
  readonly receiving_touchdowns: number;
  readonly passing_touchdowns_40_plus: number;
  readonly passing_touchdowns_50_plus: number;
  readonly rushing_touchdowns_40_plus: number;
  readonly rushing_touchdowns_50_plus: number;
  readonly receiving_touchdowns_40_plus: number;
  readonly receiving_touchdowns_50_plus: number;
}

export interface NflversePlayByPlayResult {
  readonly checkedAt: string;
  readonly sourceKey: typeof NFLVERSE_PLAY_BY_PLAY_SOURCE_KEY;
  readonly sourceUrl: string;
  readonly attribution: typeof NFLVERSE_PLAY_BY_PLAY_ATTRIBUTION;
  readonly attributionUrl: typeof NFLVERSE_PLAY_BY_PLAY_ATTRIBUTION_URL;
  readonly license: typeof NFLVERSE_DATA_LICENSE;
  readonly season: number;
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly checksumSha256: string;
  readonly observations: readonly NflverseFourthDownStopObservation[];
  readonly rowsRead: number;
  readonly rowsRejected: number;
  readonly coveredGames: number;
  readonly playerTouchdowns: readonly NflversePlayerTouchdownObservation[];
  /** Legacy custom loaders may lack this capability; defense consumers must require it. */
  readonly defenseScoringEvents?: readonly NflverseDefenseScoringEvents[];
}

export interface NflversePlayByPlayLoader {
  load(season: number): Promise<NflversePlayByPlayResult>;
}

export function buildNflversePlayByPlayUrl(season: number): string {
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

async function parsePlayByPlay(
  response: Response,
  season: number,
  checkedAt: string,
): Promise<{
  readonly checksumSha256: string;
  readonly observations: readonly NflverseFourthDownStopObservation[];
  readonly rowsRead: number;
  readonly rowsRejected: number;
  readonly coveredGames: number;
  readonly playerTouchdowns: readonly NflversePlayerTouchdownObservation[];
  readonly defenseScoringEvents: readonly NflverseDefenseScoringEvents[];
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
      readonly scoringRows: DefenseScoringRow[];
    }
  >();
  const seenPlays = new Set<string>();
  const touchdowns = new Map<
    string,
    {
      -readonly [
        K in keyof NflversePlayerTouchdownObservation
      ]: NflversePlayerTouchdownObservation[K];
    }
  >();
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
        scoringRows: [],
      };
      games.set(gameId, game);
      // Retain every selected game row, including administrative/cancelled plays. The scoring
      // extractor needs a complete score ledger, not a prefiltered set of touchdown flags.
      game.scoringRows.push(
        Object.fromEntries(NFLVERSE_DEFENSE_SCORING_EVENT_COLUMNS.map((key) => [key, row[key]!])),
      );
      if (failed === 1 && defense) {
        game.stops.set(defense, (game.stops.get(defense) ?? 0) + 1);
      }
      const passTd = failedFourthDown(row.pass_touchdown);
      const rushTd = failedFourthDown(row.rush_touchdown);
      const twoPoint = failedFourthDown(row.two_point_attempt);
      const deleted = failedFourthDown(row.play_deleted);
      if (
        passTd === null ||
        rushTd === null ||
        twoPoint === null ||
        deleted === null ||
        (passTd === 1 && rushTd === 1)
      ) {
        rowsRejected += 1;
        continue;
      }
      if (passTd !== 1 && rushTd !== 1) continue;
      // Positive TD flags on erased/conversion plays are ambiguous source data, never zero events.
      if (row.play_type === "no_play" || twoPoint === 1 || deleted === 1) {
        rowsRejected += 1;
        continue;
      }
      const credit = (
        family: "passing" | "rushing" | "receiving",
        player: unknown,
        distance: unknown,
      ) => {
        const gsisId = boundedText(player, 32);
        const yards = boundedInteger(distance, 0, 110);
        if (!gsisId || !/^\d{2}-\d{7}$/u.test(gsisId) || yards === null) {
          rowsRejected += 1;
          return;
        }
        const key = `${gameId}:${gsisId}`;
        const totals = touchdowns.get(key) ?? {
          gsisId,
          season,
          week,
          seasonType,
          gameId,
          passing_touchdowns: 0,
          rushing_touchdowns: 0,
          receiving_touchdowns: 0,
          passing_touchdowns_40_plus: 0,
          passing_touchdowns_50_plus: 0,
          rushing_touchdowns_40_plus: 0,
          rushing_touchdowns_50_plus: 0,
          receiving_touchdowns_40_plus: 0,
          receiving_touchdowns_50_plus: 0,
        };
        totals[`${family}_touchdowns`] += 1;
        totals[`${family}_touchdowns_40_plus`] += Number(yards >= 40);
        totals[`${family}_touchdowns_50_plus`] += Number(yards >= 50);
        touchdowns.set(key, totals);
      };
      const creditedDistance = (family: "receiving" | "rushing") => {
        const primary = family === "receiving" ? row.receiver_player_id : row.rusher_player_id;
        const lateral =
          family === "receiving" ? row.lateral_receiver_player_id : row.lateral_rusher_player_id;
        if (row.td_player_id === lateral) return row[`lateral_${family}_yards`];
        if (row.td_player_id === primary) return row[`${family}_yards`];
        return undefined;
      };
      if (passTd === 1) {
        credit("passing", row.passer_player_id, row.passing_yards);
        credit("receiving", row.td_player_id, creditedDistance("receiving"));
      } else {
        credit("rushing", row.td_player_id, creditedDistance("rushing"));
      }
    }
  } catch (error) {
    if (error instanceof NflverseDatasetSourceError) throw error;
    throw new NflverseDatasetSourceError(
      "INVALID_CSV",
      "nflverse play-by-play is not a valid gzip CSV artifact",
    );
  } finally {
    compressed.destroy();
    gunzip.destroy();
    parser.destroy();
    await reader.cancel().catch(() => undefined);
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
  const checksumSha256 = checksum.digest("hex");
  const defenseScoringEvents = [...games.entries()].map(([gameId, game]) => {
    const ends = game.scoringRows.filter(
      (row) => row.play_type_nfl === "END_GAME" && row.play_deleted === "0",
    );
    const end = ends.length === 1 ? ends[0]! : null;
    const score = (value: unknown): number | null => {
      if (typeof value !== "string" || !/^\d+(?:\.0+)?$/u.test(value)) return null;
      const parsed = Number(value);
      return Number.isSafeInteger(parsed) && parsed <= 200 ? parsed : null;
    };
    const homeScore = end
      ? score(end.posteam === game.homeTeam ? end.posteam_score_post : end.defteam_score_post)
      : null;
    const awayScore = end
      ? score(end.posteam === game.awayTeam ? end.posteam_score_post : end.defteam_score_post)
      : null;
    const finality =
      end && homeScore !== null && awayScore !== null
        ? {
            gameId,
            homeTeam: game.homeTeam,
            awayTeam: game.awayTeam,
            homeScore,
            awayScore,
            observedAt: checkedAt,
            sourceChecksumSha256: checksumSha256,
          }
        : null;
    return extractNflverseDefenseScoringEvents({
      game: {
        gameId,
        season,
        week: game.week,
        seasonType: game.seasonType,
        homeTeam: game.homeTeam,
        awayTeam: game.awayTeam,
      },
      rows: game.scoringRows,
      provenance: {
        artifactChecksumSha256: checksumSha256,
        gameRowsChecksumSha256: defenseScoringRowsChecksum(game.scoringRows),
        gameRowCount: game.scoringRows.length,
        checkedAt,
        coverage: "full-game",
      },
      // Explicit END_GAME is terminal evidence from this same source, not an independent
      // scoreboard verification. Prospective weekly evaluation separately requires that proof.
      finality,
    });
  });
  return {
    checksumSha256,
    observations,
    rowsRead,
    rowsRejected,
    coveredGames: games.size,
    defenseScoringEvents,
    playerTouchdowns: [...touchdowns.values()].sort(
      (left, right) =>
        left.gameId.localeCompare(right.gameId) || left.gsisId.localeCompare(right.gsisId),
    ),
  };
}

export class NflversePlayByPlaySource implements NflversePlayByPlayLoader {
  readonly #fetch: NflverseFetchLike;
  readonly #now: () => Date;

  constructor(options: { readonly fetch?: NflverseFetchLike; readonly now?: () => Date } = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? (() => new Date());
  }

  async load(season: number): Promise<NflversePlayByPlayResult> {
    const sourceUrl = buildNflversePlayByPlayUrl(season);
    const release = await checkNflverseReleaseResponse({
      fetch: this.#fetch,
      now: this.#now,
      sourceUrl,
      previous: EMPTY_STATE,
      maximumBytes: MAX_COMPRESSED_BYTES,
      datasetLabel: "nflverse play-by-play",
      accept: "application/gzip, application/octet-stream;q=0.9",
      format: "gzip",
      timeoutMs: 60_000,
    });
    if (release.state === "unchanged") {
      throw new NflverseDatasetSourceError(
        "UPSTREAM",
        "nflverse play-by-play unexpectedly returned an unconditioned 304 response",
        true,
      );
    }
    const parsed = await parsePlayByPlay(release.response, season, release.checkedAt);
    return {
      checkedAt: release.checkedAt,
      sourceKey: NFLVERSE_PLAY_BY_PLAY_SOURCE_KEY,
      sourceUrl,
      attribution: NFLVERSE_PLAY_BY_PLAY_ATTRIBUTION,
      attributionUrl: NFLVERSE_PLAY_BY_PLAY_ATTRIBUTION_URL,
      license: NFLVERSE_DATA_LICENSE,
      season,
      etag: release.etag,
      lastModified: release.lastModified,
      ...parsed,
    };
  }
}

/** Reuse a complete PBP snapshot for team fourth-down scoring without another download/parse. */
export function fourthDownStopsFromPlayByPlay(
  source: NflversePlayByPlayLoader,
): NflverseFourthDownStopsLoader {
  return {
    async load(season) {
      const result = await source.load(season);
      return {
        ...result,
        sourceKey: NFLVERSE_FOURTH_DOWN_STOPS_SOURCE_KEY,
        attribution: NFLVERSE_FOURTH_DOWN_STOPS_ATTRIBUTION,
      };
    },
  };
}

/** Explicitly scoped to one refresh batch; a failed snapshot stays failed for the batch and never becomes cached zeros. */
export function snapshotNflversePlayByPlay(
  source: NflversePlayByPlayLoader,
  season: number,
): NflversePlayByPlayLoader {
  let pending: Promise<NflversePlayByPlayResult> | undefined;
  return {
    load(requestedSeason) {
      if (requestedSeason !== season) throw new RangeError("PBP snapshot is scoped to one season");
      pending ??= source.load(season);
      return pending;
    },
  };
}
