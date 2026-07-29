import { loadEnvironment } from "@fantasy/config";
import { unresolvedIdentityResponseSchema } from "@fantasy/contracts";
import type { ApplicationRole } from "@fantasy/db";
import { describe, expect, it, vi } from "vitest";

import { buildApp } from "./app.js";
import { AuthService, type AuthRepository } from "./auth.js";
import type { DataQualityPort } from "./data-quality-routes.js";

const SESSION_TOKEN = "s".repeat(32);
const COOKIE = `fantasy_session=${SESSION_TOKEN}`;
const SOURCE_KEY = "nflverse.stats-player-week.2026";

function authenticatedService(role: ApplicationRole): AuthService {
  const repository: AuthRepository = {
    findUserByEmail: () => Promise.resolve(undefined),
    createSession: () => Promise.resolve(),
    findSession: () =>
      Promise.resolve({
        user: {
          id: "10000000-0000-4000-8000-000000000001",
          email: "member@example.com",
          displayName: "Member",
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

const source = {
  key: SOURCE_KEY,
  name: "NFL weekly player stats 2026",
  dataset: "weekly-stats" as const,
  season: 2026,
  admission: "quarantined" as const,
  matchRate: 0.82,
  minimumMatchRate: 0.95,
  thresholdRationale: "GSIS identifiers resolve reliably.",
  meetsThreshold: false,
  rowsRead: 1200,
  rowsRejected: 0,
  rowsUnmatched: 216,
  lastSuccessfulAt: "2026-07-27T06:00:00.000Z",
  checksumSha256: null,
  affectedAnalysis: ["Schedule Edge"],
  reason: "The latest dataset has not cleared admission and identity-quality checks.",
};

const summary = {
  generatedAt: "2026-07-27T12:00:00.000Z",
  algorithmVersion: "data-quality-v1" as const,
  availability: { state: "available" as const, reason: null },
  sources: [source],
  degradedSourceKeys: [SOURCE_KEY],
};

const unresolved = {
  generatedAt: summary.generatedAt,
  algorithmVersion: "data-quality-v1" as const,
  source,
  weeks: { state: "available" as const, reason: null, rows: [] },
  sample: { state: "available" as const, reason: null, rows: [] },
};

function defaultPort() {
  const getSourceQuality = vi.fn(() => Promise.resolve(summary));
  const getUnresolvedIdentities = vi.fn((key: string) =>
    Promise.resolve(key === SOURCE_KEY ? unresolved : undefined),
  );
  const port: DataQualityPort = { getSourceQuality, getUnresolvedIdentities };
  return { port, getSourceQuality, getUnresolvedIdentities };
}

async function appWith(role: ApplicationRole, dataQuality?: DataQualityPort) {
  return buildApp({
    environment: loadEnvironment({ NODE_ENV: "test" }),
    logger: false,
    requireAuthentication: true,
    authService: authenticatedService(role),
    ...(dataQuality ? { dataQuality } : {}),
  });
}

describe("data quality routes", () => {
  it("serves the source summary to any authenticated member", async () => {
    const app = await appWith("member", defaultPort().port);
    const response = await app.inject({
      method: "GET",
      url: "/v1/data-quality/sources",
      headers: { cookie: COOKIE },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      algorithmVersion: "data-quality-v1",
      degradedSourceKeys: [SOURCE_KEY],
    });
    await app.close();
  });

  it("rejects an anonymous summary request", async () => {
    const { port, getSourceQuality } = defaultPort();
    const app = await appWith("member", port);
    const response = await app.inject({ method: "GET", url: "/v1/data-quality/sources" });

    expect(response.statusCode).toBe(401);
    expect(getSourceQuality).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns 503 when the port is not configured", async () => {
    const app = await appWith("admin");
    const response = await app.inject({
      method: "GET",
      url: "/v1/data-quality/sources",
      headers: { cookie: COOKIE },
    });

    expect(response.statusCode).toBe(503);
    await app.close();
  });

  it("refuses the unresolved sample to a non-admin member", async () => {
    const { port, getUnresolvedIdentities } = defaultPort();
    const app = await appWith("member", port);
    const response = await app.inject({
      method: "GET",
      url: `/v1/data-quality/sources/${SOURCE_KEY}/unresolved`,
      headers: { cookie: COOKIE },
    });

    expect(response.statusCode).toBe(403);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(getUnresolvedIdentities).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects an anonymous unresolved request before the admin gate", async () => {
    const app = await appWith("admin", defaultPort().port);
    const response = await app.inject({
      method: "GET",
      url: `/v1/data-quality/sources/${SOURCE_KEY}/unresolved`,
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("serves the unresolved sample to an admin", async () => {
    const app = await appWith("admin", defaultPort().port);
    const response = await app.inject({
      method: "GET",
      url: `/v1/data-quality/sources/${SOURCE_KEY}/unresolved`,
      headers: { cookie: COOKIE },
    });

    expect(response.statusCode).toBe(200);
    expect(unresolvedIdentityResponseSchema.parse(response.json())).toMatchObject({
      source: { key: SOURCE_KEY },
      sample: { rows: [] },
    });
    await app.close();
  });

  it("returns 404 for an unknown source key", async () => {
    const app = await appWith("admin", defaultPort().port);
    const response = await app.inject({
      method: "GET",
      url: "/v1/data-quality/sources/nflverse.injuries.1999/unresolved",
      headers: { cookie: COOKIE },
    });

    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("rejects a source key that violates the data_sources key pattern", async () => {
    const { port, getUnresolvedIdentities } = defaultPort();
    const app = await appWith("admin", port);
    const response = await app.inject({
      method: "GET",
      url: "/v1/data-quality/sources/NOT%20A%20KEY/unresolved",
      headers: { cookie: COOKIE },
    });

    expect(response.statusCode).toBe(400);
    expect(getUnresolvedIdentities).not.toHaveBeenCalled();
    await app.close();
  });
});
