import { describe, expect, it, vi } from "vitest";

import { YahooTokenClient } from "./token-client.js";

describe("YahooTokenClient", () => {
  it("exchanges a code through Yahoo's confidential-client flow", async () => {
    let requestedInput: string | URL | undefined;
    let requestedInit: RequestInit | undefined;
    const fetchMock = vi.fn((input: string | URL, init?: RequestInit): Promise<Response> => {
      requestedInput = input;
      requestedInit = init;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: "access-token-value",
            refresh_token: "refresh-token-value",
            token_type: "bearer",
            expires_in: 3600,
            xoauth_yahoo_guid: "fake-guid",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    });
    const client = new YahooTokenClient({
      clientId: "client-id",
      clientSecret: "client-secret",
      redirectUri: "https://fantasy.example.test/callback",
      fetch: fetchMock,
      now: () => new Date("2026-07-16T12:00:00.000Z"),
    });

    const result = await client.exchangeAuthorizationCode({
      code: "authorization-code",
    });

    expect(result.credentialVersion).toBe(1);
    expect(result.tokenSet.expiresAt).toBe("2026-07-16T13:00:00.000Z");
    expect(String(requestedInput)).toBe("https://api.login.yahoo.com/oauth2/get_token");
    expect(requestedInit?.body).not.toContain("code_verifier=");
    expect(requestedInit?.body).toContain("grant_type=authorization_code");
    const headers = new Headers(requestedInit?.headers);
    expect(headers.get("Authorization")).toMatch(/^Basic /u);
    expect(headers.get("Content-Type")).toBe("application/x-www-form-urlencoded");
  });

  it("returns a credential-version CAS contract for refresh-token rotation", async () => {
    const fetchMock = (): Promise<Response> =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: "new-access-token",
            refresh_token: "rotated-refresh-token",
            token_type: "bearer",
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      );
    const client = new YahooTokenClient({
      clientId: "client-id",
      clientSecret: "client-secret",
      redirectUri: "https://fantasy.example.test/callback",
      fetch: fetchMock,
    });

    const result = await client.refresh({
      refreshToken: "old-refresh-token",
      expectedCredentialVersion: 8,
    });
    expect(result.tokenSet.refreshToken).toBe("rotated-refresh-token");
    expect(result.atomicRotation).toEqual({
      expectedCredentialVersion: 8,
      nextCredentialVersion: 9,
      refreshTokenRotated: true,
    });
  });

  it("resolves the Fantasy user GUID when Yahoo omits its deprecated token field", async () => {
    const fetchMock = vi
      .fn<(input: string | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "access-token-value",
            refresh_token: "refresh-token-value",
            token_type: "bearer",
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          '<?xml version="1.0"?><fantasy_content><users><user><guid>stable-yahoo-guid</guid></user></users></fantasy_content>',
          { status: 200, headers: { "content-type": "application/xml" } },
        ),
      );
    const client = new YahooTokenClient({
      clientId: "client-id",
      clientSecret: "client-secret",
      redirectUri: "https://fantasy.example.test/callback",
      fetch: fetchMock,
    });

    const result = await client.exchangeAuthorizationCode({ code: "authorization-code" });

    expect(result.tokenSet.yahooGuid).toBe("stable-yahoo-guid");
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      "https://fantasysports.yahooapis.com/fantasy/v2/users;use_login=1",
    );
    const headers = new Headers(fetchMock.mock.calls[1]?.[1]?.headers);
    expect(headers.get("Authorization")).toBe("Bearer access-token-value");
  });
});
