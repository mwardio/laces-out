import { readFileSync } from "node:fs";

import { rosScoringProfile, type FirstPartyRosChampionPolicy } from "@laces-out/projections";
import { describe, expect, it } from "vitest";

import {
  firstPartyRosAdmissionConstants,
  validateFirstPartyRosAdmission,
} from "./first-party-ros-admission.js";
import { composeFirstPartyRosValidationReport, sha256Text } from "./first-party-ros-compose.js";
import { firstPartyRosChampionPolicyChecksum } from "./first-party-ros-publication.js";

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

const baseRaw = readFileSync(
  new URL(
    "../../../reports/ros-release-laces-ros-distribution-v8-20260813-n8/full-ppr.json",
    import.meta.url,
  ),
  "utf8",
);
const baseFixture = JSON.parse(baseRaw) as JsonObject;

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
