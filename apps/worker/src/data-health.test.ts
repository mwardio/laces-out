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
});
