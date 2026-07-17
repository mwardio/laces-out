import {
  ANALYTICS_EPSILON,
  assertFinite,
  assertNonNegative,
  assertUniqueStrings,
  compareNumbers,
  safeRate,
} from "./shared.js";

export interface PlayoffSimulationTeamInput {
  readonly teamId: string;
  readonly wins: number;
  readonly losses: number;
  readonly ties: number;
  readonly pointsFor: number;
  /** Future weekly scoring mean; falls back to current points per game, then league mean. */
  readonly projectedPointsPerWeek?: number;
  /** Future weekly score standard deviation; falls back to the simulation default. */
  readonly scoringStandardDeviation?: number;
}

export interface RemainingMatchupInput {
  readonly week: number;
  readonly teamAId: string;
  readonly teamBId: string;
}

export interface SimulatePlayoffOddsInput {
  readonly teams: readonly PlayoffSimulationTeamInput[];
  readonly remainingMatchups: readonly RemainingMatchupInput[];
  readonly playoffTeamCount: number;
  readonly simulations?: number;
  readonly seed?: number | string;
  readonly defaultScoringStandardDeviation?: number;
  readonly tieTolerance?: number;
}

export interface PlayoffSeedProbability {
  readonly seed: number;
  readonly probability: number;
}

export interface TeamPlayoffOdds {
  readonly teamId: string;
  readonly playoffProbability: number;
  readonly monteCarloStandardError: number;
  readonly expectedSeed: number;
  readonly seedProbabilities: readonly PlayoffSeedProbability[];
  readonly averageFinalWins: number;
  readonly averageFinalLosses: number;
  readonly averageFinalTies: number;
  readonly averageFinalPointsFor: number;
  readonly scoringMean: number;
  readonly scoringStandardDeviation: number;
  readonly explanation: string;
}

export interface PlayoffOddsResult {
  readonly teams: readonly TeamPlayoffOdds[];
  readonly simulations: number;
  readonly seed: number | string;
  readonly playoffTeamCount: number;
  readonly definition: string;
  readonly factors: readonly string[];
  readonly tieBreakers: readonly string[];
}

interface SimulationTeam {
  readonly teamId: string;
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
  readonly scoringMean: number;
  readonly scoringStandardDeviation: number;
}

interface SimulationAccumulator {
  playoffAppearances: number;
  seedTotal: number;
  winsTotal: number;
  lossesTotal: number;
  tiesTotal: number;
  pointsForTotal: number;
  readonly seedCounts: number[];
}

const DEFAULT_SIMULATIONS = 10_000;

function hashSeed(seed: number | string): number {
  if (typeof seed === "number") {
    assertFinite(seed, "seed");
    return Math.trunc(seed) >>> 0;
  }
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function createRandom(seed: number | string): () => number {
  let state = hashSeed(seed) || 0x6d2b79f5;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function createNormalRandom(random: () => number): () => number {
  let spare: number | null = null;
  return () => {
    if (spare !== null) {
      const value = spare;
      spare = null;
      return value;
    }
    // Avoid log(0); the generator itself never returns 1.
    const first = Math.max(Number.EPSILON, random());
    const second = random();
    const radius = Math.sqrt(-2 * Math.log(first));
    const angle = 2 * Math.PI * second;
    spare = radius * Math.sin(angle);
    return radius * Math.cos(angle);
  };
}

function gamesPlayed(team: PlayoffSimulationTeamInput): number {
  return team.wins + team.losses + team.ties;
}

function validateInput(input: SimulatePlayoffOddsInput): void {
  if (input.teams.length === 0) throw new RangeError("At least one team is required");
  assertUniqueStrings(
    input.teams.map((team) => team.teamId),
    "team IDs",
  );
  if (
    !Number.isInteger(input.playoffTeamCount) ||
    input.playoffTeamCount <= 0 ||
    input.playoffTeamCount > input.teams.length
  ) {
    throw new RangeError("playoffTeamCount must be between one and the number of teams");
  }
  const simulations = input.simulations ?? DEFAULT_SIMULATIONS;
  if (!Number.isInteger(simulations) || simulations <= 0 || simulations > 1_000_000) {
    throw new RangeError("simulations must be an integer between 1 and 1,000,000");
  }
  assertNonNegative(input.defaultScoringStandardDeviation ?? 15, "defaultScoringStandardDeviation");
  assertNonNegative(input.tieTolerance ?? ANALYTICS_EPSILON, "tieTolerance");

  for (const team of input.teams) {
    assertNonNegative(team.wins, `wins for ${team.teamId}`);
    assertNonNegative(team.losses, `losses for ${team.teamId}`);
    assertNonNegative(team.ties, `ties for ${team.teamId}`);
    if (![team.wins, team.losses, team.ties].every(Number.isInteger)) {
      throw new RangeError(`record values for ${team.teamId} must be integers`);
    }
    assertFinite(team.pointsFor, `pointsFor for ${team.teamId}`);
    if (team.projectedPointsPerWeek !== undefined) {
      assertFinite(team.projectedPointsPerWeek, `projectedPointsPerWeek for ${team.teamId}`);
    }
    if (team.scoringStandardDeviation !== undefined) {
      assertNonNegative(
        team.scoringStandardDeviation,
        `scoringStandardDeviation for ${team.teamId}`,
      );
    }
  }

  const knownTeams = new Set(input.teams.map((team) => team.teamId));
  const matchupKeys = new Set<string>();
  for (const matchup of input.remainingMatchups) {
    if (!Number.isInteger(matchup.week) || matchup.week <= 0) {
      throw new RangeError("remaining matchup week must be a positive integer");
    }
    if (!knownTeams.has(matchup.teamAId) || !knownTeams.has(matchup.teamBId)) {
      throw new Error(`Unknown team in remaining matchup for week ${matchup.week}`);
    }
    if (matchup.teamAId === matchup.teamBId) {
      throw new Error(`A team cannot play itself in week ${matchup.week}`);
    }
    const pair = [matchup.teamAId, matchup.teamBId].sort().join("\u0000");
    const key = `${matchup.week}\u0000${pair}`;
    if (matchupKeys.has(key))
      throw new Error(`Duplicate remaining matchup in week ${matchup.week}`);
    matchupKeys.add(key);
  }
}

function standingsComparison(left: SimulationTeam, right: SimulationTeam): number {
  const leftGames = left.wins + left.losses + left.ties;
  const rightGames = right.wins + right.losses + right.ties;
  const leftPercentage = safeRate(left.wins + left.ties * 0.5, leftGames) ?? 0;
  const rightPercentage = safeRate(right.wins + right.ties * 0.5, rightGames) ?? 0;
  const percentageComparison = compareNumbers(rightPercentage, leftPercentage);
  if (percentageComparison !== 0) return percentageComparison;
  const pointsComparison = compareNumbers(right.pointsFor, left.pointsFor);
  if (pointsComparison !== 0) return pointsComparison;
  return left.teamId.localeCompare(right.teamId);
}

export function simulatePlayoffOdds(input: SimulatePlayoffOddsInput): PlayoffOddsResult {
  validateInput(input);
  const simulations = input.simulations ?? DEFAULT_SIMULATIONS;
  const seed = input.seed ?? 1;
  const defaultDeviation = input.defaultScoringStandardDeviation ?? 15;
  const tieTolerance = input.tieTolerance ?? ANALYTICS_EPSILON;
  const orderedTeams = [...input.teams].sort((left, right) =>
    left.teamId.localeCompare(right.teamId),
  );
  const orderedMatchups = input.remainingMatchups
    .map((matchup): RemainingMatchupInput =>
      matchup.teamAId.localeCompare(matchup.teamBId) <= 0
        ? matchup
        : { week: matchup.week, teamAId: matchup.teamBId, teamBId: matchup.teamAId },
    )
    .sort(
      (left, right) =>
        left.week - right.week ||
        `${left.teamAId}\u0000${left.teamBId}`.localeCompare(
          `${right.teamAId}\u0000${right.teamBId}`,
        ),
    );
  const currentPerGame = orderedTeams.flatMap((team) => {
    const games = gamesPlayed(team);
    return games === 0 ? [] : [team.pointsFor / games];
  });
  const leagueScoringMean =
    currentPerGame.length === 0
      ? 100
      : currentPerGame.reduce((sum, value) => sum + value, 0) / currentPerGame.length;
  const models = orderedTeams.map((team) => ({
    ...team,
    scoringMean:
      team.projectedPointsPerWeek ??
      (gamesPlayed(team) === 0 ? leagueScoringMean : team.pointsFor / gamesPlayed(team)),
    scoringStandardDeviation: team.scoringStandardDeviation ?? defaultDeviation,
  }));
  const accumulators = new Map<string, SimulationAccumulator>(
    orderedTeams.map((team) => [
      team.teamId,
      {
        playoffAppearances: 0,
        seedTotal: 0,
        winsTotal: 0,
        lossesTotal: 0,
        tiesTotal: 0,
        pointsForTotal: 0,
        seedCounts: Array.from({ length: orderedTeams.length }, () => 0),
      },
    ]),
  );
  const normalRandom = createNormalRandom(createRandom(seed));
  const participantsByWeek = new Map<number, Set<string>>();
  for (const matchup of orderedMatchups) {
    const participants = participantsByWeek.get(matchup.week) ?? new Set<string>();
    participants.add(matchup.teamAId);
    participants.add(matchup.teamBId);
    participantsByWeek.set(matchup.week, participants);
  }
  const scoringTeamsByWeek = [...participantsByWeek.entries()]
    .sort(([left], [right]) => left - right)
    .map(([week, participants]) => ({
      week,
      teamIds: [...participants].sort((left, right) => left.localeCompare(right)),
    }));

  for (let simulation = 0; simulation < simulations; simulation += 1) {
    const states = new Map<string, SimulationTeam>(
      models.map((team) => [
        team.teamId,
        {
          teamId: team.teamId,
          wins: team.wins,
          losses: team.losses,
          ties: team.ties,
          pointsFor: team.pointsFor,
          scoringMean: team.scoringMean,
          scoringStandardDeviation: team.scoringStandardDeviation,
        },
      ]),
    );
    const weeklyScores = new Map<string, number>();
    const scoreFor = (week: number, teamId: string): number => {
      const key = `${week}\u0000${teamId}`;
      const cached = weeklyScores.get(key);
      if (cached !== undefined) return cached;
      const team = states.get(teamId);
      if (team === undefined) throw new Error(`Missing simulation team ${teamId}`);
      const score = team.scoringMean + normalRandom() * team.scoringStandardDeviation;
      weeklyScores.set(key, score);
      team.pointsFor += score;
      return score;
    };

    for (const scoringWeek of scoringTeamsByWeek) {
      for (const teamId of scoringWeek.teamIds) {
        scoreFor(scoringWeek.week, teamId);
      }
    }

    for (const matchup of orderedMatchups) {
      const teamA = states.get(matchup.teamAId);
      const teamB = states.get(matchup.teamBId);
      if (teamA === undefined || teamB === undefined) {
        throw new Error("Validated simulation team disappeared");
      }
      const scoreA = scoreFor(matchup.week, matchup.teamAId);
      const scoreB = scoreFor(matchup.week, matchup.teamBId);
      const comparison = compareNumbers(scoreA, scoreB, tieTolerance);
      if (comparison > 0) {
        teamA.wins += 1;
        teamB.losses += 1;
      } else if (comparison < 0) {
        teamA.losses += 1;
        teamB.wins += 1;
      } else {
        teamA.ties += 1;
        teamB.ties += 1;
      }
    }

    const standings = [...states.values()].sort(standingsComparison);
    standings.forEach((team, index) => {
      const accumulator = accumulators.get(team.teamId);
      if (accumulator === undefined) throw new Error("Missing playoff accumulator");
      const finalSeed = index + 1;
      if (finalSeed <= input.playoffTeamCount) accumulator.playoffAppearances += 1;
      accumulator.seedTotal += finalSeed;
      accumulator.winsTotal += team.wins;
      accumulator.lossesTotal += team.losses;
      accumulator.tiesTotal += team.ties;
      accumulator.pointsForTotal += team.pointsFor;
      const currentSeedCount = accumulator.seedCounts[index] ?? 0;
      accumulator.seedCounts[index] = currentSeedCount + 1;
    });
  }

  const teams = models.map((model): TeamPlayoffOdds => {
    const accumulator = accumulators.get(model.teamId);
    if (accumulator === undefined) throw new Error("Missing final playoff accumulator");
    const playoffProbability = accumulator.playoffAppearances / simulations;
    return {
      teamId: model.teamId,
      playoffProbability,
      monteCarloStandardError: Math.sqrt(
        (playoffProbability * (1 - playoffProbability)) / simulations,
      ),
      expectedSeed: accumulator.seedTotal / simulations,
      seedProbabilities: accumulator.seedCounts.map((count, index) => ({
        seed: index + 1,
        probability: count / simulations,
      })),
      averageFinalWins: accumulator.winsTotal / simulations,
      averageFinalLosses: accumulator.lossesTotal / simulations,
      averageFinalTies: accumulator.tiesTotal / simulations,
      averageFinalPointsFor: accumulator.pointsForTotal / simulations,
      scoringMean: model.scoringMean,
      scoringStandardDeviation: model.scoringStandardDeviation,
      explanation:
        "Odds are the share of seeded simulations finishing inside the playoff cutoff; standard error reports Monte Carlo sampling uncertainty, not model uncertainty.",
    };
  });

  return {
    teams,
    simulations,
    seed,
    playoffTeamCount: input.playoffTeamCount,
    definition:
      "Deterministic seeded Monte Carlo simulation. Each team receives one normally distributed score per remaining week (reused for doubleheaders), schedule results update the record, and final standings determine playoff qualification.",
    factors: [
      "Current wins, losses, ties, and points for",
      "Supplied projected weekly scoring mean, or current points per game fallback",
      "Supplied scoring volatility, or configured league fallback",
      "Every supplied remaining matchup",
    ],
    tieBreakers: [
      "Win percentage (wins plus half-ties divided by games)",
      "Total points for",
      "teamId ascending for deterministic exact ties",
    ],
  };
}
