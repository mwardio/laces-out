import {
  ANALYTICS_EPSILON,
  assertFinite,
  assertNonNegative,
  assertUniqueStrings,
  compareNumbers,
  safeRate,
  sortedUniqueNumbers,
  type MetricDefinition,
} from "./shared.js";

export interface LeagueAnalyticsTeamInput {
  readonly teamId: string;
}

export interface WeeklyTeamPerformanceInput {
  readonly teamId: string;
  /** The official fantasy points credited to this team for the week. */
  readonly points: number;
  /** Defaults to points when optimalLineupPoints is supplied. */
  readonly actualLineupPoints?: number;
  /** Best achievable points supplied by a lineup optimizer or provider-neutral calculation. */
  readonly optimalLineupPoints?: number;
}

export interface WeeklyMatchupInput {
  readonly teamAId: string;
  readonly teamBId: string;
}

export interface LeagueWeekInput {
  readonly week: number;
  readonly performances: readonly WeeklyTeamPerformanceInput[];
  /** Omit or leave empty when the schedule is unavailable. */
  readonly matchups?: readonly WeeklyMatchupInput[];
}

export interface AnalyzeLeagueSeasonInput {
  readonly teams: readonly LeagueAnalyticsTeamInput[];
  readonly weeks: readonly LeagueWeekInput[];
  /** Scores within this distance are treated as tied. Defaults to 1e-9. */
  readonly tieTolerance?: number;
}

export interface RecordSummary {
  readonly wins: number;
  readonly losses: number;
  readonly ties: number;
  readonly games: number;
  /** Wins plus half of ties divided by games; null before any completed game. */
  readonly winPercentage: number | null;
  readonly definition: string;
}

export interface WeeklyAllPlaySummary extends RecordSummary {
  readonly week: number;
  readonly points: number | null;
  readonly missing: boolean;
}

export interface AllPlaySummary extends RecordSummary {
  readonly weekly: readonly WeeklyAllPlaySummary[];
}

export interface PointsSummary {
  readonly total: number;
  readonly average: number | null;
  readonly sampleSize: number;
  readonly definition: string;
}

export interface ExpectedWinsSummary {
  readonly expectedWins: number;
  readonly actualWinEquivalents: number;
  /** Positive means the actual record is ahead of all-play expectation. */
  readonly luckWins: number;
  readonly eligibleMatchups: number;
  readonly definition: string;
}

export interface WeeklyLineupEfficiency {
  readonly week: number;
  readonly actualPoints: number | null;
  readonly optimalPoints: number | null;
  readonly efficiency: number | null;
  readonly pointsLeft: number | null;
  readonly consistentWithOptimal: boolean | null;
  readonly definition: string;
}

export interface LineupEfficiencySummary {
  readonly actualPoints: number;
  readonly optimalPoints: number;
  readonly efficiency: number | null;
  readonly pointsLeft: number;
  readonly eligibleWeeks: number;
  readonly missingWeeks: readonly number[];
  readonly inconsistentWeeks: readonly number[];
  readonly weekly: readonly WeeklyLineupEfficiency[];
  readonly definition: string;
}

export interface WeeklyTeamAnalytics {
  readonly week: number;
  readonly points: number | null;
  readonly missingScore: boolean;
  readonly completedMatchups: number;
  readonly incompleteMatchups: number;
  readonly actualRecord: RecordSummary;
  readonly allPlay: WeeklyAllPlaySummary;
  readonly expectedWins: number | null;
  readonly actualWinEquivalents: number;
  readonly luckWins: number | null;
  readonly pointsAgainst: number | null;
  readonly lineupEfficiency: WeeklyLineupEfficiency;
}

export interface TeamSeasonAnalytics {
  readonly teamId: string;
  readonly scoringWeeks: number;
  readonly missingScoringWeeks: readonly number[];
  readonly completedMatchups: number;
  readonly incompleteMatchups: number;
  readonly pointsFor: PointsSummary;
  readonly pointsAgainst: PointsSummary;
  readonly actualRecord: RecordSummary;
  readonly allPlay: AllPlaySummary;
  readonly expectedWins: ExpectedWinsSummary;
  readonly lineupEfficiency: LineupEfficiencySummary;
  readonly weekly: readonly WeeklyTeamAnalytics[];
}

export interface LeagueSeasonAnalyticsResult {
  readonly teams: readonly TeamSeasonAnalytics[];
  readonly weeks: readonly number[];
  readonly definitions: readonly MetricDefinition[];
}

const ACTUAL_RECORD_DEFINITION =
  "Head-to-head record from scheduled matchups where both teams have a score; missing scores never become losses.";
const ALL_PLAY_DEFINITION =
  "Each scored week compares the team with every other team that has a score: a win for a higher score, a loss for a lower score, and a tie inside the configured tolerance.";
const EXPECTED_WINS_DEFINITION =
  "For each completed head-to-head matchup, expected wins equal that week's all-play win equivalent rate (wins + 0.5 × ties, divided by all-play games). Luck wins are actual win equivalents minus expected wins.";
const POINTS_FOR_DEFINITION =
  "Official points scored, averaged only across weeks where this team has a score.";
const POINTS_AGAINST_DEFINITION =
  "Opponent points from completed scheduled matchups, averaged per completed matchup.";
const LINEUP_EFFICIENCY_DEFINITION =
  "Actual starter points divided by supplied optimal starter points. Season efficiency is ratio-of-totals, so higher-scoring weeks receive proportional weight; it is not capped at 100%.";

export const LEAGUE_SEASON_DEFINITIONS: readonly MetricDefinition[] = [
  { id: "actual-record", label: "Actual record", definition: ACTUAL_RECORD_DEFINITION },
  { id: "all-play", label: "All-play record", definition: ALL_PLAY_DEFINITION },
  { id: "expected-wins", label: "Expected wins and luck", definition: EXPECTED_WINS_DEFINITION },
  { id: "points-for", label: "Points for", definition: POINTS_FOR_DEFINITION },
  { id: "points-against", label: "Points against", definition: POINTS_AGAINST_DEFINITION },
  {
    id: "lineup-efficiency",
    label: "Lineup efficiency",
    definition: LINEUP_EFFICIENCY_DEFINITION,
  },
];

interface MutableRecord {
  wins: number;
  losses: number;
  ties: number;
}

function emptyRecord(): MutableRecord {
  return { wins: 0, losses: 0, ties: 0 };
}

function recordSummary(record: MutableRecord, definition: string): RecordSummary {
  const games = record.wins + record.losses + record.ties;
  return {
    ...record,
    games,
    winPercentage: safeRate(record.wins + record.ties * 0.5, games),
    definition,
  };
}

function addResult(record: MutableRecord, comparison: -1 | 0 | 1): void {
  if (comparison > 0) record.wins += 1;
  else if (comparison < 0) record.losses += 1;
  else record.ties += 1;
}

function lineupRate(actual: number, optimal: number): number | null {
  if (Math.abs(optimal) <= ANALYTICS_EPSILON) {
    return Math.abs(actual) <= ANALYTICS_EPSILON ? 1 : null;
  }
  return actual / optimal;
}

function validateInput(input: AnalyzeLeagueSeasonInput): void {
  if (input.teams.length === 0) throw new RangeError("At least one team is required");
  const teamIds = input.teams.map((team) => team.teamId);
  assertUniqueStrings(teamIds, "team IDs");
  const knownTeamIds = new Set(teamIds);
  assertUniqueStrings(
    input.weeks.map((week) => String(week.week)),
    "weeks",
  );

  const tolerance = input.tieTolerance ?? ANALYTICS_EPSILON;
  assertNonNegative(tolerance, "tieTolerance");

  for (const week of input.weeks) {
    if (!Number.isInteger(week.week) || week.week <= 0) {
      throw new RangeError("week must be a positive integer");
    }
    assertUniqueStrings(
      week.performances.map((performance) => performance.teamId),
      `team IDs in week ${week.week}`,
    );
    for (const performance of week.performances) {
      if (!knownTeamIds.has(performance.teamId)) {
        throw new Error(`Unknown team ${performance.teamId} in week ${week.week}`);
      }
      assertFinite(performance.points, `points for ${performance.teamId} in week ${week.week}`);
      if (performance.actualLineupPoints !== undefined) {
        assertFinite(
          performance.actualLineupPoints,
          `actualLineupPoints for ${performance.teamId} in week ${week.week}`,
        );
      }
      if (performance.optimalLineupPoints !== undefined) {
        assertFinite(
          performance.optimalLineupPoints,
          `optimalLineupPoints for ${performance.teamId} in week ${week.week}`,
        );
      }
    }

    const matchupKeys = new Set<string>();
    for (const matchup of week.matchups ?? []) {
      if (!knownTeamIds.has(matchup.teamAId) || !knownTeamIds.has(matchup.teamBId)) {
        throw new Error(`Unknown matchup team in week ${week.week}`);
      }
      if (matchup.teamAId === matchup.teamBId) {
        throw new Error(`A team cannot play itself in week ${week.week}`);
      }
      const key = [matchup.teamAId, matchup.teamBId].sort().join("\u0000");
      if (matchupKeys.has(key)) {
        throw new Error(`Duplicate matchup in week ${week.week}`);
      }
      matchupKeys.add(key);
    }
  }
}

export function analyzeLeagueSeason(input: AnalyzeLeagueSeasonInput): LeagueSeasonAnalyticsResult {
  validateInput(input);
  const tolerance = input.tieTolerance ?? ANALYTICS_EPSILON;
  const orderedTeams = [...input.teams].sort((left, right) =>
    left.teamId.localeCompare(right.teamId),
  );
  const orderedWeeks = [...input.weeks].sort((left, right) => left.week - right.week);
  const weekNumbers = sortedUniqueNumbers(orderedWeeks.map((week) => week.week));

  const teams = orderedTeams.map((team): TeamSeasonAnalytics => {
    const weekly: WeeklyTeamAnalytics[] = [];
    const seasonActual = emptyRecord();
    const seasonAllPlay = emptyRecord();
    let pointsFor = 0;
    let scoringWeeks = 0;
    let pointsAgainst = 0;
    let completedMatchups = 0;
    let incompleteMatchups = 0;
    let expectedWins = 0;
    let actualWinEquivalents = 0;
    let eligibleExpectedMatchups = 0;
    let totalActualLineupPoints = 0;
    let totalOptimalLineupPoints = 0;
    let eligibleLineupWeeks = 0;
    const missingScoringWeeks: number[] = [];
    const missingLineupWeeks: number[] = [];
    const inconsistentLineupWeeks: number[] = [];

    for (const week of orderedWeeks) {
      const performances = new Map(
        week.performances.map((performance) => [performance.teamId, performance]),
      );
      const performance = performances.get(team.teamId);
      const weeklyActual = emptyRecord();
      const weeklyAllPlayRecord = emptyRecord();
      let weeklyPointsAgainst = 0;
      let weeklyCompletedMatchups = 0;
      let weeklyIncompleteMatchups = 0;

      if (performance === undefined) {
        missingScoringWeeks.push(week.week);
      } else {
        scoringWeeks += 1;
        pointsFor += performance.points;
        for (const opponent of week.performances) {
          if (opponent.teamId === team.teamId) continue;
          addResult(
            weeklyAllPlayRecord,
            compareNumbers(performance.points, opponent.points, tolerance),
          );
        }
      }

      for (const matchup of week.matchups ?? []) {
        let opponentId: string | null = null;
        if (matchup.teamAId === team.teamId) opponentId = matchup.teamBId;
        else if (matchup.teamBId === team.teamId) opponentId = matchup.teamAId;
        if (opponentId === null) continue;

        const opponent = performances.get(opponentId);
        if (performance === undefined || opponent === undefined) {
          weeklyIncompleteMatchups += 1;
          continue;
        }

        const comparison = compareNumbers(performance.points, opponent.points, tolerance);
        addResult(weeklyActual, comparison);
        weeklyPointsAgainst += opponent.points;
        weeklyCompletedMatchups += 1;
      }

      seasonActual.wins += weeklyActual.wins;
      seasonActual.losses += weeklyActual.losses;
      seasonActual.ties += weeklyActual.ties;
      seasonAllPlay.wins += weeklyAllPlayRecord.wins;
      seasonAllPlay.losses += weeklyAllPlayRecord.losses;
      seasonAllPlay.ties += weeklyAllPlayRecord.ties;
      pointsAgainst += weeklyPointsAgainst;
      completedMatchups += weeklyCompletedMatchups;
      incompleteMatchups += weeklyIncompleteMatchups;

      const allPlayGames =
        weeklyAllPlayRecord.wins + weeklyAllPlayRecord.losses + weeklyAllPlayRecord.ties;
      const allPlayEquivalentRate = safeRate(
        weeklyAllPlayRecord.wins + weeklyAllPlayRecord.ties * 0.5,
        allPlayGames,
      );
      const weeklyExpectedWins =
        allPlayEquivalentRate === null || weeklyCompletedMatchups === 0
          ? null
          : allPlayEquivalentRate * weeklyCompletedMatchups;
      const weeklyActualWinEquivalents = weeklyActual.wins + weeklyActual.ties * 0.5;
      if (weeklyExpectedWins !== null) {
        expectedWins += weeklyExpectedWins;
        actualWinEquivalents += weeklyActualWinEquivalents;
        eligibleExpectedMatchups += weeklyCompletedMatchups;
      }

      let actualLineupPoints: number | null = null;
      let optimalLineupPoints: number | null = null;
      let efficiency: number | null = null;
      let pointsLeft: number | null = null;
      let consistentWithOptimal: boolean | null = null;
      if (performance?.optimalLineupPoints !== undefined) {
        actualLineupPoints = performance.actualLineupPoints ?? performance.points;
        optimalLineupPoints = performance.optimalLineupPoints;
        efficiency = lineupRate(actualLineupPoints, optimalLineupPoints);
        pointsLeft = optimalLineupPoints - actualLineupPoints;
        consistentWithOptimal = actualLineupPoints <= optimalLineupPoints + tolerance;
        eligibleLineupWeeks += 1;
        totalActualLineupPoints += actualLineupPoints;
        totalOptimalLineupPoints += optimalLineupPoints;
        if (!consistentWithOptimal) inconsistentLineupWeeks.push(week.week);
      } else {
        missingLineupWeeks.push(week.week);
      }

      const weeklyLineupEfficiency: WeeklyLineupEfficiency = {
        week: week.week,
        actualPoints: actualLineupPoints,
        optimalPoints: optimalLineupPoints,
        efficiency,
        pointsLeft,
        consistentWithOptimal,
        definition: LINEUP_EFFICIENCY_DEFINITION,
      };
      const allPlaySummary: WeeklyAllPlaySummary = {
        week: week.week,
        points: performance?.points ?? null,
        missing: performance === undefined,
        ...recordSummary(weeklyAllPlayRecord, ALL_PLAY_DEFINITION),
      };

      weekly.push({
        week: week.week,
        points: performance?.points ?? null,
        missingScore: performance === undefined,
        completedMatchups: weeklyCompletedMatchups,
        incompleteMatchups: weeklyIncompleteMatchups,
        actualRecord: recordSummary(weeklyActual, ACTUAL_RECORD_DEFINITION),
        allPlay: allPlaySummary,
        expectedWins: weeklyExpectedWins,
        actualWinEquivalents: weeklyActualWinEquivalents,
        luckWins:
          weeklyExpectedWins === null ? null : weeklyActualWinEquivalents - weeklyExpectedWins,
        pointsAgainst: weeklyCompletedMatchups === 0 ? null : weeklyPointsAgainst,
        lineupEfficiency: weeklyLineupEfficiency,
      });
    }

    const allPlayWeekly = weekly.map((item) => item.allPlay);
    return {
      teamId: team.teamId,
      scoringWeeks,
      missingScoringWeeks,
      completedMatchups,
      incompleteMatchups,
      pointsFor: {
        total: pointsFor,
        average: safeRate(pointsFor, scoringWeeks),
        sampleSize: scoringWeeks,
        definition: POINTS_FOR_DEFINITION,
      },
      pointsAgainst: {
        total: pointsAgainst,
        average: safeRate(pointsAgainst, completedMatchups),
        sampleSize: completedMatchups,
        definition: POINTS_AGAINST_DEFINITION,
      },
      actualRecord: recordSummary(seasonActual, ACTUAL_RECORD_DEFINITION),
      allPlay: {
        ...recordSummary(seasonAllPlay, ALL_PLAY_DEFINITION),
        weekly: allPlayWeekly,
      },
      expectedWins: {
        expectedWins,
        actualWinEquivalents,
        luckWins: actualWinEquivalents - expectedWins,
        eligibleMatchups: eligibleExpectedMatchups,
        definition: EXPECTED_WINS_DEFINITION,
      },
      lineupEfficiency: {
        actualPoints: totalActualLineupPoints,
        optimalPoints: totalOptimalLineupPoints,
        efficiency:
          eligibleLineupWeeks === 0
            ? null
            : lineupRate(totalActualLineupPoints, totalOptimalLineupPoints),
        pointsLeft: totalOptimalLineupPoints - totalActualLineupPoints,
        eligibleWeeks: eligibleLineupWeeks,
        missingWeeks: missingLineupWeeks,
        inconsistentWeeks: inconsistentLineupWeeks,
        weekly: weekly.map((item) => item.lineupEfficiency),
        definition: LINEUP_EFFICIENCY_DEFINITION,
      },
      weekly,
    };
  });

  return { teams, weeks: weekNumbers, definitions: LEAGUE_SEASON_DEFINITIONS };
}
