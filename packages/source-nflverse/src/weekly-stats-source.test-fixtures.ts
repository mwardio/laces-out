import {
  NFLVERSE_PLAY_BY_PLAY_ATTRIBUTION,
  NFLVERSE_PLAY_BY_PLAY_ATTRIBUTION_URL,
  NFLVERSE_PLAY_BY_PLAY_SOURCE_KEY,
  type NflversePlayByPlayLoader,
  type NflversePlayByPlayResult,
} from "./play-by-play-source.js";

/** Explicit toy PBP aggregate for the two-player parser fixture; no source fetch is simulated. */
export function weeklyStatsPlayByPlayFixture(): NflversePlayByPlayResult {
  const context = { season: 2025, week: 1, seasonType: "REG" as const, gameId: "2025_01_CHI_GB" };
  const empty = {
    ...context,
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
  return {
    checkedAt: "2026-07-21T15:00:00.000Z",
    season: 2025,
    sourceKey: NFLVERSE_PLAY_BY_PLAY_SOURCE_KEY,
    sourceUrl:
      "https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_2025.csv.gz",
    attribution: NFLVERSE_PLAY_BY_PLAY_ATTRIBUTION,
    attributionUrl: NFLVERSE_PLAY_BY_PLAY_ATTRIBUTION_URL,
    license: "CC BY 4.0",
    etag: null,
    lastModified: null,
    checksumSha256: "b".repeat(64),
    observations: [
      { ...context, team: "CHI", opponentTeam: "GB", fourthDownStops: 0 },
      { ...context, team: "GB", opponentTeam: "CHI", fourthDownStops: 0 },
    ],
    rowsRead: 3,
    rowsRejected: 0,
    coveredGames: 1,
    playerTouchdowns: [
      { ...empty, gsisId: "00-0039999", receiving_touchdowns: 1, receiving_touchdowns_40_plus: 1 },
      {
        ...empty,
        gsisId: "00-0038888",
        passing_touchdowns: 2,
        passing_touchdowns_40_plus: 1,
        passing_touchdowns_50_plus: 1,
      },
    ],
  };
}
export const weeklyStatsPlayByPlayLoader: NflversePlayByPlayLoader = {
  load: () => Promise.resolve(weeklyStatsPlayByPlayFixture()),
};
