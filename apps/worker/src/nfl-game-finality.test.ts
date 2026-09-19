import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  fetchNflGameFinalitySource,
  NFL_GAME_FINALITY_SOURCE,
  NFL_GAME_FINALITY_VERSION,
  verifyNflGameFinality,
  type NflGameFinalitySchedule,
  type NflGameFinalitySource,
} from "./nfl-game-finality.js";

const schedule: NflGameFinalitySchedule = {
  nflverseGameId: "2026_02_DET_BUF",
  season: 2026,
  week: 2,
  seasonType: "REG",
  homeTeam: "BUF",
  awayTeam: "DET",
  kickoffAt: "2026-09-18T00:15:00.000Z",
};
const observedAt = "2026-09-19T11:00:00.000Z";
const status = () => ({ type: { completed: true, state: "post", name: "STATUS_FINAL" } });
function document() {
  return {
    leagues: [{ slug: "nfl" }],
    season: { year: 2026, type: 2 },
    week: { number: 2 },
    events: [
      {
        id: "401872932",
        date: "2026-09-18T00:15Z",
        season: { year: 2026, type: 2 },
        week: { number: 2 },
        status: status(),
        competitions: [
          {
            id: "401872932",
            date: "2026-09-18T00:15Z",
            status: status(),
            competitors: [
              { homeAway: "home", team: { abbreviation: "BUF" } },
              { homeAway: "away", team: { abbreviation: "DET" } },
            ],
          },
        ],
      },
    ],
  };
}
function source(value: unknown = document()): NflGameFinalitySource {
  const payload = JSON.stringify(value);
  return {
    sourceKey: NFL_GAME_FINALITY_SOURCE,
    version: NFL_GAME_FINALITY_VERSION,
    url: "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=2026&seasontype=2&week=2&limit=1000",
    payload,
    payloadChecksum: createHash("sha256").update(payload).digest("hex"),
    observedAt,
  };
}

describe("explicit NFL game completion", () => {
  it("binds both terminal status objects to the exact frozen game and retained source", () => {
    expect(verifyNflGameFinality({ source: source(), schedule })).toEqual({
      ...schedule,
      state: "verified",
      sourceKey: NFL_GAME_FINALITY_SOURCE,
      version: NFL_GAME_FINALITY_VERSION,
      payloadChecksum: source().payloadChecksum,
      observedAt,
      providerEventId: "401872932",
      providerStatus: { completed: true, state: "post", name: "STATUS_FINAL" },
    });
  });

  it.each([
    ["unfinished overtime", { completed: false, state: "in", name: "STATUS_IN_PROGRESS" }],
    ["canceled", { completed: true, state: "post", name: "STATUS_CANCELED" }],
    ["contradictory completion", { completed: false, state: "post", name: "STATUS_FINAL" }],
  ])("does not grade %s, regardless of scores or elapsed time", (_label, value) => {
    const payload = document();
    payload.events[0]!.status.type = value;
    expect(verifyNflGameFinality({ source: source(payload), schedule })).toMatchObject({
      state: "unavailable",
      reason: "game-not-explicitly-final",
    });
  });

  it("rejects disagreement between event and competition status", () => {
    const payload = document();
    payload.events[0]!.competitions[0]!.status.type.completed = false;
    expect(verifyNflGameFinality({ source: source(payload), schedule }).state).toBe("unavailable");
  });

  it.each([
    [
      "different week",
      (p: ReturnType<typeof document>) => {
        p.week.number = 1;
      },
    ],
    [
      "different season",
      (p: ReturnType<typeof document>) => {
        p.events[0]!.season.year = 2025;
      },
    ],
    [
      "different league",
      (p: ReturnType<typeof document>) => {
        p.leagues[0]!.slug = "college-football";
      },
    ],
    [
      "changed kickoff",
      (p: ReturnType<typeof document>) => {
        p.events[0]!.date = "2026-09-18T01:15Z";
      },
    ],
    [
      "duplicate event",
      (p: ReturnType<typeof document>) => {
        p.events.push(structuredClone(p.events[0]!));
      },
    ],
    [
      "duplicate matchup",
      (p: ReturnType<typeof document>) => {
        const duplicate = structuredClone(p.events[0]!);
        duplicate.id = "2";
        duplicate.competitions[0]!.id = "2";
        p.events.push(duplicate);
      },
    ],
    [
      "missing game",
      (p: ReturnType<typeof document>) => {
        p.events = [];
      },
    ],
    [
      "reversed home/away",
      (p: ReturnType<typeof document>) => {
        p.events[0]!.competitions[0]!.competitors[0]!.homeAway = "away";
      },
    ],
  ])("rejects %s instead of borrowing a final result", (_label, mutate) => {
    const payload = document();
    mutate(payload);
    expect(verifyNflGameFinality({ source: source(payload), schedule }).state).toBe("unavailable");
  });

  it("supports established team aliases while checking the original NFL game ID", () => {
    const payload = document();
    payload.events[0]!.competitions[0]!.competitors[0]!.team.abbreviation = "WSH";
    expect(
      verifyNflGameFinality({
        source: source(payload),
        schedule: { ...schedule, homeTeam: "WAS", nflverseGameId: "2026_02_DET_WAS" },
      }).state,
    ).toBe("verified");
    expect(
      verifyNflGameFinality({
        source: source(),
        schedule: { ...schedule, nflverseGameId: "2026_01_DET_BUF" },
      }).state,
    ).toBe("unavailable");
  });

  it("rejects stale checksum, wrong origin and terminal observations before kickoff", () => {
    for (const altered of [
      { ...source(), payloadChecksum: "0".repeat(64) },
      { ...source(), url: "https://example.com/scoreboard" },
      { ...source(), observedAt: "2026-09-17T00:00:00.000Z" },
    ])
      expect(verifyNflGameFinality({ source: altered, schedule }).state).toBe("unavailable");
  });
});

describe("bounded public terminal-status capture", () => {
  it("uses the fixed credential-free GET and preserves the exact payload", async () => {
    const expected = source();
    let calls = 0;
    const captured = await fetchNflGameFinalitySource({
      season: 2026,
      week: 2,
      now: () => new Date(observedAt),
      fetch: (url, options) => {
        calls++;
        expect(url).toBe(expected.url);
        expect(options).toMatchObject({
          method: "GET",
          redirect: "error",
          credentials: "omit",
          headers: { Accept: "application/json" },
        });
        return Promise.resolve(
          new Response(expected.payload, {
            headers: { "content-type": "application/json;charset=utf-8" },
          }),
        );
      },
    });
    expect(calls).toBe(1);
    expect(captured).toEqual(expected);
    expect(verifyNflGameFinality({ source: captured, schedule }).state).toBe("verified");
  });

  it.each([
    () => new Response("{}", { status: 429, headers: { "content-type": "application/json" } }),
    () => new Response("{}", { headers: { "content-type": "text/html" } }),
    () =>
      new Response("{}", {
        headers: { "content-type": "application/json", "content-length": "2097153" },
      }),
    () => new Response(" ".repeat(2097153), { headers: { "content-type": "application/json" } }),
  ])("rejects unavailable or oversized source responses", async (response) => {
    await expect(
      fetchNflGameFinalitySource({
        season: 2026,
        week: 2,
        fetch: () => Promise.resolve(response()),
      }),
    ).rejects.toThrow();
  });
});
