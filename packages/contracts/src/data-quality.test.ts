import { describe, expect, it } from "vitest";

import { dataQualityResponseSchema, unresolvedIdentityResponseSchema } from "./data-quality.js";

const source = {
  key: "nflverse.stats-player-week.2026",
  name: "NFL weekly player stats 2026",
  dataset: "weekly-stats" as const,
  season: 2026,
  lifecycle: "active" as const,
  admission: "quarantined" as const,
  matchRate: 0.82,
  minimumMatchRate: 0.95,
  thresholdRationale: "GSIS identifiers resolve reliably; below this the catalog is stale.",
  meetsThreshold: false,
  rowsRead: 1200,
  rowsRejected: 0,
  rowsUnmatched: 216,
  lastSuccessfulAt: "2026-07-27T06:00:00.000Z",
  checksumSha256: null,
  affectedAnalysis: ["Schedule Edge", "Stats Center"],
  reason: "The latest dataset has not cleared admission and identity-quality checks.",
};

describe("data quality contracts", () => {
  it("accepts a degraded source summary", () => {
    const parsed = dataQualityResponseSchema.parse({
      generatedAt: "2026-07-27T12:00:00.000Z",
      algorithmVersion: "data-quality-v1",
      availability: { state: "available", reason: null },
      sources: [source],
      degradedSourceKeys: [source.key],
    });

    expect(parsed.sources[0]?.meetsThreshold).toBe(false);
  });

  it("rejects a sample row carrying redacted injury free text", () => {
    expect(() =>
      unresolvedIdentityResponseSchema.parse({
        generatedAt: "2026-07-27T12:00:00.000Z",
        algorithmVersion: "data-quality-v1",
        source,
        weeks: { state: "available", reason: null, rows: [] },
        sample: {
          state: "available",
          reason: null,
          rows: [
            {
              season: 2026,
              week: 3,
              externalPlayerId: "00-0033873",
              team: "KC",
              position: "WR",
              reportPrimaryInjury: "hamstring",
            },
          ],
        },
      }),
    ).toThrow(/unrecognized key/iu);
  });

  it("rejects a match rate outside zero to one", () => {
    expect(() =>
      dataQualityResponseSchema.parse({
        generatedAt: "2026-07-27T12:00:00.000Z",
        algorithmVersion: "data-quality-v1",
        availability: { state: "available", reason: null },
        sources: [{ ...source, matchRate: 1.4 }],
        degradedSourceKeys: [],
      }),
    ).toThrow();
  });

  it("accepts a withheld week breakdown with its stated reason", () => {
    const parsed = unresolvedIdentityResponseSchema.parse({
      generatedAt: "2026-07-27T12:00:00.000Z",
      algorithmVersion: "data-quality-v1",
      source,
      weeks: {
        state: "unavailable",
        reason: "The bounded read reached its 500 row safety limit, so this dataset was withheld.",
        rows: [],
      },
      sample: { state: "available", reason: null, rows: [] },
    });

    expect(parsed.weeks.state).toBe("unavailable");
    expect(parsed.weeks.rows).toEqual([]);
  });

  it("rejects an unknown algorithm version so a drifting service fails closed", () => {
    expect(() =>
      dataQualityResponseSchema.parse({
        generatedAt: "2026-07-27T12:00:00.000Z",
        algorithmVersion: "data-quality-v2",
        availability: { state: "available", reason: null },
        sources: [],
        degradedSourceKeys: [],
      }),
    ).toThrow();
  });
});
