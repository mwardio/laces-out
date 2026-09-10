import { loadEnvironment } from "@laces-out/config";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "./app.js";
import { AuthService, type AuthRepository } from "./auth.js";
import { type PlayerExposurePort } from "./player-exposure-routes.js";

const USER = "10000000-0000-4000-8000-000000000001";
const COOKIE = `fantasy_session=${"e".repeat(32)}`;
const url = "/v1/portfolio/player-exposure";
const exposure = {
  generatedAt: "2026-09-10T12:00:00.000Z",
  season: null,
  leagues: [],
  players: [],
};

const repository: AuthRepository = {
  findUserByEmail: () => Promise.resolve(undefined),
  createSession: () => Promise.resolve(),
  findSession: () =>
    Promise.resolve({
      user: { id: USER, email: "exposure@example.com", displayName: "Manager", role: "member" },
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      lastSeenAt: new Date(),
    }),
  touchSession: () => Promise.resolve(),
  deleteSession: () => Promise.resolve(),
  deleteExpiredSessions: () => Promise.resolve(),
};

const apps: FastifyInstance[] = [];
async function appFor(playerExposure?: PlayerExposurePort) {
  const app = await buildApp({
    environment: loadEnvironment({ NODE_ENV: "test" }),
    logger: false,
    requireAuthentication: true,
    authService: new AuthService(repository),
    ...(playerExposure ? { playerExposure } : {}),
  });
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("Player exposure routes", () => {
  it("requires sign-in, uses only the session account, and disables shared caching", async () => {
    const getExposure = vi.fn(() => Promise.resolve(exposure));
    const app = await appFor({ getExposure });
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
    expect(getExposure).not.toHaveBeenCalled();
    const response = await app.inject({ method: "GET", url, headers: { cookie: COOKIE } });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toContain("no-store");
    expect(response.json()).toEqual(exposure);
    expect(getExposure).toHaveBeenCalledWith(USER);
  });

  it("rejects caller-supplied account and league scopes", async () => {
    const getExposure = vi.fn(() => Promise.resolve(exposure));
    const app = await appFor({ getExposure });
    for (const query of [`userId=${USER}`, `leagueId=${USER}`]) {
      expect(
        (await app.inject({ method: "GET", url: `${url}?${query}`, headers: { cookie: COOKIE } }))
          .statusCode,
      ).toBe(400);
    }
    expect(getExposure).not.toHaveBeenCalled();
  });

  it("reports unavailable configuration and validates the service response", async () => {
    const unavailable = await appFor();
    expect(
      (await unavailable.inject({ method: "GET", url, headers: { cookie: COOKIE } })).statusCode,
    ).toBe(503);
    const invalid = await appFor({
      getExposure: () => Promise.resolve({ ...exposure, players: [{}] }),
    });
    expect(
      (await invalid.inject({ method: "GET", url, headers: { cookie: COOKIE } })).statusCode,
    ).not.toBe(200);
  });
});
