import { describe, expect, it } from "vitest";
import {
  compareMarginalIntervalCell,
  compareMarginalIntervalPortfolio,
  marginalIntervalComparisonIsValid,
  type MarginalIntervalComparisonRow,
  type MarginalIntervalComparisonSeries,
} from "./marginal-interval-comparison.js";
import { projectionScoringProfileKey } from "./scoring.js";

const profile = projectionScoringProfileKey({
  id: "test",
  version: "1",
  rules: [{ statId: "receptions", points: 1 }],
});
const cell = { position: "TE", bucket: "nine-plus" } as const;
function rows(
  position: MarginalIntervalComparisonRow["position"] = "TE",
  error = 0,
): MarginalIntervalComparisonRow[] {
  return [1, 2, 3].flatMap((asOfWeek) =>
    Array.from({ length: asOfWeek }, (_, i) => ({
      playerId: `p${i}`,
      forecastSeason: 2025,
      asOfWeek,
      position,
      windowStartWeek: asOfWeek + 1,
      windowEndWeek: 18,
      scheduledGames: 18 - asOfWeek,
      actualPoints: 10,
      p15Points: 10 + error,
      p50Points: 10 + error,
      p85Points: 10 + error,
    })),
  );
}
function series(values = rows(), previous = false): MarginalIntervalComparisonSeries {
  return {
    source: {
      modelVersion: previous ? "v12" : "v13",
      policyVersion: "frozen-policy",
      scoringProfileKey: profile,
      physicalCorpusChecksum: (previous ? "b" : "a").repeat(64),
      reportChecksum: "c".repeat(64),
    },
    rows: values,
  };
}
function fixture() {
  return {
    evaluationSeason: 2025,
    cell,
    candidate: series(),
    benchmarks: {
      "same-physics-legacy": series(rows("TE", 2)),
      "previous-deployed": series(rows("TE", 3), true),
    },
  };
}
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([k, v]) => [k, reverseKeys(v)]),
    );
  return value;
}

describe("matched marginal WIS comparisons", () => {
  it("requires both complete fixed cell benchmarks and gives each cutoff equal weight", () => {
    const input = fixture();
    input.candidate = series(
      rows().map((r) => ({
        ...r,
        p15Points: 10 + r.asOfWeek,
        p50Points: 10 + r.asOfWeek,
        p85Points: 10 + r.asOfWeek,
      })),
    );
    const result = compareMarginalIntervalCell(input);
    // For a zero-width interval WIS equals absolute error; mean cutoff error is (1+2+3)/3.
    expect(result.candidateWis).toBe(2);
    expect(result.cells[0]!.samples).toBe(6);
    expect(result.state).toBe("passed");
    expect(marginalIntervalComparisonIsValid(result)).toBe(true);
  });

  it("matches identity exactly rather than intersecting or accepting renamed players", () => {
    const input = fixture();
    input.benchmarks["previous-deployed"] = series(
      rows().map((r, i) => (i === 0 ? { ...r, playerId: "replacement" } : r)),
      true,
    );
    expect(() => compareMarginalIntervalCell(input)).toThrow(/cohort/);
  });

  it.each(["actualPoints", "scheduledGames", "windowStartWeek"] as const)(
    "rejects matched-key %s changes",
    (field) => {
      const input = fixture();
      const changed = rows().map((r, i) => (i === 2 ? { ...r, [field]: r[field] - 1 } : r));
      input.benchmarks["previous-deployed"] = series(changed, true);
      expect(() => compareMarginalIntervalCell(input)).toThrow();
    },
  );

  it.each(["missing", "extra", "duplicate"])("rejects %s benchmark rows", (kind) => {
    const input = fixture();
    const values = rows();
    const changed =
      kind === "missing"
        ? values.slice(1)
        : [
            ...values,
            { ...values[0]!, playerId: kind === "extra" ? "extra" : values[0]!.playerId },
          ];
    input.benchmarks["previous-deployed"] = series(changed, true);
    expect(() => compareMarginalIntervalCell(input)).toThrow();
  });

  it.each(["same-physics-legacy", "previous-deployed"] as const)(
    "requires %s and rejects undeclared benchmarks",
    (name) => {
      const input = fixture();
      const partial = { ...input.benchmarks } as Record<string, unknown>;
      delete partial[name];
      expect(() =>
        compareMarginalIntervalCell({ ...input, benchmarks: partial as typeof input.benchmarks }),
      ).toThrow();
      expect(() =>
        compareMarginalIntervalCell({
          ...input,
          benchmarks: { ...input.benchmarks, extra: series() } as typeof input.benchmarks,
        }),
      ).toThrow();
    },
  );

  it("does not permit physical or scoring mismatches under a same-physics label", () => {
    const input = fixture();
    const benchmark = input.benchmarks["same-physics-legacy"];
    for (const source of [
      { ...benchmark.source, modelVersion: "different" },
      { ...benchmark.source, physicalCorpusChecksum: "f".repeat(64) },
      {
        ...benchmark.source,
        scoringProfileKey: projectionScoringProfileKey({
          id: "other",
          version: "1",
          rules: [{ statId: "receptions", points: 0.5 }],
        }),
      },
    ])
      expect(() =>
        compareMarginalIntervalCell({
          ...input,
          benchmarks: { ...input.benchmarks, "same-physics-legacy": { ...benchmark, source } },
        }),
      ).toThrow();
  });

  it("has no numerical tolerance or rounded-score rescue", () => {
    const input = fixture();
    input.candidate = series(rows("TE", 2 + 1e-12));
    const result = compareMarginalIntervalCell(input);
    expect(result.state).toBe("failed");
    expect(result.worseThan).toEqual(["same-physics-legacy"]);
    expect(marginalIntervalComparisonIsValid(result)).toBe(true);
  });

  it("preserves tied and negative quantiles, and scores the supplied median", () => {
    const input = fixture();
    const negative = rows().map((r) => ({
      ...r,
      actualPoints: -5,
      p15Points: -10,
      p50Points: -5,
      p85Points: -5,
    }));
    input.candidate = series(negative);
    input.benchmarks = {
      "same-physics-legacy": series(negative.map((r) => ({ ...r, p50Points: -10 }))),
      "previous-deployed": series(negative, true),
    };
    const result = compareMarginalIntervalCell(input);
    expect(result.candidateWis).toBe(0.5);
    expect(result.benchmarkWis["same-physics-legacy"]).toBeGreaterThan(result.candidateWis);
    expect(result.state).toBe("passed");
  });

  it.each([
    { scheduledGames: 0 },
    { scheduledGames: 0.5 },
    { scheduledGames: 18 },
    { forecastSeason: 2024 },
    { p50Points: NaN },
    { p85Points: Infinity },
    { p15Points: 11 },
  ])("rejects invalid or unscored candidate evidence %j", (mutation) => {
    const input = fixture();
    input.candidate = series(rows().map((r, i) => (i === 0 ? { ...r, ...mutation } : r)));
    expect(() => compareMarginalIntervalCell(input)).toThrow();
  });

  it("is stable under row and JSONB key reordering but binds all triples and provenance", () => {
    const input = fixture();
    const result = compareMarginalIntervalCell(input);
    expect(marginalIntervalComparisonIsValid(reverseKeys(result))).toBe(true);
    expect(
      compareMarginalIntervalCell({ ...input, candidate: series([...rows()].reverse()) }),
    ).toEqual(result);
    const shifted = compareMarginalIntervalCell({
      ...input,
      candidate: series(rows().map((r) => ({ ...r, p15Points: r.p15Points - 1 }))),
    });
    expect(shifted.evidenceChecksum).not.toBe(result.evidenceChecksum);
    expect(shifted.cells[0]!.cohortChecksum).toBe(result.cells[0]!.cohortChecksum);
    expect(shifted.cells[0]!.blocks[0]!.rowsChecksum).not.toBe(
      result.cells[0]!.blocks[0]!.rowsChecksum,
    );
    const sourceChanged = compareMarginalIntervalCell({
      ...input,
      candidate: {
        ...input.candidate,
        source: { ...input.candidate.source, reportChecksum: "d".repeat(64) },
      },
    });
    expect(sourceChanged.evidenceChecksum).not.toBe(result.evidenceChecksum);
  });

  it.each([
    (r: Record<string, unknown>) => {
      r.state = "failed";
    },
    (r: Record<string, unknown>) => {
      r.candidateWis = 100;
    },
    (r: Record<string, unknown>) => {
      r.evaluationSeason = 2024;
    },
    (r: Record<string, unknown>) => {
      r.scope = "anything";
    },
    (r: Record<string, unknown>) => {
      r.extra = true;
    },
    (r: Record<string, unknown>) => {
      r.cells = [];
    },
    (r: Record<string, unknown>) => {
      r.benchmarkWis = {};
    },
  ])("rejects tampered compact receipt %#", (mutate) => {
    const result = structuredClone(compareMarginalIntervalCell(fixture())) as unknown as Record<
      string,
      unknown
    >;
    mutate(result);
    expect(marginalIntervalComparisonIsValid(result)).toBe(false);
  });

  it("weights portfolio cells equally and retains worse individual cells", () => {
    const cells = [cell, { position: "WR", bucket: "nine-plus" }] as const;
    const candidate = [
      ...rows("TE", 4),
      ...rows("WR", 0).flatMap((r) =>
        Array.from({ length: 10 }, (_, i) => ({ ...r, playerId: `${r.playerId}-${i}` })),
      ),
    ];
    const legacy = candidate.map((r) => ({ ...r, p15Points: 12, p50Points: 12, p85Points: 12 }));
    const input = {
      evaluationSeason: 2025,
      cells,
      candidate: series(candidate),
      benchmarks: {
        "same-physics-raw": series(legacy),
        "same-physics-legacy": series(legacy),
        "previous-raw": series(legacy, true),
        "previous-deployed": series(legacy, true),
      },
    };
    const result = compareMarginalIntervalPortfolio(input);
    expect(result.candidateWis).toBe(2);
    expect(result.state).toBe("passed");
    expect(result.cells[0]!.worseThan).toHaveLength(4);
    expect(marginalIntervalComparisonIsValid(result)).toBe(true);
    expect(() =>
      compareMarginalIntervalPortfolio({
        ...input,
        cells: [...cells, { position: "QB", bucket: "nine-plus" }],
      }),
    ).toThrow(/required cell/);
    expect(() => compareMarginalIntervalPortfolio({ ...input, cells: [cell, cell] })).toThrow(
      /duplicate/,
    );
    expect(() =>
      compareMarginalIntervalPortfolio({
        ...input,
        benchmarks: { ...input.benchmarks, "previous-raw": series(legacy) },
      }),
    ).toThrow(/corpus mismatch/);
  });
});
