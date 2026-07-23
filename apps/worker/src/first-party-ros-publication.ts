import { createHash } from "node:crypto";

import type {
  FirstPartyRosAvailabilitySnapshot,
  FirstPartyRosChampionArtifactSourceChecksum,
} from "@fantasy/db";
import {
  FIRST_PARTY_ROS_INTERVAL_CALIBRATION_VERSION,
  FIRST_PARTY_ROS_MODEL_VERSION,
  FIRST_PARTY_ROS_POLICY_VERSION,
  evaluateFirstPartyRosReleaseGate,
  type FirstPartyRosChampionPolicy,
  type FirstPartyRosLiveReleaseEvidence,
  type FirstPartyRosPosition,
  type FirstPartyRosProjection,
  type FirstPartyRosReleaseGateDecision,
  type FirstPartyRosReleaseGateOptions,
  type FirstPartyRosRemainingWeeksBucket,
  type FirstPartyRosStrategy,
} from "@fantasy/projections";

/**
 * The immutable, checksummed portion of a ROS champion artifact. The stored `artifactChecksum` is a
 * SHA-256 digest over exactly this payload, so any drift in versions, evidence, source lineage, or
 * champion policy invalidates the artifact and forces the rail back to fail-closed shadow behavior.
 */
export interface FirstPartyRosChampionArtifactPayload {
  readonly season: number;
  readonly scoringProfileKey: string;
  readonly modelVersion: string;
  readonly policyVersion: string;
  readonly calibrationVersion: string;
  readonly evidenceThroughSeason: number;
  readonly sourceChecksums: readonly FirstPartyRosChampionArtifactSourceChecksum[];
  readonly policy: FirstPartyRosChampionPolicy;
  readonly releaseGate: Record<string, unknown>;
}

/** A champion artifact as loaded from `first_party_ros_champion_artifacts`. */
export interface LoadedFirstPartyRosChampionArtifact extends FirstPartyRosChampionArtifactPayload {
  readonly artifactChecksum: string;
}

export const FIRST_PARTY_ROS_CHAMPION_ARTIFACT_CHECKSUM_VERSION =
  "first-party-ros-champion-artifact-v1";

function normalizeForChecksum(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeForChecksum);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, candidate]) => [key, normalizeForChecksum(candidate)]),
    );
  }
  return value;
}

/** Canonical checksum over the immutable artifact payload; stable across object key order. */
export function firstPartyRosChampionArtifactChecksum(
  payload: FirstPartyRosChampionArtifactPayload,
): string {
  const normalized = {
    version: FIRST_PARTY_ROS_CHAMPION_ARTIFACT_CHECKSUM_VERSION,
    season: payload.season,
    scoringProfileKey: payload.scoringProfileKey,
    modelVersion: payload.modelVersion,
    policyVersion: payload.policyVersion,
    calibrationVersion: payload.calibrationVersion,
    evidenceThroughSeason: payload.evidenceThroughSeason,
    sourceChecksums: [...payload.sourceChecksums]
      .map((entry) => ({ key: entry.key, checksum: entry.checksum }))
      .sort((left, right) => left.key.localeCompare(right.key)),
    policy: payload.policy,
    releaseGate: payload.releaseGate,
  };
  return createHash("sha256")
    .update(JSON.stringify(normalizeForChecksum(normalized)))
    .digest("hex");
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

/**
 * Fail-closed artifact validity. An artifact authorizes publication only when its checksum
 * recomputes exactly, its model/policy/calibration identities match the running code, its champion
 * policy carries evidence identity, and the scoring-profile identity is internally consistent.
 */
export function firstPartyRosChampionArtifactIsValid(
  artifact: LoadedFirstPartyRosChampionArtifact,
): boolean {
  if (!SHA256_PATTERN.test(artifact.artifactChecksum)) return false;
  if (artifact.artifactChecksum !== firstPartyRosChampionArtifactChecksum(artifact)) return false;
  if (
    artifact.modelVersion !== FIRST_PARTY_ROS_MODEL_VERSION ||
    artifact.policyVersion !== FIRST_PARTY_ROS_POLICY_VERSION ||
    artifact.calibrationVersion !== FIRST_PARTY_ROS_INTERVAL_CALIBRATION_VERSION
  ) {
    return false;
  }
  if (typeof artifact.scoringProfileKey !== "string" || artifact.scoringProfileKey.trim() === "") {
    return false;
  }
  if (
    !Number.isSafeInteger(artifact.season) ||
    !Number.isSafeInteger(artifact.evidenceThroughSeason) ||
    artifact.evidenceThroughSeason > artifact.season
  ) {
    return false;
  }
  if (artifact.sourceChecksums.length === 0) return false;
  if (
    artifact.sourceChecksums.some(
      (entry) =>
        typeof entry.key !== "string" ||
        entry.key.trim() === "" ||
        typeof entry.checksum !== "string" ||
        !SHA256_PATTERN.test(entry.checksum),
    )
  ) {
    return false;
  }
  const policy = artifact.policy;
  if (
    policy.policyVersion !== FIRST_PARTY_ROS_POLICY_VERSION ||
    policy.modelVersion !== FIRST_PARTY_ROS_MODEL_VERSION ||
    policy.evidenceIdentity === null ||
    policy.evidenceIdentity.scoringProfileKey !== artifact.scoringProfileKey ||
    policy.evidenceThroughSeason !== artifact.evidenceThroughSeason
  ) {
    return false;
  }
  return true;
}

export type FirstPartyRosPublicationReason =
  | "ros_champion_artifact_absent"
  | "ros_champion_artifact_invalid"
  | "ros_champion_artifact_scoring_profile_mismatch"
  | "ros_future_window_incomplete"
  | "ros_release_gate_withheld"
  | "ros_admitted_cell_blocker_withheld";

const ARTIFACT_CELL_BLOCKER_PATTERN =
  /^(?:cell|champion|calibration)_(QB|RB|WR|TE|K|DST)_(one-to-four|five-to-eight|nine-plus)_/u;

/**
 * Position:bucket cells the admitted evidence itself marked blocked. Most per-cell blocker
 * families are re-derived from the artifact's policy evidence by the live release gate, but not
 * all (the kicker count-family audit has no policy counterpart), so publication must also honor
 * the blockers recorded in the admitted report verbatim — otherwise "admitted with cell blockers"
 * would release exactly the cells admission promised to withhold.
 */
function admittedCellBlockers(artifact: LoadedFirstPartyRosChampionArtifact): ReadonlySet<string> {
  const cells = new Set<string>();
  const blockers = (artifact.releaseGate as { readonly blockers?: unknown }).blockers;
  if (!Array.isArray(blockers)) return cells;
  for (const blocker of blockers) {
    if (typeof blocker !== "string") continue;
    const match = ARTIFACT_CELL_BLOCKER_PATTERN.exec(blocker);
    if (match) cells.add(`${match[1]}:${match[2]}`);
  }
  return cells;
}

export interface FirstPartyRosBucketDecision {
  readonly position: FirstPartyRosPosition;
  readonly bucket: FirstPartyRosRemainingWeeksBucket;
  readonly state: "release" | "withhold";
  readonly strategy: FirstPartyRosStrategy | null;
  readonly gate: FirstPartyRosReleaseGateDecision;
}

export interface FirstPartyRosPublicationDecision {
  readonly canPublish: boolean;
  readonly artifactValid: boolean;
  readonly scoringProfileMatches: boolean;
  readonly futureWindowComplete: boolean;
  readonly reasons: readonly FirstPartyRosPublicationReason[];
  readonly buckets: readonly FirstPartyRosBucketDecision[];
  readonly releasingBuckets: readonly FirstPartyRosBucketDecision[];
  /**
   * True whenever the last good published ROS set must remain authoritative: no artifact, an
   * invalid or mismatched artifact, an incomplete future window, or any bucket that withheld.
   */
  readonly preservePriorGoodSet: boolean;
}

/**
 * Fail-closed publication decision. With no persisted artifact the result is byte-for-byte the
 * shadow outcome (cannot publish, preserve the prior good set). Publication becomes possible only
 * when the artifact validates, its scoring-profile identity matches the league exactly, the future
 * window is complete, and the live release gate returns "release" for a position/bucket.
 */
export function evaluateFirstPartyRosPublication(input: {
  readonly artifact: LoadedFirstPartyRosChampionArtifact | null;
  readonly leagueScoringProfileKey: string;
  readonly evidence: readonly FirstPartyRosLiveReleaseEvidence[];
  readonly futureWindowComplete: boolean;
  readonly gateOptions?: FirstPartyRosReleaseGateOptions;
}): FirstPartyRosPublicationDecision {
  const reasons = new Set<FirstPartyRosPublicationReason>();
  if (input.artifact === null) {
    reasons.add("ros_champion_artifact_absent");
    return {
      canPublish: false,
      artifactValid: false,
      scoringProfileMatches: false,
      futureWindowComplete: input.futureWindowComplete,
      reasons: [...reasons],
      buckets: [],
      releasingBuckets: [],
      preservePriorGoodSet: true,
    };
  }
  const artifactValid = firstPartyRosChampionArtifactIsValid(input.artifact);
  if (!artifactValid) reasons.add("ros_champion_artifact_invalid");
  const scoringProfileMatches =
    artifactValid && input.artifact.scoringProfileKey === input.leagueScoringProfileKey;
  if (artifactValid && !scoringProfileMatches) {
    reasons.add("ros_champion_artifact_scoring_profile_mismatch");
  }
  if (!input.futureWindowComplete) reasons.add("ros_future_window_incomplete");

  const eligible = artifactValid && scoringProfileMatches && input.futureWindowComplete;
  const blockedCells = eligible ? admittedCellBlockers(input.artifact) : new Set<string>();
  let blockedCellWithheld = false;
  const buckets: FirstPartyRosBucketDecision[] = eligible
    ? input.evidence.map((live) => {
        const gate = evaluateFirstPartyRosReleaseGate(
          input.artifact!.policy,
          live,
          input.gateOptions,
        );
        // The admitted report's own cell blockers override a releasing gate; the gate decision is
        // preserved unmodified for observability.
        const blocked = blockedCells.has(`${live.position}:${live.bucket}`);
        if (blocked && gate.state === "release") blockedCellWithheld = true;
        return {
          position: live.position,
          bucket: live.bucket,
          state: blocked ? "withhold" : gate.state,
          strategy: gate.strategy,
          gate,
        };
      })
    : [];
  const releasingBuckets = buckets.filter((decision) => decision.state === "release");
  if (buckets.some((decision) => decision.state === "withhold")) {
    reasons.add("ros_release_gate_withheld");
  }
  if (blockedCellWithheld) reasons.add("ros_admitted_cell_blocker_withheld");
  const canPublish = eligible && releasingBuckets.length > 0;
  const preservePriorGoodSet = !canPublish || releasingBuckets.length < buckets.length;
  return {
    canPublish,
    artifactValid,
    scoringProfileMatches,
    futureWindowComplete: input.futureWindowComplete,
    reasons: [...reasons],
    buckets,
    releasingBuckets,
    preservePriorGoodSet,
  };
}

const ROS_SUMMARY_MAXIMUM_SCENARIOS = 4_096;

function round(value: number, digits: number): string {
  if (!Number.isFinite(value)) throw new RangeError("ROS numeric value must be finite");
  return value.toFixed(digits);
}

/** A released player whose selected-strategy projection cleared the live release gate. */
export interface FirstPartyRosReleasedPlayer {
  readonly playerId: string;
  readonly bucket: FirstPartyRosRemainingWeeksBucket;
  readonly strategy: FirstPartyRosStrategy;
  readonly projection: FirstPartyRosProjection;
}

export interface FirstPartyRosPlayerPersistenceRow {
  readonly playerId: string;
  readonly playerProjection: {
    readonly meanPoints: string;
    readonly floorPoints: string;
    readonly ceilingPoints: string;
    readonly components: Record<string, number>;
  };
  readonly summary: {
    readonly scheduledGames: number;
    readonly expectedGames: string;
    readonly aggregateMeanPoints: string;
    readonly p15Points: string;
    readonly p50Points: string;
    readonly p85Points: string;
    readonly meanPointsPerExpectedGame: string | null;
    readonly pointsStddev: string;
    readonly availability: FirstPartyRosAvailabilitySnapshot;
    readonly scenarioCount: number;
    readonly methodVersion: string;
    readonly seedHash: string;
  };
}

/**
 * Reconciles one released player's simulation into the exact numeric shapes the append-only ROS
 * persistence invariants require: `player_projections` mean/floor/ceiling equal the summary
 * aggregate/p15/p85, the availability snapshot sums to expected games, and every quantile is
 * ordered. Throws (fail-closed) rather than emitting an unpublishable or unavailable row.
 */
export function buildFirstPartyRosPlayerPersistenceRow(
  player: FirstPartyRosReleasedPlayer,
): FirstPartyRosPlayerPersistenceRow {
  const projection = player.projection;
  if (projection.state !== "projected" || projection.expectedGames <= 0) {
    throw new RangeError("Only projected players with positive expected games can be persisted");
  }
  const scenarioCount = projection.provenance.scenarioCount;
  if (
    !Number.isSafeInteger(scenarioCount) ||
    scenarioCount < 128 ||
    scenarioCount > ROS_SUMMARY_MAXIMUM_SCENARIOS
  ) {
    throw new RangeError(
      `Released ROS scenario count must be between 128 and ${ROS_SUMMARY_MAXIMUM_SCENARIOS}`,
    );
  }
  if (projection.p15Points > projection.p50Points || projection.p50Points > projection.p85Points) {
    throw new RangeError("Released ROS quantiles must be ordered P15 <= P50 <= P85");
  }
  const expectedGames = round(projection.expectedGames, 6);
  const aggregateMeanPoints = round(projection.meanPoints, 3);
  const meanPointsPerExpectedGame = round(Number(aggregateMeanPoints) / Number(expectedGames), 6);
  const availability: FirstPartyRosAvailabilitySnapshot = {
    schemaVersion: 1,
    semantics: "unconditional-active-probability",
    weeks: projection.weekly.map((week) => ({
      week: week.week,
      scheduled: week.scheduled,
      bye: week.bye,
      availabilityProbability: week.availabilityProbability,
    })),
  };
  return {
    playerId: player.playerId,
    playerProjection: {
      meanPoints: aggregateMeanPoints,
      floorPoints: round(projection.p15Points, 3),
      ceilingPoints: round(projection.p85Points, 3),
      components: projection.expectedComponents,
    },
    summary: {
      scheduledGames: projection.scheduledGames,
      expectedGames,
      aggregateMeanPoints,
      p15Points: round(projection.p15Points, 3),
      p50Points: round(projection.p50Points, 3),
      p85Points: round(projection.p85Points, 3),
      meanPointsPerExpectedGame,
      pointsStddev: round(projection.standardDeviation, 3),
      availability,
      scenarioCount,
      methodVersion: FIRST_PARTY_ROS_MODEL_VERSION,
      seedHash: projection.provenance.seedHash,
    },
  };
}

export interface FirstPartyRosRunConvergence {
  readonly state: "converged" | "unstable";
  readonly lowerScenarioCount: number;
  readonly referenceScenarioCount: number;
  readonly maxToleranceRatio: number;
  readonly diagnosticChecksum: string;
}

/**
 * Builds the immutable model-run `calibration` and `metrics` jsonb for a released ROS run so it
 * satisfies the 0016 ROS-summary scope trigger: a calibrated `rosIntervals` block and a passing
 * `rosConvergence` diagnostic, both keyed to the admitted champion evidence.
 */
export function buildFirstPartyRosRunPayload(input: {
  readonly artifact: LoadedFirstPartyRosChampionArtifact;
  readonly decision: FirstPartyRosPublicationDecision;
  readonly convergence: FirstPartyRosRunConvergence;
  readonly orchestrationVersion: string;
  readonly extraConfiguration?: Record<string, unknown>;
}): {
  readonly configuration: Record<string, unknown>;
  readonly calibration: Record<string, unknown>;
  readonly metrics: Record<string, unknown>;
} {
  const policy = input.artifact.policy;
  const releasing = input.decision.releasingBuckets;
  const observedCoverages = releasing.flatMap((decision) => {
    const choice = policy.choices.find(
      (candidate) =>
        candidate.position === decision.position && candidate.bucket === decision.bucket,
    );
    if (!choice) return [];
    const selected = choice.strategy === "contextual" ? "contextual" : "recency";
    return [
      selected === "contextual"
        ? choice.heldOutEvidence.contextualObservedIntervalCoverage
        : choice.heldOutEvidence.recencyObservedIntervalCoverage,
    ];
  });
  const empiricalCoverage =
    observedCoverages.length === 0
      ? 0.7
      : observedCoverages.reduce((sum, value) => sum + value, 0) / observedCoverages.length;
  const evidenceChecksum =
    releasing[0]?.gate.evidenceChecksum ??
    createHash("sha256").update(input.artifact.artifactChecksum).digest("hex");
  return {
    configuration: {
      mode: "release",
      simulationModelVersion: FIRST_PARTY_ROS_MODEL_VERSION,
      orchestrationVersion: input.orchestrationVersion,
      policyVersion: FIRST_PARTY_ROS_POLICY_VERSION,
      calibrationVersion: FIRST_PARTY_ROS_INTERVAL_CALIBRATION_VERSION,
      championArtifactChecksum: input.artifact.artifactChecksum,
      scoringProfileKey: input.artifact.scoringProfileKey,
      releasingBuckets: releasing.map((decision) => ({
        position: decision.position,
        bucket: decision.bucket,
        strategy: decision.strategy,
      })),
      ...input.extraConfiguration,
    },
    calibration: {
      state: "calibrated",
      rosIntervals: {
        schemaVersion: 1,
        state: "calibrated",
        method: FIRST_PARTY_ROS_INTERVAL_CALIBRATION_VERSION,
        evidenceChecksum,
        heldOutSeasons: policy.globalSeasons,
        batches: policy.globalBatches,
        samples: policy.globalSamples,
        nominalCoverage: 0.7,
        empiricalCoverage,
        maximumAllowedCoverageError: 0.1,
      },
    },
    metrics: {
      rosConvergence: {
        schemaVersion: 1,
        state: input.convergence.state,
        method: "live-bounded-ros-convergence-v1",
        evidenceChecksum: input.convergence.diagnosticChecksum,
        lowerScenarioCount: input.convergence.lowerScenarioCount,
        referenceScenarioCount: input.convergence.referenceScenarioCount,
        maxToleranceRatio: input.convergence.maxToleranceRatio,
      },
      releasingBuckets: releasing.length,
      withheldReasons: input.decision.reasons,
    },
  };
}
