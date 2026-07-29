import { loadEnvironment } from "@fantasy/config";
import { describe, expect, it, vi } from "vitest";

import { buildApp } from "./app.js";
import { AuthService, type AuthRepository } from "./auth.js";
import type { ChangeEventPort } from "./change-event-routes.js";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const EVENT_ID = "50000000-0000-4000-8000-000000000001";
const SESSION_TOKEN = "a".repeat(32);
const COOKIE = `fantasy_session=${SESSION_TOKEN}`;

function authenticatedService(): AuthService {
  const repository: AuthRepository = {
    findUserByEmail: () => Promise.resolve(undefined),
    createSession: () => Promise.resolve(),
    findSession: () =>
      Promise.resolve({
        user: { id: USER_ID, email: "guru@example.com", displayName: "League Guru", role: "admin" },
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
        lastSeenAt: new Date(),
      }),
    touchSession: () => Promise.resolve(),
    deleteSession: () => Promise.resolve(),
    deleteExpiredSessions: () => Promise.resolve(),
  };
  return new AuthService(repository);
}

const emptyFeed = {
  generatedAt: "2026-09-16T12:00:00.000Z",
  unreadCount: 0,
  nextCursor: null,
  events: [],
};

async function appWith(changeEvents: ChangeEventPort) {
  return buildApp({
    environment: loadEnvironment({ NODE_ENV: "test" }),
    logger: false,
    requireAuthentication: true,
    authService: authenticatedService(),
    changeEvents,
  });
}

describe("change event routes", () => {
  it("requires authentication and passes the bounded query to the service", async () => {
    const list = vi.fn(() => Promise.resolve(emptyFeed));
    const app = await appWith({
      list,
      markRead: () => Promise.resolve(undefined),
      dismiss: () => Promise.resolve(undefined),
    });

    const denied = await app.inject({ method: "GET", url: "/v1/change-events" });
    expect(denied.statusCode).toBe(401);
    expect(list).not.toHaveBeenCalled();

    const response = await app.inject({
      method: "GET",
      url: "/v1/change-events?limit=10&cursor=abc",
      headers: { cookie: COOKIE },
    });
    expect(response.statusCode).toBe(200);
    expect(list).toHaveBeenCalledWith(USER_ID, { limit: 10, cursor: "abc", leagueId: null });
    await app.close();
  });

  it("rejects an out-of-range limit and a non-uuid league filter with a 400", async () => {
    const app = await appWith({
      list: () => Promise.resolve(emptyFeed),
      markRead: () => Promise.resolve(undefined),
      dismiss: () => Promise.resolve(undefined),
    });

    for (const query of ["?limit=0", "?limit=500", "?leagueId=nope", "?unknown=1"]) {
      const response = await app.inject({
        method: "GET",
        url: `/v1/change-events${query}`,
        headers: { cookie: COOKIE },
      });
      expect(response.statusCode).toBe(400);
    }
    await app.close();
  });

  it("marks read and dismisses idempotently", async () => {
    const receipt = { eventId: EVENT_ID, state: "read" as const, at: "2026-09-16T12:00:00.000Z" };
    const markRead = vi.fn(() => Promise.resolve(receipt));
    const dismiss = vi.fn(() => Promise.resolve({ ...receipt, state: "dismissed" as const }));
    const app = await appWith({ list: () => Promise.resolve(emptyFeed), markRead, dismiss });

    for (const action of ["read", "dismiss"]) {
      const first = await app.inject({
        method: "POST",
        url: `/v1/change-events/${EVENT_ID}/${action}`,
        headers: { cookie: COOKIE },
      });
      const second = await app.inject({
        method: "POST",
        url: `/v1/change-events/${EVENT_ID}/${action}`,
        headers: { cookie: COOKIE },
      });
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(second.json()).toEqual(first.json());
    }
    await app.close();
  });

  it("requires authentication for both mutations", async () => {
    const markRead = vi.fn(() => Promise.resolve(undefined));
    const dismiss = vi.fn(() => Promise.resolve(undefined));
    const app = await appWith({ list: () => Promise.resolve(emptyFeed), markRead, dismiss });

    for (const action of ["read", "dismiss"]) {
      const response = await app.inject({
        method: "POST",
        url: `/v1/change-events/${EVENT_ID}/${action}`,
      });
      expect(response.statusCode).toBe(401);
    }
    expect(markRead).not.toHaveBeenCalled();
    expect(dismiss).not.toHaveBeenCalled();
    await app.close();
  });

  it("keeps an unknown event and another member's event indistinguishable", async () => {
    const app = await appWith({
      list: () => Promise.resolve(emptyFeed),
      markRead: () => Promise.resolve(undefined),
      dismiss: () => Promise.resolve(undefined),
    });

    for (const action of ["read", "dismiss"]) {
      const response = await app.inject({
        method: "POST",
        url: `/v1/change-events/${EVENT_ID}/${action}`,
        headers: { cookie: COOKIE },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ title: "Change event not found" });
    }
    await app.close();
  });

  it("answers 503 when the service is not configured", async () => {
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authenticatedService(),
    });

    const response = await app.inject({
      method: "GET",
      url: "/v1/change-events",
      headers: { cookie: COOKIE },
    });
    expect(response.statusCode).toBe(503);
    await app.close();
  });
});
