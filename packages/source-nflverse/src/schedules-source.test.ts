import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  NFLVERSE_SCHEDULES_SOURCE_KEY,
  NFLVERSE_SCHEDULES_UPSTREAM_URL,
  NFLVERSE_SCHEDULES_URL,
  NflverseDatasetSourceError,
  NflverseSchedulesSource,
  expandNflverseTeamScheduleGames,
  type NflverseDatasetState,
} from "./index.js";

const fixture = readFileSync(new URL("./fixtures/schedules.csv", import.meta.url), "utf8");
const EMPTY_STATE: NflverseDatasetState = {
  etag: null,
  lastModified: null,
  checksumSha256: null,
};

function fixtureResponse(body = fixture, headers: HeadersInit = {}): Response {
  return new Response(body, {
    headers: { "content-type": "text/csv; charset=utf-8", ...headers },
  });
}

describe("NflverseSchedulesSource", () => {
  it("normalizes a season into game and team/opponent schedule grains", async () => {
    const requests: Array<{ readonly url: string; readonly headers: Headers }> = [];
    const source = new NflverseSchedulesSource({
      now: () => new Date("2026-07-21T16:00:00.000Z"),
      fetch: (input, init) => {
        requests.push({ url: input.toString(), headers: new Headers(init?.headers) });
        return Promise.resolve(
          fixtureResponse(fixture, {
            etag: '"schedules-v2"',
            "last-modified": "Tue, 21 Jul 2026 15:30:00 GMT",
          }),
        );
      },
    });

    const result = await source.check(
      2025,
      { ...EMPTY_STATE, etag: '"schedules-v1"', selectionKey: "2025:REG" },
      { seasonTypes: ["REG"] },
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(NFLVERSE_SCHEDULES_URL);
    expect(requests[0]?.headers.get("if-none-match")).toBe('"schedules-v1"');
    expect(result).toMatchObject({
      state: "changed",
      sourceKey: NFLVERSE_SCHEDULES_SOURCE_KEY,
      upstreamUrl: NFLVERSE_SCHEDULES_UPSTREAM_URL,
      season: 2025,
      selectionKey: "2025:REG",
      requestedSeasonTypes: ["REG"],
      artifactRowsRead: 5,
      rowsRead: 3,
      rowsRejected: 0,
      coveredWeeks: [1, 2, 3],
      coveredSeasonTypes: ["REG"],
      coveredTeams: ["DAL", "DEN", "LAC", "NYG", "PHI"],
      etag: '"schedules-v2"',
    });
    if (result.state === "changed") {
      expect(result.checksumSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(result.games[0]).toMatchObject({
        gameId: "2025_01_DAL_PHI",
        seasonType: "REG",
        gameType: "REG",
        gameDate: "2025-09-04",
        startTimeEastern: "20:20",
        awayTeam: "DAL",
        homeTeam: "PHI",
        awayScore: 20,
        homeScore: 24,
        status: "final",
      });
      expect(result.teamGames).toHaveLength(6);
      expect(result.teamGames).toContainEqual(
        expect.objectContaining({
          team: "DAL",
          opponentTeam: "PHI",
          side: "away",
          teamScore: 20,
          opponentScore: 24,
          teamRestDays: 7,
          opponentRestDays: 7,
        }),
      );
      expect(result.teamGames).toContainEqual(
        expect.objectContaining({
          team: "PHI",
          opponentTeam: "DAL",
          side: "home",
          teamScore: 24,
          opponentScore: 20,
        }),
      );
    }
  });

  it("preserves time-TBD games for postponed or not-yet-finalized kickoff windows", async () => {
    const source = new NflverseSchedulesSource({
      fetch: () => Promise.resolve(fixtureResponse()),
    });
    const result = await source.check(2025, EMPTY_STATE, { seasonTypes: ["REG"] });
    expect(result.state).toBe("changed");
    if (result.state === "changed") {
      expect(result.games.find((game) => game.gameId === "2025_02_NYG_DAL")).toMatchObject({
        gameDate: "2025-09-14",
        startTimeEastern: null,
        timeTbd: true,
        status: "scheduled",
      });
      expect(result.games.find((game) => game.gameId === "2025_03_DEN_LAC")).toMatchObject({
        venue: "neutral",
        status: "scheduled",
      });
    }
  });

  it("filters postseason rounds while retaining the upstream round", async () => {
    const source = new NflverseSchedulesSource({
      fetch: () => Promise.resolve(fixtureResponse()),
    });
    const result = await source.check(2025, EMPTY_STATE, { seasonTypes: ["POST"] });
    expect(result).toMatchObject({
      state: "changed",
      selectionKey: "2025:POST",
      rowsRead: 1,
      coveredWeeks: [19],
      coveredSeasonTypes: ["POST"],
    });
    if (result.state === "changed") {
      expect(result.games).toEqual([
        expect.objectContaining({ gameType: "WC", seasonType: "POST" }),
      ]);
    }
  });

  it("defaults to regular and postseason games with a stable selection key", async () => {
    const source = new NflverseSchedulesSource({
      fetch: () => Promise.resolve(fixtureResponse()),
    });
    const result = await source.check(2025, EMPTY_STATE);
    expect(result).toMatchObject({
      state: "changed",
      requestedSeasonTypes: ["POST", "REG"],
      selectionKey: "2025:POST+REG",
      rowsRead: 4,
      coveredSeasonTypes: ["POST", "REG"],
    });
  });

  it("expands neutral-site score and rest context symmetrically", () => {
    const [away, home] = expandNflverseTeamScheduleGames([
      {
        gameId: "2025_03_DEN_LAC",
        season: 2025,
        week: 3,
        seasonType: "REG",
        gameType: "REG",
        gameDate: "2025-09-21",
        startTimeEastern: "16:05",
        timeTbd: false,
        awayTeam: "DEN",
        homeTeam: "LAC",
        awayScore: null,
        homeScore: null,
        awayRestDays: 6,
        homeRestDays: 8,
        venue: "neutral",
        status: "scheduled",
      },
    ]);
    expect(away).toMatchObject({
      team: "DEN",
      opponentTeam: "LAC",
      isNeutralSite: true,
      teamRestDays: 6,
      opponentRestDays: 8,
    });
    expect(home).toMatchObject({
      team: "LAC",
      opponentTeam: "DEN",
      isNeutralSite: true,
      teamRestDays: 8,
      opponentRestDays: 6,
    });
  });

  it("uses the cumulative artifact checksum when HTTP validators are absent", async () => {
    const source = new NflverseSchedulesSource({
      fetch: () => Promise.resolve(fixtureResponse()),
    });
    const first = await source.check(2025, EMPTY_STATE);
    const second = await source.check(2025, {
      etag: null,
      lastModified: null,
      checksumSha256: first.checksumSha256,
      selectionKey: first.selectionKey,
    });
    expect(second).toMatchObject({
      state: "unchanged",
      selectionKey: "2025:POST+REG",
      checksumSha256: first.checksumSha256,
    });
  });

  it("accepts a conditional 304 without parsing an artifact", async () => {
    const source = new NflverseSchedulesSource({
      fetch: () => Promise.resolve(new Response(null, { status: 304 })),
    });
    await expect(
      source.check(
        2025,
        {
          etag: '"same"',
          lastModified: "Tue, 21 Jul 2026 15:30:00 GMT",
          checksumSha256: "a".repeat(64),
          selectionKey: "2025:REG",
        },
        { seasonTypes: ["REG"] },
      ),
    ).resolves.toMatchObject({
      state: "unchanged",
      selectionKey: "2025:REG",
      checksumSha256: "a".repeat(64),
    });
  });

  it("does not let one season/filter checksum suppress another context", async () => {
    let fetches = 0;
    const source = new NflverseSchedulesSource({
      fetch: (_input, init) => {
        fetches += 1;
        expect(new Headers(init?.headers).get("if-none-match")).toBeNull();
        return Promise.resolve(fixtureResponse());
      },
    });
    await expect(
      source.check(
        2025,
        {
          etag: '"same-artifact"',
          lastModified: "Tue, 21 Jul 2026 15:30:00 GMT",
          checksumSha256: "a".repeat(64),
          selectionKey: "2025:POST",
        },
        { seasonTypes: ["REG"] },
      ),
    ).resolves.toMatchObject({ state: "changed", selectionKey: "2025:REG" });
    expect(fetches).toBe(1);
  });

  it.each([
    {
      name: "a missing required column",
      body: fixture.replace("gametime,", ""),
      code: "INVALID_CSV",
    },
    {
      name: "malformed CSV",
      body: 'game_id,season,game_type,week,gameday,gametime,away_team,away_score,home_team,home_score,location,away_rest,home_rest\n"unterminated',
      code: "INVALID_CSV",
    },
    {
      name: "an impossible calendar date",
      body: fixture.replace("2025-09-04", "2025-02-30"),
      code: "QUALITY_THRESHOLD",
    },
    {
      name: "a one-sided final score",
      body: fixture.replace("NYG,,DAL,,Home", "NYG,17,DAL,,Home"),
      code: "QUALITY_THRESHOLD",
    },
  ])("fails closed on $name", async ({ body, code }) => {
    const source = new NflverseSchedulesSource({
      fetch: () => Promise.resolve(fixtureResponse(body)),
    });
    await expect(source.check(2025, EMPTY_STATE)).rejects.toMatchObject({
      code,
      retryable: false,
    });
  });

  it("fails the complete selection on a duplicate game", async () => {
    const duplicate = fixture.trimEnd().split("\n")[2];
    const source = new NflverseSchedulesSource({
      fetch: () => Promise.resolve(fixtureResponse(`${fixture.trimEnd()}\n${duplicate ?? ""}\n`)),
    });
    await expect(source.check(2025, EMPTY_STATE)).rejects.toMatchObject({
      code: "QUALITY_THRESHOLD",
      message: "nflverse schedules rejected 1 of 5 selected rows",
    });
  });

  it("fails the complete selection when a team is scheduled twice in one week", async () => {
    const conflict = "2025_01_NYG_DAL,2025,REG,1,2025-09-05,20:15,NYG,,DAL,,Home,7,7";
    const source = new NflverseSchedulesSource({
      fetch: () => Promise.resolve(fixtureResponse(`${fixture.trimEnd()}\n${conflict}\n`)),
    });
    await expect(source.check(2025, EMPTY_STATE, { seasonTypes: ["REG"] })).rejects.toMatchObject({
      code: "QUALITY_THRESHOLD",
    });
  });

  it("reports a missing season or requested segment as not available", async () => {
    const source = new NflverseSchedulesSource({
      fetch: () => Promise.resolve(fixtureResponse()),
    });
    await expect(source.check(2026, EMPTY_STATE)).rejects.toMatchObject({
      code: "NOT_AVAILABLE",
    });
    await expect(source.check(2024, EMPTY_STATE, { seasonTypes: ["POST"] })).rejects.toMatchObject({
      code: "NOT_AVAILABLE",
    });
  });

  it.each([
    {
      name: "an oversized declared response",
      response: fixtureResponse(fixture, { "content-length": String(8 * 1024 * 1024 + 1) }),
      code: "TOO_LARGE",
    },
    {
      name: "an unsupported content type",
      response: new Response(fixture, { headers: { "content-type": "text/html" } }),
      code: "CONTENT_TYPE",
    },
    {
      name: "an unapproved redirect",
      response: new Response(null, {
        status: 302,
        headers: { location: "https://attacker.example/games.csv" },
      }),
      code: "REDIRECT",
    },
  ])("rejects $name", async ({ response, code }) => {
    const source = new NflverseSchedulesSource({
      fetch: () => Promise.resolve(response.clone()),
    });
    const error = await source.check(2025, EMPTY_STATE).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NflverseDatasetSourceError);
    expect(error).toMatchObject({ code, retryable: false });
  });

  it("validates the season and filter context before fetching", async () => {
    let fetches = 0;
    const source = new NflverseSchedulesSource({
      fetch: () => {
        fetches += 1;
        return Promise.resolve(fixtureResponse());
      },
    });
    await expect(source.check(1998, EMPTY_STATE)).rejects.toMatchObject({
      code: "INVALID_CONTEXT",
    });
    await expect(
      source.check(2025, EMPTY_STATE, { seasonTypes: ["REG", "REG"] }),
    ).rejects.toMatchObject({ code: "INVALID_CONTEXT" });
    await expect(source.check(2025, EMPTY_STATE, { seasonTypes: [] })).rejects.toMatchObject({
      code: "INVALID_CONTEXT",
    });
    expect(fetches).toBe(0);
  });
});
