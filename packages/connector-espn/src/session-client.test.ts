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
      expect(url.origin).toBe("https://lm-api-reads.fantasy.espn.com");
      expect(init?.method).toBe("GET");
      expect(new Headers(init?.headers).get("cookie")).toBe(
        `SWID=${credential.swid}; espn_s2=${credential.espnS2}`,
      );
      if (fetch.mock.calls.length === 1) {
        expect(url.searchParams.getAll("view")).toEqual([
          "mSettings",
          "mTeam",
          "mRoster",
          "mStandings",
          "mMatchup",
          "mNav",
        ]);
      }
      if (new Headers(init?.headers).get("x-fantasy-filter")?.includes("WAIVERS")) {
        return jsonResponse({ error: "temporary" }, 500);
      }
      return jsonResponse(
        fetch.mock.calls.length === 1
          ? {
              id: 123456789,
              seasonId: 2026,
              scoringPeriodId: 3,
              settings: { scheduleSettings: { matchupPeriods: { 3: [3] } } },
              teams: [],
            }
          : { ok: true },
      );
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

    expect(fetch).toHaveBeenCalledTimes(6);
    expect(result.core).toMatchObject({ leagueId: "123456789", season: 2026 });
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

  it("rejects caller-controlled league scope before making a request", async () => {
    const fetch = vi.fn();
    const client = new EspnSessionReadClient({ fetch });
    await expect(
      client.fetchLeague({ credential, leagueId: "../../users", season: 2026 }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
