import { describe, expect, it } from "vitest";

import { loadEnvironment } from "@laces-out/config";

import { buildApp } from "./app.js";
import type { PasswordResetPort } from "./password-reset-routes.js";

const validToken = "t".repeat(43);

async function appWith(passwordReset?: PasswordResetPort) {
  return buildApp({
    environment: loadEnvironment({ NODE_ENV: "test" }),
    logger: false,
    ...(passwordReset ? { passwordReset } : {}),
  });
}

describe("/v1/auth/forgot-password", () => {
  it("answers 202 identically for any address and hands the raw input to the service", async () => {
    const requested: string[] = [];
    const app = await appWith({
      requestReset: (email) => {
        requested.push(email);
        return Promise.resolve();
      },
      resetPassword: () => Promise.resolve("invalid"),
    });

    const known = await app.inject({
      method: "POST",
      url: "/v1/auth/forgot-password",
      payload: { email: "member@example.com" },
    });
    const unknown = await app.inject({
      method: "POST",
      url: "/v1/auth/forgot-password",
      payload: { email: "stranger@example.com" },
    });

    expect(known.statusCode).toBe(202);
    expect(unknown.statusCode).toBe(202);
    expect(known.json()).toEqual({ requested: true });
    expect(unknown.json()).toEqual(known.json());
    expect(requested).toEqual(["member@example.com", "stranger@example.com"]);
    await app.close();
  });

  it("still answers 202 when processing fails after the response", async () => {
    const app = await appWith({
      requestReset: () => Promise.reject(new Error("smtp down")),
      resetPassword: () => Promise.resolve("invalid"),
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/forgot-password",
      payload: { email: "member@example.com" },
    });
    expect(response.statusCode).toBe(202);
    await app.close();
  });

  it("answers a non-disclosing 404 when the deployment sends no email", async () => {
    const app = await appWith();
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/forgot-password",
      payload: { email: "member@example.com" },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      title: "Self-service password reset is not available",
    });
    await app.close();
  });
});

describe("/v1/auth/reset-password", () => {
  it("completes a reset with a valid token", async () => {
    const received: { token: string; password: string }[] = [];
    const app = await appWith({
      requestReset: () => Promise.resolve(),
      resetPassword: (token, password) => {
        received.push({ token, password });
        return Promise.resolve("reset");
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/reset-password",
      payload: { token: validToken, password: "a brand new password" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ reset: true });
    expect(received).toEqual([{ token: validToken, password: "a brand new password" }]);
    await app.close();
  });

  it("answers one generic 400 for unknown, expired, and used tokens", async () => {
    const app = await appWith({
      requestReset: () => Promise.resolve(),
      resetPassword: () => Promise.resolve("invalid"),
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/reset-password",
      payload: { token: validToken, password: "a brand new password" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      type: "https://fantasy.local/problems/invalid-reset-token",
      title: "The reset link is invalid or has expired",
    });
    await app.close();
  });

  it("rejects a too-short password before reaching the service", async () => {
    const app = await appWith({
      requestReset: () => Promise.resolve(),
      resetPassword: () => Promise.resolve("reset"),
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/reset-password",
      payload: { token: validToken, password: "short" },
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });
});
