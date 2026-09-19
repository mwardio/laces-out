import { beforeAll, describe, expect, it } from "vitest";
import {
  applyFirstPartyRosMarginalRelease,
  evaluateFirstPartyRosMarginalReleaseGate,
  prepareFirstPartyRosMarginalRelease,
  type FirstPartyRosMarginalLiveForecast,
  type FirstPartyRosMarginalReleaseInput,
} from "./marginal-ros-release.js";
import { validateMarginalRosTrainingCohort } from "./marginal-ros-training.js";
import {
  evaluateFirstPartyRosChampionPolicy,
  evaluateFirstPartyRosReleaseGate,
  FIRST_PARTY_ROS_POLICY_VERSION,
  type FirstPartyRosChampionChoice,
  type FirstPartyRosChampionPolicy,
  type FirstPartyRosLiveReleaseEvidence,
  type FirstPartyRosReleaseGateReason,
} from "./rest-of-season.js";
import {
  buildRosMarginalIntervalQualification,
  type RosMarginalQualificationDataset,
} from "./ros-marginal-interval-qualification.js";
import { rosMarginalIntervalQualificationFixtureInput } from "./ros-marginal-interval-test-fixtures.js";
import { rosScoringProfile } from "./ros-scoring-profiles.js";
import { projectionScoringProfileKey } from "./scoring.js";
import { sha256Hex } from "./sha256.js";

const YEARS = [2022, 2023, 2024, 2025];
const CELL = { position: "DST", bucket: "one-to-four" } as const;

function fixture(
  mode: "normal" | "failed-screen" | "block-outliers" | "contextual-shifted-median" = "normal",
) {
  const pinned = rosMarginalIntervalQualificationFixtureInput();
  function amend(dataset: RosMarginalQualificationDataset): RosMarginalQualificationDataset {
    if (mode === "normal") return dataset;
    const heldOutSeasons = dataset.heldOutSeasons.map((year) => ({
      ...year,
      forecasts: year.forecasts.map((row) => {
        const actualPoints =
          row.actualPoints +
          (mode === "failed-screen" && year.season === 2025
            ? 20 * row.evidence.availability.scheduledGames
            : 0) +
          (mode === "block-outliers" && row.playerId === "DST:MIA"
            ? 10 ** (year.season - 2019)
            : 0);
        return {
          ...row,
          actualPoints,
          inputChecksum: sha256Hex(`${row.inputChecksum}:${mode}`),
          contextual: {
            ...row.contextual,
            meanPoints: actualPoints + (mode === "contextual-shifted-median" ? 0 : 1),
            p50Points: row.contextual.p50Points * (mode === "contextual-shifted-median" ? 0.75 : 1),
          },
          recency: {
            ...row.recency,
            meanPoints: actualPoints + 1,
            p50Points: row.recency.p50Points * (mode === "contextual-shifted-median" ? 0.75 : 1),
          },
        };
      }),
    }));
    return {
      ...dataset,
      heldOutSeasons,
      source: {
        ...dataset.source,
        physicalCorpusChecksum: sha256Hex(`${dataset.source.physicalCorpusChecksum}:${mode}`),
        reportChecksum: sha256Hex(`${dataset.source.reportChecksum}:${mode}`),
      },
      rowsChecksum: validateMarginalRosTrainingCohort(heldOutSeasons, heldOutSeasons).provenance
        .evaluationRowsChecksum,
    };
  }
  const candidate = amend(pinned.candidate);
  const qualification = buildRosMarginalIntervalQualification({
    ...pinned,
    cell: CELL,
    candidate,
    previous: amend(pinned.previous),
  });
  const meanPolicy = evaluateFirstPartyRosChampionPolicy(
    candidate.heldOutSeasons,
    qualification.meanSelectorOptions,
  ).livePolicy;
  const live: FirstPartyRosLiveReleaseEvidence = {
    ...meanPolicy.evidenceIdentity!,
    ...CELL,
    inputChecksum: sha256Hex("live-cell-inputs"),
    coverage: { contextual: 1, recency: 1 },
    availability: { scheduledGames: 4, contextualExpectedGames: 4, recencyExpectedGames: 4 },
    convergence: {
      contextual: { state: "converged", diagnosticChecksum: sha256Hex("live-contextual") },
      recency: { state: "converged", diagnosticChecksum: sha256Hex("live-recency") },
    },
  };
  return {
    meanPolicy,
    live,
    expectedForecastSeason: 2026,
    admittedQualification: qualification,
  } satisfies FirstPartyRosMarginalReleaseInput;
}

function withChoice(
  input: FirstPartyRosMarginalReleaseInput,
  change: (choice: FirstPartyRosChampionChoice) => FirstPartyRosChampionChoice,
): FirstPartyRosMarginalReleaseInput {
  return {
    ...input,
    meanPolicy: {
      ...input.meanPolicy,
      choices: input.meanPolicy.choices.map((choice) =>
        choice.position === CELL.position && choice.bucket === CELL.bucket
          ? change(choice)
          : choice,
      ),
    },
  };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, field]) => `${JSON.stringify(key)}:${canonical(field)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function forge(value: Record<string, unknown>) {
  const body = { ...value };
  delete body.qualificationChecksum;
  return { ...body, qualificationChecksum: sha256Hex(canonical(body)) };
}

function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, child]) => [key, reverseKeys(child)]),
    );
  }
  return value;
}

let base: ReturnType<typeof fixture>;
let failed: ReturnType<typeof fixture>;
let blockOutliers: ReturnType<typeof fixture>;
let contextual: ReturnType<typeof fixture>;
beforeAll(() => {
  base = fixture();
  failed = fixture("failed-screen");
  blockOutliers = fixture("block-outliers");
  contextual = fixture("contextual-shifted-median");
}, 30_000);

function forecast(
  overrides: Partial<FirstPartyRosMarginalLiveForecast> = {},
): FirstPartyRosMarginalLiveForecast {
  return {
    playerId: "DST:LAR",
    ...CELL,
    strategy: base.admittedQualification.strategy,
    inputChecksum: sha256Hex("live-player-inputs"),
    evidenceIdentity: { ...base.meanPolicy.evidenceIdentity! },
    meanPoints: 9.125,
    forecastSeason: 2026,
    asOfWeek: 14,
    windowStartWeek: 15,
    windowEndWeek: 18,
    scheduledGames: 4,
    p15Points: 4,
    p50Points: 8,
    p85Points: 12,
    ...overrides,
  };
}

describe("marginal live release adapter", () => {
  it("uses an authenticated qualified cell without changing the frozen mean policy", () => {
    const before = structuredClone(base);
    const result = evaluateFirstPartyRosMarginalReleaseGate(base);
    expect(base.admittedQualification.state).toBe("qualified");
    expect(result).toMatchObject({
      state: "release",
      strategy: "availability-aware-recency",
      reasons: [],
      intervalCalibration: "season-prior-weighted-quantile-residuals-v1",
      qualificationChecksum: base.admittedQualification.qualificationChecksum,
      calibrationArtifactChecksum: base.admittedQualification.liveArtifact.artifactChecksum,
      legacyEvidenceChecksum: evaluateFirstPartyRosReleaseGate(base.meanPolicy, base.live)
        .evidenceChecksum,
    });
    expect(result.evidenceChecksum).toMatch(/^[a-f0-9]{64}$/u);
    expect(base).toEqual(before);
    expect(base.meanPolicy.policyVersion).toBe(FIRST_PARTY_ROS_POLICY_VERSION);
  });

  it("replaces the old block-coverage requirement with actual passing marginal evidence and both WIS comparators", () => {
    const legacy = evaluateFirstPartyRosReleaseGate(blockOutliers.meanPolicy, blockOutliers.live);
    expect(legacy.reasons).toContain("interval-coverage-gate-failed");
    expect(blockOutliers.admittedQualification.state).toBe("qualified");
    expect(blockOutliers.admittedQualification.comparison.state).toBe("passed");
    expect(
      Object.keys(blockOutliers.admittedQualification.comparison.benchmarkSources).sort(),
    ).toEqual(["previous-deployed", "same-physics-legacy"]);
    expect(evaluateFirstPartyRosMarginalReleaseGate(blockOutliers).state).toBe("release");
  });

  it("is stable across JSONB ordering for both the admission and current mean policy", () => {
    const reordered = {
      ...base,
      admittedQualification: reverseKeys(base.admittedQualification),
      meanPolicy: reverseKeys(base.meanPolicy) as FirstPartyRosChampionPolicy,
    };
    expect(evaluateFirstPartyRosMarginalReleaseGate(reordered)).toEqual(
      evaluateFirstPartyRosMarginalReleaseGate(base),
    );
  });

  const independentFailures: readonly [
    FirstPartyRosReleaseGateReason,
    (input: FirstPartyRosMarginalReleaseInput) => FirstPartyRosMarginalReleaseInput,
  ][] = [
    [
      "invalid-mean-selection-evidence",
      (input) =>
        withChoice(input, (choice) => ({
          ...choice,
          meanSelectionEvidence: {
            ...choice.meanSelectionEvidence,
            contextualMse: 999,
          },
        })),
    ],
    [
      "missing-policy-evidence",
      (input) => ({ ...input, meanPolicy: { ...input.meanPolicy, choices: [] } }),
    ],
    [
      "evidence-identity-mismatch",
      (input) => ({ ...input, live: { ...input.live, contextualModelVersion: "wrong-model" } }),
    ],
    [
      "invalid-live-evidence",
      (input) => ({ ...input, live: { ...input.live, inputChecksum: "bad-digest" } }),
    ],
    [
      "insufficient-held-out-evidence",
      (input) =>
        withChoice(input, (choice) => ({
          ...choice,
          heldOutEvidence: { ...choice.heldOutEvidence, state: "insufficient-evidence" },
        })),
    ],
    [
      "input-coverage-below-threshold",
      (input) => ({
        ...input,
        live: { ...input.live, coverage: { ...input.live.coverage, recency: 0.94 } },
      }),
    ],
    [
      "availability-error-above-threshold",
      (input) =>
        withChoice(input, (choice) => ({
          ...choice,
          heldOutEvidence: { ...choice.heldOutEvidence, recencyAvailabilityMae: 4 },
        })),
    ],
    [
      "availability-bias-above-threshold",
      (input) =>
        withChoice(input, (choice) => ({
          ...choice,
          heldOutEvidence: { ...choice.heldOutEvidence, recencyAvailabilityBias: 1.01 },
        })),
    ],
    [
      "convergence-gate-failed",
      (input) => ({
        ...input,
        live: {
          ...input.live,
          convergence: {
            ...input.live.convergence,
            recency: { ...input.live.convergence.recency, state: "unstable" },
          },
        },
      }),
    ],
    [
      "no-expected-games",
      (input) => ({
        ...input,
        live: {
          ...input.live,
          availability: { ...input.live.availability, recencyExpectedGames: 0 },
        },
      }),
    ],
  ];
  it.each(independentFailures)("preserves independent legacy failure %s", (reason, change) => {
    const input = change(base);
    expect(evaluateFirstPartyRosReleaseGate(input.meanPolicy, input.live).reasons).toContain(
      reason,
    );
    const result = evaluateFirstPartyRosMarginalReleaseGate(input);
    expect(result.state).toBe("withhold");
    expect(result.reasons).toContain(reason);
    expect(result.strategy).toBeNull();
    expect(result.calibrationArtifactChecksum).toBeNull();
    expect(result.intervalCalibration).toBe("not-calibrated");
  });

  it("does not block a chosen recency strategy on unselected contextual convergence", () => {
    const live = {
      ...base.live,
      convergence: {
        ...base.live.convergence,
        contextual: { ...base.live.convergence.contextual, state: "unstable" as const },
      },
    };
    expect(evaluateFirstPartyRosMarginalReleaseGate({ ...base, live }).state).toBe("release");
  });

  it.each([2025, 2027, 2026.5, NaN])(
    "rejects wrong or malformed forecast season %s",
    (expectedForecastSeason) => {
      const result = evaluateFirstPartyRosMarginalReleaseGate({ ...base, expectedForecastSeason });
      expect(result.reasons).toContain("marginal-season-mismatch");
    },
  );

  it("binds the current policy's evidence cutoff and frozen selector settings", () => {
    for (const change of [
      { evidenceThroughSeason: 2026 },
      { minimumSamples: 1 },
      { minimumModelImprovement: 0 },
      { globalSamples: 1 },
    ]) {
      const result = evaluateFirstPartyRosMarginalReleaseGate({
        ...base,
        meanPolicy: { ...base.meanPolicy, ...change },
      });
      expect(result.state).toBe("withhold");
      expect(
        result.reasons.some(
          (reason) =>
            reason === "marginal-season-mismatch" || reason === "marginal-mean-policy-mismatch",
        ),
      ).toBe(true);
    }
  });

  it("binds the exact current cell and strategy, including duplicate current choices", () => {
    expect(
      evaluateFirstPartyRosMarginalReleaseGate({
        ...base,
        live: { ...base.live, bucket: "five-to-eight" },
      }).reasons,
    ).toContain("marginal-cell-mismatch");
    expect(
      evaluateFirstPartyRosMarginalReleaseGate({ ...base, live: { ...base.live, position: "K" } })
        .reasons,
    ).toContain("marginal-cell-mismatch");
    const switched = withChoice(base, (choice) => ({ ...choice, strategy: "contextual" }));
    expect(evaluateFirstPartyRosMarginalReleaseGate(switched).reasons).toContain(
      "marginal-strategy-mismatch",
    );
    const duplicate = {
      ...base,
      meanPolicy: {
        ...base.meanPolicy,
        choices: [...base.meanPolicy.choices, base.admittedQualification.meanChoice],
      },
    };
    expect(evaluateFirstPartyRosMarginalReleaseGate(duplicate).reasons).toContain(
      "marginal-mean-choice-mismatch",
    );
  });

  it("rejects a changed mean choice even when its point-selection proof still passes", () => {
    const changed = withChoice(base, (choice) => ({
      ...choice,
      recencyMae: choice.recencyMae + 0.01,
    }));
    expect(evaluateFirstPartyRosReleaseGate(changed.meanPolicy, changed.live).state).toBe(
      "release",
    );
    expect(evaluateFirstPartyRosMarginalReleaseGate(changed).reasons).toContain(
      "marginal-mean-choice-mismatch",
    );
  });

  it("preserves position-scoped scoring identity while rejecting a changed defense rule", () => {
    const unrelated = {
      ...base,
      live: { ...base.live, scoringProfileKey: rosScoringProfile("half-ppr").scoringProfileKey },
    };
    expect(evaluateFirstPartyRosMarginalReleaseGate(unrelated).state).toBe("release");
    const profile = rosScoringProfile("full-ppr").profile;
    const changed = projectionScoringProfileKey({
      ...profile,
      rules: profile.rules.map((rule) =>
        rule.statId === "defensive_sacks" ? { ...rule, points: 0.5 } : rule,
      ),
    });
    const result = evaluateFirstPartyRosMarginalReleaseGate({
      ...base,
      live: { ...base.live, scoringProfileKey: changed },
    });
    expect(result.reasons).toContain("evidence-identity-mismatch");
    expect(result.reasons).toContain("marginal-evidence-identity-mismatch");
  });

  it("withholds a structurally valid failed historical qualification", () => {
    expect(failed.admittedQualification.state).toBe("failed-qualification");
    const result = evaluateFirstPartyRosMarginalReleaseGate(failed);
    expect(result.reasons).toContain("marginal-qualification-failed");
    expect(result.qualificationChecksum).toBe(failed.admittedQualification.qualificationChecksum);
  });

  it.each([null, {}, [], "admitted", { qualificationChecksum: sha256Hex("claim") }])(
    "rejects malformed qualification %j safely",
    (admittedQualification) => {
      expect(
        evaluateFirstPartyRosMarginalReleaseGate({ ...base, admittedQualification }).reasons,
      ).toContain("invalid-marginal-qualification");
    },
  );

  it("rejects receipt tampering, omitted WIS comparators, and in-season fit leakage even when the outer hash is recomputed", () => {
    const qualification = base.admittedQualification;
    const changes: unknown[] = [
      { ...qualification, qualificationChecksum: sha256Hex("tampered") },
      forge({ ...qualification, strategy: "contextual" }),
      forge({ ...qualification, comparison: { ...qualification.comparison, benchmarkWis: {} } }),
      forge({
        ...qualification,
        liveArtifact: {
          ...qualification.liveArtifact,
          fit: { ...qualification.liveArtifact.fit, priorSeasons: [...YEARS, 2026] },
        },
      }),
      forge({
        ...qualification,
        meanSelectorOptions: { ...qualification.meanSelectorOptions, minimumSamples: 1 },
      }),
    ];
    for (const admittedQualification of changes) {
      expect(
        evaluateFirstPartyRosMarginalReleaseGate({ ...base, admittedQualification }).reasons,
      ).toContain("invalid-marginal-qualification");
    }
  });

  it("fails closed on a malformed legacy policy rather than throwing or publishing raw intervals", () => {
    const result = evaluateFirstPartyRosMarginalReleaseGate({
      ...base,
      meanPolicy: null as unknown as FirstPartyRosChampionPolicy,
    });
    expect(result.state).toBe("withhold");
    expect(result.reasons).toContain("invalid-legacy-release-evidence");
  });
});

describe("marginal live correction", () => {
  it("preserves a contextual mean choice and actually corrects its P50", () => {
    const input = {
      ...contextual,
      live: {
        ...contextual.live,
        convergence: {
          ...contextual.live.convergence,
          recency: { ...contextual.live.convergence.recency, state: "unstable" as const },
        },
      },
    };
    expect(evaluateFirstPartyRosMarginalReleaseGate(input).strategy).toBe("contextual");
    const raw = forecast({ strategy: "contextual", p50Points: 6 });
    const result = applyFirstPartyRosMarginalRelease({ ...input, forecast: raw });
    expect([result.p15Points, result.p50Points, result.p85Points]).toEqual([8, 8, 8]);
    expect(result.meanPoints).toBe(raw.meanPoints);
  });

  it("prepares an immutable cell once without retaining mutable admission or policy objects", () => {
    const mutable = structuredClone(base);
    const prepared = prepareFirstPartyRosMarginalRelease(mutable);
    const expected = prepared.apply(forecast());
    Object.assign(mutable.admittedQualification.liveArtifact.fit, { corrections: [99, 99, 99] });
    Object.assign(mutable.admittedQualification, { qualificationChecksum: sha256Hex("changed") });
    Object.assign(mutable.live, { scoringProfileKey: "changed", position: "K" });
    Object.assign(mutable.meanPolicy, { choices: [] });
    expect(prepared.apply(forecast())).toEqual(expected);
    expect(prepared.apply(forecast({ playerId: "DST:BUF", meanPoints: -0 })).meanPoints).toBe(-0);
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.decision)).toBe(true);
    expect(Object.isFrozen(prepared.decision.reasons)).toBe(true);
    expect(() => prepared.apply(forecast({ position: "K" }))).toThrow("forecast binding");
    expect(() => prepareFirstPartyRosMarginalRelease(mutable)).toThrow("withheld");
  });

  it("applies all three per-game residuals and preserves exact mean and all source fields", () => {
    const raw = {
      ...forecast(),
      opaqueSource: { checksum: sha256Hex("physics"), bytes: [1, 2, 3] },
    };
    const before = structuredClone(raw);
    const result = applyFirstPartyRosMarginalRelease({ ...base, forecast: raw });
    expect(result).toMatchObject({
      p15Points: 8,
      p50Points: 8,
      p85Points: 8,
      meanPoints: raw.meanPoints,
    });
    expect(result.opaqueSource).toBe(raw.opaqueSource);
    expect(result.evidenceIdentity).toBe(raw.evidenceIdentity);
    for (const key of [
      "playerId",
      "position",
      "strategy",
      "inputChecksum",
      "forecastSeason",
      "asOfWeek",
      "windowStartWeek",
      "windowEndWeek",
      "scheduledGames",
    ] as const)
      expect(result[key]).toBe(raw[key]);
    expect(result.marginalIntervalCalibration.qualificationChecksum).toBe(
      base.admittedQualification.qualificationChecksum,
    );
    expect(result.marginalIntervalCalibration.calibrationArtifactChecksum).toBe(
      base.admittedQualification.liveArtifact.artifactChecksum,
    );
    expect(raw).toEqual(before);
  });

  it("reorders crossed corrected quantiles while preserving a negative fractional mean", () => {
    const raw = forecast({ p15Points: 0, p50Points: 1, p85Points: 2, meanPoints: -1.375 });
    const result = applyFirstPartyRosMarginalRelease({ ...base, forecast: raw });
    expect([result.p15Points, result.p50Points, result.p85Points]).toEqual([-2, 1, 4]);
    expect(result.meanPoints).toBe(-1.375);
    expect(result.marginalIntervalCalibration.rearrangement).toMatchObject({
      crossed: true,
      unsorted: [4, 1, -2],
      permutation: [2, 1, 0],
    });
  });

  it("uses exact scheduled games, including byes, instead of calendar-window length", () => {
    const result = applyFirstPartyRosMarginalRelease({
      ...base,
      forecast: forecast({ scheduledGames: 3 }),
    });
    expect([result.p15Points, result.p50Points, result.p85Points]).toEqual([7, 8, 9]);
  });

  it("rejects applying the correction twice to an already calibrated forecast", () => {
    const corrected = applyFirstPartyRosMarginalRelease({ ...base, forecast: forecast() });
    expect(() => applyFirstPartyRosMarginalRelease({ ...base, forecast: corrected })).toThrow(
      "forecast binding",
    );
  });

  it("allows an irrelevant scoring change through the same position-scoped contract", () => {
    const scoringProfileKey = rosScoringProfile("half-ppr").scoringProfileKey;
    const raw = forecast({
      evidenceIdentity: { ...base.meanPolicy.evidenceIdentity!, scoringProfileKey },
    });
    const result = applyFirstPartyRosMarginalRelease({
      ...base,
      live: { ...base.live, scoringProfileKey },
      forecast: raw,
    });
    expect(result.evidenceIdentity.scoringProfileKey).toBe(scoringProfileKey);
    expect(result.p50Points).toBe(8);
  });

  it.each([
    { forecastSeason: 2025 },
    { strategy: "contextual" },
    { position: "K" },
    { playerId: "" },
    { inputChecksum: "invalid" },
    { meanPoints: NaN },
    { scheduledGames: 0 },
    { scheduledGames: 5 },
    { scheduledGames: 2.5 },
    { asOfWeek: 15 },
    { asOfWeek: 12, windowStartWeek: 13 },
    { windowEndWeek: 19 },
    { p15Points: 9 },
    { p85Points: Infinity },
  ] satisfies Partial<FirstPartyRosMarginalLiveForecast>[])(
    "rejects malformed or unbound forecast %j with no raw fallback",
    (overrides) => {
      expect(() =>
        applyFirstPartyRosMarginalRelease({ ...base, forecast: forecast(overrides) }),
      ).toThrow();
    },
  );

  it("rechecks the independent gate before application and rejects changed scoring lineage", () => {
    const withheld = {
      ...base,
      live: { ...base.live, availability: { ...base.live.availability, recencyExpectedGames: 0 } },
      forecast: forecast(),
    };
    expect(() => applyFirstPartyRosMarginalRelease(withheld)).toThrow("no-expected-games");
    expect(() =>
      applyFirstPartyRosMarginalRelease({
        ...base,
        forecast: forecast({
          evidenceIdentity: {
            ...base.meanPolicy.evidenceIdentity!,
            intervalMethodVersion: "different-raw-method",
          },
        }),
      }),
    ).toThrow("forecast binding");
  });
});
