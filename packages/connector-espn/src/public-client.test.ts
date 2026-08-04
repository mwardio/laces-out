import { describe, expect, it, vi } from "vitest";

import { canonicalEspnPayloadChecksumV1 } from "./payload-checksum.js";
import { EspnPublicReadClient } from "./public-client.js";
import type { EspnPublicReadError } from "./public-client.js";

describe("EspnPublicReadClient", () => {
  it("performs an anonymous, credential-omitting, read-only request", async () => {
    let requestedInput: string | URL | undefined;
    let requestedInit: RequestInit | undefined;
    const fetchMock = vi.fn((input: string | URL, init?: RequestInit): Promise<Response> => {
      requestedInput = input;
      requestedInit = init;
      return Promise.resolve(
        new Response(JSON.stringify({ id: 987654321, seasonId: 2026, teams: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    });
    const client = new EspnPublicReadClient({
      fetch: fetchMock,
      now: () => new Date("2026-07-16T12:00:00.000Z"),
    });

    const artifact = await client.fetchLeague({
      leagueId: "987654321",
      season: 2026,
      views: ["mSettings", "mRoster"],
    });

    expect(String(requestedInput)).toBe(
      "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/2026/segments/0/leagues/987654321?view=mSettings&view=mRoster",
    );
    expect(requestedInit).toMatchObject({
      method: "GET",
      credentials: "omit",
      redirect: "error",
      headers: { Accept: "application/json" },
    });
    expect(JSON.stringify(requestedInit)).not.toMatch(/cookie|authorization|password/iu);
    expect(artifact).toMatchObject({
      provider: "espn",
      authority: "unofficial",
      readOnly: true,
      fetchedAt: "2026-07-16T12:00:00.000Z",
      checksumSha256: canonicalEspnPayloadChecksumV1({
        id: 987654321,
        seasonId: 2026,
        teams: [],
      }),
    });
  });

  it("directs private leagues to the browser bridge without accepting auth material", async () => {
    const client = new EspnPublicReadClient({
      fetch: () => Promise.resolve(new Response("", { status: 403 })),
    });

    await expect(client.fetchLeague({ leagueId: "12345", season: 2026 })).rejects.toMatchObject({
      code: "NOT_PUBLIC",
      status: 403,
    } satisfies Partial<EspnPublicReadError>);
  });
});
