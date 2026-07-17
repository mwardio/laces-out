import { describe, expect, it } from "vitest";

import { NFLVERSE_PLAYERS_URL, NflversePlayersSource } from "./players-source.js";

const csv = `gsis_id,display_name,first_name,last_name,espn_id,position,position_group,latest_team,status,birth_date,rookie_season,last_season
00-0039999,Example Runner,Example,Runner,12345,RB,RB,CHI,ACT,2000-01-02,2024,2026
bad,Rejected Player,Rejected,Player,,QB,QB,FA,RET,,2010,2020
`;

describe("NflversePlayersSource", () => {
  it("conditionally checks, validates, and normalizes the official player catalog", async () => {
    const requests: Array<{ readonly url: string; readonly headers: Headers }> = [];
    const source = new NflversePlayersSource({
      now: () => new Date("2026-07-16T22:00:00.000Z"),
      fetch: (input, init) => {
        requests.push({
          url: input.toString(),
          headers: new Headers(init?.headers),
        });
        return Promise.resolve(
          new Response(csv, {
            status: 200,
            headers: { "content-type": "text/csv", etag: '"players-v2"' },
          }),
        );
      },
    });
    const result = await source.check({
      etag: '"players-v1"',
      lastModified: null,
      checksumSha256: null,
    });
    expect(requests[0]?.url).toBe(NFLVERSE_PLAYERS_URL);
    expect(requests[0]?.headers.get("if-none-match")).toBe('"players-v1"');
    expect(result).toMatchObject({ state: "changed", rowsRead: 2, rowsRejected: 1 });
    if (result.state === "changed") {
      expect(result.players).toEqual([
        expect.objectContaining({
          gsisId: "00-0039999",
          displayName: "Example Runner",
          espnId: "12345",
          latestTeam: "CHI",
        }),
      ]);
    }
  });

  it("records a daily check without reparsing a 304 response", async () => {
    const source = new NflversePlayersSource({
      fetch: () => Promise.resolve(new Response(null, { status: 304 })),
    });
    const result = await source.check({
      etag: '"same"',
      lastModified: "Wed, 15 Jul 2026 10:00:00 GMT",
      checksumSha256: "a".repeat(64),
    });
    expect(result).toMatchObject({ state: "unchanged", checksumSha256: "a".repeat(64) });
  });

  it("rejects redirects outside the fixed GitHub asset hosts", async () => {
    const source = new NflversePlayersSource({
      fetch: () =>
        Promise.resolve(
          new Response(null, { status: 302, headers: { location: "https://attacker.example/a" } }),
        ),
    });
    await expect(
      source.check({ etag: null, lastModified: null, checksumSha256: null }),
    ).rejects.toMatchObject({ code: "REDIRECT" });
  });
});
