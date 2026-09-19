import {
  NflverseInjuriesSource,
  NflversePlayersSource,
  NflverseSchedulesSource,
  NflverseSnapCountsSource,
  NflverseTeamWeeklyStatsSource,
  NflverseWeeklyRostersSource,
  NflverseWeeklyStatsSource,
  NflversePlayByPlaySource,
  snapshotNflversePlayByPlay,
  type NflverseDatasetState,
} from "@laces-out/source-nflverse";

import path from "node:path";
import {
  FIRST_PARTY_ROS_MODEL_VERSION,
  FIRST_PARTY_ROS_OUTCOME_SCHEMA_VERSION,
  type FirstPartyRosPosition,
} from "@laces-out/projections";

import {
  buildHistoricalRosBacktest,
  historicalRosBucket,
  preflightHistoricalRosComponentCoverage,
  HISTORICAL_ROS_SUPPORTED_POSITIONS,
  HISTORICAL_ROS_CANDIDATE_PAIR_VERSION,
  HISTORICAL_ROS_PRODUCTION_BASIS_VERSION,
  type HistoricalRosBacktestResult,
} from "../src/first-party-ros-backtest.js";
import { createRosOutcomeCache } from "../src/ros-outcome-cache.js";
import { createRosOutcomeSimulationPool } from "../src/ros-outcome-simulation-pool.js";
import {
  createRosHistoricalOutcomeEvaluator,
  rosHistoricalOutcomeCacheKey,
} from "../src/ros-historical-outcome-replay.js";
import {
  createRosHistoricalCorpusStore,
  createRetainedV12RosHistoricalCorpusReader,
  ROS_HISTORICAL_ACTUAL_DEFINITION_VERSION,
  ROS_HISTORICAL_CORPUS_SCHEMA_VERSION,
} from "../src/ros-historical-corpus.js";
import {
  replayRosHistoricalCorpus,
  replayRetainedV12RosHistoricalCorpus,
} from "../src/ros-historical-corpus-replay.js";
import {
  ROS_HISTORICAL_CORPUS_BUILD_PROTOCOL,
  ROS_HISTORICAL_CORPUS_RELEASE_THRESHOLDS,
  hasCurrentRosHistoricalCoverageThresholds,
  hasRosHistoricalCorpusReleaseThresholds,
  isCompatibleRosHistoricalCorpusBuildProtocol,
  isRetainedV12RosHistoricalCorpusBuildProtocol,
} from "../src/ros-historical-corpus-protocol.js";
import {
  buildFirstPartyPlayerHistory,
  buildFirstPartyDefenseHistory,
  type ProjectionInjuryFact,
  type ProjectionRosterFact,
  type ProjectionScheduleFact,
  type ProjectionSnapFact,
  type ProjectionTeamWeekFact,
  type ProjectionWeeklyFact,
} from "../src/first-party-projection-inputs.js";
import { firstPartyRosChampionPolicyChecksum } from "../src/first-party-ros-publication.js";
import { rosValidationSourceCache } from "../src/ros-validation-source-cache.js";
import { rosValidationScoringProfileOption } from "../src/ros-validation-profile-option.js";
import {
  FIRST_PARTY_ROS_RELEASE_MAXIMUM_FORECASTS,
  FIRST_PARTY_ROS_RELEASE_PLAYERS_PER_POSITION,
} from "../src/first-party-ros-validation-contract.js";
import {
  ROS_COVERAGE_POSITIONS,
  auditHistoricalRosCoverage,
  type RosCoveragePosition,
  type RosPlayerCoverageFact,
  type RosScheduleCoverageFact,
  type RosHistoricalCoverageReport,
} from "../src/ros-data-coverage.js";
import { nflEasternKickoffAt } from "../src/nflverse-schedules.js";

const emptyState: NflverseDatasetState = {
  etag: null,
  lastModified: null,
  checksumSha256: null,
};

function integerOption(name: string, fallback: number): number {
  const raw = process.argv.find((argument) => argument.startsWith(`${name}=`));
  const value = raw ? Number(raw.slice(name.length + 1)) : fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function integerList(name: string, fallback: string): readonly number[] {
  const raw = process.argv.find((argument) => argument.startsWith(`${name}=`));
  const values = (raw?.slice(name.length + 1) ?? fallback).split(",").map(Number);
  if (values.some((value) => !Number.isSafeInteger(value))) {
    throw new Error(`${name} must contain comma-separated integers`);
  }
  return [...new Set(values)].sort((left, right) => left - right);
}

function positionListOption(): readonly FirstPartyRosPosition[] | undefined {
  const raw = process.argv.find((argument) => argument.startsWith("--positions="));
  if (raw === undefined) return undefined;
  const positions = raw
    .slice("--positions=".length)
    .split(",")
    .map((position) => position.trim().toUpperCase());
  if (positions.length === 0) {
    throw new Error(
      `--positions must contain values from ${HISTORICAL_ROS_SUPPORTED_POSITIONS.join(", ")}`,
    );
  }
  if (
    positions.some(
      (position) => !HISTORICAL_ROS_SUPPORTED_POSITIONS.includes(position as FirstPartyRosPosition),
    )
  ) {
    throw new Error(
      `--positions must contain values from ${HISTORICAL_ROS_SUPPORTED_POSITIONS.join(", ")}`,
    );
  }
  return [...new Set(positions as FirstPartyRosPosition[])].sort();
}

function normalizePosition(value: string): RosCoveragePosition | null {
  const normalized = value.trim().toUpperCase();
  const position =
    normalized === "HB" || normalized === "FB" ? "RB" : normalized === "PK" ? "K" : normalized;
  return ROS_COVERAGE_POSITIONS.includes(position as RosCoveragePosition)
    ? (position as RosCoveragePosition)
    : null;
}

function requireChanged<T extends { readonly state: string }>(
  result: T,
  label: string,
): Extract<T, { readonly state: "changed" }> {
  if (result.state !== "changed") throw new Error(`${label} returned ${result.state}`);
  return result as Extract<T, { readonly state: "changed" }>;
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const outcomeDirectory = process.argv
    .find((value) => value.startsWith("--outcome-cache="))
    ?.slice("--outcome-cache=".length);
  const currentReplayCorpus = process.argv
    .find((value) => value.startsWith("--replay-corpus="))
    ?.slice("--replay-corpus=".length);
  const retainedReplayCorpus = process.argv
    .find((value) => value.startsWith("--replay-retained-v12-corpus="))
    ?.slice("--replay-retained-v12-corpus=".length);
  if (currentReplayCorpus !== undefined && retainedReplayCorpus !== undefined)
    throw new Error("Current and retained-v12 replay modes are mutually exclusive");
  const replayCorpus = retainedReplayCorpus ?? currentReplayCorpus;
  if (replayCorpus !== undefined && !/^[a-f0-9]{64}$/u.test(replayCorpus))
    throw new Error("ROS replay requires a pinned corpus SHA-256 identity");
  if (replayCorpus && !outcomeDirectory)
    throw new Error("--replay-corpus requires --outcome-cache");
  const outcomeCache = outcomeDirectory
    ? createRosOutcomeCache({ directory: outcomeDirectory })
    : undefined;
  const corpusStore = outcomeDirectory
    ? createRosHistoricalCorpusStore({ directory: path.join(outcomeDirectory, "corpora") })
    : undefined;
  let outcomeCorpusIdentity: string | undefined;
  const cacheDirectory = process.argv
    .find((value) => value.startsWith("--source-cache="))
    ?.slice("--source-cache=".length);
  const offline = process.argv.includes("--offline");
  if (offline && !cacheDirectory) throw new Error("--offline requires --source-cache=<directory>");
  const boundedSourceCache = process.argv.some((value) =>
    value.startsWith("--source-cache-max-bytes="),
  );
  if (boundedSourceCache && !cacheDirectory)
    throw new Error("--source-cache-max-bytes requires --source-cache=<directory>");
  const sourceCacheMaxBytes = boundedSourceCache
    ? integerOption("--source-cache-max-bytes", 0)
    : undefined;
  const sourceOptions = cacheDirectory
    ? {
        fetch: rosValidationSourceCache({
          directory: cacheDirectory,
          offline,
          ...(sourceCacheMaxBytes === undefined ? {} : { maxBytes: sourceCacheMaxBytes }),
        }),
      }
    : {};
  const scoringProfile = rosValidationScoringProfileOption(process.argv);
  const seasons = integerList("--seasons", "2019,2020,2021,2022,2023,2024,2025");
  const heldOutSeasons = integerList("--holdouts", "2022,2023,2024,2025");
  const asOfWeeks = integerList("--cutoffs", "1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17");
  const positions = positionListOption();
  // Eight deterministic quantile-stratified players per position/cutoff is the locked release
  // replay. Smaller values remain available explicitly for local exploration, but admission rejects
  // them. The default must therefore be the publication-grade configuration, never the cheaper
  // exploratory configuration that once produced a false K coverage regression.
  const playersPerPosition = integerOption(
    "--players-per-position",
    FIRST_PARTY_ROS_RELEASE_PLAYERS_PER_POSITION,
  );
  const maximumForecasts = integerOption(
    "--max-forecasts",
    FIRST_PARTY_ROS_RELEASE_MAXIMUM_FORECASTS,
  );
  if (heldOutSeasons.length < 3) {
    throw new Error("Historical ROS validation requires at least three holdouts");
  }
  if (heldOutSeasons.some((season) => !seasons.includes(season))) {
    throw new Error("Every holdout must be included in --seasons");
  }
  if (
    heldOutSeasons.some((season) => seasons.filter((candidate) => candidate < season).length < 3)
  ) {
    throw new Error("Every holdout requires at least three earlier source seasons");
  }

  if (replayCorpus) {
    const reader =
      retainedReplayCorpus !== undefined
        ? createRetainedV12RosHistoricalCorpusReader({
            directory: path.join(outcomeDirectory!, "corpora"),
          })
        : corpusStore!;
    const loaded = await reader.read(replayCorpus);
    if (loaded.state !== "hit") throw new Error(`ROS historical corpus is ${loaded.state}`);
    const corpus = loaded.corpus;
    const expectedPositions = positions ?? HISTORICAL_ROS_SUPPORTED_POSITIONS;
    if (
      !(retainedReplayCorpus !== undefined
        ? isRetainedV12RosHistoricalCorpusBuildProtocol(corpus.buildProtocol)
        : isCompatibleRosHistoricalCorpusBuildProtocol(corpus.buildProtocol)) ||
      !hasRosHistoricalCorpusReleaseThresholds(corpus.options) ||
      !hasCurrentRosHistoricalCoverageThresholds(corpus.coverage.thresholds) ||
      JSON.stringify([...corpus.options.heldOutSeasons].sort()) !==
        JSON.stringify([...heldOutSeasons].sort()) ||
      JSON.stringify([...corpus.options.asOfWeeks].sort()) !==
        JSON.stringify([...asOfWeeks].sort()) ||
      JSON.stringify([...corpus.options.positions].sort()) !==
        JSON.stringify([...expectedPositions].sort()) ||
      JSON.stringify(corpus.sourceAudit.map((row) => row.season).sort()) !==
        JSON.stringify([...seasons].sort()) ||
      corpus.options.playersPerPosition !== playersPerPosition ||
      corpus.options.maximumForecasts !== maximumForecasts ||
      corpus.weeklyModelVersion !== HISTORICAL_ROS_CANDIDATE_PAIR_VERSION ||
      corpus.productionBasis !== HISTORICAL_ROS_PRODUCTION_BASIS_VERSION
    )
      throw new Error(
        "ROS historical corpus does not match requested model, seasons or validation scope",
      );
    process.stderr.write(
      `Rescoring immutable football corpus ${replayCorpus} (no source fetch, fitting or simulation)...\n`,
    );
    const replayInput = {
      corpus,
      cache: outcomeCache!,
      scoringProfile: scoringProfile.profile,
    };
    const result =
      retainedReplayCorpus !== undefined
        ? await replayRetainedV12RosHistoricalCorpus({
            ...replayInput,
            expectedIdentity: replayCorpus,
          })
        : await replayRosHistoricalCorpus(replayInput);
    emitReport({
      result,
      positions,
      scoringProfile,
      coverage: corpus.coverage,
      sourceAudit: corpus.sourceAudit,
      startedAt,
      outcomeCorpusIdentity: replayCorpus,
    });
    return;
  }

  process.stderr.write(
    `Scoring profile: ${scoringProfile.key} (${scoringProfile.label}, digest ${scoringProfile.digest.slice(0, 12)})\n`,
  );
  process.stderr.write(
    `Loading official nflverse artifacts for ${seasons.join(", ")} (read-only)...\n`,
  );
  const catalog = requireChanged(
    await new NflversePlayersSource(sourceOptions).check(emptyState),
    "player catalog",
  );
  const gsisByPfr = new Map(
    catalog.players.flatMap((player) =>
      player.pfrId ? ([[player.pfrId, player.gsisId]] as const) : [],
    ),
  );
  const positionByGsis = new Map(
    catalog.players.map((player) => [player.gsisId, player.position] as const),
  );
  const weekly: ProjectionWeeklyFact[] = [];
  const teamWeekly: ProjectionTeamWeekFact[] = [];
  const snaps: ProjectionSnapFact[] = [];
  const rosters: ProjectionRosterFact[] = [];
  const injuries: ProjectionInjuryFact[] = [];
  const schedules: ProjectionScheduleFact[] = [];
  const coveragePlayers: RosPlayerCoverageFact[] = [];
  const coverageSchedules: RosScheduleCoverageFact[] = [];
  const sourceAudit: Array<Record<string, string | number>> = [];

  for (const season of seasons) {
    process.stderr.write(`  ${season}: player/team stats, rosters, injuries, snaps, schedule\n`);
    const playByPlay = snapshotNflversePlayByPlay(
      new NflversePlayByPlaySource(sourceOptions),
      season,
    );
    const [weeklyResult, teamWeeklyResult, rosterResult, injuryResult, snapResult, scheduleResult] =
      await Promise.all([
        new NflverseWeeklyStatsSource({ ...sourceOptions, playByPlay }).check(season, emptyState),
        new NflverseTeamWeeklyStatsSource({
          ...sourceOptions,
          playByPlay,
        }).check(season, emptyState),
        new NflverseWeeklyRostersSource(sourceOptions).check(season, emptyState),
        new NflverseInjuriesSource(sourceOptions).check(season, emptyState),
        new NflverseSnapCountsSource(sourceOptions).check(season, emptyState),
        new NflverseSchedulesSource(sourceOptions).check(
          season,
          { ...emptyState, selectionKey: null },
          { seasonTypes: ["REG"] },
        ),
      ]);
    const weeklyArtifact = requireChanged(weeklyResult, `${season} weekly stats`);
    const teamWeeklyArtifact = requireChanged(teamWeeklyResult, `${season} team weekly stats`);
    const rosterArtifact = requireChanged(rosterResult, `${season} weekly rosters`);
    const injuryArtifact = requireChanged(injuryResult, `${season} injuries`);
    const snapArtifact = requireChanged(snapResult, `${season} snap counts`);
    const scheduleArtifact = requireChanged(scheduleResult, `${season} schedule`);

    for (const row of weeklyArtifact.observations) {
      const position = normalizePosition(row.position);
      if (row.seasonType !== "REG" || !position) continue;
      weekly.push({
        playerId: row.gsisId,
        position,
        season: row.season,
        week: row.week,
        gameId: row.gameId,
        team: row.team,
        opponentTeam: row.opponentTeam,
        components: Object.fromEntries(Object.entries(row.components)),
        advanced: Object.fromEntries(Object.entries(row.advanced)),
      });
      coveragePlayers.push({
        dataset: "weekly-stats",
        season: row.season,
        week: row.week,
        position,
        playerId: row.gsisId,
      });
    }
    for (const row of teamWeeklyArtifact.observations) {
      if (row.seasonType !== "REG") continue;
      teamWeekly.push({
        season: row.season,
        week: row.week,
        gameId: row.gameId,
        team: row.team,
        opponentTeam: row.opponentTeam,
        components: Object.fromEntries(Object.entries(row.components)),
      });
    }
    for (const row of rosterArtifact.observations) {
      const catalogPosition = row.gsisId ? positionByGsis.get(row.gsisId) : undefined;
      const position = normalizePosition(catalogPosition ?? row.position);
      if (row.seasonType !== "REG" || !row.gsisId || !position) continue;
      rosters.push({
        playerId: row.gsisId,
        position,
        season: row.season,
        week: row.week,
        team: row.team,
        status: row.status,
      });
      coveragePlayers.push({
        dataset: "weekly-rosters",
        season: row.season,
        week: row.week,
        position,
        playerId: row.gsisId,
      });
    }
    for (const row of injuryArtifact.observations) {
      const position = normalizePosition(positionByGsis.get(row.gsisId) ?? row.position);
      if (row.seasonType !== "REG" || !position) continue;
      injuries.push({
        playerId: row.gsisId,
        season: row.season,
        week: row.week,
        reportStatus: row.report.status,
        practiceStatus: row.practice.status,
      });
      coveragePlayers.push({
        dataset: "injuries",
        season: row.season,
        week: row.week,
        position,
        playerId: row.gsisId,
      });
    }
    let unresolvedSnaps = 0;
    for (const row of snapArtifact.observations) {
      const position = normalizePosition(row.position);
      const playerId = gsisByPfr.get(row.pfrPlayerId);
      if (row.seasonType !== "REG" || !position || !playerId) {
        unresolvedSnaps += 1;
        continue;
      }
      snaps.push({
        playerId,
        position,
        season: row.season,
        week: row.week,
        gameId: row.gameId,
        team: row.team,
        opponentTeam: row.opponentTeam,
        offenseShare: row.offense.share,
        specialTeamsShare: row.specialTeams.share,
      });
      coveragePlayers.push({
        dataset: "snap-counts",
        season: row.season,
        week: row.week,
        position,
        playerId,
      });
    }
    for (const game of scheduleArtifact.games) {
      schedules.push({
        season: game.season,
        week: game.week,
        gameId: game.gameId,
        awayTeam: game.awayTeam,
        homeTeam: game.homeTeam,
        awayScore: game.awayScore,
        homeScore: game.homeScore,
        kickoffAt: nflEasternKickoffAt(game),
      });
      coverageSchedules.push({
        season: game.season,
        week: game.week,
        gameId: game.gameId,
        complete: game.status === "final" && game.awayScore !== null && game.homeScore !== null,
      });
    }
    sourceAudit.push({
      season,
      weeklyStatsChecksum: weeklyArtifact.checksumSha256,
      playerWeeklyRawChecksum: weeklyArtifact.playerWeeklyChecksumSha256!,
      playerTouchdownPlayByPlayChecksum: weeklyArtifact.playByPlayChecksumSha256!,
      teamWeeklyStatsChecksum: teamWeeklyArtifact.checksumSha256,
      weeklyRosterChecksum: rosterArtifact.checksumSha256,
      injuryChecksum: injuryArtifact.checksumSha256,
      snapChecksum: snapArtifact.checksumSha256,
      scheduleChecksum: scheduleArtifact.checksumSha256,
      unresolvedSnapRows: unresolvedSnaps,
    });
  }

  const coverage = auditHistoricalRosCoverage({
    seasons,
    heldOutSeasons,
    players: coveragePlayers,
    schedules: coverageSchedules,
  });
  if (coverage.state !== "qualified") {
    const output = {
      validationMode: "read-only-first-party-ros-backtest",
      validationScope: {
        positions: positions ?? HISTORICAL_ROS_SUPPORTED_POSITIONS,
        completePortfolio: positions === undefined,
      },
      generatedAt: new Date().toISOString(),
      elapsedSeconds: (Date.now() - startedAt) / 1_000,
      state: "blocked-before-modeling",
      noDatabaseWrites: true,
      noSimulation: true,
      scoringProfile: {
        key: scoringProfile.key,
        label: scoringProfile.label,
        digest: scoringProfile.digest,
      },
      executionIdentity: {
        modelVersion: ROS_HISTORICAL_CORPUS_BUILD_PROTOCOL.modelVersion,
        policyVersion: ROS_HISTORICAL_CORPUS_BUILD_PROTOCOL.policyVersion,
        calibrationVersion: ROS_HISTORICAL_CORPUS_BUILD_PROTOCOL.calibrationVersion,
        scoringProfileKey: scoringProfile.scoringProfileKey,
        evidenceThroughSeason: Math.max(...heldOutSeasons),
      },
      coverage: {
        state: coverage.state,
        fullyHeldOutSeasons: coverage.fullyHeldOutSeasons,
        completeAsOfBatches: coverage.completeAsOfBatches,
        reasons: coverage.reasons,
        seasons: coverage.seasons.map((candidate) => ({
          season: candidate.season,
          reasons: candidate.reasons,
          completeAsOfWeeks: candidate.completeAsOfWeeks,
          eligibleAsOfWeeks: candidate.eligibleAsOfWeeks,
        })),
      },
      sources: sourceAudit,
    };
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    if (!process.argv.includes("--allow-incomplete")) process.exitCode = 1;
    return;
  }

  if (process.argv.includes("--inputs-only")) {
    process.stdout.write(
      `${JSON.stringify(
        {
          state: "inputs-qualified",
          noDatabaseWrites: true,
          sources: sourceAudit,
          coverage: {
            state: coverage.state,
            fullyHeldOutSeasons: coverage.fullyHeldOutSeasons,
            completeAsOfBatches: coverage.completeAsOfBatches,
          },
          elapsedSeconds: (Date.now() - startedAt) / 1_000,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  const history = buildFirstPartyPlayerHistory(weekly, snaps, rosters, schedules, injuries);
  const defenseHistory = buildFirstPartyDefenseHistory(teamWeekly, schedules);
  const componentPreflight = preflightHistoricalRosComponentCoverage({
    history,
    rosters,
    schedules,
    coverage,
    scoringProfile: scoringProfile.profile,
    options: {
      heldOutSeasons,
      asOfWeeks,
      playersPerPosition,
      maximumForecasts,
      ...(positions === undefined ? {} : { positions }),
    },
  });
  if (componentPreflight.state === "blocked" || process.argv.includes("--preflight-only")) {
    process.stdout.write(
      `${JSON.stringify(
        {
          validationMode: "read-only-first-party-ros-backtest",
          validationScope: {
            positions: positions ?? HISTORICAL_ROS_SUPPORTED_POSITIONS,
            completePortfolio: positions === undefined,
          },
          generatedAt: new Date().toISOString(),
          state:
            componentPreflight.state === "qualified"
              ? "component-preflight-qualified"
              : "blocked-before-modeling",
          noDatabaseWrites: true,
          noSimulation: true,
          scoringProfile: {
            key: scoringProfile.key,
            label: scoringProfile.label,
            digest: scoringProfile.digest,
          },
          executionIdentity: {
            modelVersion: ROS_HISTORICAL_CORPUS_BUILD_PROTOCOL.modelVersion,
            policyVersion: ROS_HISTORICAL_CORPUS_BUILD_PROTOCOL.policyVersion,
            calibrationVersion: ROS_HISTORICAL_CORPUS_BUILD_PROTOCOL.calibrationVersion,
            scoringProfileKey: scoringProfile.scoringProfileKey,
            evidenceThroughSeason: Math.max(...heldOutSeasons),
          },
          sources: sourceAudit,
          coverage: {
            state: coverage.state,
            fullyHeldOutSeasons: coverage.fullyHeldOutSeasons,
            completeAsOfBatches: coverage.completeAsOfBatches,
          },
          componentPreflight,
          elapsedSeconds: (Date.now() - startedAt) / 1_000,
        },
        null,
        2,
      )}\n`,
    );
    if (componentPreflight.state === "blocked") process.exitCode = 1;
    return;
  }
  process.stderr.write(
    `Component preflight qualified ${componentPreflight.checkedPlayers} selected player windows across ${componentPreflight.checkedBatches} batches before fitting or simulation.\n`,
  );
  process.stderr.write(
    `Building paired forecasts (${playersPerPosition}/position/cutoff, max ${maximumForecasts}${positions === undefined ? "" : `, positions ${positions.join(",")}`})...\n`,
  );
  let phaseStartedAt = Date.now();
  const simulationAbort = new AbortController();
  const abortSimulation = () => simulationAbort.abort(new Error("ROS corpus build interrupted"));
  process.once("SIGTERM", abortSimulation);
  process.once("SIGINT", abortSimulation);
  const simulationPool = outcomeCache
    ? createRosOutcomeSimulationPool({ signal: simulationAbort.signal })
    : undefined;
  let result: HistoricalRosBacktestResult;
  try {
    result = await buildHistoricalRosBacktest({
      history,
      defenseHistory,
      rosters,
      injuries,
      schedules,
      coverage,
      scoringProfile: scoringProfile.profile,
      ...(outcomeCache && corpusStore
        ? {
            projectionEvaluator: createRosHistoricalOutcomeEvaluator({
              cache: outcomeCache,
              mode: "build",
              signal: simulationAbort.signal,
              simulate: simulationPool!.simulate,
            }),
            onPrepared: async (prepared) => {
              const written = await corpusStore.write({
                schemaVersion: ROS_HISTORICAL_CORPUS_SCHEMA_VERSION,
                actualDefinitionVersion: ROS_HISTORICAL_ACTUAL_DEFINITION_VERSION,
                buildProtocol: ROS_HISTORICAL_CORPUS_BUILD_PROTOCOL,
                modelVersion: FIRST_PARTY_ROS_MODEL_VERSION,
                outcomeSchemaVersion: FIRST_PARTY_ROS_OUTCOME_SCHEMA_VERSION,
                weeklyModelVersion: HISTORICAL_ROS_CANDIDATE_PAIR_VERSION,
                productionBasis: HISTORICAL_ROS_PRODUCTION_BASIS_VERSION,
                sourceChecksums: {
                  catalog: catalog.checksumSha256,
                  ...Object.fromEntries(
                    sourceAudit.flatMap((row) =>
                      Object.entries(row)
                        .filter(([key]) => key.endsWith("Checksum"))
                        .map(([key, value]) => [`${row.season}:${key}`, String(value)]),
                    ),
                  ),
                },
                sourceAudit,
                coverage,
                options: prepared.options,
                seasons: prepared.qualifiedSeasons,
                skippedForecasts: prepared.skippedForecasts,
                kickerFamilyAudit: prepared.kickerFamilyAudits,
                forecasts: prepared.drafts.map((draft) => ({
                  forecast: {
                    playerId: draft.forecast.playerId,
                    position: draft.forecast.position,
                    contextualModelVersion: draft.forecast.contextualModelVersion,
                    recencyModelVersion: draft.forecast.recencyModelVersion,
                    intervalMethodVersion: draft.forecast.intervalMethodVersion,
                    forecastSeason: draft.forecast.forecastSeason,
                    asOfWeek: draft.forecast.asOfWeek,
                    windowStartWeek: draft.forecast.windowStartWeek,
                    windowEndWeek: draft.forecast.windowEndWeek,
                    trainedThroughSeason: draft.forecast.trainedThroughSeason,
                    inputChecksum: draft.forecast.inputChecksum,
                  },
                  contextualKey: rosHistoricalOutcomeCacheKey(draft.contextualInput),
                  recencyKey: rosHistoricalOutcomeCacheKey(draft.recencyInput),
                  actualComponents: draft.actualComponents,
                  coverage: draft.coverage,
                  actualGames: Math.min(draft.actualGames, draft.scheduledGames),
                  scheduledGames: draft.scheduledGames,
                })),
              });
              outcomeCorpusIdentity = written.identity;
              process.stderr.write(
                `Reusable football corpus ${written.identity} is ${written.state}\n`,
              );
            },
          }
        : {}),
      onProgress: (event) => {
        const now = Date.now();
        process.stderr.write(
          `  ${event.stage}${event.season === undefined ? "" : ` ${event.season}`}: ${event.forecasts} forecasts${event.convergenceStrata === undefined ? "" : `, ${event.convergenceStrata} strata`} (${((now - phaseStartedAt) / 1_000).toFixed(1)}s)\n`,
        );
        phaseStartedAt = now;
      },
      options: {
        heldOutSeasons,
        asOfWeeks,
        ...(positions === undefined ? {} : { positions }),
        playersPerPosition,
        maximumForecasts,
        ...ROS_HISTORICAL_CORPUS_RELEASE_THRESHOLDS,
      },
    });
  } finally {
    process.removeListener("SIGTERM", abortSimulation);
    process.removeListener("SIGINT", abortSimulation);
    await simulationPool?.close();
    if (simulationPool)
      process.stderr.write(
        `ROS simulation worker usage ${JSON.stringify(simulationPool.stats())}\n`,
      );
  }

  emitReport({
    result,
    positions,
    scoringProfile,
    coverage,
    sourceAudit,
    startedAt,
    ...(outcomeCorpusIdentity ? { outcomeCorpusIdentity } : {}),
  });
}

function emitReport(input: {
  readonly result: HistoricalRosBacktestResult;
  readonly positions: readonly FirstPartyRosPosition[] | undefined;
  readonly scoringProfile: ReturnType<typeof rosValidationScoringProfileOption>;
  readonly coverage: RosHistoricalCoverageReport;
  readonly sourceAudit: readonly Readonly<Record<string, string | number>>[];
  readonly startedAt: number;
  readonly outcomeCorpusIdentity?: string;
}): void {
  const {
    result,
    positions,
    scoringProfile,
    coverage,
    sourceAudit,
    startedAt,
    outcomeCorpusIdentity,
  } = input;
  // Signed expected-games bias per selected strategy and cell (row-weighted, diagnostic-only):
  // the release gate uses block-weighted MAE, but a signed view identifies systematic hazard
  // mismatch before any threshold tuning is considered.
  const meanOf = (values: readonly number[]): number =>
    values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
  const availabilityAudit = result.champion.livePolicy.choices.map((choice) => {
    const rows = result.heldOutSeasons.flatMap((season) =>
      season.forecasts.filter(
        (forecast) =>
          forecast.position === choice.position &&
          historicalRosBucket(forecast.windowStartWeek, forecast.windowEndWeek) === choice.bucket,
      ),
    );
    const selected = choice.strategy === "contextual" ? "contextual" : "recency";
    const errors = rows.map((forecast) => {
      const expected =
        selected === "contextual"
          ? forecast.evidence.availability.contextualExpectedGames
          : forecast.evidence.availability.recencyExpectedGames;
      return expected - forecast.evidence.availability.actualGames;
    });
    return {
      position: choice.position,
      bucket: choice.bucket,
      strategy: choice.strategy,
      rows: rows.length,
      signedExpectedGamesBias: meanOf(errors),
      expectedGamesRowMae: meanOf(errors.map((error) => Math.abs(error))),
    };
  });
  const output = {
    validationMode: "read-only-first-party-ros-backtest",
    validationScope: {
      positions: positions ?? HISTORICAL_ROS_SUPPORTED_POSITIONS,
      completePortfolio: positions === undefined,
    },
    generatedAt: new Date().toISOString(),
    elapsedSeconds: (Date.now() - startedAt) / 1_000,
    noDatabaseWrites: true,
    sourcePolicy: "official-nflverse-artifacts",
    actualDefinitionVersion: ROS_HISTORICAL_ACTUAL_DEFINITION_VERSION,
    ...(outcomeCorpusIdentity ? { outcomeCorpusIdentity } : {}),
    // Recorded so a report can never be misattributed to a profile it was not graded under. The
    // authoritative identity remains `identityAudit.scoringProfileKey`, which admission compares.
    scoringProfile: {
      key: scoringProfile.key,
      label: scoringProfile.label,
      digest: scoringProfile.digest,
    },
    availabilityAudit,
    coverage: {
      state: coverage.state,
      fullyHeldOutSeasons: coverage.fullyHeldOutSeasons,
      completeAsOfBatches: coverage.completeAsOfBatches,
      totalAsOfBatches: coverage.totalAsOfBatches,
    },
    report: result.report,
    identityAudit: {
      inputChecksums: new Set(
        result.heldOutSeasons.flatMap((season) =>
          season.forecasts.map((forecast) => forecast.inputChecksum),
        ),
      ).size,
      contextualConvergenceChecksums: new Set(
        result.heldOutSeasons.flatMap((season) =>
          season.forecasts.map(
            (forecast) => forecast.evidence.convergence.contextual.diagnosticChecksum,
          ),
        ),
      ).size,
      recencyConvergenceChecksums: new Set(
        result.heldOutSeasons.flatMap((season) =>
          season.forecasts.map(
            (forecast) => forecast.evidence.convergence.recency.diagnosticChecksum,
          ),
        ),
      ).size,
      scoringProfileKey: result.champion.livePolicy.evidenceIdentity?.scoringProfileKey ?? null,
      contextualModelVersion:
        result.champion.livePolicy.evidenceIdentity?.contextualModelVersion ?? null,
      recencyModelVersion: result.champion.livePolicy.evidenceIdentity?.recencyModelVersion ?? null,
      intervalMethodVersion:
        result.champion.livePolicy.evidenceIdentity?.intervalMethodVersion ?? null,
    },
    champion: {
      policyVersion: result.champion.livePolicy.policyVersion,
      meanSelectionEvidenceVersion: result.champion.livePolicy.meanSelectionEvidenceVersion,
      legacyPointImprovementMetric: result.champion.livePolicy.legacyPointImprovementMetric,
      modelVersion: result.champion.livePolicy.modelVersion,
      evidenceThroughSeason: result.champion.livePolicy.evidenceThroughSeason,
      globalBatches: result.champion.livePolicy.globalBatches,
      evidenceIdentity: result.champion.livePolicy.evidenceIdentity,
      publicationPolicyChecksum: firstPartyRosChampionPolicyChecksum(result.champion.livePolicy),
      choices: result.champion.livePolicy.choices.map((choice) => {
        const selected = choice.strategy === "contextual" ? "contextual" : "recency";
        const calibration = choice.intervalCalibrationArtifacts[selected];
        const walkForward = choice.walkForwardCalibrationEvidence[selected];
        return {
          position: choice.position,
          bucket: choice.bucket,
          strategy: choice.strategy,
          reason: choice.reason,
          heldOutSeasons: choice.heldOutSeasons,
          batches: choice.batches,
          samples: choice.samples,
          legacyPointImprovementMetric: "mean-absolute-error",
          contextualMae: choice.contextualMae,
          recencyMae: choice.recencyMae,
          meanSelectionEvidence: choice.meanSelectionEvidence,
          modelImprovement: choice.modelImprovement,
          modelImprovementLowerBound: choice.modelImprovementLowerBound,
          intervalScoreDifferenceUpperBound: choice.intervalScoreDifferenceUpperBound,
          inputCoverage: {
            contextual: choice.heldOutEvidence.contextualMeanInputCoverage,
            recency: choice.heldOutEvidence.recencyMeanInputCoverage,
          },
          convergenceRate: {
            contextual: choice.heldOutEvidence.contextualConvergenceRate,
            recency: choice.heldOutEvidence.recencyConvergenceRate,
          },
          // Uncalibrated simulation-interval hit rates; the release gate judges only the
          // CQR-calibrated walk-forward coverage, but the raw rate shows how much work the
          // conformal expansion is doing.
          observedIntervalCoverage: {
            contextual: choice.heldOutEvidence.contextualObservedIntervalCoverage,
            recency: choice.heldOutEvidence.recencyObservedIntervalCoverage,
          },
          intervalCalibration: choice.intervalCalibration,
          selectedCalibrationState: calibration.state,
          selectedCalibrationCorrectionPoints: calibration.adjustmentPoints,
          selectedHeldOutEvidence: {
            state: choice.heldOutEvidence.state,
            inputCoverage:
              selected === "contextual"
                ? choice.heldOutEvidence.contextualMeanInputCoverage
                : choice.heldOutEvidence.recencyMeanInputCoverage,
            availabilityMae:
              selected === "contextual"
                ? choice.heldOutEvidence.contextualAvailabilityMae
                : choice.heldOutEvidence.recencyAvailabilityMae,
            availabilityBias:
              selected === "contextual"
                ? choice.heldOutEvidence.contextualAvailabilityBias
                : choice.heldOutEvidence.recencyAvailabilityBias,
            convergenceRate:
              selected === "contextual"
                ? choice.heldOutEvidence.contextualConvergenceRate
                : choice.heldOutEvidence.recencyConvergenceRate,
          },
          walkForwardCalibration: {
            state: walkForward.state,
            seasons: walkForward.seasons,
            blocks: walkForward.blocks,
            samples: walkForward.samples,
            observedBlockCoverage: walkForward.observedBlockCoverage,
            nominalCoverage: calibration.nominalCoverage,
            coverageShortfall: calibration.nominalCoverage - walkForward.observedBlockCoverage,
          },
        };
      }),
    },
    // Admission needs the exact executable policy, including immutable calibration artifacts and
    // their checksums. `champion` above remains the concise human-audit summary; it must never be
    // cast back into this richer runtime contract.
    publicationPolicy: result.champion.livePolicy,
    diagnostics: process.argv.includes("--diagnostics")
      ? {
          seasonPolicies: result.champion.seasonPolicies.map((audit) => ({
            season: audit.season,
            evidenceThroughSeason: audit.evidenceThroughSeason,
            choices: audit.policy.choices
              .filter((choice) => positions === undefined || positions.includes(choice.position))
              .map((choice) => ({
                position: choice.position,
                bucket: choice.bucket,
                strategy: choice.strategy,
                reason: choice.reason,
                contextualCalibration: choice.intervalCalibrationArtifacts.contextual,
                recencyCalibration: choice.intervalCalibrationArtifacts.recency,
              })),
          })),
          selected: result.champion.selected.filter(
            (row) => positions === undefined || positions.includes(row.position),
          ),
          // Bounded per-forecast scalar summaries/evidence only; no scenario vectors or histories.
          candidateForecasts: result.heldOutSeasons.flatMap((season) => season.forecasts),
        }
      : undefined,
    sources: process.argv.includes("--full") ? sourceAudit : undefined,
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (result.report.state !== "evidence-ready" && !process.argv.includes("--allow-incomplete")) {
    process.exitCode = 1;
  }
}

await main();
