import { createHash } from "node:crypto";

import { loadEnvironment } from "@fantasy/config";
import {
  createDatabase,
  dataSources,
  nflScheduleObservations,
  playerWeeklyRosterObservations,
  playerWeeklyStatObservations,
  type Database,
  type JsonPrimitive,
} from "@fantasy/db";
import {
  SCHEDULE_EDGE_POSITIONS,
  buildScheduleEdgeGamePositionTotals,
  type ScheduleEdgeGameFact,
  type ScheduleEdgePolicy,
  type ScheduleEdgePosition,
  type ScheduleEdgeWeeklyRosterFact,
  type ScheduleEdgeWeeklyStatFact,
} from "@fantasy/league-analytics";
import {
  normalizeHistoricalPlayerStatComponents,
  scoreProjectionStatComponents,
  type ProjectionScoringProfile,
} from "@fantasy/projections";
import { and, asc, eq } from "drizzle-orm";

import {
  evaluateScheduleEdgeHistory,
  type ScheduleEdgeEvaluationCandidate,
  type ScheduleEdgeEvaluationProfile,
  type ScheduleEdgePlayerGamePoint,
} from "../src/schedule-edge-evaluation.js";

const seasons = [2022, 2023, 2024, 2025] as const;
const heldOutSeasons = [2023, 2024, 2025] as const;

interface AdmittedSource {
  readonly id: string;
  readonly key: string;
  readonly checksum: string;
  readonly metadata: Record<string, JsonPrimitive>;
}

interface HistoricalFacts {
  readonly games: readonly ScheduleEdgeGameFact[];
  readonly stats: readonly ScheduleEdgeWeeklyStatFact[];
  readonly rosters: readonly ScheduleEdgeWeeklyRosterFact[];
  readonly evidenceChecksum: string;
  readonly sources: readonly {
    readonly key: string;
    readonly checksum: string;
    readonly rows: number;
  }[];
}

function profile(name: string, receptions: number): ProjectionScoringProfile {
  return {
    id: `schedule-edge-evaluation-${name}`,
    version: "1",
    rules: [
      { statId: "passing_yards", points: 0.04 },
      { statId: "passing_touchdowns", points: 4 },
      { statId: "passing_interceptions", points: -2 },
      { statId: "rushing_yards", points: 0.1 },
      { statId: "rushing_touchdowns", points: 6 },
      { statId: "receptions", points: receptions },
      { statId: "receiving_yards", points: 0.1 },
      { statId: "receiving_touchdowns", points: 6 },
      { statId: "fumbles_lost", points: -2 },
      { statId: "two_point_conversions", points: 2 },
      { statId: "return_touchdowns", points: 6 },
    ],
  };
}

const profiles = [
  { name: "standard" as const, scoring: profile("standard", 0) },
  { name: "half-ppr" as const, scoring: profile("half-ppr", 0.5) },
  { name: "full-ppr" as const, scoring: profile("full-ppr", 1) },
];

function policy(
  version: string,
  options: {
    readonly offenseShrinkageGames: number;
    readonly defenseShrinkageGames: number;
    readonly priorSeasonPseudoGames: number;
    readonly recencyDecay: number | null;
    readonly minimumCurrentSeasonGamesForLabel?: number;
    readonly minimumPointDifferentialByPosition?: Readonly<Record<ScheduleEdgePosition, number>>;
  },
): ScheduleEdgePolicy {
  return {
    version,
    labelsEnabled: false,
    validatedPositions: [],
    offenseShrinkageGames: options.offenseShrinkageGames,
    defenseShrinkageGames: options.defenseShrinkageGames,
    priorSeasonPseudoGames: options.priorSeasonPseudoGames,
    recencyDecay: options.recencyDecay,
    highConfidenceGames: 8,
    minimumCurrentSeasonGamesForLabel: options.minimumCurrentSeasonGamesForLabel ?? 6,
    allowPriorOnlyLabels: false,
    minimumPointDifferentialByPosition: options.minimumPointDifferentialByPosition ?? {
      QB: 1.5,
      RB: 1,
      WR: 1,
      TE: 0.75,
    },
  };
}

function playerGamesForProfile(
  facts: HistoricalFacts,
  scoringProfile: ProjectionScoringProfile,
): readonly ScheduleEdgePlayerGamePoint[] {
  const supported = new Set<string>(SCHEDULE_EDGE_POSITIONS);
  const gameByTeamWeek = new Map<
    string,
    { readonly gameId: string; readonly defenseTeam: string }
  >();
  for (const game of facts.games) {
    if (game.status !== "final") continue;
    gameByTeamWeek.set(`${game.season}\u0000${game.week}\u0000${game.awayTeam}`, {
      gameId: game.gameId,
      defenseTeam: game.homeTeam,
    });
    gameByTeamWeek.set(`${game.season}\u0000${game.week}\u0000${game.homeTeam}`, {
      gameId: game.gameId,
      defenseTeam: game.awayTeam,
    });
  }
  const activePlayers = new Map<
    string,
    {
      readonly playerId: string;
      readonly season: number;
      readonly week: number;
      readonly team: string;
      readonly positions: Set<string>;
    }
  >();
  for (const row of facts.rosters) {
    if (!row.playerId || row.status?.trim().toUpperCase() !== "ACT") continue;
    const key = `${row.season}\u0000${row.week}\u0000${row.team}\u0000${row.playerId}`;
    const current = activePlayers.get(key) ?? {
      playerId: row.playerId,
      season: row.season,
      week: row.week,
      team: row.team,
      positions: new Set<string>(),
    };
    current.positions.add(row.position.trim().toUpperCase());
    activePlayers.set(key, current);
  }
  const statsByPlayerGame = new Map<string, ScheduleEdgeWeeklyStatFact[]>();
  for (const row of facts.stats) {
    if (!row.playerId) continue;
    const key = `${row.season}\u0000${row.gameId}\u0000${row.playerId}`;
    statsByPlayerGame.set(key, [...(statsByPlayerGame.get(key) ?? []), row]);
  }
  return [...activePlayers.values()]
    .flatMap((player): ScheduleEdgePlayerGamePoint[] => {
      if (player.positions.size !== 1) return [];
      const [position] = player.positions;
      if (!position || !supported.has(position)) return [];
      const game = gameByTeamWeek.get(`${player.season}\u0000${player.week}\u0000${player.team}`);
      if (!game) return [];
      const statRows =
        statsByPlayerGame.get(`${player.season}\u0000${game.gameId}\u0000${player.playerId}`) ?? [];
      if (statRows.length > 1) return [];
      const points =
        statRows.length === 0
          ? 0
          : scoreProjectionStatComponents(
              normalizeHistoricalPlayerStatComponents(statRows[0]!.components),
              scoringProfile,
            );
      return [
        {
          season: player.season,
          week: player.week,
          gameId: game.gameId,
          playerId: player.playerId,
          offenseTeam: player.team,
          defenseTeam: game.defenseTeam,
          position: position as ScheduleEdgePosition,
          points,
        },
      ];
    })
    .sort(
      (left, right) =>
        left.season - right.season ||
        left.week - right.week ||
        left.gameId.localeCompare(right.gameId) ||
        left.playerId.localeCompare(right.playerId),
    );
}

const balancedEqual = policy("schedule-edge-candidate-balanced-equal-v1", {
  offenseShrinkageGames: 4,
  defenseShrinkageGames: 4,
  priorSeasonPseudoGames: 4,
  recencyDecay: null,
});
const conservativeEqual = policy("schedule-edge-candidate-conservative-equal-v1", {
  offenseShrinkageGames: 6,
  defenseShrinkageGames: 6,
  priorSeasonPseudoGames: 6,
  recencyDecay: null,
});
const lightPriorEqual = policy("schedule-edge-candidate-light-prior-equal-v1", {
  offenseShrinkageGames: 4,
  defenseShrinkageGames: 3,
  priorSeasonPseudoGames: 2,
  recencyDecay: null,
});
const lightPriorSupport4 = policy("schedule-edge-candidate-light-prior-support-4-v1", {
  offenseShrinkageGames: 4,
  defenseShrinkageGames: 3,
  priorSeasonPseudoGames: 2,
  recencyDecay: null,
  minimumCurrentSeasonGamesForLabel: 4,
});
const lightPriorSupport8 = policy("schedule-edge-candidate-light-prior-support-8-v1", {
  offenseShrinkageGames: 4,
  defenseShrinkageGames: 3,
  priorSeasonPseudoGames: 2,
  recencyDecay: null,
  minimumCurrentSeasonGamesForLabel: 8,
});
const lightPriorLowerDifferential = policy(
  "schedule-edge-candidate-light-prior-lower-differential-v1",
  {
    offenseShrinkageGames: 4,
    defenseShrinkageGames: 3,
    priorSeasonPseudoGames: 2,
    recencyDecay: null,
    minimumPointDifferentialByPosition: { QB: 1, RB: 0.75, WR: 0.75, TE: 0.5 },
  },
);
const lightPriorHigherDifferential = policy(
  "schedule-edge-candidate-light-prior-higher-differential-v1",
  {
    offenseShrinkageGames: 4,
    defenseShrinkageGames: 3,
    priorSeasonPseudoGames: 2,
    recencyDecay: null,
    minimumPointDifferentialByPosition: { QB: 2, RB: 1.5, WR: 1.5, TE: 1 },
  },
);

const candidates: readonly ScheduleEdgeEvaluationCandidate[] = [
  { id: "raw-equal", estimator: "raw", policy: balancedEqual },
  { id: "adjusted-balanced-equal", estimator: "opponent-adjusted", policy: balancedEqual },
  {
    id: "adjusted-conservative-equal",
    estimator: "opponent-adjusted",
    policy: conservativeEqual,
  },
  { id: "adjusted-light-prior-equal", estimator: "opponent-adjusted", policy: lightPriorEqual },
  {
    id: "adjusted-light-prior-support-4",
    estimator: "opponent-adjusted",
    policy: lightPriorSupport4,
  },
  {
    id: "adjusted-light-prior-support-8",
    estimator: "opponent-adjusted",
    policy: lightPriorSupport8,
  },
  {
    id: "adjusted-light-prior-lower-differential",
    estimator: "opponent-adjusted",
    policy: lightPriorLowerDifferential,
  },
  {
    id: "adjusted-light-prior-higher-differential",
    estimator: "opponent-adjusted",
    policy: lightPriorHigherDifferential,
  },
  {
    id: "adjusted-balanced-recency-0.9",
    estimator: "opponent-adjusted",
    policy: {
      ...balancedEqual,
      version: "schedule-edge-candidate-balanced-recency-0.9-v1",
      recencyDecay: 0.9,
    },
  },
  {
    id: "adjusted-balanced-recency-0.8",
    estimator: "opponent-adjusted",
    policy: {
      ...balancedEqual,
      version: "schedule-edge-candidate-balanced-recency-0.8-v1",
      recencyDecay: 0.8,
    },
  },
];

function canonicalTeam(team: string): string {
  return team === "LA" ? "LAR" : team;
}

async function admittedSource(database: Database, key: string): Promise<AdmittedSource> {
  const [source] = await database
    .select({
      id: dataSources.id,
      key: dataSources.key,
      checksum: dataSources.lastChecksum,
      metadata: dataSources.metadata,
      enabled: dataSources.enabled,
    })
    .from(dataSources)
    .where(eq(dataSources.key, key))
    .limit(1);
  if (!source || !source.enabled || !source.checksum || source.metadata.publishable !== true) {
    throw new Error(`${key} has not cleared source admission.`);
  }
  return { id: source.id, key: source.key, checksum: source.checksum, metadata: source.metadata };
}

async function loadHistoricalFacts(database: Database): Promise<HistoricalFacts> {
  const games: ScheduleEdgeGameFact[] = [];
  const stats: ScheduleEdgeWeeklyStatFact[] = [];
  const rosters: ScheduleEdgeWeeklyRosterFact[] = [];
  const evidence: Array<{ key: string; checksum: string; rows: number }> = [];

  for (const season of seasons) {
    const [scheduleSource, statSource, rosterSource] = await Promise.all([
      admittedSource(database, `nflverse.schedules.${season}`),
      admittedSource(database, `nflverse.stats-player-week.${season}`),
      admittedSource(database, `nflverse.weekly-rosters.${season}`),
    ]);
    const [scheduleRows, statRows, rosterRows] = await Promise.all([
      database
        .select({
          season: nflScheduleObservations.season,
          week: nflScheduleObservations.week,
          gameId: nflScheduleObservations.externalGameId,
          awayTeam: nflScheduleObservations.awayTeam,
          homeTeam: nflScheduleObservations.homeTeam,
          status: nflScheduleObservations.status,
        })
        .from(nflScheduleObservations)
        .where(
          and(
            eq(nflScheduleObservations.sourceId, scheduleSource.id),
            eq(nflScheduleObservations.inputChecksum, scheduleSource.checksum),
            eq(nflScheduleObservations.season, season),
            eq(nflScheduleObservations.seasonType, "REG"),
          ),
        )
        .orderBy(asc(nflScheduleObservations.week), asc(nflScheduleObservations.externalGameId)),
      database
        .select({
          externalPlayerId: playerWeeklyStatObservations.externalPlayerId,
          playerId: playerWeeklyStatObservations.playerId,
          season: playerWeeklyStatObservations.season,
          week: playerWeeklyStatObservations.week,
          gameId: playerWeeklyStatObservations.gameId,
          team: playerWeeklyStatObservations.team,
          opponentTeam: playerWeeklyStatObservations.opponentTeam,
          components: playerWeeklyStatObservations.components,
        })
        .from(playerWeeklyStatObservations)
        .where(
          and(
            eq(playerWeeklyStatObservations.sourceId, statSource.id),
            eq(playerWeeklyStatObservations.inputChecksum, statSource.checksum),
            eq(playerWeeklyStatObservations.season, season),
            eq(playerWeeklyStatObservations.seasonType, "REG"),
          ),
        )
        .orderBy(
          asc(playerWeeklyStatObservations.week),
          asc(playerWeeklyStatObservations.gameId),
          asc(playerWeeklyStatObservations.externalPlayerId),
        ),
      database
        .select({
          externalPlayerId: playerWeeklyRosterObservations.externalPlayerId,
          playerId: playerWeeklyRosterObservations.playerId,
          season: playerWeeklyRosterObservations.season,
          week: playerWeeklyRosterObservations.week,
          team: playerWeeklyRosterObservations.team,
          position: playerWeeklyRosterObservations.position,
          status: playerWeeklyRosterObservations.rosterStatus,
        })
        .from(playerWeeklyRosterObservations)
        .where(
          and(
            eq(playerWeeklyRosterObservations.sourceId, rosterSource.id),
            eq(playerWeeklyRosterObservations.inputChecksum, rosterSource.checksum),
            eq(playerWeeklyRosterObservations.season, season),
          ),
        )
        .orderBy(
          asc(playerWeeklyRosterObservations.week),
          asc(playerWeeklyRosterObservations.team),
          asc(playerWeeklyRosterObservations.externalPlayerId),
        ),
    ]);
    games.push(
      ...scheduleRows.map((row) => ({
        ...row,
        awayTeam: canonicalTeam(row.awayTeam),
        homeTeam: canonicalTeam(row.homeTeam),
      })),
    );
    stats.push(
      ...statRows.map((row) => ({
        ...row,
        team: canonicalTeam(row.team),
        opponentTeam: canonicalTeam(row.opponentTeam),
      })),
    );
    rosters.push(
      ...rosterRows.map((row) => ({
        ...row,
        team: canonicalTeam(row.team),
      })),
    );
    evidence.push(
      { key: scheduleSource.key, checksum: scheduleSource.checksum, rows: scheduleRows.length },
      { key: statSource.key, checksum: statSource.checksum, rows: statRows.length },
      { key: rosterSource.key, checksum: rosterSource.checksum, rows: rosterRows.length },
    );
  }
  const stableEvidence = JSON.stringify(
    [...evidence].sort((left, right) => left.key.localeCompare(right.key)),
  );
  return {
    games,
    stats,
    rosters,
    evidenceChecksum: createHash("sha256").update(stableEvidence, "utf8").digest("hex"),
    sources: evidence,
  };
}

async function main(): Promise<void> {
  const environment = loadEnvironment();
  const { db, close } = createDatabase(environment.DATABASE_URL, 2);
  try {
    const facts = await loadHistoricalFacts(db);
    const evaluationProfiles: ScheduleEdgeEvaluationProfile[] = profiles.map((entry) => ({
      name: entry.name,
      evidenceChecksum: facts.evidenceChecksum,
      totals: buildScheduleEdgeGamePositionTotals({
        games: facts.games,
        weeklyStats: facts.stats,
        weeklyRosters: facts.rosters,
        scoringProfile: entry.scoring,
      }),
      playerGames: playerGamesForProfile(facts, entry.scoring),
    }));
    const candidateSelection = evaluateScheduleEdgeHistory({
      profiles: evaluationProfiles,
      candidates,
      heldOutSeasons: [2023, 2024],
    });
    const selectedCandidate = candidates.find(
      (candidate) => candidate.id === candidateSelection.selectedCandidateId,
    );
    if (!selectedCandidate) throw new Error("Selected Schedule Edge candidate is missing.");
    const confirmation = evaluateScheduleEdgeHistory({
      profiles: evaluationProfiles,
      candidates: [selectedCandidate],
      heldOutSeasons: [2025],
      minimumSamplesPerCell: 100,
      minimumDirectionalSamplesPerCell: 30,
      minimumOrderedSeasons: 1,
    });
    const evaluation = evaluateScheduleEdgeHistory({
      profiles: evaluationProfiles,
      candidates: [selectedCandidate],
      heldOutSeasons,
    });
    const releasePositions = evaluation.positionGates
      .filter((gate) => {
        const selectedGate = candidateSelection.positionGates.find(
          (candidate) => candidate.position === gate.position,
        );
        const confirmationGate = confirmation.positionGates.find(
          (candidate) => candidate.position === gate.position,
        );
        return (
          gate.state === "validated" &&
          selectedGate?.state === "validated" &&
          confirmationGate?.state === "validated"
        );
      })
      .map((gate) => gate.position);
    process.stdout.write(
      `${JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          sources: facts.sources,
          candidateSelection,
          confirmation,
          evaluation,
          releaseDecision: {
            estimator: selectedCandidate.estimator,
            selectedCandidateId: selectedCandidate.id,
            validatedPositions: releasePositions,
            state: releasePositions.length > 0 ? "partially-validated" : "descriptive-only",
          },
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await close();
  }
}

await main();
