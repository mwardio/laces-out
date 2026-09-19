import {
  NFLVERSE_DEFENSE_SCORING_EVENT_COLUMNS,
  defenseScoringRowsChecksum,
  extractNflverseDefenseScoringEvents,
  type DefenseScoringEventKind,
  type DefenseScoringGame,
  type DefenseScoringRow,
} from "./defense-scoring-events.js";

/** Explicit toy complete-game rows for consumer tests; never presented as captured NFL data. */
export function teamScoringEventsFixture(input: {
  readonly game: DefenseScoringGame;
  readonly checksum: string;
  readonly checkedAt: string;
  readonly events: readonly { readonly team: string; readonly kind: DefenseScoringEventKind }[];
}) {
  const { game } = input;
  const scores: Record<string, number> = { [game.homeTeam]: 0, [game.awayTeam]: 0 };
  const base = (): Record<string, string> => ({
    ...Object.fromEntries(NFLVERSE_DEFENSE_SCORING_EVENT_COLUMNS.map((field) => [field, ""])),
    game_id: game.gameId,
    season: String(game.season),
    week: String(game.week),
    season_type: game.seasonType,
    home_team: game.homeTeam,
    away_team: game.awayTeam,
    play_deleted: "0",
    play_type: "run",
    play_type_nfl: "RUSH",
    ...Object.fromEntries(
      [
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
      ].map((field) => [field, "0"]),
    ),
  });
  const rows: DefenseScoringRow[] = [];
  for (const [index, event] of input.events.entries()) {
    const offensive =
      event.kind.startsWith("offensive-") ||
      event.kind === "field-goal" ||
      event.kind === "extra-point";
    const other = event.team === game.homeTeam ? game.awayTeam : game.homeTeam;
    const offense = offensive ? event.team : other,
      defense = offensive ? other : event.team;
    const row = {
      ...base(),
      play_id: String(index + 1),
      posteam: offense,
      defteam: defense,
      posteam_score: String(scores[offense]),
      defteam_score: String(scores[defense]),
    };
    const touchdown = event.kind.endsWith("-touchdown");
    const points = touchdown
      ? 6
      : event.kind === "field-goal"
        ? 3
        : event.kind === "extra-point" || event.kind === "one-point-safety"
          ? 1
          : 2;
    const fields: Record<string, string> = {};
    if (touchdown) {
      fields.touchdown = "1";
      fields.td_team = event.team;
      fields.return_touchdown = offensive ? "0" : "1";
    }
    switch (event.kind) {
      case "offensive-pass-touchdown":
        fields.pass_touchdown = "1";
        break;
      case "offensive-rush-touchdown":
        fields.rush_touchdown = "1";
        break;
      case "offensive-fumble-touchdown":
        fields.fumble = "1";
        fields.fumble_recovery_1_team = event.team;
        break;
      case "defensive-interception-touchdown":
        fields.interception = "1";
        break;
      case "defensive-fumble-touchdown":
        fields.fumble = "1";
        fields.fumble_lost = "1";
        fields.fumble_recovery_1_team = event.team;
        break;
      case "kickoff-return-touchdown":
        fields.kickoff_attempt = "1";
        break;
      case "kickoff-fumble-touchdown":
        fields.kickoff_attempt = "1";
        fields.fumble = "1";
        break;
      case "punt-return-touchdown":
        fields.punt_attempt = "1";
        break;
      case "punt-fumble-touchdown":
        fields.punt_attempt = "1";
        fields.fumble = "1";
        break;
      case "blocked-punt-touchdown":
        fields.punt_blocked = "1";
        break;
      case "blocked-field-goal-touchdown":
        fields.field_goal_attempt = "1";
        fields.field_goal_result = "blocked";
        break;
      case "field-goal-return-touchdown":
        fields.field_goal_attempt = "1";
        fields.field_goal_result = "missed";
        break;
      case "field-goal":
        fields.field_goal_attempt = "1";
        fields.field_goal_result = "made";
        break;
      case "extra-point":
        fields.extra_point_attempt = "1";
        fields.extra_point_result = "good";
        break;
      case "offensive-two-point-conversion":
        fields.two_point_attempt = "1";
        fields.two_point_conv_result = "success";
        break;
      case "defensive-two-point-return":
        fields.two_point_attempt = "1";
        fields.defensive_two_point_conv = "1";
        break;
      case "one-point-safety":
        fields.two_point_attempt = "1";
        fields.two_point_conv_result = "safety";
        break;
      case "safety":
        fields.safety = "1";
        break;
      default: {
        const impossible: never = event.kind;
        throw new Error(String(impossible));
      }
    }
    scores[event.team]! += points;
    rows.push({
      ...row,
      ...fields,
      posteam_score_post: String(scores[offense]),
      defteam_score_post: String(scores[defense]),
    });
  }
  rows.push({
    ...base(),
    play_id: "9999",
    play_type: "",
    play_type_nfl: "END_GAME",
    posteam: game.homeTeam,
    defteam: game.awayTeam,
    posteam_score: String(scores[game.homeTeam]),
    defteam_score: String(scores[game.awayTeam]),
    posteam_score_post: String(scores[game.homeTeam]),
    defteam_score_post: String(scores[game.awayTeam]),
  });
  return extractNflverseDefenseScoringEvents({
    game,
    rows,
    provenance: {
      artifactChecksumSha256: input.checksum,
      gameRowsChecksumSha256: defenseScoringRowsChecksum(rows),
      gameRowCount: rows.length,
      checkedAt: input.checkedAt,
      coverage: "full-game",
    },
    finality: {
      gameId: game.gameId,
      homeTeam: game.homeTeam,
      awayTeam: game.awayTeam,
      homeScore: scores[game.homeTeam]!,
      awayScore: scores[game.awayTeam]!,
      observedAt: input.checkedAt,
      sourceChecksumSha256: input.checksum,
    },
  });
}
