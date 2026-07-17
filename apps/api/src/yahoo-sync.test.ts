import { readFileSync } from "node:fs";

import { YahooReadClientError, type YahooXmlArtifact } from "@fantasy/connector-yahoo";
import type { LeagueSyncBundle } from "@fantasy/connectors";
import { describe, expect, it, vi } from "vitest";

import {
  YahooSyncError,
  YahooSyncService,
  type YahooAccessTokenPort,
  type YahooReadPort,
  type YahooSyncReceipt,
  type YahooSyncRepository,
} from "./yahoo-sync.js";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_USER_ID = "10000000-0000-4000-8000-000000000002";
const CONNECTION_ID = "20000000-0000-4000-8000-000000000001";
const LEAGUE_ID = "30000000-0000-4000-8000-000000000001";
const SEASON_ID = "40000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-07-16T12:00:00.000Z");

function fixture(name: string): string {
  return readFileSync(
    new URL(`../../../packages/connector-yahoo/test/fixtures/${name}`, import.meta.url),
    "utf8",
  );
}

function artifact(
  xml: string,
  endpoint = "https://fantasysports.yahooapis.com/fantasy/v2/test",
): YahooXmlArtifact {
  return {
    xml,
    endpoint,
    fetchedAt: NOW.toISOString(),
    contentType: "application/xml",
    etag: null,
    lastModified: null,
  };
}

function receipt(
  bundle: LeagueSyncBundle,
  state: "accepted" | "unchanged" = "accepted",
): YahooSyncReceipt {
  return {
    syncRunId: "50000000-0000-4000-8000-000000000001",
    leagueId: LEAGUE_ID,
    leagueSeasonId: SEASON_ID,
    externalLeagueKey: bundle.league.externalId,
    state,
    recordsWritten: 12,
    syncedAt: NOW.toISOString(),
  };
}

function repository(overrides: Partial<YahooSyncRepository> = {}): YahooSyncRepository {
  return {
    findOwnedConnection: (userId, connectionId) =>
      Promise.resolve(
        userId === USER_ID && connectionId === CONNECTION_ID
          ? { id: CONNECTION_ID, health: "healthy" as const }
          : undefined,
      ),
    listConnectionStatus: () => Promise.resolve([]),
    disconnectOwnedConnection: () => Promise.resolve(true),
    persistBundle: (_userId, _connectionId, bundle) => Promise.resolve(receipt(bundle)),
    markFailure: () => Promise.resolve(),
    ...overrides,
  };
}

function tokens(overrides: Partial<YahooAccessTokenPort> = {}): YahooAccessTokenPort {
  return {
    getAccessToken: () => Promise.resolve("sanitized-access-token"),
    ...overrides,
  };
}

function readPort(overrides: Partial<YahooReadPort> = {}): YahooReadPort {
  return {
    getUserLeagues: (_request, options) =>
      Promise.resolve(
        artifact(
          fixture(
            options.start === 0
              ? "sanitized-user-leagues-page-1.xml"
              : "sanitized-user-leagues-page-2.xml",
          ),
        ),
      ),
    getLeagueSettings: () => Promise.resolve(artifact(fixture("sanitized-settings.xml"))),
    getLeagueTeams: () => Promise.resolve(artifact(fixture("sanitized-teams.xml"))),
    getLeagueRosters: () => Promise.resolve(artifact(fixture("sanitized-rosters.xml"))),
    getLeagueStandings: () => Promise.resolve(artifact(fixture("sanitized-standings.xml"))),
    getLeagueMatchups: () => Promise.resolve(artifact(fixture("sanitized-scoreboard.xml"))),
    ...overrides,
  };
}

describe("YahooSyncService", () => {
  it("removes only the authenticated user's local connection and remains idempotent", async () => {
    const disconnectOwnedConnection = vi
      .fn<YahooSyncRepository["disconnectOwnedConnection"]>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const getAccessToken = vi.fn(() => Promise.resolve("must-not-be-used"));
    const baseClient = readPort();
    const getUserLeagues = vi.fn((...input: Parameters<YahooReadPort["getUserLeagues"]>) =>
      baseClient.getUserLeagues(...input),
    );
    const service = new YahooSyncService({
      repository: repository({ disconnectOwnedConnection }),
      tokens: tokens({ getAccessToken }),
      client: readPort({ getUserLeagues }),
      now: () => NOW,
    });

    await expect(
      service.disconnectConnection(USER_ID, CONNECTION_ID, "request-one"),
    ).resolves.toBeUndefined();
    await expect(
      service.disconnectConnection(USER_ID, CONNECTION_ID, "request-two"),
    ).resolves.toBeUndefined();

    expect(disconnectOwnedConnection).toHaveBeenNthCalledWith(1, {
      userId: USER_ID,
      connectionId: CONNECTION_ID,
      correlationId: "request-one",
      disconnectedAt: NOW,
    });
    expect(disconnectOwnedConnection).toHaveBeenNthCalledWith(2, {
      userId: USER_ID,
      connectionId: CONNECTION_ID,
      correlationId: "request-two",
      disconnectedAt: NOW,
    });
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(getUserLeagues).not.toHaveBeenCalled();
  });

  it("returns a bounded local error when atomic credential removal fails", async () => {
    const service = new YahooSyncService({
      repository: repository({
        disconnectOwnedConnection: () =>
          Promise.reject(new Error("encrypted credential must not escape")),
      }),
      tokens: tokens(),
      client: readPort(),
      now: () => NOW,
    });

    await expect(
      service.disconnectConnection(USER_ID, CONNECTION_ID, "request-failure"),
    ).rejects.toMatchObject({
      code: "LOCAL_DISCONNECT_FAILED",
      statusCode: 500,
      message: "The stored Yahoo authorization could not be removed from Laces Out",
    });
  });

  it("paginates discovery and atomically hands each strict normalized bundle to persistence", async () => {
    const baseClient = readPort();
    const getUserLeagues = vi.fn((...input: Parameters<YahooReadPort["getUserLeagues"]>) =>
      baseClient.getUserLeagues(...input),
    );
    const persistBundle = vi.fn(
      (_userId: string, _connectionId: string, bundle: LeagueSyncBundle) =>
        Promise.resolve(receipt(bundle)),
    );
    const service = new YahooSyncService({
      repository: repository({ persistBundle }),
      tokens: tokens(),
      client: readPort({ getUserLeagues }),
      now: () => NOW,
      pageSize: 1,
    });

    const result = await service.discoverAndSync(USER_ID, CONNECTION_ID);

    expect(getUserLeagues).toHaveBeenNthCalledWith(
      1,
      { accessToken: "sanitized-access-token" },
      { gameKeys: ["nfl"], start: 0, count: 1 },
    );
    expect(getUserLeagues).toHaveBeenNthCalledWith(
      2,
      { accessToken: "sanitized-access-token" },
      { gameKeys: ["nfl"], start: 1, count: 1 },
    );
    expect(result.discovered).toHaveLength(1);
    expect(result.syncs).toHaveLength(1);
    expect(persistBundle).toHaveBeenCalledTimes(1);
    const persisted = persistBundle.mock.calls[0];
    expect(persisted?.[0]).toBe(USER_ID);
    expect(persisted?.[1]).toBe(CONNECTION_ID);
    expect(persisted?.[2].provider).toBe("yahoo");
    expect(persisted?.[2].league).toMatchObject({ externalId: "449.l.12345", season: 2026 });
    expect(persisted?.[2].standings?.entries).toHaveLength(2);
    expect(persisted?.[2].matchups?.matchups).toHaveLength(1);
  });

  it("refreshes once after an authenticated resource 401, then retries without exposing tokens", async () => {
    const getAccessToken = vi
      .fn<YahooAccessTokenPort["getAccessToken"]>()
      .mockResolvedValueOnce("expired-access-token")
      .mockResolvedValueOnce("fresh-access-token");
    const getUserLeagues = vi
      .fn<YahooReadPort["getUserLeagues"]>()
      .mockRejectedValueOnce(
        new YahooReadClientError({
          code: "UNAUTHORIZED",
          message: "Yahoo rejected the token",
          status: 401,
          refreshAccessToken: true,
        }),
      )
      .mockResolvedValueOnce(artifact(fixture("sanitized-user-leagues-page-2.xml")));
    const service = new YahooSyncService({
      repository: repository(),
      tokens: tokens({ getAccessToken }),
      client: readPort({ getUserLeagues }),
      now: () => NOW,
    });

    await expect(service.discoverAndSync(USER_ID, CONNECTION_ID)).resolves.toMatchObject({
      discovered: [],
      syncs: [],
    });
    expect(getAccessToken).toHaveBeenNthCalledWith(1, USER_ID, CONNECTION_ID);
    expect(getAccessToken).toHaveBeenNthCalledWith(2, USER_ID, CONNECTION_ID, {
      forceRefresh: true,
    });
    expect(getUserLeagues).toHaveBeenNthCalledWith(
      2,
      { accessToken: "fresh-access-token" },
      expect.any(Object),
    );
  });

  it("stops before credentials or provider reads for a connection owned by another user", async () => {
    const getAccessToken = vi.fn(() => Promise.resolve("must-not-be-used"));
    const baseClient = readPort();
    const getUserLeagues = vi.fn((...input: Parameters<YahooReadPort["getUserLeagues"]>) =>
      baseClient.getUserLeagues(...input),
    );
    const service = new YahooSyncService({
      repository: repository(),
      tokens: tokens({ getAccessToken }),
      client: readPort({ getUserLeagues }),
      now: () => NOW,
    });

    await expect(service.discoverAndSync(OTHER_USER_ID, CONNECTION_ID)).rejects.toMatchObject({
      code: "CONNECTION_NOT_FOUND",
    });
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(getUserLeagues).not.toHaveBeenCalled();
  });

  it("records a bounded connection health error when provider discovery fails", async () => {
    const markFailure = vi.fn(() => Promise.resolve());
    const service = new YahooSyncService({
      repository: repository({ markFailure }),
      tokens: tokens(),
      client: readPort({
        getUserLeagues: () =>
          Promise.reject(
            new YahooReadClientError({
              code: "RATE_LIMITED",
              message: "rate limited",
              status: 429,
              retryable: true,
            }),
          ),
      }),
      now: () => NOW,
    });

    await expect(service.discoverAndSync(USER_ID, CONNECTION_ID)).rejects.toMatchObject({
      code: "PROVIDER_READ_FAILED",
    });
    expect(markFailure).toHaveBeenCalledWith(USER_ID, CONNECTION_ID, "read_rate_limited", NOW);
  });

  it("keeps an explicit on-demand sync scoped to the authenticated connection", async () => {
    const persistBundle = vi.fn(
      (_userId: string, _connectionId: string, bundle: LeagueSyncBundle) =>
        Promise.resolve(receipt(bundle, "unchanged")),
    );
    const service = new YahooSyncService({
      repository: repository({ persistBundle }),
      tokens: tokens(),
      client: readPort(),
      now: () => NOW,
    });

    const result = await service.syncLeague(USER_ID, CONNECTION_ID, "449.l.12345");
    expect(result.state).toBe("unchanged");
    expect(persistBundle).toHaveBeenCalledWith(USER_ID, CONNECTION_ID, expect.any(Object));

    await expect(
      service.syncLeague(OTHER_USER_ID, CONNECTION_ID, "449.l.12345"),
    ).rejects.toBeInstanceOf(YahooSyncError);
    expect(persistBundle).toHaveBeenCalledTimes(1);
  });
});
