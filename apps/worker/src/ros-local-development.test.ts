import { NFL_TEAMS } from "@laces-out/domain";
import { beforeAll, describe, expect, it } from "vitest";
import {
  buildLocalRosDefenseRankSidecar,
  buildRosLocalDevelopmentReport,
  type LocalRosRankReportPair,
} from "./ros-local-development.js";
import {
  fullReport,
  defenseTrainingReport,
  trainingRequest,
} from "./ros-marginal-admission.test-fixtures.js";
import { forecasts, hash, SCORING, TEAMS } from "./ros-marginal-development.test-fixtures.js";
import {
  firstPartyRosAdmissionConstants,
  validateFirstPartyRosAdmission,
} from "./first-party-ros-admission.js";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
const ORDER = [...TEAMS, ...NFL_TEAMS.filter((team) => !TEAMS.includes(team))];
const PROTOCOL = "Synthetic full-portfolio protocol; unchanged gates and no release authority.";
let candidate: ReturnType<typeof fullReport>,
  previous: ReturnType<typeof fullReport>,
  training: ReturnType<typeof defenseTrainingReport>;
let profiles: LocalRosRankReportPair[];
let sidecar: ReturnType<typeof buildLocalRosDefenseRankSidecar>;
let result: ReturnType<typeof buildRosLocalDevelopmentReport>;
function makeSidecar(pairs = profiles) {
  return buildLocalRosDefenseRankSidecar({
    profiles: pairs,
    sourceRevision: "a".repeat(40),
    extractorSourceChecksum: hash("synthetic frozen selector"),
  });
}
function request() {
  const candidateReportJson = JSON.stringify(candidate),
    previousReportJson = JSON.stringify(previous);
  const rankSidecarJson = JSON.stringify(sidecar);
  const specificationText = JSON.stringify({
    version: "ros-local-residual-candidate-spec-v2",
    method: "prior-local-reference-rank-exposure-strength-residual-quantiles-v2",
    canAuthorizeRelease: false,
    canAuthorizeHistoricalExecution: false,
    population: {
      scoringProfiles: sidecar.profiles.map((profile) => profile.scoringProfileDigest),
    },
  });
  return {
    candidateReportJson,
    candidateReportChecksum: hash(candidateReportJson),
    previousReportJson,
    previousReportChecksum: hash(previousReportJson),
    ...trainingRequest(training),
    protocolText: PROTOCOL,
    protocolChecksum: hash(PROTOCOL),
    sourceManifestChecksum: hash(canonical(candidate.sources)),
    scoringProfileKey: SCORING.scoringProfileKey,
    rankSidecarJson,
    rankSidecarChecksum: hash(rankSidecarJson),
    specificationText,
    specificationChecksum: hash(specificationText),
  };
}
beforeAll(() => {
  candidate = fullReport(false);
  previous = fullReport(true);
  training = defenseTrainingReport(forecasts(false, ORDER));
  profiles = Array.from({ length: 9 }, (_, index) => {
    const profileKey = index === 0 ? SCORING.scoringProfileKey : `synthetic-profile-${index}`;
    const profileDigest = index === 0 ? SCORING.digest : hash(profileKey);
    // The additional profiles test rank metadata only; no model is fitted for these copies.
    const rewrite = (report: typeof candidate | typeof training) =>
      JSON.stringify({
        ...report,
        scoringProfile: { ...report.scoringProfile, digest: profileDigest },
        identityAudit: { ...report.identityAudit, scoringProfileKey: profileKey },
        diagnostics: {
          ...report.diagnostics,
          candidateForecasts: report.diagnostics.candidateForecasts.map((row) => ({
            ...row,
            scoringProfileKey: profileKey,
          })),
        },
      });
    const candidateReportJson = rewrite(candidate),
      trainingReportJson = rewrite(training);
    return {
      scoringProfileKey: profileKey,
      candidateReportJson,
      candidateReportChecksum: hash(candidateReportJson),
      trainingReportJson,
      trainingReportChecksum: hash(trainingReportJson),
    };
  });
  sidecar = makeSidecar();
  result = buildRosLocalDevelopmentReport(request());
}, 60_000);

describe("pinned full-portfolio local development adapter", () => {
  it("authenticates all nine profile orders and every original/full32 defense input checksum without fitting", () => {
    expect(sidecar.ranks.rows).toHaveLength(2176);
    expect(sidecar.profiles).toHaveLength(9);
    expect(new Set(sidecar.ranks.rows.map((row) => `${row.season}:${row.asOfWeek}`)).size).toBe(68);
    expect(sidecar.ranks.rows.slice(0, 32).map((row) => row.canonicalTeam)).toEqual(ORDER);
    for (const profile of sidecar.profiles) {
      expect(profile.bindings).toHaveLength(2176);
      expect(
        profile.bindings.filter((binding) => binding.auditInputChecksum !== null),
      ).toHaveLength(544);
      expect(
        profile.bindings.every((binding) => /^[a-f0-9]{64}$/u.test(binding.trainingInputChecksum)),
      ).toBe(true);
    }
    expect(sidecar.canAuthorizeRelease).toBe(false);
  });

  it("grades all original rows with full training, unchanged comparisons and no release shape", () => {
    expect(result).toMatchObject({
      canAuthorizeRelease: false,
      noDatabaseWrites: true,
      completePortfolio: true,
      forecastSeason: 2026,
      evaluationSeason: 2025,
    });
    expect(result.localDevelopment.evaluation.auditCoverage).toMatchObject({
      forecasts: 3264,
      candidateRows: 6528,
      selectedRows: 3264,
    });
    expect(result.localDevelopment.evaluation.cohort).toMatchObject({
      evaluationForecasts: 3264,
      trainingForecasts: 4896,
      additionalTrainingForecasts: 1632,
    });
    expect(result.localDevelopment.evaluation.liveFits.scopes).toHaveLength(12);
    expect(result.localDevelopment.cells).toHaveLength(18);
    for (const cell of result.localDevelopment.cells) {
      expect(cell.strategies).toHaveLength(2);
      for (const strategy of cell.strategies) {
        expect(strategy.evidence.requiredEvaluationSeasons).toEqual([2023, 2024, 2025]);
        expect(strategy.evidence.expectedRows).toBe(
          strategy.evidence.correctedRows + strategy.evidence.unavailable.length,
        );
        expect(strategy.liveFit.fit.priorSeasons).toEqual([2022, 2023, 2024, 2025]);
        expect(strategy.evidence.version).toBe("local-prior-fit-marginal-evidence-v2");
      }
      if (
        cell.strategies.find((strategy) => strategy.selectedForFinalLive)!.evidence.unavailable
          .length > 0
      )
        expect(cell.intervalPassed).toBe(false);
    }
    const portfolio = result.localDevelopment.portfolio;
    if (portfolio.state === "available")
      expect(Object.keys(portfolio.comparison.benchmarkSources).sort()).toEqual([
        "previous-deployed",
        "previous-raw",
        "same-physics-legacy",
        "same-physics-raw",
      ]);
    else expect(result.state).toBe("rejected-at-development-screen");
    const { evidenceChecksum, ...payload } = result;
    expect(evidenceChecksum).toBe(hash(canonical(payload)));
    expect(
      validateFirstPartyRosAdmission({
        report: result,
        evidenceThroughSeason: 2025,
        constants: firstPartyRosAdmissionConstants(SCORING.profile),
      }).state,
    ).toBe("rejected");
  });

  it("rejects changed profile rank ordering even when the new report bytes are correctly pinned", () => {
    const pair = profiles[8]!;
    const changed = JSON.parse(pair.trainingReportJson) as typeof training;
    const rows = changed.diagnostics.candidateForecasts;
    [rows[8], rows[9]] = [rows[9]!, rows[8]!];
    const trainingReportJson = JSON.stringify(changed);
    expect(() =>
      makeSidecar([
        ...profiles.slice(0, 8),
        { ...pair, trainingReportJson, trainingReportChecksum: hash(trainingReportJson) },
      ]),
    ).toThrow(/order differs across scoring profiles/);
  });

  it("rejects original-eight reorderings, duplicate teams and missing profile reports", () => {
    const pair = profiles[0]!;
    const changed = JSON.parse(pair.candidateReportJson) as typeof candidate;
    const rows = changed.diagnostics.candidateForecasts;
    const indexes = rows
      .map((row, index) =>
        row.position === "DST" && row.forecastSeason === 2022 && row.asOfWeek === 1 ? index : -1,
      )
      .filter((index) => index >= 0);
    [rows[indexes[0]!], rows[indexes[1]!]] = [rows[indexes[1]!]!, rows[indexes[0]!]!];
    const candidateReportJson = JSON.stringify(changed);
    expect(() =>
      makeSidecar([
        { ...pair, candidateReportJson, candidateReportChecksum: hash(candidateReportJson) },
        ...profiles.slice(1),
      ]),
    ).toThrow(/ordered full32 subsequence/);
    expect(() => makeSidecar(profiles.slice(1))).toThrow(/nine distinct profiles/);
    const bad = JSON.parse(pair.trainingReportJson) as typeof training;
    bad.diagnostics.candidateForecasts[1] = bad.diagnostics.candidateForecasts[0]!;
    const trainingReportJson = JSON.stringify(bad);
    expect(() =>
      makeSidecar([
        { ...pair, trainingReportJson, trainingReportChecksum: hash(trainingReportJson) },
        ...profiles.slice(1),
      ]),
    ).toThrow(/unique teams/);
  });

  it("rejects tampered rank input bindings before a local fit is constructed", () => {
    const changed = {
      ...sidecar,
      profiles: sidecar.profiles.map((profile, index) =>
        index !== 0
          ? profile
          : {
              ...profile,
              bindings: profile.bindings.map((binding, rankIndex) =>
                rankIndex !== 0 ? binding : { ...binding, trainingInputChecksum: hash("changed") },
              ),
            },
      ),
    };
    const rankSidecarJson = JSON.stringify(changed);
    expect(() =>
      buildRosLocalDevelopmentReport({
        ...request(),
        rankSidecarJson,
        rankSidecarChecksum: hash(rankSidecarJson),
      }),
    ).toThrow(/forecast input\/model join mismatch/);
  });
});
