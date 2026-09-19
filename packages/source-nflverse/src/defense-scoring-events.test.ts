import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parse } from "csv-parse/sync";
import { describe, expect, it } from "vitest";
import {
  defenseScoringRowsChecksum,
  extractNflverseDefenseScoringEvents,
  NFLVERSE_DEFENSE_SCORING_EVENT_COLUMNS,
  type DefenseScoringRow,
} from "./defense-scoring-events.js";

const game = {
  gameId: "2023_02_CLE_PIT",
  season: 2023,
  week: 2,
  seasonType: "REG",
  homeTeam: "PIT",
  awayTeam: "CLE",
} as const;
const checksum = "a".repeat(64);
const observedAt = "2023-09-19T04:00:00.000Z";
function row(overrides: DefenseScoringRow = {}): DefenseScoringRow {
  return {
    ...Object.fromEntries(NFLVERSE_DEFENSE_SCORING_EVENT_COLUMNS.map((name) => [name, ""])),
    play_id: "1",
    game_id: game.gameId,
    season: "2023",
    week: "2",
    season_type: "REG",
    home_team: "PIT",
    away_team: "CLE",
    play_type: "pass",
    play_type_nfl: "PASS",
    posteam: "CLE",
    defteam: "PIT",
    play_deleted: "0",
    touchdown: "0",
    pass_touchdown: "0",
    rush_touchdown: "0",
    return_touchdown: "0",
    interception: "0",
    fumble: "0",
    fumble_lost: "0",
    kickoff_attempt: "0",
    punt_attempt: "0",
    punt_blocked: "0",
    field_goal_attempt: "0",
    extra_point_attempt: "0",
    two_point_attempt: "0",
    defensive_two_point_conv: "0",
    defensive_extra_point_conv: "0",
    safety: "0",
    special: "0",
    special_teams_play: "0",
    posteam_score: "0",
    defteam_score: "0",
    posteam_score_post: "0",
    defteam_score_post: "0",
    ...overrides,
  };
}
function touchdown(overrides: DefenseScoringRow = {}): DefenseScoringRow {
  return row({
    touchdown: "1",
    return_touchdown: "1",
    interception: "1",
    td_team: "PIT",
    defteam_score_post: "6",
    ...overrides,
  });
}
function end(homeScore = 0, awayScore = 0): DefenseScoringRow {
  return row({
    play_id: "9999",
    play_type: "",
    play_type_nfl: "END_GAME",
    posteam_score: String(awayScore),
    defteam_score: String(homeScore),
    posteam_score_post: String(awayScore),
    defteam_score_post: String(homeScore),
  });
}
function input(rows: readonly DefenseScoringRow[], homeScore = 0, awayScore = 0) {
  return {
    game,
    rows,
    provenance: {
      artifactChecksumSha256: checksum,
      gameRowsChecksumSha256: defenseScoringRowsChecksum(rows),
      gameRowCount: rows.length,
      checkedAt: observedAt,
      coverage: "full-game" as const,
    },
    finality: {
      gameId: game.gameId,
      homeTeam: "PIT",
      awayTeam: "CLE",
      homeScore,
      awayScore,
      observedAt,
      sourceChecksumSha256: checksum,
    },
  };
}
function result(rows: readonly DefenseScoringRow[], home = 0, away = 0) {
  return extractNflverseDefenseScoringEvents(input([...rows, end(home, away)], home, away));
}
function reasons(value: ReturnType<typeof result>) {
  return value.issues.map((issue) => issue.reason);
}
function observedEdgeCases(): DefenseScoringRow[] {
  const csv = readFileSync(
    new URL("./fixtures/defense-scoring-2023-penalties-and-two-fumbles.csv", import.meta.url),
    "utf8",
  );
  expect(createHash("sha256").update(csv).digest("hex")).toBe(
    "05184978b63ea0be3c9d8ec39c43f35b63a2f5138c15b3d499d8fdcbb2846d6c",
  );
  return parse(csv, { columns: true, skip_empty_lines: true });
}
function observed2019EdgeCases(): DefenseScoringRow[] {
  const csv = readFileSync(
    new URL("./fixtures/defense-scoring-2019-try-and-repeated-fumble.csv", import.meta.url),
    "utf8",
  );
  expect(createHash("sha256").update(csv).digest("hex")).toBe(
    "ede1f238d5ba771d6771c308328b0c5ef49ece758383723afd9f11754c66754f",
  );
  return parse(csv, { columns: true, skip_empty_lines: true });
}
function inspectObservedEvent(row: DefenseScoringRow) {
  const captured = input([row]);
  return extractNflverseDefenseScoringEvents({
    ...captured,
    game: {
      gameId: String(row.game_id),
      season: Number(row.season),
      week: Number(row.week),
      seasonType: row.season_type as "REG" | "POST",
      homeTeam: String(row.home_team),
      awayTeam: String(row.away_team),
    },
    provenance: { ...captured.provenance, coverage: "partial-game" },
    finality: null,
  });
}

describe("bound final-game defense scoring events", () => {
  it("recovers BOTH Pittsburgh defensive touchdowns in the complete official 2023 week 2 PBP", () => {
    // Exact selected columns from all 185 rows of the public nflverse 2023 artifact.
    // https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_2023.csv.gz
    // Compressed source SHA256: 4649804ee0f0a40b41e51ec75a1ce921949d7fab5459213488656b92f78560e8
    const csv = readFileSync(
      new URL("./fixtures/defense-scoring-cle-pit-2023.csv", import.meta.url),
      "utf8",
    );
    expect(createHash("sha256").update(csv).digest("hex")).toBe(
      "f72dd995f0c893c23ad185098b56aae3ae2b998cacea8bc746b3646f7e439980",
    );
    const rows: DefenseScoringRow[] = parse(csv, { columns: true, skip_empty_lines: true });
    const captured = input(rows, 26, 22);
    captured.provenance.artifactChecksumSha256 =
      "4649804ee0f0a40b41e51ec75a1ce921949d7fab5459213488656b92f78560e8";
    const actual = extractNflverseDefenseScoringEvents(captured);
    expect(actual.issues).toEqual([]);
    expect(actual.rowsRead).toBe(185);
    expect(actual.teams?.find((entry) => entry.team === "PIT")).toMatchObject({
      pointsScored: 26,
      defensiveTouchdowns: 2,
      defensiveFumbleTouchdowns: 1,
      offensiveFumbleTouchdowns: 0,
      specialTeamsTouchdowns: 0,
    });
    expect(
      actual.events
        .filter((event) => event.kind?.startsWith("defensive-"))
        .map((event) => [event.playId, event.kind]),
    ).toEqual([
      ["56", "defensive-interception-touchdown"],
      ["4056", "defensive-fumble-touchdown"],
    ]);
    expect(actual.events.find((event) => event.playId === "4056")?.facts).toMatchObject({
      fumble: "1",
      fumble_lost: "1",
      fumble_recovery_1_team: "PIT",
      play_type_nfl: "SACK",
    });
  });
  it("keeps own-offense fumble TDs separate from defense totals", () => {
    const actual = result(
      [
        touchdown({
          interception: "0",
          fumble: "1",
          fumble_lost: "0",
          fumble_recovery_1_team: "CLE",
          td_team: "CLE",
          posteam_score_post: "6",
          defteam_score_post: "0",
        }),
      ],
      0,
      6,
    );
    expect(actual.state).toBe("complete");
    expect(actual.teams?.find((entry) => entry.team === "CLE")).toMatchObject({
      defensiveTouchdowns: 0,
      offensiveFumbleTouchdowns: 1,
    });
  });
  it("classifies the seven real 2023 scoring edge cases without calling a partial fixture a complete game", () => {
    // Same SHA-pinned public 2023 PBP artifact as the full-game fixture above. Six penalty plays
    // have real scores despite play_type=no_play; one two-fumble chain changes possession once.
    const cases = observedEdgeCases();
    expect(cases).toHaveLength(7);
    for (const observed of cases) {
      const actual = inspectObservedEvent(observed);
      const expected =
        observed.game_id === "2023_01_JAX_IND"
          ? "defensive-fumble-touchdown"
          : observed.game_id === "2023_04_KC_NYJ"
            ? "safety"
            : "offensive-two-point-conversion";
      expect(actual.events[0]?.kind, String(observed.game_id)).toBe(expected);
      expect(reasons(actual)).not.toContain("scoring-event-unresolved");
      expect(actual.teams).toBeNull();
      expect(reasons(actual)).toContain("partial-game-selection");
    }
  });
  it("requires both offensive fumbles and the precise recovery chain for the double-fumble exception", () => {
    const observed = observedEdgeCases().find((row) => row.game_id === "2023_01_JAX_IND")!;
    for (const mutation of [
      { fumbled_1_team: "IND" },
      { fumbled_2_team: "IND" },
      { fumble_recovery_1_team: "IND" },
      { fumble_recovery_2_team: "JAX" },
      { interception: "1" },
      { kickoff_attempt: "1" },
    ]) {
      const actual = inspectObservedEvent({ ...observed, ...mutation });
      expect(actual.events[0]?.kind).toBeNull();
      expect(reasons(actual)).toContain("scoring-event-unresolved");
    }
  });
  it.each([
    [{ kickoff_attempt: "1" }, "kickoff-return-touchdown"],
    [{ kickoff_attempt: "1", fumble: "1" }, "kickoff-fumble-touchdown"],
    [{ punt_attempt: "1" }, "punt-return-touchdown"],
    [{ punt_attempt: "1", fumble: "1" }, "punt-fumble-touchdown"],
    [{ punt_blocked: "1" }, "blocked-punt-touchdown"],
    [{ field_goal_attempt: "1", field_goal_result: "blocked" }, "blocked-field-goal-touchdown"],
    [{ field_goal_attempt: "1", field_goal_result: "missed" }, "field-goal-return-touchdown"],
  ] as const)("retains distinct kick event context %j", (fields, kind) => {
    const actual = result([touchdown({ interception: "0", ...fields })], 6);
    expect(actual.state).toBe("complete");
    expect(actual.events[0]?.kind).toBe(kind);
    expect(actual.teams?.[0]).toMatchObject({ defensiveTouchdowns: 0, specialTeamsTouchdowns: 1 });
  });
  it("does not classify a fake-punt passing TD as a return TD because special-team personnel were on the field", () => {
    const actual = result(
      [
        touchdown({
          interception: "0",
          return_touchdown: "0",
          pass_touchdown: "1",
          special_teams_play: "1",
          td_team: "CLE",
          posteam_score_post: "6",
          defteam_score_post: "0",
        }),
      ],
      0,
      6,
    );
    expect(actual.state).toBe("complete");
    expect(actual.events[0]?.kind).toBe("offensive-pass-touchdown");
  });
  it.each(["two_point_attempt", "extra_point_attempt"] as const)(
    "records defensive returns from %s",
    (attempt) => {
      const actual = result(
        [
          row({
            [attempt]: "1",
            [attempt === "two_point_attempt"
              ? "defensive_two_point_conv"
              : "defensive_extra_point_conv"]: "1",
            defteam_score_post: "2",
          }),
        ],
        2,
      );
      expect(actual.state).toBe("complete");
      expect(actual.teams?.[0]?.defensiveTwoPointReturns).toBe(1);
    },
  );
  it.each(["PIT", "CLE"] as const)(
    "retains the observed recipient of a one-point safety (%s), without assigning provider credit",
    (recipient) => {
      const actual = result(
        [
          row({
            extra_point_attempt: "1",
            extra_point_result: "safety",
            safety: "1",
            posteam_score_post: recipient === "CLE" ? "1" : "0",
            defteam_score_post: recipient === "PIT" ? "1" : "0",
          }),
        ],
        Number(recipient === "PIT"),
        Number(recipient === "CLE"),
      );
      expect(actual.state).toBe("complete");
      expect(actual.events[0]).toMatchObject({
        scoringTeam: recipient,
        points: 1,
        kind: "one-point-safety",
      });
    },
  );
  it("records regular safeties separately from try safeties", () => {
    const actual = result([row({ safety: "1", defteam_score_post: "2" })], 2);
    expect(actual.state).toBe("complete");
    expect(actual.teams?.[0]).toMatchObject({ safeties: 1, onePointSafeties: 0 });
  });
  it("recognizes the real 2019 blocked-PAT return and same-player repeated fumble", () => {
    // Official public 2019 PBP gzip SHA:
    // b764668137052be23745953cbc33fa17e537a70c81e9b73785a19a15e7288216
    // https://www.chiefs.com/video/charvarius-ward-runs-back-blocked-point-after-to-close-out-chiefs-win
    // https://www.steelers.com/news/season-ends-with-loss-to-ravens
    for (const observed of observed2019EdgeCases()) {
      const actual = inspectObservedEvent(observed);
      expect(actual.state).toBe("unresolved"); // A two-row selection never claims full-game coverage.
      expect(actual.events[0]).toMatchObject({
        playId: observed.play_id,
        kind:
          observed.play_id === "3713" ? "defensive-two-point-return" : "defensive-fumble-touchdown",
      });
      expect(reasons(actual)).not.toContain("scoring-event-unresolved");
    }
  });
  it("requires complete player identity proof before allowing an absent second-fumbler slot", () => {
    const original = observed2019EdgeCases().find((entry) => entry.play_id === "3380")!;
    for (const changes of [
      { fumbled_1_player_id: "" },
      { fumble_recovery_1_player_id: "" },
      { fumble_recovery_2_player_id: "" },
      { td_player_id: "" },
      { fumbled_1_player_id: original.fumble_recovery_2_player_id },
      { fumble_recovery_2_player_id: original.fumble_recovery_1_player_id },
      { fumbled_2_player_id: original.fumbled_1_player_id },
      { fumbled_2_team: "BAL" },
      { fumble_recovery_1_team: "BAL" },
      { fumble_recovery_2_team: "PIT" },
      { interception: "1" },
      { punt_attempt: "1" },
    ]) {
      const actual = inspectObservedEvent({ ...original, ...changes });
      expect(reasons(actual)).toContain("scoring-event-unresolved");
      expect(actual.teams).toBeNull();
    }
  });
  it("still requires exactly one try type and a two-point defensive delta for PAT returns", () => {
    const original = observed2019EdgeCases().find((entry) => entry.play_id === "3713")!;
    for (const changes of [
      { extra_point_attempt: "0" },
      { two_point_attempt: "1" },
      { defensive_extra_point_conv: "1" },
      { defteam_score_post: "39" },
      { defteam_score_post: "38", posteam_score_post: "11" },
    ])
      expect(reasons(inspectObservedEvent({ ...original, ...changes }))).toContain(
        "scoring-event-unresolved",
      );
  });
  it("refuses contradictory positive scoring facts rather than choosing one", () => {
    const safetyAndKick = result(
      [
        row({
          safety: "1",
          field_goal_attempt: "1",
          field_goal_result: "made",
          defteam_score_post: "2",
        }),
      ],
      2,
    );
    expect(reasons(safetyAndKick)).toContain("scoring-event-unresolved");
    const safetyAndReturn = result(
      [
        row({
          extra_point_attempt: "1",
          extra_point_result: "safety",
          defensive_extra_point_conv: "1",
          defteam_score_post: "1",
        }),
      ],
      1,
    );
    expect(reasons(safetyAndReturn)).toContain("scoring-event-unresolved");
    const wrongTry = result(
      [
        row({
          extra_point_attempt: "1",
          two_point_attempt: "1",
          defensive_two_point_conv: "1",
          defteam_score_post: "2",
        }),
      ],
      2,
    );
    expect(reasons(wrongTry)).toContain("scoring-event-unresolved");
  });
  it("deduplicates identical plays and refuses conflicting duplicates", () => {
    const first = touchdown();
    expect(result([first, first], 6)).toMatchObject({ state: "complete", identicalDuplicates: 1 });
    const conflicting = result([first, { ...first, td_team: "CLE" }], 6);
    expect(reasons(conflicting)).toContain("conflicting-duplicate-play");
    expect(conflicting.teams).toBeNull();
  });
  it("excludes deleted and nullified touchdown evidence without discarding accepted-penalty TDs", () => {
    const deleted = touchdown({ play_deleted: "1" });
    const cancelled = touchdown({ play_id: "2", play_type: "no_play", defteam_score_post: "0" });
    expect(result([deleted, cancelled])).toMatchObject({
      state: "complete",
      events: [],
      excludedCancelled: 2,
    });
    expect(result([touchdown({ penalty: "1" })], 6).events[0]?.kind).toBe(
      "defensive-interception-touchdown",
    );
  });
  it("does not infer a scoring classification merely because a no-play score changed", () => {
    const actual = result([touchdown({ play_type: "no_play", touchdown: "0" })], 6);
    expect(reasons(actual)).toContain("scoring-event-unresolved");
    expect(actual.teams).toBeNull();
  });
  it.each([
    { fumble: "1", fumble_recovery_1_team: "PIT" },
    {
      interception: "0",
      fumble: "1",
      fumble_recovery_1_team: "PIT",
      fumble_recovery_2_team: "CLE",
    },
  ])("keeps ambiguous multi-turnover TDs unresolved %j", (fields) => {
    const actual = result([touchdown(fields)], 6);
    expect(actual.events[0]).toMatchObject({ scoringTeam: "PIT", points: 6, kind: null });
    expect(reasons(actual)).toContain("scoring-event-unresolved");
    expect(actual.teams).toBeNull();
  });
  it("requires a complete bound selection and explicit finality before producing any zero counts", () => {
    const captured = input([row(), end()]);
    expect(extractNflverseDefenseScoringEvents({ ...captured, finality: null }).teams).toBeNull();
    expect(
      extractNflverseDefenseScoringEvents({
        ...captured,
        provenance: { ...captured.provenance, coverage: "partial-game" },
      }).teams,
    ).toBeNull();
    expect(
      extractNflverseDefenseScoringEvents({
        ...captured,
        provenance: { ...captured.provenance, checkedAt: "2023-09-19T03:00:00.000Z" },
      }).teams,
    ).toBeNull();
    expect(extractNflverseDefenseScoringEvents(captured).teams?.[0]?.defensiveTwoPointReturns).toBe(
      0,
    );
  });
  it("rejects omitted scoring plays even when the terminal scoreboard exists", () => {
    const actual = result([], 6);
    expect(reasons(actual)).toContain("score-transition-gap");
    expect(reasons(actual)).toContain("final-score-reconciliation-failed");
    expect(actual.teams).toBeNull();
  });
  it("does not treat a matching final total as proof for events with inconsistent individual score deltas", () => {
    const actual = result(
      [
        touchdown({ defteam_score_post: "1" }),
        row({
          play_id: "2",
          extra_point_attempt: "1",
          extra_point_result: "good",
          posteam: "PIT",
          defteam: "CLE",
          posteam_score: "1",
          posteam_score_post: "6",
        }),
      ],
      6,
    );
    expect(reasons(actual).filter((reason) => reason === "scoring-event-unresolved")).toHaveLength(
      2,
    );
    expect(actual.teams).toBeNull();
  });
  it("requires END_GAME rather than a nonzero scoreboard or elapsed game clock", () => {
    const actual = extractNflverseDefenseScoringEvents(
      input([touchdown({ game_seconds_remaining: "0" })], 6),
    );
    expect(reasons(actual)).toContain("game-end-record-unavailable-or-ambiguous");
  });
  it("refuses malformed identity, missing columns and nonbinary flags without manufacturing zeros", () => {
    for (const invalid of [
      row({ game_id: "2023_02_PIT_CLE" }),
      row({ fumble: "2" }),
      row({ play_deleted: "" }),
    ])
      expect(result([invalid]).teams).toBeNull();
    const { punt_attempt: omitted, ...incomplete } = touchdown();
    void omitted;
    expect(reasons(result([incomplete], 6))).toContain("required-event-column-unavailable");
    expect(reasons(result([touchdown({ kickoff_attempt: "" })], 6))).toContain(
      "scoring-event-unresolved",
    );
  });
  it("checks exact rows, ordering, count and bounded input rather than trusting a checksum label", () => {
    const captured = input([row(), end()]);
    expect(() =>
      extractNflverseDefenseScoringEvents({ ...captured, rows: [...captured.rows].reverse() }),
    ).toThrow("binding");
    expect(() =>
      extractNflverseDefenseScoringEvents({
        ...captured,
        provenance: { ...captured.provenance, gameRowCount: 3 },
      }),
    ).toThrow("binding");
    expect(() => defenseScoringRowsChecksum(Array.from({ length: 1001 }, () => row()))).toThrow(
      "bound",
    );
    expect(() => defenseScoringRowsChecksum([{ ...row(), unknown: { nested: true } }])).toThrow(
      "field",
    );
  });
});
