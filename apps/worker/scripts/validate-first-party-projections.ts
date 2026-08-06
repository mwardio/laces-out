import {
  applyFirstPartyProjectionChampionPolicy,
  applyFirstPartyProjectionFinalPolicy,
  evaluateFirstPartyBacktestForScoringProfile,
  evaluateFirstPartyTeamDefenseBacktestForScoringProfile,
  runFirstPartyProjectionBacktest,
  runFirstPartyTeamDefenseBacktest,
  type FirstPartyPointResidualCalibration,
  type FirstPartyTeamDefenseBacktest,
  type FirstPartyTeamDefenseWeeklyStatLine,
  type ProjectionScoringProfile,
} from "@laces-out/projections";
import {
  NflversePlayersSource,
  NflverseInjuriesSource,
  NflverseSchedulesSource,
  NflverseSnapCountsSource,
  NflverseTeamWeeklyStatsSource,
  NflverseWeeklyRostersSource,
  NflverseWeeklyStatsSource,
  type NflverseDatasetState,
} from "@laces-out/source-nflverse";

import {
  buildFirstPartyDefenseHistory,
  buildFirstPartyPlayerHistory,
  type ProjectionScheduleFact,
  type ProjectionInjuryFact,
  type ProjectionRosterFact,
  type ProjectionSnapFact,
  type ProjectionTeamWeekFact,
  type ProjectionWeeklyFact,
} from "../src/first-party-projection-inputs.js";
import { projectionModelGate } from "../src/first-party-projections.js";

const emptyState: NflverseDatasetState = {
  etag: null,
  lastModified: null,
  checksumSha256: null,
};

const validationProfile: ProjectionScoringProfile = {
  id: "validation-ppr",
  version: "1",
  rules: [
    { statId: "passing_yards", points: 0.04 },
    { statId: "passing_touchdowns", points: 4 },
    { statId: "passing_interceptions", points: -2 },
    { statId: "rushing_yards", points: 0.1 },
    { statId: "rushing_touchdowns", points: 6 },
    { statId: "receptions", points: 1 },
    { statId: "receiving_yards", points: 0.1 },
    { statId: "receiving_touchdowns", points: 6 },
    { statId: "fumbles_lost", points: -2 },
    { statId: "field_goals_made_0_39", points: 3 },
    { statId: "field_goals_made_40_49", points: 4 },
    { statId: "field_goals_made_50_plus", points: 5 },
    { statId: "field_goals_missed", points: -1 },
    { statId: "extra_points_made", points: 1 },
    { statId: "defensive_sacks", points: 1 },
    { statId: "defensive_interceptions", points: 2 },
    { statId: "defensive_fumble_recoveries", points: 2 },
    { statId: "defensive_safeties", points: 2 },
    { statId: "defensive_touchdowns", points: 6 },
    { statId: "defensive_blocked_kicks", points: 2 },
    { statId: "special_teams_touchdowns", points: 6 },
    { statId: "points_allowed_0_probability", points: 10 },
    { statId: "points_allowed_1_6_probability", points: 7 },
    { statId: "points_allowed_7_13_probability", points: 4 },
    { statId: "points_allowed_14_20_probability", points: 1 },
    { statId: "points_allowed_21_27_probability", points: 0 },
    { statId: "points_allowed_28_34_probability", points: -1 },
    { statId: "points_allowed_35_plus_probability", points: -4 },
  ],
};

/**
 * The three real ESPN leagues' D/ST scoring, transcribed from the sanitized fixtures in
 * `packages/projections/src/league-scoring.test.ts` (`ESPN_LEAGUE_B_ROWS` and its `:slot:16`
 * override points — identical across all three leagues; stat IDs and point values only, no
 * league/team/member data), expressed as normalized component stat IDs. ESPN IDs 121/122
 * (points allowed 18-21 / 22-27) and 131 (yards allowed 300-349) are absent from every fixture —
 * worth 0 and therefore omitted here.
 */
const espnDefaultDstProfile: ProjectionScoringProfile = {
  id: "espn-default-dst",
  version: "1",
  rules: [
    { statId: "defensive_sacks", points: 1 }, // ESPN 99
    { statId: "defensive_interceptions", points: 2 }, // ESPN 95
    { statId: "defensive_fumble_recoveries", points: 2 }, // ESPN 96
    { statId: "defensive_blocked_kicks", points: 2 }, // ESPN 97
    { statId: "defensive_safeties", points: 2 }, // ESPN 98
    { statId: "defensive_touchdowns", points: 6 }, // ESPN 103/104
    { statId: "special_teams_touchdowns", points: 6 }, // ESPN 93/101/102
    { statId: "points_allowed_0_probability", points: 5 }, // ESPN 89
    { statId: "points_allowed_1_6_probability", points: 4 }, // ESPN 90
    { statId: "points_allowed_7_13_probability", points: 3 }, // ESPN 91
    { statId: "points_allowed_14_17_probability", points: 1 }, // ESPN 92
    { statId: "points_allowed_28_34_probability", points: -1 }, // ESPN 123
    { statId: "points_allowed_35_45_probability", points: -3 }, // ESPN 124
    { statId: "points_allowed_46_plus_probability", points: -5 }, // ESPN 125
    { statId: "yards_allowed_0_99_probability", points: 5 }, // ESPN 128
    { statId: "yards_allowed_100_199_probability", points: 3 }, // ESPN 129
    { statId: "yards_allowed_200_299_probability", points: 2 }, // ESPN 130
    { statId: "yards_allowed_350_399_probability", points: -1 }, // ESPN 132
    { statId: "yards_allowed_400_449_probability", points: -3 }, // ESPN 133
    { statId: "yards_allowed_450_499_probability", points: -5 }, // ESPN 134
    { statId: "yards_allowed_500_549_probability", points: -6 }, // ESPN 135
    { statId: "yards_allowed_550_plus_probability", points: -7 }, // ESPN 136
  ],
};

/**
 * ESPN's evidence-established yards-allowed ladder, restated here only to derive strictly-prior
 * bracket outcomes for the calibration measurement (see
 * `docs/dst-yards-allowed-calibration-2026-07-29.md`). The projector owns the authoritative copy in
 * `packages/projections/src/first-party.ts`.
 */
const espnYardsAllowedLadder = [
  { component: "yards_allowed_0_99_probability", minimum: 0, maximum: 99 },
  { component: "yards_allowed_100_199_probability", minimum: 100, maximum: 199 },
  { component: "yards_allowed_200_299_probability", minimum: 200, maximum: 299 },
  { component: "yards_allowed_300_349_probability", minimum: 300, maximum: 349 },
  { component: "yards_allowed_350_399_probability", minimum: 350, maximum: 399 },
  { component: "yards_allowed_400_449_probability", minimum: 400, maximum: 449 },
  { component: "yards_allowed_450_499_probability", minimum: 450, maximum: 499 },
  {
    component: "yards_allowed_500_549_probability",
    minimum: 500,
    maximum: 549,
  },
  {
    component: "yards_allowed_550_plus_probability",
    minimum: 550,
    maximum: Number.POSITIVE_INFINITY,
  },
] as const;

function usableYardsAllowed(row: FirstPartyTeamDefenseWeeklyStatLine): number | undefined {
  const value = row.components.yards_allowed;
  return value === undefined || !Number.isFinite(value) || value < 0 ? undefined : value;
}

function yardsAllowedBracketIndex(yardsAllowed: number): number {
  return espnYardsAllowedLadder.findIndex(
    (bucket) => yardsAllowed >= bucket.minimum && yardsAllowed <= bucket.maximum,
  );
}

/**
 * Transcribed from `pointEvaluationClearsGate` (`apps/worker/src/first-party-projections.ts`,
 * lines 822-833) and its module constants (`minimumPositionScoredSamples = 100`,
 * `minimumIntervalCoverageSamples = 100`, `minimumIntervalCoverage = 0.62`,
 * `maximumIntervalCoverage = 0.78`, `pointBiasLimit = max(0.5, min(1, mae * 0.15))`). The worker
 * keeps that gate un-exported, so the conditions are restated here verbatim rather than imported;
 * each condition is reported individually so a failing bar names itself.
 */
function espnDstGateConditions(evaluation: FirstPartyPointResidualCalibration): {
  readonly samples: number;
  readonly samplesAtLeast100: boolean;
  readonly baselineMaePositive: boolean;
  readonly maeBeatsBaseline: boolean;
  readonly intervalCoverageInBand: boolean;
  readonly biasWithinLimit: boolean;
  readonly clearsGate: boolean;
} {
  const samplesAtLeast100 = evaluation.samples >= 100;
  const baselineMaePositive = evaluation.baselineMae > 0;
  const maeBeatsBaseline = evaluation.mae <= evaluation.baselineMae;
  const intervalCoverageInBand =
    evaluation.intervalCoverage !== null &&
    evaluation.intervalCoverageSamples >= 100 &&
    evaluation.intervalCoverage >= 0.62 &&
    evaluation.intervalCoverage <= 0.78;
  const biasWithinLimit =
    Math.abs(evaluation.bias) <= Math.max(0.5, Math.min(1, evaluation.mae * 0.15));
  return {
    samples: evaluation.samples,
    samplesAtLeast100,
    baselineMaePositive,
    maeBeatsBaseline,
    intervalCoverageInBand,
    biasWithinLimit,
    clearsGate:
      samplesAtLeast100 &&
      baselineMaePositive &&
      maeBeatsBaseline &&
      intervalCoverageInBand &&
      biasWithinLimit,
  };
}

/**
 * Walk-forward calibration measurement for the yards-allowed ladder (bars 1-3 of
 * `docs/dst-yards-allowed-calibration-2026-07-29.md`). Every prediction in the backtest is already
 * strictly prior; the climatology baseline recomputes each bracket's observed frequency over the
 * defense-history rows strictly before that prediction's season/week, so model and baseline obey
 * the same information discipline. Predictions whose actual row lacks a usable `yards_allowed`
 * are excluded everywhere; predictions with zero strictly-prior usable rows are excluded from
 * both Brier means (there is no climatology to compare against) but still count toward the
 * probability-sum and reliability measurements.
 */
function evaluateEspnDstLadder(
  backtest: FirstPartyTeamDefenseBacktest,
  defenseHistory: readonly FirstPartyTeamDefenseWeeklyStatLine[],
): Record<string, unknown> {
  const ordinalOf = (season: number, week: number): number => season * 100 + week;
  const usableRows = defenseHistory
    .filter((row) => row.played !== false && usableYardsAllowed(row) !== undefined)
    .map((row) => ({
      ordinal: ordinalOf(row.season, row.week),
      bracket: yardsAllowedBracketIndex(usableYardsAllowed(row) ?? 0),
    }))
    .sort((left, right) => left.ordinal - right.ordinal);
  const yardsByRowKey = new Map(
    defenseHistory.map((row) => [
      `${row.team.trim().toUpperCase()}|${row.season}|${row.week}`,
      usableYardsAllowed(row),
    ]),
  );

  let scoredSamples = 0;
  let skippedUnusableActual = 0;
  let skippedNoPriorRows = 0;
  let maxProbabilitySumDeviation = 0;
  let brierModelTotal = 0;
  let brierClimatologyTotal = 0;
  let brierSamples = 0;
  const predictedTotals = espnYardsAllowedLadder.map(() => 0);
  const observedTotals = espnYardsAllowedLadder.map(() => 0);

  for (const prediction of backtest.predictions) {
    const yardsAllowed = yardsByRowKey.get(
      `${prediction.team.trim().toUpperCase()}|${prediction.season}|${prediction.week}`,
    );
    if (yardsAllowed === undefined) {
      skippedUnusableActual += 1;
      continue;
    }
    const outcomeBracket = yardsAllowedBracketIndex(yardsAllowed);
    const predicted = espnYardsAllowedLadder.map(
      (bucket) => prediction.predicted[bucket.component] ?? 0,
    );
    const probabilitySum = predicted.reduce((sum, value) => sum + value, 0);
    maxProbabilitySumDeviation = Math.max(maxProbabilitySumDeviation, Math.abs(probabilitySum - 1));
    scoredSamples += 1;
    for (const [index] of espnYardsAllowedLadder.entries()) {
      predictedTotals[index] = (predictedTotals[index] ?? 0) + (predicted[index] ?? 0);
      observedTotals[index] = (observedTotals[index] ?? 0) + (index === outcomeBracket ? 1 : 0);
    }

    const predictionOrdinal = ordinalOf(prediction.season, prediction.week);
    const priorRows = usableRows.filter((row) => row.ordinal < predictionOrdinal);
    if (priorRows.length === 0) {
      skippedNoPriorRows += 1;
      continue;
    }
    const climatology = espnYardsAllowedLadder.map(
      (_, index) => priorRows.filter((row) => row.bracket === index).length / priorRows.length,
    );
    let brierModel = 0;
    let brierClimatology = 0;
    for (const [index] of espnYardsAllowedLadder.entries()) {
      const outcome = index === outcomeBracket ? 1 : 0;
      brierModel += ((predicted[index] ?? 0) - outcome) ** 2;
      brierClimatology += ((climatology[index] ?? 0) - outcome) ** 2;
    }
    brierModelTotal += brierModel;
    brierClimatologyTotal += brierClimatology;
    brierSamples += 1;
  }

  const brierModel = brierSamples === 0 ? null : brierModelTotal / brierSamples;
  const brierClimatology = brierSamples === 0 ? null : brierClimatologyTotal / brierSamples;
  const evaluation = evaluateFirstPartyTeamDefenseBacktestForScoringProfile(
    backtest,
    espnDefaultDstProfile,
  );
  return {
    profileId: espnDefaultDstProfile.id,
    samples: scoredSamples,
    skippedUnusableActual,
    skippedNoPriorRows,
    probabilitySum: { maxAbsDeviationFromOne: maxProbabilitySumDeviation },
    brackets: espnYardsAllowedLadder.map((bucket, index) => {
      const meanPredicted =
        scoredSamples === 0 ? null : (predictedTotals[index] ?? 0) / scoredSamples;
      const observedFrequency =
        scoredSamples === 0 ? null : (observedTotals[index] ?? 0) / scoredSamples;
      return {
        component: bucket.component,
        samples: scoredSamples,
        meanPredicted,
        observedFrequency,
        reliabilityGap:
          meanPredicted === null || observedFrequency === null
            ? null
            : Math.abs(meanPredicted - observedFrequency),
      };
    }),
    brier: {
      samples: brierSamples,
      model: brierModel,
      climatology: brierClimatology,
      skillScore:
        brierModel === null || brierClimatology === null || brierClimatology === 0
          ? null
          : 1 - brierModel / brierClimatology,
    },
    espnDstEvaluation: {
      overall: evaluation.overall,
      gate: espnDstGateConditions(evaluation.overall),
    },
  };
}

function validationSeasons(): readonly number[] {
  const option = process.argv.find((argument) => argument.startsWith("--seasons="));
  const seasons = (option?.slice("--seasons=".length) ?? "2023,2024,2025").split(",").map(Number);
  if (
    seasons.length < 3 ||
    seasons.some((season) => !Number.isSafeInteger(season) || season < 2012 || season > 2200)
  ) {
    throw new Error("--seasons must contain at least three comma-separated NFL seasons");
  }
  return [...new Set(seasons)].sort((left, right) => left - right);
}

function requireChanged<T extends { readonly state: string }>(
  result: T,
  label: string,
): Extract<T, { readonly state: "changed" }> {
  if (result.state !== "changed") throw new Error(`${label} did not return a complete artifact`);
  return result as Extract<T, { readonly state: "changed" }>;
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const seasons = validationSeasons();
  const playersResult = requireChanged(
    await new NflversePlayersSource().check({
      etag: null,
      lastModified: null,
      checksumSha256: null,
    }),
    "player catalog",
  );
  const gsisByPfr = new Map(
    playersResult.players.flatMap((player) =>
      player.pfrId ? ([[player.pfrId, player.gsisId]] as const) : [],
    ),
  );
  const positionByGsis = new Map(
    playersResult.players.map((player) => [player.gsisId, player.position] as const),
  );
  const weekly: ProjectionWeeklyFact[] = [];
  const snaps: ProjectionSnapFact[] = [];
  const teams: ProjectionTeamWeekFact[] = [];
  const rosters: ProjectionRosterFact[] = [];
  const injuries: ProjectionInjuryFact[] = [];
  const schedules: ProjectionScheduleFact[] = [];
  const sources: Array<Record<string, unknown>> = [];

  for (const season of seasons) {
    const [weeklyResult, snapResult, rosterResult, injuryResult, teamResult, scheduleResult] =
      await Promise.all([
        new NflverseWeeklyStatsSource().check(season, emptyState),
        new NflverseSnapCountsSource().check(season, emptyState),
        new NflverseWeeklyRostersSource().check(season, emptyState),
        new NflverseInjuriesSource().check(season, emptyState),
        new NflverseTeamWeeklyStatsSource().check(season, emptyState),
        new NflverseSchedulesSource().check(
          season,
          { ...emptyState, selectionKey: null },
          { seasonTypes: ["REG"] },
        ),
      ]);
    const weeklyArtifact = requireChanged(weeklyResult, `${season} player weeks`);
    const snapArtifact = requireChanged(snapResult, `${season} snap counts`);
    const rosterArtifact = requireChanged(rosterResult, `${season} weekly rosters`);
    const injuryArtifact = requireChanged(injuryResult, `${season} injury reports`);
    const teamArtifact = requireChanged(teamResult, `${season} team weeks`);
    const scheduleArtifact = requireChanged(scheduleResult, `${season} schedules`);
    weekly.push(
      ...weeklyArtifact.observations
        .filter((row) => row.seasonType === "REG")
        .map((row) => ({
          playerId: row.gsisId,
          position: row.position,
          season: row.season,
          week: row.week,
          gameId: row.gameId,
          team: row.team,
          opponentTeam: row.opponentTeam,
          components: Object.fromEntries(Object.entries(row.components)),
          advanced: Object.fromEntries(Object.entries(row.advanced)),
        })),
    );
    snaps.push(
      ...snapArtifact.observations.flatMap((row): ProjectionSnapFact[] => {
        const playerId = gsisByPfr.get(row.pfrPlayerId);
        return playerId && row.seasonType === "REG"
          ? [
              {
                playerId,
                position: row.position,
                season: row.season,
                week: row.week,
                gameId: row.gameId,
                team: row.team,
                opponentTeam: row.opponentTeam,
                offenseShare: row.offense.share,
                specialTeamsShare: row.specialTeams.share,
              },
            ]
          : [];
      }),
    );
    rosters.push(
      ...rosterArtifact.observations.flatMap((row): ProjectionRosterFact[] => {
        const position = row.gsisId ? positionByGsis.get(row.gsisId) : undefined;
        return row.seasonType === "REG" &&
          row.gsisId &&
          position &&
          ["QB", "RB", "WR", "TE", "K"].includes(position)
          ? [
              {
                playerId: row.gsisId,
                position,
                season: row.season,
                week: row.week,
                team: row.team,
                status: row.status,
              },
            ]
          : [];
      }),
    );
    injuries.push(
      ...injuryArtifact.observations.flatMap((row): ProjectionInjuryFact[] => {
        const position = positionByGsis.get(row.gsisId);
        return row.seasonType === "REG" &&
          position &&
          ["QB", "RB", "WR", "TE", "K"].includes(position)
          ? [
              {
                playerId: row.gsisId,
                season: row.season,
                week: row.week,
                reportStatus: row.report.status,
                practiceStatus: row.practice.status,
              },
            ]
          : [];
      }),
    );
    teams.push(
      ...teamArtifact.observations
        .filter((row) => row.seasonType === "REG")
        .map((row) => ({
          season: row.season,
          week: row.week,
          gameId: row.gameId,
          team: row.team,
          opponentTeam: row.opponentTeam,
          components: row.components,
        })),
    );
    schedules.push(
      ...scheduleArtifact.games.map((game) => ({
        season: game.season,
        week: game.week,
        gameId: game.gameId,
        awayTeam: game.awayTeam,
        homeTeam: game.homeTeam,
        awayScore: game.awayScore,
        homeScore: game.homeScore,
        kickoffAt: null,
      })),
    );
    sources.push({
      season,
      playerWeeks: {
        checksum: weeklyArtifact.checksumSha256,
        rowsRead: weeklyArtifact.rowsRead,
        rowsRejected: weeklyArtifact.rowsRejected,
      },
      snaps: {
        checksum: snapArtifact.checksumSha256,
        rowsRead: snapArtifact.rowsRead,
        rowsRejected: snapArtifact.rowsRejected,
      },
      weeklyRosters: {
        checksum: rosterArtifact.checksumSha256,
        rowsRead: rosterArtifact.rowsRead,
        rowsRejected: rosterArtifact.rowsRejected,
      },
      injuries: {
        checksum: injuryArtifact.checksumSha256,
        rowsRead: injuryArtifact.rowsRead,
        rowsRejected: injuryArtifact.rowsRejected,
      },
      teamWeeks: {
        checksum: teamArtifact.checksumSha256,
        rowsRead: teamArtifact.rowsRead,
        rowsRejected: teamArtifact.rowsRejected,
      },
      schedules: {
        checksum: scheduleArtifact.checksumSha256,
        rowsRead: scheduleArtifact.rowsRead,
        rowsRejected: scheduleArtifact.rowsRejected,
      },
    });
  }

  const playerHistory = buildFirstPartyPlayerHistory(weekly, snaps, rosters, schedules, injuries);
  const basePlayerBacktest = runFirstPartyProjectionBacktest(playerHistory);
  const champion = applyFirstPartyProjectionChampionPolicy(basePlayerBacktest, validationProfile);
  const publicationBacktest = applyFirstPartyProjectionFinalPolicy(
    basePlayerBacktest,
    champion.policy,
  );
  const candidateEvaluation = evaluateFirstPartyBacktestForScoringProfile(
    basePlayerBacktest,
    validationProfile,
  );
  const playerEvaluation = evaluateFirstPartyBacktestForScoringProfile(
    publicationBacktest,
    validationProfile,
  );
  const defenseHistory = buildFirstPartyDefenseHistory(teams, schedules);
  const defenseBacktest = runFirstPartyTeamDefenseBacktest(defenseHistory);
  const defenseEvaluation = evaluateFirstPartyTeamDefenseBacktestForScoringProfile(
    defenseBacktest,
    validationProfile,
  );
  const gate = projectionModelGate({
    player: playerEvaluation,
    defense: defenseEvaluation,
    playerPredictions: publicationBacktest.predictions.length,
    defensePredictions: defenseBacktest.predictions.length,
  });
  const result = {
    validationMode: "champion-rail",
    generatedAt: new Date().toISOString(),
    elapsedSeconds: (Date.now() - startedAt) / 1_000,
    seasons,
    gate,
    sources,
    history: {
      playerRows: playerHistory.length,
      defenseRows: defenseHistory.length,
      matchedSnapRows: snaps.length,
      matchedWeeklyRosterRows: rosters.length,
      matchedInjuryRows: injuries.length,
    },
    player: {
      predictions: champion.backtest.predictions.length,
      evaluation: champion.backtest.evaluation,
      policy: champion.policy,
      qualifiedCandidatePositions: Object.entries(champion.policy.byPosition)
        .filter(([, choice]) => choice?.strategy === "first-party-model")
        .map(([position]) => position),
      fallbackPositions: Object.entries(champion.policy.byPosition)
        .filter(([, choice]) => choice?.strategy === "recency-only")
        .map(([position]) => position),
      candidateOverall: candidateEvaluation.overall,
      championOverall: playerEvaluation.overall,
      byPosition: playerEvaluation.byPosition,
    },
    defense: {
      predictions: defenseBacktest.predictions.length,
      overall: defenseEvaluation.overall,
      espnDstLadder: evaluateEspnDstLadder(defenseBacktest, defenseHistory),
    },
  };
  const output = process.argv.includes("--summary")
    ? {
        validationMode: result.validationMode,
        generatedAt: result.generatedAt,
        elapsedSeconds: result.elapsedSeconds,
        seasons: result.seasons,
        gate: result.gate,
        history: result.history,
        player: {
          predictions: result.player.predictions,
          policy: result.player.policy,
          qualifiedCandidatePositions: result.player.qualifiedCandidatePositions,
          fallbackPositions: result.player.fallbackPositions,
          candidateOverall: result.player.candidateOverall,
          championOverall: result.player.championOverall,
          byPosition: result.player.byPosition,
        },
        defense: result.defense,
      }
    : result;
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (gate.state !== "publishable") {
    throw new Error(`Projection release gate failed: ${gate.reasons.join(", ")}`);
  }
  if (
    process.argv.includes("--require-qualified-candidate") &&
    Object.values(champion.policy.byPosition).every(
      (choice) => choice?.strategy !== "first-party-model",
    )
  ) {
    throw new Error("No player-position candidate qualified over the safe recency baseline");
  }
}

await main();
