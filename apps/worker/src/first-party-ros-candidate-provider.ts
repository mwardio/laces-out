import { createHash } from "node:crypto";

import {
  dataSources,
  fantasyTeams,
  leagueSeasons,
  nflScheduleObservations,
  playerInjuryReportObservations,
  playerSnapCountObservations,
  playerWeeklyRosterObservations,
  playerWeeklyStatObservations,
  players,
  rosterEntries,
  rosterSnapshots,
  scoringRules,
  type Database,
} from "@fantasy/db";
import {
  LEAGUE_SCORING_NORMALIZATION_VERSION,
  normalizeLeagueScoringProfile,
  projectionScoringProfileKey,
  runFirstPartyProjectionBacktest,
  type FirstPartyProjectionCalibration,
  type FirstPartyProjectionPosition,
  type FirstPartyRosLiveReleaseEvidence,
  type FirstPartyWeeklyStatLine,
  type ProjectionScoringProfile,
} from "@fantasy/projections";
import { and, desc, eq, inArray } from "drizzle-orm";

import {
  HISTORICAL_ROS_SUPPORTED_POSITIONS,
  calibrateHistoricalRosAvailability,
  calibrateHistoricalRosRole,
  type HistoricalRosAvailabilityCalibration,
  type HistoricalRosRoleCalibration,
} from "./first-party-ros-backtest.js";
import {
  assembleFirstPartyRosCandidateInputs,
  buildFirstPartyRosLiveReleaseEvidence,
  buildFirstPartyRosPlayerCandidate,
  diagnoseBoundedFirstPartyRosConvergence,
  type FirstPartyRosAssembledCandidateInputs,
  type FirstPartyRosCandidate,
} from "./first-party-ros-candidates.js";
import {
  buildFirstPartyPlayerHistory,
  type ProjectionInjuryFact,
  type ProjectionRosterFact,
  type ProjectionScheduleFact,
  type ProjectionSnapFact,
  type ProjectionWeeklyFact,
} from "./first-party-projection-inputs.js";
import {
  firstPartyAvailableProjectionComponents,
  projectionHistorySeasons,
} from "./first-party-projections.js";
import type {
  FirstPartyRosCandidateContext,
  FirstPartyRosCandidateProvider,
  FirstPartyRosPublicationTarget,
  FirstPartyRosWindow,
} from "./first-party-ros-projections.js";
import type {
  FirstPartyRosReleasedPlayer,
  FirstPartyRosRunConvergence,
  LoadedFirstPartyRosChampionArtifact,
} from "./first-party-ros-publication.js";

const supportedPositions = new Set<string>(HISTORICAL_ROS_SUPPORTED_POSITIONS);

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

/**
 * Enumerates leagues whose exact normalized scoring-profile key equals the champion artifact's
 * `scoringProfileKey`. The artifact authorizes only its own profile, so a league whose rules
 * normalize to any other key — or whose rules cannot be normalized at all — is excluded. Exact
 * digest equality only; no compatibility widening.
 */
export function enumerateFirstPartyRosScoringMatchedLeagues(input: {
  readonly artifactScoringProfileKey: string;
  readonly leagues: readonly FirstPartyRosLeagueRow[];
  readonly rules: readonly FirstPartyRosScoringRuleRow[];
  readonly availableStatIds: readonly string[];
}): readonly FirstPartyRosScoringMatchedLeague[] {
  const rulesByLeague = new Map<string, FirstPartyRosScoringRuleRow[]>();
  for (const rule of input.rules) {
    const rows = rulesByLeague.get(rule.leagueSeasonId) ?? [];
    rows.push(rule);
    rulesByLeague.set(rule.leagueSeasonId, rows);
  }
  const matched: FirstPartyRosScoringMatchedLeague[] = [];
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
    if (normalization.state !== "available") continue;
    if (projectionScoringProfileKey(normalization.profile) !== input.artifactScoringProfileKey) {
      continue;
    }
    matched.push({ leagueSeasonId: league.id, profile: normalization.profile });
  }
  return matched;
}

export interface FirstPartyRosRosteredPlayer {
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
  readonly season: number;
  readonly window: FirstPartyRosWindow;
  readonly rosteredPlayers: readonly FirstPartyRosRosteredPlayer[];
  readonly featureHistory: readonly FirstPartyWeeklyStatLine[];
  readonly calibration: FirstPartyProjectionCalibration;
  readonly availabilityCalibration: HistoricalRosAvailabilityCalibration;
  readonly roleCalibration: HistoricalRosRoleCalibration;
  readonly injuries: readonly ProjectionInjuryFact[];
  readonly schedules: readonly ProjectionScheduleFact[];
  readonly futureWindowComplete: boolean;
  readonly sourceAsOf: Date;
  readonly scenarioCount?: number;
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
  for (const rostered of input.rosteredPlayers) {
    const position = normalizePosition(rostered.position);
    if (!supportedPositions.has(position) || rostered.team === null) continue;
    if (seenPlayers.has(rostered.playerId)) continue;
    seenPlayers.add(rostered.playerId);

    const builderInput = {
      player: {
        playerId: rostered.playerId,
        position: position as FirstPartyProjectionPosition,
        team: rostered.team,
        ...(rostered.rosterStatus === undefined ? {} : { rosterStatus: rostered.rosterStatus }),
      },
      window,
      featureHistory: input.featureHistory,
      calibration: input.calibration,
      availabilityCalibration: input.availabilityCalibration,
      roleCalibration: input.roleCalibration,
      injuries: input.injuries,
      schedules: input.schedules,
      scoringProfile: input.scoringProfile,
      seed: `live-ros:${input.leagueSeasonId}:${input.season}:${window.asOfWeek}:${rostered.playerId}`,
      ...(input.scenarioCount === undefined ? {} : { scenarioCount: input.scenarioCount }),
    };

    const candidate = buildFirstPartyRosPlayerCandidate(builderInput);
    if (candidate === null) {
      skippedPlayers += 1;
      continue;
    }
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
    const assembled = assembleFirstPartyRosCandidateInputs(builderInput);
    if (assembled === null) {
      skippedPlayers += 1;
      continue;
    }
    accepted.push({
      candidate,
      assembled,
      released: {
        playerId: rostered.playerId,
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
    const contextualConvergence = diagnoseBoundedFirstPartyRosConvergence({
      projectionInput: representative.assembled.contextualInput,
      ...(input.scenarioCount === undefined ? {} : { releaseScenarioCount: input.scenarioCount }),
    });
    const recencyConvergence = diagnoseBoundedFirstPartyRosConvergence({
      projectionInput: representative.assembled.recencyInput,
      ...(input.scenarioCount === undefined ? {} : { releaseScenarioCount: input.scenarioCount }),
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
 * candidate builder. Any league whose scoring profile does not exactly match the artifact — or that
 * cannot be fully assembled — yields no target.
 */
export function databaseFirstPartyRosCandidateProvider(input: {
  readonly database: Database;
  readonly scenarioCount?: number;
}): FirstPartyRosCandidateProvider {
  return {
    buildTargets: (context) => buildDatabaseFirstPartyRosTargets(input, context),
  };
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
  options: { readonly database: Database; readonly scenarioCount?: number },
  context: FirstPartyRosCandidateContext,
): Promise<readonly FirstPartyRosPublicationTarget[]> {
  const database = options.database;
  const { season, window, artifact } = context;
  const seasons = projectionHistorySeasons(season);
  const completedSeasons = seasons.filter((candidate) => candidate < season);

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

  const matched = enumerateFirstPartyRosScoringMatchedLeagues({
    artifactScoringProfileKey: artifact.scoringProfileKey,
    leagues: leagueRows,
    rules: ruleRows,
    availableStatIds: firstPartyAvailableProjectionComponents(),
  });
  if (matched.length === 0) return [];

  const sourceKeys = [
    ...seasons.map((candidate) => `nflverse.schedules.${candidate}`),
    ...completedSeasons.map((candidate) => `nflverse.stats-player-week.${candidate}`),
    ...completedSeasons.map((candidate) => `nflverse.snap-counts.${candidate}`),
    ...completedSeasons.map((candidate) => `nflverse.weekly-rosters.${candidate}`),
    ...completedSeasons.map((candidate) => `nflverse.injuries.${candidate}`),
    `nflverse.stats-player-week.${season}`,
    `nflverse.snap-counts.${season}`,
    `nflverse.weekly-rosters.${season}`,
    `nflverse.injuries.${season}`,
  ];
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

  const [scheduleRows, weeklyRows, snapRows, rosterRows, injuryRows] = await Promise.all([
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
            position: players.primaryPosition,
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
  const cutoff = season * 32 + window.asOfWeek;
  const featureHistory = history.filter((row) => row.season * 32 + row.week <= cutoff);
  const trainingHistory = history.filter((row) => row.season < season);
  // Availability/role calibration must be trained strictly before the current season so a live
  // forecast can never leak its own season into its publication decision.
  if (trainingHistory.length === 0) return [];
  const referenceProfile = matched[0]!.profile;
  let calibration: FirstPartyProjectionCalibration;
  let availabilityCalibration: HistoricalRosAvailabilityCalibration;
  let roleCalibration: HistoricalRosRoleCalibration;
  try {
    calibration = runFirstPartyProjectionBacktest(trainingHistory).calibration;
    availabilityCalibration = calibrateHistoricalRosAvailability(
      trainingHistory,
      schedules,
      referenceProfile,
    );
    roleCalibration = calibrateHistoricalRosRole(trainingHistory, schedules, referenceProfile);
  } catch {
    // A calibration that cannot be fitted is a league-wide missing piece: yield nothing.
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

  const rosteredByLeague = await loadRosteredPlayers(
    database,
    matched.map((league) => league.leagueSeasonId),
  );

  const targets: FirstPartyRosPublicationTarget[] = [];
  for (const league of matched) {
    const rosteredPlayers = rosteredByLeague.get(league.leagueSeasonId) ?? [];
    if (rosteredPlayers.length === 0) continue;
    const result = buildFirstPartyRosLeagueTarget({
      artifact,
      leagueSeasonId: league.leagueSeasonId,
      scoringProfile: league.profile,
      season,
      window,
      rosteredPlayers,
      featureHistory,
      calibration,
      availabilityCalibration,
      roleCalibration,
      injuries,
      schedules,
      futureWindowComplete,
      sourceAsOf,
      ...(options.scenarioCount === undefined ? {} : { scenarioCount: options.scenarioCount }),
    });
    if (result.target !== null) targets.push(result.target);
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

async function loadRosteredPlayers(
  database: Database,
  leagueSeasonIds: readonly string[],
): Promise<ReadonlyMap<string, FirstPartyRosRosteredPlayer[]>> {
  const result = new Map<string, FirstPartyRosRosteredPlayer[]>();
  if (leagueSeasonIds.length === 0) return result;
  const snapshotRows = await database
    .select({
      leagueSeasonId: fantasyTeams.leagueSeasonId,
      teamId: fantasyTeams.id,
      snapshotId: rosterSnapshots.id,
      effectiveAt: rosterSnapshots.effectiveAt,
    })
    .from(fantasyTeams)
    .innerJoin(rosterSnapshots, eq(rosterSnapshots.teamId, fantasyTeams.id))
    .where(inArray(fantasyTeams.leagueSeasonId, [...leagueSeasonIds]))
    .orderBy(fantasyTeams.id, desc(rosterSnapshots.effectiveAt), rosterSnapshots.id);
  const latestSnapshotByTeam = new Map<
    string,
    { readonly leagueSeasonId: string; readonly snapshotId: string }
  >();
  for (const row of snapshotRows) {
    if (!latestSnapshotByTeam.has(row.teamId)) {
      latestSnapshotByTeam.set(row.teamId, {
        leagueSeasonId: row.leagueSeasonId,
        snapshotId: row.snapshotId,
      });
    }
  }
  const latestSnapshots = [...latestSnapshotByTeam.values()];
  if (latestSnapshots.length === 0) return result;
  const entryRows = await database
    .select({
      snapshotId: rosterEntries.snapshotId,
      playerId: rosterEntries.playerId,
      primaryPosition: players.primaryPosition,
      nflTeam: players.nflTeam,
    })
    .from(rosterEntries)
    .innerJoin(players, eq(players.id, rosterEntries.playerId))
    .where(
      inArray(
        rosterEntries.snapshotId,
        latestSnapshots.map((row) => row.snapshotId),
      ),
    );
  const leagueBySnapshot = new Map(
    latestSnapshots.map((row) => [row.snapshotId, row.leagueSeasonId]),
  );
  for (const row of entryRows) {
    const leagueSeasonId = leagueBySnapshot.get(row.snapshotId);
    if (!leagueSeasonId) continue;
    const rows = result.get(leagueSeasonId) ?? [];
    rows.push({
      playerId: row.playerId,
      position: row.primaryPosition,
      team: row.nflTeam,
    });
    result.set(leagueSeasonId, rows);
  }
  return result;
}
