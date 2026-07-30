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
import type {
  LeagueAnalyticsTeamInput,
  LeagueWeekInput,
  WeeklyMatchupInput,
  WeeklyTeamPerformanceInput,
} from "./season.js";

export type WeeklyAwardId = "bad-beat" | "horseshoe" | "bench-warmer" | "beatdown" | "photo-finish";

export type WeeklyAwardWithheldCode =
  | "WEEK_MISSING" // the requested week is not present in weeks[]
  | "MATCHUPS_MISSING" // the week carries no matchups
  | "SCORES_INCOMPLETE" // required scores absent for the candidate matchups
  | "LINEUP_POINTS_MISSING" // optimalLineupPoints not supplied for the week
  | "NO_QUALIFYING_TEAM"; // computed cleanly, nobody met the bar (e.g. no non-tie margin under threshold)

export interface WeeklyAwardWithheldReason {
  readonly code: WeeklyAwardWithheldCode;
  readonly message: string;
}

export interface WeeklyAwardDetail {
  /** The head-to-head opponent, and only from a matchup where both teams have a score. */
  readonly opponentTeamId: string | null;
  readonly teamPoints: number | null;
  readonly opponentPoints: number | null;
  /** All-play win equivalents (wins + 0.5 × ties) that week, so a rate is allPlayWins / allPlayGames. */
  readonly allPlayWins: number | null;
  readonly allPlayGames: number | null;
}

export interface WeeklyAward {
  readonly id: WeeklyAwardId;
  readonly label: string;
  readonly definition: string;
  readonly teamId: string;
  /** The primary number that earned the award. */
  readonly value: number;
  /** Points are league-scored points; a percent value is a 0-1 rate the caller renders. */
  readonly unit: "points" | "percent";
  readonly detail: WeeklyAwardDetail;
}

export interface WithheldWeeklyAward {
  readonly id: WeeklyAwardId;
  readonly label: string;
  readonly reasons: readonly WeeklyAwardWithheldReason[];
}

export interface CalculateWeeklyAwardsInput {
  readonly teams: readonly LeagueAnalyticsTeamInput[];
  readonly weeks: readonly LeagueWeekInput[];
  /** The week to award. */
  readonly week: number;
  /** Scores within this distance are treated as tied. Defaults to 1e-9. */
  readonly tieTolerance?: number;
  /** Photo Finish only fires at or below this margin. Defaults to 3. */
  readonly photoFinishThreshold?: number;
}

export interface WeeklyAwardsResult {
  readonly week: number;
  readonly awards: readonly WeeklyAward[];
  readonly withheld: readonly WithheldWeeklyAward[];
  readonly definitions: readonly MetricDefinition[];
}

export const DEFAULT_PHOTO_FINISH_THRESHOLD = 3;

/** Presentation order; every result lists awards and withheld awards in this order. */
const AWARD_ORDER: readonly WeeklyAwardId[] = [
  "bad-beat",
  "horseshoe",
  "bench-warmer",
  "beatdown",
  "photo-finish",
];

const AWARD_LABELS: Readonly<Record<WeeklyAwardId, string>> = {
  "bad-beat": "Bad Beat of the Week",
  horseshoe: "The Horseshoe",
  "bench-warmer": "Bench Warmer",
  beatdown: "Beatdown of the Week",
  "photo-finish": "Photo Finish",
};

const AWARD_DEFINITIONS: Readonly<Record<WeeklyAwardId, string>> = {
  "bad-beat":
    "Among teams that lost a head-to-head matchup where both teams have a score, the highest all-play win rate that week: wins plus half of ties against every other team with a score, divided by those comparisons.",
  horseshoe:
    "Among teams that won a head-to-head matchup where both teams have a score, the lowest all-play win rate that week, calculated the same way as Bad Beat.",
  "bench-warmer":
    "The most points left on the bench: supplied optimal lineup points minus supplied actual lineup points. It is withheld unless a team supplies both numbers and the optimal lineup is at least the actual lineup.",
  beatdown:
    "The largest margin of victory among matchups where both teams have a score; a result inside the tie tolerance produces no winner.",
  "photo-finish":
    "The smallest margin of victory outside the tie tolerance, awarded only when that margin is at or below the configured Photo Finish threshold.",
};

export const WEEKLY_AWARD_DEFINITIONS: readonly MetricDefinition[] = AWARD_ORDER.map((id) => ({
  id,
  label: AWARD_LABELS[id],
  definition: AWARD_DEFINITIONS[id],
}));

interface WeeklyAllPlay {
  readonly teamId: string;
  readonly points: number;
  /** Wins plus half of ties against every other team with a score that week. */
  readonly winEquivalents: number;
  readonly games: number;
  readonly rate: number | null;
}

interface CompletedMatchup {
  readonly teamAId: string;
  readonly teamBId: string;
  readonly teamAPoints: number;
  readonly teamBPoints: number;
  /** 1 when team A won, -1 when team B won, 0 inside the tie tolerance. */
  readonly comparison: -1 | 0 | 1;
  readonly margin: number;
}

interface WeekContext {
  readonly week: number;
  readonly photoFinishThreshold: number;
  readonly performances: readonly WeeklyTeamPerformanceInput[];
  readonly allPlay: ReadonlyMap<string, WeeklyAllPlay>;
  readonly scheduledMatchups: number;
  readonly completed: readonly CompletedMatchup[];
}

interface AwardCandidate {
  readonly teamId: string;
  readonly opponentTeamId: string | null;
  readonly value: number;
}

type AwardOutcome =
  | { readonly kind: "award"; readonly award: WeeklyAward }
  | { readonly kind: "withheld"; readonly withheld: WithheldWeeklyAward };

function validateLeagueInput(input: Omit<CalculateWeeklyAwardsInput, "week">): void {
  if (input.teams.length === 0) throw new RangeError("At least one team is required");
  const teamIds = input.teams.map((team) => team.teamId);
  assertUniqueStrings(teamIds, "team IDs");
  const knownTeamIds = new Set(teamIds);
  assertUniqueStrings(
    input.weeks.map((week) => String(week.week)),
    "weeks",
  );

  assertNonNegative(input.tieTolerance ?? ANALYTICS_EPSILON, "tieTolerance");
  assertNonNegative(
    input.photoFinishThreshold ?? DEFAULT_PHOTO_FINISH_THRESHOLD,
    "photoFinishThreshold",
  );

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

function buildAllPlay(
  performances: readonly WeeklyTeamPerformanceInput[],
  tolerance: number,
): ReadonlyMap<string, WeeklyAllPlay> {
  const allPlay = new Map<string, WeeklyAllPlay>();
  for (const performance of performances) {
    let wins = 0;
    let ties = 0;
    let games = 0;
    for (const opponent of performances) {
      if (opponent.teamId === performance.teamId) continue;
      const comparison = compareNumbers(performance.points, opponent.points, tolerance);
      if (comparison > 0) wins += 1;
      else if (comparison === 0) ties += 1;
      games += 1;
    }
    const winEquivalents = wins + ties * 0.5;
    allPlay.set(performance.teamId, {
      teamId: performance.teamId,
      points: performance.points,
      winEquivalents,
      games,
      rate: safeRate(winEquivalents, games),
    });
  }
  return allPlay;
}

function buildCompletedMatchups(
  matchups: readonly WeeklyMatchupInput[],
  performances: ReadonlyMap<string, WeeklyTeamPerformanceInput>,
  tolerance: number,
): readonly CompletedMatchup[] {
  return matchups.flatMap((matchup) => {
    const teamA = performances.get(matchup.teamAId);
    const teamB = performances.get(matchup.teamBId);
    // A matchup is completed only when both teams have a stored score; a
    // missing score never becomes a loss and never earns anyone an award.
    if (teamA === undefined || teamB === undefined) return [];
    return [
      {
        teamAId: matchup.teamAId,
        teamBId: matchup.teamBId,
        teamAPoints: teamA.points,
        teamBPoints: teamB.points,
        comparison: compareNumbers(teamA.points, teamB.points, tolerance),
        margin: Math.abs(teamA.points - teamB.points),
      },
    ];
  });
}

function winnerOf(matchup: CompletedMatchup): string {
  return matchup.comparison > 0 ? matchup.teamAId : matchup.teamBId;
}

function loserOf(matchup: CompletedMatchup): string {
  return matchup.comparison > 0 ? matchup.teamBId : matchup.teamAId;
}

/**
 * The head-to-head opponent used for award detail. A team can appear in more
 * than one matchup in a week, so the lexicographically smallest opponent is
 * chosen to keep the result independent of input order.
 */
function opponentsByOutcome(
  completed: readonly CompletedMatchup[],
  outcome: "win" | "loss" | "any",
): ReadonlyMap<string, string> {
  const opponents = new Map<string, string>();
  const remember = (teamId: string, opponentId: string): void => {
    const existing = opponents.get(teamId);
    if (existing === undefined || opponentId.localeCompare(existing) < 0) {
      opponents.set(teamId, opponentId);
    }
  };

  for (const matchup of completed) {
    if (outcome === "any") {
      remember(matchup.teamAId, matchup.teamBId);
      remember(matchup.teamBId, matchup.teamAId);
      continue;
    }
    if (matchup.comparison === 0) continue;
    const winner = winnerOf(matchup);
    const loser = loserOf(matchup);
    if (outcome === "win") remember(winner, loser);
    else remember(loser, winner);
  }
  return opponents;
}

/**
 * A strict total order over (value, teamId, opponentTeamId). Values are
 * compared exactly rather than within the tie tolerance so that the winner
 * never depends on the order the candidates arrived in.
 */
function isBetterCandidate(
  candidate: AwardCandidate,
  incumbent: AwardCandidate,
  highestWins: boolean,
): boolean {
  if (candidate.value !== incumbent.value) {
    return highestWins ? candidate.value > incumbent.value : candidate.value < incumbent.value;
  }
  const byTeam = candidate.teamId.localeCompare(incumbent.teamId);
  if (byTeam !== 0) return byTeam < 0;
  return (candidate.opponentTeamId ?? "").localeCompare(incumbent.opponentTeamId ?? "") < 0;
}

function pickCandidate(
  candidates: readonly AwardCandidate[],
  highestWins: boolean,
): AwardCandidate | null {
  let best: AwardCandidate | null = null;
  for (const candidate of candidates) {
    if (best === null || isBetterCandidate(candidate, best, highestWins)) best = candidate;
  }
  return best;
}

function formatPoints(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function withheldOutcome(
  id: WeeklyAwardId,
  code: WeeklyAwardWithheldCode,
  message: string,
): AwardOutcome {
  return {
    kind: "withheld",
    withheld: { id, label: AWARD_LABELS[id], reasons: [{ code, message }] },
  };
}

function awardOutcome(
  context: WeekContext,
  id: WeeklyAwardId,
  candidate: AwardCandidate,
  unit: "points" | "percent",
): AwardOutcome {
  const team = context.allPlay.get(candidate.teamId);
  const opponent =
    candidate.opponentTeamId === null ? undefined : context.allPlay.get(candidate.opponentTeamId);
  return {
    kind: "award",
    award: {
      id,
      label: AWARD_LABELS[id],
      definition: AWARD_DEFINITIONS[id],
      teamId: candidate.teamId,
      value: candidate.value,
      unit,
      detail: {
        opponentTeamId: opponent === undefined ? null : opponent.teamId,
        teamPoints: team?.points ?? null,
        opponentPoints: opponent?.points ?? null,
        allPlayWins: team?.winEquivalents ?? null,
        allPlayGames: team?.games ?? null,
      },
    },
  };
}

/** The gate every head-to-head award shares: a schedule, then scores for it. */
function matchupGate(context: WeekContext, id: WeeklyAwardId): AwardOutcome | null {
  if (context.scheduledMatchups === 0) {
    return withheldOutcome(
      id,
      "MATCHUPS_MISSING",
      `Week ${context.week} carries no matchups, so no head-to-head result is known.`,
    );
  }
  if (context.completed.length === 0) {
    return withheldOutcome(
      id,
      "SCORES_INCOMPLETE",
      `No matchup in week ${context.week} has a stored score for both teams, so no result is inferred.`,
    );
  }
  return null;
}

function resolveAllPlayAward(
  context: WeekContext,
  id: "bad-beat" | "horseshoe",
  outcome: "win" | "loss",
): AwardOutcome {
  const gate = matchupGate(context, id);
  if (gate !== null) return gate;

  const opponents = opponentsByOutcome(context.completed, outcome);
  const candidates = [...opponents].flatMap(([teamId, opponentTeamId]): AwardCandidate[] => {
    const rate = context.allPlay.get(teamId)?.rate;
    return rate === undefined || rate === null ? [] : [{ teamId, opponentTeamId, value: rate }];
  });
  const best = pickCandidate(candidates, id === "bad-beat");
  if (best === null) {
    const decided = context.completed.some((matchup) => matchup.comparison !== 0);
    return withheldOutcome(
      id,
      "NO_QUALIFYING_TEAM",
      decided
        ? `No ${outcome === "win" ? "winning" : "losing"} team in week ${context.week} has an all-play comparison to rank.`
        : `Every completed matchup in week ${context.week} finished inside the tie tolerance, so no team ${outcome === "win" ? "won" : "lost"}.`,
    );
  }
  return awardOutcome(context, id, best, "percent");
}

function resolveBenchWarmer(context: WeekContext): AwardOutcome {
  const supplied = context.performances.filter(
    (performance) =>
      performance.actualLineupPoints !== undefined && performance.optimalLineupPoints !== undefined,
  );
  if (supplied.length === 0) {
    return withheldOutcome(
      "bench-warmer",
      "LINEUP_POINTS_MISSING",
      `No team in week ${context.week} supplied both actual and optimal lineup points.`,
    );
  }

  const opponents = opponentsByOutcome(context.completed, "any");
  const candidates = supplied.flatMap((performance): AwardCandidate[] => {
    const actual = performance.actualLineupPoints ?? 0;
    const optimal = performance.optimalLineupPoints ?? 0;
    // An optimal lineup below the actual lineup is inconsistent input; it is
    // excluded rather than clamped into a zero.
    if (optimal < actual) return [];
    return [
      {
        teamId: performance.teamId,
        opponentTeamId: opponents.get(performance.teamId) ?? null,
        value: optimal - actual,
      },
    ];
  });
  const best = pickCandidate(candidates, true);
  if (best === null) {
    return withheldOutcome(
      "bench-warmer",
      "NO_QUALIFYING_TEAM",
      `Every team with lineup points in week ${context.week} reported an optimal lineup below its actual lineup, which cannot be a bench total.`,
    );
  }
  return awardOutcome(context, "bench-warmer", best, "points");
}

function resolveMarginAward(context: WeekContext, id: "beatdown" | "photo-finish"): AwardOutcome {
  const gate = matchupGate(context, id);
  if (gate !== null) return gate;

  const candidates = context.completed.flatMap((matchup): AwardCandidate[] =>
    matchup.comparison === 0
      ? []
      : [{ teamId: winnerOf(matchup), opponentTeamId: loserOf(matchup), value: matchup.margin }],
  );
  const best = pickCandidate(candidates, id === "beatdown");
  if (best === null) {
    return withheldOutcome(
      id,
      "NO_QUALIFYING_TEAM",
      `Every completed matchup in week ${context.week} finished inside the tie tolerance, so there is no margin of victory.`,
    );
  }
  if (id === "photo-finish" && best.value > context.photoFinishThreshold) {
    return withheldOutcome(
      id,
      "NO_QUALIFYING_TEAM",
      `The closest margin in week ${context.week} was ${formatPoints(best.value)} points, above the ${formatPoints(context.photoFinishThreshold)}-point Photo Finish threshold.`,
    );
  }
  return awardOutcome(context, id, best, "points");
}

function resolveAward(context: WeekContext, id: WeeklyAwardId): AwardOutcome {
  switch (id) {
    case "bad-beat":
      return resolveAllPlayAward(context, id, "loss");
    case "horseshoe":
      return resolveAllPlayAward(context, id, "win");
    case "bench-warmer":
      return resolveBenchWarmer(context);
    case "beatdown":
    case "photo-finish":
      return resolveMarginAward(context, id);
  }
}

export function calculateWeeklyAwards(input: CalculateWeeklyAwardsInput): WeeklyAwardsResult {
  validateLeagueInput(input);
  if (!Number.isInteger(input.week) || input.week <= 0) {
    throw new RangeError("week must be a positive integer");
  }

  const week = input.weeks.find((entry) => entry.week === input.week);
  if (week === undefined) {
    return {
      week: input.week,
      awards: [],
      withheld: AWARD_ORDER.map((id) => ({
        id,
        label: AWARD_LABELS[id],
        reasons: [
          {
            code: "WEEK_MISSING" as const,
            message: `Week ${input.week} is not present in the supplied weeks.`,
          },
        ],
      })),
      definitions: WEEKLY_AWARD_DEFINITIONS,
    };
  }

  const tolerance = input.tieTolerance ?? ANALYTICS_EPSILON;
  const matchups = week.matchups ?? [];
  const performances = new Map(
    week.performances.map((performance) => [performance.teamId, performance]),
  );
  const context: WeekContext = {
    week: week.week,
    photoFinishThreshold: input.photoFinishThreshold ?? DEFAULT_PHOTO_FINISH_THRESHOLD,
    performances: week.performances,
    allPlay: buildAllPlay(week.performances, tolerance),
    scheduledMatchups: matchups.length,
    completed: buildCompletedMatchups(matchups, performances, tolerance),
  };

  const outcomes = AWARD_ORDER.map((id) => resolveAward(context, id));
  return {
    week: week.week,
    awards: outcomes.flatMap((outcome) => (outcome.kind === "award" ? [outcome.award] : [])),
    withheld: outcomes.flatMap((outcome) =>
      outcome.kind === "withheld" ? [outcome.withheld] : [],
    ),
    definitions: WEEKLY_AWARD_DEFINITIONS,
  };
}

/**
 * Every supplied week that yields at least one award, ascending. A recap may be written for any
 * of them, so the caller gets the whole selectable set rather than only the newest entry.
 */
export function awardableWeeks(input: Omit<CalculateWeeklyAwardsInput, "week">): readonly number[] {
  validateLeagueInput(input);
  return sortedUniqueNumbers(input.weeks.map((week) => week.week)).filter(
    (week) => calculateWeeklyAwards({ ...input, week }).awards.length > 0,
  );
}

/** Most recent week that yields at least one award, or null. */
export function latestAwardableWeek(
  input: Omit<CalculateWeeklyAwardsInput, "week">,
): number | null {
  return awardableWeeks(input).at(-1) ?? null;
}
