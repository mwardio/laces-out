import { describe, expect, it, vi } from "vitest";

import { EspnSessionReadClient, type EspnSessionCredential } from "./session-client.js";
import type { EspnSessionReadError } from "./session-client.js";

const credential: EspnSessionCredential = {
  swid: "{123e4567-e89b-42d3-a456-426614174000}",
  espnS2: "session-value-that-is-long-enough-for-validation",
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("ESPN server-session read client", () => {
  it("uses only the fixed read origin, scopes the cookie header, and isolates supplemental drift", async () => {
    const fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(input);
      const views = url.searchParams.getAll("view");
      const headers = new Headers(init?.headers);
      expect(url.origin).toBe("https://lm-api-reads.fantasy.espn.com");
      expect(init?.method).toBe("GET");
      expect(init?.credentials).toBe("omit");
      expect(init?.redirect).toBe("error");
      expect(init?.cache).toBe("no-store");
      expect(headers.get("cookie")).toBe(`SWID=${credential.swid}; espn_s2=${credential.espnS2}`);
      if (views.includes("mSettings")) {
        expect(views).toEqual(["mSettings", "mTeam", "mRoster", "mStandings", "mMatchup"]);
        expect([...headers.keys()].sort()).toEqual(["accept", "cookie"]);
        return jsonResponse({
          id: 123456789,
          seasonId: 2026,
          scoringPeriodId: 3,
          settings: { scheduleSettings: { matchupPeriods: { 3: [3] } } },
          teams: [],
        });
      }
      if (views.includes("mNav")) {
        expect(views).toEqual(["mNav"]);
        expect([...headers.keys()].sort()).toEqual(["accept", "cookie"]);
        return jsonResponse({ id: 123456789, seasonId: 2026, members: [] });
      }
      if (headers.get("x-fantasy-filter")?.includes("WAIVERS")) {
        return jsonResponse({ error: "temporary" }, 500);
      }
      return jsonResponse({ ok: true });
    });
    const client = new EspnSessionReadClient({
      fetch,
      now: () => new Date("2026-09-24T15:00:00.000Z"),
    });

    const result = await client.fetchLeague({
      credential,
      leagueId: "123456789",
      season: 2026,
    });

    expect(fetch).toHaveBeenCalledTimes(7);
    expect(result.core).toMatchObject({ leagueId: "123456789", season: 2026 });
    expect(result.navigation.endpoint.endsWith("?view=mNav")).toBe(true);
    expect(result.supplemental).toHaveLength(4);
    expect(result.supplementalFailures).toEqual([
      { kind: "available-waivers", code: "UPSTREAM_ERROR" },
    ]);
  });

  it("classifies an expired ESPN session without exposing credential material", async () => {
    const client = new EspnSessionReadClient({
      fetch: async () => jsonResponse({ error: "denied" }, 401),
    });

    await expect(
      client.fetchLeague({ credential, leagueId: "123456789", season: 2026 }),
    ).rejects.toMatchObject({
      name: "EspnSessionReadError",
      code: "AUTHORIZATION_EXPIRED",
      message: "ESPN sign-in must be renewed",
    } satisfies Partial<EspnSessionReadError>);
  });

  it("does not downgrade supplemental authentication expiry to best-effort drift", async () => {
    const fetch = vi.fn(async (input: string | URL) => {
      const views = new URL(input).searchParams.getAll("view");
      if (views.includes("mSettings")) {
        return jsonResponse({
          id: 123456789,
          seasonId: 2026,
          scoringPeriodId: 3,
          settings: { scheduleSettings: { matchupPeriods: { 3: [3] } } },
          teams: [],
        });
      }
      if (views.includes("mNav")) {
        return jsonResponse({ id: 123456789, seasonId: 2026, members: [] });
      }
      return jsonResponse({ error: "denied" }, 401);
    });
    const client = new EspnSessionReadClient({ fetch });

    await expect(
      client.fetchLeague({ credential, leagueId: "123456789", season: 2026 }),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_EXPIRED" });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("preserves caller cancellation while classifying an independent timeout as retryable", async () => {
    const cancelled = new DOMException("worker shutdown", "AbortError");
    const controller = new AbortController();
    controller.abort(cancelled);
    const cancelledFetch = vi.fn();
    const cancelledClient = new EspnSessionReadClient({ fetch: cancelledFetch });

    await expect(
      cancelledClient.fetchCore({
        credential,
        leagueId: "123456789",
        season: 2026,
        signal: controller.signal,
      }),
    ).rejects.toBe(cancelled);
    expect(cancelledFetch).not.toHaveBeenCalled();

    const timeoutClient = new EspnSessionReadClient({
      timeoutMs: 500,
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("request timed out")), {
            once: true,
          });
        }),
    });
    await expect(
      timeoutClient.fetchCore({ credential, leagueId: "123456789", season: 2026 }),
    ).rejects.toMatchObject({ code: "UPSTREAM_ERROR", retryable: true });
  });

  it("rejects caller-controlled league scope before making a request", async () => {
    const fetch = vi.fn();
    const client = new EspnSessionReadClient({ fetch });
    await expect(
      client.fetchLeague({ credential, leagueId: "../../users", season: 2026 }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(
      client.fetchNavigation({ credential, leagueId: "123456789", season: 1999 }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
