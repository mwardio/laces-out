import { describe, expect, it } from "vitest";

import { projectionScoringProfileKey, rosScoringProfile } from "@fantasy/projections";

import {
  deriveFirstPartyRosSourceChecksums,
  firstPartyRosAdmissionConstants,
  validateFirstPartyRosAdmission,
} from "./first-party-ros-admission.js";
import { HISTORICAL_ROS_SCORING_PROFILE } from "./first-party-ros-backtest.js";
import {
  firstPartyRosChampionArtifactChecksum,
  firstPartyRosChampionArtifactIsValid,
} from "./first-party-ros-publication.js";

const constants = firstPartyRosAdmissionConstants();

function sourceAudit(season: number): Record<string, unknown> {
  return {
    season,
    weeklyStatsChecksum: "a".repeat(64),
    teamWeeklyStatsChecksum: "b".repeat(64),
    weeklyRosterChecksum: "c".repeat(64),
    injuryChecksum: "d".repeat(64),
    snapChecksum: "e".repeat(64),
    scheduleChecksum: "f".repeat(64),
  };
}

function validReport(overrides: {
  reportOverrides?: Record<string, unknown>;
  championOverrides?: Record<string, unknown>;
  evidenceIdentityOverrides?: Record<string, unknown>;
  sources?: unknown;
}): Record<string, unknown> {
  return {
    report: {
      state: "evidence-ready",
      blockers: [],
      availabilityCalibrationVersion: constants.availabilityCalibrationVersion,
      roleCalibrationVersion: constants.roleCalibrationVersion,
      kickerCalibrationVersion: constants.kickerCalibrationVersion,
      ...overrides.reportOverrides,
    },
    champion: {
      policyVersion: constants.policyVersion,
      modelVersion: constants.modelVersion,
      evidenceThroughSeason: 2025,
      globalBatches: 40,
      evidenceIdentity: {
        contextualModelVersion: "contextual-v1",
        recencyModelVersion: "recency-v1",
        scoringProfileKey: constants.scoringProfileKey,
        intervalMethodVersion: constants.intervalMethodVersion,
        ...overrides.evidenceIdentityOverrides,
      },
      choices: [],
      ...overrides.championOverrides,
    },
    sources:
      overrides.sources === undefined
        ? [sourceAudit(2022), sourceAudit(2023), sourceAudit(2024), sourceAudit(2025)]
        : overrides.sources,
  };
}

describe("deriveFirstPartyRosSourceChecksums", () => {
  it("expands the per-season source audit and drops non-SHA-256 checksums", () => {
    const checksums = deriveFirstPartyRosSourceChecksums({
      sources: [
        { season: 2024, weeklyStatsChecksum: "a".repeat(64), scheduleChecksum: "not-a-checksum" },
        { season: 2024, snapChecksum: "b".repeat(64) },
        { weeklyStatsChecksum: "c".repeat(64) },
      ],
    });
    expect(checksums).toEqual([
      { key: "nflverse.snap-counts.2024", checksum: "b".repeat(64) },
      { key: "nflverse.stats-player-week.2024", checksum: "a".repeat(64) },
    ]);
  });

  it("returns nothing when the report carries no source audit (e.g. produced without --full)", () => {
    expect(deriveFirstPartyRosSourceChecksums({ report: {} })).toEqual([]);
  });
});

describe("validateFirstPartyRosAdmission", () => {
  it("admits a valid evidence-ready report and produces a self-consistent artifact", () => {
    const result = validateFirstPartyRosAdmission({
      report: validReport({}),
      evidenceThroughSeason: 2025,
      constants,
    });
    expect(result.state).toBe("admissible");
    if (result.state !== "admissible") return;
    expect(result.payload.season).toBe(2026);
    expect(result.payload.evidenceThroughSeason).toBe(2025);
    expect(result.payload.scoringProfileKey).toBe(constants.scoringProfileKey);
    expect(result.payload.sourceChecksums.length).toBeGreaterThan(0);
    expect(result.artifactChecksum).toMatch(/^[a-f0-9]{64}$/u);
    expect(firstPartyRosChampionArtifactChecksum(result.payload)).toBe(result.artifactChecksum);
    expect(
      firstPartyRosChampionArtifactIsValid({
        ...result.payload,
        artifactChecksum: result.artifactChecksum,
      }),
    ).toBe(true);
  });

  it("refuses an insufficient report whose state is unexplained by any blocker", () => {
    const result = validateFirstPartyRosAdmission({
      report: validReport({ reportOverrides: { state: "insufficient" } }),
      evidenceThroughSeason: 2025,
      constants,
    });
    expect(result.state).toBe("rejected");
    expect(result.blockers).toContain("report_state_inconsistent");
  });

  it("refuses an unsupported report state", () => {
    const result = validateFirstPartyRosAdmission({
      report: validReport({ reportOverrides: { state: "blocked-before-modeling" } }),
      evidenceThroughSeason: 2025,
      constants,
    });
    expect(result.state).toBe("rejected");
    expect(result.blockers).toContain("report_state_unsupported");
  });

  it("refuses any global/portfolio blocker", () => {
    const result = validateFirstPartyRosAdmission({
      report: validReport({
        reportOverrides: {
          state: "insufficient",
          blockers: ["portfolio_forecasts_below_minimum"],
        },
      }),
      evidenceThroughSeason: 2025,
      constants,
    });
    expect(result.state).toBe("rejected");
    expect(result.blockers).toContain("report_global_blockers_present");
  });

  it("admits through per-cell blockers, surfacing them for the release gate to withhold", () => {
    const result = validateFirstPartyRosAdmission({
      report: validReport({
        reportOverrides: {
          state: "insufficient",
          blockers: ["calibration_K_one-to-four_coverage_shortfall_above_maximum"],
        },
      }),
      evidenceThroughSeason: 2025,
      constants,
    });
    expect(result.state).toBe("admissible");
    if (result.state === "admissible") {
      expect(result.cellBlockers).toEqual([
        "calibration_K_one-to-four_coverage_shortfall_above_maximum",
      ]);
    }
  });

  it("classifies kicker count-family audit blockers as per-cell, not global", () => {
    const familyBlockers = [
      "calibration_K_one-to-four_count_family_dispersion_out_of_bounds",
      "calibration_K_five-to-eight_count_family_dispersion_out_of_bounds",
      "calibration_K_nine-plus_count_family_dispersion_out_of_bounds",
    ];
    const result = validateFirstPartyRosAdmission({
      report: validReport({
        reportOverrides: { state: "insufficient", blockers: familyBlockers },
      }),
      evidenceThroughSeason: 2025,
      constants,
    });
    expect(result.state).toBe("admissible");
    if (result.state === "admissible") {
      expect(result.cellBlockers).toEqual(familyBlockers);
    }
  });

  it("refuses model, scoring, calibration, and evidence-through identity drift", () => {
    const model = validateFirstPartyRosAdmission({
      report: validReport({ championOverrides: { modelVersion: "laces-ros-distribution-v3" } }),
      evidenceThroughSeason: 2025,
      constants,
    });
    expect(model.blockers).toContain("model_version_mismatch");

    const scoring = validateFirstPartyRosAdmission({
      report: validReport({ evidenceIdentityOverrides: { scoringProfileKey: "other-profile:v9" } }),
      evidenceThroughSeason: 2025,
      constants,
    });
    expect(scoring.blockers).toContain("scoring_profile_mismatch");

    const calibration = validateFirstPartyRosAdmission({
      report: validReport({ reportOverrides: { roleCalibrationVersion: "stale-role-v0" } }),
      evidenceThroughSeason: 2025,
      constants,
    });
    expect(calibration.blockers).toContain("role_calibration_mismatch");

    const kickerCalibration = validateFirstPartyRosAdmission({
      report: validReport({ reportOverrides: { kickerCalibrationVersion: "stale-kicker-v0" } }),
      evidenceThroughSeason: 2025,
      constants,
    });
    expect(kickerCalibration.blockers).toContain("kicker_calibration_mismatch");

    const evidenceThrough = validateFirstPartyRosAdmission({
      report: validReport({}),
      evidenceThroughSeason: 2024,
      constants,
    });
    expect(evidenceThrough.blockers).toContain("evidence_through_season_report_mismatch");
  });

  it("refuses when no source lineage can be derived", () => {
    const result = validateFirstPartyRosAdmission({
      report: validReport({ sources: undefined, reportOverrides: {} }),
      evidenceThroughSeason: 2025,
      constants,
    });
    // Sanity: with sources present it admits; removing them blocks.
    expect(result.state).toBe("admissible");
    const withoutSources = validateFirstPartyRosAdmission({
      report: { ...validReport({}), sources: [] },
      evidenceThroughSeason: 2025,
      constants,
    });
    expect(withoutSources.state).toBe("rejected");
    expect(withoutSources.blockers).toContain("source_lineage_unavailable");
  });
});

describe("firstPartyRosAdmissionConstants scoring-profile parameter", () => {
  it("defaults to the historical full-PPR identity", () => {
    expect(firstPartyRosAdmissionConstants().scoringProfileKey).toBe(
      projectionScoringProfileKey(HISTORICAL_ROS_SCORING_PROFILE),
    );
  });

  it("reproduces the historical profile from the shared catalog", () => {
    expect(rosScoringProfile("full-ppr").scoringProfileKey).toBe(
      projectionScoringProfileKey(HISTORICAL_ROS_SCORING_PROFILE),
    );
  });

  it("mints a distinct identity for each requested profile without moving any other version", () => {
    const half = firstPartyRosAdmissionConstants(rosScoringProfile("half-ppr").profile);
    const standard = firstPartyRosAdmissionConstants(rosScoringProfile("standard").profile);

    expect(half.scoringProfileKey).not.toBe(standard.scoringProfileKey);
    expect(half.scoringProfileKey).not.toBe(constants.scoringProfileKey);
    expect(half.modelVersion).toBe(constants.modelVersion);
    expect(half.policyVersion).toBe(constants.policyVersion);
    expect(half.calibrationVersion).toBe(constants.calibrationVersion);
    expect(half.intervalMethodVersion).toBe(constants.intervalMethodVersion);
    expect(half.availabilityCalibrationVersion).toBe(constants.availabilityCalibrationVersion);
    expect(half.roleCalibrationVersion).toBe(constants.roleCalibrationVersion);
    expect(half.kickerCalibrationVersion).toBe(constants.kickerCalibrationVersion);
  });

  it("rejects a full-PPR report presented for half-PPR admission", () => {
    const result = validateFirstPartyRosAdmission({
      report: validReport({}),
      evidenceThroughSeason: 2025,
      constants: firstPartyRosAdmissionConstants(rosScoringProfile("half-ppr").profile),
    });

    expect(result.state).toBe("rejected");
    expect(result.blockers).toContain("scoring_profile_mismatch");
  });

  it("admits a half-PPR report only under half-PPR constants", () => {
    const half = firstPartyRosAdmissionConstants(rosScoringProfile("half-ppr").profile);
    const report = validReport({
      evidenceIdentityOverrides: { scoringProfileKey: half.scoringProfileKey },
    });

    expect(
      validateFirstPartyRosAdmission({ report, evidenceThroughSeason: 2025, constants: half })
        .state,
    ).toBe("admissible");
    expect(
      validateFirstPartyRosAdmission({ report, evidenceThroughSeason: 2025, constants }).blockers,
    ).toContain("scoring_profile_mismatch");
  });

  it("gives each admitted profile its own artifact checksum", () => {
    const half = firstPartyRosAdmissionConstants(rosScoringProfile("half-ppr").profile);
    const fullResult = validateFirstPartyRosAdmission({
      report: validReport({}),
      evidenceThroughSeason: 2025,
      constants,
    });
    const halfResult = validateFirstPartyRosAdmission({
      report: validReport({
        evidenceIdentityOverrides: { scoringProfileKey: half.scoringProfileKey },
      }),
      evidenceThroughSeason: 2025,
      constants: half,
    });

    expect(fullResult.state).toBe("admissible");
    expect(halfResult.state).toBe("admissible");
    if (fullResult.state !== "admissible" || halfResult.state !== "admissible") return;
    expect(fullResult.artifactChecksum).not.toBe(halfResult.artifactChecksum);
    expect(halfResult.payload.scoringProfileKey).toBe(half.scoringProfileKey);
  });
});
