import { describe, expect, it } from "vitest";

import {
  FFC_ADP_ORIGIN,
  FfcAdpSource,
  FfcAdpSourceError,
  buildFfcAdpUrl,
  type FfcAdpContext,
  type FfcAdpSourceState,
} from "./ffc-adp-source.js";

const CONTEXT: FfcAdpContext = {
  season: 2026,
  teams: 12,
  scoringFormat: "ppr",
  position: null,
};

const EMPTY_STATE: FfcAdpSourceState = {
  etag: null,
  lastModified: null,
  checksumSha256: null,
  asOfDate: null,
};

function payload(
  players: unknown[] = [
    {
      player_id: 5670,
      name: "Example Runner",
      position: "RB",
      team: "ATL",
      adp: 1.6,
      adp_formatted: "1.02",
      times_drafted: 260,
      high: 1,
      low: 4,
      stdev: 0.7,
      bye: 11,
    },
  ],
) {
  return JSON.stringify({
    status: "Success",
    meta: {
      type: "PPR",
      teams: 12,
      rounds: 15,
      total_drafts: 2563,
      start_date: "2026-07-14",
      end_date: "2026-07-21",
    },
    players,
  });
}

describe("buildFfcAdpUrl", () => {
  it("builds only the approved HTTPS origin, path, and contextual query", () => {
    const endpoint = buildFfcAdpUrl({ ...CONTEXT, position: "QB" });
    expect(endpoint.origin).toBe(FFC_ADP_ORIGIN);
    expect(endpoint.protocol).toBe("https:");
    expect(endpoint.pathname).toBe("/api/v1/adp/ppr");
    expect(Object.fromEntries(endpoint.searchParams)).toEqual({
      teams: "12",
      year: "2026",
      position: "QB",
    });
  });

  it("rejects unsupported context before making a request", () => {
    expect(() => buildFfcAdpUrl({ ...CONTEXT, teams: 11 as 12 })).toThrowError(
      expect.objectContaining({ code: "INVALID_CONTEXT", retryable: false }),
    );
  });
});

describe("FfcAdpSource", () => {
  it("normalizes ADP observations and preserves their context and source fields", async () => {
    const requests: Array<{
      readonly url: string;
      readonly init: RequestInit | undefined;
    }> = [];
    const source = new FfcAdpSource({
      now: () => new Date("2026-07-21T14:30:00.000Z"),
      fetch: (input, init) => {
        requests.push({ url: input.toString(), init });
        return Promise.resolve(
          new Response(payload(), {
            status: 200,
            headers: {
              "content-type": "text/html; charset=utf-8",
              etag: '"ffc-ppr-2026"',
              "last-modified": "Tue, 21 Jul 2026 14:11:15 GMT",
            },
          }),
        );
      },
    });

    const result = await source.check(CONTEXT, {
      ...EMPTY_STATE,
      etag: '"old"',
      lastModified: "Mon, 20 Jul 2026 14:00:00 GMT",
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      "https://fantasyfootballcalculator.com/api/v1/adp/ppr?teams=12&year=2026",
    );
    expect(requests[0]?.init?.redirect).toBe("manual");
    const headers = new Headers(requests[0]?.init?.headers);
    expect(headers.get("if-none-match")).toBe('"old"');
    expect(headers.get("if-modified-since")).toBe("Mon, 20 Jul 2026 14:00:00 GMT");
    expect(result).toMatchObject({
      state: "changed",
      fetchedAt: "2026-07-21T14:30:00.000Z",
      asOfDate: "2026-07-21",
      windowStartDate: "2026-07-14",
      rounds: 15,
      totalDrafts: 2563,
      rowsRead: 1,
      rowsRejected: 0,
      context: CONTEXT,
      etag: '"ffc-ppr-2026"',
    });
    if (result.state === "changed") {
      expect(result.players).toEqual([
        {
          ffcPlayerId: "5670",
          name: "Example Runner",
          position: "RB",
          nflTeam: "ATL",
          adp: 1.6,
          adpFormatted: "1.02",
          standardDeviation: 0.7,
          timesDrafted: 260,
          highPick: 1,
          lowPick: 4,
          byeWeek: 11,
        },
      ]);
      expect(result.checksumSha256).toMatch(/^[a-f0-9]{64}$/u);
    }
  });

  it("rejects malformed and duplicate rows without contaminating valid observations", async () => {
    const rows = [
      {
        player_id: "42",
        name: "Valid Receiver",
        position: "WR",
        team: "buf",
        adp: 24.2,
        times_drafted: 100,
        stdev: 3.4,
      },
      { player_id: "42", name: "Duplicate", position: "WR", team: "BUF", adp: 25 },
      { player_id: "nope", name: "Malformed", position: "WR", team: "BUF", adp: 26 },
    ];
    const source = new FfcAdpSource({
      fetch: () =>
        Promise.resolve(
          new Response(payload(rows), { headers: { "content-type": "application/json" } }),
        ),
    });

    const result = await source.check(CONTEXT, EMPTY_STATE);
    expect(result).toMatchObject({ state: "changed", rowsRead: 3, rowsRejected: 2 });
    if (result.state === "changed") {
      expect(result.players[0]).toMatchObject({ ffcPlayerId: "42", nflTeam: "BUF" });
    }
  });

  it("honors conditional 304 responses", async () => {
    const source = new FfcAdpSource({
      fetch: () => Promise.resolve(new Response(null, { status: 304 })),
    });
    const previous = {
      etag: '"same"',
      lastModified: null,
      checksumSha256: "a".repeat(64),
      asOfDate: "2026-07-21",
    };
    await expect(source.check(CONTEXT, previous)).resolves.toMatchObject({
      state: "unchanged",
      asOfDate: "2026-07-21",
      checksumSha256: "a".repeat(64),
    });
  });

  it("uses the checksum when upstream validators do not change", async () => {
    const body = payload();
    const source = new FfcAdpSource({
      fetch: () =>
        Promise.resolve(new Response(body, { headers: { "content-type": "application/json" } })),
    });
    const first = await source.check(CONTEXT, EMPTY_STATE);
    const second = await source.check(CONTEXT, {
      etag: null,
      lastModified: null,
      checksumSha256: first.checksumSha256,
      asOfDate: "2026-07-21",
    });
    expect(second).toMatchObject({ state: "unchanged", asOfDate: "2026-07-21" });
  });

  it.each([
    {
      name: "redirect",
      response: new Response(null, { status: 302, headers: { location: "https://example.com" } }),
      code: "REDIRECT",
      retryable: false,
    },
    {
      name: "rate limit",
      response: new Response(null, { status: 429 }),
      code: "UPSTREAM",
      retryable: true,
    },
    {
      name: "wrong content type",
      response: new Response(payload(), { headers: { "content-type": "image/png" } }),
      code: "CONTENT_TYPE",
      retryable: false,
    },
    {
      name: "declared oversize response",
      response: new Response(payload(), {
        headers: { "content-type": "application/json", "content-length": "2097153" },
      }),
      code: "TOO_LARGE",
      retryable: false,
    },
  ])("classifies a $name safely", async ({ response, code, retryable }) => {
    const source = new FfcAdpSource({ fetch: () => Promise.resolve(response.clone()) });
    const error = await source.check(CONTEXT, EMPTY_STATE).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FfcAdpSourceError);
    expect(error).toMatchObject({ code, retryable });
  });

  it("rejects an invalid response envelope even when the body is JSON", async () => {
    const source = new FfcAdpSource({
      fetch: () =>
        Promise.resolve(
          new Response(JSON.stringify({ status: "Error", players: [] }), {
            headers: { "content-type": "application/json" },
          }),
        ),
    });
    await expect(source.check(CONTEXT, EMPTY_STATE)).rejects.toMatchObject({
      code: "INVALID_JSON",
      retryable: false,
    });
  });
});
