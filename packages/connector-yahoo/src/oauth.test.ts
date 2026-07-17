import { describe, expect, it } from "vitest";

import { createPkceChallenge, createYahooAuthorizationRequest, verifyOAuthState } from "./oauth.js";

describe("Yahoo authorization request", () => {
  it("builds authorization code + S256 PKCE parameters and hashed state", () => {
    let call = 0;
    const request = createYahooAuthorizationRequest({
      clientId: "client-id",
      redirectUri: "https://fantasy.example.test/oauth/yahoo/callback",
      scopes: ["openid", "fspt-r"],
      now: () => new Date("2026-07-16T12:00:00.000Z"),
      randomBytes: (size) => {
        call += 1;
        return Uint8Array.from({ length: size }, (_, index) => (index + call) % 256);
      },
    });
    const url = new URL(request.authorizationUrl);

    expect(url.origin + url.pathname).toBe("https://api.login.yahoo.com/oauth2/request_auth");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe(request.state);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe(createPkceChallenge(request.codeVerifier));
    expect(request.stateHash).not.toBe(request.state);
    expect(request.expiresAt).toBe("2026-07-16T12:10:00.000Z");
  });

  it("verifies state in constant-time-compatible fixed digests and enforces expiry", () => {
    const request = createYahooAuthorizationRequest({
      clientId: "client-id",
      redirectUri: "http://127.0.0.1:3000/oauth/yahoo/callback",
      now: () => new Date("2026-07-16T12:00:00.000Z"),
      randomBytes: (size) => new Uint8Array(size).fill(3),
    });

    expect(
      verifyOAuthState({
        returnedState: request.state,
        expectedStateHash: request.stateHash,
        expiresAt: request.expiresAt,
        now: () => new Date("2026-07-16T12:05:00.000Z"),
      }),
    ).toEqual({ valid: true });
    expect(
      verifyOAuthState({
        returnedState: request.state,
        expectedStateHash: request.stateHash,
        expiresAt: request.expiresAt,
        now: () => new Date("2026-07-16T12:11:00.000Z"),
      }),
    ).toEqual({ valid: false, reason: "expired" });
  });
});
