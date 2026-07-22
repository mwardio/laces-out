import {
  applyFirstPartyProjectionChampionPolicy,
  applyFirstPartyProjectionFinalPolicy,
  evaluateFirstPartyBacktestForScoringProfile,
  evaluateFirstPartyTeamDefenseBacktestForScoringProfile,
  runFirstPartyProjectionBacktest,
  runFirstPartyTeamDefenseBacktest,
  type ProjectionScoringProfile,
} from "@fantasy/projections";
import {
  NflversePlayersSource,
  NflverseInjuriesSource,
  NflverseSchedulesSource,
  NflverseSnapCountsSource,
  NflverseTeamWeeklyStatsSource,
  NflverseWeeklyRostersSource,
  NflverseWeeklyStatsSource,
  type NflverseDatasetState,
} from "@fantasy/source-nflverse";

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
