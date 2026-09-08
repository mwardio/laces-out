import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  NFLVERSE_FOURTH_DOWN_STOPS_SOURCE_KEY,
  NflverseDatasetSourceError,
  NflverseFourthDownStopsSource,
  buildNflverseFourthDownStopsUrl,
} from "./index.js";

const fixture = [
  "play_id,game_id,home_team,away_team,season_type,week,defteam,fourth_down_failed,season",
  "1,2024_01_TEN_CHI,CHI,TEN,REG,1,,0,2024",
  "10,2024_01_TEN_CHI,CHI,TEN,REG,1,CHI,1,2024",
  "20,2024_01_TEN_CHI,CHI,TEN,REG,1,CHI,1,2024",
  "30,2024_01_TEN_CHI,CHI,TEN,REG,1,TEN,1,2024",
  "1,2024_19_PIT_BAL,BAL,PIT,POST,19,,0,2024",
].join("\n");

function compressedResponse(body = fixture): Response {
  return new Response(gzipSync(body), {
    headers: {
      "content-type": "application/octet-stream",
      etag: '"pbp-2024-v1"',
      "last-modified": "Tue, 21 Jul 2026 17:00:00 GMT",
    },
  });
}

describe("NflverseFourthDownStopsSource", () => {
  it("streams the compressed play-by-play artifact into exact team-game stop counts", async () => {
    const requests: Array<{ readonly url: string; readonly headers: Headers }> = [];
    const source = new NflverseFourthDownStopsSource({
      now: () => new Date("2026-07-21T18:00:00.000Z"),
      fetch: (input, init) => {
        requests.push({ url: input.toString(), headers: new Headers(init?.headers) });
        return Promise.resolve(compressedResponse());
      },
    });

    const result = await source.load(2024);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(buildNflverseFourthDownStopsUrl(2024));
    expect(requests[0]?.headers.get("accept")).toContain("application/gzip");
    expect(result).toMatchObject({
      sourceKey: NFLVERSE_FOURTH_DOWN_STOPS_SOURCE_KEY,
      season: 2024,
      checkedAt: "2026-07-21T18:00:00.000Z",
      rowsRead: 5,
      rowsRejected: 0,
      coveredGames: 2,
      etag: '"pbp-2024-v1"',
    });
    expect(result.checksumSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.observations).toEqual([
      {
        season: 2024,
        week: 1,
        seasonType: "REG",
        gameId: "2024_01_TEN_CHI",
        team: "CHI",
        opponentTeam: "TEN",
        fourthDownStops: 2,
      },
      {
        season: 2024,
        week: 1,
        seasonType: "REG",
        gameId: "2024_01_TEN_CHI",
        team: "TEN",
        opponentTeam: "CHI",
        fourthDownStops: 1,
      },
      {
        season: 2024,
        week: 19,
        seasonType: "POST",
        gameId: "2024_19_PIT_BAL",
        team: "BAL",
        opponentTeam: "PIT",
        fourthDownStops: 0,
      },
      {
        season: 2024,
        week: 19,
        seasonType: "POST",
        gameId: "2024_19_PIT_BAL",
        team: "PIT",
        opponentTeam: "BAL",
        fourthDownStops: 0,
      },
    ]);
  });

  it("fails closed on malformed gzip and incomplete play-by-play schemas", async () => {
    const malformed = new NflverseFourthDownStopsSource({
      fetch: () => Promise.resolve(new Response("not gzip")),
    });
    await expect(malformed.load(2024)).rejects.toMatchObject({ code: "INVALID_CSV" });

    const incomplete = new NflverseFourthDownStopsSource({
      fetch: () =>
        Promise.resolve(
          compressedResponse(fixture.replace(",fourth_down_failed", ",missing_flag")),
        ),
    });
    await expect(incomplete.load(2024)).rejects.toMatchObject({
      code: "INVALID_CSV",
      message: "nflverse play-by-play omitted required column fourth_down_failed",
    });
  });

  it("rejects duplicate plays rather than double-counting a stop", async () => {
    const duplicated = `${fixture}\n10,2024_01_TEN_CHI,CHI,TEN,REG,1,CHI,1,2024`;
    const source = new NflverseFourthDownStopsSource({
      fetch: () => Promise.resolve(compressedResponse(duplicated)),
    });
    const error = await source.load(2024).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NflverseDatasetSourceError);
    expect(error).toMatchObject({ code: "QUALITY_THRESHOLD" });
  });
});
