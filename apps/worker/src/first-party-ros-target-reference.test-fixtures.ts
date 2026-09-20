/** Frozen f178df7 live target builder: independent output oracle for compute elimination. */
import { createHash } from "node:crypto";
import {
  fitFirstPartyDefenseGameCalibration,
  FIRST_PARTY_ROS_POINT_POLICY_VERSION,
  extractFirstPartyRosPointConvergence,
  projectionScoringProfileKey,
  projectFirstPartyRestOfSeason,
  type FirstPartyProjectionPosition,
  type FirstPartyRosProjectionInput,
  type FirstPartyRosLiveReleaseEvidence,
} from "@laces-out/projections";
import {
  assembleFirstPartyRosCandidateInputs,
  assembleFirstPartyRosDefenseCandidateInputs,
  buildFirstPartyRosLiveReleaseEvidence,
  diagnoseBoundedFirstPartyRosConvergence,
  simulateFirstPartyRosCandidate,
  validateFirstPartyRosLiveConvergenceCounts,
  type FirstPartyRosAssembledCandidateInputs,
  type FirstPartyRosCandidate,
} from "./first-party-ros-candidates.js";
import type {
  FirstPartyRosRunConvergence,
  FirstPartyRosRailPosition,
  FirstPartyRosReleasedPlayer,
} from "./first-party-ros-publication.js";
import type {
  FirstPartyRosLiveProjection,
  FirstPartyRosLiveProjector,
} from "./ros-live-projection.js";
import type {
  FirstPartyRosLeagueTargetInput,
  FirstPartyRosCandidatePlayer,
  FirstPartyRosLeagueTargetResult,
} from "./first-party-ros-candidate-provider.js";
interface AcceptedCandidate {
  readonly candidate: FirstPartyRosCandidate;
  readonly assembled: FirstPartyRosAssembledCandidateInputs;
  readonly released: FirstPartyRosReleasedPlayer;
}
function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function aggregateChecksum(kind: string, members: readonly string[]): string {
  return sha256(JSON.stringify({ kind, members: [...members].sort() }));
}

function normalizePosition(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (normalized === "HB" || normalized === "FB") return "RB";
  if (normalized === "PK") return "K";
  if (normalized === "D/ST" || normalized === "DEF") return "DST";
  return normalized;
}

export function legacyRosLeagueTarget(
  input: FirstPartyRosLeagueTargetInput,
  project: FirstPartyRosLiveProjector = projectFirstPartyRestOfSeason,
): FirstPartyRosLeagueTargetResult {
  const steps = firstPartyRosLeagueTargetSteps(input);
  let step = steps.next();
  while (!step.done) step = steps.next(project(step.value));
  return step.value;
}
function* simulateCandidateSteps(
  assembled: FirstPartyRosAssembledCandidateInputs,
): Generator<FirstPartyRosProjectionInput, FirstPartyRosCandidate, FirstPartyRosLiveProjection> {
  const contextual = yield assembled.contextualInput;
  const recency = yield assembled.recencyInput;
  return simulateFirstPartyRosCandidate(assembled, (input) =>
    input.strategy === "contextual" ? contextual : recency,
  );
}

function* firstPartyRosLeagueTargetSteps(
  input: FirstPartyRosLeagueTargetInput,
): Generator<
  FirstPartyRosProjectionInput,
  FirstPartyRosLeagueTargetResult,
  FirstPartyRosLiveProjection
> {
  const convergenceCounts = validateFirstPartyRosLiveConvergenceCounts({
    ...(input.scenarioCount === undefined ? {} : { releaseScenarioCount: input.scenarioCount }),
    ...(input.convergenceReferenceScenarioCount === undefined
      ? {}
      : { referenceScenarioCount: input.convergenceReferenceScenarioCount }),
  });
  const scoringProfileKey = projectionScoringProfileKey(input.scoringProfile);
  const window = {
    season: input.season,
    asOfWeek: input.window.asOfWeek,
    windowStartWeek: input.window.windowStartWeek,
    windowEndWeek: input.window.windowEndWeek,
  } as const;

  let skippedPlayers = input.unmatchedCandidateCount;
  const skippedCandidates: {
    playerId: string | null;
    externalPlayerId: string | null;
    position: string;
    reason: string;
  }[] = (input.unmatchedCandidates ?? []).slice(0, 20).map((candidate) => ({
    playerId: null,
    externalPlayerId: candidate.externalPlayerId,
    position: candidate.positions.join("|"),
    reason: "identity-unresolved",
  }));
  const skip = (player: FirstPartyRosCandidatePlayer, reason: string) => {
    skippedPlayers += 1;
    if (skippedCandidates.length < 20)
      skippedCandidates.push({
        playerId: player.playerId,
        externalPlayerId: null,
        position: player.position,
        reason,
      });
  };
  let expectedPlayers = input.unmatchedCandidateCount;
  const accepted: AcceptedCandidate[] = [];
  const seenPlayers = new Set<string>();
  // A position the artifact does not authorize for this league never becomes a candidate, so it is
  // withheld structurally rather than filtered out later; it is not an audited per-player skip
  // because nothing about the player was missing.
  const releasablePositions = new Set<string>(input.matchedPositions);
  // This target owns one pinned history snapshot. Reuse its prior-season fit locally, including
  // an insufficient-history result, without assuming caller-owned array identities are immutable.
  let defenseGameCalibration: ReturnType<typeof fitFirstPartyDefenseGameCalibration> | undefined;
  for (const player of input.candidatePlayers) {
    const position = normalizePosition(player.position);
    if (!releasablePositions.has(position) || player.team === null) continue;
    if (seenPlayers.has(player.playerId)) continue;
    seenPlayers.add(player.playerId);
    expectedPlayers += 1;

    if (position === "DST") {
      defenseGameCalibration ??= fitFirstPartyDefenseGameCalibration(
        input.defenseFeatureHistory,
        input.season,
      );
      const assembled = assembleFirstPartyRosDefenseCandidateInputs({
        defense: { playerId: player.playerId, team: player.team },
        window,
        featureHistory: input.defenseFeatureHistory,
        calibration: input.defenseCalibration,
        preparedGameCalibration: defenseGameCalibration,
        schedules: input.schedules,
        scoringProfile: input.scoringProfile,
        seed: `live-ros-football:${input.season}:${window.asOfWeek}:${player.playerId}`,
        asOfAt: input.asOfAt.toISOString(),
        ...(input.scenarioCount === undefined ? {} : { scenarioCount: input.scenarioCount }),
      });
      if (assembled === null) {
        skip(player, "candidate-inputs-unavailable");
        continue;
      }
      const candidate = yield* simulateCandidateSteps(assembled);
      const choice = input.artifact.policy.choices.find(
        (candidate_) =>
          candidate_.position === candidate.position && candidate_.bucket === candidate.bucket,
      );
      if (choice === undefined) {
        skip(player, "champion-choice-missing");
        continue;
      }
      const projection =
        choice.strategy === "contextual" ? candidate.contextual : candidate.recency;
      if (projection.state !== "projected" || projection.expectedGames <= 0) {
        skip(
          player,
          projection.state !== "projected" ? "projection-unavailable" : "no-expected-games",
        );
        continue;
      }
      accepted.push({
        candidate,
        assembled,
        released: {
          playerId: player.playerId,
          bucket: candidate.bucket,
          strategy: choice.strategy,
          projection,
        },
      });
      continue;
    }

    const builderInput = {
      player: {
        playerId: player.playerId,
        position: position as FirstPartyProjectionPosition,
        team: player.team,
        ...(player.rosterStatus === undefined ? {} : { rosterStatus: player.rosterStatus }),
      },
      window,
      featureHistory: input.featureHistory,
      calibration: input.calibration,
      availabilityCalibration: input.availabilityCalibration,
      roleCalibration: input.roleCalibration,
      kickerCalibration: input.kickerCalibration,
      injuries: input.injuries,
      schedules: input.schedules,
      scoringProfile: input.scoringProfile,
      seed: `live-ros-football:${input.season}:${window.asOfWeek}:${player.playerId}`,
      asOfAt: input.asOfAt.toISOString(),
      ...(input.scenarioCount === undefined ? {} : { scenarioCount: input.scenarioCount }),
    };

    // Assembled ONCE per player and reused for the simulation, the bucket evidence, and the bucket
    // convergence diagnostic. Assembly re-projects every remaining week's weekly centers, and the
    // pipeline previously performed it twice for every accepted player.
    const assembled = assembleFirstPartyRosCandidateInputs(builderInput);
    if (assembled === null) {
      skip(player, "candidate-inputs-unavailable");
      continue;
    }
    const candidate = yield* simulateCandidateSteps(assembled);
    // The champion policy authorizes exactly one strategy per position/bucket; without a matching
    // choice the player cannot be released (no default, no approximation).
    const choice = input.artifact.policy.choices.find(
      (candidate_) =>
        candidate_.position === candidate.position && candidate_.bucket === candidate.bucket,
    );
    if (choice === undefined) {
      skip(player, "champion-choice-missing");
      continue;
    }
    const projection = choice.strategy === "contextual" ? candidate.contextual : candidate.recency;
    if (projection.state !== "projected" || projection.expectedGames <= 0) {
      skip(
        player,
        projection.state !== "projected" ? "projection-unavailable" : "no-expected-games",
      );
      continue;
    }
    accepted.push({
      candidate,
      assembled,
      released: {
        playerId: player.playerId,
        bucket: candidate.bucket,
        strategy: choice.strategy,
        projection,
      },
    });
  }

  if (accepted.length === 0) {
    return { target: null, skippedPlayers, leagueReason: "no_releasable_candidates" };
  }

  const byBucket = new Map<string, AcceptedCandidate[]>();
  for (const entry of accepted) {
    const key = `${entry.candidate.position}:${entry.candidate.bucket}`;
    const rows = byBucket.get(key) ?? [];
    rows.push(entry);
    byBucket.set(key, rows);
  }

  const evidence: FirstPartyRosLiveReleaseEvidence[] = [];
  const bucketConvergences: FirstPartyRosRunConvergence[] = [];
  for (const rows of byBucket.values()) {
    const ordered = [...rows].sort((left, right) =>
      left.released.playerId.localeCompare(right.released.playerId),
    );
    const representative = ordered[0]!;
    // The representative's release runs are already simulated at exactly this path count, so the
    // diagnostic compares that run against the larger reference instead of re-simulating it. The
    // diagnostic verifies provenance before accepting the reuse.
    const scenarioOverrides = {
      releaseScenarioCount: convergenceCounts.lower,
      referenceScenarioCount: convergenceCounts.reference,
    };
    const referenceScenarioCount = convergenceCounts.reference;
    const contextualReference = yield {
      ...representative.assembled.contextualInput,
      scenarioCount: referenceScenarioCount,
    };
    const contextualConvergence = diagnoseBoundedFirstPartyRosConvergence({
      projectionInput: representative.assembled.contextualInput,
      releaseProjection: representative.candidate.contextual,
      ...scenarioOverrides,
      project: () => contextualReference,
    });
    const recencyReference = yield {
      ...representative.assembled.recencyInput,
      scenarioCount: referenceScenarioCount,
    };
    const recencyConvergence = diagnoseBoundedFirstPartyRosConvergence({
      projectionInput: representative.assembled.recencyInput,
      releaseProjection: representative.candidate.recency,
      ...scenarioOverrides,
      project: () => recencyReference,
    });
    const pointOnly = input.artifact.policyVersion === FIRST_PARTY_ROS_POINT_POLICY_VERSION;
    if (pointOnly && (!contextualConvergence.fullDiagnostic || !recencyConvergence.fullDiagnostic))
      throw new Error("Point ROS requires the standard complete convergence evidence");
    const pointConvergence = pointOnly
      ? {
          contextual: contextualConvergence.fullDiagnostic!,
          recency: recencyConvergence.fullDiagnostic!,
        }
      : undefined;
    const selectedConvergence =
      representative.released.strategy === "contextual"
        ? contextualConvergence
        : recencyConvergence;
    bucketConvergences.push(
      pointOnly
        ? extractFirstPartyRosPointConvergence({
            position: representative.candidate.position,
            scoringProfileKey,
            diagnostic: selectedConvergence.fullDiagnostic!,
          })
        : selectedConvergence,
    );
    const meanCoverage = {
      contextual:
        ordered.reduce((sum, entry) => sum + entry.candidate.coverage.contextual, 0) /
        ordered.length,
      recency:
        ordered.reduce((sum, entry) => sum + entry.candidate.coverage.recency, 0) / ordered.length,
    };
    evidence.push({
      ...buildFirstPartyRosLiveReleaseEvidence({
        position: representative.candidate.position,
        bucket: representative.candidate.bucket,
        contextualModelVersion: representative.candidate.contextualModelVersion,
        recencyModelVersion: representative.candidate.recencyModelVersion,
        scoringProfileKey,
        intervalMethodVersion: representative.candidate.intervalMethodVersion,
        inputChecksum: aggregateChecksum(
          "live-ros-bucket-evidence-v1",
          ordered.map((entry) => entry.candidate.inputChecksum),
        ),
        representative: {
          scheduledGames: representative.candidate.scheduledGames,
          contextualExpectedGames: representative.candidate.contextual.expectedGames,
          recencyExpectedGames: representative.candidate.recency.expectedGames,
        },
        meanCoverage,
        convergence: {
          contextual: {
            state: contextualConvergence.state,
            diagnosticChecksum: contextualConvergence.diagnosticChecksum,
          },
          recency: {
            state: recencyConvergence.state,
            diagnosticChecksum: recencyConvergence.diagnosticChecksum,
          },
        },
      }),
      ...(pointConvergence === undefined ? {} : { pointConvergence }),
    });
  }

  // The run summary follows each bucket's selected strategy. Both candidates remain in the
  // per-cell evidence above; an unselected strategy cannot replace the released one's diagnostic.
  const runConvergence = bucketConvergences.reduce((worst, candidate) =>
    candidate.maxToleranceRatio > worst.maxToleranceRatio ? candidate : worst,
  );
  const evaluatedPositions = [
    ...new Set(evidence.map((entry) => entry.position)),
  ].sort() as FirstPartyRosRailPosition[];
  const expectedPositions = [...input.matchedPositions].sort();
  const candidateUniverseComplete =
    skippedPlayers === 0 &&
    expectedPlayers === accepted.length &&
    expectedPositions.every((position) => evaluatedPositions.includes(position));

  return {
    target: {
      leagueSeasonId: input.leagueSeasonId,
      leagueScoringProfileKey: scoringProfileKey,
      leagueScoringProfile: input.scoringProfile,
      supportedPositions: input.supportedPositions,
      candidateUniverse: {
        expectedPlayerCount: expectedPlayers,
        evaluatedPlayerCount: accepted.length,
        skippedPlayerCount: skippedPlayers,
        skippedCandidates,
        skippedCandidatesTruncated: skippedPlayers > skippedCandidates.length,
        expectedPositions,
        evaluatedPositions,
        playerAliases: [],
        playerAliasIssues: [],
        complete: candidateUniverseComplete,
      },
      futureWindowComplete: input.futureWindowComplete,
      evidence,
      convergence: runConvergence,
      released: accepted.map((entry) => entry.released),
      sourceAsOf: input.sourceAsOf,
    },
    skippedPlayers,
  };
}
