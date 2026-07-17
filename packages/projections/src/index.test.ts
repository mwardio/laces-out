import { describe, expect, it } from "vitest";

import { buildProjectionConsensus, weightedMedian } from "./index.js";

describe("weightedMedian", () => {
  it("limits a low-weight outlier", () => {
    expect(
      weightedMedian([
        { value: 10, weight: 1 },
        { value: 11, weight: 1 },
        { value: 100, weight: 0.1 },
      ]),
    ).toBe(11);
  });

  it("averages the boundary for equal even weights", () => {
    expect(
      weightedMedian([
        { value: 10, weight: 1 },
        { value: 12, weight: 1 },
      ]),
    ).toBe(11);
  });
});

describe("buildProjectionConsensus", () => {
  it("preserves provenance and derives uncertainty", () => {
    const consensus = buildProjectionConsensus([
      { playerId: "p1", sourceId: "a", points: 15, fetchedAt: new Date("2026-09-01") },
      { playerId: "p1", sourceId: "b", points: 16, fetchedAt: new Date("2026-09-02") },
      { playerId: "p1", sourceId: "c", points: 17, fetchedAt: new Date("2026-09-03") },
    ]);

    expect(consensus.points).toBe(16);
    expect(consensus.floor).toBeLessThan(consensus.points);
    expect(consensus.ceiling).toBeGreaterThan(consensus.points);
    expect(consensus.sourceIds).toEqual(["a", "b", "c"]);
    expect(consensus.freshestAt.toISOString()).toBe("2026-09-03T00:00:00.000Z");
    expect(consensus.confidence).toBeGreaterThan(0.8);
  });

  it("rejects mixed players", () => {
    expect(() =>
      buildProjectionConsensus([
        { playerId: "p1", sourceId: "a", points: 10, fetchedAt: new Date() },
        { playerId: "p2", sourceId: "b", points: 11, fetchedAt: new Date() },
      ]),
    ).toThrow("same player");
  });
});
