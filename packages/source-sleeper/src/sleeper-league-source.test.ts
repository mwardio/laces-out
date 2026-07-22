import { readFile } from "node:fs/promises";

import { beforeAll, describe, expect, it } from "vitest";

import { SleeperLeagueSource } from "./index.js";

interface Fixture {
  readonly user: unknown;
  readonly leagues: unknown;
  readonly leagueUsers: unknown;
  readonly rosters: unknown;
  readonly matchups: unknown;
  readonly transactions: unknown;
  readonly drafts: unknown;
  readonly draftPicks: unknown;
  readonly tradedPicks: unknown;
}

let fixture: Fixture;

beforeAll(async () => {
  fixture = JSON.parse(
    await readFile(new URL("../fixtures/league-read.json", import.meta.url), "utf8"),
  ) as Fixture;
});

function fixtureFor(endpoint: URL): unknown {
  const path = endpoint.pathname;
  if (path === "/v1/user/sample_manager") return fixture.user;
  if (path.endsWith("/leagues/nfl/2026")) return fixture.leagues;
  if (path.endsWith("/drafts/nfl/2026")) return fixture.drafts;
  if (path.endsWith("/users")) return fixture.leagueUsers;
  if (path.endsWith("/rosters")) return fixture.rosters;
  if (path.includes("/matchups/")) return fixture.matchups;
  if (path.includes("/transactions/")) return fixture.transactions;
  if (path === "/v1/league/900000000000000000/drafts") return fixture.drafts;
  if (path === "/v1/draft/910000000000000000") {
    return Array.isArray(fixture.drafts) ? fixture.drafts[0] : null;
  }
  if (path.endsWith("/picks")) return fixture.draftPicks;
  if (path.endsWith("/traded_picks")) return fixture.tradedPicks;
  if (path === "/v1/league/900000000000000000") {
    return Array.isArray(fixture.leagues) ? fixture.leagues[0] : null;
  }
  return null;
}

function fixtureSource(requests: URL[] = []) {
  return new SleeperLeagueSource({
    now: () => new Date("2026-07-21T15:00:00.000Z"),
    fetch: (input, init) => {
      const endpoint = new URL(input);
      requests.push(endpoint);
      expect(init).toMatchObject({ method: "GET", redirect: "error" });
      expect(new Headers(init?.headers).get("accept")).toBe("application/json");
      return Promise.resolve(
        new Response(JSON.stringify(fixtureFor(endpoint)), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    },
  });
}

describe("SleeperLeagueSource discovery and league reads", () => {
  it("discovers a stable user ID and returns per-call provenance", async () => {
    const requests: URL[] = [];
    const result = await fixtureSource(requests).findUser("sample_manager");

    expect(requests[0]?.toString()).toBe("https://api.sleeper.app/v1/user/sample_manager");
    expect(result.data).toEqual({
      userId: "100000000000000001",
      username: "sample_manager",
      displayName: "Sample Manager",
      avatarId: "avatar001",
    });
    expect(result.provenance).toMatchObject({
      provider: "sleeper",
      endpoint: "https://api.sleeper.app/v1/user/sample_manager",
      fetchedAt: "2026-07-21T15:00:00.000Z",
    });
    expect(result.provenance.checksumSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("normalizes league configuration and rejects malformed rows without losing valid leagues", async () => {
    const result = await fixtureSource().getUserLeagues("100000000000000001", 2026);

    expect(result).toMatchObject({ rowsRead: 2, rowsRejected: 1 });
    expect(result.data).toEqual([
      expect.objectContaining({
        leagueId: "900000000000000000",
        draftId: "910000000000000000",
        name: "Fixture Friends League",
        sport: "nfl",
        season: "2026",
        totalRosters: 2,
        rosterPositions: ["QB", "RB", "WR", "FLEX", "BN"],
        settings: { playoff_teams: 2, waiver_budget: 100 },
        scoringSettings: { rec: 1, pass_yd: 0.04 },
      }),
    ]);
  });

  it("preserves league users, roster player IDs, and matchup scoring", async () => {
    const source = fixtureSource();
    const [users, rosters, matchups] = await Promise.all([
      source.getLeagueUsers("900000000000000000"),
      source.getLeagueRosters("900000000000000000"),
      source.getMatchups("900000000000000000", 6),
    ]);

    expect(users.data[0]).toMatchObject({
      userId: "100000000000000001",
      isCommissioner: true,
      metadata: { team_name: "The Samples" },
    });
    expect(rosters.data[0]).toMatchObject({
      rosterId: 1,
      ownerId: "100000000000000001",
      coOwnerIds: ["100000000000000003"],
      reserveIds: ["player-ir"],
      taxiIds: ["player-taxi"],
    });
    expect(matchups.data[0]).toMatchObject({
      rosterId: 1,
      matchupId: 1,
      points: 45.75,
      customPoints: null,
      playerPoints: { "player-qb": 22.5, "player-rb": 15.25, CHI: 8, "player-bench": 4 },
      starterPoints: [22.5, 15.25, 8],
    });
  });
});

describe("SleeperLeagueSource transactions and drafts", () => {
  it("retains transaction participants, player moves, picks, and FAAB transfers", async () => {
    const result = await fixtureSource().getTransactions("900000000000000000", 6);

    expect(result.data[0]).toMatchObject({
      transactionId: "920000000000000001",
      type: "trade",
      status: "complete",
      week: 6,
      rosterIds: [1, 2],
      adds: { "player-add": 1 },
      drops: { "player-drop": 1 },
      draftPicks: [
        {
          season: "2027",
          round: 2,
          originalRosterId: 1,
          previousOwnerRosterId: 1,
          ownerRosterId: 2,
        },
      ],
      waiverBudgetTransfers: [{ senderRosterId: 2, receiverRosterId: 1, amount: 10 }],
    });
  });

  it("reads league drafts, a draft, picks, and traded-pick ownership", async () => {
    const source = fixtureSource();
    const [userDrafts, drafts, draft, picks, leaguePicks, draftPicks] = await Promise.all([
      source.getUserDrafts("100000000000000001", 2026),
      source.getLeagueDrafts("900000000000000000"),
      source.getDraft("910000000000000000"),
      source.getDraftPicks("910000000000000000"),
      source.getLeagueTradedPicks("900000000000000000"),
      source.getDraftTradedPicks("910000000000000000"),
    ]);

    expect(userDrafts.data).toEqual(drafts.data);
    expect(drafts.data[0]).toMatchObject({
      draftId: "910000000000000000",
      draftOrder: { "100000000000000001": 1, "100000000000000002": 2 },
      slotToRosterId: { "1": 1, "2": 2 },
    });
    expect(draft.data?.draftId).toBe("910000000000000000");
    expect(picks.data[0]).toEqual(
      expect.objectContaining({
        playerId: "player-qb",
        rosterId: 1,
        round: 1,
        draftSlot: 1,
        pickNumber: 1,
        metadata: { team: "BUF", position: "QB", amount: "41" },
      }),
    );
    expect(leaguePicks.data).toEqual(draftPicks.data);
    expect(leaguePicks.data[0]).toMatchObject({ ownerRosterId: 2 });
  });
});

describe("SleeperLeagueSource boundaries", () => {
  it("does not issue requests for unsafe IDs, seasons, or weeks", async () => {
    let calls = 0;
    const source = new SleeperLeagueSource({
      fetch: () => {
        calls += 1;
        return Promise.resolve(new Response("[]"));
      },
    });

    await expect(source.getLeague("../players/nfl")).rejects.toThrow(RangeError);
    await expect(source.getUserLeagues("123", 2500)).rejects.toThrow(RangeError);
    await expect(source.getMatchups("900000000000000000", 26)).rejects.toThrow(RangeError);
    expect(calls).toBe(0);
  });

  it("rejects oversized responses before parsing", async () => {
    const source = new SleeperLeagueSource({
      fetch: () =>
        Promise.resolve(
          new Response("{}", { headers: { "content-length": String(2 * 1024 * 1024) } }),
        ),
    });

    await expect(source.getLeague("900000000000000000")).rejects.toMatchObject({
      code: "TOO_LARGE",
    });
  });

  it("marks throttling and upstream outages retryable", async () => {
    const source = new SleeperLeagueSource({
      fetch: () => Promise.resolve(new Response("{}", { status: 429 })),
    });

    await expect(source.getLeague("900000000000000000")).rejects.toMatchObject({
      code: "UPSTREAM",
      retryable: true,
    });
  });
});
