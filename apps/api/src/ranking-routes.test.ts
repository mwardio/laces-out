import { loadEnvironment } from "@fantasy/config";
import { RANKING_SCHEMA_VERSION, createRankingList, createRankingVersion } from "@fantasy/rankings";
import { describe, expect, it, vi } from "vitest";

import { buildApp } from "./app.js";
import { AuthService, type AuthRepository } from "./auth.js";
import type { RankingPort } from "./ranking-routes.js";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const LIST_ID = "20000000-0000-4000-8000-000000000001";
const VERSION_ID = "30000000-0000-4000-8000-000000000001";
const SHARE_ID = "40000000-0000-4000-8000-000000000001";
const SESSION_TOKEN = "s".repeat(32);
const SHARE_TOKEN = `frs_${"a".repeat(43)}`;
const COOKIE = `fantasy_session=${SESSION_TOKEN}`;
const NOW = "2026-07-16T12:00:00.000Z";

const list = createRankingList({
  id: LIST_ID,
  ownerUserId: USER_ID,
  name: "Friends auction board",
  description: "A focused test board",
  season: 2026,
  kind: "auction-values",
  scoringContext: {
    format: "PPR",
    leagueId: null,
    settingsChecksumSha256: null,
    label: "PPR",
  },
  visibility: { scope: "private" },
  createdAt: NOW,
});

const version = createRankingVersion({
  schemaVersion: RANKING_SCHEMA_VERSION,
  id: VERSION_ID,
  listId: LIST_ID,
  versionNumber: 1,
  parentVersionId: null,
  state: "draft",
  authorUserId: USER_ID,
  createdAt: NOW,
  publishedAt: null,
  changeNote: "Initial board",
  entries: [],
  provenance: { operation: "edit", sources: [], note: "Initial board" },
});

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

function rankingPort(overrides: Partial<RankingPort>): RankingPort {
  return overrides as RankingPort;
}

describe("ranking routes", () => {
  it("requires a session and scopes list reads to the authenticated user", async () => {
    const listLists = vi.fn(() => Promise.resolve([list]));
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authenticatedService(),
      rankings: rankingPort({ listLists }),
    });

    const denied = await app.inject({ method: "GET", url: "/v1/rankings" });
    expect(denied.statusCode).toBe(401);
    expect(listLists).not.toHaveBeenCalled();

    const response = await app.inject({
      method: "GET",
      url: "/v1/rankings?includeArchived=true",
      headers: { cookie: COOKIE },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ lists: [{ id: LIST_ID }] });
    expect(listLists).toHaveBeenCalledWith(USER_ID, { includeArchived: true });
    await app.close();
  });

  it("passes optimistic-version draft writes through the authenticated actor", async () => {
    const replaceWithManualDraft = vi.fn(() => Promise.resolve(version));
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authenticatedService(),
      rankings: rankingPort({ replaceWithManualDraft }),
    });

    const response = await app.inject({
      method: "PUT",
      url: `/v1/rankings/${LIST_ID}/draft`,
      headers: { cookie: COOKIE },
      payload: {
        expectedCurrentVersionId: null,
        entries: [],
        changeNote: "Initial board",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ version: { id: VERSION_ID, state: "draft" } });
    expect(replaceWithManualDraft).toHaveBeenCalledWith({
      actorUserId: USER_ID,
      listId: LIST_ID,
      expectedCurrentVersionId: null,
      entries: [],
      changeNote: "Initial board",
    });
    await app.close();
  });

  it("requires authentication and scopes clone requests to the session user", async () => {
    const cloneList = vi.fn(() => Promise.resolve({ list, version }));
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authenticatedService(),
      rankings: rankingPort({ cloneList }),
    });

    const denied = await app.inject({
      method: "POST",
      url: `/v1/rankings/${LIST_ID}/clone`,
      payload: { name: "My baseline" },
    });
    expect(denied.statusCode).toBe(401);
    expect(cloneList).not.toHaveBeenCalled();

    const response = await app.inject({
      method: "POST",
      url: `/v1/rankings/${LIST_ID}/clone`,
      headers: { cookie: COOKIE },
      payload: { name: "My baseline", sourceVersionId: VERSION_ID },
    });
    expect(response.statusCode).toBe(201);
    expect(cloneList).toHaveBeenCalledWith({
      actorUserId: USER_ID,
      sourceListId: LIST_ID,
      sourceVersionId: VERSION_ID,
      name: "My baseline",
    });
    await app.close();
  });

  it("requires authentication and authorizes both sides of board comparisons through the actor", async () => {
    const compareLists = vi.fn(() =>
      Promise.resolve({
        left: { list, version },
        right: { list, version },
        players: [],
      }),
    );
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authenticatedService(),
      rankings: rankingPort({ compareLists }),
    });
    const payload = {
      left: { listId: LIST_ID, versionId: VERSION_ID },
      right: { listId: "20000000-0000-4000-8000-000000000002" },
    };

    const denied = await app.inject({ method: "POST", url: "/v1/rankings/compare", payload });
    expect(denied.statusCode).toBe(401);
    expect(compareLists).not.toHaveBeenCalled();

    const response = await app.inject({
      method: "POST",
      url: "/v1/rankings/compare",
      headers: { cookie: COOKIE },
      payload,
    });
    expect(response.statusCode).toBe(200);
    expect(compareLists).toHaveBeenCalledWith({
      actorUserId: USER_ID,
      leftListId: LIST_ID,
      leftVersionId: VERSION_ID,
      rightListId: "20000000-0000-4000-8000-000000000002",
    });
    await app.close();
  });

  it("keeps CSV preview separate from the explicit idempotent commit", async () => {
    const preview = {
      sourceChecksumSha256: "a".repeat(64),
      previewChecksumSha256: "b".repeat(64),
      headers: ["name", "rank"],
      mapping: { playerName: "name", overallRank: "rank" },
      rows: [
        {
          rowNumber: 2,
          cells: ["Alpha Arm", "1"],
          status: "ready" as const,
          playerId: USER_ID,
          entry: null,
          diagnostics: [],
        },
      ],
      diagnostics: [],
      summary: { total: 1, ready: 1, invalid: 0, unresolved: 0, duplicate: 0 },
      canCommitAll: true,
    };
    const previewCsv = vi.fn(() => Promise.resolve(preview));
    const importCsv = vi.fn(() => Promise.resolve(version));
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authenticatedService(),
      rankings: rankingPort({ previewCsv, importCsv }),
    });
    const source = "name,rank\nAlpha Arm,1\n";
    const mapping = { playerName: "name", overallRank: "rank" };

    const previewResponse = await app.inject({
      method: "POST",
      url: `/v1/rankings/${LIST_ID}/imports/csv/preview`,
      headers: { cookie: COOKIE },
      payload: { source, mapping, hasHeader: true },
    });
    expect(previewResponse.statusCode).toBe(200);
    expect(previewResponse.json()).toMatchObject({ preview: { canCommitAll: true } });
    expect(importCsv).not.toHaveBeenCalled();

    const commitResponse = await app.inject({
      method: "POST",
      url: `/v1/rankings/${LIST_ID}/imports/csv`,
      headers: { cookie: COOKIE },
      payload: {
        source,
        mapping,
        hasHeader: true,
        expectedCurrentVersionId: null,
        idempotencyKey: "route-import-001",
        decision: {
          mode: "all-valid",
          previewChecksumSha256: preview.previewChecksumSha256,
        },
      },
    });
    expect(commitResponse.statusCode).toBe(201);
    expect(importCsv).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: USER_ID,
        listId: LIST_ID,
        idempotencyKey: "route-import-001",
        decision: { mode: "all-valid", previewChecksumSha256: "b".repeat(64) },
      }),
    );
    await app.close();
  });

  it("returns new share capabilities only in a URL fragment", async () => {
    const createShare = vi.fn(() =>
      Promise.resolve({
        id: SHARE_ID,
        token: SHARE_TOKEN,
        list,
        expiresAt: null,
      }),
    );
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test", WEB_URL: "https://fourth.example" }),
      logger: false,
      requireAuthentication: true,
      authService: authenticatedService(),
      rankings: rankingPort({ createShare }),
    });

    const requestUrl = `/v1/rankings/${LIST_ID}/shares`;
    const response = await app.inject({
      method: "POST",
      url: requestUrl,
      headers: { cookie: COOKIE },
      payload: { allowCopy: true, maxUses: 10 },
    });
    expect(response.statusCode).toBe(201);
    expect(requestUrl).not.toContain(SHARE_TOKEN);
    expect(response.json()).toMatchObject({
      id: SHARE_ID,
      shareUrl: `https://fourth.example/rankings/shared#${SHARE_TOKEN}`,
    });
    expect(response.json()).not.toHaveProperty("token");
    await app.close();
  });

  it("opens a share publicly from a request body without putting the capability in the URL", async () => {
    const openShare = vi.fn(() =>
      Promise.resolve({ list, version, allowCopy: false, players: [] }),
    );
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authenticatedService(),
      rankings: rankingPort({ openShare }),
    });

    const requestUrl = "/v1/ranking-shares/open";
    const response = await app.inject({
      method: "POST",
      url: requestUrl,
      payload: { token: SHARE_TOKEN },
    });
    expect(response.statusCode).toBe(200);
    expect(requestUrl).not.toContain(SHARE_TOKEN);
    expect(response.json()).toMatchObject({ list: { id: LIST_ID }, version: { id: VERSION_ID } });
    expect(openShare).toHaveBeenCalledWith(SHARE_TOKEN);
    await app.close();
  });
});
