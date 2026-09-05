import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  YahooFantasyReadClient,
  type YahooFetchLike,
  YahooReadClientError,
} from "./read-client.js";

const auth = { accessToken: "sanitized-access-token" } as const;
const leagueKey = "449.l.12345";
const validXml = `<?xml version="1.0" encoding="UTF-8"?><fantasy_content><games/></fantasy_content>`;
const leagueFixture = readFileSync(
  new URL("../test/fixtures/sanitized-league.xml", import.meta.url),
  "utf8",
);

function xmlResponse(xml = validXml, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/xml; charset=UTF-8");
  return new Response(xml, { ...init, headers });
}

function errorDetails(error: unknown): YahooReadClientError {
  expect(error).toBeInstanceOf(YahooReadClientError);
  return error as YahooReadClientError;
}

describe("YahooFantasyReadClient resource paths", () => {
  it("builds only official Yahoo Fantasy user and league GET resource paths", async () => {
    const calls: { readonly url: string; readonly init: RequestInit | undefined }[] = [];
    const fetch: YahooFetchLike = (input, init) => {
      calls.push({ url: String(input), init });
      return Promise.resolve(xmlResponse());
    };
    const client = new YahooFantasyReadClient({
      fetch,
      now: () => new Date("2026-07-16T12:00:00.000Z"),
    });

    await client.getUserGames(auth, {
      gameCodes: ["nfl"],
      seasons: [2026],
      availableOnly: true,
    });
    await client.getUserLeagues(auth, { gameKeys: ["449"], start: 25, count: 25 });
    await client.getLeagueSettings(auth, leagueKey);
    await client.getLeagueTeams(auth, leagueKey);
    await client.getLeagueRosters(auth, leagueKey, { week: 4 });
    await client.getLeagueMatchups(auth, leagueKey, { week: 4 });
    await client.getLeagueStandings(auth, leagueKey);
    await client.getLeagueTransactions(auth, leagueKey, {
      types: ["add", "trade"],
      teamKey: "449.l.12345.t.1",
      count: 10,
    });
    await client.getLeaguePlayers(auth, leagueKey, {
      status: "FA",
      position: "W/R/T",
      search: "Example Player",
      sort: "PTS",
      sortType: "week",
      sortWeek: 4,
      start: 25,
      count: 10,
    });
    await client.getLeaguePlayersByKeys(auth, leagueKey, ["449.p.9001", "449.p.9002"]);
    await client.getLeagueDraftResults(auth, leagueKey);

    expect(calls.map(({ url }) => url)).toEqual([
      "https://fantasysports.yahooapis.com/fantasy/v2/users;use_login=1/games;game_codes=nfl;seasons=2026;is_available=1",
      "https://fantasysports.yahooapis.com/fantasy/v2/users;use_login=1/games;game_keys=449/leagues;start=25;count=25",
      "https://fantasysports.yahooapis.com/fantasy/v2/league/449.l.12345/settings",
      "https://fantasysports.yahooapis.com/fantasy/v2/league/449.l.12345/teams",
      "https://fantasysports.yahooapis.com/fantasy/v2/league/449.l.12345/teams/roster;week=4/players",
      "https://fantasysports.yahooapis.com/fantasy/v2/league/449.l.12345/scoreboard;week=4",
      "https://fantasysports.yahooapis.com/fantasy/v2/league/449.l.12345/standings",
      "https://fantasysports.yahooapis.com/fantasy/v2/league/449.l.12345/transactions;types=add,trade;team_key=449.l.12345.t.1;count=10",
      "https://fantasysports.yahooapis.com/fantasy/v2/league/449.l.12345/players;status=FA;position=W%2FR%2FT;search=Example%20Player;sort=PTS;sort_type=week;sort_week=4;start=25;count=10",
      "https://fantasysports.yahooapis.com/fantasy/v2/league/449.l.12345/players;player_keys=449.p.9001,449.p.9002",
      "https://fantasysports.yahooapis.com/fantasy/v2/league/449.l.12345/draftresults",
    ]);
    for (const call of calls) {
      expect(call.init?.method).toBe("GET");
      expect(call.init?.redirect).toBe("error");
      const headers = new Headers(call.init?.headers);
      expect(headers.get("authorization")).toBe("Bearer sanitized-access-token");
      expect(headers.get("accept")).toContain("application/xml");
    }
  });

  it("uses bounded pagination defaults and rejects path injection", async () => {
    let requestedUrl = "";
    const client = new YahooFantasyReadClient({
      fetch: (input) => {
        requestedUrl = String(input);
        return Promise.resolve(xmlResponse());
      },
    });

    await client.getLeaguePlayers(auth, leagueKey, { status: "A" });
    expect(requestedUrl).toContain(";start=0;count=25");
    expect(() => client.getLeagueSettings(auth, "449.l.123/settings")).toThrow(TypeError);
    expect(() => client.getLeaguePlayers(auth, leagueKey, { count: 101 })).toThrow(TypeError);
    expect(() => client.getLeaguePlayers(auth, leagueKey, { status: "A;sort=PTS" as "A" })).toThrow(
      TypeError,
    );
    expect(() => client.getUserLeagues(auth, { gameKeys: ["nfl/leagues"] })).toThrow(TypeError);
    expect(() => client.getUserLeagues(auth, { count: 101 })).toThrow(TypeError);
    expect(() => client.getLeaguePlayersByKeys(auth, leagueKey, [])).toThrow(TypeError);
    expect(() =>
      client.getLeaguePlayersByKeys(auth, leagueKey, ["449.p.9001", "449.p.9001"]),
    ).toThrow(TypeError);
    expect(() =>
      client.getLeaguePlayersByKeys(auth, leagueKey, ["449.p.9001", "450.p.9002"]),
    ).toThrow(TypeError);
    expect(() => client.getLeaguePlayersByKeys(auth, leagueKey, ["449.p.9001/ownership"])).toThrow(
      TypeError,
    );
    expect(() =>
      client.getLeaguePlayersByKeys(
        auth,
        leagueKey,
        Array.from({ length: 26 }, (_, index) => `449.p.${index + 1}`),
      ),
    ).toThrow(TypeError);
    expect(() =>
      client.getLeagueTransactions(auth, leagueKey, {
        types: ["add;type=waiver" as "add"],
      }),
    ).toThrow(TypeError);
    expect(() => client.getLeagueTransactions(auth, leagueKey, { types: ["waiver"] })).toThrow(
      TypeError,
    );

    await client.getLeagueTransactions(auth, leagueKey, {
      types: ["waiver"],
      teamKey: "449.l.12345.t.1",
    });
    expect(requestedUrl).toContain("/transactions;type=waiver;team_key=449.l.12345.t.1;count=25");
  });

  it("normalizes only artifacts supported by the existing strict league parser", () => {
    const client = new YahooFantasyReadClient();
    const normalized = client.normalizeLeagueArtifact({
      xml: leagueFixture,
      endpoint: "https://fantasysports.yahooapis.com/fantasy/v2/league/449.l.12345",
      fetchedAt: "2026-07-16T12:00:00.000Z",
      contentType: "application/xml",
      etag: null,
      lastModified: null,
    });

    expect(normalized).toMatchObject({
      provider: "yahoo",
      league: { externalId: "449.l.12345", season: 2026 },
      provenance: { mode: "official-api", fetchedAt: "2026-07-16T12:00:00.000Z" },
    });
  });
});

describe("YahooFantasyReadClient transport policy", () => {
  it("coalesces identical in-flight reads only within the same credential", async () => {
    let finish: ((response: Response) => void) | undefined;
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    const client = new YahooFantasyReadClient({ fetch });

    const first = client.getLeagueSettings(auth, leagueKey);
    const second = client.getLeagueSettings(auth, leagueKey);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    finish?.(xmlResponse());
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not coalesce the same URL across different access tokens", async () => {
    const fetch = vi.fn(() => Promise.resolve(xmlResponse()));
    const client = new YahooFantasyReadClient({ fetch });

    await Promise.all([
      client.getLeagueSettings({ accessToken: "first-private-token" }, leagueKey),
      client.getLeagueSettings({ accessToken: "second-private-token" }, leagueKey),
    ]);

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("caps concurrent upstream requests", async () => {
    const finishes: ((response: Response) => void)[] = [];
    let active = 0;
    let peak = 0;
    const fetch: YahooFetchLike = () => {
      active += 1;
      peak = Math.max(peak, active);
      return new Promise<Response>((resolve) => {
        finishes.push((response) => {
          active -= 1;
          resolve(response);
        });
      });
    };
    const client = new YahooFantasyReadClient({ fetch, maxConcurrentRequests: 2 });
    const reads = [
      client.getLeagueSettings(auth, leagueKey),
      client.getLeagueTeams(auth, leagueKey),
      client.getLeagueStandings(auth, leagueKey),
    ];

    await vi.waitFor(() => expect(finishes).toHaveLength(2));
    finishes.shift()?.(xmlResponse());
    await vi.waitFor(() => expect(finishes).toHaveLength(2));
    finishes.shift()?.(xmlResponse());
    finishes.shift()?.(xmlResponse());
    await Promise.all(reads);
    expect(peak).toBe(2);
  });

  it("rejects redirects and mismatched final origins", async () => {
    const redirecting = new YahooFantasyReadClient({
      fetch: () => Promise.resolve(new Response(null, { status: 302 })),
    });
    await expect(redirecting.getLeagueTeams(auth, leagueKey)).rejects.toMatchObject({
      code: "REDIRECT",
      status: 302,
    });

    const mismatchedResponse = xmlResponse();
    Object.defineProperty(mismatchedResponse, "url", {
      value: "https://attacker.example/fantasy/v2/league/449.l.12345/teams",
    });
    const mismatched = new YahooFantasyReadClient({
      fetch: () => Promise.resolve(mismatchedResponse),
    });
    await expect(mismatched.getLeagueTeams(auth, leagueKey)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  it("requires a supported XML content type and secure well-formed XML", async () => {
    const jsonClient = new YahooFantasyReadClient({
      fetch: () =>
        Promise.resolve(
          new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
        ),
    });
    await expect(jsonClient.getLeagueTeams(auth, leagueKey)).rejects.toMatchObject({
      code: "UNSUPPORTED_CONTENT_TYPE",
    });

    const unsafeClient = new YahooFantasyReadClient({
      fetch: () =>
        Promise.resolve(
          xmlResponse("<!DOCTYPE x [<!ENTITY leak SYSTEM 'file:///etc/passwd'>]><x>&leak;</x>"),
        ),
    });
    await expect(unsafeClient.getLeagueTeams(auth, leagueKey)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  it("enforces declared and streamed response size limits", async () => {
    const declared = new YahooFantasyReadClient({
      maxResponseBytes: 64,
      fetch: () => Promise.resolve(xmlResponse("<x/>", { headers: { "content-length": "65" } })),
    });
    await expect(declared.getLeagueTeams(auth, leagueKey)).rejects.toMatchObject({
      code: "TOO_LARGE",
    });

    const streamed = new YahooFantasyReadClient({
      maxResponseBytes: 64,
      fetch: () => Promise.resolve(xmlResponse(`<x>${"a".repeat(64)}</x>`)),
    });
    await expect(streamed.getLeagueTeams(auth, leagueKey)).rejects.toMatchObject({
      code: "TOO_LARGE",
    });
  });

  it("classifies 401 and 403 responses without exposing response bodies", async () => {
    const unauthorized = new YahooFantasyReadClient({
      fetch: () => Promise.resolve(new Response("secret details", { status: 401 })),
    });
    const unauthorizedError = errorDetails(
      await unauthorized.getLeagueTeams(auth, leagueKey).catch((error: unknown) => error),
    );
    expect(unauthorizedError).toMatchObject({
      code: "UNAUTHORIZED",
      status: 401,
      retryable: false,
      refreshAccessToken: true,
    });
    expect(unauthorizedError.message).not.toContain("secret details");

    const forbidden = new YahooFantasyReadClient({
      fetch: () => Promise.resolve(new Response(null, { status: 403 })),
    });
    await expect(forbidden.getLeagueTeams(auth, leagueKey)).rejects.toMatchObject({
      code: "FORBIDDEN",
      status: 403,
      retryable: false,
    });
  });

  it("parses Retry-After for rate limits and retryable upstream errors", async () => {
    const now = () => new Date("2026-07-16T12:00:00.000Z");
    const rateLimited = new YahooFantasyReadClient({
      now,
      fetch: () =>
        Promise.resolve(new Response(null, { status: 429, headers: { "retry-after": "7" } })),
    });
    await expect(rateLimited.getLeagueTeams(auth, leagueKey)).rejects.toMatchObject({
      code: "RATE_LIMITED",
      retryable: true,
      retryAfterMs: 7_000,
    });

    const unavailable = new YahooFantasyReadClient({
      now,
      fetch: () =>
        Promise.resolve(
          new Response(null, {
            status: 503,
            headers: { "retry-after": "Thu, 16 Jul 2026 12:00:11 GMT" },
          }),
        ),
    });
    await expect(unavailable.getLeagueTeams(auth, leagueKey)).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
      retryable: true,
      retryAfterMs: 11_000,
    });

    const extreme = new YahooFantasyReadClient({
      now,
      fetch: () =>
        Promise.resolve(
          new Response(null, {
            status: 429,
            headers: { "retry-after": String(Number.MAX_SAFE_INTEGER) },
          }),
        ),
    });
    await expect(extreme.getLeagueTeams(auth, leagueKey)).rejects.toMatchObject({
      code: "RATE_LIMITED",
      retryable: true,
      retryAfterMs: 15 * 60 * 1_000,
    });
  });

  it("distinguishes caller cancellation from timeout", async () => {
    const neverCompletes: YahooFetchLike = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    const client = new YahooFantasyReadClient({ fetch: neverCompletes, timeoutMs: 500 });
    await expect(client.getLeagueTeams(auth, leagueKey)).rejects.toMatchObject({
      code: "TIMEOUT",
      retryable: true,
    });

    const controller = new AbortController();
    controller.abort();
    await expect(
      client.getLeagueTeams({ ...auth, signal: controller.signal }, leagueKey),
    ).rejects.toMatchObject({ code: "ABORTED", retryable: false });
  });
});
