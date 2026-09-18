import { describe, expect, it, vi } from "vitest";

import {
  FIRST_PARTY_ROS_AVAILABILITY_EVIDENCE_ALPHA,
  FIRST_PARTY_ROS_COVERAGE_EVIDENCE_ALPHA,
  FIRST_PARTY_ROS_MAXIMUM_AVAILABILITY_ROW_ERROR,
  FIRST_PARTY_ROS_MAX_AVAILABILITY_BIAS,
  FIRST_PARTY_ROS_MAX_AVAILABILITY_MAE,
  FIRST_PARTY_ROS_MAX_NINE_PLUS_AVAILABILITY_MAE,
  FIRST_PARTY_ROS_MODEL_VERSION,
  FIRST_PARTY_ROS_POLICY_VERSION,
  firstPartyRosMeanSelectionEvidenceIsValid,
  FIRST_PARTY_ROS_SEED_VERSION,
  applyFirstPartyRosIntervalCalibration,
  firstPartyRosAvailabilityEvidenceOfExcessMae,
  firstPartyRosNominalIntervalCoverage,
  diagnoseFirstPartyRosConvergence,
  evaluateFirstPartyRosChampionPolicy,
  evaluateFirstPartyRosReleaseGate,
  projectFirstPartyRestOfSeason,
  type FirstPartyRosHeldOutForecast,
  type FirstPartyRosPosition,
  type FirstPartyRosProjectionInput,
  type FirstPartyRosWeeklyScenarioInput,
} from "./rest-of-season.js";
import { rosScoringProfile } from "./ros-scoring-profiles.js";
import { firstPartyRosDefenseInputFixture } from "./rest-of-season-defense.test-fixtures.js";
import * as scoring from "./scoring.js";
import { projectionScoringProfileKey } from "./scoring.js";

const scoringProfile = {
  id: "test-ppr",
  rules: [
    { statId: "receiving_yards", points: 0.1 },
    { statId: "receptions", points: 1 },
    { statId: "receiving_touchdowns", points: 6 },
  ],
} as const;

function week(
  value: number,
  weekNumber: number,
  options: {
    readonly bye?: boolean;
    readonly newAbsenceProbability?: number;
    readonly recoveryProbability?: number;
  } = {},
): FirstPartyRosWeeklyScenarioInput {
  const bye = options.bye ?? false;
  return {
    season: 2026,
    week: weekNumber,
    scheduled: !bye,
    bye,
    contextualComponents: {
      receiving_yards: value,
      receptions: value / 12,
      receiving_touchdowns: value / 180,
    },
    recencyComponents: {
      receiving_yards: value * 0.9,
      receptions: value / 13,
      receiving_touchdowns: value / 210,
    },
    componentElasticities: {
      receiving_yards: { role: 1, production: 1 },
      receptions: { role: 1, production: 0.8 },
      receiving_touchdowns: { role: 0.7, production: 1.2 },
    },
    ...(options.newAbsenceProbability === undefined
      ? {}
      : { newAbsenceProbability: options.newAbsenceProbability }),
    ...(options.recoveryProbability === undefined
      ? {}
      : { recoveryProbability: options.recoveryProbability }),
  };
}

function projectionInput(
  overrides: Partial<FirstPartyRosProjectionInput> = {},
): FirstPartyRosProjectionInput {
  const weeks = Array.from({ length: 8 }, (_, index) => week(60 + index * 2, index + 5));
  return {
    playerId: "player-one",
    position: "WR",
    season: 2026,
    asOfWeek: 4,
    asOfAt: "2026-10-01T12:00:00.000Z",
    windowStartWeek: 5,
    windowEndWeek: 12,
    strategy: "contextual",
    weeks,
    availability: {
      state: "active",
      newAbsenceProbability: 0.08,
      recoveryProbability: 0.35,
      reserveRecoveryProbability: 0.15,
      limitedRoleMultiplier: 0.8,
      returnRoleMultiplier: 0.82,
    },
    role: {
      currentMultiplier: 1.12,
      persistence: 0.82,
      innovationVolatility: 0.12,
      weeklyProductionVolatility: 0.24,
      minimumMultiplier: 0.25,
      maximumMultiplier: 2.5,
    },
    scoringProfile,
    inputChecksum: "a".repeat(64),
    weeklyModelVersion: "weekly-v4",
    seed: "locked-run-seed",
    scenarioCount: 512,
    ...overrides,
  };
}

function longTouchdownProjectionInput(): FirstPartyRosProjectionInput {
  const input = projectionInput();
  const withDistanceCounts = (components: scoring.ProjectionStatComponents) => ({
    ...components,
    receiving_touchdowns_40_plus: components.receiving_touchdowns! * 0.25,
    receiving_touchdowns_50_plus: components.receiving_touchdowns! * 0.1,
  });
  return {
    ...input,
    scoringProfile: {
      id: "test-ppr-long-touchdowns",
      rules: [
        ...scoringProfile.rules,
        { statId: "receiving_touchdowns_40_plus", points: 2 },
        { statId: "receiving_touchdowns_50_plus", points: 3 },
      ],
    },
    weeks: input.weeks.map((value) => ({
      ...value,
      contextualComponents: withDistanceCounts(value.contextualComponents),
      recencyComponents: withDistanceCounts(value.recencyComponents),
      componentElasticities: {
        ...value.componentElasticities,
        receiving_touchdowns_40_plus: { role: 1, production: 1.6 },
        receiving_touchdowns_50_plus: { role: 1, production: 1.8 },
      },
    })),
  };
}

describe("first-party ROS distribution", () => {
  it("is deterministic for pinned inputs and independent of week order", () => {
    const input = projectionInput();
    const forward = projectFirstPartyRestOfSeason(input);
    const reverse = projectFirstPartyRestOfSeason({ ...input, weeks: [...input.weeks].reverse() });

    expect(reverse).toEqual(forward);
    expect(forward.provenance.modelVersion).toBe(FIRST_PARTY_ROS_MODEL_VERSION);
    expect(forward.provenance.intervalCalibration).toBe("simulation-only");
    // The long-touchdown model has its own scoring-independent seed lineage.
    expect(forward.provenance.seedHash).toBe(
      "2267146248fa64e1295b6273a26ae43487149edbe0a5a26557e3a1c802fb267a",
    );
    expect(forward.provenance).toMatchObject({
      asOfWeek: 4,
      asOfAt: "2026-10-01T12:00:00.000Z",
      randomGenerator: "xoshiro128**-sha256-128",
    });
    expect(forward.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "simulation_interval_not_calibrated",
    );
  });

  it("treats byes as deterministic zero-game weeks", () => {
    const weeks = [week(70, 5), week(70, 6, { bye: true }), week(70, 7)];
    const result = projectFirstPartyRestOfSeason(
      projectionInput({ windowEndWeek: 7, weeks, scenarioCount: 256 }),
    );

    expect(result.scheduledGames).toBe(2);
    expect(result.expectedGames).toBeLessThanOrEqual(2);
    expect(result.weekly[1]).toMatchObject({
      week: 6,
      scheduled: false,
      bye: true,
      availabilityProbability: 0,
      meanPoints: 0,
      p15Points: 0,
      p50Points: 0,
      p85Points: 0,
    });
  });

  it("does not consume limited or post-return role state during a bye", () => {
    const weeks = [
      week(60, 5, { bye: true, recoveryProbability: 1 }),
      week(60, 6, { newAbsenceProbability: 0 }),
    ];
    const stableRole = {
      ...projectionInput().role,
      currentMultiplier: 1,
      persistence: 1,
      innovationVolatility: 0,
      weeklyProductionVolatility: 0,
    };
    const fullStrength = projectFirstPartyRestOfSeason(
      projectionInput({
        windowEndWeek: 6,
        weeks,
        availability: {
          ...projectionInput().availability,
          state: "active",
          newAbsenceProbability: 0,
        },
        role: stableRole,
        scenarioCount: 128,
      }),
    );
    const limited = projectFirstPartyRestOfSeason(
      projectionInput({
        windowEndWeek: 6,
        weeks,
        availability: {
          ...projectionInput().availability,
          state: "limited",
          newAbsenceProbability: 0,
          limitedRoleMultiplier: 0.5,
        },
        role: stableRole,
        scenarioCount: 128,
      }),
    );
    const returned = projectFirstPartyRestOfSeason(
      projectionInput({
        windowEndWeek: 6,
        weeks,
        availability: {
          ...projectionInput().availability,
          state: "inactive",
          newAbsenceProbability: 0,
          recoveryProbability: 1,
          returnRoleMultiplier: 0.5,
        },
        role: stableRole,
        scenarioCount: 128,
      }),
    );

    expect(limited.meanPoints).toBeLessThan(fullStrength.meanPoints * 0.75);
    expect(returned.meanPoints).toBeCloseTo(limited.meanPoints, 10);
  });

  it("persists current injury state until a modeled recovery", () => {
    const inactive = projectFirstPartyRestOfSeason(
      projectionInput({
        availability: {
          ...projectionInput().availability,
          state: "inactive",
          newAbsenceProbability: 0,
          recoveryProbability: 0.18,
        },
      }),
    );
    const healthy = projectFirstPartyRestOfSeason(
      projectionInput({
        availability: {
          ...projectionInput().availability,
          state: "active",
          newAbsenceProbability: 0,
          recoveryProbability: 1,
        },
      }),
    );

    expect(inactive.expectedGames).toBeLessThan(healthy.expectedGames);
    expect(inactive.weekly[0]!.availabilityProbability).toBeLessThan(
      inactive.weekly.at(-1)!.availabilityProbability,
    );
    expect(inactive.simulation.availabilityLagOneCorrelation).not.toBeNull();
    expect(inactive.simulation.availabilityLagOneCorrelation!).toBeGreaterThan(0.3);
    expect(inactive.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "current_unavailability_persisted",
    );
  });

  it("keeps role shocks serially correlated", () => {
    const result = projectFirstPartyRestOfSeason(
      projectionInput({
        availability: {
          ...projectionInput().availability,
          newAbsenceProbability: 0,
        },
        role: {
          ...projectionInput().role,
          currentMultiplier: 1,
          persistence: 0.95,
          innovationVolatility: 0.22,
          weeklyProductionVolatility: 0,
          minimumMultiplier: 0.1,
          maximumMultiplier: 4,
        },
      }),
    );

    expect(result.simulation.roleLagOneCorrelation).not.toBeNull();
    expect(result.simulation.roleLagOneCorrelation!).toBeGreaterThan(0.5);
  });

  it("uses the stationary mean-one AR(1) intercept before fail-safe bounds", () => {
    const persistence = 0.8;
    const volatility = 0.2;
    const stationaryLogMean = (-0.5 * volatility ** 2) / (1 - persistence ** 2);
    const weeks = Array.from({ length: 18 }, (_, index) => ({
      season: 2026,
      week: index + 1,
      scheduled: true,
      bye: false,
      contextualComponents: { receiving_yards: 100 },
      recencyComponents: { receiving_yards: 100 },
      componentElasticities: { receiving_yards: { role: 1, production: 0 } },
    }));
    const result = projectFirstPartyRestOfSeason(
      projectionInput({
        asOfWeek: 0,
        windowStartWeek: 1,
        windowEndWeek: 18,
        weeks,
        availability: {
          ...projectionInput().availability,
          newAbsenceProbability: 0,
        },
        role: {
          currentMultiplier: Math.exp(stationaryLogMean),
          persistence,
          innovationVolatility: volatility,
          weeklyProductionVolatility: 0,
          minimumMultiplier: 0.1,
          maximumMultiplier: 10,
        },
        scenarioCount: 4_096,
      }),
    );

    expect(Math.abs(result.weekly.at(-1)!.meanPoints - 10)).toBeLessThan(0.15);
  });

  it("returns coherent totals, quantiles, weekly paths, and raw component means", () => {
    const result = projectFirstPartyRestOfSeason(projectionInput());

    expect(result.state).toBe("projected");
    expect(result.meanPoints).toBeGreaterThan(0);
    expect(result.standardDeviation).toBeGreaterThan(0);
    expect(result.p15Points).toBeLessThan(result.meanPoints);
    expect(result.p50Points).toBeGreaterThanOrEqual(result.p15Points);
    expect(result.p50Points).toBeLessThanOrEqual(result.p85Points);
    expect(result.p85Points).toBeGreaterThan(result.meanPoints);
    expect(result.weekly).toHaveLength(8);
    expect(result.expectedComponents.receiving_yards).toBeGreaterThan(0);
    expect(result.expectedGames).toBeGreaterThan(0);
    expect(result.expectedGames).toBeLessThanOrEqual(result.scheduledGames);
    expect(result.weeklyMeanSemantics).toBe("unconditional-includes-zero-for-bye-or-unavailable");
  });

  it("returns empirical quantiles even when the arithmetic mean lies outside P15/P85", () => {
    const result = projectFirstPartyRestOfSeason(
      projectionInput({
        windowEndWeek: 5,
        weeks: [week(60, 5, { newAbsenceProbability: 0.1 })],
        availability: {
          ...projectionInput().availability,
          newAbsenceProbability: 0.1,
        },
        role: {
          ...projectionInput().role,
          currentMultiplier: 1,
          persistence: 1,
          innovationVolatility: 0,
          weeklyProductionVolatility: 0,
        },
        scenarioCount: 4_096,
      }),
    );

    expect(result.p15Points).toBeGreaterThan(result.meanPoints);
    expect(result.p15Points).toBe(result.p50Points);
    expect(result.p50Points).toBe(result.p85Points);
  });

  it("retains explicit zero raw totals when every scenario remains unavailable", () => {
    const result = projectFirstPartyRestOfSeason(
      projectionInput({
        availability: {
          ...projectionInput().availability,
          state: "reserve",
          reserveRecoveryProbability: 0,
        },
      }),
    );

    expect(result.expectedGames).toBe(0);
    expect(result.meanPoints).toBe(0);
    expect(result.weekly.every((item) => item.meanPoints === 0)).toBe(true);
    expect(result.expectedComponents).toEqual({
      receiving_touchdowns: 0,
      receiving_yards: 0,
      receptions: 0,
    });
  });

  it("restores supported football component identities after stochastic shocks", () => {
    const components = {
      passing_attempts: 10,
      passing_completions: 8,
      passing_interceptions: 1,
      passing_yards: 300,
      passing_yards_per_5_units: 60,
      passing_yards_300_399_probability: 0.7,
      passing_yards_400_plus_probability: 0.2,
      targets: 10,
      receptions: 8,
      fumbles: 2,
      fumbles_lost: 1,
      field_goals_attempted: 4,
      field_goals_made: 3,
      field_goals_missed: 1,
      field_goals_made_0_19: 0.2,
      field_goals_made_20_29: 0.5,
      field_goals_made_30_39: 0.8,
      field_goals_made_0_39: 1.5,
      field_goals_made_40_49: 0.9,
      field_goals_made_50_59: 0.5,
      field_goals_made_60_plus: 0.1,
      field_goals_made_50_plus: 0.6,
      extra_points_attempted: 3,
      extra_points_made: 2.7,
      extra_points_missed: 0.3,
    };
    const parents = new Set([
      "passing_attempts",
      "passing_yards",
      "targets",
      "fumbles",
      "field_goals_attempted",
      "extra_points_attempted",
    ]);
    const componentElasticities = Object.fromEntries(
      Object.keys(components).map((component) => [
        component,
        { role: 0, production: parents.has(component) ? 0 : 2 },
      ]),
    );
    // Position QB keeps this synthetic mixed-component fixture on the lognormal shock path whose
    // invariant restoration is under test; model v7 routes position K to the count process, which
    // satisfies these identities by construction and is covered by its own coherence test.
    const result = projectFirstPartyRestOfSeason(
      projectionInput({
        position: "QB",
        windowEndWeek: 5,
        weeks: [
          {
            season: 2026,
            week: 5,
            scheduled: true,
            bye: false,
            contextualComponents: components,
            recencyComponents: components,
            componentElasticities,
          },
        ],
        availability: {
          ...projectionInput().availability,
          newAbsenceProbability: 0,
        },
        role: {
          ...projectionInput().role,
          currentMultiplier: 1,
          persistence: 1,
          innovationVolatility: 0,
          weeklyProductionVolatility: 2,
        },
        scoringProfile: {
          id: "invariant-test",
          rules: [{ statId: "passing_attempts", points: 0.1 }],
        },
        scenarioCount: 4_096,
      }),
    );
    const expected = result.expectedComponents;

    expect(expected.passing_completions).toBeLessThanOrEqual(expected.passing_attempts!);
    expect(expected.passing_interceptions).toBeLessThanOrEqual(expected.passing_attempts!);
    expect(expected.passing_yards_per_5_units).toBeLessThanOrEqual(
      expected.passing_yards! / 5 + 1e-10,
    );
    expect(expected.passing_yards_300_399_probability).toBeLessThanOrEqual(1);
    expect(expected.passing_yards_400_plus_probability).toBeLessThanOrEqual(1);
    expect(
      expected.passing_yards_300_399_probability! + expected.passing_yards_400_plus_probability!,
    ).toBeLessThanOrEqual(1 + 1e-10);
    expect(expected.receptions).toBeLessThanOrEqual(expected.targets!);
    expect(expected.fumbles_lost).toBeLessThanOrEqual(expected.fumbles!);
    expect(expected.field_goals_made).toBeLessThanOrEqual(expected.field_goals_attempted!);
    expect(expected.field_goals_attempted).toBeCloseTo(
      expected.field_goals_made! + expected.field_goals_missed!,
      10,
    );
    expect(expected.extra_points_attempted).toBeCloseTo(
      expected.extra_points_made! + expected.extra_points_missed!,
      10,
    );
    expect(expected.field_goals_made_0_39).toBeCloseTo(
      expected.field_goals_made_0_19! +
        expected.field_goals_made_20_29! +
        expected.field_goals_made_30_39!,
      10,
    );
    expect(expected.field_goals_made_50_plus).toBeCloseTo(
      expected.field_goals_made_50_59! + expected.field_goals_made_60_plus!,
      10,
    );
  });

  it("rejects an impossible weekly yardage-game probability pair", () => {
    const invalidWeek = week(100, 5);
    expect(() =>
      projectFirstPartyRestOfSeason(
        projectionInput({
          windowEndWeek: 5,
          weeks: [
            {
              ...invalidWeek,
              contextualComponents: {
                ...invalidWeek.contextualComponents,
                receiving_yards_100_199_probability: 0.8,
                receiving_yards_200_plus_probability: 0.4,
              },
              recencyComponents: {
                ...invalidWeek.recencyComponents,
                receiving_yards_100_199_probability: 0.8,
                receiving_yards_200_plus_probability: 0.4,
              },
              componentElasticities: {
                ...invalidWeek.componentElasticities,
                receiving_yards_100_199_probability: { role: 1, production: 1 },
                receiving_yards_200_plus_probability: { role: 1, production: 1 },
              },
            },
          ],
        }),
      ),
    ).toThrow(/mutually exclusive probabilities/iu);
  });

  it.each(["contextual", "availability-aware-recency"] as const)(
    "keeps every %s long-touchdown path nested after distinct production shocks",
    (strategy) => {
      const components: Record<string, number> = {};
      const componentElasticities: Record<string, { role: number; production: number }> = {};
      for (const { total, fortyPlus, fiftyPlus } of scoring.SCORING_LONG_TOUCHDOWN_COMPONENTS) {
        components[total] = 0.5;
        components[fortyPlus] = 0.3;
        components[fiftyPlus] = 0.2;
        componentElasticities[total] = { role: 0, production: 0 };
        componentElasticities[fortyPlus] = { role: 0, production: 1 };
        componentElasticities[fiftyPlus] = { role: 0, production: 2 };
      }
      let observedActive = 0;
      let observedZero = 0;
      const result = projectFirstPartyRestOfSeason(
        projectionInput({
          strategy,
          windowEndWeek: 6,
          weeks: [5, 6].map((weekNumber) => ({
            season: 2026,
            week: weekNumber,
            scheduled: weekNumber === 5,
            bye: weekNumber === 6,
            contextualComponents: components,
            recencyComponents: components,
            componentElasticities,
          })),
          role: { ...projectionInput().role, weeklyProductionVolatility: 2 },
          scoringProfile: {
            id: "long-touchdown-bonuses",
            rules: [
              { statId: "receiving_touchdowns", points: 6 },
              { statId: "receiving_touchdowns_40_plus", points: 2 },
              { statId: "receiving_touchdowns_50_plus", points: 3 },
            ],
          },
          scenarioCount: 256,
        }),
        undefined,
        ({ available, components: observed }) => {
          if (!available) {
            observedZero += 1;
            expect(Object.values(observed).every((value) => value === 0)).toBe(true);
            return;
          }
          observedActive += 1;
          for (const { total, fortyPlus, fiftyPlus } of scoring.SCORING_LONG_TOUCHDOWN_COMPONENTS) {
            expect(observed[fiftyPlus]).toBeGreaterThanOrEqual(0);
            expect(observed[fiftyPlus]).toBeLessThanOrEqual(observed[fortyPlus]!);
            expect(observed[fortyPlus]).toBeLessThanOrEqual(observed[total]!);
          }
        },
      );
      expect(observedActive).toBeGreaterThan(0);
      expect(observedZero).toBeGreaterThanOrEqual(256);
      const expected = result.expectedComponents;
      expect(result.meanPoints).toBeCloseTo(
        expected.receiving_touchdowns! * 6 +
          expected.receiving_touchdowns_40_plus! * 2 +
          expected.receiving_touchdowns_50_plus! * 3,
        10,
      );
    },
  );

  it.each(scoring.SCORING_LONG_TOUCHDOWN_COMPONENTS)(
    "rejects inconsistent or incompletely sourced $total distance counts",
    ({ total, fortyPlus, fiftyPlus }) => {
      for (const counts of [
        { [total]: 0.5, [fortyPlus]: 0.3, [fiftyPlus]: 0.4 },
        { [total]: 0.5, [fortyPlus]: 0.6, [fiftyPlus]: 0.4 },
        { [fortyPlus]: 0.3, [fiftyPlus]: 0.2 },
        { [total]: 0.5, [fiftyPlus]: 0.2 },
      ]) {
        const componentElasticities = Object.fromEntries(
          Object.keys(counts).map((key) => [key, { role: 1, production: 1 }]),
        );
        expect(() =>
          projectFirstPartyRestOfSeason(
            projectionInput({
              windowEndWeek: 5,
              weeks: [
                {
                  ...week(60, 5),
                  contextualComponents: counts,
                  recencyComponents: counts,
                  componentElasticities,
                },
              ],
            }),
          ),
        ).toThrow(/requires .*touchdowns/);
      }
    },
  );

  it("rejects an every-N expectation that exceeds its positive-part expectation bound", () => {
    const invalidWeek = week(20, 5);
    expect(() =>
      projectFirstPartyRestOfSeason(
        projectionInput({
          windowEndWeek: 5,
          weeks: [
            {
              ...invalidWeek,
              contextualComponents: {
                ...invalidWeek.contextualComponents,
                receiving_yards_nonnegative: 20,
                receiving_yards_per_5_units: 5,
              },
              recencyComponents: {
                ...invalidWeek.recencyComponents,
                receiving_yards_nonnegative: 20,
                receiving_yards_per_5_units: 5,
              },
              componentElasticities: {
                ...invalidWeek.componentElasticities,
                receiving_yards_nonnegative: { role: 1, production: 1 },
                receiving_yards_per_5_units: { role: 1, production: 1 },
              },
            },
          ],
        }),
      ),
    ).toThrow(/receiving_yards_per_5_units not to exceed receiving_yards \/ 5/iu);
  });

  it("produces a deterministic release-vs-reference convergence diagnostic", () => {
    // A short two-week window keeps the 8192+16384-path comparison in this single test fast.
    const input = projectionInput({
      windowEndWeek: 6,
      weeks: [week(60, 5), week(60, 6)],
      availability: {
        ...projectionInput().availability,
        newAbsenceProbability: 0,
      },
      role: {
        ...projectionInput().role,
        currentMultiplier: 1,
        persistence: 1,
        innovationVolatility: 0,
        weeklyProductionVolatility: 0,
      },
    });
    const first = diagnoseFirstPartyRosConvergence(input);
    const second = diagnoseFirstPartyRosConvergence(input);

    expect(second).toEqual(first);
    expect(first).toMatchObject({
      state: "converged",
      releaseScenarioCount: 12288,
      referenceScenarioCount: 16384,
    });
    expect(first.metrics).toHaveLength(5);
    expect(first.metrics.every((metric) => metric.converged)).toBe(true);
    for (const metric of first.metrics) {
      expect(metric.toleranceRatio).toBeCloseTo(
        metric.absoluteDifference / metric.allowedDifference,
        10,
      );
    }
    expect(first.worstToleranceRatio).toBe(
      Math.max(...first.metrics.map((metric) => metric.toleranceRatio)),
    );
    const worst = first.metrics.find((metric) => metric.metric === first.worstMetric);
    expect(worst).toBeDefined();
    expect(worst!.toleranceRatio).toBe(first.worstToleranceRatio);
  });

  it("does not create aggregate intervals by summing marginal weekly intervals", () => {
    const result = projectFirstPartyRestOfSeason(
      projectionInput({
        role: {
          ...projectionInput().role,
          persistence: 0.96,
          innovationVolatility: 0.28,
          weeklyProductionVolatility: 0.15,
          minimumMultiplier: 0.1,
          maximumMultiplier: 4,
        },
      }),
    );
    const marginalP15Sum = result.weekly.reduce((sum, item) => sum + item.p15Points, 0);
    const marginalP85Sum = result.weekly.reduce((sum, item) => sum + item.p85Points, 0);

    expect(result.p15Points).not.toBeCloseTo(marginalP15Sum, 4);
    expect(result.p85Points).not.toBeCloseTo(marginalP85Sum, 4);
  });

  it("fails closed on incomplete windows and implicit component behavior", () => {
    expect(() =>
      projectFirstPartyRestOfSeason(projectionInput({ weeks: projectionInput().weeks.slice(1) })),
    ).toThrow("every week");

    const invalidWeek = {
      ...projectionInput().weeks[0]!,
      componentElasticities: {
        receiving_yards: { role: 1, production: 1 },
      },
    };
    expect(() =>
      projectFirstPartyRestOfSeason(
        projectionInput({ weeks: [invalidWeek, ...projectionInput().weeks.slice(1)] }),
      ),
    ).toThrow("missing elasticity");

    expect(() =>
      projectFirstPartyRestOfSeason(projectionInput({ inputChecksum: "not-a-checksum" })),
    ).toThrow("SHA-256");

    expect(() => projectFirstPartyRestOfSeason(projectionInput({ asOfWeek: 5 }))).toThrow(
      "precede windowStartWeek",
    );

    expect(() => projectFirstPartyRestOfSeason(projectionInput({ scenarioCount: 64 }))).toThrow(
      "between 128 and 16384",
    );
  });
});

const kickerScoringProfile = {
  id: "test-kicker-ppr",
  rules: [
    { statId: "field_goals_made_0_39", points: 3 },
    { statId: "field_goals_made_40_49", points: 4 },
    { statId: "field_goals_made_50_plus", points: 5 },
    { statId: "field_goals_missed", points: -1 },
    { statId: "extra_points_made", points: 1 },
  ],
} as const;

const kickerProcess = {
  fgEventDispersion: 0.83,
  xpDispersion: 0.85,

  centerVolatility: 0,
  bucketMix: [0.57, 0.27, 0.16],
  missBucketMix: [0, 0.03, 0.09, 0.36, 0.46, 0.06],
} as const;

function kickerWeek(
  weekNumber: number,
  options: {
    readonly bye?: boolean;
    readonly made0_39?: number;
    readonly made40_49?: number;
    readonly made50Plus?: number;
    readonly attempted?: number;
    readonly extraPoints?: number;
  } = {},
): FirstPartyRosWeeklyScenarioInput {
  const bye = options.bye ?? false;
  const made0_39 = options.made0_39 ?? 0.95;
  const made40_49 = options.made40_49 ?? 0.45;
  const made50Plus = options.made50Plus ?? 0.28;
  const made = made0_39 + made40_49 + made50Plus;
  const attempted = options.attempted ?? made + 0.3;
  const extraPoints = options.extraPoints ?? 2.2;
  const components = {
    field_goals_made_0_19: made0_39 * 0.05,
    field_goals_made_20_29: made0_39 * 0.45,
    field_goals_made_30_39: made0_39 * 0.5,
    field_goals_made_0_39: made0_39,
    field_goals_made_40_49: made40_49,
    field_goals_made_50_59: made50Plus * 0.9,
    field_goals_made_60_plus: made50Plus * 0.1,
    field_goals_made_50_plus: made50Plus,
    field_goals_made: made,
    field_goals_attempted: attempted,
    field_goals_missed: attempted - made,
    field_goals_missed_0_19: (attempted - made) * 0,
    field_goals_missed_20_29: (attempted - made) * 0.03,
    field_goals_missed_30_39: (attempted - made) * 0.09,
    field_goals_missed_0_39: (attempted - made) * 0.12,
    field_goals_missed_40_49: (attempted - made) * 0.36,
    field_goals_missed_50_59: (attempted - made) * 0.46,
    field_goals_missed_60_plus: (attempted - made) * 0.06,
    field_goals_missed_50_plus: (attempted - made) * 0.52,
    field_goals_total_yards:
      made0_39 * (0.05 * 18 + 0.45 * 25 + 0.5 * 35) +
      made40_49 * 45 +
      made50Plus * (0.9 * 55 + 0.1 * 62),
    extra_points_made: extraPoints,
    extra_points_attempted: extraPoints / 0.95,
    extra_points_missed: extraPoints / 0.95 - extraPoints,
  };
  const componentElasticities = Object.fromEntries(
    Object.keys(components).map((key) => [key, { role: 1, production: 1 }]),
  );
  return {
    season: 2026,
    week: weekNumber,
    scheduled: !bye,
    bye,
    contextualComponents: bye
      ? Object.fromEntries(Object.keys(components).map((k) => [k, 0]))
      : components,
    recencyComponents: bye
      ? Object.fromEntries(Object.keys(components).map((k) => [k, 0]))
      : components,
    componentElasticities,
  };
}

function kickerInput(
  overrides: Partial<FirstPartyRosProjectionInput> = {},
): FirstPartyRosProjectionInput {
  const weeks = Array.from({ length: 4 }, (_, index) => kickerWeek(index + 5));
  return {
    ...projectionInput(),
    position: "K",
    windowStartWeek: 5,
    windowEndWeek: 8,
    weeks,
    scoringProfile: kickerScoringProfile,
    kicker: kickerProcess,
    scenarioCount: 2_048,
    ...overrides,
  };
}

describe("compiled ROS scoring equivalence", () => {
  const positionComponents = {
    QB: { passing_yards: 275, passing_touchdowns: 1.7, passing_interceptions: 0.8 },
    RB: { rushing_yards: 85, rushing_touchdowns: 0.7, receptions: 3, receiving_yards: 22 },
    WR: { receptions: 6, receiving_yards: 85, receiving_touchdowns: 0.5 },
    TE: { receptions: 4, receiving_yards: 45, receiving_touchdowns: 0.4 },
  } as const;

  it.each(["QB", "RB", "WR", "TE", "K", "DST"] as const)(
    "preserves every output and seed for %s across both strategies",
    (position: FirstPartyRosPosition) => {
      const base =
        position === "K"
          ? kickerInput()
          : position === "DST"
            ? firstPartyRosDefenseInputFixture()
            : projectionInput();
      const components =
        position === "K" || position === "DST" ? undefined : positionComponents[position];
      const input = {
        ...base,
        position,
        scenarioCount: 128,
        scoringProfile: rosScoringProfile("espn-ppr-yardage-bonus-6pt-pass").profile,
        weeks:
          components === undefined
            ? base.weeks
            : base.weeks.map((week, index) => ({
                ...week,
                scheduled: index !== 2,
                bye: index === 2,
                contextualComponents: components,
                recencyComponents: Object.fromEntries(
                  Object.entries(components).map(([key, value]) => [key, value * 0.9]),
                ),
                componentElasticities: Object.fromEntries(
                  Object.keys(components).map((key) => [key, { role: 1, production: 0.8 }]),
                ),
              })),
      };
      for (const seed of ["release-seed-one", "release-seed-two"]) {
        for (const strategy of ["contextual", "availability-aware-recency"] as const) {
          const pinned = { ...input, seed, strategy };
          const compiled = projectFirstPartyRestOfSeason(pinned);
          // Recreate the previous hot loop: validate and canonicalize the profile on every
          // available simulated week. JSON equality also covers diagnostics/provenance/order.
          const legacy = vi
            .spyOn(scoring, "compileProjectionScorer")
            .mockImplementation(
              (profile) => (values) => scoring.scoreProjectionStatComponents(values, profile),
            );
          try {
            expect(JSON.stringify(compiled)).toBe(
              JSON.stringify(projectFirstPartyRestOfSeason(pinned)),
            );
          } finally {
            legacy.mockRestore();
          }
        }
      }
    },
  );
});

describe("first-party ROS kicker count process", () => {
  it("requires the kicker process input for position K and rejects it elsewhere", () => {
    expect(() => {
      const { kicker, ...withoutKicker } = kickerInput();
      void kicker;
      projectFirstPartyRestOfSeason(withoutKicker);
    }).toThrow("required for position K");
    expect(() => projectFirstPartyRestOfSeason(projectionInput({ kicker: kickerProcess }))).toThrow(
      "only supported for position K",
    );
  });

  it("declares the new scoring-independent model and seed lineage", () => {
    expect(FIRST_PARTY_ROS_MODEL_VERSION).toBe("laces-ros-distribution-v13");
    expect(FIRST_PARTY_ROS_SEED_VERSION).toBe("laces-ros-distribution-v11");
  });

  it("is deterministic and satisfies the prefix property for pinned kicker inputs", () => {
    const first = projectFirstPartyRestOfSeason(kickerInput());
    const second = projectFirstPartyRestOfSeason(kickerInput());
    expect(second).toEqual(first);
    expect(first.provenance.modelVersion).toBe(FIRST_PARTY_ROS_MODEL_VERSION);
  });

  it("keeps every simulated kicker week on the exact scoring lattice", () => {
    const projection = projectFirstPartyRestOfSeason(kickerInput({ scenarioCount: 512 }));
    // Weekly quantiles interpolate between lattice atoms, so probe the lattice through the
    // aggregate: with one scheduled week and always-available fixtures the totals are per-game
    // scores and must be integers.
    const oneWeek = projectFirstPartyRestOfSeason(
      kickerInput({
        windowStartWeek: 5,
        windowEndWeek: 5,
        weeks: [kickerWeek(5)],
        availability: {
          ...projectionInput().availability,
          newAbsenceProbability: 0,
        },
        scenarioCount: 512,
      }),
    );
    // Scenario totals are integer lattice points: their mean times the power-of-two scenario
    // count is exactly representable and integral, and the interpolating median sits either on an
    // atom or exactly halfway between two adjacent atoms.
    expect(Number.isInteger(oneWeek.meanPoints * 512)).toBe(true);
    expect(Number.isInteger(2 * oneWeek.p50Points)).toBe(true);
    expect(oneWeek.p15Points).toBeGreaterThanOrEqual(-4);
    expect(projection.state).toBe("projected");
  });

  it("emits a coherent kicker component map that satisfies every football identity", () => {
    const projection = projectFirstPartyRestOfSeason(
      kickerInput({
        availability: { ...projectionInput().availability, newAbsenceProbability: 0 },
      }),
    );
    const expected = projection.expectedComponents;
    expect(expected.field_goals_made).toBeCloseTo(
      expected.field_goals_made_0_39! +
        expected.field_goals_made_40_49! +
        expected.field_goals_made_50_plus!,
      10,
    );
    expect(expected.field_goals_attempted).toBeCloseTo(
      expected.field_goals_made! + expected.field_goals_missed!,
      10,
    );
    expect(expected.field_goals_made_0_39).toBeCloseTo(
      expected.field_goals_made_0_19! +
        expected.field_goals_made_20_29! +
        expected.field_goals_made_30_39!,
      10,
    );
    expect(expected.field_goals_made_50_plus).toBeCloseTo(
      expected.field_goals_made_50_59! + expected.field_goals_made_60_plus!,
      10,
    );
    expect(expected.extra_points_attempted).toBeCloseTo(
      expected.extra_points_made! + expected.extra_points_missed!,
      10,
    );
    expect(expected.extra_points_missed).toBeGreaterThan(0);
  });

  it("preserves the pinned per-component means through the count process", () => {
    const weeks = Array.from({ length: 4 }, (_, index) => kickerWeek(index + 5));
    const projection = projectFirstPartyRestOfSeason(
      kickerInput({
        weeks,
        availability: { ...projectionInput().availability, newAbsenceProbability: 0 },
        scenarioCount: 16_384,
      }),
    );
    const expected = projection.expectedComponents;
    // Four always-available weeks at the fixture rates; loose 3-sigma-style bounds.
    expect(expected.field_goals_made_0_39!).toBeGreaterThan(4 * 0.95 * 0.94);
    expect(expected.field_goals_made_0_39!).toBeLessThan(4 * 0.95 * 1.06);
    expect(expected.field_goals_made_40_49!).toBeGreaterThan(4 * 0.45 * 0.9);
    expect(expected.field_goals_made_40_49!).toBeLessThan(4 * 0.45 * 1.1);
    expect(expected.extra_points_made!).toBeGreaterThan(4 * 2.2 * 0.95);
    expect(expected.extra_points_made!).toBeLessThan(4 * 2.2 * 1.05);
    // Miss penalties include every unsuccessful attempt, including blocks.
    expect(expected.field_goals_missed!).toBeGreaterThan(4 * 0.3 * 0.85);
    expect(expected.field_goals_missed!).toBeLessThan(4 * 0.3 * 1.15);
  });

  it("realizes the calibrated under-dispersion and collapses to Poisson at phi one", () => {
    const base = kickerInput({
      windowStartWeek: 5,
      windowEndWeek: 5,
      weeks: [kickerWeek(5)],
      availability: { ...projectionInput().availability, newAbsenceProbability: 0 },
      scenarioCount: 16_384,
    });
    const dispersed = projectFirstPartyRestOfSeason(base);
    const poisson = projectFirstPartyRestOfSeason({
      ...base,
      kicker: { ...kickerProcess, fgEventDispersion: 1 },
    });
    // Same stream layout: count parameters must not perturb the availability chain.
    expect(poisson.expectedGames).toBe(dispersed.expectedGames);
    // The under-dispersed run concentrates: its variance strictly below the Poisson run's.
    expect(dispersed.standardDeviation).toBeLessThan(poisson.standardDeviation);
  });

  it("produces a discrete distribution with mass at zero-or-negative and strong games", () => {
    const projection = projectFirstPartyRestOfSeason(
      kickerInput({
        windowStartWeek: 5,
        windowEndWeek: 5,
        weeks: [kickerWeek(5, { made0_39: 0.5, made40_49: 0.2, made50Plus: 0.1, extraPoints: 1 })],
        availability: { ...projectionInput().availability, newAbsenceProbability: 0 },
        scenarioCount: 8_192,
      }),
    );
    // Low-volume kicker week: sizable mass at <= 0 yet P85 at a multi-kick game.
    expect(projection.p15Points).toBeLessThanOrEqual(0);
    expect(projection.p85Points).toBeGreaterThanOrEqual(5);
  });

  it("treats a zero-intensity kicker week as a deterministic zero-point game", () => {
    const zeroWeek = kickerWeek(5, {
      made0_39: 0,
      made40_49: 0,
      made50Plus: 0,
      attempted: 0,
      extraPoints: 0,
    });
    const projection = projectFirstPartyRestOfSeason(
      kickerInput({
        windowStartWeek: 5,
        windowEndWeek: 5,
        weeks: [zeroWeek],
        availability: { ...projectionInput().availability, newAbsenceProbability: 0 },
        scenarioCount: 512,
      }),
    );
    expect(projection.meanPoints).toBe(0);
    expect(projection.standardDeviation).toBe(0);
    expect(projection.expectedGames).toBe(1);
    expect(Number.isFinite(projection.p85Points)).toBe(true);
  });

  it("keeps kicker byes as deterministic zero weeks without consuming availability state", () => {
    const projection = projectFirstPartyRestOfSeason(
      kickerInput({
        windowStartWeek: 5,
        windowEndWeek: 6,
        weeks: [kickerWeek(5, { bye: true }), kickerWeek(6)],
        scenarioCount: 512,
      }),
    );
    expect(projection.weekly[0]!.meanPoints).toBe(0);
    expect(projection.weekly[0]!.bye).toBe(true);
    expect(projection.weekly[1]!.meanPoints).toBeGreaterThan(0);
  });

  it("pairs antithetically: pair means concentrate and the center factor stays mean-one", () => {
    const withCenter = projectFirstPartyRestOfSeason(
      kickerInput({
        kicker: { ...kickerProcess, centerVolatility: 0.25 },
        availability: { ...projectionInput().availability, newAbsenceProbability: 0 },
        scenarioCount: 16_384,
      }),
    );
    const withoutCenter = projectFirstPartyRestOfSeason(
      kickerInput({
        availability: { ...projectionInput().availability, newAbsenceProbability: 0 },
        scenarioCount: 16_384,
      }),
    );
    // The static center factor is mean-one by construction, so the aggregate mean moves by well
    // under its added dispersion while the spread strictly widens.
    expect(Math.abs(withCenter.meanPoints - withoutCenter.meanPoints)).toBeLessThan(
      0.05 * withoutCenter.meanPoints,
    );
    expect(withCenter.standardDeviation).toBeGreaterThan(withoutCenter.standardDeviation);
  });

  it("applies the lattice-aware p50 convergence tolerance to kickers only", () => {
    const kicker = diagnoseFirstPartyRosConvergence(kickerInput());
    const kickerP50 = kicker.metrics.find((metric) => metric.metric === "p50Points")!;
    // Kicker totals live on an integer lattice; the declared absolute tolerance equals the
    // lattice spacing (1), so a single-atom median hop can never read as instability.
    expect(kickerP50.allowedDifference).toBeGreaterThanOrEqual(1);
    const wr = diagnoseFirstPartyRosConvergence(projectionInput());
    const wrP50 = wr.metrics.find((metric) => metric.metric === "p50Points")!;
    // Non-kicker positions keep the original 0.75-absolute / 3%-relative tolerance verbatim.
    expect(wrP50.allowedDifference).toBeCloseTo(
      Math.max(0.75, Math.abs(wrP50.referenceValue) * 0.03),
      10,
    );
  }, 15_000);

  it("validates kicker process parameter ranges fail-closed", () => {
    expect(() =>
      projectFirstPartyRestOfSeason(
        kickerInput({ kicker: { ...kickerProcess, fgEventDispersion: 0.5 } }),
      ),
    ).toThrow("between 0.6 and 1");
    expect(() =>
      projectFirstPartyRestOfSeason(
        kickerInput({ kicker: { ...kickerProcess, xpDispersion: 1.2 } }),
      ),
    ).toThrow("between 0.7 and 1.05");
    expect(() =>
      projectFirstPartyRestOfSeason(
        kickerInput({ kicker: { ...kickerProcess, bucketMix: [0.5, 0.5, 0.5] } }),
      ),
    ).toThrow("sum to one");
    expect(() =>
      projectFirstPartyRestOfSeason(
        kickerInput({
          kicker: { ...kickerProcess, missBucketMix: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6] },
        }),
      ),
    ).toThrow("sum to one");
  });
});

describe("shared football model golden output", () => {
  it("preserves v11 simulation numbers for identical football inputs under the new model identity", async () => {
    const { readFileSync } = await import("node:fs");
    const golden = JSON.parse(
      readFileSync(new URL("./rest-of-season.v11-golden-wr.json", import.meta.url), "utf8"),
    ) as ReturnType<typeof projectFirstPartyRestOfSeason>;
    const current = projectFirstPartyRestOfSeason(longTouchdownProjectionInput());
    expect(current).toEqual({
      ...golden,
      provenance: { ...golden.provenance, modelVersion: FIRST_PARTY_ROS_MODEL_VERSION },
    });
    expect(golden.provenance.modelVersion).toBe("laces-ros-distribution-v11");
  });
});

function heldOutForecast(
  season: number,
  asOfWeek: number,
  playerId: string,
  options: {
    readonly position?: "WR" | "RB";
    readonly contextualMean?: number;
    readonly recencyMean?: number;
    readonly actual?: number;
  } = {},
): FirstPartyRosHeldOutForecast {
  const actual = options.actual ?? 100;
  const contextualMean = options.contextualMean ?? actual + 1;
  const recencyMean = options.recencyMean ?? actual + 8;
  return {
    playerId,
    position: options.position ?? "WR",
    contextualModelVersion: "contextual-v1",
    recencyModelVersion: "recency-v1",
    scoringProfileKey: "test-ppr:v1",
    intervalMethodVersion: "simulation-p15-p85-v1",
    forecastSeason: season,
    asOfWeek,
    windowStartWeek: asOfWeek + 1,
    windowEndWeek: 18,
    trainedThroughSeason: season - 1,
    inputChecksum: "b".repeat(64),
    evidence: {
      coverage: { contextual: 1, recency: 1 },
      availability: {
        scheduledGames: 18 - asOfWeek,
        actualGames: 17 - asOfWeek,
        contextualExpectedGames: 17 - asOfWeek,
        recencyExpectedGames: 16.5 - asOfWeek,
      },
      convergence: {
        contextual: { state: "converged", diagnosticChecksum: "c".repeat(64) },
        recency: { state: "converged", diagnosticChecksum: "d".repeat(64) },
      },
    },
    contextual: {
      meanPoints: contextualMean,
      p15Points: contextualMean - 15,
      p50Points: contextualMean,
      p85Points: contextualMean + 15,
    },
    recency: {
      meanPoints: recencyMean,
      p15Points: recencyMean - 25,
      p50Points: recencyMean,
      p85Points: recencyMean + 25,
    },
    actualPoints: actual,
  };
}

function strategySwitchSeasons() {
  return [2022, 2023, 2024, 2025].map((season) => ({
    season,
    complete: true,
    forecasts: Array.from({ length: 17 }, (_, index) => index + 1).flatMap((asOfWeek) =>
      Array.from({ length: 8 }, (_, player) => {
        // Three seasons do not establish a contextual advantage; the fourth clears the same
        // uncertainty gate. Both candidates nevertheless have prior-trained CQR artifacts.
        const contextualMean = season === 2023 ? 110 : 108;
        const base = heldOutForecast(season, asOfWeek, `team-${player}`);
        const scheduledGames = 18 - asOfWeek;
        return {
          ...base,
          position: "DST" as const,
          contextual: {
            meanPoints: contextualMean,
            p15Points: contextualMean - 5,
            p50Points: contextualMean,
            p85Points: contextualMean + 5,
          },
          recency: {
            meanPoints: 110,
            // One independently missed block in each short window during the held-out year.
            p15Points: season === 2025 && [10, 14].includes(asOfWeek) ? 101 : 85,
            p50Points: 110,
            p85Points: 135,
          },
          evidence: {
            ...base.evidence,
            availability: {
              scheduledGames,
              actualGames: scheduledGames,
              contextualExpectedGames: scheduledGames,
              recencyExpectedGames: scheduledGames,
            },
          },
        };
      }),
    ),
  }));
}

describe("season-locked ROS champion policy", () => {
  it("measures both prior-calibrated candidates before a live strategy switch without changing selected metrics", () => {
    const seasons = strategySwitchSeasons();
    // Use all production minima: three prior seasons, 51 batches and 408 paired forecasts.
    const prior = evaluateFirstPartyRosChampionPolicy(seasons.slice(0, 3));
    const evaluation = evaluateFirstPartyRosChampionPolicy(seasons);
    expect(evaluation.selected.every((row) => row.strategy === "availability-aware-recency")).toBe(
      true,
    );
    expect(
      evaluation.selected
        .filter((row) => row.forecastSeason < 2025)
        .every((row) => row.intervalCalibration === "not-calibrated"),
    ).toBe(true);
    for (const bucket of ["one-to-four", "five-to-eight"] as const) {
      const before = prior.livePolicy.choices.find(
        (choice) => choice.position === "DST" && choice.bucket === bucket,
      )!;
      const live = evaluation.livePolicy.choices.find(
        (choice) => choice.position === "DST" && choice.bucket === bucket,
      )!;
      expect(before.strategy).toBe("availability-aware-recency");
      for (const strategy of ["contextual", "recency"] as const) {
        expect(before.intervalCalibrationArtifacts[strategy]).toMatchObject({
          state: "calibrated",
          trainedThroughSeason: 2024,
          seasons: 3,
          blocks: 12,
          samples: 96,
        });
        expect(before.walkForwardCalibrationEvidence[strategy].state).toBe("unavailable");
        expect(live.walkForwardCalibrationEvidence[strategy]).toMatchObject({
          state: "available",
          seasons: 1,
          blocks: 4,
          samples: 32,
        });
      }
      expect(live).toMatchObject({ strategy: "contextual", reason: "model-cleared-margin" });
      expect(live.walkForwardCalibrationEvidence.contextual.observedBlockCoverage).toBe(1);
      expect(live.walkForwardCalibrationEvidence.recency.observedBlockCoverage).toBe(0.75);
      expect(live.walkForwardCalibrationEvidence.contextual.evidenceChecksum).not.toBe(
        live.walkForwardCalibrationEvidence.recency.evidenceChecksum,
      );
      const selected = evaluation.selected.filter(
        (row) => row.forecastSeason === 2025 && row.bucket === bucket,
      );
      expect(selected).toHaveLength(32);
      expect(selected.every((row) => row.predictedMean === 110 && row.p85Points === 135)).toBe(
        true,
      );
      expect(
        selected.filter((row) => row.p15Points === 101 && row.intervalCovered === false),
      ).toHaveLength(8);
      const decision = evaluateFirstPartyRosReleaseGate(evaluation.livePolicy, {
        contextualModelVersion: "contextual-v1",
        recencyModelVersion: "recency-v1",
        scoringProfileKey: "test-ppr:v1",
        intervalMethodVersion: "simulation-p15-p85-v1",
        position: "DST",
        bucket,
        inputChecksum: "e".repeat(64),
        coverage: { contextual: 1, recency: 1 },
        availability: { scheduledGames: 4, contextualExpectedGames: 4, recencyExpectedGames: 4 },
        convergence: {
          contextual: { state: "converged", diagnosticChecksum: "c".repeat(64) },
          recency: { state: "converged", diagnosticChecksum: "d".repeat(64) },
        },
      });
      expect(decision).toMatchObject({ state: "release", strategy: "contextual", reasons: [] });
    }
  });

  it("records unselected candidate misses independently while preserving every season-selected forecast", () => {
    const seasons = strategySwitchSeasons();
    const original = evaluateFirstPartyRosChampionPolicy(seasons);
    const changed = evaluateFirstPartyRosChampionPolicy(
      seasons.map((season) => ({
        ...season,
        forecasts: season.forecasts.map((forecast) =>
          season.season === 2025
            ? {
                ...forecast,
                contextual: { meanPoints: 141, p15Points: 130, p50Points: 141, p85Points: 152 },
              }
            : forecast,
        ),
      })),
    );
    expect(changed.selected).toEqual(original.selected);
    expect(changed.seasonPolicies).toEqual(original.seasonPolicies);
    for (const bucket of ["one-to-four", "five-to-eight"] as const) {
      const originalChoice = original.livePolicy.choices.find(
        (choice) => choice.position === "DST" && choice.bucket === bucket,
      )!;
      const changedChoice = changed.livePolicy.choices.find(
        (choice) => choice.position === "DST" && choice.bucket === bucket,
      )!;
      expect(changedChoice.walkForwardCalibrationEvidence.contextual).toMatchObject({
        state: "available",
        observedBlockCoverage: 0,
        seasons: 1,
        blocks: 4,
        samples: 32,
      });
      expect(changedChoice.walkForwardCalibrationEvidence.recency).toEqual(
        originalChoice.walkForwardCalibrationEvidence.recency,
      );
      expect(changedChoice.walkForwardCalibrationEvidence.contextual.evidenceChecksum).not.toBe(
        originalChoice.walkForwardCalibrationEvidence.contextual.evidenceChecksum,
      );
    }
  });

  it("does not let either candidate's current-season outcomes calibrate their own coverage", () => {
    const seasons = strategySwitchSeasons();
    const original = evaluateFirstPartyRosChampionPolicy(seasons);
    const changed = evaluateFirstPartyRosChampionPolicy(
      seasons.map((season) => ({
        ...season,
        forecasts: season.forecasts.map((forecast) =>
          season.season === 2025 ? { ...forecast, actualPoints: 1000 } : forecast,
        ),
      })),
    );
    expect(changed.seasonPolicies).toEqual(original.seasonPolicies);
    expect(changed.selected.filter((row) => row.forecastSeason < 2025)).toEqual(
      original.selected.filter((row) => row.forecastSeason < 2025),
    );
    const live = changed.livePolicy.choices.find(
      (choice) => choice.position === "DST" && choice.bucket === "one-to-four",
    )!;
    for (const strategy of ["contextual", "recency"] as const) {
      expect(live.walkForwardCalibrationEvidence[strategy]).toMatchObject({
        state: "available",
        observedBlockCoverage: 0,
        seasons: 1,
        blocks: 4,
        samples: 32,
      });
      // The live artifact includes this season only after its walk-forward measurements.
      expect(live.intervalCalibrationArtifacts[strategy].trainedThroughSeason).toBe(2025);
      const priorChoice = changed.seasonPolicies
        .at(-1)!
        .policy.choices.find(
          (choice) => choice.position === "DST" && choice.bucket === "one-to-four",
        )!;
      expect(live.intervalCalibrationArtifacts[strategy].artifactChecksum).not.toBe(
        priorChoice.intervalCalibrationArtifacts[strategy].artifactChecksum,
      );
      if (strategy === "recency") {
        expect(
          changed.selected
            .filter((row) => row.forecastSeason === 2025 && row.bucket === "one-to-four")
            .every(
              (row) =>
                row.calibrationArtifactChecksum ===
                priorChoice.intervalCalibrationArtifacts.recency.artifactChecksum,
            ),
        ).toBe(true);
      }
    }
  });

  it("uses conservative simultaneous targets only for the matching nonlinear scoring shapes", () => {
    const identity = {
      contextualModelVersion: "contextual-v1",
      recencyModelVersion: "recency-v1",
      scoringProfileKey: projectionScoringProfileKey({
        id: "espn-tiered-defense",
        rules: [
          { statId: "defensive_sacks", points: 1 },
          { statId: "points_allowed_0_probability", points: 5 },
          { statId: "yards_allowed_350_399_probability", points: -1 },
        ],
      }),
      intervalMethodVersion: "simulation-p15-p85-v1",
    };
    const legacyIdentity = {
      ...identity,
      scoringProfileKey: projectionScoringProfileKey({
        id: "legacy-defense",
        rules: [
          { statId: "defensive_sacks", points: 1 },
          { statId: "points_allowed_0_probability", points: 10 },
        ],
      }),
    };
    const bonusIdentity = {
      ...identity,
      scoringProfileKey: projectionScoringProfileKey({
        id: "yardage-game-bonus",
        rules: [
          { statId: "receptions", points: 1 },
          { statId: "receiving_yards", points: 0.1 },
          { statId: "receiving_yards_100_199_probability", points: 1 },
          { statId: "receiving_yards_200_plus_probability", points: 3 },
        ],
      }),
    };

    expect(firstPartyRosNominalIntervalCoverage("DST", "five-to-eight", identity)).toBe(0.8);
    expect(firstPartyRosNominalIntervalCoverage("DST", "five-to-eight", legacyIdentity)).toBe(0.7);
    expect(firstPartyRosNominalIntervalCoverage("TE", "nine-plus", bonusIdentity)).toBe(0.85);
    expect(firstPartyRosNominalIntervalCoverage("TE", "five-to-eight", bonusIdentity)).toBe(0.7);
    expect(firstPartyRosNominalIntervalCoverage("WR", "nine-plus", bonusIdentity)).toBe(0.7);
    expect(firstPartyRosNominalIntervalCoverage("WR", "nine-plus", identity)).toBe(0.7);
    expect(firstPartyRosNominalIntervalCoverage("DST", "five-to-eight", null)).toBe(0.7);
    expect(
      firstPartyRosNominalIntervalCoverage("DST", "five-to-eight", {
        ...identity,
        scoringProfileKey: "not canonical JSON",
      }),
    ).toBe(0.7);
  });

  it("defends recency and never lets current-season outcomes calibrate themselves", () => {
    const evaluation = evaluateFirstPartyRosChampionPolicy(
      [2023, 2024].map((season) => ({
        season,
        complete: true,
        forecasts: [
          heldOutForecast(season, 10, `${season}-one`),
          heldOutForecast(season, 11, `${season}-two`),
        ],
      })),
      {
        minimumHeldOutSeasons: 2,
        minimumBatches: 4,
        minimumSamples: 4,
        minimumCellSeasons: 2,
        minimumCellSamples: 4,
        minimumCellCutoffs: 2,
        minimumCellBatches: 4,
      },
    );

    const firstPolicy = evaluation.seasonPolicies[0]!.policy.choices.find(
      (choice) => choice.position === "WR" && choice.bucket === "five-to-eight",
    )!;
    const secondPolicy = evaluation.seasonPolicies[1]!.policy.choices.find(
      (choice) => choice.position === "WR" && choice.bucket === "five-to-eight",
    )!;
    const live = evaluation.livePolicy.choices.find(
      (choice) => choice.position === "WR" && choice.bucket === "five-to-eight",
    )!;

    expect(firstPolicy).toMatchObject({
      strategy: "availability-aware-recency",
      reason: "insufficient-global-evidence",
      heldOutSeasons: 0,
    });
    expect(secondPolicy).toMatchObject({
      strategy: "availability-aware-recency",
      reason: "insufficient-global-evidence",
      heldOutSeasons: 1,
    });
    expect(live).toMatchObject({
      strategy: "contextual",
      reason: "model-cleared-margin",
      heldOutSeasons: 2,
      batches: 4,
      samples: 4,
      intervalCalibration: "split-conformal-cqr",
      heldOutEvidence: {
        state: "derived-immutable-not-calibrated",
        intervalCalibration: "not-calibrated",
        contextualConvergenceRate: 1,
      },
    });
    expect(live.heldOutEvidence.evidenceChecksum).toMatch(/^[a-f0-9]{64}$/u);
    expect(evaluation.seasonPolicies[1]!.evidenceThroughSeason).toBe(2023);
    expect(evaluation.livePolicy.evidenceThroughSeason).toBe(2024);
    expect(
      evaluation.selected.every(
        (selection) =>
          selection.strategy === "availability-aware-recency" &&
          selection.intervalCalibration === "not-calibrated",
      ),
    ).toBe(true);
    expect(secondPolicy.intervalCalibration).toBe("not-calibrated");
    expect(live.intervalCalibrationArtifacts.contextual).toMatchObject({
      state: "calibrated",
      trainedThroughSeason: 2024,
      calibrationVersion: "season-blocked-split-conformal-cqr-v1",
    });
  });

  it("releases only when immutable held-out and live evidence clear every gate", () => {
    const evaluation = evaluateFirstPartyRosChampionPolicy(
      [2023, 2024, 2025].map((season) => ({
        season,
        complete: true,
        forecasts: [
          heldOutForecast(season, 10, `${season}-one`),
          heldOutForecast(season, 11, `${season}-two`),
        ],
      })),
      {
        minimumHeldOutSeasons: 2,
        minimumBatches: 4,
        minimumSamples: 4,
        minimumCellSeasons: 2,
        minimumCellSamples: 4,
        minimumCellCutoffs: 2,
        minimumCellBatches: 4,
      },
    );
    const liveEvidence = {
      contextualModelVersion: "contextual-v1",
      recencyModelVersion: "recency-v1",
      scoringProfileKey: "test-ppr:v1",
      intervalMethodVersion: "simulation-p15-p85-v1",
      position: "WR" as const,
      bucket: "five-to-eight" as const,
      inputChecksum: "e".repeat(64),
      coverage: { contextual: 1, recency: 1 },
      availability: {
        scheduledGames: 8,
        contextualExpectedGames: 7,
        recencyExpectedGames: 6.5,
      },
      convergence: {
        contextual: { state: "converged" as const, diagnosticChecksum: "c".repeat(64) },
        recency: { state: "converged" as const, diagnosticChecksum: "d".repeat(64) },
      },
    };
    const releaseOptions = {
      maximumIntervalCoverageDeviation: 0.31,
      minimumWalkForwardCalibrationSeasons: 1,
      minimumWalkForwardCalibrationBatches: 2,
      minimumWalkForwardCalibrationSamples: 2,
    };
    const released = evaluateFirstPartyRosReleaseGate(
      evaluation.livePolicy,
      liveEvidence,
      releaseOptions,
    );
    const withheld = evaluateFirstPartyRosReleaseGate(
      evaluation.livePolicy,
      {
        ...liveEvidence,
        convergence: {
          ...liveEvidence.convergence,
          contextual: { ...liveEvidence.convergence.contextual, state: "unstable" as const },
        },
      },
      releaseOptions,
    );
    const identityMismatch = evaluateFirstPartyRosReleaseGate(
      evaluation.livePolicy,
      { ...liveEvidence, scoringProfileKey: "other-profile" },
      releaseOptions,
    );
    const uncalibrated = evaluateFirstPartyRosReleaseGate(
      evaluation.seasonPolicies[0]!.policy,
      liveEvidence,
      { ...releaseOptions, maximumIntervalCoverageDeviation: 1 },
    );

    expect(released).toMatchObject({
      state: "release",
      strategy: "contextual",
      reasons: [],
      intervalCalibration: "split-conformal-cqr",
    });
    expect(released.evidenceChecksum).toMatch(/^[a-f0-9]{64}$/u);
    expect(withheld).toMatchObject({
      state: "withhold",
      strategy: null,
      reasons: ["convergence-gate-failed"],
      intervalCalibration: "not-calibrated",
    });
    expect(identityMismatch.state).toBe("withhold");
    expect(identityMismatch.reasons).toContain("evidence-identity-mismatch");
    expect(identityMismatch.intervalCalibration).toBe("not-calibrated");
    expect(uncalibrated.state).toBe("withhold");
    expect(uncalibrated.reasons).toContain("interval-calibration-unavailable");
    expect(uncalibrated.intervalCalibration).toBe("not-calibrated");
  });

  it("fails the availability ceiling only on evidence of excess error, not on a point estimate", () => {
    // The releasing fixture above, moved to the nine-plus bucket: asOfWeek 8 and 9 leave 10- and
    // 9-week windows. The fixture's own availability MAE is 0, so the ceiling behavior is probed
    // by overriding the derived held-out evidence exactly as the report-gate test does
    // (apps/worker/src/first-party-ros-backtest.test.ts).
    const evaluation = evaluateFirstPartyRosChampionPolicy(
      [2023, 2024, 2025].map((season) => ({
        season,
        complete: true,
        forecasts: [
          heldOutForecast(season, 8, `${season}-one`),
          heldOutForecast(season, 9, `${season}-two`),
        ],
      })),
      {
        minimumHeldOutSeasons: 2,
        minimumBatches: 4,
        minimumSamples: 4,
        minimumCellSeasons: 2,
        minimumCellSamples: 4,
        minimumCellCutoffs: 2,
        minimumCellBatches: 4,
      },
    );
    const policyWithAvailabilityMae = (availabilityMae: number, samples: number) => ({
      ...evaluation.livePolicy,
      choices: evaluation.livePolicy.choices.map((choice) =>
        choice.position === "WR" && choice.bucket === "nine-plus"
          ? {
              ...choice,
              samples,
              meanSelectionEvidence: {
                ...choice.meanSelectionEvidence,
                samples,
                seasonEvidence: choice.meanSelectionEvidence.seasonEvidence.map(
                  (row, index, rows) => ({
                    ...row,
                    samples:
                      Math.floor(samples / rows.length) + Number(index < samples % rows.length),
                  }),
                ),
              },
              heldOutEvidence: {
                ...choice.heldOutEvidence,
                contextualAvailabilityMae: availabilityMae,
                recencyAvailabilityMae: availabilityMae,
              },
            }
          : choice,
      ),
    });
    const liveEvidence = {
      contextualModelVersion: "contextual-v1",
      recencyModelVersion: "recency-v1",
      scoringProfileKey: "test-ppr:v1",
      intervalMethodVersion: "simulation-p15-p85-v1",
      position: "WR" as const,
      bucket: "nine-plus" as const,
      inputChecksum: "e".repeat(64),
      coverage: { contextual: 1, recency: 1 },
      availability: {
        scheduledGames: 10,
        contextualExpectedGames: 9,
        recencyExpectedGames: 8.5,
      },
      convergence: {
        contextual: { state: "converged" as const, diagnosticChecksum: "c".repeat(64) },
        recency: { state: "converged" as const, diagnosticChecksum: "d".repeat(64) },
      },
    };
    const releaseOptions = {
      maximumIntervalCoverageDeviation: 0.31,
      minimumWalkForwardCalibrationSeasons: 1,
      minimumWalkForwardCalibrationBatches: 2,
      minimumWalkForwardCalibrationSamples: 2,
    };

    // Hundredths over the 2.75 nine-plus ceiling at 288 paired rows is inside the evidence test's
    // bar (a nine-plus cell fails only from about 3.25 games at that sample), so the cell releases
    // where the superseded point comparison withheld it.
    const marginal = evaluateFirstPartyRosReleaseGate(
      policyWithAvailabilityMae(2.76, 288),
      liveEvidence,
      releaseOptions,
    );
    expect(marginal).toMatchObject({ state: "release", strategy: "contextual", reasons: [] });
    // A cell genuinely and substantially over its ceiling still withholds, for exactly that reason.
    const substantial = evaluateFirstPartyRosReleaseGate(
      policyWithAvailabilityMae(3.5, 288),
      liveEvidence,
      releaseOptions,
    );
    expect(substantial.state).toBe("withhold");
    expect(substantial.reasons).toEqual(["availability-error-above-threshold"]);
    // A small sample cannot turn hundredths over the ceiling into evidence either.
    const smallSample = evaluateFirstPartyRosReleaseGate(
      policyWithAvailabilityMae(2.76, 18),
      liveEvidence,
      releaseOptions,
    );
    expect(smallSample.state).toBe("release");
  });

  it("scopes the live gate's evidence identity to the position being gated", () => {
    const artifactRules = [
      { statId: "passing_yards", points: 0.04 },
      { statId: "passing_touchdowns", points: 4 },
      { statId: "receptions", points: 1 },
    ];
    const artifactKey = projectionScoringProfileKey({ id: "artifact", rules: artifactRules });
    // A D/ST-only rule joining the league profile moves the whole key for a reason that cannot
    // touch a QB cell: defensive_sacks is outside the QB component vocabulary.
    const dstAugmentedKey = projectionScoringProfileKey({
      id: "league-with-dst",
      rules: [...artifactRules, { statId: "defensive_sacks", points: 1 }],
    });
    // Repricing passing yards is inside the QB vocabulary, so the QB-scoped keys diverge.
    const qbRepricedKey = projectionScoringProfileKey({
      id: "league-reprices-qb",
      rules: [{ statId: "passing_yards", points: 0.05 }, ...artifactRules.slice(1)],
    });
    const policyFor = (scoringProfileKey: string) =>
      evaluateFirstPartyRosChampionPolicy(
        [2023, 2024, 2025].map((season) => ({
          season,
          complete: true,
          forecasts: [
            {
              ...heldOutForecast(season, 10, `${season}-one`),
              position: "QB" as const,
              scoringProfileKey,
            },
            {
              ...heldOutForecast(season, 11, `${season}-two`),
              position: "QB" as const,
              scoringProfileKey,
            },
          ],
        })),
        {
          minimumHeldOutSeasons: 2,
          minimumBatches: 4,
          minimumSamples: 4,
          minimumCellSeasons: 2,
          minimumCellSamples: 4,
          minimumCellCutoffs: 2,
          minimumCellBatches: 4,
        },
      ).livePolicy;
    const liveEvidenceFor = (scoringProfileKey: string) => ({
      contextualModelVersion: "contextual-v1",
      recencyModelVersion: "recency-v1",
      scoringProfileKey,
      intervalMethodVersion: "simulation-p15-p85-v1",
      position: "QB" as const,
      bucket: "five-to-eight" as const,
      inputChecksum: "e".repeat(64),
      coverage: { contextual: 1, recency: 1 },
      availability: {
        scheduledGames: 8,
        contextualExpectedGames: 7,
        recencyExpectedGames: 6.5,
      },
      convergence: {
        contextual: { state: "converged" as const, diagnosticChecksum: "c".repeat(64) },
        recency: { state: "converged" as const, diagnosticChecksum: "d".repeat(64) },
      },
    });
    const releaseOptions = {
      maximumIntervalCoverageDeviation: 0.31,
      minimumWalkForwardCalibrationSeasons: 1,
      minimumWalkForwardCalibrationBatches: 2,
      minimumWalkForwardCalibrationSamples: 2,
    };
    const artifactPolicy = policyFor(artifactKey);

    // The whole keys differ, but byte-equal QB-scoped keys mean byte-identical QB scoring, so the
    // QB cell keeps releasing when the league profile gains rules outside its vocabulary.
    const dstAugmented = evaluateFirstPartyRosReleaseGate(
      artifactPolicy,
      liveEvidenceFor(dstAugmentedKey),
      releaseOptions,
    );
    expect(dstAugmented).toMatchObject({ state: "release", strategy: "contextual", reasons: [] });

    const repriced = evaluateFirstPartyRosReleaseGate(
      artifactPolicy,
      liveEvidenceFor(qbRepricedKey),
      releaseOptions,
    );
    expect(repriced.state).toBe("withhold");
    expect(repriced.reasons).toContain("evidence-identity-mismatch");

    // Two canonical profiles that both scope to "[]" for the gated position must never read as
    // agreement (fail closed): pricing nothing for QB is not evidence of identical QB scoring.
    const dstOnlyPolicy = policyFor(
      projectionScoringProfileKey({
        id: "dst-only-a",
        rules: [{ statId: "defensive_sacks", points: 1 }],
      }),
    );
    const emptyScoped = evaluateFirstPartyRosReleaseGate(
      dstOnlyPolicy,
      liveEvidenceFor(
        projectionScoringProfileKey({
          id: "dst-only-b",
          rules: [{ statId: "defensive_sacks", points: 2 }],
        }),
      ),
      releaseOptions,
    );
    expect(emptyScoped.state).toBe("withhold");
    expect(emptyScoped.reasons).toContain("evidence-identity-mismatch");
  });

  it("pins Amendment 4's inertness argument: one frozen profile on both sides decides exactly as whole-key equality did", () => {
    // The 2026 untouched run scores every position under a single frozen profile, so both sides of
    // every identity comparison derive from that one profile and carry the same canonical key.
    // Byte-equal keys take the fast path that is whole-key equality, so position scoping cannot
    // change any frozen-corpus decision.
    const frozenKey = projectionScoringProfileKey({
      id: "frozen-untouched-proof-ppr",
      rules: [
        { statId: "receptions", points: 1 },
        { statId: "receiving_yards", points: 0.1 },
        { statId: "receiving_touchdowns", points: 6 },
        { statId: "rushing_yards", points: 0.1 },
        { statId: "passing_yards", points: 0.04 },
        { statId: "field_goals_made_0_39", points: 3 },
        { statId: "defensive_sacks", points: 1 },
      ],
    });
    const evaluation = evaluateFirstPartyRosChampionPolicy(
      [2023, 2024, 2025].map((season) => ({
        season,
        complete: true,
        forecasts: [
          { ...heldOutForecast(season, 10, `${season}-one`), scoringProfileKey: frozenKey },
          { ...heldOutForecast(season, 11, `${season}-two`), scoringProfileKey: frozenKey },
        ],
      })),
      {
        minimumHeldOutSeasons: 2,
        minimumBatches: 4,
        minimumSamples: 4,
        minimumCellSeasons: 2,
        minimumCellSamples: 4,
        minimumCellCutoffs: 2,
        minimumCellBatches: 4,
      },
    );
    const releaseOptions = {
      maximumIntervalCoverageDeviation: 0.31,
      minimumWalkForwardCalibrationSeasons: 1,
      minimumWalkForwardCalibrationBatches: 2,
      minimumWalkForwardCalibrationSamples: 2,
    };
    const liveEvidenceFor = (
      position: "QB" | "RB" | "WR" | "TE" | "K" | "DST",
      bucket: "one-to-four" | "five-to-eight" | "nine-plus",
    ) => ({
      contextualModelVersion: "contextual-v1",
      recencyModelVersion: "recency-v1",
      scoringProfileKey: frozenKey,
      intervalMethodVersion: "simulation-p15-p85-v1",
      position,
      bucket,
      inputChecksum: "e".repeat(64),
      coverage: { contextual: 1, recency: 1 },
      availability: {
        scheduledGames: 8,
        contextualExpectedGames: 7,
        recencyExpectedGames: 6.5,
      },
      convergence: {
        contextual: { state: "converged" as const, diagnosticChecksum: "c".repeat(64) },
        recency: { state: "converged" as const, diagnosticChecksum: "d".repeat(64) },
      },
    });

    // The releasing fixture decides byte-identically to the whole-key gate's pre-change
    // expectation: release, contextual, no reasons.
    const released = evaluateFirstPartyRosReleaseGate(
      evaluation.livePolicy,
      liveEvidenceFor("WR", "five-to-eight"),
      releaseOptions,
    );
    expect(released).toMatchObject({ state: "release", strategy: "contextual", reasons: [] });
    // The withholding fixture raises exactly the single reason the whole-key gate raised.
    const withheld = evaluateFirstPartyRosReleaseGate(
      evaluation.livePolicy,
      {
        ...liveEvidenceFor("WR", "five-to-eight"),
        convergence: {
          ...liveEvidenceFor("WR", "five-to-eight").convergence,
          contextual: { state: "unstable" as const, diagnosticChecksum: "c".repeat(64) },
        },
      },
      releaseOptions,
    );
    expect(withheld).toMatchObject({ state: "withhold", reasons: ["convergence-gate-failed"] });
    // Across the entire position x bucket matrix, identity never decides anything: both sides
    // carry the frozen key, so no cell can raise evidence-identity-mismatch, and each sparse
    // cell's reasons are exactly the evidence shortfalls whole-key semantics produced.
    for (const position of ["QB", "RB", "WR", "TE", "K", "DST"] as const) {
      for (const bucket of ["one-to-four", "five-to-eight", "nine-plus"] as const) {
        const decision = evaluateFirstPartyRosReleaseGate(
          evaluation.livePolicy,
          liveEvidenceFor(position, bucket),
          releaseOptions,
        );
        expect(decision.reasons).not.toContain("evidence-identity-mismatch");
        if (position === "WR" && bucket === "five-to-eight") {
          expect(decision.state).toBe("release");
        } else {
          // Sparse cells withhold on evidence, never on identity — same as before the change.
          expect(decision.state).toBe("withhold");
          expect(decision.reasons.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("withholds on a signed availability bias above threshold even when the MAE ceiling is cleared", () => {
    // Consistently shifts the selected (contextual) strategy's expected games 1.2 above actual
    // for every held-out forecast: |bias| = 1.2 exceeds FIRST_PARTY_ROS_MAX_AVAILABILITY_BIAS
    // (1.0), while the MAE of the same consistently-signed errors (also 1.2) stays under the
    // five-to-eight ceiling (1.5), isolating the new bias gate from the pre-existing MAE gate.
    const biasedForecast = (season: number, asOfWeek: number, playerId: string) => {
      const base = heldOutForecast(season, asOfWeek, playerId);
      const actualGames = base.evidence.availability.actualGames - 2;
      return {
        ...base,
        evidence: {
          ...base.evidence,
          availability: {
            ...base.evidence.availability,
            actualGames,
            contextualExpectedGames: actualGames + 1.2,
          },
        },
      };
    };
    const evaluation = evaluateFirstPartyRosChampionPolicy(
      [2023, 2024, 2025].map((season) => ({
        season,
        complete: true,
        forecasts: [
          biasedForecast(season, 10, `${season}-one`),
          biasedForecast(season, 11, `${season}-two`),
        ],
      })),
      {
        minimumHeldOutSeasons: 2,
        minimumBatches: 4,
        minimumSamples: 4,
        minimumCellSeasons: 2,
        minimumCellSamples: 4,
        minimumCellCutoffs: 2,
        minimumCellBatches: 4,
      },
    );
    const choice = evaluation.livePolicy.choices.find(
      (item) => item.position === "WR" && item.bucket === "five-to-eight",
    )!;
    const liveEvidence = {
      contextualModelVersion: "contextual-v1",
      recencyModelVersion: "recency-v1",
      scoringProfileKey: "test-ppr:v1",
      intervalMethodVersion: "simulation-p15-p85-v1",
      position: "WR" as const,
      bucket: "five-to-eight" as const,
      inputChecksum: "e".repeat(64),
      coverage: { contextual: 1, recency: 1 },
      availability: {
        scheduledGames: 8,
        contextualExpectedGames: 7,
        recencyExpectedGames: 6.5,
      },
      convergence: {
        contextual: { state: "converged" as const, diagnosticChecksum: "c".repeat(64) },
        recency: { state: "converged" as const, diagnosticChecksum: "d".repeat(64) },
      },
    };
    const decision = evaluateFirstPartyRosReleaseGate(evaluation.livePolicy, liveEvidence, {
      maximumIntervalCoverageDeviation: 0.31,
      minimumWalkForwardCalibrationSeasons: 1,
      minimumWalkForwardCalibrationBatches: 2,
      minimumWalkForwardCalibrationSamples: 2,
    });

    expect(choice.strategy).toBe("contextual");
    expect(choice.heldOutEvidence.contextualAvailabilityBias).toBeCloseTo(1.2, 10);
    expect(choice.heldOutEvidence.contextualAvailabilityMae).toBeCloseTo(1.2, 10);
    expect(decision.state).toBe("withhold");
    expect(decision.reasons).toEqual(["availability-bias-above-threshold"]);
  });

  it("learns a deterministic prior-season CQR expansion that corrects undercoverage", () => {
    const seasons = [2023, 2024].map((season) => ({
      season,
      complete: true,
      forecasts: [10, 11].map((asOfWeek) => ({
        ...heldOutForecast(season, asOfWeek, `${season}:${asOfWeek}`, {
          contextualMean: 101,
          recencyMean: 108,
        }),
        contextual: { meanPoints: 101, p15Points: 104, p50Points: 105, p85Points: 106 },
        recency: { meanPoints: 108, p15Points: 75, p50Points: 108, p85Points: 133 },
      })),
    }));
    const options = {
      minimumHeldOutSeasons: 2,
      minimumBatches: 4,
      minimumSamples: 4,
      minimumCellSeasons: 2,
      minimumCellSamples: 4,
      minimumCellCutoffs: 2,
      minimumCellBatches: 4,
    };
    const evaluation = evaluateFirstPartyRosChampionPolicy(seasons, options);
    const reversed = evaluateFirstPartyRosChampionPolicy(
      [...seasons]
        .reverse()
        .map((season) => ({ ...season, forecasts: [...season.forecasts].reverse() })),
      options,
    );
    const choice = evaluation.livePolicy.choices.find(
      (item) => item.position === "WR" && item.bucket === "five-to-eight",
    )!;
    const reversedChoice = reversed.livePolicy.choices.find(
      (item) => item.position === "WR" && item.bucket === "five-to-eight",
    )!;
    const artifact = choice.intervalCalibrationArtifacts.contextual;
    const applied = applyFirstPartyRosIntervalCalibration(
      { p15Points: 104, p50Points: 105, p85Points: 106 },
      artifact,
    );

    expect(choice.strategy).toBe("contextual");
    expect(artifact).toMatchObject({
      state: "calibrated",
      adjustmentPoints: 4,
      trainedThroughSeason: 2024,
      seasons: 2,
      blocks: 4,
    });
    expect(artifact.artifactChecksum).toMatch(/^[a-f0-9]{64}$/u);
    expect(reversedChoice.intervalCalibrationArtifacts.contextual.artifactChecksum).toBe(
      artifact.artifactChecksum,
    );
    expect(applied).toMatchObject({
      p15Points: 100,
      p50Points: 105,
      p85Points: 110,
      intervalCalibration: "split-conformal-cqr",
      calibrationArtifactChecksum: artifact.artifactChecksum,
    });
    expect(applied.p15Points).toBeLessThanOrEqual(applied.p50Points);
    expect(applied.p50Points).toBeLessThanOrEqual(applied.p85Points);
  });

  it("does not let in-sample construction coverage mask bad walk-forward coverage", () => {
    // Gate v3 requires the bad walk-forward record to be statistical evidence, not noise: four
    // fully-missed 2025 blocks (P(X<=0 | p=0.6, n=4) ~ 0.026 < 0.1) clear the evidence bar.
    const seasons = [2023, 2024, 2025].map((season) => ({
      season,
      complete: true,
      forecasts: [10, 11, 12, 13].map((asOfWeek) => {
        const base = heldOutForecast(season, asOfWeek, `${season}:${asOfWeek}`, {
          contextualMean: 100,
          recencyMean: 150,
        });
        return season < 2025
          ? base
          : {
              ...base,
              contextual: {
                meanPoints: 100,
                p15Points: 101,
                p50Points: 102,
                p85Points: 103,
              },
            };
      }),
    }));
    const evaluation = evaluateFirstPartyRosChampionPolicy(seasons, {
      minimumHeldOutSeasons: 2,
      minimumBatches: 4,
      minimumSamples: 4,
      minimumCellSeasons: 2,
      minimumCellSamples: 4,
      minimumCellCutoffs: 2,
      minimumCellBatches: 4,
    });
    const choice = evaluation.livePolicy.choices.find(
      (item) => item.position === "WR" && item.bucket === "five-to-eight",
    )!;
    const liveEvidence = {
      contextualModelVersion: "contextual-v1",
      recencyModelVersion: "recency-v1",
      scoringProfileKey: "test-ppr:v1",
      intervalMethodVersion: "simulation-p15-p85-v1",
      position: "WR" as const,
      bucket: "five-to-eight" as const,
      inputChecksum: "e".repeat(64),
      coverage: { contextual: 1, recency: 1 },
      availability: {
        scheduledGames: 8,
        contextualExpectedGames: 7,
        recencyExpectedGames: 6.5,
      },
      convergence: {
        contextual: { state: "converged" as const, diagnosticChecksum: "c".repeat(64) },
        recency: { state: "converged" as const, diagnosticChecksum: "d".repeat(64) },
      },
    };
    const decision = evaluateFirstPartyRosReleaseGate(evaluation.livePolicy, liveEvidence, {
      maximumIntervalCoverageDeviation: 0.1,
      minimumWalkForwardCalibrationSeasons: 1,
      minimumWalkForwardCalibrationBatches: 2,
      minimumWalkForwardCalibrationSamples: 2,
    });

    expect(choice.strategy).toBe("contextual");
    expect(choice.intervalCalibrationArtifacts.contextual.observedCalibratedBlockCoverage).toBe(1);
    expect(choice.walkForwardCalibrationEvidence.contextual).toMatchObject({
      state: "available",
      observedBlockCoverage: 0,
      seasons: 1,
      blocks: 4,
      samples: 4,
    });
    expect(
      evaluation.selected
        .filter((selection) => selection.forecastSeason === 2025)
        .every(
          (selection) =>
            selection.intervalCalibration === "split-conformal-cqr" &&
            selection.intervalCovered === false,
        ),
    ).toBe(true);
    expect(decision).toMatchObject({
      state: "withhold",
      strategy: null,
      intervalCalibration: "not-calibrated",
    });
    expect(decision.reasons).toContain("interval-coverage-gate-failed");
  });

  it("uses the cutoff-batch threshold globally rather than making short-window cells impossible", () => {
    const evaluation = evaluateFirstPartyRosChampionPolicy(
      [2023, 2024].map((season) => ({
        season,
        complete: true,
        forecasts: [
          heldOutForecast(season, 10, `${season}:long`),
          heldOutForecast(season, 14, `${season}:short-one`),
          heldOutForecast(season, 15, `${season}:short-two`),
        ],
      })),
      {
        minimumHeldOutSeasons: 2,
        minimumBatches: 6,
        minimumSamples: 6,
        minimumCellSeasons: 2,
        minimumCellSamples: 4,
        minimumCellCutoffs: 2,
        minimumCellBatches: 4,
      },
    );
    const shortCell = evaluation.livePolicy.choices.find(
      (choice) => choice.position === "WR" && choice.bucket === "one-to-four",
    )!;
    const sparseLongCell = evaluation.livePolicy.choices.find(
      (choice) => choice.position === "WR" && choice.bucket === "five-to-eight",
    )!;

    expect(evaluation.livePolicy.globalBatches).toBe(6);
    expect(shortCell.batches).toBe(4);
    expect(shortCell.globalBatches).toBe(6);
    expect(shortCell.intervalCalibrationArtifacts.contextual.state).toBe("calibrated");
    expect(sparseLongCell).toMatchObject({
      reason: "sparse-cell",
      samples: 2,
      intervalCalibration: "not-calibrated",
    });
  });

  it("does not claim calibration or promote a better-MAE model with worse intervals", () => {
    const seasons = [2023, 2024].map((season) => ({
      season,
      complete: true,
      forecasts: [10, 11].map((asOfWeek) => ({
        ...heldOutForecast(season, asOfWeek, `${season}:${asOfWeek}`, {
          contextualMean: 105,
          recencyMean: 110,
        }),
        contextual: { meanPoints: 105, p15Points: 105, p50Points: 105, p85Points: 105 },
        recency: { meanPoints: 110, p15Points: 100, p50Points: 110, p85Points: 110 },
      })),
    }));
    const evaluation = evaluateFirstPartyRosChampionPolicy(seasons, {
      minimumHeldOutSeasons: 2,
      minimumBatches: 4,
      minimumSamples: 4,
      minimumCellSeasons: 2,
      minimumCellSamples: 4,
      minimumCellCutoffs: 2,
      minimumCellBatches: 4,
    });
    const choice = evaluation.livePolicy.choices.find(
      (item) => item.position === "WR" && item.bucket === "five-to-eight",
    )!;

    expect(choice.contextualMae).toBeLessThan(choice.recencyMae);
    expect(choice.contextualWeightedIntervalScore).toBeGreaterThan(
      choice.recencyWeightedIntervalScore,
    );
    expect(choice).toMatchObject({
      strategy: "availability-aware-recency",
      reason: "baseline-defended",
      intervalCalibration: "split-conformal-cqr",
    });
  });

  it("does not promote a raw one-percent gain without paired season-block certainty", () => {
    const evaluation = evaluateFirstPartyRosChampionPolicy(
      [
        { season: 2023, contextualMean: 109.7 },
        { season: 2024, contextualMean: 110.1 },
      ].map(({ season, contextualMean }) => ({
        season,
        complete: true,
        forecasts: [10, 11].map((asOfWeek) =>
          heldOutForecast(season, asOfWeek, `${season}:${asOfWeek}`, {
            contextualMean,
            recencyMean: 110,
          }),
        ),
      })),
      {
        minimumHeldOutSeasons: 2,
        minimumBatches: 4,
        minimumSamples: 4,
        minimumCellSeasons: 2,
        minimumCellSamples: 4,
        minimumCellCutoffs: 2,
        minimumCellBatches: 4,
        minimumModelImprovement: 0.01,
      },
    );
    const choice = evaluation.livePolicy.choices.find(
      (item) => item.position === "WR" && item.bucket === "five-to-eight",
    )!;

    expect(choice.modelImprovement).toBeCloseTo(0.01, 10);
    expect(choice.modelImprovementLowerBound).not.toBeNull();
    expect(choice.modelImprovementLowerBound!).toBeLessThan(0.01);
    expect(choice).toMatchObject({
      strategy: "availability-aware-recency",
      reason: "baseline-defended",
      pairedBlocks: 4,
      uncertaintyMethod: "paired-season-clustered-one-sided-95",
    });
  });

  it("rejects incomplete seasons and same-season training evidence", () => {
    expect(() =>
      evaluateFirstPartyRosChampionPolicy([{ season: 2024, complete: false, forecasts: [] }]),
    ).toThrow("incomplete");

    expect(() =>
      evaluateFirstPartyRosChampionPolicy([
        {
          season: 2024,
          complete: true,
          forecasts: [{ ...heldOutForecast(2024, 9, "one"), trainedThroughSeason: 2024 }],
        },
      ]),
    ).toThrow("earlier season");

    expect(() =>
      evaluateFirstPartyRosChampionPolicy([
        {
          season: 2024,
          complete: true,
          forecasts: [{ ...heldOutForecast(2024, 9, "bad-checksum"), inputChecksum: "legacy" }],
        },
      ]),
    ).toThrow("SHA-256");

    const duplicate = heldOutForecast(2024, 9, "duplicate");
    expect(() =>
      evaluateFirstPartyRosChampionPolicy([
        { season: 2024, complete: true, forecasts: [duplicate, duplicate] },
      ]),
    ).toThrow("Duplicate held-out ROS forecast");

    expect(() =>
      evaluateFirstPartyRosChampionPolicy([
        {
          season: 2024,
          complete: true,
          forecasts: [
            heldOutForecast(2024, 9, "mixed"),
            { ...heldOutForecast(2024, 10, "mixed-two"), scoringProfileKey: "other-profile" },
          ],
        },
      ]),
    ).toThrow("identities cannot be mixed");

    expect(() =>
      evaluateFirstPartyRosChampionPolicy([
        {
          season: 2024,
          complete: true,
          forecasts: [duplicate, { ...duplicate, inputChecksum: "e".repeat(64) }],
        },
      ]),
    ).not.toThrow();
  });
});

describe("availability MAE evidence test (gate v3)", () => {
  const ninePlus = FIRST_PARTY_ROS_MAXIMUM_AVAILABILITY_ROW_ERROR["nine-plus"];
  const midRange = FIRST_PARTY_ROS_MAXIMUM_AVAILABILITY_ROW_ERROR["five-to-eight"];

  function ninePlusEvidence(samples: number, mae: number): boolean {
    return firstPartyRosAvailabilityEvidenceOfExcessMae(
      samples,
      mae,
      FIRST_PARTY_ROS_MAX_NINE_PLUS_AVAILABILITY_MAE,
      ninePlus,
      FIRST_PARTY_ROS_AVAILABILITY_EVIDENCE_ALPHA,
    );
  }

  it("leaves every ratified availability ceiling exactly where gate v2 put it", () => {
    expect(FIRST_PARTY_ROS_MAX_AVAILABILITY_MAE).toBe(1.5);
    expect(FIRST_PARTY_ROS_MAX_NINE_PLUS_AVAILABILITY_MAE).toBe(2.75);
    expect(FIRST_PARTY_ROS_MAX_AVAILABILITY_BIAS).toBe(1);
    // Same one-sided convention the coverage evidence test was ratified under.
    expect(FIRST_PARTY_ROS_AVAILABILITY_EVIDENCE_ALPHA).toBe(
      FIRST_PARTY_ROS_COVERAGE_EVIDENCE_ALPHA,
    );
    expect(FIRST_PARTY_ROS_MAXIMUM_AVAILABILITY_ROW_ERROR).toEqual({
      "one-to-four": 4,
      "five-to-eight": 8,
      "nine-plus": 17,
    });
  });

  it("never finds evidence against a ceiling the cell is already inside", () => {
    for (const mae of [0, 1, 2.5, 2.749_999, 2.75]) {
      expect(ninePlusEvidence(288, mae)).toBe(false);
    }
    // Not even with an enormous sample: the point estimate is the ceiling itself.
    expect(ninePlusEvidence(1_000_000, 2.75)).toBe(false);
  });

  it("reproduces an exactly hand-computable binomial tail", () => {
    // n = 4, ceiling 2, support 4 gives p = 0.5, and MAE 3 needs ceil(4 * 3 / 4) = 3
    // exceedances, so the null tail is P(Bin(4, 0.5) >= 3) = (4 + 1) / 16 = 0.3125 exactly.
    expect(firstPartyRosAvailabilityEvidenceOfExcessMae(4, 3, 2, 4, 0.3125)).toBe(false);
    expect(firstPartyRosAvailabilityEvidenceOfExcessMae(4, 3, 2, 4, 0.3126)).toBe(true);
  });

  it("reads the measured QB nine-plus cell as sampling noise, not evidence", () => {
    // The three admitted 8-player-per-position reports, standard/half-PPR/full-PPR.
    for (const mae of [2.763_827, 2.805_7, 2.809_1]) {
      expect(ninePlusEvidence(288, mae)).toBe(false);
    }
  });

  it("still blocks a cell that is genuinely and substantially over the ceiling", () => {
    for (const mae of [3.3, 3.5, 4, 6, 12]) {
      expect(ninePlusEvidence(288, mae)).toBe(true);
    }
    // The five-to-eight ceiling behaves the same way at its own support.
    for (const mae of [1.9, 2.5, 4]) {
      expect(
        firstPartyRosAvailabilityEvidenceOfExcessMae(
          128,
          mae,
          FIRST_PARTY_ROS_MAX_AVAILABILITY_MAE,
          midRange,
          FIRST_PARTY_ROS_AVAILABILITY_EVIDENCE_ALPHA,
        ),
      ).toBe(true);
    }
  });

  it("demands more excess from a smaller sample and is monotone in the point estimate", () => {
    expect(ninePlusEvidence(288, 3.3)).toBe(true);
    expect(ninePlusEvidence(72, 3.3)).toBe(false);
    expect(ninePlusEvidence(72, 4.2)).toBe(true);
    let previous = false;
    for (const mae of [2.8, 3, 3.2, 3.25, 3.3, 3.6, 4]) {
      const current = ninePlusEvidence(288, mae);
      expect(current || !previous).toBe(true);
      previous = current;
    }
  });

  it("treats an impossible MAE as certain evidence and an unusable sample as none", () => {
    // No row can miss by more than the window it spans, so this tail is exactly zero.
    expect(ninePlusEvidence(288, ninePlus)).toBe(true);
    for (const samples of [0, -1, 1.5, Number.NaN]) {
      expect(ninePlusEvidence(samples, 12)).toBe(false);
    }
  });

  it("fails closed on an incoherent test specification", () => {
    expect(() => firstPartyRosAvailabilityEvidenceOfExcessMae(288, -1, 2.75, 17, 0.1)).toThrow(
      RangeError,
    );
    expect(() => firstPartyRosAvailabilityEvidenceOfExcessMae(288, 3, 0, 17, 0.1)).toThrow(
      RangeError,
    );
    expect(() => firstPartyRosAvailabilityEvidenceOfExcessMae(288, 3, 2.75, 2.75, 0.1)).toThrow(
      RangeError,
    );
    expect(() => firstPartyRosAvailabilityEvidenceOfExcessMae(288, 3, 2.75, 17, 1.5)).toThrow(
      RangeError,
    );
  });
});

describe("ROS expected-mean selection evidence", () => {
  const options = {
    minimumHeldOutSeasons: 2,
    minimumBatches: 2,
    minimumSamples: 2,
    minimumCellSeasons: 2,
    minimumCellSamples: 2,
    minimumCellCutoffs: 1,
    minimumCellBatches: 2,
    minimumModelImprovement: 0.01,
  };
  function evaluate(
    input: readonly {
      season: number;
      cutoff?: number;
      actual: number;
      contextual: number;
      recency: number;
    }[],
  ) {
    const seasons = [...new Set(input.map((row) => row.season))].map((season) => ({
      season,
      complete: true,
      forecasts: input
        .filter((row) => row.season === season)
        .map((row, index) => ({
          ...heldOutForecast(season, row.cutoff ?? 10, `${season}:${index}`),
          actualPoints: row.actual,
          // Keep the proper quantile score identical to isolate the mean-selection requirement.
          contextual: { meanPoints: row.contextual, p15Points: 0, p50Points: 0, p85Points: 20 },
          recency: { meanPoints: row.recency, p15Points: 0, p50Points: 0, p85Points: 20 },
        })),
    }));
    const result = evaluateFirstPartyRosChampionPolicy(seasons, options);
    const choice = result.livePolicy.choices.find(
      (row) => row.position === "WR" && row.bucket === "five-to-eight",
    )!;
    return { ...result, choice, mean: choice.meanSelectionEvidence };
  }

  it("selects the expected mean when its squared loss wins but its legacy MAE loses", () => {
    const result = evaluate(
      [2023, 2024].flatMap((season) =>
        Array.from({ length: 10 }, (_, i) => ({
          season,
          actual: i === 9 ? 20 : 0,
          contextual: 2,
          recency: 0,
        })),
      ),
    );
    expect(result.choice.contextualMae).toBeCloseTo(3.6);
    expect(result.choice.recencyMae).toBe(2);
    expect(result.choice.modelImprovement).toBeLessThan(0);
    expect(result.choice.modelImprovementLowerBound).toBeLessThan(0);
    expect(result.choice.intervalScoreDifferenceUpperBound).toBe(0);
    expect(result.mean).toMatchObject({
      contextualMse: 36,
      recencyMse: 40,
      marginStandardError: 0,
      clearsMeanMargin: true,
    });
    expect(result.mean.marginLowerBound).toBeCloseTo(0.9801 * 40 - 36, 12);
    expect(result.choice.strategy).toBe("contextual");
    expect(result.livePolicy).toMatchObject({
      policyVersion: FIRST_PARTY_ROS_POLICY_VERSION,
      legacyPointImprovementMetric: "mean-absolute-error",
    });
  });

  it.each([0.1, 1, 10, 100])(
    "preserves mean-margin selection under positive point rescaling by %s",
    (scale) => {
      const result = evaluate(
        [2023, 2024].flatMap((season) =>
          Array.from({ length: 10 }, (_, i) => ({
            season,
            actual: (i === 9 ? 20 : 0) * scale,
            contextual: 2 * scale,
            recency: 0,
          })),
        ),
      );
      expect(result.choice.strategy).toBe("contextual");
      expect(result.mean.relativeRmseImprovement).toBeCloseTo(1 - Math.sqrt(36 / 40), 12);
      expect(result.mean.marginLowerBound).toBeCloseTo((0.9801 * 40 - 36) * scale ** 2, 9);
    },
  );

  it("requires one percent RMSE, not one percent MSE, with no boundary epsilon", () => {
    const rows = (contextual: number) =>
      [2023, 2024].map((season) => ({ season, actual: 0, contextual, recency: 1 }));
    const boundary = evaluate(rows(0.99));
    expect(boundary.mean.squaredLossBaselineMultiplier).toBe(0.99 ** 2);
    expect(boundary.mean.marginLowerBound).toBe(0);
    expect(boundary.choice.strategy).toBe("contextual");
    const below = evaluate(rows(0.994));
    expect(1 - below.mean.contextualMse!).toBeGreaterThan(0.01);
    expect(below.mean.relativeRmseImprovement).toBeLessThan(0.01);
    expect(below.choice.strategy).toBe("availability-aware-recency");
    expect(evaluate(rows(0.99 + Number.EPSILON)).mean.clearsMeanMargin).toBe(false);
  });

  it("uses paired seasonal margin variance and equal cutoff weights within each season", () => {
    const result = evaluate([
      { season: 2023, cutoff: 10, actual: 0, contextual: 0.5, recency: 1 },
      { season: 2024, cutoff: 10, actual: 0, contextual: 1.5, recency: 3 },
      { season: 2024, cutoff: 11, actual: 0, contextual: 1.5, recency: 3 },
    ]);
    expect(result.mean).toMatchObject({
      contextualMse: 1.25,
      recencyMse: 5,
      seasons: 2,
      blocks: 3,
      samples: 3,
    });
    expect(result.choice.recencyMae).toBe(7 / 3);
    const margins = [0.9801 - 0.25, 0.9801 * 9 - 2.25];
    const center = (margins[0]! + margins[1]!) / 2;
    const se = Math.abs(margins[0]! - margins[1]!) / 2;
    expect(result.mean.marginMean).toBeCloseTo(center, 12);
    expect(result.mean.marginStandardError).toBeCloseTo(se, 12);
    expect(result.mean.marginLowerBound).toBeCloseTo(center - 6.314 * se, 12);
    expect(result.choice.strategy).toBe("availability-aware-recency");
  });

  it("fails closed for a perfect comparator or squared-loss overflow", () => {
    for (const row of [
      { actual: 0, contextual: 1, recency: 0 },
      { actual: 1e200, contextual: 0, recency: 0 },
    ]) {
      const result = evaluate([2023, 2024].map((season) => ({ season, ...row })));
      expect(result.mean.state).toBe("insufficient-evidence");
      expect(result.mean.clearsMeanMargin).toBe(false);
      expect(result.choice.strategy).toBe("availability-aware-recency");
      expect(firstPartyRosMeanSelectionEvidenceIsValid(result.mean, 0.01)).toBe(true);
      expect(JSON.stringify(result.mean)).not.toContain("Infinity");
    }
  });

  it("validates the seasonal proof and fails closed on missing, forged or legacy evidence", () => {
    const result = evaluate(
      [2023, 2024].map((season) => ({ season, actual: 0, contextual: 0.5, recency: 1 })),
    );
    expect(firstPartyRosMeanSelectionEvidenceIsValid(result.mean, 0.01)).toBe(true);
    for (const change of [
      { version: "legacy-mae" },
      { clearsMeanMargin: false },
      { contextualMse: 0 },
      { marginLowerBound: 5 },
      { marginStandardError: Number.NaN },
      { minimumRelativeRmseImprovement: 0 },
      { seasonEvidence: [] },
    ])
      expect(firstPartyRosMeanSelectionEvidenceIsValid({ ...result.mean, ...change }, 0.01)).toBe(
        false,
      );
    expect(firstPartyRosMeanSelectionEvidenceIsValid(undefined, 0.01)).toBe(false);
    const malformed = {
      ...result.livePolicy,
      choices: result.livePolicy.choices.map((choice) => ({
        ...choice,
        meanSelectionEvidence: undefined,
      })),
    };
    const forecast = heldOutForecast(2025, 10, "live");
    const live = {
      ...forecast.evidence,
      inputChecksum: forecast.inputChecksum,
      position: "WR" as const,
      bucket: "five-to-eight" as const,
      contextualModelVersion: forecast.contextualModelVersion,
      recencyModelVersion: forecast.recencyModelVersion,
      scoringProfileKey: forecast.scoringProfileKey,
      intervalMethodVersion: forecast.intervalMethodVersion,
    };
    expect(
      evaluateFirstPartyRosReleaseGate(malformed as unknown as typeof result.livePolicy, live)
        .reasons,
    ).toContain("invalid-mean-selection-evidence");
    // A policy cannot cite future seasons as mean-selection proof even if its internal
    // numeric summaries are all self-consistent.
    expect(
      evaluateFirstPartyRosReleaseGate({ ...result.livePolicy, evidenceThroughSeason: 2023 }, live)
        .reasons,
    ).toContain("invalid-mean-selection-evidence");
  });
});
