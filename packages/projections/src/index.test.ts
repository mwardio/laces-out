import { describe, expect, it } from "vitest";

import {
  buildProjectionConsensus,
  groupProjectionConsensus,
  validateProjectionObservationCompatibility,
  weightedMedian,
  type ProjectionObservation,
  type ProjectionScoringProfile,
} from "./index.js";

const standard: ProjectionScoringProfile = {
  id: "standard",
  rules: [
    { statId: "rushing_yards", points: 0.1 },
    { statId: "receiving_yards", points: 0.1 },
    { statId: "rushing_touchdowns", points: 6 },
  ],
};

const ppr: ProjectionScoringProfile = {
  id: "ppr",
  rules: [...standard.rules, { statId: "receptions", points: 1 }],
};

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

  it("scores raw components for the target league and blends compatible point forecasts", () => {
    const consensus = buildProjectionConsensus(
      [
        {
          kind: "stat-components",
          playerId: "p1",
          sourceId: "raw",
          sourceVersion: "2026.1",
          horizon: { kind: "week", season: 2026, week: 1 },
          components: {
            rushing_yards: 80,
            receiving_yards: 40,
            rushing_touchdowns: 1,
            receptions: 6,
          },
          asOf: new Date("2026-09-01T11:00:00Z"),
          fetchedAt: new Date("2026-09-01T12:00:00Z"),
        },
        {
          kind: "points",
          playerId: "p1",
          sourceId: "points",
          sourceVersion: "2026.1",
          horizon: { kind: "week", season: 2026, week: 1 },
          points: 26,
          scoringProfile: ppr,
          asOf: new Date("2026-09-01T11:30:00Z"),
          fetchedAt: new Date("2026-09-01T13:00:00Z"),
        },
      ],
      { scoringProfile: ppr },
    );

    expect(consensus.points).toBe(25);
    expect(consensus.sourceCount).toBe(2);
    expect(consensus.horizon).toEqual({ kind: "week", season: 2026, week: 1 });
    expect(consensus.scoringProfile).toBe(ppr);
  });

  it("rejects incompatible and unscoped point-only forecasts", () => {
    const pprObservation: ProjectionObservation = {
      kind: "points",
      playerId: "p1",
      sourceId: "ppr-source",
      sourceVersion: "1",
      points: 20,
      scoringProfile: ppr,
      horizon: { kind: "week", season: 2026, week: 1 },
      asOf: new Date("2026-09-01"),
      fetchedAt: new Date("2026-09-01"),
    };
    const standardObservation: ProjectionObservation = {
      kind: "points",
      playerId: "p1",
      sourceId: "standard-source",
      sourceVersion: "1",
      points: 16,
      scoringProfile: standard,
      horizon: { kind: "week", season: 2026, week: 1 },
      asOf: new Date("2026-09-01"),
      fetchedAt: new Date("2026-09-01"),
    };

    expect(() => buildProjectionConsensus([pprObservation, standardObservation])).toThrow(
      "incompatible scoring profiles",
    );
    expect(() => buildProjectionConsensus([standardObservation], { scoringProfile: ppr })).toThrow(
      "uses an incompatible scoring profile",
    );
    expect(() =>
      buildProjectionConsensus(
        [
          {
            playerId: "p1",
            sourceId: "legacy",
            points: 20,
            fetchedAt: new Date("2026-09-01"),
          },
        ],
        { scoringProfile: ppr },
      ),
    ).toThrow("has no scoring profile");
    expect(() =>
      validateProjectionObservationCompatibility([pprObservation, standardObservation]),
    ).toThrow("incompatible horizons or scoring profiles");
  });

  it("requires a target league profile before scoring raw components", () => {
    expect(() =>
      buildProjectionConsensus([
        {
          kind: "stat-components",
          playerId: "p1",
          sourceId: "raw",
          sourceVersion: "1",
          horizon: { kind: "week", season: 2026, week: 1 },
          components: { receptions: 5 },
          asOf: new Date("2026-09-01"),
          fetchedAt: new Date("2026-09-01"),
        },
      ]),
    ).toThrow("requires a target scoring profile");
  });

  it("counts independent projection lineages and selects their latest observation", () => {
    const observations: ProjectionObservation[] = [
      {
        kind: "points",
        playerId: "p1",
        sourceId: "original",
        sourceVersion: "1",
        independenceKey: "model-a",
        points: 10,
        scoringProfile: ppr,
        horizon: { kind: "week", season: 2026, week: 1 },
        asOf: new Date("2026-08-31T12:00:00Z"),
        fetchedAt: new Date("2026-09-01T12:00:00Z"),
      },
      {
        kind: "points",
        playerId: "p1",
        sourceId: "mirror",
        sourceVersion: "1",
        independenceKey: "model-a",
        points: 20,
        scoringProfile: ppr,
        horizon: { kind: "week", season: 2026, week: 1 },
        asOf: new Date("2026-09-01T12:00:00Z"),
        fetchedAt: new Date("2026-09-01T13:00:00Z"),
      },
      {
        kind: "points",
        playerId: "p1",
        sourceId: "independent",
        sourceVersion: "1",
        independenceKey: "model-b",
        points: 30,
        scoringProfile: ppr,
        horizon: { kind: "week", season: 2026, week: 1 },
        asOf: new Date("2026-09-01T12:00:00Z"),
        fetchedAt: new Date("2026-09-01T14:00:00Z"),
      },
    ];

    const forward = buildProjectionConsensus(observations);
    const reverse = buildProjectionConsensus([...observations].reverse());

    expect(forward.points).toBe(25);
    expect(forward.sourceCount).toBe(2);
    expect(forward.sourceIds).toEqual(["independent", "mirror"]);
    expect(reverse).toEqual(forward);
  });
});

describe("groupProjectionConsensus", () => {
  it("groups by player, horizon, and compatible scoring context in deterministic order", () => {
    const observations: ProjectionObservation[] = [
      {
        kind: "points",
        playerId: "p2",
        sourceId: "standard-week",
        sourceVersion: "1",
        points: 15,
        scoringProfile: standard,
        horizon: { kind: "week", season: 2026, week: 1 },
        asOf: new Date("2026-09-01"),
        fetchedAt: new Date("2026-09-01"),
      },
      {
        kind: "points",
        playerId: "p1",
        sourceId: "ppr-ros",
        sourceVersion: "1",
        points: 200,
        scoringProfile: ppr,
        horizon: { kind: "rest-of-season", season: 2026 },
        asOf: new Date("2026-09-01"),
        fetchedAt: new Date("2026-09-01"),
      },
      {
        kind: "points",
        playerId: "p1",
        sourceId: "ppr-week",
        sourceVersion: "1",
        points: 20,
        scoringProfile: ppr,
        horizon: { kind: "week", season: 2026, week: 1 },
        asOf: new Date("2026-09-01"),
        fetchedAt: new Date("2026-09-01"),
      },
      {
        kind: "points",
        playerId: "p1",
        sourceId: "standard-week",
        sourceVersion: "1",
        points: 16,
        scoringProfile: standard,
        horizon: { kind: "week", season: 2026, week: 1 },
        asOf: new Date("2026-09-01"),
        fetchedAt: new Date("2026-09-01"),
      },
    ];

    const grouped = groupProjectionConsensus(observations);

    expect(grouped).toHaveLength(4);
    expect(grouped.map((item) => [item.playerId, item.points])).toEqual([
      ["p1", 200],
      ["p1", 20],
      ["p1", 16],
      ["p2", 15],
    ]);
    expect(groupProjectionConsensus([...observations].reverse())).toEqual(grouped);
  });

  it("keeps semantically equivalent named profiles in one group", () => {
    const alternatePpr: ProjectionScoringProfile = {
      id: "provider-ppr",
      rules: [...ppr.rules].reverse(),
    };
    const observations: ProjectionObservation[] = [
      {
        kind: "points",
        playerId: "p1",
        sourceId: "a",
        sourceVersion: "1",
        points: 20,
        scoringProfile: ppr,
        horizon: { kind: "week", season: 2026, week: 1 },
        asOf: new Date("2026-09-01"),
        fetchedAt: new Date("2026-09-01"),
      },
      {
        kind: "points",
        playerId: "p1",
        sourceId: "b",
        sourceVersion: "1",
        points: 22,
        scoringProfile: alternatePpr,
        horizon: { kind: "week", season: 2026, week: 1 },
        asOf: new Date("2026-09-01"),
        fetchedAt: new Date("2026-09-01"),
      },
    ];
    const grouped = groupProjectionConsensus(observations);

    expect(grouped).toHaveLength(1);
    expect(grouped[0]?.sourceCount).toBe(2);
    expect(grouped[0]?.points).toBe(21);
    expect(groupProjectionConsensus([...observations].reverse())).toEqual(grouped);
  });
});
