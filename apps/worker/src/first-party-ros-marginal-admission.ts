import { createHash } from "node:crypto";
import {
  FIRST_PARTY_ROS_MARGINAL_POLICY_VERSION,
  MARGINAL_INTERVAL_CALIBRATION_VERSION,
  ROS_MARGINAL_INTERVAL_QUALIFICATION_VERSION,
  buildRosMarginalIntervalStoredCells,
  type ProjectionScoringProfile,
} from "@laces-out/projections";
import {
  firstPartyRosAdmissionConstants,
  validateFirstPartyRosAdmission,
  type FirstPartyRosAdmissionValidation,
} from "./first-party-ros-admission.js";
import { historicalRosCalibrationBlockers } from "./first-party-ros-backtest.js";
import {
  firstPartyRosChampionArtifactChecksum,
  firstPartyRosChampionArtifactIsValid,
  type FirstPartyRosChampionArtifactPayload,
} from "./first-party-ros-publication.js";
import { buildRosMarginalDevelopmentReport } from "./ros-marginal-development.js";
import type { RosDerivedEvaluationInput } from "./ros-derived-evaluation.js";

export const FIRST_PARTY_ROS_MARGINAL_ADMISSION_VERSION = "first-party-ros-marginal-admission-v1";
const POSITIONS = ["QB", "RB", "WR", "TE", "K", "DST"] as const;
const BUCKETS = ["one-to-four", "five-to-eight", "nine-plus"] as const;
const SHA256 = /^[a-f0-9]{64}$/u;
const LEGACY_SOURCE_FIELDS = [
  ["nflverse.stats-player-week", "weeklyStatsChecksum"],
  ["nflverse.stats-team-week", "teamWeeklyStatsChecksum"],
  ["nflverse.weekly-rosters", "weeklyRosterChecksum"],
  ["nflverse.injuries", "injuryChecksum"],
  ["nflverse.snap-counts", "snapChecksum"],
  ["nflverse.schedules", "scheduleChecksum"],
] as const;

export interface FirstPartyRosMarginalAdmissionInput {
  readonly candidateReportJson: string;
  readonly candidateReportChecksum: string;
  readonly previousReportJson: string;
  readonly previousReportChecksum: string;
  /** Exact frozen protocol text, including its original whitespace and final newline. */
  readonly qualificationProtocolText: string;
  readonly qualificationProtocolChecksum: string;
  /** Trusted current forecast season; must immediately follow the frozen held-out year. */
  readonly forecastSeason: number;
  readonly scoringProfile: ProjectionScoringProfile;
  /** Pinned complete32-defense training; composed with the unchanged non-defense audit rows. */
  readonly intervalTrainingReportJson?: string;
  readonly intervalTrainingReportChecksum?: string;
  readonly derivedEvaluation?: RosDerivedEvaluationInput;
}

function reject(...blockers: string[]): FirstPartyRosAdmissionValidation {
  return { state: "rejected", blockers };
}

function fail(reason: string): never {
  throw new Error(reason);
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail("marginal_admission_report_not_object");
  return value as Record<string, unknown>;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Matches the pinned development report's canonical source-audit serialization. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, field]) => `${JSON.stringify(key)}:${canonical(field)}`)
      .join(",")}}`;
  const result = JSON.stringify(value);
  if (result === undefined) fail("marginal_admission_undefined_evidence");
  return result;
}

function equal(left: unknown, right: unknown, reason: string): void {
  if (canonical(left) !== canonical(right)) fail(reason);
}

function pinnedText(text: unknown, checksum: unknown, label: string, maximumBytes: number): string {
  if (
    typeof text !== "string" ||
    !text.trim() ||
    Buffer.byteLength(text) > maximumBytes ||
    typeof checksum !== "string" ||
    !SHA256.test(checksum) ||
    hash(text) !== checksum
  )
    fail(`marginal_admission_${label}_pin_mismatch`);
  return text;
}

function fullScope(report: Record<string, unknown>, label: string): void {
  const scope = record(report.validationScope);
  if (
    !Array.isArray(scope.positions) ||
    scope.positions.length !== 6 ||
    scope.completePortfolio !== true
  )
    fail(`marginal_admission_${label}_scope_not_complete`);
  const positions: readonly unknown[] = scope.positions;
  equal(
    [...positions].sort(),
    [...POSITIONS].sort(),
    `marginal_admission_${label}_scope_not_complete`,
  );
}

/**
 * Pure admission preparation from exact pinned raw reports, never from a supplied qualification
 * verdict. Hash pins establish integrity, not signatures or operator authorization. A returned
 * admissible payload still requires the ordinary authenticated admission workflow and any frozen
 * fresh-confirmation/deployment prerequisites; this function performs no database writes.
 *
 * This first branch intentionally inherits the development builder's fixed 3264-row complete
 * cohort. Optional complete-defense training has its own authenticated composition manifest;
 * legacy-compatible reduced scoring cohorts remain unsupported by this frozen protocol.
 */
export function prepareFirstPartyRosMarginalAdmission(
  input: FirstPartyRosMarginalAdmissionInput,
): FirstPartyRosAdmissionValidation {
  try {
    if (
      (input.intervalTrainingReportJson === undefined) !==
      (input.intervalTrainingReportChecksum === undefined)
    )
      return reject("marginal_admission_interval_training_pin_incomplete");
    if (input.intervalTrainingReportJson !== undefined)
      pinnedText(
        input.intervalTrainingReportJson,
        input.intervalTrainingReportChecksum,
        "interval_training",
        64 * 1024 * 1024,
      );
    if (
      !Number.isSafeInteger(input.forecastSeason) ||
      input.forecastSeason < 2001 ||
      input.forecastSeason > 2200
    )
      return reject("marginal_admission_forecast_season_invalid");
    const protocolText = pinnedText(
      input.qualificationProtocolText,
      input.qualificationProtocolChecksum,
      "protocol",
      1024 * 1024,
    );
    const candidate = record(
      JSON.parse(
        pinnedText(
          input.candidateReportJson,
          input.candidateReportChecksum,
          "candidate",
          64 * 1024 * 1024,
        ),
      ) as unknown,
    );
    const previous = record(
      JSON.parse(
        pinnedText(
          input.previousReportJson,
          input.previousReportChecksum,
          "previous",
          64 * 1024 * 1024,
        ),
      ) as unknown,
    );
    fullScope(candidate, "candidate");
    fullScope(previous, "previous");
    const evidenceThroughSeason = input.forecastSeason - 1;
    const constants = firstPartyRosAdmissionConstants(input.scoringProfile);
    // Run the unchanged legacy boundary on the exact candidate bytes, never on an edited report
    // with inconvenient blockers removed or on the development wrapper's claimed verdict.
    const legacy = validateFirstPartyRosAdmission({
      report: candidate,
      evidenceThroughSeason,
      constants,
    });
    if (legacy.state === "rejected") return legacy;
    const development = buildRosMarginalDevelopmentReport({
      candidateReportJson: input.candidateReportJson,
      candidateReportChecksum: input.candidateReportChecksum,
      previousReportJson: input.previousReportJson,
      previousReportChecksum: input.previousReportChecksum,
      forecastSeason: input.forecastSeason,
      evaluationSeason: evidenceThroughSeason,
      positions: POSITIONS,
      qualificationProtocolChecksum: input.qualificationProtocolChecksum,
      ...(input.derivedEvaluation === undefined
        ? {}
        : { derivedEvaluation: input.derivedEvaluation }),
      ...(input.intervalTrainingReportJson === undefined
        ? {}
        : {
            intervalTrainingReportJson: input.intervalTrainingReportJson,
            intervalTrainingReportChecksum: input.intervalTrainingReportChecksum!,
          }),
    });
    if (!("qualification" in development) || !development.completePortfolio)
      return reject("marginal_admission_complete_qualification_missing");
    const portfolio = development.marginalDevelopment.portfolio;
    equal(
      Object.keys(portfolio.benchmarkSources).sort(),
      ["previous-deployed", "previous-raw", "same-physics-legacy", "same-physics-raw"],
      "marginal_admission_portfolio_comparators_incomplete",
    );
    if (portfolio.state !== "passed" || portfolio.worseThan.length > 0)
      return reject(
        ...portfolio.worseThan.map((name) => `marginal_admission_portfolio_wis_worse_than_${name}`),
        "marginal_admission_portfolio_comparison_failed",
      );

    const qualifications = development.qualification.cells;
    const required = POSITIONS.flatMap((position) =>
      BUCKETS.map((bucket) => `${position}:${bucket}`),
    ).sort();
    equal(
      qualifications.map((receipt) => `${receipt.cell.position}:${receipt.cell.bucket}`).sort(),
      required,
      "marginal_admission_incomplete_cell_scope",
    );
    equal(candidate.sources, previous.sources, "marginal_admission_source_audit_mismatch");
    equal(
      candidate.sources,
      development.provenance.sources,
      "marginal_admission_reconstructed_source_audit_mismatch",
    );
    const sourceAudit = development.provenance.sources;
    const sourceAuditChecksum = hash(canonical(sourceAudit));
    // Independently derive the legacy six-source list. The two additional raw/PBP pins remain
    // inspectable in sourceAudit and covered by its all-field canonical digest and report pins.
    const sourceChecksums = sourceAudit
      .flatMap((source) =>
        LEGACY_SOURCE_FIELDS.map(([prefix, field]) => {
          if (
            !Number.isSafeInteger(source.season) ||
            typeof source[field] !== "string" ||
            !SHA256.test(source[field])
          )
            fail("marginal_admission_invalid_source_audit");
          return { key: `${prefix}.${source.season as number}`, checksum: source[field] };
        }),
      )
      .sort((left, right) => left.key.localeCompare(right.key));
    equal(
      sourceChecksums,
      legacy.payload.sourceChecksums,
      "marginal_admission_source_list_linkage_mismatch",
    );
    const trainingSource = development.provenance.intervalTraining ?? null;
    const composition = development.provenance.intervalTrainingComposition ?? null;
    if (input.intervalTrainingReportJson !== undefined) {
      if (
        trainingSource === null ||
        composition === null ||
        composition.constituents[1].source.reportChecksum !==
          input.intervalTrainingReportChecksum ||
        composition.evaluation.source.reportChecksum !== input.candidateReportChecksum ||
        composition.sourceManifestChecksum !== sourceAuditChecksum ||
        trainingSource.reportChecksum !== hash(canonical(composition)) ||
        trainingSource.physicalCorpusChecksum !==
          hash(canonical({ kind: "derived-training-corpus", manifest: composition }))
      )
        fail("marginal_admission_training_composition_binding_mismatch");
    } else if (trainingSource !== null || composition !== null) {
      fail("marginal_admission_unrequested_training_composition");
    }
    for (const receipt of qualifications) {
      if (input.derivedEvaluation === undefined) {
        if (receipt.frozenPrevious !== undefined)
          fail("marginal_admission_unrequested_frozen_benchmark");
      } else if (
        receipt.frozenPrevious?.comparisonManifestChecksum !==
          input.derivedEvaluation.comparisonManifestChecksum ||
        receipt.frozenPrevious.original.source.reportChecksum !==
          input.derivedEvaluation.originalPreviousReportChecksum ||
        receipt.frozenPrevious.correctedObservations.source.reportChecksum !==
          input.previousReportChecksum
      )
        fail("marginal_admission_frozen_benchmark_binding_mismatch");
      if (
        receipt.forecastSeason !== input.forecastSeason ||
        receipt.comparisonSeason !== evidenceThroughSeason ||
        receipt.sourceScope.protocolChecksum !== input.qualificationProtocolChecksum ||
        receipt.sourceScope.sourceManifestChecksum !== sourceAuditChecksum ||
        receipt.sourceScope.fullReportChecksum !==
          development.qualification.developmentReportChecksum ||
        receipt.sources.candidate.sourceManifestChecksum !== sourceAuditChecksum ||
        receipt.sources.previous.sourceManifestChecksum !== sourceAuditChecksum ||
        receipt.sources.candidate.source.reportChecksum !== input.candidateReportChecksum ||
        receipt.sources.previous.source.reportChecksum !== input.previousReportChecksum ||
        receipt.sources.candidate.source.scoringProfileKey !== constants.scoringProfileKey
      )
        fail("marginal_admission_qualification_source_binding_mismatch");
      equal(
        receipt.sources.intervalTraining,
        composition === null
          ? null
          : {
              source: trainingSource,
              sourceManifestChecksum: sourceAuditChecksum,
              rowsChecksum: composition.trainingRowsChecksum,
            },
        "marginal_admission_qualification_training_binding_mismatch",
      );
      equal(
        receipt.sourceScope.requiredCells.map((cell) => `${cell.position}:${cell.bucket}`).sort(),
        required,
        "marginal_admission_qualification_scope_mismatch",
      );
    }
    equal(
      development.legacyEvaluation.candidatePolicy,
      legacy.payload.policy,
      "marginal_admission_changed_legacy_mean_policy",
    );

    const physicalBlocker = (reason: string, training: boolean) => {
      const match =
        /^physical-convergence:(20[0-9]{2}|21[0-9]{2}|2200):(QB|RB|WR|TE|K|DST):(one-to-four|five-to-eight|nine-plus):(contextual|availability-aware-recency)$/u.exec(
          reason,
        );
      if (!match) fail("marginal_admission_unknown_physical_blocker");
      return `calibration_${match[2]}_${match[3]}_marginal_${training ? "training_" : ""}physical_convergence_${match[1]}_${match[4]}`;
    };
    const physicalBlockers = development.legacyEvaluation.physicalBlockers.map((reason) =>
      physicalBlocker(reason, false),
    );
    const trainingAudit = development.legacyEvaluation.intervalTraining;
    const trainingLegacyConvergenceBlockers =
      trainingAudit === undefined
        ? []
        : (record(trainingAudit.fullReport.report).blockers as string[]).filter((reason) =>
            reason.includes("convergence"),
          );
    // The legacy evaluator reports absent-position failures in a DST-only report. Keep those
    // diagnostics inspectable, but do not turn unevaluated QB/RB/WR/TE/K cells into new failures.
    // The complete original audit and its physical checks remain independently authoritative.
    const ignoredTrainingBlockers = trainingLegacyConvergenceBlockers.filter((reason) =>
      /^(?:cell|champion|calibration)_(QB|RB|WR|TE|K)_(one-to-four|five-to-eight|nine-plus)_/u.test(
        reason,
      ),
    );
    const trainingBlockers =
      trainingAudit === undefined
        ? []
        : [
            ...trainingAudit.physicalBlockers.map((reason) => physicalBlocker(reason, true)),
            ...trainingLegacyConvergenceBlockers
              .filter((reason) => !ignoredTrainingBlockers.includes(reason))
              .map((reason) => {
                const match =
                  /^(?:cell|champion|calibration)_(QB|RB|WR|TE|K|DST)_(one-to-four|five-to-eight|nine-plus)_(.+)$/u.exec(
                    reason,
                  );
                return match
                  ? `calibration_${match[1]}_${match[2]}_marginal_training_${match[3]}`
                  : `marginal_interval_training_${reason}`;
              }),
          ];
    const cellBlockers = [
      ...new Set([
        ...legacy.cellBlockers,
        ...historicalRosCalibrationBlockers(legacy.payload.policy.choices),
        ...physicalBlockers,
        ...trainingBlockers,
        ...qualifications
          .filter((receipt) => receipt.state !== "qualified")
          .map(
            (receipt) =>
              `calibration_${receipt.cell.position}_${receipt.cell.bucket}_marginal_interval_qualification_failed`,
          ),
      ]),
    ];
    const payload: FirstPartyRosChampionArtifactPayload = {
      ...legacy.payload,
      season: input.forecastSeason,
      policyVersion: FIRST_PARTY_ROS_MARGINAL_POLICY_VERSION,
      calibrationVersion: MARGINAL_INTERVAL_CALIBRATION_VERSION,
      releaseGate: {
        ...legacy.payload.releaseGate,
        state: cellBlockers.length === 0 ? "evidence-ready" : "insufficient",
        blockers: cellBlockers,
        marginalIntervals: {
          schemaVersion: 1,
          qualificationMethod: ROS_MARGINAL_INTERVAL_QUALIFICATION_VERSION,
          qualifications,
          cells: buildRosMarginalIntervalStoredCells({
            qualifications,
            releasedCells: qualifications
              .filter((receipt) => receipt.state === "qualified")
              .map((receipt) => receipt.cell),
          }),
        },
        marginalAdmission: {
          schemaVersion: 1,
          version: FIRST_PARTY_ROS_MARGINAL_ADMISSION_VERSION,
          forecastSeason: input.forecastSeason,
          evidenceThroughSeason,
          scoringProfileKey: constants.scoringProfileKey,
          pins: {
            candidateReportChecksum: input.candidateReportChecksum,
            previousReportChecksum: input.previousReportChecksum,
            qualificationProtocolChecksum: input.qualificationProtocolChecksum,
            ...(input.derivedEvaluation === undefined
              ? {}
              : {
                  derivedComparisonManifestChecksum:
                    input.derivedEvaluation.comparisonManifestChecksum,
                  originalCandidateReportChecksum:
                    input.derivedEvaluation.originalCandidateReportChecksum,
                  originalPreviousReportChecksum:
                    input.derivedEvaluation.originalPreviousReportChecksum,
                }),
            ...(input.intervalTrainingReportChecksum === undefined
              ? {}
              : { intervalTrainingReportChecksum: input.intervalTrainingReportChecksum }),
          },
          protocolText,
          sourceAudit,
          sourceAuditChecksum,
          ...(development.provenance.derivedEvaluation === undefined
            ? {}
            : {
                derivedEvaluation: development.provenance.derivedEvaluation,
              }),
          developmentEvidenceChecksum: development.evidenceChecksum,
          developmentReportChecksum: development.qualification.developmentReportChecksum,
          legacyArtifactChecksum: legacy.artifactChecksum,
          portfolio,
          ...(composition === null
            ? {}
            : {
                intervalTrainingComposition: composition,
                intervalTrainingDiagnostics: {
                  physicalBlockers: trainingAudit!.physicalBlockers,
                  rawLegacyConvergenceBlockers: trainingLegacyConvergenceBlockers,
                  ignoredOutOfScopeLegacyConvergenceBlockers: ignoredTrainingBlockers,
                },
              }),
        },
      },
    };
    const artifactChecksum = firstPartyRosChampionArtifactChecksum(payload);
    if (!firstPartyRosChampionArtifactIsValid({ ...payload, artifactChecksum }))
      return reject("marginal_admission_constructed_artifact_invalid");
    return { state: "admissible", blockers: [], cellBlockers, payload, artifactChecksum };
  } catch (error) {
    return reject(
      `marginal_admission_reconstruction_failed:${error instanceof Error ? error.message : "invalid evidence"}`,
    );
  }
}
