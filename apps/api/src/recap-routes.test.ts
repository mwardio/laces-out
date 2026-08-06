import { loadEnvironment } from "@laces-out/config";
import { describe, expect, it, vi } from "vitest";

import { buildApp } from "./app.js";
import { AuthService, type AuthRepository } from "./auth.js";
import type { RecapRoutePort } from "./recap-routes.js";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const LEAGUE_ID = "20000000-0000-4000-8000-000000000001";
const TEAM_ID = "40000000-0000-4000-8000-000000000001";
const SESSION_TOKEN = "f".repeat(32);
const COOKIE = `fantasy_session=${SESSION_TOKEN}`;

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

const ENVELOPE = {
  leagueId: LEAGUE_ID,
  week: 5,
  configuredSpiceLevel: "scorched",
  generation: { state: "available" },
  recap: {
    week: 5,
    body: "The recap",
    provider: "gemini",
    model: "gemini-3.6-flash",
    spiceLevel: "medium",
    generatedByDisplayName: "League Guru",
    generatedAt: "2026-10-07T16:20:00.000Z",
  },
} as const;

function port(overrides: Partial<RecapRoutePort> = {}): RecapRoutePort {
  return {
    getRecap: () => Promise.resolve(ENVELOPE),
    generate: () => Promise.resolve({ state: "generated", response: ENVELOPE }),
    listPersonaCards: () =>
      Promise.resolve({ state: "listed", list: { leagueId: LEAGUE_ID, cards: [] } }),
    savePersonaCard: () =>
      Promise.resolve({
        state: "saved",
        card: {
          teamId: TEAM_ID,
          teamName: "Budget Ballers",
          body: "Fears kickers.",
          updatedAt: "2026-10-01T12:00:00.000Z",
          updatedByDisplayName: "League Guru",
        },
      }),
    deletePersonaCard: () => Promise.resolve({ state: "deleted" }),
    saveSettings: () =>
      Promise.resolve({ state: "saved", settings: { leagueId: LEAGUE_ID, spiceLevel: "mild" } }),
    ...overrides,
  };
}

async function recapApp(recaps: RecapRoutePort) {
  return buildApp({
    environment: loadEnvironment({ NODE_ENV: "test" }),
    logger: false,
    requireAuthentication: true,
    authService: authenticatedService(),
    recaps,
  });
}

describe("recap routes", () => {
  it("requires authentication and scopes reads to the current user", async () => {
    const getRecap = vi.fn(() => Promise.resolve(ENVELOPE));
    const app = await recapApp(port({ getRecap }));

    const denied = await app.inject({
      method: "GET",
      url: `/v1/leagues/${LEAGUE_ID}/recap?week=5`,
    });
    expect(denied.statusCode).toBe(401);
    expect(getRecap).not.toHaveBeenCalled();

    const response = await app.inject({
      method: "GET",
      url: `/v1/leagues/${LEAGUE_ID}/recap?week=5`,
      headers: { cookie: COOKIE },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      week: 5,
      configuredSpiceLevel: "scorched",
      recap: { spiceLevel: "medium" },
    });
    expect(getRecap).toHaveBeenCalledWith(USER_ID, LEAGUE_ID, 5);
    await app.close();
  });

  it("does not reveal whether an inaccessible league exists", async () => {
    const app = await recapApp(port({ getRecap: () => Promise.resolve(undefined) }));

    const response = await app.inject({
      method: "GET",
      url: `/v1/leagues/${LEAGUE_ID}/recap?week=5`,
      headers: { cookie: COOKIE },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ title: "League not found" });
    await app.close();
  });

  it("rejects a missing or out-of-range week", async () => {
    const getRecap = vi.fn(() => Promise.resolve(ENVELOPE));
    const app = await recapApp(port({ getRecap }));

    for (const query of ["", "?week=0", "?week=31", "?week=later"]) {
      const response = await app.inject({
        method: "GET",
        url: `/v1/leagues/${LEAGUE_ID}/recap${query}`,
        headers: { cookie: COOKIE },
      });
      expect(response.statusCode).toBe(400);
    }
    expect(getRecap).not.toHaveBeenCalled();
    await app.close();
  });

  it("carries generation availability through the read envelope", async () => {
    const app = await recapApp(
      port({
        getRecap: () =>
          Promise.resolve({
            ...ENVELOPE,
            generation: { state: "cooldown", retryAfterSeconds: 30 },
          }),
      }),
    );

    const response = await app.inject({
      method: "GET",
      url: `/v1/leagues/${LEAGUE_ID}/recap?week=5`,
      headers: { cookie: COOKIE },
    });

    expect(response.json()).toMatchObject({
      generation: { state: "cooldown", retryAfterSeconds: 30 },
    });
    await app.close();
  });

  it("generates on POST and forwards the requested week and provider", async () => {
    const generate = vi.fn(() =>
      Promise.resolve({ state: "generated" as const, response: { ...ENVELOPE, week: 4 } }),
    );
    const app = await recapApp(port({ generate }));

    const ok = await app.inject({
      method: "POST",
      url: `/v1/leagues/${LEAGUE_ID}/recap`,
      headers: { cookie: COOKIE },
      payload: { week: 4, provider: "openai", expectedSpiceLevel: "mild" },
    });

    expect(ok.statusCode).toBe(200);
    expect(generate).toHaveBeenCalledWith(USER_ID, LEAGUE_ID, {
      week: 4,
      provider: "openai",
      expectedSpiceLevel: "mild",
    });
    expect(ok.json()).toMatchObject({ week: 4, recap: { spiceLevel: "medium" } });
    await app.close();
  });

  it("omits an unspecified provider rather than inventing one", async () => {
    const generate = vi.fn(() =>
      Promise.resolve({ state: "generated" as const, response: ENVELOPE }),
    );
    const app = await recapApp(port({ generate }));

    await app.inject({
      method: "POST",
      url: `/v1/leagues/${LEAGUE_ID}/recap`,
      headers: { cookie: COOKIE },
      payload: { week: 5 },
    });

    expect(generate).toHaveBeenCalledWith(USER_ID, LEAGUE_ID, { week: 5 });
    await app.close();
  });

  it("maps every generation refusal to a stable problem", async () => {
    const forbidden = await recapApp(
      port({ generate: () => Promise.resolve({ state: "forbidden" }) }),
    );
    const denied = await forbidden.inject({
      method: "POST",
      url: `/v1/leagues/${LEAGUE_ID}/recap`,
      headers: { cookie: COOKIE },
      payload: { week: 5 },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: "RECAP_FORBIDDEN" });
    await forbidden.close();

    const stale = await recapApp(
      port({
        generate: () =>
          Promise.resolve({
            state: "unavailable",
            message: "Only week 5 can be recapped right now.",
          }),
      }),
    );
    const conflict = await stale.inject({
      method: "POST",
      url: `/v1/leagues/${LEAGUE_ID}/recap`,
      headers: { cookie: COOKIE },
      payload: { week: 4 },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({
      code: "RECAP_WEEK_UNAVAILABLE",
      detail: "Only week 5 can be recapped right now.",
    });
    await stale.close();

    const changedConfiguration = await recapApp(
      port({ generate: () => Promise.resolve({ state: "configuration-changed" }) }),
    );
    const changed = await changedConfiguration.inject({
      method: "POST",
      url: `/v1/leagues/${LEAGUE_ID}/recap`,
      headers: { cookie: COOKIE },
      payload: { week: 5, provider: "gemini", expectedSpiceLevel: "mild" },
    });
    expect(changed.statusCode).toBe(409);
    expect(changed.json()).toMatchObject({ code: "RECAP_CONFIGURATION_CHANGED" });
    await changedConfiguration.close();

    const unconfigured = await recapApp(
      port({ generate: () => Promise.resolve({ state: "unconfigured" }) }),
    );
    const missing = await unconfigured.inject({
      method: "POST",
      url: `/v1/leagues/${LEAGUE_ID}/recap`,
      headers: { cookie: COOKIE },
      payload: { week: 5 },
    });
    expect(missing.statusCode).toBe(503);
    await unconfigured.close();

    const unknownLeague = await recapApp(port({ generate: () => Promise.resolve(undefined) }));
    const hidden = await unknownLeague.inject({
      method: "POST",
      url: `/v1/leagues/${LEAGUE_ID}/recap`,
      headers: { cookie: COOKIE },
      payload: { week: 5 },
    });
    expect(hidden.statusCode).toBe(404);
    await unknownLeague.close();
  });

  it("reports an in-flight generation and a cooldown with Retry-After", async () => {
    const inProgress = await recapApp(
      port({
        generate: () => Promise.resolve({ state: "in-progress", retryAfterSeconds: 20 }),
      }),
    );
    const busy = await inProgress.inject({
      method: "POST",
      url: `/v1/leagues/${LEAGUE_ID}/recap`,
      headers: { cookie: COOKIE },
      payload: { week: 5 },
    });
    expect(busy.statusCode).toBe(409);
    expect(busy.headers["retry-after"]).toBe("20");
    expect(busy.json()).toMatchObject({
      code: "RECAP_GENERATION_IN_PROGRESS",
      retryAfterSeconds: 20,
    });
    await inProgress.close();

    const cooling = await recapApp(
      port({ generate: () => Promise.resolve({ state: "cooldown", retryAfterSeconds: 45 }) }),
    );
    const waiting = await cooling.inject({
      method: "POST",
      url: `/v1/leagues/${LEAGUE_ID}/recap`,
      headers: { cookie: COOKIE },
      payload: { week: 5 },
    });
    expect(waiting.statusCode).toBe(429);
    expect(waiting.headers["retry-after"]).toBe("45");
    expect(waiting.json()).toMatchObject({ code: "RECAP_COOLDOWN", retryAfterSeconds: 45 });
    await cooling.close();
  });

  it("rejects an invalid generate payload before reaching the service", async () => {
    const generate = vi.fn(() =>
      Promise.resolve({ state: "generated" as const, response: ENVELOPE }),
    );
    const app = await recapApp(port({ generate }));

    for (const payload of [
      { week: 0 },
      { week: 5, provider: "nope" },
      { week: 5, expectedSpiceLevel: "mild" },
      { week: 5, provider: "gemini", expectedSpiceLevel: "nuclear" },
      { week: 5, extra: true },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: `/v1/leagues/${LEAGUE_ID}/recap`,
        headers: { cookie: COOKIE },
        payload,
      });
      expect(response.statusCode).toBe(400);
    }
    expect(generate).not.toHaveBeenCalled();
    await app.close();
  });

  it("lists League Intel for an authorized league owner or commissioner", async () => {
    const listPersonaCards = vi.fn(() =>
      Promise.resolve({
        state: "listed" as const,
        list: {
          leagueId: LEAGUE_ID,
          cards: [
            {
              teamId: TEAM_ID,
              teamName: "Budget Ballers",
              body: "Fears kickers.",
              updatedAt: "2026-10-01T12:00:00.000Z",
              updatedByDisplayName: "League Guru",
            },
          ],
        },
      }),
    );
    const app = await recapApp(port({ listPersonaCards }));

    const response = await app.inject({
      method: "GET",
      url: `/v1/leagues/${LEAGUE_ID}/persona-cards`,
      headers: { cookie: COOKIE },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      cards: [{ teamId: TEAM_ID, updatedByDisplayName: "League Guru" }],
    });
    expect(listPersonaCards).toHaveBeenCalledWith(USER_ID, LEAGUE_ID);
    await app.close();
  });

  it("refuses League Intel reads from regular league members", async () => {
    const app = await recapApp(
      port({ listPersonaCards: () => Promise.resolve({ state: "forbidden" }) }),
    );

    const response = await app.inject({
      method: "GET",
      url: `/v1/leagues/${LEAGUE_ID}/persona-cards`,
      headers: { cookie: COOKIE },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "RECAP_FORBIDDEN" });
    await app.close();
  });

  it("saves persona cards and maps forbidden and unknown-team", async () => {
    const savePersonaCard = vi.fn(() =>
      Promise.resolve({
        state: "saved" as const,
        card: {
          teamId: TEAM_ID,
          teamName: "Budget Ballers",
          body: "Fears kickers.",
          updatedAt: "2026-10-01T12:00:00.000Z",
          updatedByDisplayName: "League Guru",
        },
      }),
    );
    const app = await recapApp(port({ savePersonaCard }));
    const saved = await app.inject({
      method: "PUT",
      url: `/v1/leagues/${LEAGUE_ID}/persona-cards/${TEAM_ID}`,
      headers: { cookie: COOKIE },
      payload: { body: "  Fears kickers.  " },
    });
    expect(saved.statusCode).toBe(200);
    // The contract trims before the service sees it.
    expect(savePersonaCard).toHaveBeenCalledWith(USER_ID, LEAGUE_ID, TEAM_ID, "Fears kickers.");
    await app.close();

    const forbidden = await recapApp(
      port({ savePersonaCard: () => Promise.resolve({ state: "forbidden" }) }),
    );
    const denied = await forbidden.inject({
      method: "PUT",
      url: `/v1/leagues/${LEAGUE_ID}/persona-cards/${TEAM_ID}`,
      headers: { cookie: COOKIE },
      payload: { body: "Nope." },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: "RECAP_FORBIDDEN" });
    await forbidden.close();

    const unknown = await recapApp(
      port({ savePersonaCard: () => Promise.resolve({ state: "unknown-team" }) }),
    );
    const missing = await unknown.inject({
      method: "PUT",
      url: `/v1/leagues/${LEAGUE_ID}/persona-cards/${TEAM_ID}`,
      headers: { cookie: COOKIE },
      payload: { body: "Who dis." },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ title: "Team not found" });
    await unknown.close();
  });

  it("rejects an empty or oversized card body before reaching the service", async () => {
    const savePersonaCard = vi.fn(() =>
      Promise.resolve({
        state: "saved" as const,
        card: {
          teamId: TEAM_ID,
          teamName: "Budget Ballers",
          body: "Fears kickers.",
          updatedAt: "2026-10-01T12:00:00.000Z",
          updatedByDisplayName: "League Guru",
        },
      }),
    );
    const app = await recapApp(port({ savePersonaCard }));

    for (const payload of [{ body: "   " }, { body: "x".repeat(501) }, {}]) {
      const response = await app.inject({
        method: "PUT",
        url: `/v1/leagues/${LEAGUE_ID}/persona-cards/${TEAM_ID}`,
        headers: { cookie: COOKIE },
        payload,
      });
      expect(response.statusCode).toBe(400);
    }
    expect(savePersonaCard).not.toHaveBeenCalled();
    await app.close();
  });

  it("clears League Intel and maps its refusals", async () => {
    const deletePersonaCard = vi.fn(() => Promise.resolve({ state: "deleted" as const }));
    const app = await recapApp(port({ deletePersonaCard }));
    const cleared = await app.inject({
      method: "DELETE",
      url: `/v1/leagues/${LEAGUE_ID}/persona-cards/${TEAM_ID}`,
      headers: { cookie: COOKIE },
    });
    expect(cleared.statusCode).toBe(204);
    expect(deletePersonaCard).toHaveBeenCalledWith(USER_ID, LEAGUE_ID, TEAM_ID);
    await app.close();

    const forbidden = await recapApp(
      port({ deletePersonaCard: () => Promise.resolve({ state: "forbidden" }) }),
    );
    const denied = await forbidden.inject({
      method: "DELETE",
      url: `/v1/leagues/${LEAGUE_ID}/persona-cards/${TEAM_ID}`,
      headers: { cookie: COOKIE },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: "RECAP_FORBIDDEN" });
    await forbidden.close();

    const unknown = await recapApp(
      port({ deletePersonaCard: () => Promise.resolve({ state: "unknown-team" }) }),
    );
    const missing = await unknown.inject({
      method: "DELETE",
      url: `/v1/leagues/${LEAGUE_ID}/persona-cards/${TEAM_ID}`,
      headers: { cookie: COOKIE },
    });
    expect(missing.statusCode).toBe(404);
    await unknown.close();

    const hiddenLeague = await recapApp(
      port({ deletePersonaCard: () => Promise.resolve(undefined) }),
    );
    const hidden = await hiddenLeague.inject({
      method: "DELETE",
      url: `/v1/leagues/${LEAGUE_ID}/persona-cards/${TEAM_ID}`,
      headers: { cookie: COOKIE },
    });
    expect(hidden.statusCode).toBe(404);
    await hiddenLeague.close();
  });

  it("saves the spice level for commissioners only", async () => {
    const saveSettings = vi.fn(() =>
      Promise.resolve({
        state: "saved" as const,
        settings: { leagueId: LEAGUE_ID, spiceLevel: "scorched" as const },
      }),
    );
    const app = await recapApp(port({ saveSettings }));
    const saved = await app.inject({
      method: "PUT",
      url: `/v1/leagues/${LEAGUE_ID}/recap-settings`,
      headers: { cookie: COOKIE },
      payload: { spiceLevel: "scorched" },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({ leagueId: LEAGUE_ID, spiceLevel: "scorched" });
    expect(saveSettings).toHaveBeenCalledWith(USER_ID, LEAGUE_ID, "scorched");
    await app.close();

    const forbidden = await recapApp(
      port({ saveSettings: () => Promise.resolve({ state: "forbidden" }) }),
    );
    const denied = await forbidden.inject({
      method: "PUT",
      url: `/v1/leagues/${LEAGUE_ID}/recap-settings`,
      headers: { cookie: COOKIE },
      payload: { spiceLevel: "scorched" },
    });
    expect(denied.statusCode).toBe(403);
    await forbidden.close();
  });

  it("rejects an unknown spice level before reaching the service", async () => {
    const saveSettings = vi.fn(() =>
      Promise.resolve({
        state: "saved" as const,
        settings: { leagueId: LEAGUE_ID, spiceLevel: "mild" as const },
      }),
    );
    const app = await recapApp(port({ saveSettings }));

    const response = await app.inject({
      method: "PUT",
      url: `/v1/leagues/${LEAGUE_ID}/recap-settings`,
      headers: { cookie: COOKIE },
      payload: { spiceLevel: "nuclear" },
    });

    expect(response.statusCode).toBe(400);
    expect(saveSettings).not.toHaveBeenCalled();
    await app.close();
  });

  it("answers 503 when the recap service is not configured", async () => {
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authenticatedService(),
    });

    const response = await app.inject({
      method: "GET",
      url: `/v1/leagues/${LEAGUE_ID}/recap?week=5`,
      headers: { cookie: COOKIE },
    });

    expect(response.statusCode).toBe(503);
    await app.close();
  });
});
