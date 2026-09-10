import { loadEnvironment } from "@laces-out/config";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "./app.js";
import { AuthService, type AuthRepository } from "./auth.js";
import { type DecisionInboxPort } from "./decision-inbox-routes.js";
import { buildDecisionInboxSummary } from "./decision-inbox-summary.js";
import {
  decisionInboxSnapshot,
  INBOX_LEAGUE_ID as LEAGUE,
  INBOX_NOW as NOW,
  INBOX_USER_ID as USER,
} from "./decision-inbox-test-fixtures.js";

const COOKIE = `fantasy_session=${"d".repeat(32)}`;
const inbox = buildDecisionInboxSummary(decisionInboxSnapshot());
const itemId = inbox.items[0]!.id;
const url = `/v1/leagues/${LEAGUE}/decision-inbox`;
const stateUrl = `${url}/${itemId}/state`;

function authService(): AuthService {
  const repository: AuthRepository = {
    findUserByEmail: () => Promise.resolve(undefined),
    createSession: () => Promise.resolve(),
    findSession: () =>
      Promise.resolve({
        user: { id: USER, email: "inbox@example.com", displayName: "Manager", role: "member" },
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
        lastSeenAt: new Date(),
      }),
    touchSession: () => Promise.resolve(),
    deleteSession: () => Promise.resolve(),
    deleteExpiredSessions: () => Promise.resolve(),
  };
  return new AuthService(repository);
}

const apps: FastifyInstance[] = [];
async function appFor(decisionInbox?: DecisionInboxPort) {
  const app = await buildApp({
    environment: loadEnvironment({ NODE_ENV: "test" }),
    logger: false,
    requireAuthentication: true,
    authService: authService(),
    ...(decisionInbox ? { decisionInbox } : {}),
  });
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("Decision inbox routes", () => {
  it("requires authentication and derives actor identity from the session", async () => {
    const getInbox = vi.fn(() => Promise.resolve(inbox));
    const setState = vi.fn(() => Promise.resolve({ itemId, state: "reviewed", updatedAt: NOW }));
    const app = await appFor({ getInbox, setState });
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: "POST", url: stateUrl, payload: { state: "reviewed" } }))
        .statusCode,
    ).toBe(401);
    expect(getInbox).not.toHaveBeenCalled();
    expect(setState).not.toHaveBeenCalled();
    const response = await app.inject({
      method: "GET",
      url: `${url}?refresh=true`,
      headers: { cookie: COOKIE },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toContain("no-store");
    expect(response.json()).toEqual(inbox);
    expect(getInbox).toHaveBeenCalledWith(USER, LEAGUE, { refresh: true });
    const changed = await app.inject({
      method: "POST",
      url: stateUrl,
      headers: { cookie: COOKIE },
      payload: { state: "reviewed" },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toEqual({ itemId, state: "reviewed", updatedAt: NOW });
    expect(setState).toHaveBeenCalledWith(USER, LEAGUE, itemId, "reviewed");
  });

  it("validates scopes, refresh flags, item fingerprints and state bodies", async () => {
    const getInbox = vi.fn(() => Promise.resolve(inbox));
    const setState = vi.fn(() => Promise.resolve(undefined));
    const app = await appFor({ getInbox, setState });
    for (const invalidUrl of [
      "/v1/leagues/not-a-uuid/decision-inbox",
      `${url}?refresh=1`,
      `${url}?userId=${USER}`,
    ]) {
      expect(
        (await app.inject({ method: "GET", url: invalidUrl, headers: { cookie: COOKIE } }))
          .statusCode,
      ).toBe(400);
    }
    for (const payload of [{ state: "read" }, { state: "reviewed", userId: USER }, {}]) {
      expect(
        (await app.inject({ method: "POST", url: stateUrl, headers: { cookie: COOKIE }, payload }))
          .statusCode,
      ).toBe(400);
    }
    expect(
      (
        await app.inject({
          method: "POST",
          url: `${url}/unknown/state`,
          headers: { cookie: COOKIE },
          payload: { state: "open" },
        })
      ).statusCode,
    ).toBe(400);
    expect(getInbox).not.toHaveBeenCalled();
    expect(setState).not.toHaveBeenCalled();
  });

  it("returns the same not-found response for inaccessible leagues and unknown items", async () => {
    const app = await appFor({
      getInbox: () => Promise.resolve(undefined),
      setState: () => Promise.resolve(undefined),
    });
    const missingLeague = await app.inject({ method: "GET", url, headers: { cookie: COOKIE } });
    const missingItem = await app.inject({
      method: "POST",
      url: stateUrl,
      headers: { cookie: COOKIE },
      payload: { state: "dismissed" },
    });
    expect(missingLeague.statusCode).toBe(404);
    expect(missingItem.statusCode).toBe(404);
    expect(missingLeague.json<{ title: string }>().title).toBe(
      missingItem.json<{ title: string }>().title,
    );
  });

  it("reports an unconfigured deployment without fabricating demo recommendations", async () => {
    const app = await appFor();
    expect((await app.inject({ method: "GET", url, headers: { cookie: COOKIE } })).statusCode).toBe(
      503,
    );
  });
});
