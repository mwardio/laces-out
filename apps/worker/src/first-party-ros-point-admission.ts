import { createHash } from "node:crypto";
import {
  FIRST_PARTY_ROS_POINT_POLICY_VERSION,
  FIRST_PARTY_ROS_POINT_CALIBRATION_VERSION,
  FIRST_PARTY_ROS_POINT_RELEASE_VERSION,
  buildFirstPartyRosPointQualificationSet,
  deriveRosArtifactBlockers,
  type FirstPartyRosPointConvergenceEvidence,
} from "@laces-out/projections";
import {
  firstPartyRosAdmissionConstants,
  validateFirstPartyRosAdmission,
  type FirstPartyRosAdmissionValidation,
} from "./first-party-ros-admission.js";
import type { FirstPartyRosMarginalAdmissionInput } from "./first-party-ros-marginal-admission.js";
import {
  firstPartyRosChampionArtifactChecksum,
  firstPartyRosChampionArtifactIsValid,
} from "./first-party-ros-publication.js";
import { historicalRosBucket, historicalRosChecksum } from "./first-party-ros-backtest.js";
import { parsePinnedRosMarginalDevelopmentInputs } from "./ros-marginal-development.js";
import type { RosDerivedConvergenceBinding } from "./ros-derived-population-replay.js";

const POSITIONS = ["QB", "RB", "WR", "TE", "K", "DST"] as const;

/**
 * Distinct expected-point admission. Authenticating the existing full reports never upgrades
 * their rejected interval verdict. The v7 mean selector and its immutable support evidence are
 * reconstructed unchanged; the new receipts qualify only means and expected games.
 */
export function prepareFirstPartyRosPointAdmission(
  input: FirstPartyRosMarginalAdmissionInput,
): FirstPartyRosAdmissionValidation {
  try {
    if (!input.derivedEvaluation || input.forecastSeason !== 2026)
      return { state: "rejected", blockers: ["point_admission_corrected_evidence_required"] };
    const parsed = parsePinnedRosMarginalDevelopmentInputs({
      ...input,
      evaluationSeason: input.forecastSeason - 1,
      positions: POSITIONS,
    });
    const candidate = parsed.candidate;
    const legacy = validateFirstPartyRosAdmission({
      report: candidate.root,
      evidenceThroughSeason: input.forecastSeason - 1,
      constants: firstPartyRosAdmissionConstants(input.scoringProfile),
    });
    if (legacy.state === "rejected") return legacy;
    const manifest = JSON.parse(input.derivedEvaluation.comparisonManifestJson) as {
      payload: { convergenceBindings: readonly RosDerivedConvergenceBinding[] };
    };
    // The pinned parser above reconstructs these complete diagnostics and checks their exact
    // physical sample, seed, profile, release values and row evidence checksums.
    const bindings = new Map(
      manifest.payload.convergenceBindings.map(
        (entry) => [`${entry.stratum}:${entry.strategy}`, entry] as const,
      ),
    );
    const audit = (
      candidate.root.report as {
        convergenceAudit: readonly {
          season: number;
          position: (typeof POSITIONS)[number];
          bucket: "one-to-four" | "five-to-eight" | "nine-plus";
          strategy: "contextual" | "availability-aware-recency";
          state: "converged" | "unstable";
          worstToleranceRatio: number;
        }[];
      }
    ).convergenceAudit;
    const convergenceEvidence: FirstPartyRosPointConvergenceEvidence[] = audit.map((entry) => {
      const selected = entry.strategy === "contextual" ? "contextual" : "recency";
      const rows = candidate.raw.filter(
        (row) =>
          row.forecastSeason === entry.season &&
          row.position === entry.position &&
          historicalRosBucket(row.windowStartWeek, row.windowEndWeek) === entry.bucket,
      );
      const evidence = rows[0]?.evidence.convergence[selected];
      if (
        !evidence ||
        rows.some(
          (row) =>
            row.evidence.convergence[selected].state !== entry.state ||
            row.evidence.convergence[selected].diagnosticChecksum !== evidence.diagnosticChecksum,
        )
      )
        throw new Error("Point ROS audit is not bound to every forecast in its stratum");
      const shared = {
        season: entry.season,
        position: entry.position,
        bucket: entry.bucket,
        strategy: entry.strategy,
        diagnosticChecksum: evidence.diagnosticChecksum,
      };
      const binding = bindings.get(
        `${entry.season}:${entry.position}:${entry.bucket}:${entry.strategy}`,
      );
      if (entry.position === "DST") {
        if (!binding) throw new Error("Point ROS defense audit lacks its full physical diagnostic");
        return { ...shared, kind: "full-diagnostic", diagnostic: binding.diagnostic };
      }
      if (
        entry.state !== "converged" ||
        !Number.isFinite(entry.worstToleranceRatio) ||
        entry.worstToleranceRatio < 0 ||
        entry.worstToleranceRatio > 1
      )
        throw new Error("Point ROS non-defense audit requires complete convergence evidence");
      return {
        ...shared,
        kind: "full-distribution-converged",
        state: "converged",
        worstToleranceRatio: entry.worstToleranceRatio,
      };
    });
    const sourceEvidenceChecksum = historicalRosChecksum({
      version: "point-ros-source-evidence-v1",
      sources: candidate.sources,
      derivedEvaluation: parsed.derivedEvaluation!.lineage,
    });
    const qualifications = buildFirstPartyRosPointQualificationSet({
      meanPolicy: legacy.payload.policy,
      forecastSeason: input.forecastSeason,
      candidateReportChecksum: input.candidateReportChecksum,
      sourceEvidenceChecksum,
      comparisonManifestChecksum: input.derivedEvaluation.comparisonManifestChecksum,
      convergenceEvidence,
    });
    if (
      qualifications.some(
        (qualification) =>
          qualification.convergence[
            qualification.selectedStrategy === "contextual" ? "contextual" : "recency"
          ].rate !== 1,
      )
    )
      return { state: "rejected", blockers: ["point_admission_mean_or_convergence_failed"] };
    const payload = {
      ...legacy.payload,
      policyVersion: FIRST_PARTY_ROS_POINT_POLICY_VERSION,
      calibrationVersion: FIRST_PARTY_ROS_POINT_CALIBRATION_VERSION,
      sourceChecksums: [
        ...legacy.payload.sourceChecksums,
        { key: "point-candidate-report", checksum: input.candidateReportChecksum },
        { key: "point-source-evidence", checksum: sourceEvidenceChecksum },
        {
          key: "point-comparison-manifest",
          checksum: input.derivedEvaluation.comparisonManifestChecksum,
        },
        {
          key: "point-qualification-contract",
          checksum: createHash("sha256")
            .update(FIRST_PARTY_ROS_POINT_RELEASE_VERSION)
            .digest("hex"),
        },
      ],
      releaseGate: {
        ...legacy.payload.releaseGate,
        pointForecasts: {
          schemaVersion: 1,
          method: FIRST_PARTY_ROS_POINT_RELEASE_VERSION,
          intervalAvailable: false,
          qualifications,
        },
      },
    };
    const artifactChecksum = firstPartyRosChampionArtifactChecksum(payload);
    if (!firstPartyRosChampionArtifactIsValid({ ...payload, artifactChecksum }))
      return { state: "rejected", blockers: ["point_admission_constructed_artifact_invalid"] };
    const blockers = deriveRosArtifactBlockers(payload).effectiveBlockers;
    if (blockers.length)
      return { state: "rejected", blockers: ["point_admission_mean_or_convergence_failed"] };
    return { state: "admissible", blockers: [], cellBlockers: [], payload, artifactChecksum };
  } catch {
    return { state: "rejected", blockers: ["point_admission_evidence_invalid"] };
  }
}
