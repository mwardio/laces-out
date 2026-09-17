import { describe, expect, it } from "vitest";

import {
  scoreFirstPartyRosOutcomes,
  simulateFirstPartyRosOutcomes,
  type FirstPartyRosOutcomeInput,
} from "./ros-outcomes.js";
import {
  projectFirstPartyRestOfSeason,
  projectFirstPartyRestOfSeasonProfiles,
} from "./rest-of-season.js";
import type { ProjectionScoringProfile } from "./scoring.js";

function input(overrides: Partial<FirstPartyRosOutcomeInput> = {}): FirstPartyRosOutcomeInput {
  return {
    playerId: "receiver",
    position: "WR",
    season: 2026,
    asOfWeek: 4,
    asOfAt: "2026-10-01T12:00:00.000Z",
    windowStartWeek: 5,
    windowEndWeek: 8,
    strategy: "contextual",
    weeks: [5, 6, 7, 8].map((week) => ({
      season: 2026,
      week,
      scheduled: week !== 6,
      bye: week === 6,
      contextualComponents: { receptions: 6, receiving_yards: 80, receiving_touchdowns: 0.4 },
      recencyComponents: { receptions: 5, receiving_yards: 70, receiving_touchdowns: 0.3 },
      componentElasticities: {
        receptions: { role: 1, production: 1 },
        receiving_yards: { role: 1, production: 1 },
        receiving_touchdowns: { role: 0.7, production: 1.2 },
      },
    })),
    availability: {
      state: "active",
      newAbsenceProbability: 0.1,
      recoveryProbability: 0.25,
      reserveRecoveryProbability: 0.1,
      limitedRoleMultiplier: 0.8,
      returnRoleMultiplier: 0.82,
    },
    role: {
      currentMultiplier: 1,
      persistence: 0.82,
      innovationVolatility: 0.1,
      weeklyProductionVolatility: 0.3,
      centerVolatility: 0.15,
      minimumMultiplier: 0.2,
      maximumMultiplier: 3,
    },
    inputChecksum: "a".repeat(64),
    weeklyModelVersion: "weekly-test",
    seed: "football-only",
    scenarioCount: 256,
    ...overrides,
  };
}

const profiles: readonly ProjectionScoringProfile[] = [0, 0.5, 1].map((points) => ({
  id: `reception-${points}`,
  rules: [
    { statId: "receptions", points },
    { statId: "receiving_yards", points: 0.1 },
    { statId: "receiving_touchdowns", points: 6 },
    // A rule for another position is a known zero, rather than a missing WR input.
    { statId: "passing_interceptions", points: -2 },
  ],
}));

describe("reusable ROS joint football outcomes", () => {
  it("does not turn a bye's zero vocabulary into evidence for missing touchdown distances", () => {
    const football = input();
    const withByeZeros = {
      ...football,
      weeks: football.weeks.map((week) =>
        week.bye
          ? {
              ...week,
              contextualComponents: {
                ...week.contextualComponents,
                receiving_touchdowns_40_plus: 0,
                receiving_touchdowns_50_plus: 0,
              },
              recencyComponents: {
                ...week.recencyComponents,
                receiving_touchdowns_40_plus: 0,
                receiving_touchdowns_50_plus: 0,
              },
              componentElasticities: {
                ...week.componentElasticities,
                receiving_touchdowns_40_plus: { role: 1, production: 1 },
                receiving_touchdowns_50_plus: { role: 1, production: 1 },
              },
            }
          : week,
      ),
    };
    const ensemble = simulateFirstPartyRosOutcomes(withByeZeros);
    expect(ensemble.columns).not.toHaveProperty("receiving_touchdowns_40_plus");
    expect(ensemble.columns).not.toHaveProperty("receiving_touchdowns_50_plus");
    const bonusProfile = {
      id: "long-td",
      rules: [...profiles[0]!.rules, { statId: "receiving_touchdowns_40_plus", points: 2 }],
    };
    expect(() => scoreFirstPartyRosOutcomes(ensemble, bonusProfile)).toThrow(
      /lack scored component receiving_touchdowns_40_plus/,
    );
    expect(() =>
      projectFirstPartyRestOfSeason({ ...withByeZeros, scoringProfile: bonusProfile }),
    ).toThrow(/evidence for every scheduled week/);
    expect(() =>
      projectFirstPartyRestOfSeasonProfiles(withByeZeros, [profiles[0]!, bonusProfile]),
    ).toThrow(/evidence for every scheduled week/);
  });

  it("rejects a partial season of touchdown-distance evidence before caching an ensemble", () => {
    const football = input();
    expect(() =>
      simulateFirstPartyRosOutcomes({
        ...football,
        weeks: football.weeks.map((week) =>
          week.week === 5
            ? {
                ...week,
                contextualComponents: {
                  ...week.contextualComponents,
                  receiving_touchdowns_40_plus: 0.1,
                  receiving_touchdowns_50_plus: 0.05,
                },
                recencyComponents: {
                  ...week.recencyComponents,
                  receiving_touchdowns_40_plus: 0.1,
                  receiving_touchdowns_50_plus: 0.05,
                },
                componentElasticities: {
                  ...week.componentElasticities,
                  receiving_touchdowns_40_plus: { role: 1, production: 1 },
                  receiving_touchdowns_50_plus: { role: 1, production: 1 },
                },
              }
            : week,
        ),
      }),
    ).toThrow(/evidence for every scheduled week/);
  });

  it("reproduces separately scored simulations from one unchanged ensemble", () => {
    const football = input();
    const ensemble = simulateFirstPartyRosOutcomes(football);
    const originalReceptions = ensemble.columns.receptions!.slice();
    for (const scoringProfile of profiles) {
      const expected = projectFirstPartyRestOfSeason({ ...football, scoringProfile });
      const scored = scoreFirstPartyRosOutcomes(ensemble, scoringProfile);
      for (const metric of [
        "meanPoints",
        "standardDeviation",
        "p15Points",
        "p50Points",
        "p85Points",
      ] as const) {
        // Sum-stat-then-score changes only floating-point addition order relative to scoring
        // each week first. It does not change football paths, rankings or distribution semantics.
        expect(scored[metric]).toBeCloseTo(expected[metric], 10);
      }
      expect(scored.expectedGames).toBe(expected.expectedGames);
    }
    expect(ensemble.columns.receptions).toEqual(originalReceptions);
    expect(ensemble.metadata.provenance).not.toHaveProperty("scoringProfileKey");
    expect(ensemble.games.some((games) => games < 3)).toBe(true);
    expect(Math.max(...ensemble.games)).toBe(3);
  });

  it("preserves covariance and negative scoring rather than combining marginal quantiles", () => {
    const ensemble = simulateFirstPartyRosOutcomes(input());
    const scored = scoreFirstPartyRosOutcomes(ensemble, {
      id: "offsetting-correlated-stats",
      rules: [
        { statId: "receiving_yards", points: 0.075 },
        { statId: "receptions", points: -1 },
      ],
    });
    expect(scored.meanPoints).toBeCloseTo(0, 12);
    expect(scored.standardDeviation).toBeCloseTo(0, 12);
    expect(scored.p15Points).toBeCloseTo(0, 12);
    expect(scored.p85Points).toBeCloseTo(0, 12);
  });

  it("uses the identical release prefix of a larger reference ensemble", () => {
    const football = input();
    const ensemble = simulateFirstPartyRosOutcomes(football);
    const scored = scoreFirstPartyRosOutcomes(ensemble, profiles[2]!, 128);
    const direct = projectFirstPartyRestOfSeason({
      ...football,
      scoringProfile: profiles[2]!,
      scenarioCount: 128,
    });
    expect(scored.meanPoints).toBeCloseTo(direct.meanPoints, 10);
    expect(scored.p15Points).toBeCloseTo(direct.p15Points, 10);
    expect(scored.p85Points).toBeCloseTo(direct.p85Points, 10);
    expect(scored.expectedGames).toBe(direct.expectedGames);
    expect(scored.scenarioCount).toBe(128);
  });

  it("retains zero columns and games for an unavailable player with no recovery", () => {
    const football = input();
    const ensemble = simulateFirstPartyRosOutcomes({
      ...football,
      availability: { ...football.availability, state: "inactive", recoveryProbability: 0 },
    });
    expect(scoreFirstPartyRosOutcomes(ensemble, profiles[2]!)).toMatchObject({
      expectedGames: 0,
      meanPoints: 0,
      standardDeviation: 0,
      p15Points: 0,
      p85Points: 0,
    });
  });

  it("rejects weekly thresholds applied to totals and unknown or missing priced components", () => {
    const ensemble = simulateFirstPartyRosOutcomes(input());
    expect(() =>
      scoreFirstPartyRosOutcomes(ensemble, {
        id: "unsafe-season-threshold",
        rules: [{ statId: "receiving_yards", points: 0.1, bonuses: [{ atLeast: 100, points: 3 }] }],
      }),
    ).toThrow("Weekly threshold");
    expect(() =>
      scoreFirstPartyRosOutcomes(ensemble, {
        id: "unknown",
        rules: [{ statId: "invented_stat", points: 1 }],
      }),
    ).toThrow("Unknown scoring component");
    expect(() =>
      scoreFirstPartyRosOutcomes(ensemble, {
        id: "missing",
        rules: [{ statId: "fumbles_lost", points: -2 }],
      }),
    ).toThrow("lack scored component");
  });

  it("fails closed on damaged vectors, unsupported prefixes and stale identities", () => {
    const ensemble = simulateFirstPartyRosOutcomes(input());
    expect(() => scoreFirstPartyRosOutcomes(ensemble, profiles[0]!, 129)).toThrow("scenario count");
    expect(() => scoreFirstPartyRosOutcomes(ensemble, profiles[0]!, 512)).toThrow("scenario count");
    expect(() =>
      scoreFirstPartyRosOutcomes({ ...ensemble, games: new Uint8Array(128) }, profiles[0]!),
    ).toThrow("scenario count");
    expect(() =>
      scoreFirstPartyRosOutcomes(
        {
          ...ensemble,
          columns: { ...ensemble.columns, receptions: new Float64Array(10) },
        },
        profiles[0]!,
      ),
    ).toThrow("component column");
    ensemble.columns.receptions![255] = Number.NaN;
    expect(() => scoreFirstPartyRosOutcomes(ensemble, profiles[0]!, 128)).toThrow("Non-finite");
  });
});

describe("streamed live scoring profiles", () => {
  it("preserves every single-profile aggregate, weekly interval, component and diagnostic exactly", () => {
    const bonus: ProjectionScoringProfile = {
      id: "weekly-bonuses-and-negative-points",
      rules: [
        { statId: "receiving_yards", points: -0.05, bonuses: [{ atLeast: 70, points: 4 }] },
        { statId: "receptions", points: 0.5, bonuses: [{ atLeast: 0, points: 1 }] },
      ],
    };
    for (const availability of [
      input().availability,
      { ...input().availability, state: "reserve" as const },
    ]) {
      const football = input({ availability });
      const requested = [...profiles, bonus];
      for (const order of [requested, [...requested].reverse()]) {
        const shared = projectFirstPartyRestOfSeasonProfiles(football, order);
        for (const scoringProfile of requested) {
          const direct = projectFirstPartyRestOfSeason({ ...football, scoringProfile });
          expect(shared.get(direct.provenance.scoringProfileKey)).toEqual(direct);
        }
      }
    }
  });
});
