import { describe, expect, it } from "vitest";

import { loadEnvironment } from "@fantasy/config";

import { buildApp } from "./app.js";
import type { EmailVerificationPort } from "./email-verification-routes.js";

const validToken = "v".repeat(43);
const userId = "00000000-0000-4000-8000-000000000001";

async function appWith(emailVerification?: EmailVerificationPort) {
  return buildApp({
    environment: loadEnvironment({ NODE_ENV: "test" }),
    logger: false,
    ...(emailVerification ? { emailVerification } : {}),
  });
}

describe("/v1/auth/verify-email", () => {
  it("confirms a live token without creating a session", async () => {
    const received: string[] = [];
    const app = await appWith({
      verifyEmail: (token) => {
        received.push(token);
        return Promise.resolve({ userId });
      },
      requestResend: () => Promise.resolve(),
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/verify-email",
      payload: { token: validToken },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(response.json()).toEqual({ verified: true });
    expect(received).toEqual([validToken]);
    await app.close();
  });

  it("answers one generic 400 for unknown, expired, and used tokens", async () => {
    const app = await appWith({
      verifyEmail: () => Promise.resolve(undefined),
      requestResend: () => Promise.resolve(),
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/verify-email",
      payload: { token: validToken },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      type: "https://fantasy.local/problems/invalid-verification-token",
      title: "The confirmation link is invalid or has expired",
    });
    expect(response.headers["set-cookie"]).toBeUndefined();
    await app.close();
  });

  it("answers a non-disclosing 404 when the deployment sends no email", async () => {
    const app = await appWith();
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/verify-email",
      payload: { token: validToken },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ title: "Email confirmation is not available" });
    await app.close();
  });
});

describe("/v1/auth/resend-verification", () => {
  it("answers 202 identically for any address and hands the raw input to the service", async () => {
    const requested: string[] = [];
    const app = await appWith({
      verifyEmail: () => Promise.resolve(undefined),
      requestResend: (email) => {
        requested.push(email);
        return Promise.resolve();
      },
    });

    const pending = await app.inject({
      method: "POST",
      url: "/v1/auth/resend-verification",
      payload: { email: "member@example.com" },
    });
    const unknown = await app.inject({
      method: "POST",
      url: "/v1/auth/resend-verification",
      payload: { email: "stranger@example.com" },
    });

    expect(pending.statusCode).toBe(202);
    expect(unknown.statusCode).toBe(202);
    expect(pending.json()).toEqual(unknown.json());
    expect(requested).toEqual(["member@example.com", "stranger@example.com"]);
    await app.close();
  });

  it("still answers 202 when processing fails after the response", async () => {
    const app = await appWith({
      verifyEmail: () => Promise.resolve(undefined),
      requestResend: () => Promise.reject(new Error("smtp down")),
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/resend-verification",
      payload: { email: "member@example.com" },
    });
    expect(response.statusCode).toBe(202);
    await app.close();
  });
});
