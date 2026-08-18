import { describe, expect, it } from "vitest";

import {
  evaluateFirstPartyRosChampionPolicy,
  projectionScoringProfileKey,
  rosScoringProfile,
  type FirstPartyRosHeldOutForecast,
} from "@laces-out/projections";

import {
  deriveFirstPartyRosSourceChecksums,
  firstPartyRosAdmissionConstants,
  validateFirstPartyRosAdmission,
} from "./first-party-ros-admission.js";
import { HISTORICAL_ROS_SCORING_PROFILE } from "./first-party-ros-backtest.js";
import {
  firstPartyRosChampionArtifactChecksum,
  firstPartyRosChampionArtifactIsValid,
  firstPartyRosChampionPolicyChecksum,
} from "./first-party-ros-publication.js";
import {
  FIRST_PARTY_ROS_RELEASE_MAXIMUM_FORECASTS,
  FIRST_PARTY_ROS_RELEASE_MINIMUM_BATCHES,
  FIRST_PARTY_ROS_RELEASE_MINIMUM_FORECASTS,
  FIRST_PARTY_ROS_RELEASE_PLAYERS_PER_POSITION,
} from "./first-party-ros-validation-contract.js";

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

function heldOutForecast(
  season: number,
  asOfWeek: number,
  playerId: string,
  scoringProfileKey: string,
): FirstPartyRosHeldOutForecast {
  return {
    playerId,
    position: "WR",
    contextualModelVersion: "contextual-v1",
    recencyModelVersion: "recency-v1",
    scoringProfileKey,
    intervalMethodVersion: constants.intervalMethodVersion,
    forecastSeason: season,
    asOfWeek,
    windowStartWeek: asOfWeek + 1,
    windowEndWeek: 18,
    trainedThroughSeason: season - 1,
    inputChecksum: "1".repeat(64),
    evidence: {
      coverage: { contextual: 1, recency: 1 },
      availability: {
        scheduledGames: 18 - asOfWeek,
        actualGames: 17 - asOfWeek,
        contextualExpectedGames: 17 - asOfWeek,
        recencyExpectedGames: 16.5 - asOfWeek,
      },
      convergence: {
        contextual: { state: "converged", diagnosticChecksum: "2".repeat(64) },
        recency: { state: "converged", diagnosticChecksum: "3".repeat(64) },
      },
    },
    contextual: { meanPoints: 101, p15Points: 86, p50Points: 101, p85Points: 116 },
    recency: { meanPoints: 108, p15Points: 83, p50Points: 108, p85Points: 133 },
    actualPoints: 100,
  };
}

function publicationPolicy(scoringProfileKey: string) {
  return evaluateFirstPartyRosChampionPolicy(
    [2023, 2024, 2025].map((season) => ({
      season,
      complete: true,
      forecasts: [
        heldOutForecast(season, 10, `${season}-one`, scoringProfileKey),
        heldOutForecast(season, 11, `${season}-two`, scoringProfileKey),
      ],
    })),
    {
      minimumHeldOutSeasons: 2,
      minimumBatches: 4,
      minimumSamples: 4,
      minimumCellSeasons: 2,
      minimumCellSamples: 4,
      minimumCellCutoffs: 2,
      minimumCellBatches: 4,
    },
  ).livePolicy;
}

function validReport(overrides: {
  reportOverrides?: Record<string, unknown>;
  championOverrides?: Record<string, unknown>;
  evidenceIdentityOverrides?: Record<string, unknown>;
  sources?: unknown;
}): Record<string, unknown> {
  const scoringProfileKey =
    typeof overrides.evidenceIdentityOverrides?.scoringProfileKey === "string"
      ? overrides.evidenceIdentityOverrides.scoringProfileKey
      : constants.scoringProfileKey;
  const policy = publicationPolicy(scoringProfileKey);
  return {
    report: {
      state: "evidence-ready",
      blockers: [],
      seasons: [2022, 2023, 2024, 2025],
      playersPerPosition: FIRST_PARTY_ROS_RELEASE_PLAYERS_PER_POSITION,
      maximumForecasts: FIRST_PARTY_ROS_RELEASE_MAXIMUM_FORECASTS,
      forecasts: FIRST_PARTY_ROS_RELEASE_MINIMUM_FORECASTS,
      batches: FIRST_PARTY_ROS_RELEASE_MINIMUM_BATCHES,
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
      publicationPolicyChecksum: firstPartyRosChampionPolicyChecksum(policy),
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
    publicationPolicy: policy,
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

  it("admits the smaller valid ESPN-shaped N=8 release population", () => {
    const result = validateFirstPartyRosAdmission({
      report: validReport({
        reportOverrides: { forecasts: 2_965 },
      }),
      evidenceThroughSeason: 2025,
      constants,
    });
    expect(result.state).toBe("admissible");
  });

  it("rejects a position-only validation slice even when its summary counts are forged upward", () => {
    const report = validReport({});
    report.validationScope = { positions: ["TE"], completePortfolio: false };
    const result = validateFirstPartyRosAdmission({
      report,
      evidenceThroughSeason: 2025,
      constants,
    });
    expect(result.state).toBe("rejected");
    expect(result.blockers).toContain("validation_scope_not_complete_portfolio");
  });

  it("admits an explicitly complete six-position validation scope", () => {
    const report = validReport({});
    report.validationScope = {
      positions: ["QB", "RB", "WR", "TE", "K", "DST"],
      completePortfolio: true,
    };
    const result = validateFirstPartyRosAdmission({
      report,
      evidenceThroughSeason: 2025,
      constants,
    });
    expect(result.state).toBe("admissible");
  });

  it("rejects the concise champion summary when the executable publication policy is absent", () => {
    const { publicationPolicy: omitted, ...summaryOnly } = validReport({});
    void omitted;
    const result = validateFirstPartyRosAdmission({
      report: summaryOnly,
      evidenceThroughSeason: 2025,
      constants,
    });
    expect(result.state).toBe("rejected");
    expect(result.blockers).toContain("publication_policy_missing_or_invalid");
  });

  it("rejects a publication policy with a missing nested calibration contract", () => {
    const report = structuredClone(validReport({}));
    const policy = report.publicationPolicy as { choices: Record<string, unknown>[] };
    delete policy.choices[0]!.intervalCalibrationArtifacts;
    const result = validateFirstPartyRosAdmission({
      report,
      evidenceThroughSeason: 2025,
      constants,
    });
    expect(result.state).toBe("rejected");
    expect(result.blockers).toContain("publication_policy_missing_or_invalid");
  });

  it("rejects a complete publication policy that no longer matches the report summary checksum", () => {
    const report = structuredClone(validReport({}));
    const policy = report.publicationPolicy as { choices: { samples: number }[] };
    policy.choices[0]!.samples += 1;
    const result = validateFirstPartyRosAdmission({
      report,
      evidenceThroughSeason: 2025,
      constants,
    });
    expect(result.state).toBe("rejected");
    expect(result.blockers).toContain("publication_policy_checksum_mismatch");
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

  it("rejects an otherwise clean report produced by an undersized exploratory replay", () => {
    const result = validateFirstPartyRosAdmission({
      report: validReport({
        reportOverrides: {
          playersPerPosition: 5,
          maximumForecasts: 3_000,
          forecasts: 2_040,
        },
      }),
      evidenceThroughSeason: 2025,
      constants,
    });

    expect(result.state).toBe("rejected");
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        "release_validation_players_per_position_below_minimum",
        "release_validation_forecast_cap_below_minimum",
        "release_validation_forecasts_below_minimum",
      ]),
    );
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
