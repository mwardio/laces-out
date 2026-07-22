import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  NFLVERSE_SNAP_COUNTS_SOURCE_KEY,
  NflverseSnapCountsSource,
  buildNflverseSnapCountsUrl,
  type NflverseDatasetState,
} from "./index.js";

const fixture = readFileSync(new URL("./fixtures/snap-counts.csv", import.meta.url), "utf8");
const EMPTY_STATE: NflverseDatasetState = {
  etag: null,
  lastModified: null,
  checksumSha256: null,
};

describe("NflverseSnapCountsSource", () => {
  it("normalizes game-level offense, defense, and special-teams participation", async () => {
    const requested: string[] = [];
    const source = new NflverseSnapCountsSource({
      now: () => new Date("2026-07-21T15:30:00.000Z"),
      fetch: (input) => {
        requested.push(input.toString());
        return Promise.resolve(
          new Response(fixture, {
            headers: {
              "content-type": "application/octet-stream",
              etag: '"snaps-2025-v1"',
            },
          }),
        );
      },
    });

    const result = await source.check(2025, EMPTY_STATE);

    expect(requested).toEqual([buildNflverseSnapCountsUrl(2025)]);
    expect(result).toMatchObject({
      state: "changed",
      sourceKey: NFLVERSE_SNAP_COUNTS_SOURCE_KEY,
      season: 2025,
      rowsRead: 2,
      rowsRejected: 0,
      coveredWeeks: [1],
      coveredSeasonTypes: ["REG"],
    });
    if (result.state === "changed") {
      expect(result.observations).toEqual([
        expect.objectContaining({
          pfrPlayerId: "RunnEx00",
          offense: { snaps: 62, share: 0.91 },
          defense: { snaps: 0, share: 0 },
          specialTeams: { snaps: 1, share: 0.04 },
        }),
        expect.objectContaining({
          pfrPlayerId: "DefeSa00",
          defense: { snaps: 58, share: 0.88 },
        }),
      ]);
    }
  });

  it("uses checksums when a release host omits HTTP validators", async () => {
    const source = new NflverseSnapCountsSource({
      fetch: () => Promise.resolve(new Response(fixture)),
    });
    const first = await source.check(2025, EMPTY_STATE);
    const second = await source.check(2025, {
      etag: null,
      lastModified: null,
      checksumSha256: first.checksumSha256,
    });
    expect(second).toMatchObject({ state: "unchanged", checksumSha256: first.checksumSha256 });
  });

  it("rejects impossible snap shares while preserving valid rows", async () => {
    const invalid = fixture.trimEnd().split("\n")[1]?.replace(",62,0.91,", ",0,0.91,");
    const source = new NflverseSnapCountsSource({
      fetch: () => Promise.resolve(new Response(`${fixture.trimEnd()}\n${invalid ?? ""}\n`)),
    });
    const result = await source.check(2025, EMPTY_STATE);
    expect(result).toMatchObject({
      state: "changed",
      rowsRead: 3,
      rowsRejected: 1,
      rejections: { invalidCounts: 1 },
    });
  });

  it("classifies an upstream rate limit as retryable", async () => {
    const source = new NflverseSnapCountsSource({
      fetch: () => Promise.resolve(new Response(null, { status: 429 })),
    });
    await expect(source.check(2025, EMPTY_STATE)).rejects.toMatchObject({
      code: "UPSTREAM",
      retryable: true,
    });
  });

  it("validates snap-count coverage before fetching", async () => {
    const source = new NflverseSnapCountsSource({
      fetch: () => Promise.resolve(new Response(fixture)),
    });
    await expect(source.check(2011, EMPTY_STATE)).rejects.toMatchObject({
      code: "INVALID_CONTEXT",
      retryable: false,
    });
  });
});
