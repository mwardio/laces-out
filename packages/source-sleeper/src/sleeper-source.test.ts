import { describe, expect, it } from "vitest";

import {
  SLEEPER_PLAYERS_URL,
  SleeperPlayersSource,
  SleeperTrendsSource,
} from "./sleeper-source.js";

describe("SleeperPlayersSource", () => {
  it("normalizes cross-provider IDs and current player signals", async () => {
    const requests: Array<{ readonly url: string; readonly headers: Headers }> = [];
    const source = new SleeperPlayersSource({
      now: () => new Date("2026-07-17T12:00:00.000Z"),
      fetch: (input, init) => {
        requests.push({ url: input.toString(), headers: new Headers(init?.headers) });
        return Promise.resolve(
          new Response(
            JSON.stringify({
              "1234": {
                player_id: "1234",
                full_name: "Example Runner",
                first_name: "Example",
                last_name: "Runner",
                gsis_id: "00-0039999",
                espn_id: 4567,
                yahoo_id: "8910",
                position: "RB",
                fantasy_positions: ["RB"],
                team: "chi",
                status: "Active",
                injury_status: "Questionable",
                practice_participation: "Limited Participation",
                depth_chart_position: "RB",
                depth_chart_order: 1,
              },
              malformed: { player_id: "somebody-else", position: "QB" },
            }),
            { status: 200, headers: { etag: '"players-v2"' } },
          ),
        );
      },
    });

    const result = await source.check({
      etag: '"players-v1"',
      lastModified: null,
      checksumSha256: null,
    });

    expect(requests[0]?.url).toBe(SLEEPER_PLAYERS_URL);
    expect(requests[0]?.headers.get("if-none-match")).toBe('"players-v1"');
    expect(result).toMatchObject({ state: "changed", rowsRead: 2, rowsRejected: 1 });
    if (result.state === "changed") {
      expect(result.players).toEqual([
        {
          sleeperId: "1234",
          displayName: "Example Runner",
          firstName: "Example",
          lastName: "Runner",
          gsisId: "00-0039999",
          espnId: "4567",
          yahooId: "8910",
          position: "RB",
          eligiblePositions: ["RB"],
          nflTeam: "CHI",
          status: "Active",
          injuryStatus: "Questionable",
          practiceParticipation: "Limited Participation",
          depthChartPosition: "RB",
          depthChartOrder: 1,
        },
      ]);
    }
  });

  it("honors a conditional 304 response", async () => {
    const source = new SleeperPlayersSource({
      fetch: () => Promise.resolve(new Response(null, { status: 304 })),
    });
    await expect(
      source.check({ etag: '"same"', lastModified: null, checksumSha256: "a".repeat(64) }),
    ).resolves.toMatchObject({ state: "unchanged", checksumSha256: "a".repeat(64) });
  });
});

describe("SleeperTrendsSource", () => {
  it("fetches attributed add and drop momentum with fixed bounds", async () => {
    const requested: string[] = [];
    const source = new SleeperTrendsSource({
      now: () => new Date("2026-07-17T13:00:00.000Z"),
      fetch: (input) => {
        const endpoint = new URL(input);
        requested.push(endpoint.toString());
        const signal = endpoint.pathname.endsWith("/add") ? "add" : "drop";
        return Promise.resolve(
          new Response(
            JSON.stringify(
              signal === "add"
                ? [{ player_id: "1234", count: 45 }]
                : [{ player_id: "5678", count: 12 }],
            ),
            { status: 200 },
          ),
        );
      },
    });

    const result = await source.check(null);

    expect(requested).toHaveLength(2);
    expect(requested.every((url) => url.includes("lookback_hours=24&limit=50"))).toBe(true);
    expect(result).toMatchObject({ state: "changed", rowsRead: 2, rowsRejected: 0 });
    if (result.state === "changed") {
      expect(result.trends).toEqual([
        { sleeperId: "1234", signal: "add", count: 45, rank: 1 },
        { sleeperId: "5678", signal: "drop", count: 12, rank: 1 },
      ]);
    }
  });

  it("returns newly observed rows even when the market payload is unchanged", async () => {
    const payloads = [
      JSON.stringify([{ player_id: "1234", count: 45 }]),
      JSON.stringify([{ player_id: "5678", count: 12 }]),
    ];
    const source = new SleeperTrendsSource({
      fetch: (input) =>
        Promise.resolve(
          new Response(new URL(input).pathname.endsWith("/add") ? payloads[0] : payloads[1]),
        ),
    });
    const first = await source.check(null);
    const second = await source.check(first.checksumSha256);

    expect(second).toMatchObject({ state: "unchanged", rowsRead: 2 });
    expect(second.trends).toHaveLength(2);
  });
});
