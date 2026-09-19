import {
  NFLVERSE_DEFENSE_SCORING_EVENTS_VERSION,
  type DefenseScoringEventKind,
  type extractNflverseDefenseScoringEvents,
} from "./defense-scoring-events.js";
import { NflverseDatasetSourceError } from "./release-source.js";

/** Stable observed-event vocabulary. Counts, not fantasy points or estimated probabilities. */
export const NFLVERSE_DEFENSE_SCORING_EVENT_COMPONENTS = {
  "offensive-pass-touchdown": "scoring_event_offensive_pass_touchdown",
  "offensive-rush-touchdown": "scoring_event_offensive_rush_touchdown",
  "offensive-fumble-touchdown": "scoring_event_offensive_fumble_touchdown",
  "defensive-interception-touchdown": "scoring_event_defensive_interception_touchdown",
  "defensive-fumble-touchdown": "scoring_event_defensive_fumble_touchdown",
  "kickoff-return-touchdown": "scoring_event_kickoff_return_touchdown",
  "kickoff-fumble-touchdown": "scoring_event_kickoff_fumble_touchdown",
  "punt-return-touchdown": "scoring_event_punt_return_touchdown",
  "punt-fumble-touchdown": "scoring_event_punt_fumble_touchdown",
  "blocked-punt-touchdown": "scoring_event_blocked_punt_touchdown",
  "blocked-field-goal-touchdown": "scoring_event_blocked_field_goal_touchdown",
  "field-goal-return-touchdown": "scoring_event_field_goal_return_touchdown",
  "field-goal": "scoring_event_field_goal",
  "extra-point": "scoring_event_extra_point",
  "offensive-two-point-conversion": "scoring_event_offensive_two_point_conversion",
  "defensive-two-point-return": "scoring_event_defensive_two_point_return",
  "one-point-safety": "scoring_event_one_point_safety",
  safety: "scoring_event_safety",
} as const satisfies Record<DefenseScoringEventKind, string>;

export type NflverseDefenseScoringEventComponent =
  (typeof NFLVERSE_DEFENSE_SCORING_EVENT_COMPONENTS)[DefenseScoringEventKind];
export type NflverseDefenseScoringComponents = Readonly<
  Record<NflverseDefenseScoringEventComponent, number> & {
    defensive_touchdowns: number;
    special_teams_touchdowns: number;
    defensive_two_point_returns: number;
    one_point_safeties: number;
    scoring_event_totals_complete: 1;
    scoring_points_total: number;
  }
>;
type ScoringResult = ReturnType<typeof extractNflverseDefenseScoringEvents>;
function fail(detail: string): never {
  throw new NflverseDatasetSourceError("QUALITY_THRESHOLD", `nflverse team scoring ${detail}`);
}
function canonicalTeam(value: string): string {
  return (
    ({ LA: "LAR", STL: "LAR", OAK: "LV", SD: "LAC" } as Record<string, string>)[value] ?? value
  );
}
function eventPoints(kind: DefenseScoringEventKind): number {
  if (kind.endsWith("-touchdown")) return 6;
  if (kind === "field-goal") return 3;
  if (kind === "extra-point" || kind === "one-point-safety") return 1;
  return 2;
}

/** Verify a custom loader's complete aggregate still matches its selected game and PBP epoch. */
export function nflverseDefenseScoringComponents(input: {
  readonly result: ScoringResult;
  readonly gameId: string;
  readonly season: number;
  readonly week: number;
  readonly seasonType: "REG" | "POST";
  readonly team: string;
  readonly opponentTeam: string;
  readonly playByPlayChecksumSha256: string;
  readonly playByPlayCheckedAt: string;
}): NflverseDefenseScoringComponents {
  const { result } = input;
  const own = canonicalTeam(input.team),
    opponent = canonicalTeam(input.opponentTeam);
  const home = canonicalTeam(result.game.homeTeam),
    away = canonicalTeam(result.game.awayTeam);
  if (
    result.version !== NFLVERSE_DEFENSE_SCORING_EVENTS_VERSION ||
    result.state !== "complete" ||
    result.issues.length !== 0 ||
    !result.teams ||
    result.game.gameId !== input.gameId ||
    result.game.season !== input.season ||
    result.game.week !== input.week ||
    result.game.seasonType !== input.seasonType ||
    own === opponent ||
    ![home, away].includes(own) ||
    ![home, away].includes(opponent) ||
    result.provenance.coverage !== "full-game" ||
    result.provenance.artifactChecksumSha256 !== input.playByPlayChecksumSha256 ||
    !/^[a-f0-9]{64}$/u.test(input.playByPlayChecksumSha256) ||
    !/^[a-f0-9]{64}$/u.test(result.provenance.gameRowsChecksumSha256) ||
    result.provenance.checkedAt !== input.playByPlayCheckedAt ||
    !Number.isFinite(Date.parse(input.playByPlayCheckedAt)) ||
    !Number.isSafeInteger(result.rowsRead) ||
    result.rowsRead < 1 ||
    result.rowsRead > 1000 ||
    result.provenance.gameRowCount !== result.rowsRead ||
    result.finality === null ||
    result.finality.gameId !== input.gameId ||
    canonicalTeam(result.finality.homeTeam) !== home ||
    canonicalTeam(result.finality.awayTeam) !== away ||
    result.finality.sourceChecksumSha256 !== input.playByPlayChecksumSha256 ||
    !Number.isFinite(Date.parse(result.finality.observedAt)) ||
    Date.parse(result.finality.observedAt) > Date.parse(input.playByPlayCheckedAt)
  )
    fail(`requires complete bound event totals for ${input.gameId}:${input.team}`);
  if (
    result.teams.length !== 2 ||
    new Set(result.teams.map((row) => canonicalTeam(row.team))).size !== 2 ||
    result.events.length > 1000
  )
    fail(`has ambiguous team/event totals for ${input.gameId}`);
  const counts = new Map<string, Record<NflverseDefenseScoringEventComponent, number>>(
    [home, away].map((name) => [
      name,
      Object.fromEntries(
        Object.values(NFLVERSE_DEFENSE_SCORING_EVENT_COMPONENTS).map((field) => [field, 0]),
      ) as Record<NflverseDefenseScoringEventComponent, number>,
    ]),
  );
  const points = new Map([
    [home, 0],
    [away, 0],
  ]);
  const seen = new Set<string>();
  for (const event of result.events) {
    if (
      event.kind === null ||
      !Object.hasOwn(NFLVERSE_DEFENSE_SCORING_EVENT_COMPONENTS, event.kind) ||
      !counts.has(canonicalTeam(event.scoringTeam)) ||
      !event.playId ||
      seen.has(event.playId) ||
      event.points !== eventPoints(event.kind)
    )
      fail(`has invalid or duplicate classified events for ${input.gameId}`);
    seen.add(event.playId);
    const name = canonicalTeam(event.scoringTeam);
    counts.get(name)![NFLVERSE_DEFENSE_SCORING_EVENT_COMPONENTS[event.kind]] += 1;
    points.set(name, points.get(name)! + event.points);
  }
  for (const row of result.teams) {
    const name = canonicalTeam(row.team),
      values = counts.get(name);
    if (!values || canonicalTeam(row.opponentTeam) !== (name === home ? away : home))
      fail(`has mismatched team totals for ${input.gameId}`);
    const count = (kind: DefenseScoringEventKind) =>
      values[NFLVERSE_DEFENSE_SCORING_EVENT_COMPONENTS[kind]];
    const expected = {
      pointsScored: points.get(name),
      defensiveTouchdowns:
        count("defensive-interception-touchdown") + count("defensive-fumble-touchdown"),
      defensiveFumbleTouchdowns: count("defensive-fumble-touchdown"),
      offensiveFumbleTouchdowns: count("offensive-fumble-touchdown"),
      specialTeamsTouchdowns:
        count("kickoff-return-touchdown") +
        count("kickoff-fumble-touchdown") +
        count("punt-return-touchdown") +
        count("punt-fumble-touchdown") +
        count("blocked-punt-touchdown") +
        count("blocked-field-goal-touchdown") +
        count("field-goal-return-touchdown"),
      defensiveTwoPointReturns: count("defensive-two-point-return"),
      onePointSafeties: count("one-point-safety"),
      safeties: count("safety"),
    };
    if (
      Object.entries(expected).some(
        ([key, value]) => row[key as keyof typeof expected] !== value,
      ) ||
      points.get(name) !== (name === home ? result.finality.homeScore : result.finality.awayScore)
    )
      fail(`event/team/final-score totals disagree for ${input.gameId}:${name}`);
  }
  const totals = result.teams.find((row) => canonicalTeam(row.team) === own)!;
  return {
    ...counts.get(own)!,
    defensive_touchdowns: totals.defensiveTouchdowns,
    special_teams_touchdowns: totals.specialTeamsTouchdowns,
    defensive_two_point_returns: totals.defensiveTwoPointReturns,
    one_point_safeties: totals.onePointSafeties,
    scoring_event_totals_complete: 1,
    scoring_points_total: totals.pointsScored,
  };
}
