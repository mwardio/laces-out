import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  evaluateRosNumericalReplication,
  ROS_NUMERICAL_REPLICATION_VERSION,
  rosNumericalReplicationMatchesVectors,
  type RosNumericalReplicationInput,
} from "./ros-numerical-replication.js";
import {
  evaluateFirstPartyRosConvergence,
  FIRST_PARTY_ROS_MODEL_VERSION,
} from "./rest-of-season.js";
import {
  FIRST_PARTY_ROS_OUTCOME_SCHEMA_VERSION,
  scoreFirstPartyRosOutcomesWithSamples,
  type FirstPartyRosOutcomeEnsemble,
} from "./ros-outcomes.js";
import { projectionScoringProfileKey } from "./scoring.js";

const N = 16_384;
const P = 12_288;
const S = N - P;
const profile = { id: "numerical-fixture", rules: [{ statId: "sacks", points: 1 }] };

function input(scores: readonly number[] | Float64Array = Array<number>(N).fill(0)) {
  return {
    position: "DST",
    scheduledGames: 1,
    scores,
    games: new Uint8Array(N).fill(1),
    provenance: {
      modelVersion: FIRST_PARTY_ROS_MODEL_VERSION,
      scorerVersion: "deterministic-numerical-test-v1",
      scoringProfileKey: projectionScoringProfileKey(profile),
      inputChecksum: "a".repeat(64),
      seedHash: "b".repeat(64),
      vectorChecksum: "c".repeat(64),
    },
    familySize: 24,
    familyErrorBudget: 0.05,
  } satisfies RosNumericalReplicationInput;
}

function histogram(...entries: readonly [number, number][]): number[] {
  return entries.flatMap(([score, count]) => Array<number>(count).fill(score));
}

function binary(prefixZeros: number, suffixZeros: number, high = 1): number[] {
  return [
    ...histogram([0, prefixZeros], [high, P - prefixZeros]),
    ...histogram([0, suffixZeros], [high, S - suffixZeros]),
  ];
}

function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, child]) => [key, reverseKeys(child)]),
    );
  return value;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

describe("candidate empirical ROS numerical replication", () => {
  it("preserves the complete scalar diagnostic and exposes a 100-point median flip separately", () => {
    const source = input(binary(6143, 2050, 100));
    const result = evaluateRosNumericalReplication(source);
    expect(result.version).toBe(ROS_NUMERICAL_REPLICATION_VERSION);
    expect(result.operational.state).toBe("within-tolerance");
    expect(result.measurement.prefixVsFull).toMatchObject({ numerator: 7, denominator: 49_152 });
    expect(result.summaries.release.p50Points).toBe(100);
    expect(result.summaries.reference.p50Points).toBe(0);
    expect(result.legacyDiagnostic).toEqual(
      evaluateFirstPartyRosConvergence({ position: "DST", ...result.summaries }),
    );
    expect(result.legacyDiagnostic.state).toBe("unstable");
    expect(result.legacyDiagnostic.worstMetric).toBe("p50Points");
    expect(result.legacyDiagnostic.worstToleranceRatio).toBeGreaterThan(100);
    expect(result.pointSensitivity).toMatchObject({
      state: "legacy-quantile-sensitive",
      legacyFailedQuantiles: ["p50Points"],
    });
    expect(result.pointSensitivity.quantiles[1]).toMatchObject({
      empiricalPointEstimateChanged: true,
      rawInverseCdfIdentificationSpan: { full: { kind: "finite", points: 100 } },
    });
    expect(result.canAuthorizeRelease).toBe(false);
    expect(result.canAuthorizeModelAdoption).toBe(false);
  });

  it("rejects a shape shift with exactly unchanged means and all three legacy quantiles", () => {
    const source = input([
      ...histogram([0, 6144], [2, 6144]),
      ...histogram([0, 1536], [1, 1024], [2, 1536]),
    ]);
    const result = evaluateRosNumericalReplication(source);
    expect(result.legacyDiagnostic.state).toBe("converged");
    expect(result.legacyDiagnostic.metrics.every((metric) => metric.absoluteDifference === 0)).toBe(
      true,
    );
    expect(result.measurement.prefixVsFull).toMatchObject({ numerator: 1, denominator: 32 });
    expect(result.operational).toMatchObject({
      state: "outside-tolerance",
      failures: ["prefix-full-cdf-ceiling"],
    });
  });

  it("rejects the equal-mean counterexample that defeats a one-atom quantile floor", () => {
    const result = evaluateRosNumericalReplication(
      input([
        ...histogram([0, 6141], [1, 6144], [2, 3]),
        ...histogram([0, 3072], [2, 1023], [4, 1]),
      ]),
    );
    expect(result.summaries.release.meanPoints).toBe(1025 / 2048);
    expect(result.summaries.reference.meanPoints).toBe(1025 / 2048);
    expect(result.measurement.prefixVsFull).toMatchObject({ numerator: 1025, denominator: 16_384 });
    expect(result.operational.failures).toEqual(["prefix-full-cdf-ceiling"]);
    expect(result.pointSensitivity.legacyFailedQuantiles).toEqual(["p50Points"]);
  });

  it.each([
    [6143, 491 / 49_152, "within-tolerance"],
    [6144, 492 / 49_152, "outside-tolerance"],
  ] as const)(
    "uses exact attainable CDF threshold neighbors (%i zeros)",
    (zeros, distance, state) => {
      const result = evaluateRosNumericalReplication(input(binary(zeros, 1884)));
      expect(result.measurement.prefixVsFull.fraction).toBe(distance);
      expect(result.operational.state).toBe(state);
      expect(result.legacyDiagnostic.state).toBe("converged");
      expect(result.operational.cdfCeiling).toEqual({ numerator: 1, denominator: 100 });
    },
  );

  it("retains mean failure for a tiny-probability large score", () => {
    const scores = Array<number>(N).fill(0);
    scores[N - 1] = 1_000_000;
    const result = evaluateRosNumericalReplication(input(scores));
    expect(result.operational.withinCdfCeiling).toBe(true);
    expect(result.operational.failures).toEqual(["mean-points-tolerance"]);
    expect(result.summaries.reference.meanPoints).toBe(1_000_000 / N);
    expect(result.pointSensitivity.legacyFailedQuantiles).toEqual([]);
  });

  it("retains expected-games failure even when every score agrees", () => {
    const source = input();
    source.games.fill(0, P);
    const result = evaluateRosNumericalReplication(source);
    expect(result.operational.failures).toEqual(["expected-games-tolerance"]);
    expect(result.summaries.release.expectedGames).toBe(1);
    expect(result.summaries.reference.expectedGames).toBe(0.75);
    expect(result.operational.expectedGames.allowedDifference).toBe(0.1);
  });

  it("does not pretend the operational rule detects every rare, balanced tail change", () => {
    const result = evaluateRosNumericalReplication(
      input([...histogram([0, P]), ...histogram([-1_000_000, 41], [0, 4014], [1_000_000, 41])]),
    );
    expect(result.operational.state).toBe("within-tolerance");
    expect(result.legacyDiagnostic.state).toBe("converged");
    expect(result.measurement.prefixVsFull).toMatchObject({ numerator: 41, denominator: N });
    expect(result.purpose).toBe("candidate-empirical-replication-only");
    expect(result.sourceAuthentication).toBe("caller-responsibility-not-authenticated");
  });

  it.each([0, -7, 0.125, 400])(
    "supports a constant %s score without new precision claims",
    (score) => {
      const result = evaluateRosNumericalReplication(input(new Float64Array(N).fill(score)));
      expect(result.operational.state).toBe("within-tolerance");
      expect(result.summaries.release.meanPoints).toBe(score);
      expect(
        result.legacyDiagnostic.metrics.every((metric) => metric.absoluteDifference === 0),
      ).toBe(true);
      expect(result.measurement.prefixVsFull.numerator).toBe(0);
    },
  );

  it.each([0.25, -0.25, 100])("retains affine CDF invariance for multiplier %s", (scale) => {
    const base = binary(6144, 1884);
    const result = evaluateRosNumericalReplication(input(base.map((value) => scale * value - 7)));
    expect(result.measurement.prefixVsFull.fraction).toBe(492 / 49_152);
    expect(result.operational.withinCdfCeiling).toBe(false);
  });

  it("keeps differing fixed left/right laws and inverse-CDF uncertainty honest", () => {
    const result = evaluateRosNumericalReplication(
      input(Array.from({ length: N }, (_, index) => (index % 2 === 0 ? 0 : 100))),
    );
    expect(result.operational.state).toBe("within-tolerance");
    expect(result.summaries.release.p50Points).toBe(50);
    expect(result.pointSensitivity.quantiles[1]).toMatchObject({
      empiricalPointEstimateChanged: false,
      rawInverseCdfIdentificationSpan: { full: { kind: "finite", points: 100 } },
    });
    expect(result.measurement.precision.target).toBe("fixed-simulator-pair-mixture-distribution");
  });

  it("leaves the original kicker exception solely in the preserved scalar diagnostic", () => {
    const source = input(binary(6143, 2050));
    const dst = evaluateRosNumericalReplication(source);
    const kicker = evaluateRosNumericalReplication({ ...source, position: "K" });
    expect(dst.operational.state).toBe("within-tolerance");
    expect(kicker.operational.state).toBe("within-tolerance");
    expect(dst.legacyDiagnostic.state).toBe("unstable");
    expect(kicker.legacyDiagnostic.state).toBe("converged");
    expect(kicker.pointSensitivity.quantiles[1]!.legacyMetric.allowedDifference).toBe(1);
    expect(dst.pointSensitivity.quantiles[1]!.legacyMetric.allowedDifference).toBe(0.75);
  });

  it("allows zero scheduled support only with zero game counts", () => {
    const source = { ...input(), scheduledGames: 0, games: new Uint8Array(N) };
    expect(evaluateRosNumericalReplication(source).summaries.reference.expectedGames).toBe(0);
    source.games[N - 1] = 1;
    expect(() => evaluateRosNumericalReplication(source)).toThrow(/scheduled support/);
  });

  it("preserves unbounded precision endpoints without turning them into an operational gate", () => {
    const result = evaluateRosNumericalReplication({
      ...input(),
      familySize: Number.MAX_SAFE_INTEGER,
      familyErrorBudget: Number.MIN_VALUE,
    });
    expect(result.operational.state).toBe("within-tolerance");
    expect(result.pointSensitivity.quantiles[0]!.rawInverseCdfIdentificationSpan.full).toEqual({
      kind: "unbounded",
    });
  });

  it("represents overflowing point spans explicitly while preserving finite endpoint values", () => {
    const scores: number[] = Array.from({ length: N }, (_, index) =>
      index % 2 === 0 ? -1e308 : 1e308,
    );
    scores[0] = 0;
    scores[1] = 0;
    const result = evaluateRosNumericalReplication(input(scores));
    expect(result.summaries.release.p50Points).toBe(0);
    expect(result.summaries.reference.p50Points).toBe(0);
    expect(result.pointSensitivity.quantiles[1]!.rawInverseCdfIdentificationSpan.full).toEqual({
      kind: "exceeds-finite-range",
    });
    expect(
      rosNumericalReplicationMatchesVectors(JSON.parse(JSON.stringify(result)), input(scores)),
    ).toBe(true);
  });

  it("matches the existing validated outcome scorer's complete five-scalar summaries exactly", () => {
    const games = Uint8Array.from({ length: N }, (_, index) => (index % 19 === 0 ? 0 : 1));
    const scoring = {
      id: "fractional-negative-components",
      rules: [
        { statId: "receiving_yards", points: -0.13 },
        { statId: "receptions", points: 1.3 },
      ],
    };
    const source = input();
    const ensemble: FirstPartyRosOutcomeEnsemble = {
      schemaVersion: FIRST_PARTY_ROS_OUTCOME_SCHEMA_VERSION,
      modelVersion: FIRST_PARTY_ROS_MODEL_VERSION,
      scenarioCount: N,
      columns: {
        receiving_yards: Float64Array.from(
          games,
          (game, index) => game * (((index * 37) % 171) / 4),
        ),
        receptions: Float64Array.from(games, (game, index) => game * (index % 7)),
      },
      games,
      metadata: {
        playerId: "synthetic-components-no-football-simulation",
        position: "WR",
        scheduledGames: 1,
        provenance: {
          modelVersion: FIRST_PARTY_ROS_MODEL_VERSION,
          strategy: "contextual",
          weeklyModelVersion: "fixed-components-v1",
          inputChecksum: source.provenance.inputChecksum,
          seedHash: source.provenance.seedHash,
          randomGenerator: "xoshiro128**-sha256-128",
          scenarioCount: N,
          season: 2025,
          asOfWeek: 17,
          asOfAt: "2025-12-25T00:00:00.000Z",
          windowStartWeek: 18,
          windowEndWeek: 18,
          intervalCalibration: "simulation-only",
        },
        simulation: {
          availabilityLagOneCorrelation: null,
          roleLagOneCorrelation: null,
          boundedRoleSamples: 0,
        },
        diagnostics: [],
      },
    };
    const full = scoreFirstPartyRosOutcomesWithSamples(ensemble, scoring);
    const prefix = scoreFirstPartyRosOutcomesWithSamples(ensemble, scoring, P);
    const result = evaluateRosNumericalReplication({
      ...source,
      position: "WR",
      games,
      scores: full.samples,
      provenance: { ...source.provenance, scoringProfileKey: full.summary.scoringProfileKey },
    });
    for (const [expected, actual] of [
      [prefix.summary, result.summaries.release],
      [full.summary, result.summaries.reference],
    ] as const)
      for (const field of Object.keys(actual) as Array<keyof typeof actual>)
        expect(actual[field]).toBe(expected[field]);
    expect(result.legacyDiagnostic).toEqual(
      evaluateFirstPartyRosConvergence({
        position: "WR",
        release: prefix.summary,
        reference: full.summary,
      }),
    );
    expect(full.samples.slice(0, P)).toEqual(prefix.samples);
  });

  it("copies aliased input vectors without mutation or retained caller references", () => {
    const shared = Array<number>(N).fill(1);
    const source = { ...input(shared), games: shared };
    const result = evaluateRosNumericalReplication(source);
    const serialized = JSON.stringify(result);
    expect(shared.every((value) => value === 1)).toBe(true);
    shared.fill(0);
    source.provenance.seedHash = "d".repeat(64);
    expect(JSON.stringify(result)).toBe(serialized);
    expect(rosNumericalReplicationMatchesVectors(result, source)).toBe(false);
  });

  it("captures score entries once so later reads cannot change the derived summaries", () => {
    const scores = Array<number>(N).fill(1);
    let reads = 0;
    Object.defineProperty(scores, 0, {
      enumerable: true,
      configurable: true,
      get: () => (++reads === 1 ? 2 : 100),
    });
    const result = evaluateRosNumericalReplication(input(scores));
    expect(reads).toBe(1);
    expect(result.summaries.release.meanPoints).toBe((P + 1) / P);
    expect(result.summaries.reference.meanPoints).toBe((N + 1) / N);
  });

  it("does not alias operational metric objects into the preserved legacy result", () => {
    const result = evaluateRosNumericalReplication(input());
    const legacy = JSON.stringify(result.legacyDiagnostic);
    (result.operational.meanPoints as { releaseValue: number }).releaseValue = 999;
    expect(JSON.stringify(result.legacyDiagnostic)).toBe(legacy);
  });

  it("binds ordered games even when rearrangement leaves every summary unchanged", () => {
    const source = input();
    source.games[0] = 0;
    const result = evaluateRosNumericalReplication(source);
    [source.games[0], source.games[1]] = [source.games[1]!, source.games[0]];
    const reordered = evaluateRosNumericalReplication(source);
    expect(reordered.summaries).toEqual(result.summaries);
    expect(reordered.measurement).toEqual(result.measurement);
    expect(reordered.gamesVectorChecksum).not.toBe(result.gamesVectorChecksum);
    expect(rosNumericalReplicationMatchesVectors(result, source)).toBe(false);
  });

  it("binds original score order even when within-prefix rearrangement leaves scalar/CDF results unchanged", () => {
    const scores = binary(6143, 2050, 100);
    const source = input(scores);
    const result = evaluateRosNumericalReplication(source);
    [scores[0], scores[6143]] = [scores[6143]!, scores[0]!];
    const reordered = evaluateRosNumericalReplication(source);
    expect(reordered.summaries).toEqual(result.summaries);
    expect(reordered.measurement.prefixVsFull).toEqual(result.measurement.prefixVsFull);
    expect(reordered.measurement.scoreVectorChecksum).not.toBe(
      result.measurement.scoreVectorChecksum,
    );
    expect(rosNumericalReplicationMatchesVectors(result, source)).toBe(false);
  });

  it("accepts canonical JSONB key ordering and rejects changed evidence, context and fields", () => {
    const source = input(binary(6143, 2050, 100));
    const result = evaluateRosNumericalReplication(source);
    expect(rosNumericalReplicationMatchesVectors(reverseKeys(result), source)).toBe(true);
    expect(rosNumericalReplicationMatchesVectors(JSON.parse(JSON.stringify(result)), source)).toBe(
      true,
    );
    const changed = structuredClone(result);
    (changed.legacyDiagnostic as { state: string }).state = "converged";
    expect(rosNumericalReplicationMatchesVectors(changed, source)).toBe(false);
    expect(rosNumericalReplicationMatchesVectors({ ...result, extra: true }, source)).toBe(false);
    expect(rosNumericalReplicationMatchesVectors(result, { ...source, familySize: 25 })).toBe(
      false,
    );
    expect(rosNumericalReplicationMatchesVectors(result, { ...source, scheduledGames: 2 })).toBe(
      false,
    );
    expect(rosNumericalReplicationMatchesVectors(result, { ...source, position: "K" })).toBe(false);
    expect(
      rosNumericalReplicationMatchesVectors(result, {
        ...source,
        provenance: { ...source.provenance, vectorChecksum: "d".repeat(64) },
      }),
    ).toBe(false);
    const { evidenceChecksum, ...body } = result;
    expect(createHash("sha256").update(canonical(body)).digest("hex")).toBe(evidenceChecksum);
  });

  it.each([
    ["short scores", (value: RosNumericalReplicationInput) => ({ ...value, scores: [0] })],
    [
      "odd scores",
      (value: RosNumericalReplicationInput) => ({ ...value, scores: Array<number>(N - 1).fill(0) }),
    ],
    ["short games", (value: RosNumericalReplicationInput) => ({ ...value, games: [0] })],
    ["unknown field", (value: RosNumericalReplicationInput) => ({ ...value, releaseSummary: {} })],
    ["bad position", (value: RosNumericalReplicationInput) => ({ ...value, position: "DEF" })],
    [
      "fractional schedule",
      (value: RosNumericalReplicationInput) => ({ ...value, scheduledGames: 0.5 }),
    ],
    ["large schedule", (value: RosNumericalReplicationInput) => ({ ...value, scheduledGames: 19 })],
    ["zero family", (value: RosNumericalReplicationInput) => ({ ...value, familySize: 0 })],
    ["zero alpha", (value: RosNumericalReplicationInput) => ({ ...value, familyErrorBudget: 0 })],
    ["unit alpha", (value: RosNumericalReplicationInput) => ({ ...value, familyErrorBudget: 1 })],
    [
      "bad provenance",
      (value: RosNumericalReplicationInput) => ({
        ...value,
        provenance: { ...value.provenance, seedHash: "bad" },
      }),
    ],
  ] as const)("rejects %s", (_, mutate) => {
    expect(() =>
      evaluateRosNumericalReplication(mutate(input()) as RosNumericalReplicationInput),
    ).toThrow();
  });

  it.each([NaN, Infinity, -Infinity])(
    "rejects nonfinite score %s anywhere, including the suffix",
    (value) => {
      const scores = Array<number>(N).fill(0);
      scores[N - 1] = value;
      expect(() => evaluateRosNumericalReplication(input(scores))).toThrow(/finite/);
    },
  );

  it.each([-1, 0.5, 2, NaN, Infinity])("rejects invalid games %s", (value) => {
    const games = Array<number>(N).fill(1);
    games[N - 1] = value;
    expect(() => evaluateRosNumericalReplication({ ...input(), games })).toThrow();
  });

  it("rejects sparse and extra-property vectors", () => {
    const scores = Array<number>(N).fill(0);
    Reflect.deleteProperty(scores, 1);
    expect(() => evaluateRosNumericalReplication(input(scores))).toThrow(/dense/);
    scores[1] = 0;
    Object.assign(scores, { extra: 0 });
    expect(() => evaluateRosNumericalReplication(input(scores))).toThrow(/dense/);
    const games = Array<number>(N).fill(1);
    Reflect.deleteProperty(games, N - 1);
    expect(() => evaluateRosNumericalReplication({ ...input(), games })).toThrow(/dense/);
  });

  it("rejects finite scores whose original-order mean arithmetic overflows", () => {
    expect(() => evaluateRosNumericalReplication(input(new Float64Array(N).fill(1e308)))).toThrow(
      /mean/,
    );
  });
});
