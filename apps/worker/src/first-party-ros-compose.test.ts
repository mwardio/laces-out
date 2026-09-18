import { readFileSync } from "node:fs";

import {
  FIRST_PARTY_ROS_MODEL_VERSION,
  FIRST_PARTY_ROS_POLICY_VERSION,
  evaluateFirstPartyRosChampionPolicy,
  type FirstPartyRosHeldOutForecast,
  rosScoringProfile,
  type FirstPartyRosChampionPolicy,
} from "@laces-out/projections";
import { describe, expect, it } from "vitest";

import {
  firstPartyRosAdmissionConstants,
  validateFirstPartyRosAdmission,
} from "./first-party-ros-admission.js";
import { composeFirstPartyRosValidationReport, sha256Text } from "./first-party-ros-compose.js";
import { firstPartyRosChampionPolicyChecksum } from "./first-party-ros-publication.js";
import {
  HISTORICAL_ROS_KICKER_CALIBRATION_VERSION,
  HISTORICAL_ROS_AVAILABILITY_CALIBRATION_VERSION,
  HISTORICAL_ROS_ROLE_CALIBRATION_VERSION,
} from "./first-party-ros-backtest.js";

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Expected an object fixture");
  }
  return value as JsonObject;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new TypeError("Expected an array fixture");
  return value;
}

function publicationPolicy(value: unknown): FirstPartyRosChampionPolicy {
  return object(value) as unknown as FirstPartyRosChampionPolicy;
}

const pinnedBaseRaw = readFileSync(
  new URL(
    "../../../reports/ros-release-laces-ros-distribution-v8-20260813-n8/full-ppr.json",
    import.meta.url,
  ),
  "utf8",
);
const baseFixture = JSON.parse(pinnedBaseRaw) as JsonObject;
// Composition is deliberately numeric-model agnostic, but its final structural rail admits only
// the running model envelope. This synthetic fixture tests composition structure only; changing
// its version fields never makes the old numerical evidence valid for production admission.
object(baseFixture.champion).modelVersion = FIRST_PARTY_ROS_MODEL_VERSION;
object(baseFixture.publicationPolicy).modelVersion = FIRST_PARTY_ROS_MODEL_VERSION;
object(baseFixture.report).kickerCalibrationVersion = HISTORICAL_ROS_KICKER_CALIBRATION_VERSION;
object(baseFixture.report).availabilityCalibrationVersion =
  HISTORICAL_ROS_AVAILABILITY_CALIBRATION_VERSION;
object(baseFixture.report).roleCalibrationVersion = HISTORICAL_ROS_ROLE_CALIBRATION_VERSION;
// Synthetic current mean proof for this structural-only fixture; the pinned legacy numerical
// report above is not being revalidated or promoted. Real v7 admission requires a corpus replay.
const basePolicyFixture = publicationPolicy(baseFixture.publicationPolicy);
const syntheticMeanPolicy = evaluateFirstPartyRosChampionPolicy(
  [2022, 2023, 2024, 2025].map((season) => ({
    season,
    complete: true,
    forecasts: Array.from({ length: 17 }, (_, index) => index + 1).flatMap((asOfWeek) =>
      ["QB", "RB", "WR", "TE", "K", "DST"].flatMap((position) =>
        Array.from({ length: 8 }, (_, index): FirstPartyRosHeldOutForecast => {
          const remaining = 18 - asOfWeek;
          const bucket =
            remaining <= 4 ? "one-to-four" : remaining <= 8 ? "five-to-eight" : "nine-plus";
          const original = basePolicyFixture.choices.find(
            (choice) => choice.position === position && choice.bucket === bucket,
          )!;
          return {
            playerId: `${position}:${index}`,
            position: position as FirstPartyRosHeldOutForecast["position"],
            contextualModelVersion: "synthetic-contextual",
            recencyModelVersion: "synthetic-recency",
            scoringProfileKey: basePolicyFixture.evidenceIdentity!.scoringProfileKey,
            intervalMethodVersion: basePolicyFixture.evidenceIdentity!.intervalMethodVersion,
            forecastSeason: season,
            asOfWeek,
            windowStartWeek: asOfWeek + 1,
            windowEndWeek: 18,
            trainedThroughSeason: season - 1,
            inputChecksum: "b".repeat(64),
            actualPoints: 0,
            contextual: {
              meanPoints: original.strategy === "contextual" ? 0.5 : 2,
              p15Points: -5,
              p50Points: 0,
              p85Points: 5,
            },
            recency: { meanPoints: 1, p15Points: -5, p50Points: 0, p85Points: 5 },
            evidence: {
              coverage: { contextual: 1, recency: 1 },
              availability: {
                scheduledGames: remaining,
                actualGames: remaining,
                contextualExpectedGames: remaining,
                recencyExpectedGames: remaining,
              },
              convergence: {
                contextual: { state: "converged", diagnosticChecksum: "c".repeat(64) },
                recency: { state: "converged", diagnosticChecksum: "d".repeat(64) },
              },
            },
          };
        }),
      ),
    ),
  })),
).livePolicy;
for (const target of [object(baseFixture.champion), object(baseFixture.publicationPolicy)]) {
  target.policyVersion = FIRST_PARTY_ROS_POLICY_VERSION;
  target.meanSelectionEvidenceVersion = syntheticMeanPolicy.meanSelectionEvidenceVersion;
  target.legacyPointImprovementMetric = syntheticMeanPolicy.legacyPointImprovementMetric;
  target.choices = array(target.choices).map((value) => {
    const choice = object(value);
    const mean = syntheticMeanPolicy.choices.find(
      (row) => row.position === choice.position && row.bucket === choice.bucket,
    )!.meanSelectionEvidence;
    return { ...choice, meanSelectionEvidence: mean };
  });
}
object(baseFixture.champion).publicationPolicyChecksum = firstPartyRosChampionPolicyChecksum(
  publicationPolicy(baseFixture.publicationPolicy),
);
const baseRaw = JSON.stringify(baseFixture);

function positionSlice(target: string): JsonObject {
  const slice = structuredClone(baseFixture);
  slice.validationScope = { positions: [target], completePortfolio: false };
  slice.availabilityAudit = array(slice.availabilityAudit).filter(
    (entry) => object(entry).position === target,
  );
  const body = object(slice.report);
  body.cells = array(body.cells).filter((entry) => object(entry).position === target);
  body.convergenceAudit = array(body.convergenceAudit).filter(
    (entry) => object(entry).position === target,
  );
  body.blockers = array(body.blockers).filter((entry) =>
    new RegExp(`^(?:cell|champion|calibration)_${target}_`, "u").test(String(entry)),
  );
  body.unsupportedPositions = array(body.unsupportedPositions).filter((entry) => entry === target);
  body.forecasts = Number(body.forecasts) / 6;
  body.diagnosedPairs = Number(body.diagnosedPairs) / 6;
  const champion = object(slice.champion);
  champion.choices = array(champion.choices)
    .filter((entry) => object(entry).position === target)
    .map((entry) => ({ ...object(entry), globalSamples: body.forecasts }));
  const policy = object(slice.publicationPolicy);
  policy.globalSamples = body.forecasts;
  policy.choices = array(policy.choices)
    .filter((entry) => object(entry).position === target)
    .map((entry) => ({ ...object(entry), globalSamples: body.forecasts }));
  champion.publicationPolicyChecksum = firstPartyRosChampionPolicyChecksum(
    publicationPolicy(policy),
  );
  const identity = object(slice.identityAudit);
  identity.inputChecksums = Number(identity.inputChecksums) / 6;
  identity.contextualConvergenceChecksums = Number(identity.contextualConvergenceChecksums) / 6;
  identity.recencyConvergenceChecksums = Number(identity.recencyConvergenceChecksums) / 6;
  return slice;
}

function compose(slice: JsonObject, sourceEquivalences: readonly JsonObject[] = []): JsonObject {
  const sliceRaw = JSON.stringify(slice);
  return composeFirstPartyRosValidationReport({
    base: { id: "base", sha256: sha256Text(baseRaw), report: baseFixture },
    slices: [{ id: "te", sha256: sha256Text(sliceRaw), report: slice }],
    sourceEquivalences: sourceEquivalences.map((audit, index) => ({
      id: `audit-${index}`,
      sha256: sha256Text(JSON.stringify(audit)),
      audit,
    })),
    composedAt: "2026-08-16T18:00:00.000Z",
  });
}

function scheduleEquivalence(baseChecksum: string, sliceChecksum: string): JsonObject {
  const seasons = array(baseFixture.sources).map((source) => object(source).season);
  const selectedRowsChecksum = "9".repeat(64);
  return {
    version: 1,
    sourceKey: "nflverse.schedules",
    field: "scheduleChecksum",
    baseChecksum,
    sliceChecksum,
    seasons,
    seasonTypes: ["REG"],
    selectedRows: 1_871,
    selectedRowsChecksum,
    observations: [
      {
        commit: "1".repeat(40),
        committedAt: "2026-08-15T16:35:13.000Z",
        selectedRows: 1_871,
        selectedRowsChecksum,
      },
      {
        commit: "2".repeat(40),
        committedAt: "2026-08-16T16:35:14.000Z",
        selectedRows: 1_871,
        selectedRowsChecksum,
      },
    ],
  };
}

describe("composeFirstPartyRosValidationReport", () => {
  it("builds a complete, admissible report from a lineage-matched position slice", () => {
    const result = compose(positionSlice("TE"));
    expect(result.validationScope).toEqual({
      positions: ["QB", "RB", "WR", "TE", "K", "DST"],
      completePortfolio: true,
      composedFromPositionSlices: true,
    });
    const body = object(result.report);
    expect(body.forecasts).toBe(3_264);
    expect(body.diagnosedPairs).toBe(72);
    const policy = object(result.publicationPolicy);
    expect(array(policy.choices).every((choice) => object(choice).globalSamples === 3_264)).toBe(
      true,
    );
    expect(object(result.champion).publicationPolicyChecksum).toBe(
      firstPartyRosChampionPolicyChecksum(publicationPolicy(policy)),
    );

    const admission = validateFirstPartyRosAdmission({
      report: result,
      evidenceThroughSeason: 2025,
      constants: firstPartyRosAdmissionConstants(rosScoringProfile("full-ppr").profile),
    });
    expect(admission.state).toBe("admissible");
  });

  it("rejects a slice whose source lineage differs from the base", () => {
    const slice = positionSlice("TE");
    object(array(slice.sources)[0]).weeklyStatsChecksum = "0".repeat(64);
    expect(() => compose(slice)).toThrow(/sources/u);
  });

  it("accepts a schedule-only lineage change with an explicit semantic audit", () => {
    const slice = positionSlice("TE");
    const baseChecksum = String(object(array(baseFixture.sources)[0]).scheduleChecksum);
    const sliceChecksum = "8".repeat(64);
    for (const source of array(slice.sources)) {
      object(source).scheduleChecksum = sliceChecksum;
    }
    const result = compose(slice, [scheduleEquivalence(baseChecksum, sliceChecksum)]);
    const composition = object(result.composition);
    expect(array(composition.sourceEquivalences)).toEqual([
      expect.objectContaining({
        baseChecksum,
        sliceChecksum,
        selectedRows: 1_871,
        observations: 2,
      }),
    ]);
  });

  it("rejects a schedule equivalence whose observations disagree", () => {
    const slice = positionSlice("TE");
    const baseChecksum = String(object(array(baseFixture.sources)[0]).scheduleChecksum);
    const sliceChecksum = "8".repeat(64);
    for (const source of array(slice.sources)) {
      object(source).scheduleChecksum = sliceChecksum;
    }
    const audit = scheduleEquivalence(baseChecksum, sliceChecksum);
    object(array(audit.observations)[1]).selectedRowsChecksum = "7".repeat(64);
    expect(() => compose(slice, [audit])).toThrow(/selectedRowsChecksum/u);
  });

  it("rejects a slice with forged position-level forecast counts", () => {
    const slice = positionSlice("TE");
    object(slice.report).forecasts = 543;
    expect(() => compose(slice)).toThrow(/report\.forecasts/u);
  });
});
