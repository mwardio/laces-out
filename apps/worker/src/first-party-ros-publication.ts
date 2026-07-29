import { createHash } from "node:crypto";

import type {
  FirstPartyRosAvailabilitySnapshot,
  FirstPartyRosChampionArtifactSourceChecksum,
} from "@fantasy/db";
import {
  FIRST_PARTY_ROS_INTERVAL_CALIBRATION_VERSION,
  FIRST_PARTY_ROS_MAXIMUM_SCENARIOS,
  FIRST_PARTY_ROS_MINIMUM_SCENARIOS,
  FIRST_PARTY_ROS_MODEL_VERSION,
  FIRST_PARTY_ROS_POLICY_VERSION,
  evaluateFirstPartyRosReleaseGate,
  projectionScoringProfileKeyForPosition,
  projectionScoringRulesFromProfileKey,
  type FirstPartyRosChampionPolicy,
  type FirstPartyRosLiveReleaseEvidence,
  type FirstPartyRosPosition,
  type FirstPartyRosProjection,
  type FirstPartyRosReleaseGateDecision,
  type FirstPartyRosReleaseGateOptions,
  type FirstPartyRosRemainingWeeksBucket,
  type FirstPartyRosStrategy,
  type ProjectionScoringProfile,
} from "@fantasy/projections";

import { HISTORICAL_ROS_SUPPORTED_POSITIONS } from "./first-party-ros-backtest.js";

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
  /**
   * Admission time, used only to pick the latest artifact within one scoring profile. It is not
   * part of the payload the checksum covers, so it is optional for callers that never compare.
   */
  readonly admittedAt?: Date | undefined;
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

/**
 * A position the ROS release rail models. D/ST is deliberately absent: the rail has no D/ST
 * product surface, so a D/ST rule can neither authorize nor block anything published here.
 */
export type FirstPartyRosRailPosition = (typeof HISTORICAL_ROS_SUPPORTED_POSITIONS)[number];

const FIRST_PARTY_ROS_BUCKETS: readonly FirstPartyRosRemainingWeeksBucket[] = [
  "one-to-four",
  "five-to-eight",
  "nine-plus",
];

/**
 * Why one position was withheld from a league before any player was simulated. The cases are kept
 * distinct because they are different operator actions: fix the league's unsupported rules, admit
 * an artifact under the league's own profile, repair a corrupt artifact row, or repair the caller
 * that supplied an unscoreable league profile.
 */
export type FirstPartyRosPositionWithholdReason =
  | "position-unsupported"
  | "scoring-profile-position-mismatch"
  | "artifact-scoring-profile-key-unreadable"
  | "league-scoring-profile-invalid";

/**
 * Cell-level superset. A cell can additionally be withheld for a position this rail does not model
 * at all, which no `FirstPartyRosWithheldPosition` can express because that type is rail-scoped.
 */
export type FirstPartyRosCellWithholdReason =
  FirstPartyRosPositionWithholdReason | "position-not-on-ros-rail";

export interface FirstPartyRosWithheldPosition {
  readonly position: FirstPartyRosRailPosition;
  readonly reason: FirstPartyRosPositionWithholdReason;
}

export interface FirstPartyRosPositionMatch {
  readonly matched: readonly FirstPartyRosRailPosition[];
  readonly withheld: readonly FirstPartyRosWithheldPosition[];
}

function everyRailPositionWithheld(
  reason: FirstPartyRosPositionWithholdReason,
): FirstPartyRosPositionMatch {
  return {
    matched: [],
    withheld: HISTORICAL_ROS_SUPPORTED_POSITIONS.map((position) => ({ position, reason })),
  };
}

/**
 * The per-position matching gate. A league may receive position P from an admitted artifact only
 * when league-scoring normalization supports P AND the position-scoped scoring keys are byte-equal.
 *
 * Positions never interact numerically — a rule outside P's component vocabulary contributes
 * exactly 0 to P's score — so byte-equal position subsets mean byte-identical scoring behavior for
 * P, which is what the artifact's held-out evidence for P was measured under. Matching stays exact
 * string equality: there is no nearest-match, no tolerance, and no widening, so a league paying 5
 * for a 50-59 field goal and 6 for 60+ does not match a catalog that pays 5 for 50+.
 *
 * Neither side's scoring profile can throw out of this function: a stored artifact key that is not
 * the canonical JSON it is defined to be, and a league profile that is not a valid scoring profile,
 * are both corrupt rather than merely unmatched, and refuse every position with their own reason.
 */
export function matchFirstPartyRosPositions(input: {
  readonly artifactScoringProfileKey: string;
  readonly leagueScoringProfile: ProjectionScoringProfile;
  readonly supportedPositions: readonly FirstPartyRosRailPosition[];
}): FirstPartyRosPositionMatch {
  let artifactProfile: ProjectionScoringProfile;
  try {
    artifactProfile = firstPartyRosArtifactScoringProfile(input.artifactScoringProfileKey);
  } catch {
    return everyRailPositionWithheld("artifact-scoring-profile-key-unreadable");
  }

  const supported = new Set<string>(input.supportedPositions);
  const matched: FirstPartyRosRailPosition[] = [];
  const withheld: FirstPartyRosWithheldPosition[] = [];
  try {
    for (const position of HISTORICAL_ROS_SUPPORTED_POSITIONS) {
      if (!supported.has(position)) {
        withheld.push({ position, reason: "position-unsupported" });
        continue;
      }
      const leagueKey = projectionScoringProfileKeyForPosition(
        input.leagueScoringProfile,
        position,
      );
      // A position league-scoring normalization reports as supported always prices something in
      // its own vocabulary, so an empty league-side subset means the caller's `supportedPositions`
      // disagrees with the profile it handed us. Two empty subsets are not evidence of identical
      // scoring, so `"[]" === "[]"` is never read as a match
      // (`packages/projections/src/scoring-position-keys.ts` states this requirement).
      if (leagueKey === "[]") {
        withheld.push({ position, reason: "position-unsupported" });
        continue;
      }
      if (leagueKey !== projectionScoringProfileKeyForPosition(artifactProfile, position)) {
        withheld.push({ position, reason: "scoring-profile-position-mismatch" });
        continue;
      }
      matched.push(position);
    }
  } catch {
    // Only the league profile can throw here: the artifact profile was proved valid by the round
    // trip inside `projectionScoringRulesFromProfileKey` above.
    return everyRailPositionWithheld("league-scoring-profile-invalid");
  }
  return { matched, withheld };
}

/**
 * The scoring profile every league-independent calibration for one artifact is fitted under: the
 * artifact's own, recovered from the key that IS its identity. It is deterministic and exact with
 * respect to the artifact, unlike any single matched league's profile, which per-position matching
 * makes an approximation for every other matched league.
 *
 * A position this profile prices nothing for can never be matched by any league — a supported
 * position's league-side scoped key is never `"[]"`, so it cannot equal this profile's empty one —
 * so a calibration that is degenerate for such a position can never reach a released player.
 */
export function firstPartyRosArtifactScoringProfile(
  artifactScoringProfileKey: string,
): ProjectionScoringProfile {
  return {
    id: "admitted-ros-artifact",
    rules: projectionScoringRulesFromProfileKey(artifactScoringProfileKey),
  };
}

export type FirstPartyRosPublicationReason =
  | "ros_champion_artifact_absent"
  | "ros_champion_artifact_invalid"
  | "ros_champion_artifact_scoring_profile_mismatch"
  | "ros_scoring_profile_position_withheld"
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
  /**
   * Set when position matching, not the live gate, is what withheld this cell. Every forced
   * withhold states its reason, including a cell for a position this rail does not model.
   */
  readonly positionReason?: FirstPartyRosCellWithholdReason;
}

export interface FirstPartyRosPublicationDecision {
  readonly canPublish: boolean;
  readonly artifactValid: boolean;
  readonly scoringProfileMatches: boolean;
  readonly futureWindowComplete: boolean;
  readonly reasons: readonly FirstPartyRosPublicationReason[];
  readonly buckets: readonly FirstPartyRosBucketDecision[];
  readonly releasingBuckets: readonly FirstPartyRosBucketDecision[];
  /** Positions this league may not receive from this artifact, each with its stated reason. */
  readonly withheldPositions: readonly FirstPartyRosWithheldPosition[];
  /**
   * True whenever the last good published ROS set must remain authoritative: no artifact, an
   * invalid or mismatched artifact, an incomplete future window, any bucket that withheld, or any
   * position withheld before it could produce a bucket.
   */
  readonly preservePriorGoodSet: boolean;
}

/**
 * The two inputs the publication layer needs to re-derive the per-position match for itself. It is
 * deliberately NOT the already-computed match: the candidate provider gates on the same rule, and
 * publication re-checking it here is the same redundancy the whole-key gate has always had.
 */
export interface FirstPartyRosPositionMatchingInput {
  /** The league's normalized scoring profile — the profile its candidates were scored under. */
  readonly leagueScoringProfile: ProjectionScoringProfile;
  /** The rail positions league-scoring normalization reported supported for this league. */
  readonly supportedPositions: readonly FirstPartyRosRailPosition[];
}

/**
 * Fail-closed publication decision. With no persisted artifact the result is byte-for-byte the
 * shadow outcome (cannot publish, preserve the prior good set). Publication becomes possible only
 * when the artifact validates, its scoring-profile identity matches the league, the future window
 * is complete, and the live release gate returns "release" for a position/bucket.
 *
 * Scoring identity is matched per position when `positionMatching` is supplied: the league keeps
 * exactly the positions whose scoped keys are byte-equal to the artifact's and that normalization
 * supports, and every other position is withheld with a stated reason. Without it the gate is the
 * whole-profile identity — strictly narrower, since equal whole keys imply equal position keys —
 * so a target built without per-position inputs can never over-release.
 */
export function evaluateFirstPartyRosPublication(input: {
  readonly artifact: LoadedFirstPartyRosChampionArtifact | null;
  readonly leagueScoringProfileKey: string;
  readonly evidence: readonly FirstPartyRosLiveReleaseEvidence[];
  readonly futureWindowComplete: boolean;
  readonly gateOptions?: FirstPartyRosReleaseGateOptions;
  readonly positionMatching?: FirstPartyRosPositionMatchingInput;
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
      withheldPositions: [],
      preservePriorGoodSet: true,
    };
  }
  const artifactValid = firstPartyRosChampionArtifactIsValid(input.artifact);
  if (!artifactValid) reasons.add("ros_champion_artifact_invalid");
  const positionMatch =
    !artifactValid || input.positionMatching === undefined
      ? null
      : matchFirstPartyRosPositions({
          artifactScoringProfileKey: input.artifact.scoringProfileKey,
          leagueScoringProfile: input.positionMatching.leagueScoringProfile,
          supportedPositions: input.positionMatching.supportedPositions,
        });
  const scoringProfileMatches =
    artifactValid &&
    (positionMatch === null
      ? input.artifact.scoringProfileKey === input.leagueScoringProfileKey
      : positionMatch.matched.length > 0);
  if (artifactValid && !scoringProfileMatches) {
    reasons.add("ros_champion_artifact_scoring_profile_mismatch");
  }
  if (positionMatch !== null && positionMatch.withheld.length > 0) {
    reasons.add("ros_scoring_profile_position_withheld");
  }
  if (!input.futureWindowComplete) reasons.add("ros_future_window_incomplete");

  const eligible = artifactValid && scoringProfileMatches && input.futureWindowComplete;
  const blockedCells = eligible ? admittedCellBlockers(input.artifact) : new Set<string>();
  const matchedPositions = positionMatch === null ? null : new Set<string>(positionMatch.matched);
  const withheldPositionReasons = new Map<string, FirstPartyRosPositionWithholdReason>(
    (positionMatch?.withheld ?? []).map((entry) => [entry.position, entry.reason]),
  );
  let blockedCellWithheld = false;
  const buckets: FirstPartyRosBucketDecision[] = eligible
    ? input.evidence.map((live) => {
        const gate = evaluateFirstPartyRosReleaseGate(
          input.artifact!.policy,
          live,
          input.gateOptions,
        );
        // The admitted report's own cell blockers and the per-position match both override a
        // releasing gate; the gate decision is preserved unmodified for observability.
        const blocked = blockedCells.has(`${live.position}:${live.bucket}`);
        // A cell for a position outside the matched set is forced to withhold with a stated
        // reason. `matchedPositions` only ever holds rail positions, so a D/ST cell — which this
        // rail's provider cannot produce, but a hand-built target could — is withheld as off-rail
        // rather than silently.
        const positionReason =
          matchedPositions === null || matchedPositions.has(live.position)
            ? undefined
            : (withheldPositionReasons.get(live.position) ?? "position-not-on-ros-rail");
        if (blocked && gate.state === "release") blockedCellWithheld = true;
        return {
          position: live.position,
          bucket: live.bucket,
          state: blocked || positionReason !== undefined ? "withhold" : gate.state,
          strategy: gate.strategy,
          gate,
          ...(positionReason === undefined ? {} : { positionReason }),
        };
      })
    : [];
  const releasingBuckets = buckets.filter((decision) => decision.state === "release");
  if (buckets.some((decision) => decision.state === "withhold")) {
    reasons.add("ros_release_gate_withheld");
  }
  if (blockedCellWithheld) reasons.add("ros_admitted_cell_blocker_withheld");
  const withheldPositions = positionMatch?.withheld ?? [];
  const canPublish = eligible && releasingBuckets.length > 0;
  const preservePriorGoodSet =
    !canPublish || releasingBuckets.length < buckets.length || withheldPositions.length > 0;
  return {
    canPublish,
    artifactValid,
    scoringProfileMatches,
    futureWindowComplete: input.futureWindowComplete,
    reasons: [...reasons],
    buckets,
    releasingBuckets,
    withheldPositions,
    preservePriorGoodSet,
  };
}

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
  // The persisted bound is the engine's own admissible path range, imported rather than restated,
  // so the standard 12288-path release persists and any out-of-contract count still fails closed
  // here before it can reach the equally derived `player_ros_projection_summaries` check.
  const scenarioCount = projection.provenance.scenarioCount;
  if (
    !Number.isSafeInteger(scenarioCount) ||
    scenarioCount < FIRST_PARTY_ROS_MINIMUM_SCENARIOS ||
    scenarioCount > FIRST_PARTY_ROS_MAXIMUM_SCENARIOS
  ) {
    throw new RangeError(
      `Released ROS scenario count must be between ${FIRST_PARTY_ROS_MINIMUM_SCENARIOS} and ${FIRST_PARTY_ROS_MAXIMUM_SCENARIOS}`,
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

interface FirstPartyRosCellDecision {
  readonly position: FirstPartyRosPosition;
  readonly bucket: FirstPartyRosRemainingWeeksBucket;
  readonly state: "release" | "withhold";
  readonly reasons: readonly string[];
}

/**
 * Every cell the run decided, in evaluated-then-withheld order so a truncating reader keeps the
 * cells that actually produced players. The rail's own partition is 5 positions x 3 buckets = 15
 * cells; the API's cap is 18 because its position set includes D/ST, and an evaluated D/ST cell can
 * only ever displace a rail cell that is already evaluated, so the total stays within that cap.
 */
function buildFirstPartyRosCellDecisions(
  decision: FirstPartyRosPublicationDecision,
): readonly FirstPartyRosCellDecision[] {
  const evaluated = decision.buckets.map((bucket) => ({
    position: bucket.position,
    bucket: bucket.bucket,
    state: bucket.state,
    // The position reason is appended last and `deriveCellGates` keeps only the first 16 reasons;
    // the live gate has 12 distinct reason values over a Set, so it can never be crowded out.
    reasons: [
      ...bucket.gate.reasons,
      ...(bucket.positionReason === undefined ? [] : [bucket.positionReason]),
    ],
  }));
  const evaluatedCells = new Set(evaluated.map((cell) => `${cell.position}:${cell.bucket}`));
  const withheld = decision.withheldPositions.flatMap((entry) =>
    FIRST_PARTY_ROS_BUCKETS.filter(
      (bucket) => !evaluatedCells.has(`${entry.position}:${bucket}`),
    ).map((bucket) => ({
      position: entry.position,
      bucket,
      state: "withhold" as const,
      reasons: [entry.reason],
    })),
  );
  return [...evaluated, ...withheld];
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
      // Every cell decision, released and withheld alike, so the read-only status surface can
      // report a mixed release honestly instead of inferring one number from `releasingBuckets`.
      // A position withheld before any player was simulated produces no live evidence and so no
      // gate decision, so its three cells are stated explicitly rather than being absent — an
      // absent cell reads as "not evaluated", which is precisely what it is not.
      cellDecisions: buildFirstPartyRosCellDecisions(input.decision),
      // True when the last good published set must stay authoritative for this league.
      preservePriorGoodSet: input.decision.preservePriorGoodSet,
    },
  };
}

/**
 * Selects the ONE admitted artifact a league may publish under. With the live release gate's
 * evidence identity position-scoped (2026-07-29), two admitted artifacts whose scoped keys agree
 * on some positions could each release sets for the same league; publication must therefore
 * arbitrate to a single artifact per league or the rail double-publishes (WP0 Step 3,
 * `docs/ROS_GATE_AND_DST_PLAN.md`).
 *
 * Recorded tie-break rule (the WP0 Step 3 decision — arbitration is deterministic, and every step
 * is written down rather than left to iteration order):
 *
 * 1. Whole-key equality wins outright; among whole-key matches, the latest `admittedAt` wins —
 *    the pre-existing behavior, and the ONLY behavior when `leagueScoringProfile` and
 *    `supportedPositions` are absent.
 * 2. Otherwise, among artifacts matching at least one supported position via
 *    `matchFirstPartyRosPositions`, the most matched supported positions wins (maximizes the
 *    league's published coverage under a single artifact).
 * 3. Tie: the latest `admittedAt` wins.
 * 4. Tie: the lexicographically greatest `artifactChecksum` wins (pure determinism backstop).
 *
 * A position-scoped key of `"[]"` is never a match — enforced inside
 * `matchFirstPartyRosPositions`. There is still no nearest-match, no default, and no fallback to
 * the only admitted profile: an artifact matching zero supported positions is never selected,
 * because a set scored under a merely similar profile is wrong output rather than degraded output.
 */
export function selectFirstPartyRosArtifactForLeague(input: {
  readonly artifacts: readonly LoadedFirstPartyRosChampionArtifact[];
  readonly leagueScoringProfileKey: string;
  /**
   * Both halves or neither, mirroring `evaluateFirstPartyRosPublication`: matching per position
   * without knowing what normalization supports could select on a position the league cannot
   * actually be scored for. When either is absent, selection is whole-key only (rule 1).
   */
  readonly leagueScoringProfile?: ProjectionScoringProfile;
  readonly supportedPositions?: readonly FirstPartyRosRailPosition[];
}): LoadedFirstPartyRosChampionArtifact | null {
  let selected: LoadedFirstPartyRosChampionArtifact | null = null;
  for (const artifact of input.artifacts) {
    if (artifact.scoringProfileKey !== input.leagueScoringProfileKey) continue;
    if (selected === null || admittedTime(artifact) > admittedTime(selected)) {
      selected = artifact;
    }
  }
  if (selected !== null) return selected;
  if (input.leagueScoringProfile === undefined || input.supportedPositions === undefined) {
    return null;
  }
  let selectedMatchCount = 0;
  for (const artifact of input.artifacts) {
    const match = matchFirstPartyRosPositions({
      artifactScoringProfileKey: artifact.scoringProfileKey,
      leagueScoringProfile: input.leagueScoringProfile,
      supportedPositions: input.supportedPositions,
    });
    if (match.matched.length === 0) continue;
    const wins =
      selected === null ||
      match.matched.length > selectedMatchCount ||
      (match.matched.length === selectedMatchCount &&
        (admittedTime(artifact) > admittedTime(selected) ||
          (admittedTime(artifact) === admittedTime(selected) &&
            artifact.artifactChecksum > selected.artifactChecksum)));
    if (wins) {
      selected = artifact;
      selectedMatchCount = match.matched.length;
    }
  }
  return selected;
}

function admittedTime(artifact: LoadedFirstPartyRosChampionArtifact): number {
  return artifact.admittedAt instanceof Date ? artifact.admittedAt.getTime() : 0;
}
