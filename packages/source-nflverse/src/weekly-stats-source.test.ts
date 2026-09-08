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

function replaceCell(body: string, playerId: string, column: string, value: string): string {
  const rows = body
    .trimEnd()
    .split("\n")
    .map((line) => line.split(","));
  const header = rows[0] ?? [];
  const playerIndex = header.indexOf("player_id");
  const columnIndex = header.indexOf(column);
  const row = rows.find((candidate, index) => index > 0 && candidate[playerIndex] === playerId);
  if (!row || columnIndex < 0) throw new Error(`Fixture omitted ${playerId}:${column}`);
  row[columnIndex] = value;
  return rows.map((candidate) => candidate.join(",")).join("\n");
}

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

  it("versions the normalized observation checksum independently from unchanged upstream bytes", async () => {
    const source = new NflverseWeeklyStatsSource({
      fetch: () => Promise.resolve(new Response(fixture)),
    });
    const first = await source.check(2025, EMPTY_STATE);
    if (first.state !== "changed") throw new Error("Expected changed player stats");

    const second = await source.check(2025, {
      etag: null,
      lastModified: null,
      checksumSha256: first.checksumSha256,
    });

    expect(second).toMatchObject({
      state: "unchanged",
      checksumSha256: first.checksumSha256,
    });
  });

  it("retains exact kicker miss buckets and total made-field-goal distance", async () => {
    const playerId = "00-0039999";
    let kicker = replaceCell(fixture, playerId, "position", "K");
    kicker = replaceCell(kicker, playerId, "position_group", "SPEC");
    kicker = replaceCell(kicker, playerId, "fg_made", "2");
    kicker = replaceCell(kicker, playerId, "fg_att", "4");
    kicker = replaceCell(kicker, playerId, "fg_missed", "2");
    kicker = replaceCell(kicker, playerId, "fg_made_20_29", "1");
    kicker = replaceCell(kicker, playerId, "fg_made_50_59", "1");
    kicker = replaceCell(kicker, playerId, "fg_missed_0_19", "1");
    kicker = replaceCell(kicker, playerId, "fg_missed_20_29", "1");
    kicker = replaceCell(kicker, playerId, "fg_made_distance", "79");
    const source = new NflverseWeeklyStatsSource({
      fetch: () => Promise.resolve(new Response(kicker)),
    });

    const result = await source.check(2025, EMPTY_STATE);
    if (result.state !== "changed") throw new Error("Expected changed player stats");
    expect(result.observations[0]?.components).toMatchObject({
      field_goals_missed_0_19: 1,
      field_goals_missed_20_29: 1,
      field_goals_total_yards: 79,
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
