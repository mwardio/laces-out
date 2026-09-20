import { createHash } from "node:crypto";

import { NFL_TEAMS } from "@laces-out/domain";
import {
  evaluateFirstPartyRosConvergence,
  projectionScoringProfileKey,
  type FirstPartyRosHeldOutForecast,
} from "@laces-out/projections";

import {
  historicalRosBucket,
  historicalRosChecksum,
  historicalRosConvergenceChecksum,
} from "./first-party-ros-backtest.js";
import { ROS_HISTORICAL_ACTUAL_DEFINITION_VERSION } from "./ros-historical-corpus.js";
import { ROS_DERIVED_EVALUATION_VERSION } from "./ros-derived-evaluation.js";
import { fullForecasts } from "./ros-marginal-admission.test-fixtures.js";
import { forecasts } from "./ros-marginal-development.test-fixtures.js";
import {
  ROS_DERIVED_PRODUCTION_DEPENDENCIES,
  ROS_DERIVED_PRODUCTION_PACKAGE_VERSION,
  rosDerivedProductionRoleIdentity,
  type RosDerivedProductionPackage,
} from "./ros-derived-production-package.js";

export const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const positions = ["QB", "RB", "WR", "TE", "K", "DST"];
const playerActuals = "complete-player-ledger-actuals-v1";
type Report = Record<string, unknown> & {
  diagnostics: { candidateForecasts: FirstPartyRosHeldOutForecast[] };
  identityAudit: { scoringProfileKey: string };
  sources: Record<string, unknown>[];
  report: Record<string, unknown>;
};
export const key = (row: FirstPartyRosHeldOutForecast) =>
  `${row.forecastSeason}:${row.asOfWeek}:${row.position}:${row.playerId === "DST:LA" ? "DST:LAR" : row.playerId}`;
const stratum = (row: FirstPartyRosHeldOutForecast) =>
  `${row.forecastSeason}:${row.position}:${historicalRosBucket(row.windowStartWeek, row.windowEndWeek)}`;
export const pin = (value: unknown) => {
  const text = JSON.stringify(value);
  return { text, checksum: hash(text) };
};
const sources = () =>
  Array.from({ length: 7 }, (_, index) => ({
    season: 2019 + index,
    ...Object.fromEntries(
      [
        "weeklyStatsChecksum",
        "playerWeeklyRawChecksum",
        "playerTouchdownPlayByPlayChecksum",
        "teamWeeklyStatsChecksum",
        "weeklyRosterChecksum",
        "injuryChecksum",
        "snapChecksum",
        "scheduleChecksum",
      ].map((name) => [name, hash(`${2019 + index}:${name}`)]),
    ),
  }));

export function rosDerivedEvaluationFixture() {
  const legacyProfile = projectionScoringProfileKey({
    id: "legacy",
    rules: [
      { statId: "receiving_yards", points: 0.1 },
      { statId: "points_allowed_0_probability", points: 10 },
    ],
  });
  const currentProfile = projectionScoringProfileKey({
    id: "current",
    rules: [
      { statId: "receiving_yards", points: 0.1 },
      { statId: "points_allowed_0_probability", points: 10, statDefinition: "yahoo-2022-v1" },
    ],
  });
  function report(
    raw: FirstPartyRosHeldOutForecast[],
    scoringProfileKey: string,
    name: string,
    training = false,
  ): Report {
    return {
      diagnostics: { candidateForecasts: raw.map((row) => ({ ...row, scoringProfileKey })) },
      identityAudit: { scoringProfileKey },
      outcomeCorpusIdentity: hash(name),
      sources: sources(),
      validationScope: { positions: training ? ["DST"] : positions, completePortfolio: !training },
      report: {
        forecasts: raw.length,
        playersPerPosition: training ? 32 : 8,
        skippedForecasts: 0,
        seasons: [2022, 2023, 2024, 2025],
      },
    };
  }
  const originalCandidate = report(fullForecasts(false), legacyProfile, "original-v13-view-corpus");
  const originalPrevious = report(fullForecasts(true), legacyProfile, "original-v12-corpus");
  const training = report(
    forecasts(false, NFL_TEAMS),
    currentProfile,
    "native-current-dst-corpus",
    true,
  );
  training.sources = training.sources.map((row) => ({
    ...row,
    teamWeeklyStatsChecksum: hash(`corrected:${String(row.season)}`),
  }));
  training.actualDefinitionVersion = ROS_HISTORICAL_ACTUAL_DEFINITION_VERSION;
  training.pointsAllowedDefinition = "yahoo-2022-v1";
  training.diagnostics.candidateForecasts = training.diagnostics.candidateForecasts.map((row) => ({
    ...row,
    inputChecksum: hash(`corrected-input:${row.inputChecksum}`),
    actualPoints: row.actualPoints + 3,
    contextual: { ...row.contextual, meanPoints: row.contextual.meanPoints + 0.25 },
  }));
  const trainingById = new Map(
    training.diagnostics.candidateForecasts.map((row) => [key(row), row]),
  );
  const candidate = structuredClone(originalCandidate);
  candidate.identityAudit.scoringProfileKey = currentProfile;
  candidate.sources = structuredClone(training.sources);
  candidate.diagnostics.candidateForecasts = candidate.diagnostics.candidateForecasts.map((row) =>
    row.position === "DST"
      ? structuredClone(trainingById.get(key(row))!)
      : { ...row, scoringProfileKey: currentProfile },
  );
  const previous = structuredClone(originalPrevious);
  previous.identityAudit.scoringProfileKey = currentProfile;
  previous.sources = structuredClone(training.sources);
  const candidateById = new Map(
    candidate.diagnostics.candidateForecasts.map((row) => [key(row), row]),
  );
  previous.diagnostics.candidateForecasts = previous.diagnostics.candidateForecasts.map((row) => ({
    ...row,
    actualPoints: candidateById.get(key(row))!.actualPoints,
    scoringProfileKey: currentProfile,
  }));

  const samples = new Map<string, FirstPartyRosHeldOutForecast>();
  for (const row of candidate.diagnostics.candidateForecasts.filter(
    (row) => row.position === "DST",
  )) {
    const id = stratum(row),
      prior = samples.get(id);
    if (
      !prior ||
      historicalRosChecksum(row.inputChecksum).localeCompare(
        historicalRosChecksum(prior.inputChecksum),
      ) < 0
    )
      samples.set(id, row);
  }
  const convergenceBindings: Record<string, unknown>[] = [];
  const convergenceAudit: Record<string, unknown>[] = [];
  for (const [id, row] of samples)
    for (const strategy of ["contextual", "availability-aware-recency"] as const) {
      const name = strategy === "contextual" ? "contextual" : "recency";
      const values = {
        ...row[name],
        expectedGames: row.evidence.availability.scheduledGames,
        seedHash: hash(`${id}:${strategy}:seed`),
        scoringProfileKey: currentProfile,
      };
      const diagnostic = evaluateFirstPartyRosConvergence({
        position: "DST",
        release: { ...values, scenarioCount: 12_288 },
        reference: { ...values, scenarioCount: 16_384 },
      });
      convergenceBindings.push({
        stratum: id,
        strategy,
        physicalKey: {
          modelVersion: "laces-ros-distribution-v13",
          identity: hash(`${id}:${strategy}:physical-key`),
        },
        manifestChecksum: hash(`${id}:${strategy}:manifest`),
        diagnostic,
      });
      const bucket = historicalRosBucket(row.windowStartWeek, row.windowEndWeek);
      const diagnosticChecksum = historicalRosConvergenceChecksum({
        season: row.forecastSeason,
        position: "DST",
        bucket,
        strategy,
        diagnostics: [diagnostic],
      });
      for (const member of candidate.diagnostics.candidateForecasts.filter(
        (member) => stratum(member) === id,
      ))
        Object.assign(member.evidence.convergence[name], {
          state: diagnostic.state,
          diagnosticChecksum,
        });
      convergenceAudit.push({
        season: row.forecastSeason,
        position: "DST",
        bucket,
        strategy,
        state: diagnostic.state,
        worstMetric: diagnostic.worstMetric,
        worstToleranceRatio: diagnostic.worstToleranceRatio,
      });
    }
  candidate.report.convergenceAudit = [
    ...convergenceAudit,
    ...Array.from({ length: 120 }, () => ({ position: "non-DST-unused-by-this-boundary" })),
  ];
  const manifest: Record<string, unknown> = {
    version: ROS_DERIVED_EVALUATION_VERSION,
    profile: currentProfile,
    legacyProfileDigest: hash(legacyProfile),
    pointsAllowedDefinition: "yahoo-2022-v1",
    observedActualDefinitionVersion: playerActuals,
    observedSources: training.sources,
    nonDstFragmentIdentity: hash("certified-nondst-fragment"),
    originalCandidateForecastSources: originalCandidate.sources,
    originalPreviousForecastSources: originalPrevious.sources,
    correctedDstForecastSources: training.sources,
    convergenceBindings,
    originalAuditMembershipPreserved: true,
    originalPreviousRawPredictionsPreserved: true,
    previousSelectionAndCalibrationRecomputedAgainstCorrectedObservations: true,
    noSimulation: true,
    canAuthorizeRelease: false,
  };
  function repin() {
    const oldCandidate = pin(originalCandidate),
      oldPrevious = pin(originalPrevious),
      trainingPin = pin(training);
    Object.assign(manifest, {
      originalCandidateReportSha256: oldCandidate.checksum,
      originalPreviousReportSha256: oldPrevious.checksum,
      nativeTrainingReportSha256: trainingPin.checksum,
      originalCandidatePhysicalCorpus: originalCandidate.outcomeCorpusIdentity,
      originalPreviousPhysicalCorpus: originalPrevious.outcomeCorpusIdentity,
      correctedDstPhysicalCorpus: training.outcomeCorpusIdentity,
      candidateRowsChecksum: historicalRosChecksum(candidate.diagnostics.candidateForecasts),
      previousRowsChecksum: historicalRosChecksum(previous.diagnostics.candidateForecasts),
    });
    const identity = historicalRosChecksum(manifest);
    for (const [report, role] of [
      [candidate, "candidate"],
      [previous, "retained-v12"],
    ] as const)
      Object.assign(report, {
        actualDefinitionVersion: playerActuals,
        pointsAllowedDefinition: "yahoo-2022-v1",
        canAuthorizeRelease: false,
        outcomeCorpusIdentity: historicalRosChecksum({
          kind: "derived-corrected-observation-evaluation",
          role,
          manifestIdentity: identity,
        }),
        correctedComparison: {
          version: ROS_DERIVED_EVALUATION_VERSION,
          manifestIdentity: identity,
          role,
          sourceSemantics:
            "sources identify corrected observed truth; original forecast source identities are retained in the comparison manifest",
          actualDefinitionVersion: playerActuals,
        },
      });
    const comparison = pin({ identity, payload: manifest }),
      current = pin(candidate),
      counterfactual = pin(previous);
    return {
      input: {
        comparisonManifestJson: comparison.text,
        comparisonManifestChecksum: comparison.checksum,
        originalCandidateReportJson: oldCandidate.text,
        originalCandidateReportChecksum: oldCandidate.checksum,
        originalPreviousReportJson: oldPrevious.text,
        originalPreviousReportChecksum: oldPrevious.checksum,
      },
      candidateReportJson: current.text,
      candidateReportChecksum: current.checksum,
      previousReportJson: counterfactual.text,
      previousReportChecksum: counterfactual.checksum,
      intervalTrainingReportJson: trainingPin.text,
      intervalTrainingReportChecksum: trainingPin.checksum,
    };
  }
  return { originalCandidate, originalPrevious, candidate, previous, training, manifest, repin };
}

/** Metadata/report boundary fixture only: fake file pins do not authenticate real physical data. */
export function rosDerivedProductionEvaluationFixture() {
  const fixture = rosDerivedEvaluationFixture();
  const productionPackage: RosDerivedProductionPackage = {
    version: ROS_DERIVED_PRODUCTION_PACKAGE_VERSION,
    forecastSeason: 2026,
    pointsAllowedDefinition: "yahoo-2022-v1",
    originalCandidatePhysicalCorpus: String(fixture.originalCandidate.outcomeCorpusIdentity),
    originalPreviousPhysicalCorpus: String(fixture.originalPrevious.outcomeCorpusIdentity),
    correctedDstPhysicalCorpus: String(fixture.training.outcomeCorpusIdentity),
    nonDstFragmentIdentity: String(fixture.manifest.nonDstFragmentIdentity),
    originalAuditMembershipChecksum: historicalRosChecksum(
      fixture.originalCandidate.diagnostics.candidateForecasts.map(key),
    ),
    originalForecastSources: fixture.originalCandidate.sources,
    observedSources: fixture.training.sources,
    candidateFrozenRevision: "a".repeat(40),
    dependencies: Object.fromEntries(
      ROS_DERIVED_PRODUCTION_DEPENDENCIES.map((role) => [role, `proof/${role}`]),
    ) as unknown as RosDerivedProductionPackage["dependencies"],
    files: Object.fromEntries(
      ROS_DERIVED_PRODUCTION_DEPENDENCIES.map((role) => [
        `proof/${role}`,
        {
          filename: `${hash(role)}.${role === "qualificationProtocol" ? "txt" : "json"}`,
          sha256: hash(role),
          encoding: role === "qualificationProtocol" ? "utf8-text" : "json",
        },
      ]),
    ),
    retention: "protect-original-vectors-and-proof-files-for-package-lifetime",
    noSimulation: true,
    canAuthorizeRelease: false,
  };
  return {
    ...fixture,
    productionPackage,
    repin() {
      const input = fixture.repin();
      const packagePin = pin(productionPackage);
      fixture.candidate.outcomeCorpusIdentity = rosDerivedProductionRoleIdentity(
        packagePin.checksum,
        "candidate",
      );
      fixture.previous.outcomeCorpusIdentity = rosDerivedProductionRoleIdentity(
        packagePin.checksum,
        "retained-v12",
      );
      const candidate = pin(fixture.candidate),
        previous = pin(fixture.previous);
      return {
        ...input,
        input: {
          ...input.input,
          productionPackageJson: packagePin.text,
          productionPackageChecksum: packagePin.checksum,
        },
        candidateReportJson: candidate.text,
        candidateReportChecksum: candidate.checksum,
        previousReportJson: previous.text,
        previousReportChecksum: previous.checksum,
      };
    },
  };
}
