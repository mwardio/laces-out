import { loadEnvironment } from "@fantasy/config";
import { describe, expect, it, vi } from "vitest";

import { buildApp } from "./app.js";
import { AuthService, hashOwnerPassword, type AuthRepository } from "./auth.js";
import { PreferencesService, type PreferencesRepository } from "./preferences.js";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const LEAGUE_ID = "20000000-0000-4000-8000-000000000001";
const OTHER_LEAGUE_ID = "20000000-0000-4000-8000-00000000000f";
const SESSION_TOKEN = "s".repeat(32);
const COOKIE = `fantasy_session=${SESSION_TOKEN}`;

function authRepository(overrides: Partial<AuthRepository> = {}): AuthRepository {
  return {
    findUserByEmail: () => Promise.resolve(undefined),
    createSession: () => Promise.resolve(),
    findSession: () =>
      Promise.resolve({
        user: {
          id: USER_ID,
          email: "member@example.com",
          displayName: "Member",
          role: "member",
        },
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
        lastSeenAt: new Date(),
      }),
    touchSession: () => Promise.resolve(),
    deleteSession: () => Promise.resolve(),
    deleteExpiredSessions: () => Promise.resolve(),
    ...overrides,
  };
}

async function appWith(
  options: {
    readonly auth?: AuthRepository;
    readonly preferences?: PreferencesRepository;
    readonly withoutPreferences?: boolean;
  } = {},
) {
  const preferencesRepository: PreferencesRepository = options.preferences ?? {
    find: () => Promise.resolve({ defaultLeagueId: null }),
    upsert: () => Promise.resolve(),
    isLeagueMember: (_userId, leagueId) => Promise.resolve(leagueId === LEAGUE_ID),
  };
  return buildApp({
    environment: loadEnvironment({ NODE_ENV: "test" }),
    logger: false,
    requireAuthentication: true,
    authService: new AuthService(options.auth ?? authRepository()),
    ...(options.withoutPreferences
      ? {}
      : { preferences: new PreferencesService(preferencesRepository) }),
  });
}

describe("POST /v1/auth/password", () => {
  it("requires authentication", async () => {
    const app = await appWith();
    const result = await app.inject({
      method: "POST",
      url: "/v1/auth/password",
      payload: { currentPassword: "the original password", newPassword: "a brand new password" },
    });

    expect(result.statusCode).toBe(401);
    await app.close();
  });

  it("changes the password and reports the other sessions as revoked", async () => {
    const updatePassword = vi.fn(() => Promise.resolve());
    const deleteOtherSessions = vi.fn(() => Promise.resolve());
    const app = await appWith({
      auth: authRepository({
        findUserById: async () => ({
          id: USER_ID,
          email: "member@example.com",
          displayName: "Member",
          passwordHash: await hashOwnerPassword("the original password"),
          role: "member",
        }),
        updatePassword,
        deleteOtherSessions,
      }),
    });

    const result = await app.inject({
      method: "POST",
      url: "/v1/auth/password",
      headers: { cookie: COOKIE },
      payload: { currentPassword: "the original password", newPassword: "a brand new password" },
    });

    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({ changed: true, otherSessionsRevoked: true });
    expect(updatePassword).toHaveBeenCalledOnce();
    expect(deleteOtherSessions).toHaveBeenCalledOnce();
    await app.close();
  });

  it("answers 401 for a wrong current password", async () => {
    const app = await appWith({
      auth: authRepository({
        findUserById: async () => ({
          id: USER_ID,
          email: "member@example.com",
          displayName: "Member",
          passwordHash: await hashOwnerPassword("the original password"),
          role: "member",
        }),
        updatePassword: () => Promise.resolve(),
        deleteOtherSessions: () => Promise.resolve(),
      }),
    });

    const result = await app.inject({
      method: "POST",
      url: "/v1/auth/password",
      headers: { cookie: COOKIE },
      payload: { currentPassword: "wrong", newPassword: "a brand new password" },
    });

    expect(result.statusCode).toBe(401);
    await app.close();
  });

  it("rejects a short password and a reused password before hashing", async () => {
    const updatePassword = vi.fn(() => Promise.resolve());
    const app = await appWith({
      auth: authRepository({
        findUserById: async () => ({
          id: USER_ID,
          email: "member@example.com",
          displayName: "Member",
          passwordHash: await hashOwnerPassword("the original password"),
          role: "member",
        }),
        updatePassword,
        deleteOtherSessions: () => Promise.resolve(),
      }),
    });

    const short = await app.inject({
      method: "POST",
      url: "/v1/auth/password",
      headers: { cookie: COOKIE },
      payload: { currentPassword: "the original password", newPassword: "too short" },
    });
    expect(short.statusCode).toBe(400);

    const reused = await app.inject({
      method: "POST",
      url: "/v1/auth/password",
      headers: { cookie: COOKIE },
      payload: {
        currentPassword: "the original password",
        newPassword: "the original password",
      },
    });
    expect(reused.statusCode).toBe(400);

    expect(updatePassword).not.toHaveBeenCalled();
    await app.close();
  });

  it("answers 503 when the repository cannot change passwords", async () => {
    const app = await appWith();

    const result = await app.inject({
      method: "POST",
      url: "/v1/auth/password",
      headers: { cookie: COOKIE },
      payload: { currentPassword: "the original password", newPassword: "a brand new password" },
    });

    expect(result.statusCode).toBe(503);
    await app.close();
  });
});

describe("/v1/preferences", () => {
  it("requires authentication", async () => {
    const app = await appWith();
    expect((await app.inject({ method: "GET", url: "/v1/preferences" })).statusCode).toBe(401);
    await app.close();
  });

  it("serves the stored default league", async () => {
    const app = await appWith({
      preferences: {
        find: () => Promise.resolve({ defaultLeagueId: LEAGUE_ID }),
        upsert: () => Promise.resolve(),
        isLeagueMember: () => Promise.resolve(true),
      },
    });

    const result = await app.inject({
      method: "GET",
      url: "/v1/preferences",
      headers: { cookie: COOKIE },
    });

    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({ defaultLeagueId: LEAGUE_ID });
    await app.close();
  });

  it("saves a league the member belongs to and clears it with null", async () => {
    const upsert = vi.fn(() => Promise.resolve());
    const app = await appWith({
      preferences: {
        find: () => Promise.resolve({ defaultLeagueId: null }),
        upsert,
        isLeagueMember: (_userId, leagueId) => Promise.resolve(leagueId === LEAGUE_ID),
      },
    });

    const saved = await app.inject({
      method: "PATCH",
      url: "/v1/preferences",
      headers: { cookie: COOKIE },
      payload: { defaultLeagueId: LEAGUE_ID },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({ defaultLeagueId: LEAGUE_ID });

    const cleared = await app.inject({
      method: "PATCH",
      url: "/v1/preferences",
      headers: { cookie: COOKIE },
      payload: { defaultLeagueId: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(upsert).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it("refuses a default league the member does not belong to", async () => {
    const upsert = vi.fn(() => Promise.resolve());
    const app = await appWith({
      preferences: {
        find: () => Promise.resolve({ defaultLeagueId: null }),
        upsert,
        isLeagueMember: (_userId, leagueId) => Promise.resolve(leagueId === LEAGUE_ID),
      },
    });

    const result = await app.inject({
      method: "PATCH",
      url: "/v1/preferences",
      headers: { cookie: COOKIE },
      payload: { defaultLeagueId: OTHER_LEAGUE_ID },
    });

    expect(result.statusCode).toBe(403);
    expect(upsert).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects a non-uuid league before reaching the service", async () => {
    const app = await appWith();

    const result = await app.inject({
      method: "PATCH",
      url: "/v1/preferences",
      headers: { cookie: COOKIE },
      payload: { defaultLeagueId: "not-a-uuid" },
    });

    expect(result.statusCode).toBe(400);
    await app.close();
  });

  it("answers 503 when preferences are not configured", async () => {
    const app = await appWith({ withoutPreferences: true });

    const result = await app.inject({
      method: "GET",
      url: "/v1/preferences",
      headers: { cookie: COOKIE },
    });

    expect(result.statusCode).toBe(503);
    await app.close();
  });
});
