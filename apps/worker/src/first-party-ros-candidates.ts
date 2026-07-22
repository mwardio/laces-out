import { createHash } from "node:crypto";

import {
  FIRST_PARTY_PROJECTION_MODEL_VERSION,
  FIRST_PARTY_ROS_MODEL_VERSION,
  firstPartyProjectionComponentsForPosition,
  firstPartyRecentRoleContext,
  projectFirstPartyRecencyBaselineComponents,
  projectFirstPartyRestOfSeason,
  projectFirstPartyWeeklyComponents,
  projectionScoringProfileKey,
  type FirstPartyPlayerStatus,
  type FirstPartyProjectionCalibration,
  type FirstPartyProjectionPosition,
  type FirstPartyRosAvailabilityInput,
  type FirstPartyRosConvergenceMetricName,
  type FirstPartyRosLiveReleaseEvidence,
  type FirstPartyRosPosition,
  type FirstPartyRosProjection,
  type FirstPartyRosProjectionInput,
  type FirstPartyRosRemainingWeeksBucket,
  type FirstPartyRosRoleInput,
  type FirstPartyRosStrategy,
  type FirstPartyWeeklyStatLine,
  type ProjectionScoringProfile,
  type ProjectionStatComponents,
} from "@fantasy/projections";

import {
  HISTORICAL_ROS_CANDIDATE_PAIR_VERSION,
  HISTORICAL_ROS_INTERVAL_METHOD_VERSION,
  historicalRosActiveStreak,
  historicalRosAsOfAt,
  historicalRosAvailabilityFor,
  historicalRosBucket,
  historicalRosChecksum,
  historicalRosComponentElasticities,
  historicalRosKickerProcess,
  type HistoricalRosAvailabilityCalibration,
  type HistoricalRosKickerCalibration,
  type HistoricalRosRoleCalibration,
} from "./first-party-ros-backtest.js";
import {
  firstPartyPlayerStatus,
  type ProjectionInjuryFact,
  type ProjectionScheduleFact,
} from "./first-party-projection-inputs.js";

const INACTIVE_STATUSES = new Set<FirstPartyPlayerStatus>([
  "doubtful",
  "out",
  "inactive",
  "suspended",
  "pup",
  "ir",
]);

/**
 * Live convergence tolerances mirror the model's release tolerances, but the live rail compares two
 * persistable scenario counts (both <= the ROS summary storage ceiling of 4096) rather than the
 * admission-time 8192-vs-16384 pair, so a released run's convergence diagnostic can be persisted.
 */
const ROS_LIVE_CONVERGENCE_TOLERANCES: Readonly<
  Record<
    FirstPartyRosConvergenceMetricName,
    { readonly absolute: number; readonly relative: number }
  >
> = {
  expectedGames: { absolute: 0.1, relative: 0.02 },
  meanPoints: { absolute: 0.5, relative: 0.02 },
  p15Points: { absolute: 1, relative: 0.04 },
  p50Points: { absolute: 0.75, relative: 0.03 },
  p85Points: { absolute: 1, relative: 0.04 },
};

export const FIRST_PARTY_ROS_LIVE_RELEASE_SCENARIOS = 2_048;
export const FIRST_PARTY_ROS_LIVE_CONVERGENCE_REFERENCE_SCENARIOS = 4_096;

function statusToAvailabilityState(
  status: FirstPartyPlayerStatus,
): FirstPartyRosAvailabilityInput["state"] {
  if (status === "ir" || status === "pup") return "reserve";
  if (INACTIVE_STATUSES.has(status)) return "inactive";
  if (status === "questionable") return "limited";
  return "active";
}

function scheduleForTeam(
  schedules: readonly ProjectionScheduleFact[],
  season: number,
  week: number,
  team: string,
): ProjectionScheduleFact | undefined {
  return schedules.find(
    (row) =>
      row.season === season &&
      row.week === week &&
      (row.awayTeam === team || row.homeTeam === team),
  );
}

function opponentFor(game: ProjectionScheduleFact, team: string): string {
  return game.awayTeam === team ? game.homeTeam : game.awayTeam;
}

function zeroComponents(position: FirstPartyProjectionPosition): ProjectionStatComponents {
  return Object.fromEntries(
    firstPartyProjectionComponentsForPosition(position).map((component) => [component, 0]),
  );
}

function latestInjuryStatus(
  injuries: readonly ProjectionInjuryFact[],
  playerId: string,
  season: number,
  asOfWeek: number,
): ProjectionInjuryFact | undefined {
  return injuries
    .filter((row) => row.playerId === playerId && row.season === season && row.week <= asOfWeek)
    .sort((left, right) => right.week - left.week)[0];
}

export interface FirstPartyRosCandidatePlayer {
  readonly playerId: string;
  readonly position: FirstPartyProjectionPosition;
  readonly team: string;
  readonly rosterStatus?: string | null;
}

export interface FirstPartyRosCandidateWindow {
  readonly season: number;
  readonly asOfWeek: number;
  readonly windowStartWeek: number;
  readonly windowEndWeek: number;
}

export interface FirstPartyRosCandidate {
  readonly playerId: string;
  readonly position: FirstPartyRosPosition;
  readonly bucket: FirstPartyRosRemainingWeeksBucket;
  readonly contextualModelVersion: string;
  readonly recencyModelVersion: string;
  readonly scoringProfileKey: string;
  readonly intervalMethodVersion: string;
  readonly inputChecksum: string;
  readonly asOfAt: string;
  readonly scheduledGames: number;
  readonly coverage: { readonly contextual: number; readonly recency: number };
  readonly contextual: FirstPartyRosProjection;
  readonly recency: FirstPartyRosProjection;
}

function projectionIsUsable(
  projection: { readonly state: "projected" | "zero" | "unavailable" },
  scheduled: boolean,
): boolean {
  return !scheduled || projection.state === "projected" || projection.state === "zero";
}

function rosModelVersion(strategy: FirstPartyRosStrategy): string {
  return `${FIRST_PARTY_ROS_MODEL_VERSION}:${strategy}:${FIRST_PARTY_PROJECTION_MODEL_VERSION}`;
}

export interface BuildFirstPartyRosPlayerCandidateInput {
  readonly player: FirstPartyRosCandidatePlayer;
  readonly window: FirstPartyRosCandidateWindow;
  readonly featureHistory: readonly FirstPartyWeeklyStatLine[];
  readonly calibration: FirstPartyProjectionCalibration;
  readonly availabilityCalibration: HistoricalRosAvailabilityCalibration;
  readonly roleCalibration: HistoricalRosRoleCalibration;
  readonly kickerCalibration: HistoricalRosKickerCalibration;
  readonly injuries: readonly ProjectionInjuryFact[];
  readonly schedules: readonly ProjectionScheduleFact[];
  readonly scoringProfile: ProjectionScoringProfile;
  readonly seed: string;
  readonly scenarioCount?: number;
}

/**
 * The pinned, per-strategy rest-of-season simulation inputs for one player, plus the identity and
 * coverage metadata every downstream evidence record needs. It is the single source of truth for
 * the future-week centers, so a candidate simulation and its bounded convergence diagnostic operate
 * on byte-identical inputs. Returns null when any scheduled future week lacks a usable center.
 */
export interface FirstPartyRosAssembledCandidateInputs {
  readonly playerId: string;
  readonly position: FirstPartyProjectionPosition;
  readonly bucket: FirstPartyRosRemainingWeeksBucket;
  readonly scoringProfileKey: string;
  readonly intervalMethodVersion: string;
  readonly contextualModelVersion: string;
  readonly recencyModelVersion: string;
  readonly inputChecksum: string;
  readonly asOfAt: string;
  readonly scheduledGames: number;
  readonly coverage: { readonly contextual: number; readonly recency: number };
  readonly contextualInput: FirstPartyRosProjectionInput;
  readonly recencyInput: FirstPartyRosProjectionInput;
}

/**
 * Assembles both contextual and recency future-week centers for the COMPLETE remaining window
 * (`windowStartWeek..windowEndWeek`). Returns null when any scheduled future week lacks a usable
 * center, so an incomplete future window fails closed instead of publishing a truncated season.
 */
export function assembleFirstPartyRosCandidateInputs(
  input: BuildFirstPartyRosPlayerCandidateInput,
): FirstPartyRosAssembledCandidateInputs | null {
  const { season, asOfWeek, windowStartWeek, windowEndWeek } = input.window;
  const injury = latestInjuryStatus(input.injuries, input.player.playerId, season, asOfWeek);
  const status = firstPartyPlayerStatus(
    input.player.rosterStatus,
    injury?.reportStatus,
    injury?.practiceStatus,
  );
  const availabilityState = statusToAvailabilityState(status);
  const availabilityStreak = historicalRosActiveStreak(
    input.featureHistory,
    input.player.playerId,
    season,
    asOfWeek,
    input.schedules,
  );
  const personalRows = input.featureHistory.filter(
    (row) =>
      row.playerId === input.player.playerId &&
      row.season >= season - 2 &&
      (row.season < season || row.week <= asOfWeek),
  );
  const personalAvailable = personalRows.filter(
    (row) => row.played !== false && !INACTIVE_STATUSES.has(row.status ?? "unknown"),
  ).length;
  const availabilityBase = historicalRosAvailabilityFor(
    input.availabilityCalibration,
    input.player.position,
    availabilityStreak,
    availabilityState,
    {
      rate: personalRows.length === 0 ? 0 : personalAvailable / personalRows.length,
      trials: personalRows.length,
    },
  );
  const availability: FirstPartyRosAvailabilityInput = {
    state: availabilityState,
    ...availabilityBase,
  };
  const role: FirstPartyRosRoleInput =
    input.roleCalibration.byPosition[input.player.position] ?? input.roleCalibration.fallback;
  const roleContext = firstPartyRecentRoleContext(input.featureHistory, input.player.playerId);

  const weeks: FirstPartyRosProjectionInput["weeks"][number][] = [];
  const fingerprints: unknown[] = [];
  let scheduledGames = 0;
  let contextualPresent = 0;
  let recencyPresent = 0;
  for (let week = windowStartWeek; week <= windowEndWeek; week += 1) {
    const game = scheduleForTeam(input.schedules, season, week, input.player.team);
    const scheduled = game !== undefined;
    if (scheduled) scheduledGames += 1;
    const target = {
      playerId: input.player.playerId,
      position: input.player.position,
      season,
      week,
      team: input.player.team,
      ...(game ? { opponent: opponentFor(game, input.player.team) } : {}),
      scheduled,
      isBye: !scheduled,
      status: "active" as const,
      ...(roleContext ? { role: roleContext } : {}),
    };
    const contextual = projectFirstPartyWeeklyComponents({
      target,
      history: input.featureHistory,
      calibration: input.calibration,
    });
    const recency = projectFirstPartyRecencyBaselineComponents({
      target,
      history: input.featureHistory,
      calibration: input.calibration,
    });
    if (!projectionIsUsable(contextual, scheduled) || !projectionIsUsable(recency, scheduled)) {
      return null;
    }
    if (scheduled && contextual.state !== "unavailable") contextualPresent += 1;
    if (scheduled && recency.state !== "unavailable") recencyPresent += 1;
    const contextualComponents = scheduled
      ? contextual.components
      : zeroComponents(input.player.position);
    const recencyComponents = scheduled
      ? recency.components
      : zeroComponents(input.player.position);
    weeks.push({
      season,
      week,
      scheduled,
      bye: !scheduled,
      contextualComponents,
      recencyComponents,
      componentElasticities: historicalRosComponentElasticities(
        contextualComponents,
        recencyComponents,
      ),
    });
    fingerprints.push({
      week,
      contextual: contextual.provenance.inputFingerprint,
      recency: recency.provenance.inputFingerprint,
    });
  }

  const asOfAt = historicalRosAsOfAt(input.schedules, season, asOfWeek);
  const scoringProfileKey = projectionScoringProfileKey(input.scoringProfile);
  // Kicker fields spread conditionally so every non-K checksum and input stays byte-identical
  // to its pre-v7 value (the payload version string deliberately stays live-ros-input-v1).
  const kicker =
    input.player.position === "K" ? historicalRosKickerProcess(input.kickerCalibration) : undefined;
  const inputChecksum = historicalRosChecksum({
    version: "live-ros-input-v1",
    playerId: input.player.playerId,
    position: input.player.position,
    team: input.player.team,
    season,
    asOfWeek,
    asOfAt,
    windowStartWeek,
    windowEndWeek,
    fingerprints,
    availability,
    availabilityStreak,
    availabilityCalibrationVersion: input.availabilityCalibration.version,
    role,
    roleCalibrationVersion: input.roleCalibration.version,
    ...(kicker ? { kicker, kickerCalibrationVersion: input.kickerCalibration.version } : {}),
    scoringProfileKey,
  });
  const common = {
    playerId: input.player.playerId,
    position: input.player.position,
    season,
    asOfWeek,
    asOfAt,
    windowStartWeek,
    windowEndWeek,
    weeks,
    availability,
    role,
    scoringProfile: input.scoringProfile,
    ...(kicker ? { kicker } : {}),
    inputChecksum,
    weeklyModelVersion: HISTORICAL_ROS_CANDIDATE_PAIR_VERSION,
    seed: input.seed,
    ...(input.scenarioCount === undefined ? {} : { scenarioCount: input.scenarioCount }),
  } as const;
  return {
    playerId: input.player.playerId,
    position: input.player.position,
    bucket: historicalRosBucket(windowStartWeek, windowEndWeek),
    scoringProfileKey,
    intervalMethodVersion: HISTORICAL_ROS_INTERVAL_METHOD_VERSION,
    contextualModelVersion: rosModelVersion("contextual"),
    recencyModelVersion: rosModelVersion("availability-aware-recency"),
    inputChecksum,
    asOfAt,
    scheduledGames,
    coverage: {
      contextual: scheduledGames === 0 ? 0 : contextualPresent / scheduledGames,
      recency: scheduledGames === 0 ? 0 : recencyPresent / scheduledGames,
    },
    contextualInput: { ...common, strategy: "contextual" },
    recencyInput: { ...common, strategy: "availability-aware-recency" },
  };
}

/**
 * Builds both contextual and recency future-week centers for the COMPLETE remaining window and
 * simulates the joint rest-of-season distribution for each strategy. Returns null when any
 * scheduled future week lacks a usable center, so an incomplete future window fails closed instead
 * of publishing a truncated season.
 */
export function buildFirstPartyRosPlayerCandidate(
  input: BuildFirstPartyRosPlayerCandidateInput,
): FirstPartyRosCandidate | null {
  const assembled = assembleFirstPartyRosCandidateInputs(input);
  if (assembled === null) return null;
  const contextual = projectFirstPartyRestOfSeason(assembled.contextualInput);
  const recency = projectFirstPartyRestOfSeason(assembled.recencyInput);
  return {
    playerId: assembled.playerId,
    position: contextual.position,
    bucket: assembled.bucket,
    contextualModelVersion: assembled.contextualModelVersion,
    recencyModelVersion: assembled.recencyModelVersion,
    scoringProfileKey: assembled.scoringProfileKey,
    intervalMethodVersion: assembled.intervalMethodVersion,
    inputChecksum: assembled.inputChecksum,
    asOfAt: assembled.asOfAt,
    scheduledGames: assembled.scheduledGames,
    coverage: assembled.coverage,
    contextual,
    recency,
  };
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * Deterministic bounded convergence diagnostic for the live rail. Compares the release scenario
 * count with a larger, still-persistable reference; the release run is a seeded prefix of the
 * reference, so this diagnoses Monte Carlo stability without exceeding the summary storage ceiling.
 */
export function diagnoseBoundedFirstPartyRosConvergence(input: {
  readonly projectionInput: FirstPartyRosProjectionInput;
  readonly releaseScenarioCount?: number;
  readonly referenceScenarioCount?: number;
}): {
  readonly state: "converged" | "unstable";
  readonly lowerScenarioCount: number;
  readonly referenceScenarioCount: number;
  readonly maxToleranceRatio: number;
  readonly diagnosticChecksum: string;
} {
  const lower = input.releaseScenarioCount ?? FIRST_PARTY_ROS_LIVE_RELEASE_SCENARIOS;
  const reference =
    input.referenceScenarioCount ?? FIRST_PARTY_ROS_LIVE_CONVERGENCE_REFERENCE_SCENARIOS;
  const release = projectFirstPartyRestOfSeason({ ...input.projectionInput, scenarioCount: lower });
  const referenceRun = projectFirstPartyRestOfSeason({
    ...input.projectionInput,
    scenarioCount: reference,
  });
  const pairs: Record<FirstPartyRosConvergenceMetricName, { release: number; reference: number }> =
    {
      expectedGames: { release: release.expectedGames, reference: referenceRun.expectedGames },
      meanPoints: { release: release.meanPoints, reference: referenceRun.meanPoints },
      p15Points: { release: release.p15Points, reference: referenceRun.p15Points },
      p50Points: { release: release.p50Points, reference: referenceRun.p50Points },
      p85Points: { release: release.p85Points, reference: referenceRun.p85Points },
    };
  let maxToleranceRatio = 0;
  const metrics = (Object.keys(pairs) as FirstPartyRosConvergenceMetricName[]).map((metric) => {
    const pair = pairs[metric];
    const tolerance = ROS_LIVE_CONVERGENCE_TOLERANCES[metric];
    const absoluteDifference = Math.abs(pair.release - pair.reference);
    const allowed = Math.max(tolerance.absolute, Math.abs(pair.reference) * tolerance.relative);
    const ratio = allowed === 0 ? 0 : absoluteDifference / allowed;
    maxToleranceRatio = Math.max(maxToleranceRatio, ratio);
    return { metric, absoluteDifference, allowed, ratio };
  });
  const diagnosticChecksum = sha256({
    version: "live-bounded-ros-convergence-v1",
    seedHash: release.provenance.seedHash,
    lowerScenarioCount: lower,
    referenceScenarioCount: reference,
    metrics,
  });
  return {
    state: maxToleranceRatio <= 1 ? "converged" : "unstable",
    lowerScenarioCount: lower,
    referenceScenarioCount: reference,
    maxToleranceRatio: Math.min(maxToleranceRatio, 1),
    diagnosticChecksum,
  };
}

/**
 * Aggregates same-position/same-bucket candidates into one live release-gate evidence record: mean
 * pinned-input coverage, representative expected games, and a per-strategy bounded convergence
 * diagnostic. The strategy that actually gets released is chosen by the champion policy inside the
 * release gate, so both candidate strategies contribute convergence evidence here.
 */
export function buildFirstPartyRosLiveReleaseEvidence(input: {
  readonly position: FirstPartyRosPosition;
  readonly bucket: FirstPartyRosRemainingWeeksBucket;
  readonly contextualModelVersion: string;
  readonly recencyModelVersion: string;
  readonly scoringProfileKey: string;
  readonly intervalMethodVersion: string;
  readonly inputChecksum: string;
  readonly representative: {
    readonly scheduledGames: number;
    readonly contextualExpectedGames: number;
    readonly recencyExpectedGames: number;
  };
  readonly meanCoverage: { readonly contextual: number; readonly recency: number };
  readonly convergence: {
    readonly contextual: {
      readonly state: "converged" | "unstable";
      readonly diagnosticChecksum: string;
    };
    readonly recency: {
      readonly state: "converged" | "unstable";
      readonly diagnosticChecksum: string;
    };
  };
}): FirstPartyRosLiveReleaseEvidence {
  return {
    position: input.position,
    bucket: input.bucket,
    contextualModelVersion: input.contextualModelVersion,
    recencyModelVersion: input.recencyModelVersion,
    scoringProfileKey: input.scoringProfileKey,
    intervalMethodVersion: input.intervalMethodVersion,
    inputChecksum: input.inputChecksum,
    coverage: input.meanCoverage,
    availability: input.representative,
    convergence: input.convergence,
  };
}
