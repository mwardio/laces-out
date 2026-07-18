import { describe, expect, it } from "vitest";

import { loadEnvironment } from "@fantasy/config";

import { AuthService, type AuthRepository } from "./auth.js";
import { buildApp, requestPathForLog } from "./app.js";
import { LeagueDashboardError } from "./league-dashboard.js";

const testSessionToken = "s".repeat(32);

function authenticatedService(role: "member" | "admin" = "admin"): AuthService {
  const repository: AuthRepository = {
    findUserByEmail: () => Promise.resolve(undefined),
    createSession: () => Promise.resolve(),
    findSession: () =>
      Promise.resolve({
        user: {
          id: "00000000-0000-4000-8000-000000000001",
          email: "guru@example.com",
          displayName: "League Guru",
          role,
        },
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
        lastSeenAt: new Date(),
      }),
    touchSession: () => Promise.resolve(),
    deleteSession: () => Promise.resolve(),
    deleteExpiredSessions: () => Promise.resolve(),
  };
  return new AuthService(repository);
}

const authenticatedCookie = `fantasy_session=${testSessionToken}`;
const leagueId = "00000000-0000-4000-8000-000000000101";
const teamId = "00000000-0000-4000-8000-000000000102";
const invitationToken = "i".repeat(43);

function espnManualSnapshot() {
  return {
    schemaVersion: 1,
    provider: "espn",
    importedAt: "2026-07-16T20:00:00.000Z",
    league: {
      id: "12345",
      season: 2026,
      name: "Friends League",
      currentWeek: 1,
      settings: {
        teamCount: 2,
        draftType: "auction",
        auctionBudget: 200,
        waiverType: "faab",
        faabBudget: 100,
        playoffTeamCount: 2,
        rosterSlots: [{ position: "QB", count: 1, starting: true }],
        scoringRules: [],
      },
    },
    teams: [
      {
        id: "1",
        name: "Tech Gurus",
        abbreviation: "TG",
        logoUrl: null,
        isCurrentUser: true,
        managers: [],
        roster: [],
      },
      {
        id: "2",
        name: "Wide Right",
        abbreviation: "WR",
        logoUrl: null,
        isCurrentUser: false,
        managers: [],
        roster: [],
      },
    ],
  };
}

function invitationPort() {
  return {
    create: () =>
      Promise.resolve({
        id: "00000000-0000-4000-8000-000000000201",
        token: invitationToken,
        email: "friend@example.com",
        role: "member" as const,
        scope: null,
        expiresAt: new Date("2026-07-23T22:00:00.000Z"),
      }),
    inspect: () =>
      Promise.resolve({
        id: "00000000-0000-4000-8000-000000000201",
        emailHint: "f*****@example.com",
        role: "member" as const,
        scope: null,
        expiresAt: new Date("2026-07-23T22:00:00.000Z"),
        requiresAuthentication: false,
      }),
    accept: () =>
      Promise.resolve({
        invitationId: "00000000-0000-4000-8000-000000000201",
        user: {
          id: "00000000-0000-4000-8000-000000000202",
          email: "friend@example.com",
          displayName: "Fantasy Friend",
        },
        createdUser: false,
        membership: null,
      }),
    revoke: (_userId: string, invitationId: string) => Promise.resolve({ id: invitationId }),
  };
}

function leagueListFixture() {
  return {
    generatedAt: "2026-07-16T22:00:00.000Z",
    leagues: [
      {
        id: leagueId,
        name: "Friends League",
        archived: false,
        membership: {
          role: "manager" as const,
          claimedFantasyTeamId: null,
          claimedTeamName: null,
          claimedAt: null,
        },
        season: {
          id: "00000000-0000-4000-8000-000000000103",
          provider: "espn" as const,
          season: 2026,
          status: "active",
          teamCount: 10,
          draftType: "auction",
          waiverType: "faab",
          currentWeek: 1,
          lastSyncedAt: "2026-07-16T21:00:00.000Z",
          providerFreshness: {
            state: "fresh" as const,
            observedAt: "2026-07-16T21:00:00.000Z",
            label: "Synced 1h ago",
          },
        },
      },
    ],
  };
}

describe("API", () => {
  it("removes query parameters before a request URL enters logs", () => {
    expect(
      requestPathForLog("/v1/connections/yahoo/callback?code=SECRET_CODE&state=SECRET_STATE"),
    ).toBe("/v1/connections/yahoo/callback");
    expect(requestPathForLog("/v1/leagues")).toBe("/v1/leagues");
    expect(requestPathForLog(undefined)).toBe("");
  });

  it("does not echo query parameters in problem details", async () => {
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
    });

    const response = await app.inject({
      method: "GET",
      url: "/missing?code=SECRET_CODE&state=SECRET_STATE",
    });

    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain("SECRET_CODE");
    expect(response.body).not.toContain("SECRET_STATE");
    expect(response.json()).toMatchObject({
      detail: "No route matches GET /missing",
      instance: "/missing",
    });
    await app.close();
  });

  it("reports liveness with a correlation ID", async () => {
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
    });

    const response = await app.inject({ method: "GET", url: "/health/live" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["x-request-id"]).toBeTruthy();
    expect(response.json()).toMatchObject({ status: "ok", service: "fantasy-api" });
    await app.close();
  });

  it("serves a schema-validated demo dashboard without pretending it is live", async () => {
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
    });

    const response = await app.inject({ method: "GET", url: "/v1/dashboard" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ mode: "demo", season: 2026 });
    await app.close();
  });

  it("requires an authenticated session for the DB-backed league portfolio", async () => {
    let called = false;
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authenticatedService(),
      leagueDashboard: {
        listLeagues: () => {
          called = true;
          return Promise.resolve(leagueListFixture());
        },
        getDashboard: () => Promise.resolve(undefined),
        claimTeam: () => Promise.reject(new Error("not used")),
      },
    });

    const response = await app.inject({ method: "GET", url: "/v1/leagues" });
    expect(response.statusCode).toBe(401);
    expect(called).toBe(false);
    await app.close();
  });

  it("scopes the league portfolio read to the authenticated user", async () => {
    const userIds: string[] = [];
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authenticatedService(),
      leagueDashboard: {
        listLeagues: (userId) => {
          userIds.push(userId);
          return Promise.resolve(leagueListFixture());
        },
        getDashboard: () => Promise.resolve(undefined),
        claimTeam: () => Promise.reject(new Error("not used")),
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/v1/leagues",
      headers: { cookie: authenticatedCookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ leagues: [{ id: leagueId }] });
    expect(userIds).toEqual(["00000000-0000-4000-8000-000000000001"]);
    await app.close();
  });

  it("does not expose a league dashboard when the membership-scoped read misses", async () => {
    const reads: Array<{ userId: string; requestedLeagueId: string }> = [];
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authenticatedService(),
      leagueDashboard: {
        listLeagues: () => Promise.resolve(leagueListFixture()),
        getDashboard: (userId, requestedLeagueId) => {
          reads.push({ userId, requestedLeagueId });
          return Promise.resolve(undefined);
        },
        claimTeam: () => Promise.reject(new Error("not used")),
      },
    });

    const response = await app.inject({
      method: "GET",
      url: `/v1/leagues/${leagueId}/dashboard`,
      headers: { cookie: authenticatedCookie },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ title: "League not found" });
    expect(reads).toEqual([
      {
        userId: "00000000-0000-4000-8000-000000000001",
        requestedLeagueId: leagueId,
      },
    ]);
    await app.close();
  });

  it("claims only through the authenticated member and reports claim conflicts", async () => {
    const claims: Array<{ userId: string; requestedLeagueId: string; requestedTeamId: string }> =
      [];
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authenticatedService(),
      leagueDashboard: {
        listLeagues: () => Promise.resolve(leagueListFixture()),
        getDashboard: () => Promise.resolve(undefined),
        claimTeam: (userId, requestedLeagueId, requestedTeamId) => {
          claims.push({ userId, requestedLeagueId, requestedTeamId });
          return Promise.reject(
            new LeagueDashboardError("TEAM_TAKEN", "That fantasy team is already claimed"),
          );
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/leagues/${leagueId}/team-claim`,
      headers: { cookie: authenticatedCookie },
      payload: { teamId },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      status: 409,
      detail: "That fantasy team is already claimed",
    });
    expect(claims).toEqual([
      {
        userId: "00000000-0000-4000-8000-000000000001",
        requestedLeagueId: leagueId,
        requestedTeamId: teamId,
      },
    ]);
    await app.close();
  });

  it("uses problem details for unknown routes", async () => {
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
    });

    const response = await app.inject({ method: "GET", url: "/not-here" });
    expect(response.statusCode).toBe(404);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(response.json()).toMatchObject({ status: 404, title: "Route not found" });
    await app.close();
  });

  it("allows credentialed PATCH requests in web CORS preflights", async () => {
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authenticatedService(),
    });

    const response = await app.inject({
      method: "OPTIONS",
      url: "/v1/rankings/00000000-0000-4000-8000-000000000001",
      headers: {
        origin: "http://localhost:3000",
        "access-control-request-method": "PATCH",
        "access-control-request-headers": "content-type",
      },
    });
    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
    expect(response.headers["access-control-allow-methods"]).toContain("PATCH");
    expect(response.headers["access-control-allow-credentials"]).toBe("true");
    await app.close();
  });

  it("allows the ESPN one-click bookmark to preflight the bridge snapshot route", async () => {
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
    });

    const response = await app.inject({
      method: "OPTIONS",
      url: "/v1/bridge/espn/snapshots",
      headers: {
        origin: "https://fantasy.espn.com",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,content-type",
      },
    });
    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe("https://fantasy.espn.com");
    expect(response.headers["access-control-allow-headers"]).toContain("authorization");
    expect(response.headers["access-control-allow-credentials"]).toBeUndefined();

    const unrelatedRoute = await app.inject({
      method: "OPTIONS",
      url: "/v1/rankings/00000000-0000-4000-8000-000000000001",
      headers: {
        origin: "https://fantasy.espn.com",
        "access-control-request-method": "PATCH",
      },
    });
    expect(unrelatedRoute.headers["access-control-allow-origin"]).not.toBe(
      "https://fantasy.espn.com",
    );
    await app.close();
  });

  it("validates and enqueues an on-demand refresh", async () => {
    const enqueued: unknown[] = [];
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authenticatedService(),
      enqueueRefresh: async (request) => {
        enqueued.push(request);
        return "refresh-job-1";
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/refreshes",
      headers: { cookie: authenticatedCookie },
      payload: { scope: "player-data" },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      jobId: "refresh-job-1",
      state: "queued",
      target: "shared-nfl-data",
    });
    expect(enqueued).toMatchObject([
      {
        requestedBy: "00000000-0000-4000-8000-000000000001",
        refresh: { scope: "player-data" },
      },
    ]);
    await app.close();
  });

  it("never falls back to a demo identity for an unauthenticated refresh", async () => {
    const enqueued: unknown[] = [];
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: false,
      enqueueRefresh: (request) => {
        enqueued.push(request);
        return Promise.resolve("must-not-run");
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/refreshes",
      payload: { scope: "player-data" },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ title: "Authentication required" });
    expect(enqueued).toEqual([]);
    await app.close();
  });

  it("resolves a real refresh user even when the global development guard is disabled", async () => {
    const enqueued: unknown[] = [];
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: false,
      authService: authenticatedService(),
      enqueueRefresh: (request) => {
        enqueued.push(request);
        return Promise.resolve("refresh-job-2");
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/refreshes",
      headers: { cookie: authenticatedCookie },
      payload: { scope: "player-data" },
    });
    expect(response.statusCode).toBe(202);
    expect(enqueued).toMatchObject([
      {
        requestedBy: "00000000-0000-4000-8000-000000000001",
        refresh: { scope: "player-data" },
      },
    ]);
    await app.close();
  });

  it("requires a league ID for a league refresh", async () => {
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authenticatedService(),
      enqueueRefresh: async () => "should-not-run",
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/refreshes",
      headers: { cookie: authenticatedCookie },
      payload: { scope: "league" },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("rejects legacy broad refresh scopes that do not map to the catalog job", async () => {
    const enqueued: unknown[] = [];
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authenticatedService(),
      enqueueRefresh: (request) => {
        enqueued.push(request);
        return Promise.resolve("must-not-run");
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/refreshes",
      headers: { cookie: authenticatedCookie },
      payload: { scope: "all" },
    });
    expect(response.statusCode).toBe(400);
    expect(enqueued).toEqual([]);
    await app.close();
  });

  it("checks membership before disclosing league-specific refresh behavior", async () => {
    const authorizationCalls: unknown[] = [];
    const enqueued: unknown[] = [];
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authenticatedService("member"),
      refreshAuthorization: {
        canAccessLeague: (userId, requestedLeagueId) => {
          authorizationCalls.push({ userId, requestedLeagueId });
          return Promise.resolve(false);
        },
      },
      enqueueRefresh: (request) => {
        enqueued.push(request);
        return Promise.resolve("must-not-run");
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/refreshes",
      headers: { cookie: authenticatedCookie },
      payload: { scope: "league", leagueId },
    });
    expect(response.statusCode).toBe(404);
    const inaccessibleLeagueProblem = response.json<{
      type: string;
      title: string;
      status: number;
    }>();
    expect(inaccessibleLeagueProblem).toMatchObject({
      type: "https://fantasy.local/problems/league-not-found",
      title: "League not found",
      status: 404,
    });
    const unknownLeagueResponse = await app.inject({
      method: "POST",
      url: "/v1/refreshes",
      headers: { cookie: authenticatedCookie },
      payload: {
        scope: "league",
        leagueId: "00000000-0000-4000-8000-000000000199",
      },
    });
    expect(unknownLeagueResponse.statusCode).toBe(404);
    const unknownLeagueProblem = unknownLeagueResponse.json<{
      type: string;
      title: string;
      status: number;
    }>();
    expect(unknownLeagueProblem).toMatchObject({
      type: inaccessibleLeagueProblem.type,
      title: inaccessibleLeagueProblem.title,
      status: inaccessibleLeagueProblem.status,
    });
    expect(authorizationCalls).toEqual([
      {
        userId: "00000000-0000-4000-8000-000000000001",
        requestedLeagueId: leagueId,
      },
      {
        userId: "00000000-0000-4000-8000-000000000001",
        requestedLeagueId: "00000000-0000-4000-8000-000000000199",
      },
    ]);
    expect(enqueued).toEqual([]);
    await app.close();
  });

  it("directs an authorized league member to provider-specific sync without a no-op job", async () => {
    const enqueued: unknown[] = [];
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authenticatedService("member"),
      refreshAuthorization: { canAccessLeague: () => Promise.resolve(true) },
      enqueueRefresh: (request) => {
        enqueued.push(request);
        return Promise.resolve("must-not-run");
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/refreshes",
      headers: { cookie: authenticatedCookie },
      payload: { scope: "league", leagueId },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      title: "Use the provider-specific league sync",
    });
    expect(enqueued).toEqual([]);
    await app.close();
  });

  it("starts a user-bound Yahoo authorization flow", async () => {
    const calls: unknown[] = [];
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authenticatedService(),
      yahooConnection: {
        start: (userId, returnTo) => {
          calls.push({ userId, returnTo });
          return Promise.resolve({
            authorizationUrl: "https://api.login.yahoo.com/oauth2/request_auth?state=safe",
            expiresAt: "2026-07-16T22:00:00.000Z",
          });
        },
        complete: () => Promise.reject(new Error("not used")),
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/connections/yahoo/authorize",
      headers: { cookie: authenticatedCookie },
      payload: { returnTo: "/connections?from=settings" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ expiresAt: "2026-07-16T22:00:00.000Z" });
    expect(calls).toEqual([
      {
        userId: "00000000-0000-4000-8000-000000000001",
        returnTo: "/connections?from=settings",
      },
    ]);
    await app.close();
  });

  it("rejects a cross-origin Yahoo return path", async () => {
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authenticatedService(),
      yahooConnection: {
        start: () => Promise.reject(new Error("must not run")),
        complete: () => Promise.reject(new Error("must not run")),
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/connections/yahoo/authorize",
      headers: { cookie: authenticatedCookie },
      payload: { returnTo: "//attacker.example/steal" },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("completes Yahoo authorization with a same-origin redirect", async () => {
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authenticatedService(),
      yahooConnection: {
        start: () => Promise.reject(new Error("not used")),
        complete: () => Promise.resolve({ connectionId: "connection-1", returnTo: "/connections" }),
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/v1/connections/yahoo/callback?code=grant&state=opaque",
      headers: { cookie: authenticatedCookie },
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(
      "http://localhost:3000/connections?provider=yahoo&status=connected",
    );
    await app.close();
  });

  it("validates a provenance-bearing ESPN import without storing private cookies", async () => {
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authenticatedService(),
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/connections/espn/import/validate",
      headers: { cookie: authenticatedCookie },
      payload: {
        schemaVersion: 1,
        provider: "espn",
        importedAt: "2026-07-16T20:00:00.000Z",
        league: {
          id: "12345",
          season: 2026,
          name: "Friends League",
          currentWeek: 1,
          settings: {
            teamCount: 1,
            draftType: "auction",
            auctionBudget: 200,
            waiverType: "faab",
            faabBudget: 100,
            playoffTeamCount: 1,
            rosterSlots: [{ position: "QB", count: 1, starting: true }],
            scoringRules: [],
          },
        },
        teams: [
          {
            id: "1",
            name: "Tech Gurus",
            abbreviation: "TG",
            logoUrl: null,
            isCurrentUser: true,
            managers: [],
            roster: [],
          },
        ],
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      valid: true,
      league: { name: "Friends League", teamCount: 1, draftType: "auction" },
      provenance: { mode: "manual-import" },
    });
    await app.close();
  });

  it("commits only an explicitly confirmed ESPN snapshot for the authenticated user", async () => {
    const commits: unknown[] = [];
    const checksum = "a".repeat(64);
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authenticatedService(),
      espnImports: {
        commit: (userId, input) => {
          commits.push({ userId, input });
          return Promise.resolve({
            receiptId: "00000000-0000-4000-8000-000000000401",
            state: "accepted" as const,
            league: {
              id: "00000000-0000-4000-8000-000000000402",
              leagueSeasonId: "00000000-0000-4000-8000-000000000403",
              externalId: "espn:2026:12345",
              name: "Friends League",
              season: 2026,
              teamCount: 2,
              draftType: "auction" as const,
            },
            provenance: {
              mode: "manual-import" as const,
              fetchedAt: "2026-07-16T20:00:00.000Z",
              endpoint: null,
              artifactChecksumSha256: checksum,
              ageSeconds: 60,
            },
            committedAt: "2026-07-16T20:01:00.000Z",
            recordsWritten: 6,
            warnings: ["Manual recovery snapshot"],
          });
        },
      },
    });
    const snapshot = espnManualSnapshot();
    const response = await app.inject({
      method: "POST",
      url: "/v1/connections/espn/import/commit",
      headers: { cookie: authenticatedCookie },
      payload: { snapshot, expectedChecksumSha256: checksum, confirmed: true },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      state: "accepted",
      league: {
        name: "Friends League",
        leagueSeasonId: "00000000-0000-4000-8000-000000000403",
      },
      provenance: { mode: "manual-import", artifactChecksumSha256: checksum },
    });
    expect(commits).toEqual([
      {
        userId: "00000000-0000-4000-8000-000000000001",
        input: { snapshot, expectedChecksumSha256: checksum, confirmed: true },
      },
    ]);
    await app.close();
  });

  it("rejects ESPN credentials and header material from the strict recovery artifact", async () => {
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authenticatedService(),
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/connections/espn/import/validate",
      headers: { cookie: authenticatedCookie },
      payload: {
        ...espnManualSnapshot(),
        espn_s2: "must-never-be-accepted",
        swid: "{must-never-be-accepted}",
        headers: { Cookie: "espn_s2=must-never-be-accepted" },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ title: "Request validation failed" });
    await app.close();
  });

  it("pairs an ESPN browser bridge to the authenticated user", async () => {
    const registrations: unknown[] = [];
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authenticatedService(),
      espnBridge: {
        listDevices: () => Promise.resolve({ generatedAt: new Date().toISOString(), devices: [] }),
        registerDevice: (userId, input) => {
          registrations.push({ userId, input });
          return Promise.resolve({
            deviceId: "00000000-0000-4000-8000-000000000010",
            deviceToken: `lo_espn_${"a".repeat(43)}`,
            expiresAt: null,
          });
        },
        acceptSnapshot: () => Promise.reject(new Error("not used")),
        revokeDevice: () => Promise.reject(new Error("not used")),
      },
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/bridge/espn/devices",
      headers: { cookie: authenticatedCookie },
      payload: { name: "Mack's Chrome", allowedLeagueIds: ["12345", "67890"] },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      deviceId: "00000000-0000-4000-8000-000000000010",
    });
    expect(registrations).toEqual([
      {
        userId: "00000000-0000-4000-8000-000000000001",
        input: { name: "Mack's Chrome", allowedLeagueIds: ["12345", "67890"] },
      },
    ]);
    await app.close();
  });

  it("lists and revokes only the authenticated user's ESPN bridge devices", async () => {
    const calls: Array<{ operation: string; userId: string; deviceId?: string }> = [];
    const deviceId = "00000000-0000-4000-8000-000000000010";
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authenticatedService(),
      espnBridge: {
        listDevices: (userId) => {
          calls.push({ operation: "list", userId });
          return Promise.resolve({
            generatedAt: "2026-07-16T22:00:00.000Z",
            devices: [
              {
                deviceId,
                name: "Mack's Chrome",
                state: "active" as const,
                allowedLeagues: [
                  {
                    externalLeagueId: "12345",
                    season: null,
                    leagueId: null,
                    leagueName: null,
                  },
                ],
                createdAt: "2026-07-16T21:00:00.000Z",
                expiresAt: "2027-07-16T21:00:00.000Z",
                lastSeenAt: null,
                revokedAt: null,
              },
            ],
          });
        },
        registerDevice: () => Promise.reject(new Error("not used")),
        acceptSnapshot: () => Promise.reject(new Error("not used")),
        revokeDevice: (userId, requestedDeviceId) => {
          calls.push({ operation: "revoke", userId, deviceId: requestedDeviceId });
          return Promise.resolve({
            deviceId: requestedDeviceId,
            revokedAt: "2026-07-16T22:01:00.000Z",
          });
        },
      },
    });

    const list = await app.inject({
      method: "GET",
      url: "/v1/bridge/espn/devices",
      headers: { cookie: authenticatedCookie },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({ devices: [{ deviceId, state: "active" }] });

    const revoke = await app.inject({
      method: "DELETE",
      url: `/v1/bridge/espn/devices/${deviceId}`,
      headers: { cookie: authenticatedCookie },
    });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json()).toMatchObject({ deviceId });
    expect(calls).toEqual([
      { operation: "list", userId: "00000000-0000-4000-8000-000000000001" },
      {
        operation: "revoke",
        userId: "00000000-0000-4000-8000-000000000001",
        deviceId,
      },
    ]);
    await app.close();
  });

  it("accepts an authenticated ESPN bridge snapshot without an application cookie", async () => {
    const snapshots: unknown[] = [];
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      espnBridge: {
        listDevices: () => Promise.reject(new Error("not used")),
        registerDevice: () => Promise.reject(new Error("not used")),
        acceptSnapshot: (_token, snapshot) => {
          snapshots.push(snapshot);
          return Promise.resolve({
            receiptId: "00000000-0000-4000-8000-000000000020",
            state: "accepted" as const,
            receivedAt: "2026-07-16T22:00:00.000Z",
          });
        },
        revokeDevice: () => Promise.reject(new Error("not used")),
      },
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/bridge/espn/snapshots",
      headers: { authorization: `Bridge lo_espn_${"b".repeat(43)}` },
      payload: {
        schemaVersion: 1,
        provider: "espn",
        authority: "browser-local",
        readOnly: true,
        leagueId: "12345",
        season: 2026,
        capturedAt: "2026-07-16T21:59:00.000Z",
        endpoint:
          "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/2026/segments/0/leagues/12345?view=mRoster",
        checksumSha256: "a".repeat(64),
        payload: { id: 12345, teams: [], settings: {} },
      },
    });
    expect(response.statusCode).toBe(202);
    expect(snapshots).toHaveLength(1);
    await app.close();
  });

  it("creates a fragment-based invitation URL for an administrator", async () => {
    const app = await buildApp({
      environment: loadEnvironment({
        NODE_ENV: "test",
        WEB_URL: "https://laces-out.example",
      }),
      logger: false,
      requireAuthentication: true,
      authService: authenticatedService("admin"),
      invitations: invitationPort(),
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/invitations",
      headers: { cookie: authenticatedCookie },
      payload: { email: "friend@example.com" },
    });
    expect(response.statusCode).toBe(201);
    const invitationResponse = response.json<{
      readonly invitationUrl: string;
      readonly email: string;
    }>();
    expect(invitationResponse).toMatchObject({
      invitationUrl: `https://laces-out.example/invite#${invitationToken}`,
      email: "friend@example.com",
    });
    expect(invitationResponse.invitationUrl).not.toContain("?token=");
    await app.close();
  });

  it("allows public capability inspection and acceptance without making admin routes public", async () => {
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authenticatedService("member"),
      invitations: invitationPort(),
    });
    const inspection = await app.inject({
      method: "POST",
      url: "/v1/invitations/inspect",
      payload: { token: invitationToken },
    });
    expect(inspection.statusCode).toBe(200);
    expect(inspection.json()).toMatchObject({
      emailHint: "f*****@example.com",
      requiresAuthentication: false,
    });

    const acceptance = await app.inject({
      method: "POST",
      url: "/v1/invitations/accept",
      payload: { token: invitationToken },
    });
    expect(acceptance.statusCode).toBe(200);
    expect(acceptance.json()).toMatchObject({ createdUser: false, sessionEstablished: false });

    const forbidden = await app.inject({
      method: "POST",
      url: "/v1/admin/invitations",
      headers: { cookie: authenticatedCookie },
      payload: { email: "friend@example.com" },
    });
    expect(forbidden.statusCode).toBe(403);
    await app.close();
  });
});
