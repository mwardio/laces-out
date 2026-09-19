import {
  applyMarginalIntervalArtifact,
  marginalIntervalArtifactSeriesKey,
} from "./marginal-interval-artifact.js";
import {
  MARGINAL_INTERVAL_CALIBRATION_VERSION,
  type MarginalIntervalForecast,
} from "./marginal-interval-calibration.js";
import {
  evaluateFirstPartyRosReleaseGate,
  evidenceIdentitiesMatchForPosition,
  type FirstPartyRosChampionPolicy,
  type FirstPartyRosEvidenceIdentity,
  type FirstPartyRosLiveReleaseEvidence,
  type FirstPartyRosPosition,
  type FirstPartyRosReleaseGateReason,
  type FirstPartyRosStrategy,
} from "./rest-of-season.js";
import { rosMarginalIntervalQualificationIsStructurallyValid } from "./ros-marginal-interval-storage.js";
import type { RosMarginalIntervalQualification } from "./ros-marginal-interval-qualification.js";
import { sha256Hex } from "./sha256.js";

export const FIRST_PARTY_ROS_MARGINAL_RELEASE_VERSION = "marginal-ros-release-v1";

export interface FirstPartyRosMarginalReleaseInput {
  readonly meanPolicy: FirstPartyRosChampionPolicy;
  readonly live: FirstPartyRosLiveReleaseEvidence;
  readonly expectedForecastSeason: number;
  /**
   * The caller MUST authenticate this immutable admitted payload against its trusted admission
   * record. Self-consistent checksums and a descriptive qualification cannot establish authority.
   * This adapter checks binding and release prerequisites; it does not admit a model or policy.
   */
  readonly admittedQualification: unknown;
}

export type FirstPartyRosMarginalReleaseReason =
  | FirstPartyRosReleaseGateReason
  | "invalid-legacy-release-evidence"
  | "invalid-marginal-qualification"
  | "marginal-qualification-failed"
  | "marginal-cell-mismatch"
  | "marginal-strategy-mismatch"
  | "marginal-season-mismatch"
  | "marginal-evidence-identity-mismatch"
  | "marginal-mean-policy-mismatch"
  | "marginal-mean-choice-mismatch";

export interface FirstPartyRosMarginalReleaseDecision {
  readonly version: typeof FIRST_PARTY_ROS_MARGINAL_RELEASE_VERSION;
  readonly state: "release" | "withhold";
  readonly strategy: FirstPartyRosStrategy | null;
  readonly reasons: readonly FirstPartyRosMarginalReleaseReason[];
  readonly evidenceChecksum: string;
  readonly legacyEvidenceChecksum: string | null;
  readonly qualificationChecksum: string | null;
  readonly calibrationArtifactChecksum: string | null;
  readonly intervalCalibration: typeof MARGINAL_INTERVAL_CALIBRATION_VERSION | "not-calibrated";
}

// These are the ONLY legacy gates replaced by the independently qualified marginal interval.
const LEGACY_INTERVAL_REASONS = new Set<FirstPartyRosReleaseGateReason>([
  "interval-calibration-unavailable",
  "insufficient-walk-forward-calibration-evidence",
  "interval-coverage-gate-failed",
]);

/** Traverse only the already bounded, validated receipt shape, independent of JSONB key order. */
function matchesValidated(actual: unknown, expected: unknown): boolean {
  if (expected === null || typeof expected !== "object") return actual === expected;
  if (actual === null || typeof actual !== "object") return false;
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      Object.keys(actual).length === expected.length &&
      expected.every((entry, index) =>
        Object.hasOwn(actual, index) ? matchesValidated(actual[index], entry) : false,
      )
    );
  }
  if (Array.isArray(actual)) return false;
  const candidate = actual as Record<string, unknown>;
  const keys = Object.keys(expected);
  return (
    Object.keys(candidate).length === keys.length &&
    keys.every(
      (key) =>
        Object.hasOwn(candidate, key) &&
        matchesValidated(candidate[key], (expected as Record<string, unknown>)[key]),
    )
  );
}

/**
 * Retains the v7 mean policy and every independent legacy release gate at its fixed defaults.
 * Passing requires an externally authenticated qualification; this pure function is not an
 * admission authority. Malformed payloads withhold rather than yielding raw calibrated output.
 */
export function evaluateFirstPartyRosMarginalReleaseGate(
  input: FirstPartyRosMarginalReleaseInput,
): FirstPartyRosMarginalReleaseDecision {
  const reasons = new Set<FirstPartyRosMarginalReleaseReason>();
  let legacyEvidenceChecksum: string | null = null;
  let qualificationChecksum: string | null = null;
  let artifactChecksum: string | null = null;
  let strategy: FirstPartyRosStrategy | null = null;
  try {
    // Do not pass options: callers cannot lower any of the existing release thresholds here.
    const legacy = evaluateFirstPartyRosReleaseGate(input.meanPolicy, input.live);
    legacyEvidenceChecksum = legacy.evidenceChecksum;
    for (const reason of legacy.reasons) {
      if (!LEGACY_INTERVAL_REASONS.has(reason)) reasons.add(reason);
    }
  } catch {
    reasons.add("invalid-legacy-release-evidence");
  }

  try {
    const qualification = input.admittedQualification;
    if (!rosMarginalIntervalQualificationIsStructurallyValid(qualification)) {
      reasons.add("invalid-marginal-qualification");
    } else {
      qualificationChecksum = qualification.qualificationChecksum;
      artifactChecksum = qualification.liveArtifact.artifactChecksum;
      // The structural verifier recomputes the screen, both comparators and this state.
      if (qualification.state !== "qualified") {
        reasons.add("marginal-qualification-failed");
      }
      const { meanPolicy, live, expectedForecastSeason } = input;
      const matchingChoices = meanPolicy.choices.filter(
        (choice) => choice.position === live.position && choice.bucket === live.bucket,
      );
      const choice = matchingChoices.length === 1 ? matchingChoices[0] : undefined;
      const artifact = qualification.liveArtifact;
      if (
        qualification.cell.position !== live.position ||
        qualification.cell.bucket !== live.bucket ||
        artifact.context.position !== live.position ||
        artifact.context.bucket !== live.bucket
      ) {
        reasons.add("marginal-cell-mismatch");
      }
      if (
        choice === undefined ||
        choice.strategy !== qualification.strategy ||
        artifact.context.strategy !== choice.strategy
      ) {
        reasons.add("marginal-strategy-mismatch");
      } else {
        strategy = choice.strategy;
      }
      if (
        !Number.isSafeInteger(expectedForecastSeason) ||
        expectedForecastSeason < 2000 ||
        expectedForecastSeason > 2200 ||
        qualification.forecastSeason !== expectedForecastSeason ||
        artifact.fit.forecastSeason !== expectedForecastSeason ||
        artifact.fit.priorSeasons.some((season) => season >= expectedForecastSeason) ||
        meanPolicy.evidenceThroughSeason !== qualification.sourceScope.sourceSeasons.at(-1) ||
        meanPolicy.evidenceThroughSeason === null ||
        meanPolicy.evidenceThroughSeason >= expectedForecastSeason
      ) {
        reasons.add("marginal-season-mismatch");
      }
      if (
        !evidenceIdentitiesMatchForPosition(
          artifact.context.evidenceIdentity,
          live,
          live.position,
        ) ||
        !evidenceIdentitiesMatchForPosition(
          artifact.context.evidenceIdentity,
          meanPolicy.evidenceIdentity,
          live.position,
        )
      ) {
        reasons.add("marginal-evidence-identity-mismatch");
      }
      if (
        meanPolicy.policyVersion !== qualification.meanSelectorPolicyVersion ||
        meanPolicy.modelVersion !== qualification.sources.candidate.source.modelVersion ||
        Object.entries(qualification.meanSelectorOptions).some(
          ([key, value]) => meanPolicy[key as keyof FirstPartyRosChampionPolicy] !== value,
        ) ||
        meanPolicy.globalBatches !== qualification.meanChoice.globalBatches ||
        meanPolicy.globalSeasons !== qualification.meanChoice.globalSeasons ||
        meanPolicy.globalSamples !== qualification.meanChoice.globalSamples
      ) {
        reasons.add("marginal-mean-policy-mismatch");
      }
      if (!matchesValidated(choice, qualification.meanChoice)) {
        reasons.add("marginal-mean-choice-mismatch");
      }
    }
  } catch {
    reasons.add("invalid-marginal-qualification");
  }

  const orderedReasons = [...reasons].sort();
  const release = orderedReasons.length === 0 && strategy !== null;
  return {
    version: FIRST_PARTY_ROS_MARGINAL_RELEASE_VERSION,
    state: release ? "release" : "withhold",
    strategy: release ? strategy : null,
    reasons: orderedReasons,
    legacyEvidenceChecksum,
    qualificationChecksum,
    calibrationArtifactChecksum: release ? artifactChecksum : null,
    intervalCalibration: release ? MARGINAL_INTERVAL_CALIBRATION_VERSION : "not-calibrated",
    evidenceChecksum: sha256Hex(
      JSON.stringify({
        version: FIRST_PARTY_ROS_MARGINAL_RELEASE_VERSION,
        legacyEvidenceChecksum,
        qualificationChecksum,
        artifactChecksum,
        expectedForecastSeason: Number.isSafeInteger(input?.expectedForecastSeason)
          ? input.expectedForecastSeason
          : null,
        strategy,
        reasons: orderedReasons,
      }),
    ),
  };
}

export interface FirstPartyRosMarginalLiveForecast extends Omit<
  MarginalIntervalForecast,
  "seriesKey"
> {
  readonly playerId: string;
  readonly position: FirstPartyRosPosition;
  readonly strategy: FirstPartyRosStrategy;
  readonly inputChecksum: string;
  readonly evidenceIdentity: FirstPartyRosEvidenceIdentity;
  readonly meanPoints: number;
}

/** Called only on the compact artifact/decision copies, whose shapes and sizes were verified. */
function freezeValidated<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeValidated(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Validates once per admitted live cell, then applies only that immutable bound fit to each player.
 * No mutable receipt/policy or object-identity cache is retained. Prepare again when live evidence,
 * the admission, or the forecast season changes. Admission authority remains a caller contract.
 */
export function prepareFirstPartyRosMarginalRelease(input: FirstPartyRosMarginalReleaseInput) {
  const decision = evaluateFirstPartyRosMarginalReleaseGate(input);
  if (decision.state !== "release") {
    throw new Error(`Marginal ROS release withheld: ${decision.reasons.join(", ")}`);
  }
  // A successful gate synchronously validated this bounded payload and recomputed qualification.
  const qualification = input.admittedQualification as RosMarginalIntervalQualification;
  const artifact = freezeValidated(structuredClone(qualification.liveArtifact));
  const qualificationChecksum = qualification.qualificationChecksum;
  const expectedForecastSeason = input.expectedForecastSeason;
  const position = input.live.position;
  const liveIdentity: FirstPartyRosEvidenceIdentity = Object.freeze({
    contextualModelVersion: input.live.contextualModelVersion,
    recencyModelVersion: input.live.recencyModelVersion,
    intervalMethodVersion: input.live.intervalMethodVersion,
    scoringProfileKey: input.live.scoringProfileKey,
  });
  freezeValidated(decision);
  const seriesKey = marginalIntervalArtifactSeriesKey(artifact.context);

  function apply<T extends FirstPartyRosMarginalLiveForecast>(forecast: T) {
    if (
      Object.hasOwn(forecast, "marginalIntervalCalibration") ||
      typeof forecast.playerId !== "string" ||
      !forecast.playerId.trim() ||
      forecast.playerId.length > 1024 ||
      !/^[a-f0-9]{64}$/u.test(forecast.inputChecksum) ||
      !Number.isFinite(forecast.meanPoints) ||
      forecast.position !== position ||
      forecast.strategy !== decision.strategy ||
      forecast.forecastSeason !== expectedForecastSeason ||
      !evidenceIdentitiesMatchForPosition(forecast.evidenceIdentity, liveIdentity, position)
    ) {
      throw new Error("Marginal ROS release forecast binding is invalid");
    }
    const correction = applyMarginalIntervalArtifact(
      { ...forecast, seriesKey },
      artifact.context,
      artifact,
    );
    return {
      ...forecast,
      p15Points: correction.p15Points,
      p50Points: correction.p50Points,
      p85Points: correction.p85Points,
      marginalIntervalCalibration: {
        version: FIRST_PARTY_ROS_MARGINAL_RELEASE_VERSION,
        method: correction.method,
        rearrangement: correction.rearrangement,
        qualificationChecksum,
        calibrationArtifactChecksum: correction.calibrationArtifactChecksum,
        releaseEvidenceChecksum: decision.evidenceChecksum,
      },
    };
  }
  return Object.freeze({ decision, apply });
}

/**
 * One-shot convenience adapter; use prepareFirstPartyRosMarginalRelease for a cell's whole batch.
 * The cell aggregate and player input checksums differ. Callers must bind each to the immutable
 * source inputs and schedule; neither syntactically valid hashes nor this adapter prove that link.
 */
export function applyFirstPartyRosMarginalRelease<T extends FirstPartyRosMarginalLiveForecast>(
  input: FirstPartyRosMarginalReleaseInput & { readonly forecast: T },
) {
  return prepareFirstPartyRosMarginalRelease(input).apply(input.forecast);
}
