import { describe, expect, it } from "vitest";

import { loadEnvironment } from "@laces-out/config";

import { buildApp } from "./app.js";
import { AuthService, type AuthRepository } from "./auth.js";

const sessionToken = "r".repeat(43);
const payload = {
  inviteCode: "laces-out-friends-2026",
  displayName: "Fantasy Friend",
  email: "friend@example.com",
  password: "a genuinely long password",
};

function authService(): AuthService {
  const repository: AuthRepository = {
    findUserByEmail: () => Promise.resolve(undefined),
    createSession: () => Promise.resolve(),
    findSession: () => Promise.resolve(undefined),
    touchSession: () => Promise.resolve(),
    deleteSession: () => Promise.resolve(),
    deleteExpiredSessions: () => Promise.resolve(),
  };
  return new AuthService(repository);
}

describe("registration routes", () => {
  it("allows public registration and establishes an HTTP-only session", async () => {
    const received: unknown[] = [];
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authService(),
      registration: {
        register: (input) => {
          received.push(input);
          return Promise.resolve({
            status: "active" as const,
            token: sessionToken,
            expiresAt: new Date("2026-08-15T12:00:00.000Z"),
            user: {
              id: "00000000-0000-4000-8000-000000000501",
              email: "friend@example.com",
              displayName: "Fantasy Friend",
              role: "member" as const,
            },
          });
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload,
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers["set-cookie"]).toContain(`fantasy_session=${sessionToken}`);
    expect(response.headers["set-cookie"]).toContain("HttpOnly");
    expect(response.json()).toMatchObject({
      user: { email: "friend@example.com", role: "member" },
    });
    expect(received).toEqual([payload]);
    await app.close();
  });

  it("accepts an account request without an invite code when registration is open", async () => {
    const received: unknown[] = [];
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      registration: {
        register: (input) => {
          received.push(input);
          return Promise.resolve({
            status: "active" as const,
            token: sessionToken,
            expiresAt: new Date("2026-08-15T12:00:00.000Z"),
            user: {
              id: "00000000-0000-4000-8000-000000000501",
              email: "friend@example.com",
              displayName: "Fantasy Friend",
              role: "member" as const,
            },
          });
        },
      },
    });
    const openPayload = {
      displayName: payload.displayName,
      email: payload.email,
      password: payload.password,
    };

    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: openPayload,
    });

    expect(response.statusCode).toBe(201);
    expect(received).toEqual([openPayload]);
    await app.close();
  });

  it("answers a pending registration with the legacy-client-compatible problem and no session", async () => {
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      registration: { register: () => Promise.resolve({ status: "pending" as const }) },
    });

    const response = await app.inject({ method: "POST", url: "/v1/auth/register", payload });

    expect(response.statusCode).toBe(403);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(response.json()).toMatchObject({
      type: "https://fantasy.local/problems/email-verification-required",
      title: "Email confirmation required",
      status: 403,
      code: "email_verification_required",
      detail: "Check your email to confirm your account, then return to the sign-in screen.",
    });
    expect(response.headers["set-cookie"]).toBeUndefined();
    await app.close();
  });

  it("uses one generic rejection for invalid codes and email conflicts", async () => {
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      registration: { register: () => Promise.resolve(undefined) },
    });

    const first = await app.inject({ method: "POST", url: "/v1/auth/register", payload });
    const second = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { ...payload, email: "already-used@example.com" },
    });
    expect(first.statusCode).toBe(400);
    expect(second.statusCode).toBe(400);
    expect(first.json()).toMatchObject({
      type: "https://fantasy.local/problems/registration-rejected",
      title: "Account could not be created",
      detail: "Check the registration details and try again.",
    });
    expect(second.json()).toMatchObject({
      type: "https://fantasy.local/problems/registration-rejected",
      title: "Account could not be created",
      detail: "Check the registration details and try again.",
    });
    await app.close();
  });

  it("returns a non-disclosing unavailable response when the shared code is disabled", async () => {
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ title: "Registration is not available" });
    await app.close();
  });

  it("limits registration attempts to thirty per ten-minute window", async () => {
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      registration: { register: () => Promise.resolve(undefined) },
    });

    for (let attempt = 0; attempt < 30; attempt += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/auth/register",
        payload,
      });
      expect(response.statusCode).toBe(400);
    }
    const limited = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload,
    });
    expect(limited.statusCode).toBe(429);
    await app.close();
  });
});
