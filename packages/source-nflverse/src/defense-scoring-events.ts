import { createHash } from "node:crypto";

/**
 * Inactive, provider-independent extraction of observed scoring events, not fantasy points.
 * References: https://raw.githubusercontent.com/nflverse/nflreadr/master/data-raw/dictionary_pbp.csv
 * and https://raw.githubusercontent.com/nflverse/nflfastR/master/R/calculate_stats.R .
 * In particular, nflfastR's def_tds excludes separately aggregated fumble-recovery touchdowns.
 */
export const NFLVERSE_DEFENSE_SCORING_EVENTS_VERSION = "nflverse-defense-scoring-events-v1";
export type DefenseScoringRow = Readonly<Record<string, unknown>>;
export interface DefenseScoringGame {
  readonly gameId: string;
  readonly season: number;
  readonly week: number;
  readonly seasonType: "REG" | "POST";
  readonly homeTeam: string;
  readonly awayTeam: string;
}
export interface DefenseScoringProvenance {
  readonly artifactChecksumSha256: string;
  readonly gameRowsChecksumSha256: string;
  readonly gameRowCount: number;
  readonly checkedAt: string;
  /** Caller must select every game row from the pinned artifact, without filtering scoring plays. */
  readonly coverage: "full-game" | "partial-game";
}
/** Caller-established explicit terminal evidence; this extractor does not authenticate its origin. */
export interface DefenseScoringFinality {
  readonly gameId: string;
  readonly homeTeam: string;
  readonly awayTeam: string;
  readonly homeScore: number;
  readonly awayScore: number;
  readonly observedAt: string;
  readonly sourceChecksumSha256: string;
}
export type DefenseScoringEventKind =
  | "offensive-pass-touchdown"
  | "offensive-rush-touchdown"
  | "offensive-fumble-touchdown"
  | "defensive-interception-touchdown"
  | "defensive-fumble-touchdown"
  | "kickoff-return-touchdown"
  | "kickoff-fumble-touchdown"
  | "punt-return-touchdown"
  | "punt-fumble-touchdown"
  | "blocked-punt-touchdown"
  | "blocked-field-goal-touchdown"
  | "field-goal-return-touchdown"
  | "field-goal"
  | "extra-point"
  | "offensive-two-point-conversion"
  | "defensive-two-point-return"
  | "one-point-safety"
  | "safety";
export interface DefenseScoringEvent {
  readonly playId: string;
  readonly scoringTeam: string;
  readonly points: number;
  /** A known scoring event can remain unclassified; such a game has no complete team totals. */
  readonly kind: DefenseScoringEventKind | null;
  readonly facts: Readonly<Record<string, string | number | null>>;
}
export interface DefenseScoringIssue {
  readonly playId: string | null;
  readonly reason: string;
}
const teams = new Set(
  "ARI ATL BAL BUF CAR CHI CIN CLE DAL DEN DET GB HOU IND JAX KC LA LAR LAC LV MIA MIN NE NO NYG NYJ OAK PHI PIT SD SEA SF STL TB TEN WAS".split(
    " ",
  ),
);
function team(value: unknown): string | null {
  if (typeof value !== "string" || !teams.has(value)) return null;
  return (
    ({ LA: "LAR", STL: "LAR", OAK: "LV", SD: "LAC" } as Record<string, string>)[value] ?? value
  );
}
function number(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !/^\d+(?:\.0+)?$/u.test(value)))
    return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 200 ? parsed : null;
}
function flag(value: unknown): 0 | 1 | null {
  const parsed = number(value);
  return parsed === 0 || parsed === 1 ? parsed : null;
}
function missing(value: unknown): boolean {
  return value === undefined || value === null || value === "" || value === "NA";
}
function time(value: string): number {
  return /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/u.test(value) ? Date.parse(value) : NaN;
}
function digest(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value);
}
function rowJson(row: DefenseScoringRow): string {
  if (
    row === null ||
    typeof row !== "object" ||
    Array.isArray(row) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(row) as object | null) ||
    Object.keys(row).length > 400
  )
    throw new TypeError("Scoring rows must be bounded plain records");
  const fields = Object.entries(row).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [key, value] of fields)
    if (
      !/^[a-z][a-z0-9_]{0,79}$/u.test(key) ||
      !(
        value === null ||
        (typeof value === "number" && Number.isFinite(value)) ||
        (typeof value === "string" && value.length <= 16_384)
      )
    )
      throw new TypeError("Malformed scoring row field");
  return JSON.stringify(Object.fromEntries(fields));
}
/** Hashes exact selected values and row order, with canonical field ordering; not source authentication. */
export function defenseScoringRowsChecksum(rows: readonly DefenseScoringRow[]): string {
  if (!Array.isArray(rows) || rows.length > 1_000 || Object.keys(rows).length !== rows.length)
    throw new RangeError("Scoring game row count exceeds bound");
  const hash = createHash("sha256");
  let bytes = 0;
  for (const row of rows as readonly DefenseScoringRow[]) {
    const json = rowJson(row) + "\n";
    bytes += Buffer.byteLength(json);
    if (bytes > 8 * 1024 * 1024) throw new RangeError("Scoring game payload exceeds bound");
    hash.update(json);
  }
  return hash.digest("hex");
}

const flags = [
  "play_deleted",
  "touchdown",
  "pass_touchdown",
  "rush_touchdown",
  "return_touchdown",
  "interception",
  "fumble",
  "fumble_lost",
  "kickoff_attempt",
  "punt_attempt",
  "punt_blocked",
  "field_goal_attempt",
  "extra_point_attempt",
  "two_point_attempt",
  "defensive_two_point_conv",
  "defensive_extra_point_conv",
  "safety",
  "special",
  "special_teams_play",
] as const;
const factFields = [
  ...flags,
  "play_type",
  "play_type_nfl",
  "posteam",
  "defteam",
  "td_team",
  "td_player_id",
  "return_team",
  "fumble_recovery_1_team",
  "fumble_recovery_2_team",
  "field_goal_result",
  "extra_point_result",
  "two_point_conv_result",
  "st_play_type",
  "posteam_score",
  "defteam_score",
  "posteam_score_post",
  "defteam_score_post",
] as const;
/** Compact lossless selection for this extractor; preserve row order and every row of the game. */
export const NFLVERSE_DEFENSE_SCORING_EVENT_COLUMNS = [
  "play_id",
  "game_id",
  "season",
  "week",
  "season_type",
  "home_team",
  "away_team",
  ...factFields,
] as const;

function classify(
  row: DefenseScoringRow,
  scoringTeam: string,
  points: number,
): DefenseScoringEventKind | null {
  const offense = team(row.posteam),
    defense = team(row.defteam);
  const is = (key: string) => flag(row[key]) === 1;
  if (
    flags.some(
      (key) => key !== "special" && key !== "special_teams_play" && flag(row[key]) === null,
    )
  )
    return null;
  const declaredKinds = [
    is("touchdown"),
    is("safety") || row.extra_point_result === "safety" || row.two_point_conv_result === "safety",
    row.field_goal_result === "made",
    row.extra_point_result === "good",
    row.two_point_conv_result === "success",
    is("defensive_two_point_conv") || is("defensive_extra_point_conv"),
  ];
  if (declaredKinds.filter(Boolean).length !== 1) return null;
  if (is("defensive_two_point_conv") && !is("two_point_attempt")) return null;
  if (is("defensive_extra_point_conv") && !is("extra_point_attempt")) return null;
  const tryPlay = is("extra_point_attempt") || is("two_point_attempt");
  if (is("extra_point_attempt") && is("two_point_attempt")) return null;
  if (tryPlay) {
    if (is("touchdown") || is("field_goal_attempt")) return null;
    if (row.extra_point_result === "safety" || row.two_point_conv_result === "safety")
      return points === 1 ? "one-point-safety" : null;
    if (is("defensive_two_point_conv") || is("defensive_extra_point_conv"))
      return points === 2 && scoringTeam === defense ? "defensive-two-point-return" : null;
    if (is("extra_point_attempt") && row.extra_point_result === "good")
      return points === 1 && scoringTeam === offense ? "extra-point" : null;
    if (is("two_point_attempt") && row.two_point_conv_result === "success")
      return points === 2 && scoringTeam === offense ? "offensive-two-point-conversion" : null;
    return null;
  }
  if (is("defensive_two_point_conv") || is("defensive_extra_point_conv")) return null;
  if (is("safety")) return points === 2 && !is("touchdown") ? "safety" : null;
  if (is("field_goal_attempt") && row.field_goal_result === "made")
    return points === 3 && scoringTeam === offense && !is("touchdown") ? "field-goal" : null;
  if (!is("touchdown") || points !== 6 || team(row.td_team) !== scoringTeam) return null;
  // Multiple changes of possession can change which unit receives fantasy credit. Retain the
  // score and facts, but do not guess from the initial possession or sum all fumble TDs.
  if (!missing(row.fumble_recovery_2_team) || (is("interception") && is("fumble"))) return null;
  if (
    ["interception", "fumble", "pass_touchdown", "rush_touchdown"].some(
      (key) => flag(row[key]) === null,
    )
  )
    return null;
  const kicks = [
    is("kickoff_attempt"),
    is("punt_attempt") || is("punt_blocked"),
    is("field_goal_attempt"),
  ];
  if (kicks.filter(Boolean).length > 1 || (is("pass_touchdown") && is("rush_touchdown")))
    return null;
  if (kicks.some(Boolean)) {
    if (is("pass_touchdown") || is("rush_touchdown")) return null;
    if (kicks[0]) return is("fumble") ? "kickoff-fumble-touchdown" : "kickoff-return-touchdown";
    if (kicks[1]) {
      if (is("punt_blocked")) return "blocked-punt-touchdown";
      return is("fumble") ? "punt-fumble-touchdown" : "punt-return-touchdown";
    }
    if (row.field_goal_result === "blocked") return "blocked-field-goal-touchdown";
    return row.field_goal_result === "missed" ? "field-goal-return-touchdown" : null;
  }
  if (scoringTeam === defense && !is("pass_touchdown") && !is("rush_touchdown")) {
    if (is("interception") && is("return_touchdown")) return "defensive-interception-touchdown";
    if (is("fumble") && is("fumble_lost") && team(row.fumble_recovery_1_team) === defense)
      return "defensive-fumble-touchdown";
    return null;
  }
  if (scoringTeam !== offense || is("interception")) return null;
  if (is("pass_touchdown")) return "offensive-pass-touchdown";
  if (is("rush_touchdown")) return "offensive-rush-touchdown";
  if (is("fumble") && !is("fumble_lost") && team(row.fumble_recovery_1_team) === offense)
    return "offensive-fumble-touchdown";
  return null;
}

/**
 * This does not prove caller provenance, authenticate finality, or implement Yahoo/ESPN points
 * allowed. Complete totals require pinned full-game selection, explicit terminal evidence, an
 * END_GAME record, continuous observed score transitions and a fully classified score ledger.
 * Absent/ambiguous fields yield unresolved results. No model de-minimis assumptions are used.
 */
export function extractNflverseDefenseScoringEvents(input: {
  readonly game: DefenseScoringGame;
  readonly rows: readonly DefenseScoringRow[];
  readonly provenance: DefenseScoringProvenance;
  readonly finality: DefenseScoringFinality | null;
}) {
  const { game, rows, provenance, finality } = input;
  const home = team(game.homeTeam),
    away = team(game.awayTeam);
  const gameParts = /^(\d{4})_(\d{2})_([A-Z]{2,3})_([A-Z]{2,3})$/u.exec(game.gameId);
  if (
    !home ||
    !away ||
    home === away ||
    !gameParts ||
    Number(gameParts[1]) !== game.season ||
    Number(gameParts[2]) !== game.week ||
    team(gameParts[3]) !== away ||
    team(gameParts[4]) !== home ||
    !Number.isSafeInteger(game.season) ||
    game.season < 1999 ||
    game.season > 2200 ||
    !Number.isSafeInteger(game.week) ||
    game.week < 1 ||
    game.week > 25 ||
    !["REG", "POST"].includes(game.seasonType)
  )
    throw new TypeError("Invalid scoring game identity");
  const rowsChecksum = defenseScoringRowsChecksum(rows);
  if (
    !digest(provenance.artifactChecksumSha256) ||
    !digest(provenance.gameRowsChecksumSha256) ||
    rowsChecksum !== provenance.gameRowsChecksumSha256 ||
    rows.length !== provenance.gameRowCount ||
    !Number.isFinite(time(provenance.checkedAt)) ||
    !["full-game", "partial-game"].includes(provenance.coverage)
  )
    throw new TypeError("Scoring snapshot binding mismatch");
  if (
    finality &&
    (finality.gameId !== game.gameId ||
      team(finality.homeTeam) !== home ||
      team(finality.awayTeam) !== away ||
      typeof finality.homeScore !== "number" ||
      typeof finality.awayScore !== "number" ||
      number(finality.homeScore) === null ||
      number(finality.awayScore) === null ||
      !digest(finality.sourceChecksumSha256) ||
      !Number.isFinite(time(finality.observedAt)))
  )
    throw new TypeError("Invalid scoring terminal evidence");
  const issues: DefenseScoringIssue[] = [];
  const events: DefenseScoringEvent[] = [];
  const issue = (playId: string | null, reason: string) => issues.push({ playId, reason });
  if (provenance.coverage !== "full-game") issue(null, "partial-game-selection");
  if (!finality) issue(null, "explicit-finality-unavailable");
  else if (time(provenance.checkedAt) < time(finality.observedAt))
    issue(null, "source-not-checked-after-finality");
  const seen = new Map<string, string>();
  let duplicates = 0,
    excludedCancelled = 0,
    endGames = 0;
  let currentHome = 0,
    currentAway = 0,
    scoreRows = 0;
  let endScores: { home: number; away: number } | null = null;
  const sums = { [home]: 0, [away]: 0 };
  for (const row of rows) {
    const playId =
      typeof row.play_id === "string" &&
      /^\d+(?:\.\d+)?$/u.test(row.play_id) &&
      Number.isFinite(Number(row.play_id))
        ? String(Number(row.play_id))
        : null;
    if (
      !playId ||
      row.game_id !== game.gameId ||
      Number(row.season) !== game.season ||
      Number(row.week) !== game.week ||
      row.season_type !== game.seasonType ||
      team(row.home_team) !== home ||
      team(row.away_team) !== away
    ) {
      issue(playId, "row-game-identity-conflict");
      continue;
    }
    if (NFLVERSE_DEFENSE_SCORING_EVENT_COLUMNS.some((key) => !Object.hasOwn(row, key))) {
      issue(playId, "required-event-column-unavailable");
      continue;
    }
    const fingerprint = rowJson(row);
    const previous = seen.get(playId);
    if (previous !== undefined) {
      if (previous !== fingerprint) issue(playId, "conflicting-duplicate-play");
      else duplicates += 1;
      continue;
    }
    seen.set(playId, fingerprint);
    if (flags.some((key) => !missing(row[key]) && flag(row[key]) === null)) {
      issue(playId, "invalid-event-flag");
      continue;
    }
    if (flag(row.play_deleted) === null) {
      issue(playId, "deleted-status-unavailable");
      continue;
    }
    if (flag(row.play_deleted) === 1) {
      excludedCancelled += 1;
      continue;
    }
    const offense = team(row.posteam),
      defense = team(row.defteam);
    const beforeOff = number(row.posteam_score),
      beforeDef = number(row.defteam_score);
    const afterOff = number(row.posteam_score_post),
      afterDef = number(row.defteam_score_post);
    const hasScores =
      beforeOff !== null && beforeDef !== null && afterOff !== null && afterDef !== null;
    const saysScore =
      flag(row.touchdown) === 1 ||
      flag(row.safety) === 1 ||
      flag(row.defensive_two_point_conv) === 1 ||
      flag(row.defensive_extra_point_conv) === 1 ||
      row.field_goal_result === "made" ||
      row.extra_point_result === "good" ||
      row.extra_point_result === "safety" ||
      row.two_point_conv_result === "success" ||
      row.two_point_conv_result === "safety";
    if (
      !offense ||
      !defense ||
      offense === defense ||
      ![home, away].includes(offense) ||
      ![home, away].includes(defense) ||
      !hasScores
    ) {
      if (
        saysScore ||
        row.play_type_nfl === "END_GAME" ||
        [row.posteam_score, row.defteam_score, row.posteam_score_post, row.defteam_score_post].some(
          (value) => !missing(value),
        )
      )
        issue(playId, "score-context-unavailable");
      continue;
    }
    const beforeHome = offense === home ? beforeOff : beforeDef;
    const beforeAway = offense === away ? beforeOff : beforeDef;
    const afterHome = offense === home ? afterOff : afterDef;
    const afterAway = offense === away ? afterOff : afterDef;
    if (beforeHome !== currentHome || beforeAway !== currentAway)
      issue(playId, "score-transition-gap");
    currentHome = afterHome;
    currentAway = afterAway;
    scoreRows += 1;
    const homeDelta = afterHome - beforeHome,
      awayDelta = afterAway - beforeAway;
    if (row.play_type_nfl === "END_GAME") {
      endGames += 1;
      endScores = { home: afterHome, away: afterAway };
    }
    if (homeDelta === 0 && awayDelta === 0) {
      if (row.play_type === "no_play") excludedCancelled += 1;
      else if (saysScore) issue(playId, "scoring-flag-without-score-change");
      continue;
    }
    if (row.play_type === "no_play") {
      issue(playId, "cancelled-play-changed-score");
      continue;
    }
    if (
      homeDelta < 0 ||
      awayDelta < 0 ||
      (homeDelta > 0 && awayDelta > 0) ||
      homeDelta + awayDelta > 6
    ) {
      issue(playId, "invalid-score-change");
      continue;
    }
    if (endGames > 0) issue(playId, "score-at-or-after-game-end");
    const scoringTeam = homeDelta > 0 ? home : away,
      points = homeDelta + awayDelta;
    const kind = classify(row, scoringTeam, points);
    if (kind === null) issue(playId, "scoring-event-unresolved");
    sums[scoringTeam]! += points;
    events.push({
      playId,
      scoringTeam,
      points,
      kind,
      facts: Object.fromEntries(
        factFields.map((key) => [key, (row[key] ?? null) as string | number | null]),
      ),
    });
  }
  if (rows.length === 0 || scoreRows === 0) issue(null, "game-score-history-unavailable");
  if (endGames !== 1) issue(null, "game-end-record-unavailable-or-ambiguous");
  if (
    finality &&
    (sums[home] !== finality.homeScore ||
      sums[away] !== finality.awayScore ||
      currentHome !== finality.homeScore ||
      currentAway !== finality.awayScore ||
      endScores?.home !== finality.homeScore ||
      endScores.away !== finality.awayScore)
  )
    issue(null, "final-score-reconciliation-failed");
  const complete = issues.length === 0;
  return {
    version: NFLVERSE_DEFENSE_SCORING_EVENTS_VERSION,
    state: complete ? ("complete" as const) : ("unresolved" as const),
    interpretation: "caller-bound-final-game-scoring-events-not-provider-fantasy-points" as const,
    game,
    provenance,
    finality,
    rowsRead: rows.length,
    uniquePlays: seen.size,
    identicalDuplicates: duplicates,
    excludedCancelled,
    events,
    issues,
    teams: complete
      ? [home, away].map((scoringTeam) => {
          const own = events.filter((event) => event.scoringTeam === scoringTeam);
          const count = (...kinds: DefenseScoringEventKind[]) =>
            own.filter((event) => event.kind !== null && kinds.includes(event.kind)).length;
          return {
            team: scoringTeam,
            opponentTeam: scoringTeam === home ? away : home,
            pointsScored: sums[scoringTeam]!,
            defensiveTouchdowns: count(
              "defensive-interception-touchdown",
              "defensive-fumble-touchdown",
            ),
            defensiveFumbleTouchdowns: count("defensive-fumble-touchdown"),
            offensiveFumbleTouchdowns: count("offensive-fumble-touchdown"),
            specialTeamsTouchdowns: count(
              "kickoff-return-touchdown",
              "kickoff-fumble-touchdown",
              "punt-return-touchdown",
              "punt-fumble-touchdown",
              "blocked-punt-touchdown",
              "blocked-field-goal-touchdown",
              "field-goal-return-touchdown",
            ),
            defensiveTwoPointReturns: count("defensive-two-point-return"),
            onePointSafeties: count("one-point-safety"),
            safeties: count("safety"),
          };
        })
      : null,
  };
}
