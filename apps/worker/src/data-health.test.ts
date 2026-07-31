import { describe, expect, it } from "vitest";

import { assessDataSourceHealth } from "./data-health.js";

const checkedAt = new Date("2026-07-21T12:00:00.000Z");

describe("data-source health assessment", () => {
  it("separates healthy, pending, stale, and failing enabled sources", () => {
    const result = assessDataSourceHealth(
      [
        {
          key: "healthy",
          checkIntervalMinutes: 60,
          lastSuccessfulAt: new Date("2026-07-21T11:30:00.000Z"),
          consecutiveFailures: 0,
          metadata: {},
          createdAt: new Date("2026-07-01T00:00:00.000Z"),
        },
        {
          key: "pending",
          checkIntervalMinutes: 60,
          lastSuccessfulAt: null,
          consecutiveFailures: 0,
          metadata: {},
          createdAt: new Date("2026-07-21T11:30:00.000Z"),
        },
        {
          key: "stale",
          checkIntervalMinutes: 60,
          lastSuccessfulAt: new Date("2026-07-21T09:00:00.000Z"),
          consecutiveFailures: 0,
          metadata: {},
          createdAt: new Date("2026-07-01T00:00:00.000Z"),
        },
        {
          key: "failed-and-stale",
          checkIntervalMinutes: 60,
          lastSuccessfulAt: new Date("2026-07-21T09:00:00.000Z"),
          consecutiveFailures: 2,
          metadata: {},
          createdAt: new Date("2026-07-01T00:00:00.000Z"),
        },
      ],
      checkedAt,
    );

    expect(result).toEqual({
      checkedAt: checkedAt.toISOString(),
      enabledSources: 4,
      healthySources: 1,
      pendingSources: 1,
      degradedSources: 2,
      failingSources: 1,
      staleSources: 2,
      unmatchedIdentitySources: 0,
      degradedSourceKeys: ["failed-and-stale", "stale"],
    });
  });

  it("treats a never-run source as stale only after its startup grace period", () => {
    const result = assessDataSourceHealth(
      [
        {
          key: "never-ran",
          checkIntervalMinutes: 15,
          lastSuccessfulAt: null,
          consecutiveFailures: 0,
          metadata: {},
          createdAt: new Date("2026-07-21T11:00:00.000Z"),
        },
      ],
      checkedAt,
    );

    expect(result.pendingSources).toBe(0);
    expect(result.staleSources).toBe(1);
    expect(result.degradedSourceKeys).toEqual(["never-ran"]);
  });

  it("keeps not-yet-published current-season feeds pending without aging into an outage", () => {
    const result = assessDataSourceHealth(
      [
        {
          key: "nflverse.stats-player-week.2026",
          checkIntervalMinutes: 30,
          lastSuccessfulAt: null,
          consecutiveFailures: 0,
          metadata: { season: 2026, availability: "not-published" },
          createdAt: new Date("2026-03-01T00:00:00.000Z"),
        },
      ],
      checkedAt,
    );

    expect(result.pendingSources).toBe(1);
    expect(result.staleSources).toBe(0);
    expect(result.degradedSourceKeys).toEqual([]);
  });

  it("does not flag an intentionally non-publishable shadow rail as degraded", () => {
    const result = assessDataSourceHealth(
      [
        {
          key: "laces-out.projections.first-party-ros-shadow",
          checkIntervalMinutes: 60,
          lastSuccessfulAt: new Date("2026-07-21T11:55:00.000Z"),
          consecutiveFailures: 0,
          metadata: { mode: "shadow", qualityState: "degraded", publishable: false },
          createdAt: new Date("2026-07-01T00:00:00.000Z"),
        },
      ],
      checkedAt,
    );

    expect(result.healthySources).toBe(1);
    expect(result.degradedSourceKeys).toEqual([]);
  });

  it("excludes immutable nflverse history outside the active model window", () => {
    const source = (season: number): Parameters<typeof assessDataSourceHealth>[0][number] => ({
      key: `nflverse.stats-player-week.${season}`,
      checkIntervalMinutes: 1440,
      lastSuccessfulAt: new Date("2026-07-01T00:00:00.000Z"),
      consecutiveFailures: 0,
      metadata: { season },
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const result = assessDataSourceHealth([source(2022), source(2023)], checkedAt, {
      minimumNflverseSeason: 2023,
    });

    expect(result.enabledSources).toBe(1);
    expect(result.staleSources).toBe(1);
    expect(result.degradedSourceKeys).toEqual(["nflverse.stats-player-week.2023"]);
  });

  it("degrades a current projection source when its gate rejects or its output is stale", () => {
    const result = assessDataSourceHealth(
      [
        {
          key: "projection-rejected",
          checkIntervalMinutes: 60,
          lastSuccessfulAt: new Date("2026-07-21T11:55:00.000Z"),
          consecutiveFailures: 0,
          metadata: {
            targetWeeks: "1,2",
            qualityState: "degraded",
            lastPublishedAt: "2026-07-21T11:30:00.000Z",
            lastEvaluationAt: "2026-07-21T11:55:00.000Z",
          },
          createdAt: new Date("2026-07-01T00:00:00.000Z"),
        },
        {
          key: "projection-output-stale",
          checkIntervalMinutes: 60,
          lastSuccessfulAt: new Date("2026-07-21T11:55:00.000Z"),
          consecutiveFailures: 0,
          metadata: {
            targetWeeks: "1,2",
            qualityState: "publishable",
            lastPublishedAt: "2026-07-21T09:00:00.000Z",
            lastEvaluationAt: "2026-07-21T09:00:00.000Z",
          },
          createdAt: new Date("2026-07-01T00:00:00.000Z"),
        },
      ],
      checkedAt,
    );

    expect(result.healthySources).toBe(0);
    expect(result.staleSources).toBe(1);
    expect(result.degradedSourceKeys).toEqual(["projection-output-stale", "projection-rejected"]);
  });

  it("keeps an unchanged prior publication healthy after a fresh complete evaluation", () => {
    const checkedAt = new Date("2026-07-21T12:00:00.000Z");
    const result = assessDataSourceHealth(
      [
        {
          key: "projection-unchanged",
          checkIntervalMinutes: 60,
          lastSuccessfulAt: new Date("2026-07-21T11:55:00.000Z"),
          consecutiveFailures: 0,
          metadata: {
            targetWeeks: "1,2",
            qualityState: "publishable",
            lastPublishedAt: "2026-07-20T18:00:00.000Z",
            lastEvaluationAt: "2026-07-21T11:55:00.000Z",
          },
          createdAt: new Date("2026-07-01T00:00:00.000Z"),
        },
      ],
      checkedAt,
    );

    expect(result.healthySources).toBe(1);
    expect(result.staleSources).toBe(0);
    expect(result.degradedSourceKeys).toEqual([]);
  });

  it("degrades a source whose match rate fell below its published threshold", () => {
    const result = assessDataSourceHealth(
      [
        {
          key: "nflverse.stats-player-week.2026",
          checkIntervalMinutes: 1440,
          lastSuccessfulAt: new Date("2026-07-21T11:30:00.000Z"),
          consecutiveFailures: 0,
          metadata: {
            matchRate: 0.82,
            minimumPublishableMatchRate: 0.95,
            publishable: false,
          },
          createdAt: new Date("2026-07-01T00:00:00.000Z"),
        },
        {
          key: "nflverse.weekly-rosters.2026",
          checkIntervalMinutes: 1440,
          lastSuccessfulAt: new Date("2026-07-21T11:30:00.000Z"),
          consecutiveFailures: 0,
          metadata: {
            matchRate: 0.99,
            minimumPublishableMatchRate: 0.95,
            publishable: true,
          },
          createdAt: new Date("2026-07-01T00:00:00.000Z"),
        },
      ],
      checkedAt,
    );

    expect(result.degradedSourceKeys).toEqual(["nflverse.stats-player-week.2026"]);
    expect(result.healthySources).toBe(1);
    expect(result.unmatchedIdentitySources).toBe(1);
  });

  it("reports against the threshold in force at ingestion, not today's registry value", () => {
    const result = assessDataSourceHealth(
      [
        {
          key: "nflverse.snap-counts.2026",
          checkIntervalMinutes: 1440,
          lastSuccessfulAt: new Date("2026-07-21T11:30:00.000Z"),
          consecutiveFailures: 0,
          // Refreshed while the snap threshold was still 0.95, so the stored pair governs.
          metadata: { matchRate: 0.92, minimumPublishableMatchRate: 0.95, publishable: false },
          createdAt: new Date("2026-07-01T00:00:00.000Z"),
        },
      ],
      checkedAt,
    );

    expect(result.degradedSourceKeys).toEqual(["nflverse.snap-counts.2026"]);
    expect(result.unmatchedIdentitySources).toBe(1);
  });

  it("does not treat a fresh source with no quality metadata as unmatched-degraded", () => {
    const result = assessDataSourceHealth(
      [
        {
          key: "nflverse.schedules.2026",
          checkIntervalMinutes: 1440,
          lastSuccessfulAt: new Date("2026-07-21T11:30:00.000Z"),
          consecutiveFailures: 0,
          metadata: {},
          createdAt: new Date("2026-07-01T00:00:00.000Z"),
        },
      ],
      checkedAt,
    );

    expect(result.degradedSourceKeys).toEqual([]);
    expect(result.unmatchedIdentitySources).toBe(0);
  });

  it("counts an unmatched-degraded source once even when it is also failing and stale", () => {
    const result = assessDataSourceHealth(
      [
        {
          key: "ffc.adp.2026.ppr.12",
          checkIntervalMinutes: 60,
          lastSuccessfulAt: new Date("2026-07-21T09:00:00.000Z"),
          consecutiveFailures: 3,
          metadata: { matchRate: 0.85, minimumPublishableMatchRate: 0.95, publishable: false },
          createdAt: new Date("2026-07-01T00:00:00.000Z"),
        },
      ],
      checkedAt,
    );

    expect(result.degradedSourceKeys).toEqual(["ffc.adp.2026.ppr.12"]);
    expect(result.degradedSources).toBe(1);
    expect(result.unmatchedIdentitySources).toBe(1);
  });
});
