import { describe, expect, it, vi } from "vitest";

import { requestYahooNativeAuthorization } from "./yahoo-native-connect.js";

describe("Yahoo native connect landing", () => {
  it("automatically requests only the closed iOS mode and continues to Yahoo", async () => {
    const fetcher = vi
      .fn<(input: string | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            authorizationUrl: "https://api.login.yahoo.com/oauth2/request_auth?state=opaque",
            expiresAt: "2031-08-04T12:10:00.000Z",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );

    await expect(
      requestYahooNativeAuthorization("https://self-host.example", fetcher),
    ).resolves.toEqual({
      kind: "authorization",
      url: "https://api.login.yahoo.com/oauth2/request_auth?state=opaque",
    });
    expect(fetcher).toHaveBeenCalledWith(
      "https://self-host.example/v1/connections/yahoo/authorize",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        cache: "no-store",
        body: '{"returnMode":"ios-app"}',
      }),
    );
    const requestBody = fetcher.mock.calls[0]?.[1]?.body;
    if (typeof requestBody !== "string") throw new Error("Expected a serialized request body");
    expect(requestBody).not.toContain("callback");
    expect(requestBody).not.toContain("returnTo");
  });

  it("returns only fixed credential-free callbacks for unavailable and invalid starts", async () => {
    await expect(
      requestYahooNativeAuthorization("", () =>
        Promise.resolve(new Response(null, { status: 503 })),
      ),
    ).resolves.toEqual({
      kind: "completion",
      url: "lacesout://connections/yahoo?status=unavailable",
    });
    await expect(
      requestYahooNativeAuthorization("", () =>
        Promise.resolve(new Response('{"authorizationUrl":"not a url"}', { status: 200 })),
      ),
    ).resolves.toEqual({
      kind: "completion",
      url: "lacesout://connections/yahoo?status=failed",
    });
    await expect(
      requestYahooNativeAuthorization("", () => Promise.reject(new Error("offline"))),
    ).resolves.toEqual({
      kind: "completion",
      url: "lacesout://connections/yahoo?status=unavailable",
    });
  });
});
