import { loadEnvironment } from "@fantasy/config";
import { describe, expect, it, vi } from "vitest";

import { buildApp } from "./app.js";
import type { AccountDataPort, PortableAccountExport } from "./account-data.js";
import { AuthService, type AuthRepository } from "./auth.js";
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
    readonly accountData?: AccountDataPort;
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
    ...(options.accountData ? { accountData: options.accountData } : {}),
    ...(options.withoutPreferences
      ? {}
      : { preferences: new PreferencesService(preferencesRepository) }),
  });
}

function exportFixture(): PortableAccountExport {
  return {
    schemaVersion: 1,
    exportedAt: "2031-01-02T03:04:05.000Z",
    account: {
      id: USER_ID,
      email: "member@example.com",
      displayName: "Member",
      role: "member",
      createdAt: new Date("2030-01-01T00:00:00.000Z"),
      updatedAt: new Date("2030-01-02T00:00:00.000Z"),
    },
    data: { preferences: { defaultLeagueId: LEAGUE_ID }, sessions: [] },
    omittedSecrets: ["password hashes", "session, browser-handoff, and invitation token hashes"],
  };
}

describe("account portability and deletion", () => {
  it("requires authentication for both account-data actions", async () => {
    const accountData: AccountDataPort = {
      exportData: () => Promise.resolve(exportFixture()),
      deleteAccount: () =>
        Promise.resolve({
          deleted: true,
          transferredLeagueCount: 0,
          deletedSoleMemberLeagueCount: 0,
          preservedSharedProjectionSetCount: 0,
        }),
    };
    const app = await appWith({ accountData });

    expect((await app.inject({ method: "GET", url: "/v1/account/export" })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: "/v1/account",
          payload: { currentPassword: "the original password", confirmation: "DELETE MY ACCOUNT" },
        })
      ).statusCode,
    ).toBe(401);
    await app.close();
  });

  it("downloads a versioned portable JSON export without caching", async () => {
    const exportData = vi.fn(() => Promise.resolve(exportFixture()));
    const app = await appWith({
      accountData: {
        exportData,
        deleteAccount: () => Promise.resolve(undefined),
      },
    });

    const result = await app.inject({
      method: "GET",
      url: "/v1/account/export",
      headers: { cookie: COOKIE },
    });

    expect(result.statusCode).toBe(200);
    expect(result.headers["content-disposition"]).toBe(
      'attachment; filename="laces-out-account-export.json"',
    );
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(result.json()).toMatchObject({
      schemaVersion: 1,
      account: { id: USER_ID, email: "member@example.com" },
    });
    expect(exportData).toHaveBeenCalledWith(USER_ID);
    await app.close();
  });

  it("requires the exact destructive confirmation phrase", async () => {
    const deleteAccount = vi.fn(() => Promise.resolve(undefined));
    const app = await appWith({
      accountData: { exportData: () => Promise.resolve(exportFixture()), deleteAccount },
    });

    const result = await app.inject({
      method: "DELETE",
      url: "/v1/account",
      headers: { cookie: COOKIE },
      payload: { currentPassword: "the original password", confirmation: "delete" },
    });

    expect(result.statusCode).toBe(400);
    expect(deleteAccount).not.toHaveBeenCalled();
    await app.close();
  });

  it("reauthenticates the current password before deleting", async () => {
    const deleteAccount = vi.fn<AccountDataPort["deleteAccount"]>((input) =>
      Promise.resolve(
        input.currentPassword === "the original password"
          ? {
              deleted: true as const,
              transferredLeagueCount: 1,
              deletedSoleMemberLeagueCount: 1,
              preservedSharedProjectionSetCount: 2,
            }
          : { deleted: false as const, reason: "invalid-current-password" as const },
      ),
    );
    const app = await appWith({
      accountData: { exportData: () => Promise.resolve(exportFixture()), deleteAccount },
    });

    const wrong = await app.inject({
      method: "DELETE",
      url: "/v1/account",
      headers: { cookie: COOKIE },
      payload: { currentPassword: "not the password", confirmation: "DELETE MY ACCOUNT" },
    });
    expect(wrong.statusCode).toBe(401);
    expect(deleteAccount).toHaveBeenCalledOnce();

    const deleted = await app.inject({
      method: "DELETE",
      url: "/v1/account",
      headers: { cookie: COOKIE },
      payload: { currentPassword: "the original password", confirmation: "DELETE MY ACCOUNT" },
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({
      deleted: true,
      transferredLeagueCount: 1,
      deletedSoleMemberLeagueCount: 1,
      preservedSharedProjectionSetCount: 2,
    });
    expect(deleted.headers["set-cookie"]).toContain("fantasy_session=;");
    expect(deleteAccount).toHaveBeenCalledTimes(2);
    const deletionInput = deleteAccount.mock.calls[1]?.[0];
    expect(deletionInput?.userId).toBe(USER_ID);
    expect(deletionInput?.currentPassword).toBe("the original password");
    expect(typeof deletionInput?.correlationId).toBe("string");
    await app.close();
  });

  it("reports unavailable when the deployment has no account-data repository", async () => {
    const app = await appWith();
    const exported = await app.inject({
      method: "GET",
      url: "/v1/account/export",
      headers: { cookie: COOKIE },
    });
    const deleted = await app.inject({
      method: "DELETE",
      url: "/v1/account",
      headers: { cookie: COOKIE },
      payload: { currentPassword: "the original password", confirmation: "DELETE MY ACCOUNT" },
    });
    expect(exported.statusCode).toBe(503);
    expect(deleted.statusCode).toBe(503);
    await app.close();
  });
});

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
    const replacePasswordIfCurrent = vi.fn<NonNullable<AuthRepository["replacePasswordIfCurrent"]>>(
      () => Promise.resolve("changed"),
    );
    const app = await appWith({
      auth: authRepository({
        replacePasswordIfCurrent,
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
    expect(replacePasswordIfCurrent).toHaveBeenCalledOnce();
    expect(replacePasswordIfCurrent.mock.calls[0]?.[0]).toMatchObject({
      userId: USER_ID,
      currentPassword: "the original password",
    });
    await app.close();
  });

  it("answers 401 for a wrong current password", async () => {
    const app = await appWith({
      auth: authRepository({
        replacePasswordIfCurrent: () => Promise.resolve("invalid-current-password"),
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
    const replacePasswordIfCurrent = vi.fn<NonNullable<AuthRepository["replacePasswordIfCurrent"]>>(
      () => Promise.resolve("changed"),
    );
    const app = await appWith({
      auth: authRepository({
        replacePasswordIfCurrent,
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

    expect(replacePasswordIfCurrent).not.toHaveBeenCalled();
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
