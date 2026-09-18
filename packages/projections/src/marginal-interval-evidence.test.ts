import { describe, expect, it } from "vitest";
import {
  MARGINAL_INTERVAL_EVIDENCE_MAX_ROWS,
  buildMarginalIntervalEvidence,
  evaluateMarginalIntervalEvidence,
  validateMarginalIntervalEvidence,
  type MarginalIntervalEvaluationRow,
} from "./marginal-interval-evidence.js";

const seriesKey = "v13:exact-full-ppr:TE:nine-plus:contextual";

function row(
  index: number,
  overrides: Partial<MarginalIntervalEvaluationRow> = {},
): MarginalIntervalEvaluationRow {
  const asOfWeek = Math.floor(index / 6) + 1;
  return {
    seriesKey,
    identity: `row-${index}`,
    playerId: `player-${index % 6}`,
    forecastSeason: 2023,
    asOfWeek,
    windowStartWeek: asOfWeek + 1,
    windowEndWeek: 18,
    scheduledGames: 4,
    actualPoints: 0,
    p15Points: -10,
    p50Points: 0,
    p85Points: 10,
    rawQuantiles: { p15Points: -5, p50Points: 1, p85Points: 5 },
    artifactChecksum: "a".repeat(64),
    trainedThroughSeason: 2022,
    ...overrides,
  };
}

function rows(count = 18): MarginalIntervalEvaluationRow[] {
  return Array.from({ length: count }, (_, index) => row(index));
}

function build(input = rows()) {
  return buildMarginalIntervalEvidence({ seriesKey, rows: input });
}

function reorderedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reorderedJson);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, child]) => [key, reorderedJson(child)]),
    );
  return value;
}

/** Three equally weighted cutoffs with an identical exact event mix. */
function eventMix(inside: number, below: number, above: number): MarginalIntervalEvaluationRow[] {
  const size = inside + below + above;
  return Array.from({ length: size * 3 }, (_, index) => {
    const asOfWeek = Math.floor(index / size) + 1;
    const within = index % size;
    return row(index, {
      playerId: `player-${within}`,
      asOfWeek,
      windowStartWeek: asOfWeek + 1,
      actualPoints: within < inside ? 0 : within < inside + below ? -20 : 20,
    });
  });
}

describe("marginal interval descriptive evidence", () => {
  it("reconstructs exact coverage, endpoint ties and proper scores without claiming admission", () => {
    const evidence = build();
    expect(evidence.overall).toMatchObject({
      seasons: 1,
      blocks: 3,
      samples: 18,
      distinctCutoffs: 3,
    });
    expect(evidence.overall.metrics).toMatchObject({
      coverage: { numerator: "1", denominator: "1" },
      lowerTail: { numerator: "0", denominator: "1" },
      upperTail: { numerator: "0", denominator: "1" },
      endpointFractions: [
        {
          below: { numerator: "0", denominator: "1" },
          equal: { numerator: "0", denominator: "1" },
          above: { numerator: "1", denominator: "1" },
        },
        {
          below: { numerator: "0", denominator: "1" },
          equal: { numerator: "1", denominator: "1" },
          above: { numerator: "0", denominator: "1" },
        },
        {
          below: { numerator: "1", denominator: "1" },
          equal: { numerator: "0", denominator: "1" },
          above: { numerator: "0", denominator: "1" },
        },
      ],
      wis: 2,
      intervalScore: 20,
      width: 20,
    });
    expect(evidence.overall.metrics!.rawWis).toBeCloseTo(4 / 3, 14);
    expect(evidence.overall.metrics!.pinball[0]).toBeCloseTo(1.5, 14);
    expect(evidence.overall.metrics!.pinball[1]).toBe(0);
    expect(evidence.overall.metrics!.pinball[2]).toBeCloseTo(1.5, 14);
    expect(evidence.descriptive.leaveOneSeasonOut).toEqual([]);
    expect(evaluateMarginalIntervalEvidence(evidence)).toMatchObject({
      state: "descriptive-screen-passed",
      reasons: [],
    });
    // Worse WIS than the raw comparator is visible, and intentionally is not this screen's gate.
    expect(evidence.overall.metrics!.wis).toBeGreaterThan(evidence.overall.metrics!.rawWis);
    expect(evidence.interpretation).toBe("overlapping-outcomes-descriptive-only");
    expect(evidence).not.toHaveProperty("admitted");
    expect(evidence).not.toHaveProperty("confidenceInterval");
  });

  it("weights seasons, cutoffs and players equally at their own levels, not pooled rows", () => {
    const fixture = [
      ...Array.from({ length: 6 }, (_, index) =>
        row(index, { asOfWeek: 1, windowStartWeek: 2, actualPoints: -20 }),
      ),
      row(6, { asOfWeek: 2, windowStartWeek: 3, actualPoints: 0 }),
      row(7, { asOfWeek: 3, windowStartWeek: 4, actualPoints: 0 }),
      ...Array.from({ length: 18 }, (_, index) =>
        row(index, {
          identity: `next-${index}`,
          forecastSeason: 2024,
          trainedThroughSeason: 2023,
          artifactChecksum: "b".repeat(64),
          actualPoints: 0,
        }),
      ),
    ];
    const evidence = build(fixture);
    expect(evidence.overall.metrics!.coverage).toEqual({ numerator: "5", denominator: "6" });
    expect(evidence.overall.metrics!.lowerTail).toEqual({ numerator: "1", denominator: "6" });
    expect(evidence.perSeason[0]!.metrics!.coverage).toEqual({ numerator: "2", denominator: "3" });
    expect(evidence.perSeason[1]!.metrics!.coverage).toEqual({ numerator: "1", denominator: "1" });
    expect(evidence.descriptive.seasonRange!.coverage[0]).toBeCloseTo(2 / 3, 15);
    expect(evidence.descriptive.seasonRange!.coverage[1]).toBe(1);
    expect(
      evidence.descriptive.leaveOneSeasonOut.map((entry) => [
        entry.excludedSeason,
        entry.metrics!.coverage,
      ]),
    ).toEqual([
      [2023, { numerator: "1", denominator: "1" }],
      [2024, { numerator: "2", denominator: "3" }],
    ]);
  });

  it("is deterministic under row ordering and JSONB object-key reordering", () => {
    const forward = build();
    expect(build(rows().reverse())).toEqual(forward);
    const jsonb = JSON.parse(JSON.stringify(reorderedJson(forward))) as unknown;
    expect(validateMarginalIntervalEvidence(jsonb)).toEqual(forward);
    expect(evaluateMarginalIntervalEvidence(jsonb)).toEqual(
      evaluateMarginalIntervalEvidence(forward),
    );
  });

  it("binds source identities, raw quantiles, fit identity, scale and outcome to the checksum", () => {
    const reference = build();
    const changes: Partial<MarginalIntervalEvaluationRow>[] = [
      { identity: "changed" },
      { playerId: "different-player" },
      { scheduledGames: 3 },
      { actualPoints: 0.25 },
      { rawQuantiles: { p15Points: -6, p50Points: 1, p85Points: 5 } },
    ];
    for (const changed of changes) {
      const fixture = rows();
      fixture[0] = { ...fixture[0]!, ...changed };
      const evidence = build(fixture);
      expect(evidence.sourceRowsChecksum).not.toBe(reference.sourceRowsChecksum);
      expect(evidence.blocks[0]!.sourceRowsChecksum).not.toBe(
        reference.blocks[0]!.sourceRowsChecksum,
      );
      expect(evidence.evidenceChecksum).not.toBe(reference.evidenceChecksum);
    }
    expect(
      build(rows().map((entry) => ({ ...entry, artifactChecksum: "b".repeat(64) })))
        .evidenceChecksum,
    ).not.toBe(reference.evidenceChecksum);
  });

  it("retains negative outcomes and inclusive endpoint ties, including a zero-width triple", () => {
    const evidence = build(
      rows().map((entry) => ({
        ...entry,
        actualPoints: -7,
        p15Points: -7,
        p50Points: -7,
        p85Points: -7,
      })),
    );
    expect(evidence.overall.metrics!.coverage).toEqual({ numerator: "1", denominator: "1" });
    expect(evidence.overall.metrics!.wis).toBe(0);
    expect(evidence.overall.metrics!.width).toBe(0);
    expect(evidence.blocks[0]!.endpointCounts).toEqual(
      Array.from({ length: 3 }, () => ({ below: 0, equal: 6, above: 0 })),
    );
    expect(evaluateMarginalIntervalEvidence(evidence).state).toBe("descriptive-screen-passed");
  });

  it("accepts the exact coverage and strict-tail boundary without a binomial precision claim", () => {
    expect(evaluateMarginalIntervalEvidence(build(eventMix(12, 5, 3))).state).toBe(
      "descriptive-screen-passed",
    );
    expect(evaluateMarginalIntervalEvidence(build(eventMix(12, 3, 5))).state).toBe(
      "descriptive-screen-passed",
    );
    const failedCoverage = evaluateMarginalIntervalEvidence(build(eventMix(11, 4, 5)));
    expect(failedCoverage).toMatchObject({
      state: "failed-screen",
      reasons: ["coverage-below-three-fifths"],
    });
    const failedLower = evaluateMarginalIntervalEvidence(build(eventMix(14, 6, 0)));
    expect(failedLower).toMatchObject({
      state: "failed-screen",
      reasons: ["lower-tail-above-one-quarter"],
    });
    const failedUpper = evaluateMarginalIntervalEvidence(build(eventMix(14, 0, 6)));
    expect(failedUpper).toMatchObject({
      state: "failed-screen",
      reasons: ["upper-tail-above-one-quarter"],
    });
  });

  it("does not turn a failed empirical fraction into a pass by increasing player multiplicity", () => {
    const original = eventMix(11, 4, 5);
    const duplicated = original.flatMap((entry) => [
      entry,
      { ...entry, identity: `${entry.identity}:clone`, playerId: `${entry.playerId}:clone` },
    ]);
    const first = evaluateMarginalIntervalEvidence(build(original));
    const second = evaluateMarginalIntervalEvidence(build(duplicated));
    expect(second.state).toBe(first.state);
    expect(second.reasons).toEqual(first.reasons);
    expect(second.overall!.metrics!.coverage).toEqual(first.overall!.metrics!.coverage);
  });

  it("rejects a rational just below 3/5 even when its displayed decimal rounds to 0.600000", () => {
    // Independent integer fixture: 123/139 + 88/149 + 49/151 is just below 9/5.
    // The gap to the exact weighted coverage threshold is 3 / (5 * 139 * 149 * 151).
    let index = 0;
    const fixture = [
      [139, 123],
      [149, 88],
      [151, 49],
    ].flatMap(([size, covered], cutoff) =>
      Array.from({ length: size! }, (_, within) =>
        row(index++, {
          playerId: `player-${within}`,
          asOfWeek: cutoff + 1,
          windowStartWeek: cutoff + 2,
          actualPoints:
            within < covered!
              ? 0
              : within < covered! + Math.floor((size! - covered!) / 2)
                ? -20
                : 20,
        }),
      ),
    );
    const evidence = build(fixture);
    const coverage = evidence.overall.metrics!.coverage;
    expect((Number(coverage.numerator) / Number(coverage.denominator)).toFixed(6)).toBe("0.600000");
    expect(evaluateMarginalIntervalEvidence(evidence)).toMatchObject({
      state: "failed-screen",
      reasons: ["coverage-below-three-fifths"],
    });
  });

  it("does not expose mutable shared semantic arrays between evidence objects", () => {
    const altered = build();
    (altered.quantiles as unknown as number[])[0] = 0.01;
    expect(build().quantiles).toEqual([0.15, 0.5, 0.85]);
    expect(evaluateMarginalIntervalEvidence(altered).state).toBe("invalid-evidence");
  });

  it("reports empty or undersupported evidence honestly", () => {
    const empty = build([]);
    expect(empty.overall.metrics).toBeNull();
    expect(empty.descriptive).toEqual({ seasonRange: null, leaveOneSeasonOut: [] });
    expect(evaluateMarginalIntervalEvidence(empty)).toMatchObject({
      state: "insufficient-evidence",
      reasons: ["fewer-than-1-seasons", "fewer-than-3-blocks", "fewer-than-18-rows"],
    });
    expect(evaluateMarginalIntervalEvidence(build(rows(12)))).toMatchObject({
      state: "insufficient-evidence",
      reasons: ["fewer-than-3-blocks", "fewer-than-18-rows"],
    });
  });

  it.each([
    { forecastSeason: 2023.1 },
    { trainedThroughSeason: 2023 },
    { asOfWeek: 18 },
    { windowStartWeek: 1 },
    { windowEndWeek: 19 },
    { scheduledGames: 0 },
    { scheduledGames: 18 },
    { scheduledGames: 1.5 },
    { actualPoints: Infinity },
    { actualPoints: NaN },
    { p15Points: 11 },
    { p50Points: -11 },
    { rawQuantiles: { p15Points: 5, p50Points: 0, p85Points: 10 } },
    { artifactChecksum: "A".repeat(64) },
    { identity: "" },
    { playerId: " " },
    { seriesKey: "different" },
  ])("rejects invalid row input %j", (override) => {
    const fixture = rows();
    fixture[0] = { ...fixture[0]!, ...override };
    expect(() => build(fixture)).toThrow();
  });

  it("rejects duplicate semantic or row identities and any within-season refitting", () => {
    expect(() => build([...rows(), rows()[0]!])).toThrow("duplicate");
    expect(() => build([...rows(), { ...rows()[0]!, identity: "other-id" }])).toThrow("duplicate");
    const refitted = rows();
    refitted[6] = { ...refitted[6]!, artifactChecksum: "b".repeat(64) };
    expect(() => build(refitted)).toThrow("locked");
    const changedWindow = rows();
    changedWindow[0] = { ...changedWindow[0]!, windowEndWeek: 17 };
    expect(() => build(changedWindow)).toThrow("conflicting forecast windows");
  });

  it("rejects missing/unknown row fields, sparse arrays, nonfinite score arithmetic and excessive rows", () => {
    const unknown = { ...row(0), ignored: true };
    expect(() => build([unknown])).toThrow("unknown");
    const missing = { ...row(0) } as Record<string, unknown>;
    delete missing.actualPoints;
    expect(() => build([missing as unknown as MarginalIntervalEvaluationRow])).toThrow("missing");
    const sparse = rows();
    Reflect.deleteProperty(sparse, 2);
    expect(() => build(sparse)).toThrow("dense");
    expect(() =>
      build([row(0, { p15Points: -Number.MAX_VALUE, p85Points: Number.MAX_VALUE })]),
    ).toThrow("finite");
    expect(() =>
      build(Array.from({ length: MARGINAL_INTERVAL_EVIDENCE_MAX_ROWS + 1 }, () => row(0))),
    ).toThrow("bound");
  });

  it("normalizes signed zero before hashing and serialization", () => {
    const ordinary = build(rows().map((entry) => ({ ...entry, actualPoints: 0, p50Points: 0 })));
    const negative = build(rows().map((entry) => ({ ...entry, actualPoints: -0, p50Points: -0 })));
    expect(negative).toEqual(ordinary);
  });

  it.each([
    (evidence: ReturnType<typeof build>) => {
      (evidence as unknown as Record<string, unknown>).admitted = true;
    },
    (evidence: ReturnType<typeof build>) => {
      (evidence as unknown as Record<string, unknown>).version = "unknown";
    },
    (evidence: ReturnType<typeof build>) => {
      (evidence.overall as unknown as Record<string, unknown>).samples = 500;
    },
    (evidence: ReturnType<typeof build>) => {
      (evidence.overall.metrics!.coverage as unknown as Record<string, unknown>).numerator = "0";
    },
    (evidence: ReturnType<typeof build>) => {
      (evidence.blocks[0] as unknown as Record<string, unknown>).coverageCount = 5;
    },
    (evidence: ReturnType<typeof build>) => {
      (evidence.blocks[0] as unknown as Record<string, unknown>).trainedThroughSeason = 2023;
    },
    (evidence: ReturnType<typeof build>) => {
      (evidence.blocks[0] as unknown as Record<string, unknown>).ignored = true;
    },
    (evidence: ReturnType<typeof build>) => {
      (evidence.blocks[0] as unknown as Record<string, unknown>).samples = 1.5;
    },
    (evidence: ReturnType<typeof build>) => {
      (evidence.blocks[0] as unknown as Record<string, unknown>).wisSum = Infinity;
    },
    (evidence: ReturnType<typeof build>) => {
      (evidence.blocks[0] as unknown as Record<string, unknown>).widthSum = 121;
    },
    (evidence: ReturnType<typeof build>) => {
      (evidence as unknown as Record<string, unknown>).evidenceChecksum = "f".repeat(64);
    },
    (evidence: ReturnType<typeof build>) => {
      (evidence.blocks as unknown[]).reverse();
    },
    (evidence: ReturnType<typeof build>) => {
      Reflect.deleteProperty(evidence.blocks, 0);
    },
    (evidence: ReturnType<typeof build>) => {
      Reflect.deleteProperty(evidence.blocks[0]!.endpointCounts, 0);
    },
    (evidence: ReturnType<typeof build>) => {
      Reflect.deleteProperty(evidence.blocks[0]!.pinballSums, 0);
    },
    (evidence: ReturnType<typeof build>) => {
      Reflect.deleteProperty(evidence.blocks[0]!.scheduledGamesRange, 0);
    },
    (evidence: ReturnType<typeof build>) => {
      Reflect.deleteProperty(evidence.quantiles, 0);
    },
    (evidence: ReturnType<typeof build>) => {
      Reflect.deleteProperty(evidence.perSeason, 0);
    },
  ])("rejects malformed compact evidence instead of trusting its passing summary %#", (mutate) => {
    const evidence = JSON.parse(JSON.stringify(build())) as ReturnType<typeof build>;
    mutate(evidence);
    expect(evaluateMarginalIntervalEvidence(evidence)).toMatchObject({
      state: "invalid-evidence",
      reasons: ["invalid-evidence"],
      overall: null,
    });
    expect(() => validateMarginalIntervalEvidence(evidence)).toThrow();
  });

  it("rejects invalid roots and an array with an extra non-index property", () => {
    for (const invalid of [null, undefined, [], true, {}, 1, "evidence"])
      expect(evaluateMarginalIntervalEvidence(invalid).state).toBe("invalid-evidence");
    const fixture = rows() as MarginalIntervalEvaluationRow[] & { extra?: boolean };
    fixture.extra = true;
    expect(() => build(fixture)).toThrow("dense");
  });

  it("rejects impossible single-row game ranges and positive loss for an all-tied endpoint", () => {
    const single = JSON.parse(JSON.stringify(build([row(0)]))) as ReturnType<typeof build>;
    (single.blocks[0] as unknown as Record<string, unknown>).scheduledGamesRange = [3, 4];
    expect(() => validateMarginalIntervalEvidence(single)).toThrow("one-row block");
    const ties = JSON.parse(JSON.stringify(build())) as ReturnType<typeof build>;
    (ties.blocks[0]!.pinballSums as unknown as number[])[1] = 0.01;
    expect(() => validateMarginalIntervalEvidence(ties)).toThrow("all-tied endpoint");
  });
});
