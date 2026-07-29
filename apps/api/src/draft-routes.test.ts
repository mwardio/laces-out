import { loadEnvironment } from "@fantasy/config";
import type {
  DraftAnalysisResponse,
  DraftMutationResponse,
  DraftSessionSnapshot,
} from "@fantasy/contracts";
import { describe, expect, it, vi } from "vitest";

import { buildApp } from "./app.js";
import { AuthService, type AuthRepository } from "./auth.js";
import type { DraftSessionPort } from "./draft-routes.js";
import { DraftSessionError } from "./draft-session.js";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const LEAGUE_SEASON_ID = "20000000-0000-4000-8000-000000000001";
const DRAFT_ID = "30000000-0000-4000-8000-000000000001";
const TEAM_A_ID = "40000000-0000-4000-8000-000000000001";
const TEAM_B_ID = "40000000-0000-4000-8000-000000000002";
const PLAYER_ID = "50000000-0000-4000-8000-000000000001";
const SESSION_TOKEN = "s".repeat(32);
const COOKIE = `fantasy_session=${SESSION_TOKEN}`;
const NOW = "2026-07-16T12:00:00.000Z";

const rosterSlot = {
  id: "slot:qb:1",
  type: "QB" as const,
  label: "QB 1",
  kind: "STARTER" as const,
  eligiblePositions: ["QB" as const],
};

const snapshot: DraftSessionSnapshot = {
  id: DRAFT_ID,
  leagueSeasonId: LEAGUE_SEASON_ID,
  transport: "manual",
  providerPolling: false,
  providerFeed: null,
  accessRole: "owner",
  sequence: 0,
  persistedState: "created",
  config: {
    mode: "SNAKE",
    teams: [
      { id: TEAM_A_ID, name: "Alpha", rosterSlots: [rosterSlot] },
      { id: TEAM_B_ID, name: "Bravo", rosterSlots: [rosterSlot] },
    ],
    players: [{ id: PLAYER_ID, name: "Alpha Arm", positions: ["QB"], nflTeam: "CHI" }],
    pickOrder: [TEAM_A_ID, TEAM_B_ID],
  },
  state: {
    mode: "SNAKE",
    teams: [
      { teamId: TEAM_A_ID, name: "Alpha", roster: [], openSlots: 1 },
      { teamId: TEAM_B_ID, name: "Bravo", roster: [], openSlots: 1 },
    ],
    draftedPlayerIds: [],
    activeEventIds: [],
    revertedEventIds: [],
    nextPick: { overallPick: 1, teamId: TEAM_A_ID },
    activeNomination: null,
    complete: false,
  },
  events: [],
  createdAt: NOW,
  updatedAt: NOW,
};

const mutation: DraftMutationResponse = {
  idempotent: false,
  appendedSequences: [1],
  session: { ...snapshot, sequence: 1, persistedState: "live" },
};

function authenticatedService(): AuthService {
  const repository: AuthRepository = {
    findUserByEmail: () => Promise.resolve(undefined),
    createSession: () => Promise.resolve(),
    findSession: () =>
      Promise.resolve({
        user: {
          id: USER_ID,
          email: "guru@example.com",
          displayName: "League Guru",
          role: "admin",
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

function draftPort(overrides: Partial<DraftSessionPort>): DraftSessionPort {
  return overrides as DraftSessionPort;
}

describe("draft session routes", () => {
  it("returns a validated, user-authorized draft-market baseline", async () => {
    const getBaseline = vi.fn(() =>
      Promise.resolve({
        state: "unavailable" as const,
        reason: "source-not-ready" as const,
        detail: "The daily draft-market source has not completed its first refresh.",
      }),
    );
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authenticatedService(),
      draftMarket: { getBaseline },
    });

    const response = await app.inject({
      method: "GET",
      url: `/v1/drafts/${DRAFT_ID}/market`,
      headers: { cookie: COOKIE },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ state: "unavailable", reason: "source-not-ready" });
    expect(getBaseline).toHaveBeenCalledWith(USER_ID, DRAFT_ID);
    await app.close();
  });

  it("requires authentication before creating a league-season session", async () => {
    const createSession = vi.fn(() => Promise.resolve(snapshot));
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authenticatedService(),
      draftSessions: draftPort({ createSession }),
    });

    const denied = await app.inject({
      method: "POST",
      url: "/v1/drafts",
      payload: { leagueSeasonId: LEAGUE_SEASON_ID, teamOrder: [TEAM_A_ID, TEAM_B_ID] },
    });
    expect(denied.statusCode).toBe(401);
    expect(createSession).not.toHaveBeenCalled();

    const created = await app.inject({
      method: "POST",
      url: "/v1/drafts",
      headers: { cookie: COOKIE },
      payload: { leagueSeasonId: LEAGUE_SEASON_ID, teamOrder: [TEAM_A_ID, TEAM_B_ID] },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      id: DRAFT_ID,
      transport: "manual",
      providerPolling: false,
    });
    expect(createSession).toHaveBeenCalledWith(USER_ID, {
      leagueSeasonId: LEAGUE_SEASON_ID,
      teamOrder: [TEAM_A_ID, TEAM_B_ID],
    });
    await app.close();
  });

  it("loads a session through the authenticated league member", async () => {
    const getSession = vi.fn(() => Promise.resolve(snapshot));
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authenticatedService(),
      draftSessions: draftPort({ getSession }),
    });

    const response = await app.inject({
      method: "GET",
      url: `/v1/drafts/${DRAFT_ID}`,
      headers: { cookie: COOKIE },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: DRAFT_ID, accessRole: "owner", sequence: 0 });
    expect(getSession).toHaveBeenCalledWith(USER_ID, DRAFT_ID);
    await app.close();
  });

  it("passes append sequence and idempotency data and distinguishes a new write", async () => {
    const appendEvent = vi
      .fn(() => Promise.resolve(mutation))
      .mockResolvedValueOnce(mutation)
      .mockResolvedValueOnce({ ...mutation, idempotent: true });
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authenticatedService(),
      draftSessions: draftPort({ appendEvent }),
    });
    const payload = {
      expectedSequence: 0,
      idempotencyKey: "draft-pick-0001",
      action: {
        type: "SNAKE_PLAYER_SELECTED",
        teamId: TEAM_A_ID,
        playerId: PLAYER_ID,
        overallPick: 1,
      },
    } as const;

    const response = await app.inject({
      method: "POST",
      url: `/v1/drafts/${DRAFT_ID}/events`,
      headers: { cookie: COOKIE },
      payload,
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ idempotent: false, appendedSequences: [1] });
    expect(appendEvent).toHaveBeenCalledWith(USER_ID, DRAFT_ID, payload);

    const retry = await app.inject({
      method: "POST",
      url: `/v1/drafts/${DRAFT_ID}/events`,
      headers: { cookie: COOKIE },
      payload,
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ idempotent: true, appendedSequences: [1] });
    await app.close();
  });

  it("returns the current sequence when a stale writer loses optimistic concurrency", async () => {
    const appendEvent = vi.fn(() =>
      Promise.reject(
        new DraftSessionError("DRAFT_VERSION_CONFLICT", "Reconnect before writing.", {
          currentSequence: 7,
        }),
      ),
    );
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authenticatedService(),
      draftSessions: draftPort({ appendEvent }),
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/drafts/${DRAFT_ID}/events`,
      headers: { cookie: COOKIE },
      payload: {
        expectedSequence: 0,
        idempotencyKey: "stale-pick-0001",
        action: {
          type: "SNAKE_PLAYER_SELECTED",
          teamId: TEAM_A_ID,
          playerId: PLAYER_ID,
          overallPick: 1,
        },
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: "DRAFT_VERSION_CONFLICT",
      currentSequence: 7,
    });
    await app.close();
  });

  it("routes undo and correction as explicit idempotent event-stream mutations", async () => {
    const undoEvent = vi.fn(() => Promise.resolve(mutation));
    const correctEvent = vi.fn(() => Promise.resolve({ ...mutation, appendedSequences: [2, 3] }));
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authenticatedService(),
      draftSessions: draftPort({ undoEvent, correctEvent }),
    });

    const undo = await app.inject({
      method: "POST",
      url: `/v1/drafts/${DRAFT_ID}/undo`,
      headers: { cookie: COOKIE },
      payload: { expectedSequence: 1, idempotencyKey: "draft-undo-0001", targetSequence: 1 },
    });
    expect(undo.statusCode).toBe(201);
    expect(undoEvent).toHaveBeenCalledWith(USER_ID, DRAFT_ID, {
      expectedSequence: 1,
      idempotencyKey: "draft-undo-0001",
      targetSequence: 1,
    });

    const correctionPayload = {
      expectedSequence: 1,
      idempotencyKey: "draft-fix-0001",
      targetSequence: 1,
      replacement: {
        type: "SNAKE_PLAYER_SELECTED",
        teamId: TEAM_B_ID,
        playerId: PLAYER_ID,
        overallPick: 1,
      },
    } as const;
    const correction = await app.inject({
      method: "POST",
      url: `/v1/drafts/${DRAFT_ID}/corrections`,
      headers: { cookie: COOKIE },
      payload: correctionPayload,
    });
    expect(correction.statusCode).toBe(201);
    expect(correction.json()).toMatchObject({ appendedSequences: [2, 3] });
    expect(correctEvent).toHaveBeenCalledWith(USER_ID, DRAFT_ID, correctionPayload);
    await app.close();
  });
});

const analysis: DraftAnalysisResponse = {
  draftId: DRAFT_ID,
  sequence: 0,
  generatedAt: NOW,
  algorithmVersion: "draft-analyzer-v1",
  inputChecksum: "c".repeat(64),
  mode: "SNAKE",
  draftStatus: "IN_PROGRESS",
  market: {
    state: "unavailable",
    reason: "source-not-ready",
    detail: "The daily draft-market source has not completed its first refresh.",
  },
  projections: {
    state: "unavailable",
    reason: "NO_COMPATIBLE_SET",
    detail:
      "No full-season projection set scored under league:ppr:v3 was published before this draft started.",
    candidatesConsidered: 0,
  },
  teams: [
    {
      mode: "SNAKE",
      teamId: TEAM_A_ID,
      name: "Alpha",
      roster: {
        rosteredPlayers: 0,
        totalRosterSlots: 1,
        openRosterSlots: 1,
        starterSlots: 1,
        coveredStarterSlots: 0,
        openStarterSlots: [{ slotId: "slot:qb:1", type: "QB", eligiblePositions: ["QB"] }],
        primaryPositionCounts: [],
        warnings: [
          {
            code: "OPEN_STARTER_SLOTS",
            message: "1 starter slot is not covered by the current roster.",
          },
        ],
      },
      selections: [],
      marketSummary: {
        status: "UNAVAILABLE",
        coveredSelections: 0,
        totalSelections: 0,
        averagePickVsAdp: null,
        values: 0,
        reaches: 0,
      },
      teamStrength: {
        status: "UNAVAILABLE",
        reason: "NO_PROJECTIONS",
        missingPlayerIds: [],
        message: "No league-scored projection set was supplied.",
      },
      warnings: [],
    },
  ],
  warnings: [
    {
      code: "MARKET_UNAVAILABLE",
      message: "The draft-market baseline is unavailable: source-not-ready.",
    },
    {
      code: "PROJECTIONS_UNAVAILABLE",
      message:
        "No full-season projection set scored under league:ppr:v3 was published before this draft started.",
    },
  ],
};

describe("draft analysis route", () => {
  it("returns the unknown-draft 404 when a non-member reads draft analysis", async () => {
    const getAnalysis = vi.fn(() =>
      Promise.reject(
        new DraftSessionError(
          "DRAFT_NOT_FOUND",
          "The draft session was not found for this account.",
        ),
      ),
    );
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authenticatedService(),
      draftAnalysis: { getAnalysis },
    });

    const response = await app.inject({
      method: "GET",
      url: `/v1/drafts/${DRAFT_ID}/analysis`,
      headers: { cookie: COOKIE },
    });

    expect(response.statusCode).toBe(404);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(response.json()).toMatchObject({
      type: "https://fantasy.local/problems/draft-not-found",
      title: "Draft request failed",
      status: 404,
      detail: "The draft session was not found for this account.",
      code: "DRAFT_NOT_FOUND",
    });
    expect(getAnalysis).toHaveBeenCalledWith(USER_ID, DRAFT_ID);
    await app.close();
  });

  it("matches the unknown-draft body served by the draft session route", async () => {
    const notFound = () =>
      Promise.reject(
        new DraftSessionError(
          "DRAFT_NOT_FOUND",
          "The draft session was not found for this account.",
        ),
      );
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authenticatedService(),
      draftSessions: draftPort({ getSession: vi.fn(notFound) }),
      draftAnalysis: { getAnalysis: vi.fn(notFound) },
    });

    const [session, report] = await Promise.all([
      app.inject({
        method: "GET",
        url: `/v1/drafts/${DRAFT_ID}`,
        headers: { cookie: COOKIE },
      }),
      app.inject({
        method: "GET",
        url: `/v1/drafts/${DRAFT_ID}/analysis`,
        headers: { cookie: COOKIE },
      }),
    ]);

    const withoutCorrelation = (body: Record<string, unknown>): Record<string, unknown> => {
      const rest = { ...body };
      delete rest.correlationId;
      return rest;
    };
    const reportBody = report.json<Record<string, unknown>>();
    expect(report.statusCode).toBe(session.statusCode);
    expect(withoutCorrelation(reportBody)).toEqual(
      withoutCorrelation(session.json<Record<string, unknown>>()),
    );
    expect(reportBody.correlationId).toEqual(expect.any(String));
    await app.close();
  });

  it("requires authentication before serving draft analysis", async () => {
    const getAnalysis = vi.fn(() => Promise.resolve(analysis));
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authenticatedService(),
      draftAnalysis: { getAnalysis },
    });

    const denied = await app.inject({ method: "GET", url: `/v1/drafts/${DRAFT_ID}/analysis` });
    expect(denied.statusCode).toBe(401);
    expect(getAnalysis).not.toHaveBeenCalled();

    const allowed = await app.inject({
      method: "GET",
      url: `/v1/drafts/${DRAFT_ID}/analysis`,
      headers: { cookie: COOKIE },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toMatchObject({
      draftId: DRAFT_ID,
      mode: "SNAKE",
      draftStatus: "IN_PROGRESS",
      projections: { state: "unavailable", reason: "NO_COMPATIBLE_SET" },
    });
    await app.close();
  });

  it("reports draft analysis unavailable when the port is not configured", async () => {
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authenticatedService(),
    });

    const response = await app.inject({
      method: "GET",
      url: `/v1/drafts/${DRAFT_ID}/analysis`,
      headers: { cookie: COOKIE },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ title: "Draft sessions are not configured" });
    await app.close();
  });
});
