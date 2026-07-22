import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { NflverseDatasetSourceError, type NflverseDatasetState } from "./release-source.js";
import {
  NFLVERSE_TEAM_WEEKLY_STATS_SOURCE_KEY,
  NflverseTeamWeeklyStatsSource,
  buildNflverseTeamWeeklyStatsUrl,
} from "./team-weekly-stats-source.js";

const fixture = readFileSync(new URL("./fixtures/team-weekly-stats.csv", import.meta.url), "utf8");
const EMPTY_STATE: NflverseDatasetState = {
  etag: null,
  lastModified: null,
  checksumSha256: null,
};

function csvRows(body: string): string[][] {
  return body
    .trimEnd()
    .split("\n")
    .map((line) => line.split(","));
}

function removeColumn(body: string, name: string): string {
  const rows = csvRows(body);
  const index = rows[0]?.indexOf(name) ?? -1;
  if (index < 0) throw new Error(`Fixture omitted ${name}`);
  return rows
    .map((row) => {
      const copy = [...row];
      copy.splice(index, 1);
      return copy.join(",");
    })
    .join("\n");
}

function replaceTeamCell(body: string, team: string, column: string, value: string): string {
  const rows = csvRows(body);
  const header = rows[0] ?? [];
  const teamIndex = header.indexOf("team");
  const columnIndex = header.indexOf(column);
  if (teamIndex < 0 || columnIndex < 0) throw new Error("Fixture schema is incomplete");
  const target = rows.find((row, index) => index > 0 && row[teamIndex] === team);
  if (!target) throw new Error(`Fixture omitted team ${team}`);
  target[columnIndex] = value;
  return rows.map((row) => row.join(",")).join("\n");
}

describe("NflverseTeamWeeklyStatsSource", () => {
  it("normalizes complete reciprocal REG and POST team games for opponent and D/ST models", async () => {
    const requests: Array<{ readonly url: string; readonly headers: Headers }> = [];
    const source = new NflverseTeamWeeklyStatsSource({
      now: () => new Date("2026-07-21T18:00:00.000Z"),
      fetch: (input, init) => {
        requests.push({ url: input.toString(), headers: new Headers(init?.headers) });
        return Promise.resolve(
          new Response(fixture, {
            headers: {
              "content-type": "text/csv; charset=utf-8",
              etag: '"team-2024-v2"',
              "last-modified": "Tue, 21 Jul 2026 17:00:00 GMT",
            },
          }),
        );
      },
    });

    const result = await source.check(2024, {
      ...EMPTY_STATE,
      etag: '"team-2024-v1"',
      lastModified: "Mon, 20 Jul 2026 17:00:00 GMT",
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(buildNflverseTeamWeeklyStatsUrl(2024));
    expect(requests[0]?.headers.get("if-none-match")).toBe('"team-2024-v1"');
    expect(requests[0]?.headers.get("if-modified-since")).toBe("Mon, 20 Jul 2026 17:00:00 GMT");
    expect(result).toMatchObject({
      state: "changed",
      sourceKey: NFLVERSE_TEAM_WEEKLY_STATS_SOURCE_KEY,
      season: 2024,
      checkedAt: "2026-07-21T18:00:00.000Z",
      rowsRead: 4,
      rowsRejected: 0,
      coveredWeeks: [1, 19],
      coveredSeasonTypes: ["REG", "POST"],
      coveredTeams: ["BAL", "CHI", "PIT", "TEN"],
      etag: '"team-2024-v2"',
    });
    if (result.state !== "changed") throw new Error("Expected changed team stats");
    expect(result.checksumSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.observations).toHaveLength(4);

    const chicago = result.observations.find((row) => row.team === "CHI");
    expect(chicago).toMatchObject({
      season: 2024,
      week: 1,
      seasonType: "REG",
      gameId: "2024_01_TEN_CHI",
      opponentTeam: "TEN",
      advanced: {
        passing_epa: -12.146704188691,
        passing_cpoe: -19.8383863629966,
        rushing_epa: -0.795930482714666,
        receiving_epa: -8.07137292242008,
      },
    });
    expect(chicago?.components).toMatchObject({
      passing_completions: 14,
      passing_attempts: 29,
      passing_yards: 93,
      rushing_yards: 84,
      total_offensive_yards: 148,
      offensive_fumbles_total: 3,
      offensive_fumbles_lost: 1,
      defensive_fumbles_forced: 1,
      defensive_fumbles_recovered: 1,
      defensive_sacks: 3,
      defensive_interceptions: 2,
      defensive_interception_return_yards: 52,
      defensive_touchdowns: 1,
      defensive_safeties: 0,
      special_teams_touchdowns: 1,
      field_goals_made: 3,
      field_goals_attempted: 3,
      field_goals_made_50_59: 1,
      extra_points_made: 1,
      punts_attempted: 6,
      punting_yards: 270,
      punt_return_yards_allowed: 30,
    });

    const baltimore = result.observations.find((row) => row.team === "BAL");
    expect(baltimore).toMatchObject({
      week: 19,
      seasonType: "POST",
      opponentTeam: "PIT",
    });
    expect(baltimore?.components).toMatchObject({
      total_offensive_yards: 464,
      defensive_sacks: 4,
      defensive_safeties: 0,
      field_goals_attempted: 0,
    });
  });

  it("retains a nonzero defensive safety without folding it into touchdown totals", async () => {
    const withSafety = replaceTeamCell(fixture, "BAL", "def_safeties", "1");
    const source = new NflverseTeamWeeklyStatsSource({
      fetch: () => Promise.resolve(new Response(withSafety)),
    });
    const result = await source.check(2024, EMPTY_STATE);
    if (result.state !== "changed") throw new Error("Expected changed team stats");
    expect(result.observations.find((row) => row.team === "BAL")?.components).toMatchObject({
      defensive_safeties: 1,
      defensive_touchdowns: 0,
    });
  });

  it("accepts an official blocked punt that is not credited as a punt attempt", async () => {
    const withBlockedPunt = replaceTeamCell(
      replaceTeamCell(fixture, "CHI", "pt_att", "0"),
      "CHI",
      "pt_blocked",
      "1",
    );
    const source = new NflverseTeamWeeklyStatsSource({
      fetch: () => Promise.resolve(new Response(withBlockedPunt)),
    });
    const result = await source.check(2024, EMPTY_STATE);
    if (result.state !== "changed") throw new Error("Expected changed team stats");
    expect(result.observations.find((row) => row.team === "CHI")?.components).toMatchObject({
      punts_attempted: 0,
      punts_blocked: 1,
    });
  });

  it("preserves conditional release state on a 304", async () => {
    const source = new NflverseTeamWeeklyStatsSource({
      fetch: () => Promise.resolve(new Response(null, { status: 304 })),
    });
    await expect(
      source.check(2024, {
        etag: '"same"',
        lastModified: "Tue, 21 Jul 2026 17:00:00 GMT",
        checksumSha256: "a".repeat(64),
      }),
    ).resolves.toMatchObject({
      state: "unchanged",
      season: 2024,
      checksumSha256: "a".repeat(64),
    });
  });

  it("fails closed when an upstream model input column disappears", async () => {
    const source = new NflverseTeamWeeklyStatsSource({
      fetch: () => Promise.resolve(new Response(removeColumn(fixture, "def_sacks"))),
    });
    await expect(source.check(2024, EMPTY_STATE)).rejects.toMatchObject({
      code: "INVALID_CSV",
      message: "nflverse team weekly stats omitted required column def_sacks",
    });
  });

  it("rejects duplicate headers instead of accepting csv-parse key overwrite", async () => {
    const duplicateHeader = fixture.replace(
      "def_fumbles_forced,def_sacks",
      "def_fumbles_forced,def_fumbles_forced",
    );
    const source = new NflverseTeamWeeklyStatsSource({
      fetch: () => Promise.resolve(new Response(duplicateHeader)),
    });
    await expect(source.check(2024, EMPTY_STATE)).rejects.toMatchObject({
      code: "INVALID_CSV",
      message: "nflverse team weekly stats contain invalid or duplicate headers",
    });
  });

  it("rejects internally inconsistent team totals rather than repairing them", async () => {
    const invalid = replaceTeamCell(fixture, "CHI", "completions", "30");
    const source = new NflverseTeamWeeklyStatsSource({
      fetch: () => Promise.resolve(new Response(invalid)),
    });
    await expect(source.check(2024, EMPTY_STATE)).rejects.toMatchObject({
      code: "QUALITY_THRESHOLD",
      message: "nflverse team weekly stats rejected 2 of 4 rows",
    });
  });

  it("rejects a partial game because opponent adjustments require both reciprocal rows", async () => {
    const partial = fixture
      .trimEnd()
      .split("\n")
      .filter((line) => !line.startsWith("2024,1,TEN,"))
      .join("\n");
    const source = new NflverseTeamWeeklyStatsSource({
      fetch: () => Promise.resolve(new Response(partial)),
    });
    await expect(source.check(2024, EMPTY_STATE)).rejects.toMatchObject({
      code: "QUALITY_THRESHOLD",
      message: "nflverse team weekly stats rejected 1 of 3 rows",
    });
  });

  it("rejects duplicate team-game observations instead of selecting one by input order", async () => {
    const lines = fixture.trimEnd().split("\n");
    const duplicate = [...lines, lines[1] ?? ""].join("\n");
    const source = new NflverseTeamWeeklyStatsSource({
      fetch: () => Promise.resolve(new Response(duplicate)),
    });
    await expect(source.check(2024, EMPTY_STATE)).rejects.toMatchObject({
      code: "QUALITY_THRESHOLD",
      message: "nflverse team weekly stats rejected 1 of 5 rows",
    });
  });

  it.each([
    {
      name: "unexpected response type",
      response: new Response(fixture, { headers: { "content-type": "text/html" } }),
      code: "CONTENT_TYPE",
    },
    {
      name: "season artifact that is not published",
      response: new Response(null, { status: 404 }),
      code: "NOT_AVAILABLE",
    },
    {
      name: "oversized declared response",
      response: new Response(fixture, {
        headers: { "content-length": String(8 * 1024 * 1024 + 1) },
      }),
      code: "TOO_LARGE",
    },
  ])("rejects $name", async ({ response, code }) => {
    const source = new NflverseTeamWeeklyStatsSource({
      fetch: () => Promise.resolve(response.clone()),
    });
    const error = await source.check(2024, EMPTY_STATE).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NflverseDatasetSourceError);
    expect(error).toMatchObject({ code, retryable: false });
  });

  it("validates season context before fetching", async () => {
    let fetched = false;
    const source = new NflverseTeamWeeklyStatsSource({
      fetch: () => {
        fetched = true;
        return Promise.resolve(new Response(fixture));
      },
    });
    await expect(source.check(2010, EMPTY_STATE)).rejects.toMatchObject({
      code: "INVALID_CONTEXT",
    });
    expect(fetched).toBe(false);
  });
});
