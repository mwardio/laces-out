import { describe, expect, it } from "vitest";

import {
  FIRST_PARTY_ROS_MODEL_VERSION,
  applyFirstPartyRosIntervalCalibration,
  diagnoseFirstPartyRosConvergence,
  evaluateFirstPartyRosChampionPolicy,
  evaluateFirstPartyRosReleaseGate,
  projectFirstPartyRestOfSeason,
  type FirstPartyRosHeldOutForecast,
  type FirstPartyRosProjectionInput,
  type FirstPartyRosWeeklyScenarioInput,
} from "./rest-of-season.js";

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

describe("first-party ROS distribution", () => {
  it("is deterministic for pinned inputs and independent of week order", () => {
    const input = projectionInput();
    const forward = projectFirstPartyRestOfSeason(input);
    const reverse = projectFirstPartyRestOfSeason({ ...input, weeks: [...input.weeks].reverse() });

    expect(reverse).toEqual(forward);
    expect(forward.provenance.modelVersion).toBe(FIRST_PARTY_ROS_MODEL_VERSION);
    expect(forward.provenance.intervalCalibration).toBe("simulation-only");
    // The seed material embeds FIRST_PARTY_ROS_MODEL_VERSION, so this pinned digest necessarily
    // changed with the v3 -> v4 model version bump.
    expect(forward.provenance.seedHash).toBe(
      "26c02a1b0d54736ae2da198b64e058d33d41d0560ee53eae4c9e9844ee4501ce",
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
    const result = projectFirstPartyRestOfSeason(
      projectionInput({
        position: "K",
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

describe("season-locked ROS champion policy", () => {
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
