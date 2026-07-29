import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  FIRST_PARTY_ROS_AVAILABILITY_EVIDENCE_ALPHA,
  FIRST_PARTY_ROS_MAXIMUM_AVAILABILITY_ROW_ERROR,
  FIRST_PARTY_ROS_MAX_AVAILABILITY_MAE,
  FIRST_PARTY_ROS_MAX_NINE_PLUS_AVAILABILITY_MAE,
  firstPartyRosAvailabilityEvidenceOfExcessMae,
} from "@fantasy/projections";

import {
  firstPartyRosAdmissionConstants,
  validateFirstPartyRosAdmission,
} from "./first-party-ros-admission.js";
import {
  firstPartyRosRegateCeilings,
  regateFirstPartyRosReport,
  type FirstPartyRosRegateResult,
} from "./first-party-ros-regate.js";

const repositoryRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");

/**
 * The six completed v8 reports the re-gate path must reproduce. `reports/` is gitignored (see
 * `.gitignore`), so these files exist only on the machine that ran the 5.5-hour validation. A
 * missing file skips its case rather than silently passing; the synthetic cases below carry the
 * always-on coverage.
 */
const STORED_REPORTS = [
  "reports/ros-validation-v8-full-ppr-n8-2026-07-28.json",
  "reports/ros-validation-v8-half-ppr-n8-2026-07-28.json",
  "reports/ros-validation-v8-standard-n8-2026-07-28.json",
  "reports/ros-validation-v8-2026-07-23.json",
  "reports/ros-validation-v8-half-ppr-2026-07-27.json",
  "reports/ros-validation-v8-standard-2026-07-27.json",
] as const;

function storedReport(relativePath: string): {
  readonly raw: string;
  readonly parsed: Record<string, unknown>;
} | null {
  const absolute = resolve(repositoryRoot, relativePath);
  if (!existsSync(absolute)) return null;
  const raw = readFileSync(absolute, "utf8");
  return { raw, parsed: JSON.parse(raw) as Record<string, unknown> };
}

function regate(
  report: unknown,
  overrides: Record<string, string> = {},
): FirstPartyRosRegateResult {
  return regateFirstPartyRosReport({
    report,
    sourceReportPath: overrides.sourceReportPath ?? "reports/example.json",
    sourceReportSha256:
      overrides.sourceReportSha256 ??
      createHash("sha256").update(JSON.stringify(report), "utf8").digest("hex"),
    regatedAt: overrides.regatedAt ?? "2026-07-28T12:00:00.000Z",
  });
}

function expectRegated(
  result: FirstPartyRosRegateResult,
): Extract<FirstPartyRosRegateResult, { state: "re-gated" }> {
  if (result.state !== "re-gated") {
    throw new Error(
      `expected a re-gated result, received ${result.state}: ${result.reasons.join(", ")}`,
    );
  }
  return result;
}

interface ChoiceOverrides {
  readonly position?: string;
  readonly bucket?: string;
  readonly strategy?: string;
  readonly reason?: string;
  readonly availabilityMae?: number;
  readonly availabilityBias?: number;
  readonly inputCoverage?: number;
  readonly convergenceRate?: number;
  readonly heldOutState?: string;
  readonly intervalCalibration?: string;
  readonly selectedCalibrationState?: string;
  readonly walkForwardState?: string;
  readonly walkForwardSeasons?: number;
  readonly walkForwardBlocks?: number;
  readonly walkForwardSamples?: number;
  readonly observedBlockCoverage?: number;
  readonly nominalCoverage?: number;
}

/** A clean choice: every gate clause passes, so any blocker in a case below is the one under test. */
function choice(overrides: ChoiceOverrides = {}): Record<string, unknown> {
  const strategy = overrides.strategy ?? "availability-aware-recency";
  const inputCoverage = overrides.inputCoverage ?? 1;
  const convergenceRate = overrides.convergenceRate ?? 1;
  const other = strategy === "contextual" ? 0.5 : 0.25;
  return {
    position: overrides.position ?? "QB",
    bucket: overrides.bucket ?? "one-to-four",
    strategy,
    reason: overrides.reason ?? "baseline-defended",
    heldOutSeasons: 4,
    batches: 16,
    samples: 128,
    modelImprovement: -0.002,
    modelImprovementLowerBound: -0.109,
    intervalScoreDifferenceUpperBound: 0.8,
    inputCoverage: {
      contextual: strategy === "contextual" ? inputCoverage : other,
      recency: strategy === "contextual" ? other : inputCoverage,
    },
    convergenceRate: {
      contextual: strategy === "contextual" ? convergenceRate : other,
      recency: strategy === "contextual" ? other : convergenceRate,
    },
    observedIntervalCoverage: { contextual: 0.54, recency: 0.52 },
    intervalCalibration: overrides.intervalCalibration ?? "split-conformal-cqr",
    selectedCalibrationState: overrides.selectedCalibrationState ?? "calibrated",
    selectedCalibrationCorrectionPoints: 30.5,
    selectedHeldOutEvidence: {
      state: overrides.heldOutState ?? "derived-immutable-not-calibrated",
      inputCoverage,
      availabilityMae: overrides.availabilityMae ?? 0.5,
      availabilityBias: overrides.availabilityBias ?? 0.1,
      convergenceRate,
    },
    walkForwardCalibration: {
      state: overrides.walkForwardState ?? "available",
      seasons: overrides.walkForwardSeasons ?? 1,
      blocks: overrides.walkForwardBlocks ?? 4,
      samples: overrides.walkForwardSamples ?? 32,
      observedBlockCoverage: overrides.observedBlockCoverage ?? 1,
      nominalCoverage: overrides.nominalCoverage ?? 0.7,
      coverageShortfall: -0.3,
    },
  };
}

function cell(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    position: "QB",
    bucket: "one-to-four",
    seasons: 4,
    cutoffs: 4,
    batches: 16,
    samples: 128,
    ready: true,
    reasons: [],
    ...overrides,
  };
}

function reportFixture(
  options: {
    readonly choices?: readonly Record<string, unknown>[];
    readonly cells?: readonly Record<string, unknown>[];
    readonly state?: string;
    readonly blockers?: readonly string[];
    readonly seasons?: readonly number[];
    readonly forecasts?: number;
    readonly batches?: number;
    readonly kickerFamilyAudit?: readonly Record<string, unknown>[];
  } = {},
): Record<string, unknown> {
  return {
    validationMode: "read-only-first-party-ros-backtest",
    generatedAt: "2026-07-28T11:49:00.000Z",
    elapsedSeconds: 19_842.5,
    noDatabaseWrites: true,
    sourcePolicy: "official-nflverse-artifacts",
    scoringProfile: { key: "full-ppr", label: "Full PPR", digest: "abc" },
    availabilityAudit: [
      {
        position: "QB",
        bucket: "one-to-four",
        strategy: "availability-aware-recency",
        rows: 128,
        signedExpectedGamesBias: 0.14,
        expectedGamesRowMae: 0.66,
      },
    ],
    coverage: { state: "qualified", fullyHeldOutSeasons: 4 },
    report: {
      state: options.state ?? "evidence-ready",
      seasons: options.seasons ?? [2022, 2023, 2024, 2025],
      forecasts: options.forecasts ?? 3264,
      batches: options.batches ?? 68,
      diagnosedPairs: 72,
      skippedForecasts: 0,
      playersPerPosition: 8,
      maximumForecasts: 6000,
      unsupportedPositions: [],
      blockers: options.blockers ?? [],
      cells: options.cells ?? [cell()],
      availabilityCalibrationVersion: "v",
      roleCalibrationVersion: "v",
      kickerCalibrationVersion: "v",
      kickerFamilyAudit: options.kickerFamilyAudit ?? [
        { season: 2022, dispersion: {}, state: "within-bounds" },
      ],
      convergenceAudit: [{ season: 2022, position: "QB", bucket: "one-to-four" }],
    },
    identityAudit: { inputChecksums: 3264, scoringProfileKey: "k" },
    champion: {
      policyVersion: "p",
      modelVersion: "m",
      evidenceThroughSeason: 2025,
      globalBatches: 68,
      evidenceIdentity: { scoringProfileKey: "k" },
      choices: options.choices ?? [choice()],
    },
    sources: [{ season: 2022, weeklyStatsChecksum: "a".repeat(64) }],
  };
}

describe("first-party ROS re-gate structural rails", () => {
  it("refuses a report body that is not an object", () => {
    const result = regate("not a report");
    expect(result).toEqual({ state: "unusable", reasons: ["report_not_object"] });
  });

  it("names the exact missing field rather than reconstructing it", () => {
    const broken = reportFixture();
    const body = broken.report as Record<string, unknown>;
    delete body.cells;
    const choices = (broken.champion as Record<string, unknown>).choices as Record<
      string,
      unknown
    >[];
    delete (choices[0]!.walkForwardCalibration as Record<string, unknown>).observedBlockCoverage;
    const result = regate(broken);
    expect(result.state).toBe("unusable");
    if (result.state !== "unusable") throw new Error("unreachable");
    expect(result.reasons).toContain("report.cells_missing_or_not_an_array");
    expect(result.reasons).toContain(
      "champion.choices[0].walkForwardCalibration.observedBlockCoverage_missing_or_not_a_finite_number",
    );
  });

  it("refuses when the selected held-out evidence contradicts the per-strategy evidence", () => {
    const inconsistent = reportFixture();
    const choices = (inconsistent.champion as Record<string, unknown>).choices as Record<
      string,
      unknown
    >[];
    (choices[0]!.selectedHeldOutEvidence as Record<string, unknown>).inputCoverage = 0.5;
    const result = regate(inconsistent);
    expect(result.state).toBe("unusable");
    if (result.state !== "unusable") throw new Error("unreachable");
    expect(result.reasons).toContain(
      "champion.choices[0].selectedHeldOutEvidence.inputCoverage_disagrees_with_inputCoverage.recency",
    );
  });

  it("refuses to re-gate a report that is itself a re-gate output", () => {
    const first = expectRegated(regate(reportFixture()));
    const result = regate(first.report);
    expect(result.state).toBe("unusable");
    if (result.state !== "unusable") throw new Error("unreachable");
    expect(result.reasons).toContain("source_report_is_already_a_re_gate_output");
  });
});

describe("first-party ROS re-gate blocker composition", () => {
  it("reproduces a clean evidence-ready verdict", () => {
    const result = expectRegated(regate(reportFixture()));
    expect(result.blockers).toEqual([]);
    expect(result.reportState).toBe("evidence-ready");
    expect(result.verdictChanged).toBe(false);
  });

  it.each([
    [
      "availability MAE carrying binomial evidence against the one-to-four ceiling",
      choice({ availabilityMae: 1.8 }),
      "calibration_QB_one-to-four_availability_mae_above_maximum",
    ],
    [
      "availability MAE over the one-to-four ceiling by only sampling noise stays clean",
      choice({ availabilityMae: 1.6 }),
      null,
    ],
    [
      "availability MAE below the nine-plus ceiling stays clean",
      choice({ bucket: "nine-plus", availabilityMae: 2.7 }),
      null,
    ],
    [
      "availability MAE over the nine-plus ceiling by only sampling noise stays clean",
      choice({ bucket: "nine-plus", availabilityMae: 2.8 }),
      null,
    ],
    [
      "availability MAE carrying binomial evidence against the nine-plus ceiling",
      choice({ bucket: "nine-plus", availabilityMae: 3.5 }),
      "calibration_QB_nine-plus_availability_mae_above_maximum",
    ],
    [
      "availability bias above the ceiling",
      choice({ availabilityBias: -1.2 }),
      "calibration_QB_one-to-four_availability_bias_above_maximum",
    ],
    [
      "input coverage below the minimum",
      choice({ inputCoverage: 0.9 }),
      "calibration_QB_one-to-four_input_coverage_below_minimum",
    ],
    [
      "convergence below the minimum",
      choice({ convergenceRate: 0.99 }),
      "calibration_QB_one-to-four_convergence_below_minimum",
    ],
    [
      "held-out evidence unavailable",
      choice({ heldOutState: "insufficient-evidence" }),
      "calibration_QB_one-to-four_held_out_evidence_unavailable",
    ],
    [
      "uncalibrated interval artifact",
      choice({ selectedCalibrationState: "not-calibrated" }),
      "calibration_QB_one-to-four_artifact_unavailable",
    ],
    [
      "walk-forward evidence unavailable",
      choice({ walkForwardState: "unavailable" }),
      "calibration_QB_one-to-four_walk_forward_unavailable",
    ],
    [
      "walk-forward blocks below the minimum",
      choice({ walkForwardBlocks: 2 }),
      "calibration_QB_one-to-four_walk_forward_blocks_below_minimum",
    ],
    [
      "walk-forward samples below the minimum",
      choice({ walkForwardSamples: 17 }),
      "calibration_QB_one-to-four_walk_forward_samples_below_minimum",
    ],
    [
      "coverage shortfall carrying binomial evidence",
      choice({ observedBlockCoverage: 0 }),
      "calibration_QB_one-to-four_coverage_shortfall_above_maximum",
    ],
    [
      "coverage shortfall that is only sampling noise stays clean",
      choice({ observedBlockCoverage: 0.25 }),
      null,
    ],
  ])("re-derives the %s clause", (_label, candidate, expected) => {
    const result = expectRegated(regate(reportFixture({ choices: [candidate] })));
    if (expected === null) expect(result.blockers).toEqual([]);
    else expect(result.blockers).toEqual([expected]);
  });

  it("re-derives portfolio, cell, champion and kicker-family blockers in source order", () => {
    const result = expectRegated(
      regate(
        reportFixture({
          seasons: [2024, 2025],
          forecasts: 100,
          batches: 4,
          cells: [cell({ ready: false, reasons: ["samples-below-minimum", "few-batches"] })],
          choices: [choice({ reason: "sparse-cell" }), choice({ position: "RB" })],
          kickerFamilyAudit: [{ season: 2022, state: "out-of-bounds" }],
        }),
      ),
    );
    expect(result.blockers).toEqual([
      "fewer_than_three_qualified_heldout_seasons",
      "portfolio_cutoff_batches_below_minimum",
      "portfolio_forecasts_below_minimum",
      "cell_QB_one-to-four_samples-below-minimum+few-batches",
      "champion_QB_one-to-four_sparse-cell",
      "calibration_K_one-to-four_count_family_dispersion_out_of_bounds",
      "calibration_K_five-to-eight_count_family_dispersion_out_of_bounds",
      "calibration_K_nine-plus_count_family_dispersion_out_of_bounds",
    ]);
    expect(result.reportState).toBe("insufficient");
  });

  it("de-duplicates repeated blockers exactly as the backtest does", () => {
    const result = expectRegated(
      regate(
        reportFixture({
          choices: [choice({ availabilityMae: 1.8 }), choice({ availabilityMae: 1.9 })],
        }),
      ),
    );
    expect(result.blockers).toEqual(["calibration_QB_one-to-four_availability_mae_above_maximum"]);
  });
});

describe("first-party ROS re-gate provenance", () => {
  it("records the source lineage, the re-gate timestamp and the ceilings used", () => {
    const source = reportFixture({ state: "insufficient", blockers: ["stale_blocker"] });
    const result = expectRegated(
      regate(source, {
        sourceReportPath: "reports/ros-validation-v8-full-ppr-n8-2026-07-28.json",
        sourceReportSha256: "f".repeat(64),
        regatedAt: "2026-07-28T13:37:00.000Z",
      }),
    );
    const provenance = result.report.regate as Record<string, unknown>;
    expect(provenance.mode).toBe("gate-only-re-evaluation");
    expect(provenance.forecastEvidence).toBe("carried-unchanged-from-source-run");
    expect(provenance.freshValidationRun).toBe(false);
    expect(provenance.sourceReportPath).toBe(
      "reports/ros-validation-v8-full-ppr-n8-2026-07-28.json",
    );
    expect(provenance.sourceReportSha256).toBe("f".repeat(64));
    expect(provenance.sourceGeneratedAt).toBe("2026-07-28T11:49:00.000Z");
    expect(provenance.sourceState).toBe("insufficient");
    expect(provenance.sourceBlockers).toEqual(["stale_blocker"]);
    expect(provenance.regatedAt).toBe("2026-07-28T13:37:00.000Z");
    expect(provenance.verdictChanged).toBe(true);
    expect(provenance.ceilings).toEqual(firstPartyRosRegateCeilings());
    expect(provenance.recomputed).toEqual(["report.state", "report.blockers"]);
    expect(Array.isArray(provenance.reconstructedGateInputs)).toBe(true);
  });

  it("leaves every evidence field byte-identical and changes only the gate outputs", () => {
    const source = reportFixture({ state: "insufficient", blockers: ["stale_blocker"] });
    const before = JSON.parse(JSON.stringify(source)) as Record<string, unknown>;
    const result = expectRegated(regate(source));
    const emitted = JSON.parse(JSON.stringify(result.report)) as Record<string, unknown>;
    expect(source).toEqual(before);

    const emittedBody = emitted.report as Record<string, unknown>;
    const sourceBody = before.report as Record<string, unknown>;
    expect(emittedBody.state).toBe("evidence-ready");
    expect(emittedBody.blockers).toEqual([]);
    expect({ ...emittedBody, state: sourceBody.state, blockers: sourceBody.blockers }).toEqual(
      sourceBody,
    );
    delete emitted.report;
    delete emitted.regate;
    delete before.report;
    expect(emitted).toEqual(before);
  });

  it("leads with the provenance block so the file cannot read as a fresh run", () => {
    const source = reportFixture();
    const emitted = expectRegated(regate(source)).report;
    expect(Object.keys(emitted)).toEqual(["regate", ...Object.keys(source)]);
  });
});

describe("first-party ROS re-gate change detection", () => {
  it("raises a nine-plus blocker when the ceiling is lowered beneath the stored MAE", async () => {
    vi.resetModules();
    vi.doMock("@fantasy/projections", async (importOriginal) => {
      const actual = await importOriginal<Record<string, unknown>>();
      return { ...actual, FIRST_PARTY_ROS_MAX_NINE_PLUS_AVAILABILITY_MAE: 2.5 };
    });
    try {
      const module = await import("./first-party-ros-regate.js");
      const source = reportFixture({
        choices: [choice({ bucket: "nine-plus", availabilityMae: 3.4 })],
      });
      const lowered = module.regateFirstPartyRosReport({
        report: source,
        sourceReportPath: "reports/example.json",
        sourceReportSha256: "0".repeat(64),
        regatedAt: "2026-07-28T12:00:00.000Z",
      });
      expect(lowered.state).toBe("re-gated");
      if (lowered.state !== "re-gated") throw new Error("unreachable");
      expect(lowered.blockers).toEqual(["calibration_QB_nine-plus_availability_mae_above_maximum"]);
      expect(lowered.reportState).toBe("insufficient");
      expect(module.firstPartyRosRegateCeilings().ninePlusAvailabilityMae).toBe(2.5);

      // The very same evidence is clean under the unmodified ceiling, so the difference is the
      // constant and nothing else.
      expect(expectRegated(regate(source)).blockers).toEqual([]);
    } finally {
      vi.doUnmock("@fantasy/projections");
      vi.resetModules();
    }
  });

  it("clears a stored blocker when the ceiling is raised above the stored MAE", async () => {
    vi.resetModules();
    vi.doMock("@fantasy/projections", async (importOriginal) => {
      const actual = await importOriginal<Record<string, unknown>>();
      return { ...actual, FIRST_PARTY_ROS_MAX_NINE_PLUS_AVAILABILITY_MAE: 3 };
    });
    try {
      const module = await import("./first-party-ros-regate.js");
      const source = reportFixture({
        state: "insufficient",
        blockers: ["calibration_QB_nine-plus_availability_mae_above_maximum"],
        choices: [choice({ bucket: "nine-plus", availabilityMae: 3.5 })],
      });
      const raised = module.regateFirstPartyRosReport({
        report: source,
        sourceReportPath: "reports/example.json",
        sourceReportSha256: "0".repeat(64),
        regatedAt: "2026-07-28T12:00:00.000Z",
      });
      if (raised.state !== "re-gated") throw new Error("unreachable");
      expect(raised.blockers).toEqual([]);
      expect(raised.reportState).toBe("evidence-ready");
      expect(raised.verdictChanged).toBe(true);

      // Unmodified ceiling reproduces the stored verdict for the same evidence.
      expect(expectRegated(regate(source)).blockers).toEqual([
        "calibration_QB_nine-plus_availability_mae_above_maximum",
      ]);
    } finally {
      vi.doUnmock("@fantasy/projections");
      vi.resetModules();
    }
  });
});

/** Just the champion-choice fields the availability-MAE clause reads out of a stored report. */
interface StoredChoice {
  readonly position: string;
  readonly bucket: keyof typeof FIRST_PARTY_ROS_MAXIMUM_AVAILABILITY_ROW_ERROR;
  readonly samples: number;
  readonly selectedHeldOutEvidence: { readonly availabilityMae: number };
}

/** The availability-MAE ceiling each bucket is graded against, read from the running constants. */
function availabilityMaeCeiling(bucket: string): number {
  return bucket === "nine-plus"
    ? FIRST_PARTY_ROS_MAX_NINE_PLUS_AVAILABILITY_MAE
    : FIRST_PARTY_ROS_MAX_AVAILABILITY_MAE;
}

/**
 * The availability-MAE blockers a stored report carries that the v3 evidence test now reads as
 * sampling noise, recomputed straight from the report's own champion choices. Deliberately
 * independent of the re-gate's evidence reconstruction: it reads the stored JSON directly, so
 * agreeing with the re-gated blocker list is a real cross-check rather than a restatement.
 */
function availabilityMaeBlockersClearedByEvidence(
  parsed: Record<string, unknown>,
): ReadonlySet<string> {
  const choices = (parsed.champion as { readonly choices: readonly StoredChoice[] }).choices;
  const cleared = new Set<string>();
  for (const entry of choices) {
    const ceiling = availabilityMaeCeiling(entry.bucket);
    const mae = entry.selectedHeldOutEvidence.availabilityMae;
    if (mae <= ceiling) continue;
    const evidence = firstPartyRosAvailabilityEvidenceOfExcessMae(
      entry.samples,
      mae,
      ceiling,
      FIRST_PARTY_ROS_MAXIMUM_AVAILABILITY_ROW_ERROR[entry.bucket],
      FIRST_PARTY_ROS_AVAILABILITY_EVIDENCE_ALPHA,
    );
    if (!evidence) {
      cleared.add(`calibration_${entry.position}_${entry.bucket}_availability_mae_above_maximum`);
    }
  }
  return cleared;
}

/**
 * The equivalence proof. Re-gating a completed report must reproduce exactly the verdict a fresh
 * run of the current code would reach from the same evidence; if it cannot, the re-gate path is not
 * faithful and must not be used. This is the entire basis for trusting a re-gated verdict, so it
 * runs over the real stored artifacts rather than a fixture.
 *
 * The stored reports were graded under the superseded point-estimate availability-MAE comparison,
 * so "reproduce the stored blockers verbatim" is no longer that claim — availability MAE gate v3
 * (2026-07-28) legitimately clears some of them. The proof is therefore taken in two halves, and
 * together they are strictly stronger than the single assertion they replace:
 *
 * 1. Forcing the evidence test to "evidence present" reduces the gate to exactly the superseded
 *    rule, and under it every stored verdict must come back byte-identical. That is the original
 *    proof, and it still covers every gate input the re-gate reconstructs — including the
 *    availability MAE, bucket and ceiling the changed clause reads.
 * 2. Under the shipped gate, the re-gated blockers must equal the stored blockers minus exactly
 *    the availability-MAE entries the evidence test clears, recomputed independently from the
 *    stored JSON. Nothing else may move.
 */
describe("first-party ROS re-gate equivalence against the stored validation reports", () => {
  for (const relativePath of STORED_REPORTS) {
    const stored = storedReport(relativePath);
    it.skipIf(stored === null)(
      `reproduces the stored verdict of ${relativePath} under the superseded availability rule`,
      async () => {
        if (stored === null) throw new Error("unreachable");
        vi.resetModules();
        vi.doMock("@fantasy/projections", async (importOriginal) => {
          const actual = await importOriginal<Record<string, unknown>>();
          return { ...actual, firstPartyRosAvailabilityEvidenceOfExcessMae: () => true };
        });
        try {
          const module = await import("./first-party-ros-regate.js");
          const result = module.regateFirstPartyRosReport({
            report: stored.parsed,
            sourceReportPath: relativePath,
            sourceReportSha256: createHash("sha256").update(stored.raw, "utf8").digest("hex"),
            regatedAt: "2026-07-28T12:00:00.000Z",
          });
          if (result.state !== "re-gated") throw new Error(`unusable: ${result.reasons.join(",")}`);
          const body = stored.parsed.report as Record<string, unknown>;
          expect(result.blockers).toEqual(body.blockers);
          expect(result.reportState).toBe(body.state);
          expect(result.verdictChanged).toBe(false);
          expect((result.report.report as Record<string, unknown>).blockers).toEqual(body.blockers);
          expect((result.report.report as Record<string, unknown>).state).toBe(body.state);
        } finally {
          vi.doUnmock("@fantasy/projections");
          vi.resetModules();
        }
      },
    );

    it.skipIf(stored === null)(
      `re-gates ${relativePath} to the shipped gate's verdict and nothing else`,
      () => {
        if (stored === null) throw new Error("unreachable");
        const result = expectRegated(
          regate(stored.parsed, {
            sourceReportPath: relativePath,
            sourceReportSha256: createHash("sha256").update(stored.raw, "utf8").digest("hex"),
          }),
        );
        const body = stored.parsed.report as Record<string, unknown>;
        const storedBlockers = body.blockers as readonly string[];
        const cleared = availabilityMaeBlockersClearedByEvidence(stored.parsed);
        for (const blocker of cleared) expect(storedBlockers).toContain(blocker);
        const expected = storedBlockers.filter((blocker) => !cleared.has(blocker));
        expect(result.blockers).toEqual(expected);
        expect(result.reportState).toBe(expected.length === 0 ? "evidence-ready" : "insufficient");
        expect(result.verdictChanged).toBe(cleared.size > 0);
      },
    );

    it.skipIf(stored === null)(`keeps ${relativePath} admissible after re-gating`, () => {
      if (stored === null) throw new Error("unreachable");
      const result = expectRegated(regate(stored.parsed, { sourceReportPath: relativePath }));
      const champion = stored.parsed.champion as Record<string, unknown>;
      const evidenceThroughSeason = champion.evidenceThroughSeason as number;
      // The report's own recorded scoring-profile identity, so each profile's report is validated
      // against the profile it was actually graded under.
      const constants = {
        ...firstPartyRosAdmissionConstants(),
        scoringProfileKey: (stored.parsed.identityAudit as Record<string, unknown>)
          .scoringProfileKey as string,
      };
      const before = validateFirstPartyRosAdmission({
        report: stored.parsed,
        evidenceThroughSeason,
        constants,
      });
      const after = validateFirstPartyRosAdmission({
        report: result.report,
        evidenceThroughSeason,
        constants,
      });
      expect(before.state).toBe("admissible");
      expect(after.state).toBe(before.state);
      if (before.state === "admissible" && after.state === "admissible") {
        // Gate outputs feed the artifact checksum, so an unchanged verdict must leave it untouched
        // and a changed verdict must move it. Both directions are asserted: a checksum that did not
        // move when the blocker set did would mean admission could not tell the artifacts apart.
        expect(after.cellBlockers).toEqual(result.blockers);
        if (result.verdictChanged) expect(after.artifactChecksum).not.toBe(before.artifactChecksum);
        else expect(after.artifactChecksum).toBe(before.artifactChecksum);
      }
    });
  }
});
