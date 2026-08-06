import {
  FIRST_PARTY_ROS_AVAILABILITY_EVIDENCE_ALPHA,
  FIRST_PARTY_ROS_COVERAGE_EVIDENCE_ALPHA,
  FIRST_PARTY_ROS_MAXIMUM_AVAILABILITY_ROW_ERROR,
  FIRST_PARTY_ROS_MAX_AVAILABILITY_BIAS,
  FIRST_PARTY_ROS_MAX_AVAILABILITY_MAE,
  FIRST_PARTY_ROS_MAX_NINE_PLUS_AVAILABILITY_MAE,
  FIRST_PARTY_ROS_MINIMUM_BATCHES,
  FIRST_PARTY_ROS_MINIMUM_HELD_OUT_SEASONS,
  FIRST_PARTY_ROS_MINIMUM_SAMPLES,
  type FirstPartyRosChampionChoice,
  type FirstPartyRosDerivedHeldOutEvidence,
  type FirstPartyRosIntervalCalibrationArtifact,
  type FirstPartyRosPosition,
  type FirstPartyRosRemainingWeeksBucket,
  type FirstPartyRosStrategy,
  type FirstPartyRosWalkForwardCalibrationEvidence,
} from "@laces-out/projections";

import { historicalRosCalibrationBlockers } from "./first-party-ros-backtest.js";

/**
 * Re-evaluates a completed rest-of-season validation report's release gate from the evidence that
 * report already carries, without re-running the multi-hour forecast build.
 *
 * The release gate is a pure function of the champion choices: `historicalRosCalibrationBlockers`
 * reads held-out evidence, walk-forward calibration evidence, interval-calibration state and
 * convergence rates, and compares them against ceiling constants. It touches no forecast, no
 * simulation and no database. When only a ceiling moves, the forecasts are identical by
 * construction and nothing but the comparison changes, so replaying the build would burn hours
 * regenerating byte-identical numbers.
 *
 * This module therefore reuses `historicalRosCalibrationBlockers` verbatim — it never reimplements
 * the gate — and rebuilds the composed blocker list in exactly the order
 * `buildHistoricalRosBacktest` composes it. The equivalence proof lives in
 * `first-party-ros-regate.test.ts`: re-gating each stored report must reproduce exactly the verdict
 * a fresh run of the current code would reach. The stored reports predate availability MAE gate v3
 * (2026-07-28), so that proof is taken in two halves — every stored verdict reproduced byte-exactly
 * with the availability evidence test forced to "evidence present" (which is precisely the
 * superseded rule those reports were graded under), and, under the shipped gate, a blocker list
 * that differs from the stored one only by the availability-MAE entries the evidence test clears.
 * Without that proof the path is not faithful and must not be used.
 */

/** The gate ceilings a re-gated report is graded under, read live from the running constants. */
export interface FirstPartyRosRegateCeilings {
  readonly availabilityMae: number;
  readonly ninePlusAvailabilityMae: number;
  readonly availabilityBias: number;
  /** Availability MAE gate v3: the one-sided level the ceilings above are tested at. */
  readonly availabilityEvidenceAlpha: number;
  /** Per-bucket support bound the availability evidence test's null distribution is built on. */
  readonly maximumAvailabilityRowError: Readonly<Record<string, number>>;
  readonly coverageEvidenceAlpha: number;
  readonly minimumHeldOutSeasons: number;
  readonly minimumPortfolioBatches: number;
  readonly minimumPortfolioForecasts: number;
}

/**
 * Snapshots the release-gate ceilings from the running code, the same way
 * `firstPartyRosAdmissionConstants` snapshots the admission identities. Only exported constants are
 * recorded: the remaining thresholds inside `historicalRosCalibrationBlockers` are inline literals,
 * and mirroring them here would let this snapshot drift into a false claim.
 */
export function firstPartyRosRegateCeilings(): FirstPartyRosRegateCeilings {
  return {
    availabilityMae: FIRST_PARTY_ROS_MAX_AVAILABILITY_MAE,
    ninePlusAvailabilityMae: FIRST_PARTY_ROS_MAX_NINE_PLUS_AVAILABILITY_MAE,
    availabilityBias: FIRST_PARTY_ROS_MAX_AVAILABILITY_BIAS,
    availabilityEvidenceAlpha: FIRST_PARTY_ROS_AVAILABILITY_EVIDENCE_ALPHA,
    maximumAvailabilityRowError: { ...FIRST_PARTY_ROS_MAXIMUM_AVAILABILITY_ROW_ERROR },
    coverageEvidenceAlpha: FIRST_PARTY_ROS_COVERAGE_EVIDENCE_ALPHA,
    minimumHeldOutSeasons: FIRST_PARTY_ROS_MINIMUM_HELD_OUT_SEASONS,
    minimumPortfolioBatches: FIRST_PARTY_ROS_MINIMUM_BATCHES,
    minimumPortfolioForecasts: FIRST_PARTY_ROS_MINIMUM_SAMPLES,
  };
}

export type FirstPartyRosRegateResult =
  | { readonly state: "unusable"; readonly reasons: readonly string[] }
  | {
      readonly state: "re-gated";
      /** The source report with `report.state`/`report.blockers` replaced and `regate` prepended. */
      readonly report: Record<string, unknown>;
      readonly sourceState: string;
      readonly sourceBlockers: readonly string[];
      readonly blockers: readonly string[];
      readonly reportState: "evidence-ready" | "insufficient";
      readonly verdictChanged: boolean;
      readonly ceilings: FirstPartyRosRegateCeilings;
    };

/**
 * Fail-closed stand-in for a gate input the stored report does not carry. Reaching one means the
 * gate asked for evidence this path cannot honestly supply, so it stops instead of inventing a
 * value. Every field guarded this way is unread by the release gate today; the throw is what keeps
 * that true if the gate ever grows a new clause.
 *
 * These objects must never be spread or serialised — a spread would invoke every getter.
 */
function absent(field: string): never {
  throw new Error(
    `Re-gate refused: ${field} is not recorded in the stored validation report, so the release ` +
      "gate verdict cannot be recomputed from stored evidence. Re-run the validation instead.",
  );
}

/**
 * Structural reconstruction of the two `evidenceChecksum` fields the validation report does not
 * serialise. Both are only ever tested for nullity by the gate, and in both producers nullity is
 * decided by the same condition as the state the report does record:
 *
 * - `derivedHeldOutEvidence` returns `null` exactly when the cell holds zero evidence records, and
 *   returns state `derived-immutable-not-calibrated` only when `enoughEvidence` holds, which needs
 *   at least `FIRST_PARTY_ROS_MINIMUM_CELL_SAMPLES` (18) paired records. Records and paired errors
 *   are appended together, so that state implies a non-null checksum.
 * - `walkForwardCalibrationEvidence` sets state `unavailable` and checksum `null` under exactly the
 *   same condition (zero records).
 *
 * So `state !== X || checksum === null` reduces to `state !== X` in both clauses, and this
 * reconstruction cannot change a verdict. The sentinel is internal and never emitted.
 */
const RECONSTRUCTED_CHECKSUM = "reconstructed-non-null-from-stored-state";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Collects a precise reason for every unreadable field instead of failing on the first one. */
class Reader {
  readonly reasons: string[] = [];

  object(value: unknown, path: string): Record<string, unknown> {
    if (isObject(value)) return value;
    this.reasons.push(`${path}_missing_or_not_an_object`);
    return {};
  }

  array(value: unknown, path: string): readonly unknown[] {
    if (Array.isArray(value)) return value;
    this.reasons.push(`${path}_missing_or_not_an_array`);
    return [];
  }

  number(value: unknown, path: string): number {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    this.reasons.push(`${path}_missing_or_not_a_finite_number`);
    return Number.NaN;
  }

  integer(value: unknown, path: string): number {
    if (Number.isSafeInteger(value)) return value as number;
    this.reasons.push(`${path}_missing_or_not_an_integer`);
    return Number.NaN;
  }

  string(value: unknown, path: string): string {
    if (typeof value === "string") return value;
    this.reasons.push(`${path}_missing_or_not_a_string`);
    return "";
  }

  stringArray(value: unknown, path: string): readonly string[] {
    if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
      return value;
    }
    this.reasons.push(`${path}_missing_or_not_a_string_array`);
    return [];
  }

  boolean(value: unknown, path: string): boolean {
    if (typeof value === "boolean") return value;
    this.reasons.push(`${path}_missing_or_not_a_boolean`);
    return false;
  }

  nullableNumber(value: unknown, path: string): number | null {
    return value === null ? null : this.number(value, path);
  }

  agree(left: number, right: number, path: string, against: string): void {
    if (!Object.is(left, right)) this.reasons.push(`${path}_disagrees_with_${against}`);
  }
}

interface StoredArtifact {
  readonly state: string;
  readonly nominalCoverage: number;
  readonly adjustmentPoints: number;
}

/**
 * The interval-calibration artifact as the report records it. `state`, `nominalCoverage` and
 * `adjustmentPoints` are the only fields the report carries; everything else refuses. Pass `null`
 * for the strategy that was not selected, which the gate never inspects.
 */
function intervalCalibrationArtifact(
  path: string,
  stored: StoredArtifact | null,
): FirstPartyRosIntervalCalibrationArtifact {
  return {
    get state(): FirstPartyRosIntervalCalibrationArtifact["state"] {
      return stored === null
        ? absent(`${path}.state`)
        : (stored.state as FirstPartyRosIntervalCalibrationArtifact["state"]);
    },
    get nominalCoverage(): FirstPartyRosIntervalCalibrationArtifact["nominalCoverage"] {
      return stored === null
        ? absent(`${path}.nominalCoverage`)
        : (stored.nominalCoverage as FirstPartyRosIntervalCalibrationArtifact["nominalCoverage"]);
    },
    get adjustmentPoints(): number {
      return stored === null ? absent(`${path}.adjustmentPoints`) : stored.adjustmentPoints;
    },
    get calibrationVersion(): FirstPartyRosIntervalCalibrationArtifact["calibrationVersion"] {
      return absent(`${path}.calibrationVersion`);
    },
    get strategy(): FirstPartyRosStrategy {
      return absent(`${path}.strategy`);
    },
    get position(): FirstPartyRosPosition {
      return absent(`${path}.position`);
    },
    get bucket(): FirstPartyRosRemainingWeeksBucket {
      return absent(`${path}.bucket`);
    },
    get evidenceIdentity(): FirstPartyRosIntervalCalibrationArtifact["evidenceIdentity"] {
      return absent(`${path}.evidenceIdentity`);
    },
    get lowerQuantile(): FirstPartyRosIntervalCalibrationArtifact["lowerQuantile"] {
      return absent(`${path}.lowerQuantile`);
    },
    get upperQuantile(): FirstPartyRosIntervalCalibrationArtifact["upperQuantile"] {
      return absent(`${path}.upperQuantile`);
    },
    get observedCalibratedBlockCoverage(): number {
      return absent(`${path}.observedCalibratedBlockCoverage`);
    },
    get trainedThroughSeason(): number | null {
      return absent(`${path}.trainedThroughSeason`);
    },
    get seasons(): number {
      return absent(`${path}.seasons`);
    },
    get blocks(): number {
      return absent(`${path}.blocks`);
    },
    get samples(): number {
      return absent(`${path}.samples`);
    },
    get evidenceChecksum(): string | null {
      return absent(`${path}.evidenceChecksum`);
    },
    get artifactChecksum(): string | null {
      return absent(`${path}.artifactChecksum`);
    },
  };
}

interface StoredWalkForward {
  readonly state: string;
  readonly observedBlockCoverage: number;
  readonly seasons: number;
  readonly blocks: number;
  readonly samples: number;
}

function walkForwardEvidence(
  path: string,
  stored: StoredWalkForward | null,
): FirstPartyRosWalkForwardCalibrationEvidence {
  return {
    get state(): FirstPartyRosWalkForwardCalibrationEvidence["state"] {
      return stored === null
        ? absent(`${path}.state`)
        : (stored.state as FirstPartyRosWalkForwardCalibrationEvidence["state"]);
    },
    get evidenceChecksum(): string | null {
      if (stored === null) return absent(`${path}.evidenceChecksum`);
      return stored.state === "available" ? RECONSTRUCTED_CHECKSUM : null;
    },
    get observedBlockCoverage(): number {
      return stored === null
        ? absent(`${path}.observedBlockCoverage`)
        : stored.observedBlockCoverage;
    },
    get seasons(): number {
      return stored === null ? absent(`${path}.seasons`) : stored.seasons;
    },
    get blocks(): number {
      return stored === null ? absent(`${path}.blocks`) : stored.blocks;
    },
    get samples(): number {
      return stored === null ? absent(`${path}.samples`) : stored.samples;
    },
  };
}

interface StoredHeldOut {
  readonly state: string;
  readonly selected: "contextual" | "recency";
  readonly contextualInputCoverage: number;
  readonly recencyInputCoverage: number;
  readonly contextualConvergenceRate: number;
  readonly recencyConvergenceRate: number;
  readonly contextualObservedIntervalCoverage: number;
  readonly recencyObservedIntervalCoverage: number;
  readonly selectedAvailabilityMae: number;
  readonly selectedAvailabilityBias: number;
}

/**
 * The report records availability MAE and bias only for the selected strategy — the only side the
 * gate reads. Asking for the other side is a real evidence gap, so it refuses rather than guessing.
 */
function heldOutEvidence(path: string, stored: StoredHeldOut): FirstPartyRosDerivedHeldOutEvidence {
  const state = stored.state as FirstPartyRosDerivedHeldOutEvidence["state"];
  return {
    state,
    evidenceChecksum: state === "derived-immutable-not-calibrated" ? RECONSTRUCTED_CHECKSUM : null,
    contextualObservedIntervalCoverage: stored.contextualObservedIntervalCoverage,
    recencyObservedIntervalCoverage: stored.recencyObservedIntervalCoverage,
    contextualMeanInputCoverage: stored.contextualInputCoverage,
    recencyMeanInputCoverage: stored.recencyInputCoverage,
    contextualConvergenceRate: stored.contextualConvergenceRate,
    recencyConvergenceRate: stored.recencyConvergenceRate,
    get contextualAvailabilityMae(): number {
      return stored.selected === "contextual"
        ? stored.selectedAvailabilityMae
        : absent(`${path}.contextualAvailabilityMae`);
    },
    get contextualAvailabilityBias(): number {
      return stored.selected === "contextual"
        ? stored.selectedAvailabilityBias
        : absent(`${path}.contextualAvailabilityBias`);
    },
    get recencyAvailabilityMae(): number {
      return stored.selected === "recency"
        ? stored.selectedAvailabilityMae
        : absent(`${path}.recencyAvailabilityMae`);
    },
    get recencyAvailabilityBias(): number {
      return stored.selected === "recency"
        ? stored.selectedAvailabilityBias
        : absent(`${path}.recencyAvailabilityBias`);
    },
    get nominalCentralIntervalCoverage(): FirstPartyRosDerivedHeldOutEvidence["nominalCentralIntervalCoverage"] {
      return absent(`${path}.nominalCentralIntervalCoverage`);
    },
    get seasons(): number {
      return absent(`${path}.seasons`);
    },
    get blocks(): number {
      return absent(`${path}.blocks`);
    },
    get samples(): number {
      return absent(`${path}.samples`);
    },
    get intervalCalibration(): FirstPartyRosDerivedHeldOutEvidence["intervalCalibration"] {
      return absent(`${path}.intervalCalibration`);
    },
  };
}

function choiceFromReport(
  reader: Reader,
  raw: unknown,
  index: number,
): FirstPartyRosChampionChoice {
  const path = `champion.choices[${index}]`;
  const entry = reader.object(raw, path);
  const strategy = reader.string(entry.strategy, `${path}.strategy`) as FirstPartyRosStrategy;
  const selected = strategy === "contextual" ? "contextual" : "recency";
  const other = selected === "contextual" ? "recency" : "contextual";

  const inputCoverage = reader.object(entry.inputCoverage, `${path}.inputCoverage`);
  const convergenceRate = reader.object(entry.convergenceRate, `${path}.convergenceRate`);
  const intervalCoverage = reader.object(
    entry.observedIntervalCoverage,
    `${path}.observedIntervalCoverage`,
  );
  const heldOut = reader.object(entry.selectedHeldOutEvidence, `${path}.selectedHeldOutEvidence`);
  const walkForward = reader.object(entry.walkForwardCalibration, `${path}.walkForwardCalibration`);

  const contextualInputCoverage = reader.number(
    inputCoverage.contextual,
    `${path}.inputCoverage.contextual`,
  );
  const recencyInputCoverage = reader.number(
    inputCoverage.recency,
    `${path}.inputCoverage.recency`,
  );
  const contextualConvergenceRate = reader.number(
    convergenceRate.contextual,
    `${path}.convergenceRate.contextual`,
  );
  const recencyConvergenceRate = reader.number(
    convergenceRate.recency,
    `${path}.convergenceRate.recency`,
  );
  const selectedInputCoverage = reader.number(
    heldOut.inputCoverage,
    `${path}.selectedHeldOutEvidence.inputCoverage`,
  );
  const selectedConvergenceRate = reader.number(
    heldOut.convergenceRate,
    `${path}.selectedHeldOutEvidence.convergenceRate`,
  );
  // The per-strategy and selected views of the same evidence must agree, or the report is not
  // internally consistent and no verdict can be trusted from it.
  reader.agree(
    selectedInputCoverage,
    selected === "contextual" ? contextualInputCoverage : recencyInputCoverage,
    `${path}.selectedHeldOutEvidence.inputCoverage`,
    `inputCoverage.${selected}`,
  );
  reader.agree(
    selectedConvergenceRate,
    selected === "contextual" ? contextualConvergenceRate : recencyConvergenceRate,
    `${path}.selectedHeldOutEvidence.convergenceRate`,
    `convergenceRate.${selected}`,
  );

  const evidence = heldOutEvidence(`${path}.heldOutEvidence`, {
    state: reader.string(heldOut.state, `${path}.selectedHeldOutEvidence.state`),
    selected,
    contextualInputCoverage,
    recencyInputCoverage,
    contextualConvergenceRate,
    recencyConvergenceRate,
    contextualObservedIntervalCoverage: reader.number(
      intervalCoverage.contextual,
      `${path}.observedIntervalCoverage.contextual`,
    ),
    recencyObservedIntervalCoverage: reader.number(
      intervalCoverage.recency,
      `${path}.observedIntervalCoverage.recency`,
    ),
    selectedAvailabilityMae: reader.number(
      heldOut.availabilityMae,
      `${path}.selectedHeldOutEvidence.availabilityMae`,
    ),
    selectedAvailabilityBias: reader.number(
      heldOut.availabilityBias,
      `${path}.selectedHeldOutEvidence.availabilityBias`,
    ),
  });

  const artifactPath = `${path}.intervalCalibrationArtifacts`;
  const artifacts = {
    [selected]: intervalCalibrationArtifact(`${artifactPath}.${selected}`, {
      state: reader.string(entry.selectedCalibrationState, `${path}.selectedCalibrationState`),
      nominalCoverage: reader.number(
        walkForward.nominalCoverage,
        `${path}.walkForwardCalibration.nominalCoverage`,
      ),
      adjustmentPoints: reader.number(
        entry.selectedCalibrationCorrectionPoints,
        `${path}.selectedCalibrationCorrectionPoints`,
      ),
    }),
    [other]: intervalCalibrationArtifact(`${artifactPath}.${other}`, null),
  } as FirstPartyRosChampionChoice["intervalCalibrationArtifacts"];

  const walkForwardPath = `${path}.walkForwardCalibrationEvidence`;
  const walkForwardEntries = {
    [selected]: walkForwardEvidence(`${walkForwardPath}.${selected}`, {
      state: reader.string(walkForward.state, `${path}.walkForwardCalibration.state`),
      observedBlockCoverage: reader.number(
        walkForward.observedBlockCoverage,
        `${path}.walkForwardCalibration.observedBlockCoverage`,
      ),
      seasons: reader.integer(walkForward.seasons, `${path}.walkForwardCalibration.seasons`),
      blocks: reader.integer(walkForward.blocks, `${path}.walkForwardCalibration.blocks`),
      samples: reader.integer(walkForward.samples, `${path}.walkForwardCalibration.samples`),
    }),
    [other]: walkForwardEvidence(`${walkForwardPath}.${other}`, null),
  } as FirstPartyRosChampionChoice["walkForwardCalibrationEvidence"];

  return {
    position: reader.string(entry.position, `${path}.position`) as FirstPartyRosPosition,
    bucket: reader.string(entry.bucket, `${path}.bucket`) as FirstPartyRosRemainingWeeksBucket,
    strategy,
    reason: reader.string(entry.reason, `${path}.reason`) as FirstPartyRosChampionChoice["reason"],
    heldOutSeasons: reader.integer(entry.heldOutSeasons, `${path}.heldOutSeasons`),
    batches: reader.integer(entry.batches, `${path}.batches`),
    samples: reader.integer(entry.samples, `${path}.samples`),
    modelImprovement: reader.number(entry.modelImprovement, `${path}.modelImprovement`),
    modelImprovementLowerBound: reader.nullableNumber(
      entry.modelImprovementLowerBound,
      `${path}.modelImprovementLowerBound`,
    ),
    intervalScoreDifferenceUpperBound: reader.nullableNumber(
      entry.intervalScoreDifferenceUpperBound,
      `${path}.intervalScoreDifferenceUpperBound`,
    ),
    intervalCalibration: reader.string(
      entry.intervalCalibration,
      `${path}.intervalCalibration`,
    ) as FirstPartyRosChampionChoice["intervalCalibration"],
    heldOutEvidence: evidence,
    intervalCalibrationArtifacts: artifacts,
    walkForwardCalibrationEvidence: walkForwardEntries,
    get globalBatches(): number {
      return absent(`${path}.globalBatches`);
    },
    get globalSeasons(): number {
      return absent(`${path}.globalSeasons`);
    },
    get globalSamples(): number {
      return absent(`${path}.globalSamples`);
    },
    get distinctCutoffs(): number {
      return absent(`${path}.distinctCutoffs`);
    },
    get contextualMae(): number {
      return absent(`${path}.contextualMae`);
    },
    get recencyMae(): number {
      return absent(`${path}.recencyMae`);
    },
    get contextualWeightedIntervalScore(): number {
      return absent(`${path}.contextualWeightedIntervalScore`);
    },
    get recencyWeightedIntervalScore(): number {
      return absent(`${path}.recencyWeightedIntervalScore`);
    },
    get pairedBlocks(): number {
      return absent(`${path}.pairedBlocks`);
    },
    get uncertaintyMethod(): FirstPartyRosChampionChoice["uncertaintyMethod"] {
      return absent(`${path}.uncertaintyMethod`);
    },
  };
}

export function regateFirstPartyRosReport(input: {
  readonly report: unknown;
  readonly sourceReportPath: string;
  readonly sourceReportSha256: string;
  readonly regatedAt: string;
}): FirstPartyRosRegateResult {
  if (!isObject(input.report)) return { state: "unusable", reasons: ["report_not_object"] };
  const source = input.report;
  if ("regate" in source) {
    // Re-gating a re-gate would launder provenance: the second output would cite the first as its
    // evidence source rather than the run that actually produced the forecasts.
    return { state: "unusable", reasons: ["source_report_is_already_a_re_gate_output"] };
  }

  const reader = new Reader();
  const body = reader.object(source.report, "report");
  const champion = reader.object(source.champion, "champion");
  const sourceState = reader.string(body.state, "report.state");
  const sourceBlockers = reader.stringArray(body.blockers, "report.blockers");
  const seasons = reader.array(body.seasons, "report.seasons");
  const forecasts = reader.integer(body.forecasts, "report.forecasts");
  const batches = reader.integer(body.batches, "report.batches");
  const choices = reader
    .array(champion.choices, "champion.choices")
    .map((raw, index) => choiceFromReport(reader, raw, index));
  const cells = reader.array(body.cells, "report.cells").map((raw, index) => {
    const path = `report.cells[${index}]`;
    const cell = reader.object(raw, path);
    return {
      ready: reader.boolean(cell.ready, `${path}.ready`),
      position: reader.string(cell.position, `${path}.position`),
      bucket: reader.string(cell.bucket, `${path}.bucket`),
      reasons: reader.stringArray(cell.reasons, `${path}.reasons`),
    };
  });
  const kickerOutOfBounds = reader
    .array(body.kickerFamilyAudit, "report.kickerFamilyAudit")
    .map((raw, index) => {
      const path = `report.kickerFamilyAudit[${index}]`;
      return reader.string(reader.object(raw, path).state, `${path}.state`);
    })
    .some((state) => state === "out-of-bounds");

  if (reader.reasons.length > 0) {
    return { state: "unusable", reasons: [...new Set(reader.reasons)] };
  }

  const ceilings = firstPartyRosRegateCeilings();
  // Composed in exactly the order `buildHistoricalRosBacktest` composes it, so the de-duplicated
  // list is order-identical to a fresh run's.
  const composed = [
    ...(seasons.length < ceilings.minimumHeldOutSeasons
      ? ["fewer_than_three_qualified_heldout_seasons"]
      : []),
    ...(batches < ceilings.minimumPortfolioBatches
      ? ["portfolio_cutoff_batches_below_minimum"]
      : []),
    ...(forecasts < ceilings.minimumPortfolioForecasts
      ? ["portfolio_forecasts_below_minimum"]
      : []),
    ...cells
      .filter((cell) => !cell.ready)
      .map((cell) => `cell_${cell.position}_${cell.bucket}_${cell.reasons.join("+")}`),
    ...choices
      .filter(
        (choice) => choice.reason.startsWith("insufficient") || choice.reason === "sparse-cell",
      )
      .map((choice) => `champion_${choice.position}_${choice.bucket}_${choice.reason}`),
    ...historicalRosCalibrationBlockers(choices),
    ...(kickerOutOfBounds
      ? [
          "calibration_K_one-to-four_count_family_dispersion_out_of_bounds",
          "calibration_K_five-to-eight_count_family_dispersion_out_of_bounds",
          "calibration_K_nine-plus_count_family_dispersion_out_of_bounds",
        ]
      : []),
  ];
  const blockers = [...new Set(composed)];
  const reportState = blockers.length === 0 ? "evidence-ready" : "insufficient";
  const verdictChanged =
    reportState !== sourceState ||
    blockers.length !== sourceBlockers.length ||
    blockers.some((blocker, index) => blocker !== sourceBlockers[index]);

  const regate = {
    mode: "gate-only-re-evaluation",
    claim:
      "Forecast evidence in this file came from the source validation run and is carried through " +
      "unchanged. Only the release gate was re-evaluated, from that stored evidence, against the " +
      "ceilings recorded below. This is NOT a fresh validation replay: no forecast, simulation, " +
      "backtest or database work was performed to produce it.",
    forecastEvidence: "carried-unchanged-from-source-run",
    freshValidationRun: false,
    sourceReportPath: input.sourceReportPath,
    sourceReportSha256: input.sourceReportSha256,
    sourceGeneratedAt: source.generatedAt ?? null,
    sourceState,
    sourceBlockers,
    regatedAt: input.regatedAt,
    verdictChanged,
    gateFunction:
      "historicalRosCalibrationBlockers (apps/worker/src/first-party-ros-backtest.ts), reused verbatim",
    ceilings,
    recomputed: ["report.state", "report.blockers"],
    carriedUnchanged: [
      "generatedAt",
      "elapsedSeconds",
      "scoringProfile",
      "availabilityAudit",
      "coverage",
      "identityAudit",
      "champion",
      "sources",
      "report.forecasts",
      "report.batches",
      "report.seasons",
      "report.cells",
      "report.convergenceAudit",
      "report.kickerFamilyAudit",
    ],
    reconstructedGateInputs: [
      "champion.choices[].heldOutEvidence.evidenceChecksum is not serialised. derivedHeldOutEvidence " +
        "returns null exactly when the cell holds zero evidence records, while state " +
        "'derived-immutable-not-calibrated' requires at least 18 paired records, so the gate clause " +
        "\"state !== 'derived-immutable-not-calibrated' || checksum === null\" reduces to the state " +
        "test alone. Reconstructed from the stored state on that identity.",
      "champion.choices[].walkForwardCalibrationEvidence[selected].evidenceChecksum is not " +
        "serialised. walkForwardCalibrationEvidence sets state 'unavailable' and checksum null under " +
        "exactly the same condition (zero records), so the gate clause \"state !== 'available' || " +
        'checksum === null" reduces to the state test alone. Reconstructed from the stored state on ' +
        "that identity.",
      "Nothing else was reconstructed: any other field the gate reads that the report does not carry " +
        "raises an error instead of being synthesised.",
    ],
    equivalenceProof:
      "apps/worker/src/first-party-ros-regate.test.ts re-gates every stored v8 validation report " +
      "and requires the original blockers and state back exactly under the availability-MAE rule " +
      "those reports were graded by (the point-estimate comparison superseded by availability MAE " +
      "gate v3 on 2026-07-28), then requires the shipped gate's blocker list to differ from the " +
      "stored one only by the availability-MAE entries the v3 evidence test clears.",
  };

  return {
    state: "re-gated",
    report: {
      regate,
      ...source,
      report: { ...body, state: reportState, blockers },
    },
    sourceState,
    sourceBlockers,
    blockers,
    reportState,
    verdictChanged,
    ceilings,
  };
}
