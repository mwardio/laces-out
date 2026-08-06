import { createHash } from "node:crypto";

import {
  dataSources,
  leagueSeasons,
  nflScheduleObservations,
  playerInjuryReportObservations,
  playerSnapCountObservations,
  playerWeeklyRosterObservations,
  playerWeeklyStatObservations,
  players,
  scoringRules,
  teamWeeklyStatObservations,
  type Database,
} from "@laces-out/db";
import {
  LEAGUE_SCORING_NORMALIZATION_VERSION,
  normalizeLeagueScoringProfile,
  projectionScoringProfileKey,
  runFirstPartyProjectionBacktest,
  runFirstPartyTeamDefenseBacktest,
  type FirstPartyProjectionCalibration,
  type FirstPartyProjectionPosition,
  type FirstPartyRosLiveReleaseEvidence,
  type FirstPartyTeamDefenseCalibration,
  type FirstPartyTeamDefenseWeeklyStatLine,
  type FirstPartyWeeklyStatLine,
  type LeagueScoringPositionSupport,
  type ProjectionScoringProfile,
} from "@laces-out/projections";
import { and, eq, inArray } from "drizzle-orm";

import {
  HISTORICAL_ROS_SUPPORTED_POSITIONS,
  calibrateHistoricalRosAvailability,
  calibrateHistoricalRosKicker,
  calibrateHistoricalRosRole,
  type HistoricalRosAvailabilityCalibration,
  type HistoricalRosKickerCalibration,
  type HistoricalRosRoleCalibration,
} from "./first-party-ros-backtest.js";
import {
  assembleFirstPartyRosCandidateInputs,
  assembleFirstPartyRosDefenseCandidateInputs,
  buildFirstPartyRosLiveReleaseEvidence,
  diagnoseBoundedFirstPartyRosConvergence,
  simulateFirstPartyRosCandidate,
  type FirstPartyRosAssembledCandidateInputs,
  type FirstPartyRosCandidate,
} from "./first-party-ros-candidates.js";
import {
  buildFirstPartyPlayerHistory,
  buildFirstPartyDefenseHistory,
  type ProjectionInjuryFact,
  type ProjectionRosterFact,
  type ProjectionScheduleFact,
  type ProjectionSnapFact,
  type ProjectionTeamWeekFact,
  type ProjectionWeeklyFact,
} from "./first-party-projection-inputs.js";
import {
  firstPartyAvailableProjectionComponents,
  firstPartyDefensePlayerId,
  projectionHistorySeasons,
} from "./first-party-projections.js";
import type {
  FirstPartyRosCandidateContext,
  FirstPartyRosCandidateProvider,
  FirstPartyRosPublicationTarget,
  FirstPartyRosWindow,
} from "./first-party-ros-projections.js";
import {
  firstPartyRosArtifactScoringProfile,
  matchFirstPartyRosPositions,
  selectFirstPartyRosArtifactForLeague,
  type FirstPartyRosRailPosition,
  type FirstPartyRosReleasedPlayer,
  type FirstPartyRosRunConvergence,
  type FirstPartyRosWithheldPosition,
  type LoadedFirstPartyRosChampionArtifact,
} from "./first-party-ros-publication.js";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Deterministic 64-hex lineage digest over an unordered set of member checksums. */
function aggregateChecksum(kind: string, members: readonly string[]): string {
  return sha256(JSON.stringify({ kind, members: [...members].sort() }));
}

function normalizePosition(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (normalized === "HB" || normalized === "FB") return "RB";
  if (normalized === "PK") return "K";
  return normalized;
}

export interface FirstPartyRosScoringMatchedLeague {
  readonly leagueSeasonId: string;
  readonly profile: ProjectionScoringProfile;
  /** Rail positions this league may receive from the artifact. Never empty on a matched league. */
  readonly matchedPositions: readonly FirstPartyRosRailPosition[];
  /** Rail positions this league may not receive, each with the reason it was withheld. */
  readonly withheldPositions: readonly FirstPartyRosWithheldPosition[];
  /** Rail positions league-scoring normalization supports, matched or not. */
  readonly supportedPositions: readonly FirstPartyRosRailPosition[];
}

/** A league the artifact authorizes for no position at all, with the reason for each one. */
export interface FirstPartyRosScoringExcludedLeague {
  readonly leagueSeasonId: string;
  readonly withheldPositions: readonly FirstPartyRosWithheldPosition[];
}

export interface FirstPartyRosScoringMatchReport {
  readonly matched: readonly FirstPartyRosScoringMatchedLeague[];
  readonly excluded: readonly FirstPartyRosScoringExcludedLeague[];
}

/**
 * Applies the release rail's single-artifact arbitration before simulation. The release service
 * repeats the same check after targets are built as a fail-closed backstop; doing it here avoids
 * simulating a full player pool for artifacts whose output would necessarily be discarded.
 */
export function firstPartyRosArtifactOwnedLeagues(input: {
  readonly artifact: LoadedFirstPartyRosChampionArtifact;
  readonly artifacts: readonly LoadedFirstPartyRosChampionArtifact[];
  readonly leagues: readonly FirstPartyRosScoringMatchedLeague[];
}): readonly FirstPartyRosScoringMatchedLeague[] {
  return input.leagues.filter((league) => {
    const selected = selectFirstPartyRosArtifactForLeague({
      artifacts: input.artifacts,
      leagueScoringProfileKey: projectionScoringProfileKey(league.profile),
      leagueScoringProfile: league.profile,
      supportedPositions: league.supportedPositions,
    });
    return selected?.artifactChecksum === input.artifact.artifactChecksum;
  });
}

export interface FirstPartyRosLeagueRow {
  readonly id: string;
  readonly provider: string;
}

export interface FirstPartyRosScoringRuleRow {
  readonly leagueSeasonId: string;
  readonly statKey: string;
  readonly providerStatId: string | null;
  readonly operation: string;
  readonly points: string;
  readonly thresholdLow: string | null;
  readonly thresholdHigh: string | null;
}

const UNSUPPORTED_RAIL_POSITIONS: readonly FirstPartyRosWithheldPosition[] =
  HISTORICAL_ROS_SUPPORTED_POSITIONS.map((position) => ({
    position,
    reason: "position-unsupported" as const,
  }));

/** The rail positions a normalization result reports as supported, in rail order. */
function supportedRailPositions(
  positions: readonly LeagueScoringPositionSupport[],
): readonly FirstPartyRosRailPosition[] {
  const supported = new Set(
    positions.filter((entry) => entry.supported).map((entry) => entry.position),
  );
  return HISTORICAL_ROS_SUPPORTED_POSITIONS.filter((position) => supported.has(position));
}

/**
 * Matches leagues against the champion artifact one position at a time. A league receives a
 * position only when its own normalization supports that position AND the position-scoped scoring
 * keys are byte-equal to the artifact's, so a league that prices D/ST or kickers differently keeps
 * every position whose scoring is provably identical and loses exactly the ones that are not.
 *
 * Nothing is widened and nothing is silently dropped: a league that matches no position is
 * excluded exactly as before, but now reports why for each position instead of vanishing.
 */
export function enumerateFirstPartyRosScoringMatchedLeagues(input: {
  readonly artifactScoringProfileKey: string;
  readonly leagues: readonly FirstPartyRosLeagueRow[];
  readonly rules: readonly FirstPartyRosScoringRuleRow[];
  readonly availableStatIds: readonly string[];
}): FirstPartyRosScoringMatchReport {
  const rulesByLeague = new Map<string, FirstPartyRosScoringRuleRow[]>();
  for (const rule of input.rules) {
    const rows = rulesByLeague.get(rule.leagueSeasonId) ?? [];
    rows.push(rule);
    rulesByLeague.set(rule.leagueSeasonId, rows);
  }
  const matched: FirstPartyRosScoringMatchedLeague[] = [];
  const excluded: FirstPartyRosScoringExcludedLeague[] = [];
  for (const league of input.leagues) {
    const normalization = normalizeLeagueScoringProfile({
      id: `league:${league.id}`,
      label: "League scoring",
      version: LEAGUE_SCORING_NORMALIZATION_VERSION,
      rows: (rulesByLeague.get(league.id) ?? []).map((rule) => ({
        provider: league.provider,
        statKey: rule.statKey,
        providerStatId: rule.providerStatId,
        operation: rule.operation,
        points: rule.points,
        thresholdLow: rule.thresholdLow,
        thresholdHigh: rule.thresholdHigh,
      })),
      availableStatIds: input.availableStatIds,
    });
    if (normalization.state !== "available") {
      // No profile exists to compare, so no position can be attributed anything but its own
      // unsupported normalization.
      excluded.push({ leagueSeasonId: league.id, withheldPositions: UNSUPPORTED_RAIL_POSITIONS });
      continue;
    }
    const supportedPositions = supportedRailPositions(normalization.positions);
    const match = matchFirstPartyRosPositions({
      artifactScoringProfileKey: input.artifactScoringProfileKey,
      leagueScoringProfile: normalization.profile,
      supportedPositions,
    });
    if (match.matched.length === 0) {
      excluded.push({ leagueSeasonId: league.id, withheldPositions: match.withheld });
      continue;
    }
    matched.push({
      leagueSeasonId: league.id,
      profile: normalization.profile,
      matchedPositions: match.matched,
      withheldPositions: match.withheld,
      supportedPositions,
    });
  }
  return { matched, excluded };
}

export interface FirstPartyRosCandidatePlayer {
  readonly playerId: string;
  readonly position: string;
  readonly team: string | null;
  readonly rosterStatus?: string | null;
}

export interface FirstPartyRosLeagueTargetResult {
  readonly target: FirstPartyRosPublicationTarget | null;
  /** Players skipped for a missing/ambiguous per-player piece (no approximation was substituted). */
  readonly skippedPlayers: number;
  /** Set when the whole league yields nothing (a league-wide piece was missing). */
  readonly leagueReason?: string;
}

interface AcceptedCandidate {
  readonly candidate: FirstPartyRosCandidate;
  readonly assembled: FirstPartyRosAssembledCandidateInputs;
  readonly released: FirstPartyRosReleasedPlayer;
}

/**
 * Builds one league-scoped publication target from database-derived observations, mirroring the
 * weekly service's assembly semantics. Every future-week center comes from the tested candidate
 * builder; a player missing any usable piece is skipped and audited (never approximated), and a
 * league that produces no releasable candidate yields no target so the rail stays fail-closed.
 */
export function buildFirstPartyRosLeagueTarget(input: {
  readonly artifact: LoadedFirstPartyRosChampionArtifact;
  readonly leagueSeasonId: string;
  readonly scoringProfile: ProjectionScoringProfile;
  /** Only these positions may become candidates; every other one is withheld before simulation. */
  readonly matchedPositions: readonly FirstPartyRosRailPosition[];
  /** Carried onto the target so publication can re-derive the match rather than trust it. */
  readonly supportedPositions: readonly FirstPartyRosRailPosition[];
  readonly season: number;
  readonly window: FirstPartyRosWindow;
  readonly candidatePlayers: readonly FirstPartyRosCandidatePlayer[];
  readonly featureHistory: readonly FirstPartyWeeklyStatLine[];
  readonly calibration: FirstPartyProjectionCalibration;
  readonly defenseFeatureHistory: readonly FirstPartyTeamDefenseWeeklyStatLine[];
  readonly defenseCalibration: FirstPartyTeamDefenseCalibration;
  readonly availabilityCalibration: HistoricalRosAvailabilityCalibration;
  readonly roleCalibration: HistoricalRosRoleCalibration;
  readonly kickerCalibration: HistoricalRosKickerCalibration;
  readonly injuries: readonly ProjectionInjuryFact[];
  readonly schedules: readonly ProjectionScheduleFact[];
  readonly futureWindowComplete: boolean;
  readonly sourceAsOf: Date;
  /** Actual live refresh cutoff; never the historical replay helper's preseason fallback. */
  readonly asOfAt: Date;
  /**
   * Downscales the release simulation. Production never sets it, so the engine default decides.
   * A caller that downscales the release run must downscale its reference too — an unpaired
   * override is exactly the half-specified scenario contract this rail was fixed for.
   */
  readonly scenarioCount?: number;
  readonly convergenceReferenceScenarioCount?: number;
}): FirstPartyRosLeagueTargetResult {
  const scoringProfileKey = projectionScoringProfileKey(input.scoringProfile);
  const window = {
    season: input.season,
    asOfWeek: input.window.asOfWeek,
    windowStartWeek: input.window.windowStartWeek,
    windowEndWeek: input.window.windowEndWeek,
  } as const;

  let skippedPlayers = 0;
  const accepted: AcceptedCandidate[] = [];
  const seenPlayers = new Set<string>();
  // A position the artifact does not authorize for this league never becomes a candidate, so it is
  // withheld structurally rather than filtered out later; it is not an audited per-player skip
  // because nothing about the player was missing.
  const releasablePositions = new Set<string>(input.matchedPositions);
  for (const player of input.candidatePlayers) {
    const position = normalizePosition(player.position);
    if (!releasablePositions.has(position) || player.team === null) continue;
    if (seenPlayers.has(player.playerId)) continue;
    seenPlayers.add(player.playerId);

    if (position === "DST") {
      const assembled = assembleFirstPartyRosDefenseCandidateInputs({
        defense: { playerId: player.playerId, team: player.team },
        window,
        featureHistory: input.defenseFeatureHistory,
        calibration: input.defenseCalibration,
        schedules: input.schedules,
        scoringProfile: input.scoringProfile,
        seed: `live-ros:${scoringProfileKey}:${input.season}:${window.asOfWeek}:${player.playerId}`,
        asOfAt: input.asOfAt.toISOString(),
        ...(input.scenarioCount === undefined ? {} : { scenarioCount: input.scenarioCount }),
      });
      if (assembled === null) {
        skippedPlayers += 1;
        continue;
      }
      const candidate = simulateFirstPartyRosCandidate(assembled);
      const choice = input.artifact.policy.choices.find(
        (candidate_) =>
          candidate_.position === candidate.position && candidate_.bucket === candidate.bucket,
      );
      if (choice === undefined) {
        skippedPlayers += 1;
        continue;
      }
      const projection =
        choice.strategy === "contextual" ? candidate.contextual : candidate.recency;
      if (projection.state !== "projected" || projection.expectedGames <= 0) {
        skippedPlayers += 1;
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
      seed: `live-ros:${scoringProfileKey}:${input.season}:${window.asOfWeek}:${player.playerId}`,
      asOfAt: input.asOfAt.toISOString(),
      ...(input.scenarioCount === undefined ? {} : { scenarioCount: input.scenarioCount }),
    };

    // Assembled ONCE per player and reused for the simulation, the bucket evidence, and the bucket
    // convergence diagnostic. Assembly re-projects every remaining week's weekly centers, and the
    // pipeline previously performed it twice for every accepted player.
    const assembled = assembleFirstPartyRosCandidateInputs(builderInput);
    if (assembled === null) {
      skippedPlayers += 1;
      continue;
    }
    const candidate = simulateFirstPartyRosCandidate(assembled);
    // The champion policy authorizes exactly one strategy per position/bucket; without a matching
    // choice the player cannot be released (no default, no approximation).
    const choice = input.artifact.policy.choices.find(
      (candidate_) =>
        candidate_.position === candidate.position && candidate_.bucket === candidate.bucket,
    );
    if (choice === undefined) {
      skippedPlayers += 1;
      continue;
    }
    const projection = choice.strategy === "contextual" ? candidate.contextual : candidate.recency;
    if (projection.state !== "projected" || projection.expectedGames <= 0) {
      skippedPlayers += 1;
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
      ...(input.scenarioCount === undefined ? {} : { releaseScenarioCount: input.scenarioCount }),
      ...(input.convergenceReferenceScenarioCount === undefined
        ? {}
        : { referenceScenarioCount: input.convergenceReferenceScenarioCount }),
    };
    const contextualConvergence = diagnoseBoundedFirstPartyRosConvergence({
      projectionInput: representative.assembled.contextualInput,
      releaseProjection: representative.candidate.contextual,
      ...scenarioOverrides,
    });
    const recencyConvergence = diagnoseBoundedFirstPartyRosConvergence({
      projectionInput: representative.assembled.recencyInput,
      releaseProjection: representative.candidate.recency,
      ...scenarioOverrides,
    });
    bucketConvergences.push(contextualConvergence);
    const meanCoverage = {
      contextual:
        ordered.reduce((sum, entry) => sum + entry.candidate.coverage.contextual, 0) /
        ordered.length,
      recency:
        ordered.reduce((sum, entry) => sum + entry.candidate.coverage.recency, 0) / ordered.length,
    };
    evidence.push(
      buildFirstPartyRosLiveReleaseEvidence({
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
    );
  }

  // The run-level convergence diagnostic is the worst (least stable) per-bucket contextual result,
  // so a single unstable stratum drags the whole released run's recorded diagnostic down.
  const runConvergence = bucketConvergences.reduce((worst, candidate) =>
    candidate.maxToleranceRatio > worst.maxToleranceRatio ? candidate : worst,
  );

  return {
    target: {
      leagueSeasonId: input.leagueSeasonId,
      leagueScoringProfileKey: scoringProfileKey,
      leagueScoringProfile: input.scoringProfile,
      supportedPositions: input.supportedPositions,
      futureWindowComplete: input.futureWindowComplete,
      evidence,
      convergence: runConvergence,
      released: accepted.map((entry) => entry.released),
      sourceAsOf: input.sourceAsOf,
    },
    skippedPlayers,
  };
}

/**
 * The production candidate provider. It loads the immutable weekly observations already pinned in
 * PostgreSQL, assembles the same inputs the weekly service uses, calibrates availability/role from
 * seasons strictly before the current one, and hands every future-week center to the tested
 * candidate builder. A league is matched against the artifact one position at a time: only the
 * positions whose scoped scoring keys equal the artifact's — and that the league's own normalization
 * supports — produce candidates. A league that matches no position, or that cannot be fully
 * assembled, yields no target.
 */
export function databaseFirstPartyRosCandidateProvider(input: {
  readonly database: Database;
  readonly scenarioCount?: number;
  readonly convergenceReferenceScenarioCount?: number;
}): FirstPartyRosCandidateProvider {
  return {
    sourceChecksum: async ({ season, window }) => {
      const sourceKeys = firstPartyRosCandidateSourceKeys(season);
      const sources = await pinnedSourceChecksums(input.database, sourceKeys);
      return aggregateChecksum("live-ros-candidate-provider-v2", [
        `season:${season}`,
        `window:${window.windowStartWeek}-${window.windowEndWeek}:asof-${window.asOfWeek}`,
        `scenario-count:${input.scenarioCount ?? "default"}`,
        `reference-scenario-count:${input.convergenceReferenceScenarioCount ?? "default"}`,
        ...sourceKeys.map((key) => `${key}:${sources.get(key)?.checksum ?? "missing"}`),
      ]);
    },
    buildTargets: (context) => buildDatabaseFirstPartyRosTargets(input, context),
  };
}

export function firstPartyRosCandidateSourceKeys(season: number): readonly string[] {
  const seasons = projectionHistorySeasons(season);
  const completedSeasons = seasons.filter((candidate) => candidate < season);
  return [
    ...seasons.map((candidate) => `nflverse.schedules.${candidate}`),
    ...completedSeasons.map((candidate) => `nflverse.stats-player-week.${candidate}`),
    ...completedSeasons.map((candidate) => `nflverse.snap-counts.${candidate}`),
    ...completedSeasons.map((candidate) => `nflverse.weekly-rosters.${candidate}`),
    ...completedSeasons.map((candidate) => `nflverse.injuries.${candidate}`),
    ...seasons.map((candidate) => `nflverse.stats-team-week.${candidate}`),
    `nflverse.stats-player-week.${season}`,
    `nflverse.snap-counts.${season}`,
    `nflverse.weekly-rosters.${season}`,
    `nflverse.injuries.${season}`,
  ];
}

async function pinnedSourceChecksums(
  database: Database,
  keys: readonly string[],
): Promise<ReadonlyMap<string, { readonly id: string; readonly checksum: string }>> {
  if (keys.length === 0) return new Map();
  const rows = await database
    .select({
      id: dataSources.id,
      key: dataSources.key,
      lastChecksum: dataSources.lastChecksum,
    })
    .from(dataSources)
    .where(inArray(dataSources.key, keys));
  const result = new Map<string, { readonly id: string; readonly checksum: string }>();
  for (const row of rows) {
    if (row.lastChecksum) result.set(row.key, { id: row.id, checksum: row.lastChecksum });
  }
  return result;
}

async function buildDatabaseFirstPartyRosTargets(
  options: {
    readonly database: Database;
    readonly scenarioCount?: number;
    readonly convergenceReferenceScenarioCount?: number;
  },
  context: FirstPartyRosCandidateContext,
): Promise<readonly FirstPartyRosPublicationTarget[]> {
  const database = options.database;
  const { season, window, artifact } = context;
  const seasons = projectionHistorySeasons(season);

  const leagueRows = await database
    .select({ id: leagueSeasons.id, provider: leagueSeasons.provider })
    .from(leagueSeasons)
    .where(eq(leagueSeasons.season, season));
  if (leagueRows.length === 0) return [];
  const ruleRows = await database
    .select({
      leagueSeasonId: scoringRules.leagueSeasonId,
      statKey: scoringRules.statKey,
      providerStatId: scoringRules.providerStatId,
      operation: scoringRules.operation,
      points: scoringRules.points,
      thresholdLow: scoringRules.thresholdLow,
      thresholdHigh: scoringRules.thresholdHigh,
    })
    .from(scoringRules)
    .innerJoin(leagueSeasons, eq(leagueSeasons.id, scoringRules.leagueSeasonId))
    .where(eq(leagueSeasons.season, season));

  // `excluded` is deliberately dropped here: this rail has no operator-facing channel of its own
  // (no logger in this file), and the ROS status surface derives its own per-position reasons from
  // its own normalization rather than reading these. It is returned so the reasons are available to
  // a caller and are covered by tests; if a diagnostics channel is ever added, this is where the
  // exclusions are already computed.
  const matchReport = enumerateFirstPartyRosScoringMatchedLeagues({
    artifactScoringProfileKey: artifact.scoringProfileKey,
    leagues: leagueRows,
    rules: ruleRows,
    availableStatIds: firstPartyAvailableProjectionComponents(),
  });
  const matched = firstPartyRosArtifactOwnedLeagues({
    artifact,
    artifacts: context.artifacts,
    leagues: matchReport.matched,
  });
  if (matched.length === 0) return [];

  const sourceKeys = firstPartyRosCandidateSourceKeys(season);
  const sources = await pinnedSourceChecksums(database, sourceKeys);
  const scheduleSources = seasons.flatMap((candidate) => {
    const source = sources.get(`nflverse.schedules.${candidate}`);
    return source ? [source] : [];
  });
  if (scheduleSources.length === 0) return [];
  const statSources = [...seasons].flatMap((candidate) => {
    const source = sources.get(`nflverse.stats-player-week.${candidate}`);
    return source ? [source] : [];
  });
  const snapSources = seasons.flatMap((candidate) => {
    const source = sources.get(`nflverse.snap-counts.${candidate}`);
    return source ? [source] : [];
  });
  const rosterSources = seasons.flatMap((candidate) => {
    const source = sources.get(`nflverse.weekly-rosters.${candidate}`);
    return source ? [source] : [];
  });
  const injurySources = seasons.flatMap((candidate) => {
    const source = sources.get(`nflverse.injuries.${candidate}`);
    return source ? [source] : [];
  });
  const teamStatSources = seasons.flatMap((candidate) => {
    const source = sources.get(`nflverse.stats-team-week.${candidate}`);
    return source ? [source] : [];
  });

  const [scheduleRows, weeklyRows, snapRows, rosterRows, injuryRows, teamRows] = await Promise.all([
    database
      .select({
        season: nflScheduleObservations.season,
        week: nflScheduleObservations.week,
        gameId: nflScheduleObservations.externalGameId,
        awayTeam: nflScheduleObservations.awayTeam,
        homeTeam: nflScheduleObservations.homeTeam,
        awayScore: nflScheduleObservations.awayScore,
        homeScore: nflScheduleObservations.homeScore,
        kickoffAt: nflScheduleObservations.kickoffAt,
        status: nflScheduleObservations.status,
        sourceAsOf: nflScheduleObservations.sourceAsOf,
      })
      .from(nflScheduleObservations)
      .where(
        and(
          inArray(
            nflScheduleObservations.sourceId,
            scheduleSources.map((entry) => entry.id),
          ),
          inArray(
            nflScheduleObservations.inputChecksum,
            scheduleSources.map((entry) => entry.checksum),
          ),
          inArray(nflScheduleObservations.season, seasons),
          eq(nflScheduleObservations.seasonType, "REG"),
        ),
      ),
    statSources.length === 0
      ? Promise.resolve([])
      : database
          .select({
            playerId: playerWeeklyStatObservations.playerId,
            position: players.primaryPosition,
            season: playerWeeklyStatObservations.season,
            week: playerWeeklyStatObservations.week,
            gameId: playerWeeklyStatObservations.gameId,
            team: playerWeeklyStatObservations.team,
            opponentTeam: playerWeeklyStatObservations.opponentTeam,
            components: playerWeeklyStatObservations.components,
            advanced: playerWeeklyStatObservations.advanced,
          })
          .from(playerWeeklyStatObservations)
          .innerJoin(players, eq(players.id, playerWeeklyStatObservations.playerId))
          .where(
            and(
              inArray(
                playerWeeklyStatObservations.sourceId,
                statSources.map((entry) => entry.id),
              ),
              inArray(
                playerWeeklyStatObservations.inputChecksum,
                statSources.map((entry) => entry.checksum),
              ),
              inArray(playerWeeklyStatObservations.season, seasons),
              eq(playerWeeklyStatObservations.seasonType, "REG"),
            ),
          ),
    snapSources.length === 0
      ? Promise.resolve([])
      : database
          .select({
            playerId: playerSnapCountObservations.playerId,
            position: players.primaryPosition,
            season: playerSnapCountObservations.season,
            week: playerSnapCountObservations.week,
            gameId: playerSnapCountObservations.gameId,
            team: playerSnapCountObservations.team,
            opponentTeam: playerSnapCountObservations.opponentTeam,
            offenseShare: playerSnapCountObservations.offenseShare,
            specialTeamsShare: playerSnapCountObservations.specialTeamsShare,
          })
          .from(playerSnapCountObservations)
          .innerJoin(players, eq(players.id, playerSnapCountObservations.playerId))
          .where(
            and(
              inArray(
                playerSnapCountObservations.sourceId,
                snapSources.map((entry) => entry.id),
              ),
              inArray(
                playerSnapCountObservations.inputChecksum,
                snapSources.map((entry) => entry.checksum),
              ),
              inArray(playerSnapCountObservations.season, seasons),
              eq(playerSnapCountObservations.seasonType, "REG"),
            ),
          ),
    rosterSources.length === 0
      ? Promise.resolve([])
      : database
          .select({
            playerId: playerWeeklyRosterObservations.playerId,
            // The NFL roster feed is the fantasy-position authority for the live pool. The
            // canonical catalog intentionally records an NFL primary position, which can be CB
            // for a two-way fantasy WR (or FB for a provider-eligible RB/TE). Replacing the feed's
            // position with that catalog value would silently drop those players from ROS.
            position: playerWeeklyRosterObservations.position,
            season: playerWeeklyRosterObservations.season,
            week: playerWeeklyRosterObservations.week,
            team: playerWeeklyRosterObservations.team,
            status: playerWeeklyRosterObservations.rosterStatus,
          })
          .from(playerWeeklyRosterObservations)
          .innerJoin(players, eq(players.id, playerWeeklyRosterObservations.playerId))
          .where(
            and(
              inArray(
                playerWeeklyRosterObservations.sourceId,
                rosterSources.map((entry) => entry.id),
              ),
              inArray(
                playerWeeklyRosterObservations.inputChecksum,
                rosterSources.map((entry) => entry.checksum),
              ),
              inArray(playerWeeklyRosterObservations.season, seasons),
            ),
          ),
    injurySources.length === 0
      ? Promise.resolve([])
      : database
          .select({
            playerId: playerInjuryReportObservations.playerId,
            season: playerInjuryReportObservations.season,
            week: playerInjuryReportObservations.week,
            reportStatus: playerInjuryReportObservations.reportStatus,
            practiceStatus: playerInjuryReportObservations.practiceStatus,
          })
          .from(playerInjuryReportObservations)
          .innerJoin(players, eq(players.id, playerInjuryReportObservations.playerId))
          .where(
            and(
              inArray(
                playerInjuryReportObservations.sourceId,
                injurySources.map((entry) => entry.id),
              ),
              inArray(
                playerInjuryReportObservations.inputChecksum,
                injurySources.map((entry) => entry.checksum),
              ),
              inArray(playerInjuryReportObservations.season, seasons),
              eq(playerInjuryReportObservations.seasonType, "REG"),
            ),
          ),
    teamStatSources.length === 0
      ? Promise.resolve([])
      : database
          .select({
            season: teamWeeklyStatObservations.season,
            week: teamWeeklyStatObservations.week,
            gameId: teamWeeklyStatObservations.gameId,
            team: teamWeeklyStatObservations.team,
            opponentTeam: teamWeeklyStatObservations.opponentTeam,
            components: teamWeeklyStatObservations.components,
          })
          .from(teamWeeklyStatObservations)
          .where(
            and(
              inArray(
                teamWeeklyStatObservations.sourceId,
                teamStatSources.map((entry) => entry.id),
              ),
              inArray(
                teamWeeklyStatObservations.inputChecksum,
                teamStatSources.map((entry) => entry.checksum),
              ),
              inArray(teamWeeklyStatObservations.season, seasons),
              eq(teamWeeklyStatObservations.seasonType, "REG"),
            ),
          ),
  ]);

  const weekly: ProjectionWeeklyFact[] = weeklyRows.flatMap((row) =>
    row.playerId
      ? [
          {
            playerId: row.playerId,
            position: row.position,
            season: row.season,
            week: row.week,
            gameId: row.gameId,
            team: row.team,
            opponentTeam: row.opponentTeam,
            components: row.components,
            advanced: row.advanced,
          },
        ]
      : [],
  );
  const snaps: ProjectionSnapFact[] = snapRows.flatMap((row) =>
    row.playerId
      ? [
          {
            playerId: row.playerId,
            position: row.position,
            season: row.season,
            week: row.week,
            gameId: row.gameId,
            team: row.team,
            opponentTeam: row.opponentTeam,
            offenseShare: Number(row.offenseShare),
            specialTeamsShare: Number(row.specialTeamsShare),
          },
        ]
      : [],
  );
  const rosters: ProjectionRosterFact[] = rosterRows.flatMap((row) =>
    row.playerId
      ? [
          {
            playerId: row.playerId,
            position: row.position,
            season: row.season,
            week: row.week,
            team: row.team,
            status: row.status,
          },
        ]
      : [],
  );
  const injuries: ProjectionInjuryFact[] = injuryRows.flatMap((row) =>
    row.playerId
      ? [
          {
            playerId: row.playerId,
            season: row.season,
            week: row.week,
            reportStatus: row.reportStatus,
            practiceStatus: row.practiceStatus,
          },
        ]
      : [],
  );
  const teamWeekly: ProjectionTeamWeekFact[] = teamRows.map((row) => ({
    season: row.season,
    week: row.week,
    gameId: row.gameId,
    team: row.team,
    opponentTeam: row.opponentTeam,
    components: row.components,
  }));
  const schedules: ProjectionScheduleFact[] = scheduleRows.map((row) => ({
    season: row.season,
    week: row.week,
    gameId: row.gameId,
    awayTeam: row.awayTeam,
    homeTeam: row.homeTeam,
    awayScore: row.awayScore,
    homeScore: row.homeScore,
    kickoffAt: row.kickoffAt,
    status: row.status,
  }));

  const history = buildFirstPartyPlayerHistory(weekly, snaps, rosters, schedules, injuries);
  const defenseHistory = buildFirstPartyDefenseHistory(teamWeekly, schedules);
  const cutoff = season * 32 + window.asOfWeek;
  const featureHistory = history.filter((row) => row.season * 32 + row.week <= cutoff);
  const trainingHistory = history.filter((row) => row.season < season);
  const defenseFeatureHistory = defenseHistory.filter(
    (row) => row.season * 32 + row.week <= cutoff,
  );
  const defenseTrainingHistory = defenseHistory.filter((row) => row.season < season);
  // Availability/role calibration must be trained strictly before the current season so a live
  // forecast can never leak its own season into its publication decision.
  if (trainingHistory.length === 0) return [];
  let calibration: FirstPartyProjectionCalibration;
  let availabilityCalibration: HistoricalRosAvailabilityCalibration;
  let roleCalibration: HistoricalRosRoleCalibration;
  let kickerCalibration: HistoricalRosKickerCalibration;
  let defenseCalibration: FirstPartyTeamDefenseCalibration;
  try {
    // These three calibrations are fitted ONCE per artifact and shared by every matched league, so
    // their reference profile must not depend on which leagues matched or on their order. It is the
    // artifact's own profile, recovered from the key that IS its identity: deterministic, exact
    // with respect to the artifact, and league-independent. Under per-position matching any single
    // league's profile would be an approximation for every other matched league, since matched
    // leagues now agree only on the positions they share.
    //
    // A position the artifact prices nothing for cannot be matched by any league (a supported
    // position's league-side scoped key is never `"[]"`, so it cannot equal the artifact's empty
    // one), so it is withheld with a stated reason before any player is simulated and a
    // calibration that is degenerate for it can never reach a released projection.
    const referenceProfile = firstPartyRosArtifactScoringProfile(artifact.scoringProfileKey);
    const weeklyBacktest = runFirstPartyProjectionBacktest(trainingHistory);
    calibration = weeklyBacktest.calibration;
    availabilityCalibration = calibrateHistoricalRosAvailability(
      trainingHistory,
      schedules,
      referenceProfile,
    );
    roleCalibration = calibrateHistoricalRosRole(trainingHistory, schedules, referenceProfile);
    // Total by contract (documented fallbacks, never throws), so the kicker calibration cannot
    // trip this league-wide fail-closed catch on a sparse corpus.
    kickerCalibration = calibrateHistoricalRosKicker(
      trainingHistory,
      schedules,
      referenceProfile,
      weeklyBacktest.predictions,
    );
    defenseCalibration = runFirstPartyTeamDefenseBacktest(defenseTrainingHistory).calibration;
  } catch {
    // A calibration that cannot be fitted — including one whose reference profile cannot be
    // recovered from a corrupt artifact key — is a league-wide missing piece: yield nothing.
    return [];
  }

  const futureWindowComplete = futureWindowIsComplete(schedules, season, window);
  const scheduleDates = scheduleRows
    .map((row) => row.sourceAsOf)
    .filter((value): value is Date => value instanceof Date);
  const sourceAsOf =
    scheduleDates.length === 0
      ? context.now
      : new Date(Math.max(...scheduleDates.map((value) => value.getTime())));

  const candidatePool = currentFantasyPlayerPool(rosters, schedules, season);
  if (candidatePool.length === 0) return [];

  const targets: FirstPartyRosPublicationTarget[] = [];
  const targetTemplates = new Map<
    string,
    Omit<FirstPartyRosPublicationTarget, "leagueSeasonId"> | null
  >();
  for (const league of matched) {
    const leagueScoringProfileKey = projectionScoringProfileKey(league.profile);
    const templateKey = aggregateChecksum("live-ros-target-template-v1", [
      leagueScoringProfileKey,
      ...league.matchedPositions,
      "supported",
      ...league.supportedPositions,
    ]);
    if (targetTemplates.has(templateKey)) {
      const template = targetTemplates.get(templateKey);
      if (template !== null && template !== undefined) {
        targets.push({ leagueSeasonId: league.leagueSeasonId, ...template });
      }
      continue;
    }
    const result = buildFirstPartyRosLeagueTarget({
      artifact,
      leagueSeasonId: league.leagueSeasonId,
      scoringProfile: league.profile,
      matchedPositions: league.matchedPositions,
      supportedPositions: league.supportedPositions,
      season,
      window,
      candidatePlayers: candidatePool,
      featureHistory,
      calibration,
      defenseFeatureHistory,
      defenseCalibration,
      availabilityCalibration,
      roleCalibration,
      kickerCalibration,
      injuries,
      schedules,
      futureWindowComplete,
      sourceAsOf,
      asOfAt: context.now,
      ...(options.scenarioCount === undefined ? {} : { scenarioCount: options.scenarioCount }),
      ...(options.convergenceReferenceScenarioCount === undefined
        ? {}
        : { convergenceReferenceScenarioCount: options.convergenceReferenceScenarioCount }),
    });
    if (result.target === null) {
      targetTemplates.set(templateKey, null);
      continue;
    }
    const { leagueSeasonId: ignoredLeagueSeasonId, ...template } = result.target;
    void ignoredLeagueSeasonId;
    targetTemplates.set(templateKey, template);
    targets.push({ leagueSeasonId: league.leagueSeasonId, ...template });
  }
  return targets;
}

function futureWindowIsComplete(
  schedules: readonly ProjectionScheduleFact[],
  season: number,
  window: FirstPartyRosWindow,
): boolean {
  for (let week = window.windowStartWeek; week <= window.windowEndWeek; week += 1) {
    if (!schedules.some((game) => game.season === season && game.week === week)) return false;
  }
  return true;
}

/**
 * Builds the shared preseason/in-season ROS universe from the latest current-season NFL roster
 * facts, then adds one stable app-owned D/ST identity per scheduled team. Fantasy-team rosters are
 * intentionally irrelevant: an undrafted player and a free agent still need an ROS forecast.
 */
export function currentFantasyPlayerPool(
  rosters: readonly ProjectionRosterFact[],
  schedules: readonly ProjectionScheduleFact[],
  season: number,
): readonly FirstPartyRosCandidatePlayer[] {
  const latestByPlayer = new Map<string, ProjectionRosterFact>();
  for (const row of rosters) {
    if (row.season !== season) continue;
    const existing = latestByPlayer.get(row.playerId);
    if (!existing || existing.week < row.week) latestByPlayer.set(row.playerId, row);
  }
  const players_ = [...latestByPlayer.values()].flatMap((row) => {
    const position = normalizePosition(row.position);
    const status = row.status?.trim().toUpperCase() ?? null;
    if (
      !["QB", "RB", "WR", "TE", "K"].includes(position) ||
      row.team.trim().length === 0 ||
      status === "CUT" ||
      status === "RET"
    ) {
      return [];
    }
    return [
      {
        playerId: row.playerId,
        position,
        team: row.team.trim().toUpperCase(),
        ...(row.status === undefined ? {} : { rosterStatus: row.status }),
      },
    ];
  });
  const defenseTeams = [
    ...new Set(
      schedules
        .filter((game) => game.season === season)
        .flatMap((game) => [
          game.awayTeam.trim().toUpperCase(),
          game.homeTeam.trim().toUpperCase(),
        ]),
    ),
  ].sort();
  return [
    ...players_,
    ...defenseTeams.map((team) => ({
      playerId: firstPartyDefensePlayerId(team),
      position: "DST",
      team,
      rosterStatus: "active",
    })),
  ].sort(
    (left, right) =>
      left.position.localeCompare(right.position) || left.playerId.localeCompare(right.playerId),
  );
}
