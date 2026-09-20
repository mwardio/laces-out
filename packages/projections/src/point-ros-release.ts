import {
  evaluateFirstPartyRosConvergence,
  evaluateFirstPartyRosReleaseGate,
  FIRST_PARTY_ROS_MODEL_VERSION,
  FIRST_PARTY_ROS_POLICY_VERSION,
  type FirstPartyRosChampionPolicy,
  type FirstPartyRosConvergenceDiagnostic,
  type FirstPartyRosConvergenceMetric,
  type FirstPartyRosConvergenceSummary,
  type FirstPartyRosLiveReleaseEvidence,
  type FirstPartyRosPosition,
  type FirstPartyRosReleaseGateReason,
  type FirstPartyRosRemainingWeeksBucket,
  type FirstPartyRosStrategy,
} from "./rest-of-season.js";
import { projectionScoringRulesFromProfileKey } from "./scoring-position-keys.js";
import { sha256Hex } from "./sha256.js";
import type { RosArtifactBlockerContext } from "./ros-artifact-blockers.js";

export const FIRST_PARTY_ROS_POINT_POLICY_VERSION = "season-walk-forward-mean-only-v1";
export const FIRST_PARTY_ROS_POINT_CALIBRATION_VERSION = "unavailable-point-only-v1";
export const FIRST_PARTY_ROS_POINT_RELEASE_VERSION = "point-ros-release-v1";
export const FIRST_PARTY_ROS_POINT_QUALIFICATION_VERSION = "point-ros-qualification-v1";
const POSITIONS = ["QB", "RB", "WR", "TE", "K", "DST"] as const;
const BUCKETS = ["one-to-four", "five-to-eight", "nine-plus"] as const;
const STRATEGIES = ["contextual", "availability-aware-recency"] as const;
const METRICS = ["expectedGames", "meanPoints", "p15Points", "p50Points", "p85Points"] as const;
const SHA = /^[a-f0-9]{64}$/u;
const INTERVAL_REASONS = new Set<FirstPartyRosReleaseGateReason>([
  "interval-calibration-unavailable",
  "insufficient-walk-forward-calibration-evidence",
  "interval-coverage-gate-failed",
]);
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new TypeError(`Invalid point ROS evidence: ${message}`);
}
function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    record(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
function count(value: unknown, maximum = 1_000_000): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= maximum;
}
/** Bounded canonical JSON, including every submitted field; independent of JSONB key order. */
export function firstPartyRosPointEvidenceChecksum(value: unknown): string {
  let nodes = 0;
  const ancestors = new Set<object>();
  function normalize(input: unknown, depth: number): unknown {
    requireValue(++nodes <= 200_000 && depth <= 32, "checksum bounds");
    if (input === null || typeof input === "boolean" || typeof input === "string") return input;
    if (typeof input === "number") {
      requireValue(Number.isFinite(input), "finite evidence");
      return input;
    }
    requireValue(record(input) || Array.isArray(input), "plain evidence");
    requireValue(!ancestors.has(input), "acyclic evidence");
    ancestors.add(input);
    const result = Array.isArray(input)
      ? input.map((child) => normalize(child, depth + 1))
      : Object.fromEntries(
          Object.keys(input)
            .sort()
            .map((key) => [key, normalize(input[key], depth + 1)]),
        );
    ancestors.delete(input);
    return result;
  }
  const text = JSON.stringify(normalize(value, 0));
  requireValue(text.length <= 4 * 1024 * 1024, "serialized evidence bounds");
  return sha256Hex(text);
}

/** Reconstruct the entire original diagnostic before considering the two point statistics. */
export function extractFirstPartyRosPointConvergence(input: {
  readonly position: FirstPartyRosPosition;
  readonly scoringProfileKey: string;
  readonly diagnostic: FirstPartyRosConvergenceDiagnostic;
}) {
  const diagnostic = input.diagnostic;
  requireValue(
    record(diagnostic) && Array.isArray(diagnostic.metrics) && diagnostic.metrics.length === 5,
    "complete convergence diagnostic",
  );
  requireValue(
    diagnostic.metrics.every((metric, index) => record(metric) && metric.metric === METRICS[index]),
    "complete ordered convergence metrics",
  );
  const shared = { seedHash: diagnostic.seedHash, scoringProfileKey: input.scoringProfileKey };
  const fullMetrics: readonly FirstPartyRosConvergenceMetric[] = diagnostic.metrics;
  const release = {
    ...shared,
    scenarioCount: diagnostic.releaseScenarioCount,
    ...Object.fromEntries(fullMetrics.map((metric) => [metric.metric, metric.releaseValue])),
  } as unknown as FirstPartyRosConvergenceSummary;
  const reference = {
    ...shared,
    scenarioCount: diagnostic.referenceScenarioCount,
    ...Object.fromEntries(fullMetrics.map((metric) => [metric.metric, metric.referenceValue])),
  } as unknown as FirstPartyRosConvergenceSummary;
  const reconstructed = evaluateFirstPartyRosConvergence({
    position: input.position,
    release,
    reference,
  });
  const originalDiagnosticChecksum = firstPartyRosPointEvidenceChecksum(diagnostic);
  requireValue(
    originalDiagnosticChecksum === firstPartyRosPointEvidenceChecksum(reconstructed),
    "full convergence reconstruction",
  );
  const metrics = reconstructed.metrics.slice(0, 2);
  const payload = {
    method: "point-ros-convergence-v1" as const,
    state: metrics.every((metric) => metric.converged)
      ? ("converged" as const)
      : ("unstable" as const),
    lowerScenarioCount: reconstructed.releaseScenarioCount,
    referenceScenarioCount: reconstructed.referenceScenarioCount,
    maxToleranceRatio: Math.max(...metrics.map((metric) => metric.toleranceRatio)),
    originalDiagnosticChecksum,
    metrics,
  };
  return { ...payload, diagnosticChecksum: firstPartyRosPointEvidenceChecksum(payload) };
}

interface PointConvergenceIdentity {
  readonly season: number;
  readonly position: FirstPartyRosPosition;
  readonly bucket: FirstPartyRosRemainingWeeksBucket;
  readonly strategy: FirstPartyRosStrategy;
  /** Original authenticated report/manifest checksum, retained without translation. */
  readonly diagnosticChecksum: string;
}
export type FirstPartyRosPointConvergenceEvidence = PointConvergenceIdentity &
  (
    | { readonly kind: "full-diagnostic"; readonly diagnostic: FirstPartyRosConvergenceDiagnostic }
    | {
        readonly kind: "full-distribution-converged";
        readonly state: "converged";
        readonly worstToleranceRatio: number;
      }
  );
interface PointConvergenceSupport {
  readonly samples: number;
  readonly converged: number;
  readonly rate: number;
  readonly evidenceChecksum: string;
}
export interface FirstPartyRosPointQualification {
  readonly schemaVersion: 1;
  readonly version: typeof FIRST_PARTY_ROS_POINT_QUALIFICATION_VERSION;
  readonly policyVersion: typeof FIRST_PARTY_ROS_POINT_POLICY_VERSION;
  readonly meanPolicyVersion: typeof FIRST_PARTY_ROS_POLICY_VERSION;
  readonly modelVersion: typeof FIRST_PARTY_ROS_MODEL_VERSION;
  readonly calibrationVersion: typeof FIRST_PARTY_ROS_POINT_CALIBRATION_VERSION;
  readonly forecastSeason: number;
  readonly scoringProfileKey: string;
  readonly position: FirstPartyRosPosition;
  readonly bucket: FirstPartyRosRemainingWeeksBucket;
  readonly selectedStrategy: FirstPartyRosStrategy;
  readonly policyChecksum: string;
  readonly candidateReportChecksum: string;
  readonly sourceEvidenceChecksum: string;
  readonly comparisonManifestChecksum: string;
  readonly heldOutEvidenceChecksum: string;
  readonly support: { readonly seasons: number; readonly blocks: number; readonly samples: number };
  readonly convergence: {
    readonly contextual: PointConvergenceSupport;
    readonly recency: PointConvergenceSupport;
  };
  readonly intervalAvailable: false;
  readonly evidenceChecksum: string;
}
const QUALIFICATION_KEYS = [
  "schemaVersion",
  "version",
  "policyVersion",
  "meanPolicyVersion",
  "modelVersion",
  "calibrationVersion",
  "forecastSeason",
  "scoringProfileKey",
  "position",
  "bucket",
  "selectedStrategy",
  "policyChecksum",
  "candidateReportChecksum",
  "sourceEvidenceChecksum",
  "comparisonManifestChecksum",
  "heldOutEvidenceChecksum",
  "support",
  "convergence",
  "intervalAvailable",
  "evidenceChecksum",
];
export function firstPartyRosPointQualificationIsStructurallyValid(
  value: unknown,
): value is FirstPartyRosPointQualification {
  try {
    if (
      !exactKeys(value, QUALIFICATION_KEYS) ||
      value.schemaVersion !== 1 ||
      value.version !== FIRST_PARTY_ROS_POINT_QUALIFICATION_VERSION ||
      value.policyVersion !== FIRST_PARTY_ROS_POINT_POLICY_VERSION ||
      value.meanPolicyVersion !== FIRST_PARTY_ROS_POLICY_VERSION ||
      value.modelVersion !== FIRST_PARTY_ROS_MODEL_VERSION ||
      value.calibrationVersion !== FIRST_PARTY_ROS_POINT_CALIBRATION_VERSION ||
      value.intervalAvailable !== false ||
      !count(value.forecastSeason, 2200) ||
      value.forecastSeason < 2000 ||
      !POSITIONS.includes(value.position as FirstPartyRosPosition) ||
      !BUCKETS.includes(value.bucket as FirstPartyRosRemainingWeeksBucket) ||
      !STRATEGIES.includes(value.selectedStrategy as FirstPartyRosStrategy)
    )
      return false;
    if (typeof value.scoringProfileKey !== "string") return false;
    projectionScoringRulesFromProfileKey(value.scoringProfileKey);
    for (const key of [
      "policyChecksum",
      "candidateReportChecksum",
      "sourceEvidenceChecksum",
      "comparisonManifestChecksum",
      "heldOutEvidenceChecksum",
      "evidenceChecksum",
    ])
      if (typeof value[key] !== "string" || !SHA.test(value[key])) return false;
    if (
      !exactKeys(value.support, ["seasons", "blocks", "samples"]) ||
      !count(value.support.seasons, 200) ||
      !count(value.support.blocks) ||
      !count(value.support.samples)
    )
      return false;
    if (!exactKeys(value.convergence, ["contextual", "recency"])) return false;
    for (const key of ["contextual", "recency"]) {
      const evidence = value.convergence[key];
      if (
        !exactKeys(evidence, ["samples", "converged", "rate", "evidenceChecksum"]) ||
        !count(evidence.samples, 200) ||
        !Number.isSafeInteger(evidence.converged) ||
        (evidence.converged as number) < 0 ||
        (evidence.converged as number) > evidence.samples ||
        evidence.rate !== (evidence.converged as number) / evidence.samples ||
        evidence.samples !== value.support.seasons ||
        typeof evidence.evidenceChecksum !== "string" ||
        !SHA.test(evidence.evidenceChecksum)
      )
        return false;
    }
    const { evidenceChecksum, ...payload } = value;
    return evidenceChecksum === firstPartyRosPointEvidenceChecksum(payload);
  } catch {
    return false;
  }
}

/** Inputs must come from an independently authenticated report and exact source manifest. */
export function buildFirstPartyRosPointQualificationSet(input: {
  readonly meanPolicy: FirstPartyRosChampionPolicy;
  readonly forecastSeason: number;
  readonly candidateReportChecksum: string;
  readonly sourceEvidenceChecksum: string;
  readonly comparisonManifestChecksum: string;
  readonly convergenceEvidence: readonly FirstPartyRosPointConvergenceEvidence[];
}): readonly FirstPartyRosPointQualification[] {
  const policy = input.meanPolicy;
  requireValue(
    policy.policyVersion === FIRST_PARTY_ROS_POLICY_VERSION &&
      policy.modelVersion === FIRST_PARTY_ROS_MODEL_VERSION &&
      policy.evidenceIdentity !== null &&
      policy.evidenceThroughSeason !== null &&
      policy.evidenceThroughSeason < input.forecastSeason,
    "mean policy identity",
  );
  const profile = policy.evidenceIdentity.scoringProfileKey;
  const policyChecksum = firstPartyRosPointEvidenceChecksum(policy);
  requireValue(
    policy.choices.length === 18 && input.convergenceEvidence.length <= 18 * 2 * 200,
    "complete bounded cells",
  );
  const seen = new Set<string>();
  const rows = new Map<
    string,
    { readonly original: FirstPartyRosPointConvergenceEvidence; readonly pointConverged: boolean }
  >();
  for (const evidence of input.convergenceEvidence) {
    const key = `${evidence.position}:${evidence.bucket}:${evidence.strategy}:${evidence.season}`;
    requireValue(
      !rows.has(key) &&
        SHA.test(evidence.diagnosticChecksum) &&
        count(evidence.season, 2200) &&
        evidence.season < input.forecastSeason,
      "unique prior convergence evidence",
    );
    let pointConverged: boolean;
    if (evidence.kind === "full-diagnostic")
      pointConverged =
        extractFirstPartyRosPointConvergence({
          position: evidence.position,
          scoringProfileKey: profile,
          diagnostic: evidence.diagnostic,
        }).state === "converged";
    else {
      requireValue(
        evidence.kind === "full-distribution-converged" &&
          evidence.state === "converged" &&
          Number.isFinite(evidence.worstToleranceRatio) &&
          evidence.worstToleranceRatio >= 0 &&
          evidence.worstToleranceRatio <= 1,
        "authenticated complete-distribution bound",
      );
      pointConverged = true;
    }
    rows.set(key, { original: evidence, pointConverged });
  }
  const qualifications = policy.choices.map((choice): FirstPartyRosPointQualification => {
    const cell = `${choice.position}:${choice.bucket}`;
    requireValue(
      !seen.has(cell) && POSITIONS.includes(choice.position) && BUCKETS.includes(choice.bucket),
      "unique required cell",
    );
    seen.add(cell);
    const seasons = choice.meanSelectionEvidence.seasonEvidence.map((entry) => entry.season);
    requireValue(
      new Set(seasons).size === seasons.length && seasons.length === choice.heldOutSeasons,
      "complete mean evidence seasons",
    );
    function convergence(strategy: FirstPartyRosStrategy): PointConvergenceSupport {
      const evidence = seasons.map((season) => {
        const key = `${cell}:${strategy}:${season}`;
        const row = rows.get(key);
        requireValue(row, "missing convergence stratum");
        rows.delete(key);
        return row;
      });
      const converged = evidence.filter((row) => row.pointConverged).length;
      return {
        samples: evidence.length,
        converged,
        rate: converged / evidence.length,
        evidenceChecksum: firstPartyRosPointEvidenceChecksum(evidence),
      };
    }
    const payload = {
      schemaVersion: 1 as const,
      version: FIRST_PARTY_ROS_POINT_QUALIFICATION_VERSION,
      policyVersion: FIRST_PARTY_ROS_POINT_POLICY_VERSION,
      meanPolicyVersion: FIRST_PARTY_ROS_POLICY_VERSION,
      modelVersion: FIRST_PARTY_ROS_MODEL_VERSION,
      calibrationVersion: FIRST_PARTY_ROS_POINT_CALIBRATION_VERSION,
      forecastSeason: input.forecastSeason,
      scoringProfileKey: profile,
      position: choice.position,
      bucket: choice.bucket,
      selectedStrategy: choice.strategy,
      policyChecksum,
      candidateReportChecksum: input.candidateReportChecksum,
      sourceEvidenceChecksum: input.sourceEvidenceChecksum,
      comparisonManifestChecksum: input.comparisonManifestChecksum,
      heldOutEvidenceChecksum: choice.heldOutEvidence.evidenceChecksum!,
      support: { seasons: choice.heldOutSeasons, blocks: choice.batches, samples: choice.samples },
      convergence: {
        contextual: convergence("contextual"),
        recency: convergence("availability-aware-recency"),
      },
      intervalAvailable: false as const,
    };
    const qualification = {
      ...payload,
      evidenceChecksum: firstPartyRosPointEvidenceChecksum(payload),
    };
    requireValue(
      firstPartyRosPointQualificationIsStructurallyValid(qualification),
      "qualification bounds",
    );
    return qualification;
  });
  requireValue(rows.size === 0 && seen.size === 18, "exact convergence population");
  return qualifications;
}

function qualificationMatchesPolicy(
  q: FirstPartyRosPointQualification,
  policy: FirstPartyRosChampionPolicy,
  season: number,
) {
  const choice = policy.choices.find(
    (cell) => cell.position === q.position && cell.bucket === q.bucket,
  );
  return (
    choice !== undefined &&
    q.forecastSeason === season &&
    policy.evidenceThroughSeason !== null &&
    policy.evidenceThroughSeason < season &&
    policy.policyVersion === FIRST_PARTY_ROS_POLICY_VERSION &&
    policy.modelVersion === q.modelVersion &&
    policy.evidenceIdentity?.scoringProfileKey === q.scoringProfileKey &&
    q.policyChecksum === firstPartyRosPointEvidenceChecksum(policy) &&
    q.selectedStrategy === choice.strategy &&
    q.heldOutEvidenceChecksum === choice.heldOutEvidence.evidenceChecksum &&
    q.support.seasons === choice.heldOutSeasons &&
    q.support.blocks === choice.batches &&
    q.support.samples === choice.samples
  );
}

/** Validates structure and immutable bindings, not the authority of the enclosing admission. */
export function firstPartyRosPointArtifactIsConsistent(
  artifact: RosArtifactBlockerContext,
): boolean {
  try {
    const value = artifact.releaseGate.pointForecasts;
    const blockers = artifact.releaseGate.blockers;
    if (
      blockers !== undefined &&
      (!Array.isArray(blockers) ||
        blockers.length > 512 ||
        blockers.some(
          (blocker) => typeof blocker !== "string" || !blocker.trim() || blocker.length > 1024,
        ))
    )
      return false;
    if (
      artifact.policyVersion !== FIRST_PARTY_ROS_POINT_POLICY_VERSION ||
      artifact.calibrationVersion !== FIRST_PARTY_ROS_POINT_CALIBRATION_VERSION ||
      artifact.modelVersion !== FIRST_PARTY_ROS_MODEL_VERSION ||
      artifact.policy.choices.length !== 18 ||
      artifact.policy.evidenceThroughSeason !== artifact.evidenceThroughSeason ||
      artifact.evidenceThroughSeason >= artifact.season ||
      !exactKeys(value, ["schemaVersion", "method", "intervalAvailable", "qualifications"]) ||
      value.schemaVersion !== 1 ||
      value.method !== FIRST_PARTY_ROS_POINT_RELEASE_VERSION ||
      value.intervalAvailable !== false ||
      !Array.isArray(value.qualifications) ||
      value.qualifications.length !== 18
    )
      return false;
    const sources = new Map(
      artifact.sourceChecksums.map((source) => [source.key, source.checksum]),
    );
    if (sources.size !== artifact.sourceChecksums.length) return false;
    const seen = new Set<string>();
    for (const q of value.qualifications) {
      if (
        !firstPartyRosPointQualificationIsStructurallyValid(q) ||
        !qualificationMatchesPolicy(q, artifact.policy, artifact.season) ||
        q.scoringProfileKey !== artifact.scoringProfileKey ||
        q.candidateReportChecksum !== sources.get("point-candidate-report") ||
        q.sourceEvidenceChecksum !== sources.get("point-source-evidence") ||
        q.comparisonManifestChecksum !== sources.get("point-comparison-manifest")
      )
        return false;
      const cell = `${q.position}:${q.bucket}`;
      if (seen.has(cell)) return false;
      seen.add(cell);
    }
    return seen.size === 18;
  } catch {
    return false;
  }
}

export type FirstPartyRosPointReleaseReason =
  | FirstPartyRosReleaseGateReason
  | "invalid-legacy-release-evidence"
  | "invalid-point-qualification"
  | "point-qualification-mismatch"
  | "invalid-point-convergence-evidence"
  | "point-convergence-gate-failed";
export interface FirstPartyRosPointReleaseDecision {
  readonly version: typeof FIRST_PARTY_ROS_POINT_RELEASE_VERSION;
  readonly state: "release" | "withhold";
  readonly strategy: FirstPartyRosStrategy | null;
  readonly reasons: readonly FirstPartyRosPointReleaseReason[];
  readonly evidenceChecksum: string;
  readonly legacyEvidenceChecksum: string | null;
  readonly qualificationChecksum: string | null;
  readonly calibrationArtifactChecksum: null;
  readonly intervalCalibration: typeof FIRST_PARTY_ROS_POINT_CALIBRATION_VERSION;
  readonly intervalAvailable: false;
}
export function evaluateFirstPartyRosPointReleaseGate(input: {
  readonly meanPolicy: FirstPartyRosChampionPolicy;
  readonly live: FirstPartyRosLiveReleaseEvidence;
  readonly expectedForecastSeason: number;
  /** Must be independently authenticated against the immutable admitted artifact. */
  readonly admittedQualification: unknown;
}): FirstPartyRosPointReleaseDecision {
  const reasons = new Set<FirstPartyRosPointReleaseReason>();
  let legacyEvidenceChecksum: string | null = null,
    qualificationChecksum: string | null = null;
  let strategy: FirstPartyRosStrategy | null = null;
  let pointEvidenceChecksum: string | null = null;
  try {
    const legacy = evaluateFirstPartyRosReleaseGate(input.meanPolicy, input.live);
    legacyEvidenceChecksum = legacy.evidenceChecksum;
    for (const reason of legacy.reasons) if (!INTERVAL_REASONS.has(reason)) reasons.add(reason);
  } catch {
    reasons.add("invalid-legacy-release-evidence");
  }
  try {
    const q = input.admittedQualification;
    requireValue(
      firstPartyRosPointQualificationIsStructurallyValid(q),
      "admitted point qualification",
    );
    qualificationChecksum = q.evidenceChecksum;
    if (
      !qualificationMatchesPolicy(q, input.meanPolicy, input.expectedForecastSeason) ||
      q.position !== input.live.position ||
      q.bucket !== input.live.bucket ||
      q.scoringProfileKey !== input.live.scoringProfileKey
    )
      reasons.add("point-qualification-mismatch");
    else {
      strategy = q.selectedStrategy;
      try {
        const full = input.live.pointConvergence;
        requireValue(full, "full live convergence");
        const points = ["contextual", "recency"].map((key) => {
          const candidate = key as "contextual" | "recency";
          const proof = extractFirstPartyRosPointConvergence({
            position: input.live.position,
            scoringProfileKey: input.live.scoringProfileKey,
            diagnostic: full[candidate],
          });
          const legacyDiagnosticChecksum = sha256Hex(
            JSON.stringify({
              version: "live-bounded-ros-convergence-v1",
              seedHash: full[candidate].seedHash,
              lowerScenarioCount: full[candidate].releaseScenarioCount,
              referenceScenarioCount: full[candidate].referenceScenarioCount,
              metrics: full[candidate].metrics.map((metric) => ({
                metric: metric.metric,
                absoluteDifference: metric.absoluteDifference,
                allowed: metric.allowedDifference,
                ratio: metric.toleranceRatio,
              })),
            }),
          );
          requireValue(
            full[candidate].state === input.live.convergence[candidate].state &&
              legacyDiagnosticChecksum === input.live.convergence[candidate].diagnosticChecksum &&
              proof.metrics[0]!.releaseValue ===
                input.live.availability[`${candidate}ExpectedGames`],
            "live convergence values",
          );
          return proof;
        });
        pointEvidenceChecksum = firstPartyRosPointEvidenceChecksum(points);
        const key = strategy === "contextual" ? "contextual" : "recency";
        if (
          points[key === "contextual" ? 0 : 1]!.state === "converged" &&
          q.convergence[key].rate === 1
        )
          reasons.delete("convergence-gate-failed");
        else reasons.add("point-convergence-gate-failed");
      } catch {
        reasons.add("invalid-point-convergence-evidence");
      }
    }
  } catch {
    reasons.add("invalid-point-qualification");
  }
  const ordered = [...reasons].sort();
  return {
    version: FIRST_PARTY_ROS_POINT_RELEASE_VERSION,
    state: ordered.length === 0 && strategy !== null ? "release" : "withhold",
    strategy: ordered.length === 0 ? strategy : null,
    reasons: ordered,
    legacyEvidenceChecksum,
    qualificationChecksum,
    calibrationArtifactChecksum: null,
    intervalCalibration: FIRST_PARTY_ROS_POINT_CALIBRATION_VERSION,
    intervalAvailable: false,
    evidenceChecksum: firstPartyRosPointEvidenceChecksum({
      version: FIRST_PARTY_ROS_POINT_RELEASE_VERSION,
      legacyEvidenceChecksum,
      qualificationChecksum,
      pointEvidenceChecksum,
      expectedForecastSeason: Number.isSafeInteger(input?.expectedForecastSeason)
        ? input.expectedForecastSeason
        : null,
      strategy,
      reasons: ordered,
    }),
  };
}
