import { readFileSync } from "node:fs";

import {
  YahooReadClientError,
  YahooXmlError,
  type YahooXmlArtifact,
} from "@laces-out/connector-yahoo";
import type { LeagueSyncBundle } from "@laces-out/connectors";
import { describe, expect, it, vi } from "vitest";

import {
  YahooConnectionError,
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
    season: bundle.league.season,
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
    listLeagueExclusions: () => Promise.resolve([]),
    clearLeagueExclusions: () => Promise.resolve(),
    persistBundle: (_userId, _connectionId, bundle) => Promise.resolve(receipt(bundle)),
    markFailure: () => Promise.resolve(),
    markDiscoverySuccess: () => Promise.resolve(),
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

  it("keeps a removed league out of discovery until the member explicitly reconnects Yahoo", async () => {
    let excluded = true;
    const persistBundle = vi.fn(
      (_userId: string, _connectionId: string, bundle: LeagueSyncBundle) =>
        Promise.resolve(receipt(bundle)),
    );
    const clearLeagueExclusions = vi.fn(() => {
      excluded = false;
      return Promise.resolve();
    });
    const service = new YahooSyncService({
      repository: repository({
        persistBundle,
        clearLeagueExclusions,
        listLeagueExclusions: () =>
          Promise.resolve(excluded ? [{ externalKey: "449.l.12345", season: 2026 }] : []),
      }),
      tokens: tokens(),
      client: readPort(),
      now: () => NOW,
    });

    await expect(service.discoverAndSync(USER_ID, CONNECTION_ID)).resolves.toMatchObject({
      discovered: [],
      syncs: [],
    });
    expect(persistBundle).not.toHaveBeenCalled();

    await expect(
      service.discoverAndSync(USER_ID, CONNECTION_ID, { restoreRemoved: true }),
    ).resolves.toMatchObject({ syncs: [{ externalLeagueKey: "449.l.12345" }] });
    expect(clearLeagueExclusions).toHaveBeenCalledWith(USER_ID);
    expect(persistBundle).toHaveBeenCalledTimes(1);
  });

  it("syncs playable leagues while leaving a one-team Yahoo league for later discovery", async () => {
    const twoLeagues = fixture("sanitized-user-leagues-page-1.xml").replace(
      "</leagues>",
      `<league><league_key>449.l.67890</league_key><league_id>67890</league_id><name>Not Ready Yet</name><season>2026</season></league></leagues>`,
    );
    const baseClient = readPort();
    const persistBundle = vi.fn(
      (_userId: string, _connectionId: string, bundle: LeagueSyncBundle) =>
        Promise.resolve(receipt(bundle)),
    );
    const markFailure = vi.fn(() => Promise.resolve());
    const markDiscoverySuccess = vi.fn(() => Promise.resolve());
    const service = new YahooSyncService({
      repository: repository({ persistBundle, markFailure, markDiscoverySuccess }),
      tokens: tokens(),
      client: readPort({
        getUserLeagues: () => Promise.resolve(artifact(twoLeagues)),
        getLeagueTeams: (request, leagueKey) =>
          leagueKey === "449.l.67890"
            ? Promise.reject(
                new YahooXmlError(
                  "LEAGUE_NOT_READY",
                  "Yahoo league is not ready to sync until another team joins",
                ),
              )
            : baseClient.getLeagueTeams(request, leagueKey),
      }),
      now: () => NOW,
    });

    await expect(service.discoverAndSync(USER_ID, CONNECTION_ID)).resolves.toMatchObject({
      discovered: [{ externalId: "449.l.12345" }, { externalId: "449.l.67890" }],
      syncs: [{ externalLeagueKey: "449.l.12345" }],
    });
    expect(persistBundle).toHaveBeenCalledTimes(1);
    expect(markFailure).not.toHaveBeenCalled();
    expect(markDiscoverySuccess).toHaveBeenCalledWith(USER_ID, CONNECTION_ID, NOW);
  });

  it("rejects an explicit sync for a removed league without touching Yahoo or connection health", async () => {
    const getAccessToken = vi.fn(() => Promise.resolve("must-not-be-used"));
    const markFailure = vi.fn(() => Promise.resolve());
    const service = new YahooSyncService({
      repository: repository({
        markFailure,
        listLeagueExclusions: () => Promise.resolve([{ externalKey: "449.l.12345", season: 2026 }]),
      }),
      tokens: tokens({ getAccessToken }),
      client: readPort(),
      now: () => NOW,
    });

    await expect(service.syncLeague(USER_ID, CONNECTION_ID, "449.l.12345")).rejects.toMatchObject({
      code: "LEAGUE_REMOVED",
      statusCode: 409,
    });
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(markFailure).not.toHaveBeenCalled();
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
    const persistBundle = vi.fn<YahooSyncRepository["persistBundle"]>();
    const service = new YahooSyncService({
      repository: repository({ markFailure, persistBundle }),
      tokens: tokens(),
      client: readPort({
        getUserLeagues: () =>
          Promise.reject(
            new YahooReadClientError({
              code: "RATE_LIMITED",
              message: "rate limited",
              status: 429,
              retryable: true,
              retryAfterMs: 7_000,
            }),
          ),
      }),
      now: () => NOW,
    });

    await expect(service.discoverAndSync(USER_ID, CONNECTION_ID)).rejects.toMatchObject({
      code: "PROVIDER_READ_FAILED",
      retryable: true,
      retryAfterMs: 7_000,
      throttled: true,
    });
    expect(markFailure).toHaveBeenCalledWith(USER_ID, CONNECTION_ID, "read_rate_limited", NOW);
    expect(persistBundle).not.toHaveBeenCalled();
  });

  it.each([
    {
      category: "network",
      client: () =>
        readPort({
          getLeagueTeams: () =>
            Promise.reject(
              new YahooReadClientError({
                code: "NETWORK",
                message: "Yahoo request failed before a response",
                retryable: true,
              }),
            ),
        }),
    },
    {
      category: "schema",
      client: () =>
        readPort({
          getLeagueTeams: () => Promise.resolve(artifact("<fantasy_content><broken>")),
        }),
    },
    {
      category: "partial-artifact",
      client: () =>
        readPort({
          getLeagueMatchups: () =>
            Promise.reject(
              new YahooReadClientError({
                code: "UPSTREAM_ERROR",
                message: "One required artifact was unavailable",
                status: 503,
                retryable: true,
              }),
            ),
        }),
    },
  ])("preserves last-good state on $category failure", async ({ client }) => {
    const persistBundle = vi.fn<YahooSyncRepository["persistBundle"]>();
    const markFailure = vi.fn(() => Promise.resolve());
    const service = new YahooSyncService({
      repository: repository({ persistBundle, markFailure }),
      tokens: tokens(),
      client: client(),
      now: () => NOW,
    });

    await expect(service.syncLeague(USER_ID, CONNECTION_ID, "449.l.12345")).rejects.toMatchObject({
      code: "PROVIDER_READ_FAILED",
    });
    expect(persistBundle).not.toHaveBeenCalled();
    expect(markFailure).toHaveBeenCalledTimes(1);
  });

  it("preserves last-good state when the connection requires reauthorization", async () => {
    const persistBundle = vi.fn<YahooSyncRepository["persistBundle"]>();
    const markFailure = vi.fn(() => Promise.resolve());
    const baseClient = readPort();
    const getLeagueSettings = vi.fn((...input: Parameters<YahooReadPort["getLeagueSettings"]>) =>
      baseClient.getLeagueSettings(...input),
    );
    const service = new YahooSyncService({
      repository: repository({ persistBundle, markFailure }),
      tokens: tokens({
        getAccessToken: () =>
          Promise.reject(
            new YahooConnectionError(
              "REAUTHORIZATION_REQUIRED",
              "Yahoo connection requires reauthorization",
            ),
          ),
      }),
      client: readPort({ getLeagueSettings }),
      now: () => NOW,
    });

    await expect(service.syncLeague(USER_ID, CONNECTION_ID, "449.l.12345")).rejects.toMatchObject({
      code: "PROVIDER_READ_FAILED",
    });
    expect(persistBundle).not.toHaveBeenCalled();
    expect(getLeagueSettings).not.toHaveBeenCalled();
    expect(markFailure).toHaveBeenCalledWith(
      USER_ID,
      CONNECTION_ID,
      "reauthorization_required",
      NOW,
    );
  });

  it("reports an atomic persistence failure without a success receipt", async () => {
    const markFailure = vi.fn(() => Promise.resolve());
    const persistBundle = vi.fn<YahooSyncRepository["persistBundle"]>(() =>
      Promise.reject(new Error("transaction rolled back")),
    );
    const service = new YahooSyncService({
      repository: repository({ persistBundle, markFailure }),
      tokens: tokens(),
      client: readPort(),
      now: () => NOW,
    });

    await expect(service.syncLeague(USER_ID, CONNECTION_ID, "449.l.12345")).rejects.toMatchObject({
      code: "PERSISTENCE_FAILED",
    });
    expect(persistBundle).toHaveBeenCalledTimes(1);
    expect(markFailure).toHaveBeenCalledWith(USER_ID, CONNECTION_ID, "persistence_failed", NOW);
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
