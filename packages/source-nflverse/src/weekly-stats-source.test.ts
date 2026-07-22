import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  NFLVERSE_WEEKLY_STATS_SOURCE_KEY,
  NflverseDatasetSourceError,
  NflverseWeeklyStatsSource,
  buildNflverseWeeklyStatsUrl,
  type NflverseDatasetState,
} from "./index.js";

const fixture = readFileSync(
  new URL("./fixtures/player-weekly-stats.csv", import.meta.url),
  "utf8",
);
const EMPTY_STATE: NflverseDatasetState = {
  etag: null,
  lastModified: null,
  checksumSha256: null,
};

describe("NflverseWeeklyStatsSource", () => {
  it("normalizes an official weekly-stat CSV into scoring and usage observations", async () => {
    const requests: Array<{ readonly url: string; readonly headers: Headers }> = [];
    const source = new NflverseWeeklyStatsSource({
      now: () => new Date("2026-07-21T15:00:00.000Z"),
      fetch: (input, init) => {
        requests.push({ url: input.toString(), headers: new Headers(init?.headers) });
        return Promise.resolve(
          new Response(fixture, {
            headers: {
              "content-type": "text/csv; charset=utf-8",
              etag: '"stats-2025-v2"',
              "last-modified": "Tue, 21 Jul 2026 14:00:00 GMT",
            },
          }),
        );
      },
    });

    const result = await source.check(2025, {
      ...EMPTY_STATE,
      etag: '"stats-2025-v1"',
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(buildNflverseWeeklyStatsUrl(2025));
    expect(requests[0]?.headers.get("if-none-match")).toBe('"stats-2025-v1"');
    expect(result).toMatchObject({
      state: "changed",
      sourceKey: NFLVERSE_WEEKLY_STATS_SOURCE_KEY,
      season: 2025,
      rowsRead: 2,
      rowsRejected: 0,
      coveredWeeks: [1],
      coveredSeasonTypes: ["REG"],
      etag: '"stats-2025-v2"',
    });
    if (result.state === "changed") {
      expect(result.checksumSha256).toMatch(/^[a-f0-9]{64}$/u);
      const receiver = result.observations[0];
      expect(receiver).toMatchObject({
        gsisId: "00-0039999",
        displayName: "Example Runner",
        team: "CHI",
        opponentTeam: "GB",
        sourceFantasyPoints: { standard: 16.3, ppr: 23.3 },
      });
      expect(receiver?.components).toMatchObject({
        receptions: 7,
        targets: 10,
        receiving_yards: 98,
        receiving_touchdowns: 1,
        fumbles_lost_total: 0,
      });
      expect(receiver?.advanced).toMatchObject({ targetShare: 0.31, airYardsShare: 0.44 });
      expect(result.observations[1]?.components).toMatchObject({
        passing_attempts: 35,
        sack_fumbles_lost: 1,
        fumbles_lost_total: 1,
      });
    }
  });

  it("conditionally checks the immutable season artifact and accepts a 304", async () => {
    const source = new NflverseWeeklyStatsSource({
      fetch: () => Promise.resolve(new Response(null, { status: 304 })),
    });
    await expect(
      source.check(2025, {
        etag: '"same"',
        lastModified: "Tue, 21 Jul 2026 14:00:00 GMT",
        checksumSha256: "a".repeat(64),
      }),
    ).resolves.toMatchObject({
      state: "unchanged",
      season: 2025,
      checksumSha256: "a".repeat(64),
    });
  });

  it("accounts for duplicate observations without admitting them", async () => {
    const [header, row, ...remaining] = fixture.trimEnd().split("\n");
    const body = [header, row, ...remaining, row].join("\n");
    const source = new NflverseWeeklyStatsSource({
      fetch: () => Promise.resolve(new Response(body)),
    });
    const result = await source.check(2025, EMPTY_STATE);
    expect(result).toMatchObject({
      state: "changed",
      rowsRead: 3,
      rowsRejected: 1,
      rejections: { duplicate: 1 },
    });
    if (result.state === "changed") expect(result.observations).toHaveLength(2);
  });

  it("fails closed when row rejections exceed the admission threshold", async () => {
    const [header, valid] = fixture.trimEnd().split("\n");
    const invalid = valid?.replace("00-0039999", "invalid-id") ?? "";
    const body = [header, valid, ...Array.from({ length: 26 }, () => invalid)].join("\n");
    const source = new NflverseWeeklyStatsSource({
      fetch: () => Promise.resolve(new Response(body)),
    });
    await expect(source.check(2025, EMPTY_STATE)).rejects.toMatchObject({
      code: "QUALITY_THRESHOLD",
      retryable: false,
    });
  });

  it.each([
    {
      name: "redirect to an unapproved host",
      response: new Response(null, {
        status: 302,
        headers: { location: "https://attacker.example/stats.csv" },
      }),
      code: "REDIRECT",
    },
    {
      name: "unexpected response type",
      response: new Response(fixture, { headers: { "content-type": "text/html" } }),
      code: "CONTENT_TYPE",
    },
    {
      name: "season artifact that is not published yet",
      response: new Response(null, { status: 404 }),
      code: "NOT_AVAILABLE",
    },
    {
      name: "oversized declared response",
      response: new Response(fixture, {
        headers: { "content-length": String(24 * 1024 * 1024 + 1) },
      }),
      code: "TOO_LARGE",
    },
  ])("rejects $name", async ({ response, code }) => {
    const source = new NflverseWeeklyStatsSource({
      fetch: () => Promise.resolve(response.clone()),
    });
    const error = await source.check(2025, EMPTY_STATE).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NflverseDatasetSourceError);
    expect(error).toMatchObject({ code, retryable: false });
  });

  it("validates season context before fetching", async () => {
    let fetched = false;
    const source = new NflverseWeeklyStatsSource({
      fetch: () => {
        fetched = true;
        return Promise.resolve(new Response(fixture));
      },
    });
    await expect(source.check(1998, EMPTY_STATE)).rejects.toMatchObject({
      code: "INVALID_CONTEXT",
    });
    expect(fetched).toBe(false);
  });
});
