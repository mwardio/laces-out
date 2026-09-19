import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import {
  NflversePlayByPlaySource,
  fourthDownStopsFromPlayByPlay,
  snapshotNflversePlayByPlay,
} from "./play-by-play-source.js";
import { NFLVERSE_DEFENSE_SCORING_EVENT_COLUMNS } from "./defense-scoring-events.js";

const eventDefaults = Object.fromEntries(
  NFLVERSE_DEFENSE_SCORING_EVENT_COLUMNS.map((key) => [key, "0"]),
) as Record<(typeof NFLVERSE_DEFENSE_SCORING_EVENT_COLUMNS)[number], string>;

const base = {
  ...eventDefaults,
  play_id: "1",
  game_id: "2024_17_DET_SF",
  season: "2024",
  week: "17",
  season_type: "REG",
  home_team: "SF",
  away_team: "DET",
  defteam: "SF",
  posteam: "DET",
  td_team: "DET",
  touchdown: "1",
  posteam_score: "0",
  defteam_score: "0",
  posteam_score_post: "6",
  defteam_score_post: "0",
  fumble_recovery_1_team: "",
  fumble_recovery_2_team: "",
  fourth_down_failed: "0",
  penalty: "0",
  play_type: "pass",
  two_point_attempt: "0",
  play_deleted: "0",
  pass_touchdown: "1",
  rush_touchdown: "0",
  passer_player_id: "00-0033106",
  receiver_player_id: "00-0037240",
  rusher_player_id: "",
  td_player_id: "00-0037240",
  passing_yards: "50",
  receiving_yards: "50",
  rushing_yards: "",
  lateral_receiver_player_id: "",
  lateral_rusher_player_id: "",
  lateral_receiving_yards: "",
  lateral_rushing_yards: "",
};
function artifact(rows: readonly Partial<typeof base>[] = [{}], omit?: keyof typeof base): Buffer {
  const columns = Object.keys(base).filter((key) => key !== omit) as (keyof typeof base)[];
  return gzipSync(
    [
      columns.join(","),
      ...rows.map((row) => columns.map((key) => ({ ...base, ...row })[key]).join(",")),
    ].join("\n"),
  );
}
function source(bytes: Buffer, contentType?: string) {
  return new NflversePlayByPlaySource({
    fetch: () =>
      Promise.resolve(
        new Response(new Uint8Array(bytes), {
          ...(contentType === undefined ? {} : { headers: { "content-type": contentType } }),
        }),
      ),
  });
}

describe("complete play-by-play football event snapshots", () => {
  it.each(["application/gzip", "application/x-gzip", "application/octet-stream"])(
    "accepts declared compressed content %s while retaining parser admission",
    async (contentType) => {
      await expect(source(artifact(), contentType).load(2024)).resolves.toMatchObject({
        rowsRead: 1,
      });
      await expect(source(Buffer.from("not gzip"), contentType).load(2024)).rejects.toMatchObject({
        code: "INVALID_CSV",
      });
    },
  );

  it("rejects an HTML error response even when its body resembles a gzip artifact", async () => {
    await expect(source(artifact(), "text/html").load(2024)).rejects.toMatchObject({
      code: "CONTENT_TYPE",
    });
  });

  it("shares a reconciled real defensive scoring ledger with the player and fourth-down capture", async () => {
    const csv = readFileSync(new URL("./fixtures/play-by-play-cle-pit-2023.csv", import.meta.url));
    const bytes = gzipSync(csv);
    const result = await source(bytes).load(2023);
    expect(result.rowsRead).toBe(185);
    expect(result.defenseScoringEvents).toHaveLength(1);
    const scoring = result.defenseScoringEvents![0]!;
    expect(scoring.state).toBe("complete");
    expect(scoring.provenance.artifactChecksumSha256).toBe(result.checksumSha256);
    expect(scoring.finality?.sourceChecksumSha256).toBe(result.checksumSha256);
    expect(scoring.teams?.find((row) => row.team === "PIT")).toMatchObject({
      defensiveTouchdowns: 2,
      defensiveFumbleTouchdowns: 1,
      pointsScored: 26,
    });
    expect(scoring.teams?.find((row) => row.team === "CLE")?.pointsScored).toBe(22);
  });

  it("retains unfinished scoring evidence without representing it as complete zero totals", async () => {
    const result = await source(artifact()).load(2024);
    expect(result.defenseScoringEvents?.[0]).toMatchObject({ state: "unresolved", teams: null });
    expect(result.defenseScoringEvents?.[0]?.issues).toContainEqual({
      playId: null,
      reason: "explicit-finality-unavailable",
    });
  });

  it("derives nested long-TD counts from each credited event at exact40/50yard boundaries", async () => {
    const rows = [39, 40, 49, 50].flatMap((yards, index) => [
      { play_id: String(index * 2), passing_yards: String(yards), receiving_yards: String(yards) },
      {
        play_id: String(index * 2 + 1),
        play_type: "run",
        pass_touchdown: "0",
        rush_touchdown: "1",
        rusher_player_id: "00-0037240",
        rushing_yards: String(yards),
      },
    ]);
    const bytes = artifact(rows);
    const result = await source(bytes).load(2024);
    expect(result.checksumSha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(result).toMatchObject({ rowsRead: 8, rowsRejected: 0, coveredGames: 1 });
    expect(result.playerTouchdowns.find((row) => row.gsisId === "00-0033106")).toMatchObject({
      passing_touchdowns: 4,
      passing_touchdowns_40_plus: 3,
      passing_touchdowns_50_plus: 1,
    });
    expect(result.playerTouchdowns.find((row) => row.gsisId === "00-0037240")).toMatchObject({
      receiving_touchdowns: 4,
      receiving_touchdowns_40_plus: 3,
      receiving_touchdowns_50_plus: 1,
      rushing_touchdowns: 4,
      rushing_touchdowns_40_plus: 3,
      rushing_touchdowns_50_plus: 1,
    });
  });

  it("credits the real2024Detroit lateral touchdown to Williams using official numeric yards", async () => {
    const result = await source(
      artifact([
        {
          play_id: "1168",
          receiver_player_id: "00-0036963",
          receiving_yards: "1",
          passing_yards: "42",
          lateral_receiver_player_id: "00-0037240",
          lateral_receiving_yards: "41",
        },
      ]),
    ).load(2024);
    expect(result.playerTouchdowns.find((row) => row.gsisId === "00-0037240")).toMatchObject({
      receiving_touchdowns: 1,
      receiving_touchdowns_40_plus: 1,
      receiving_touchdowns_50_plus: 0,
    });
    expect(result.playerTouchdowns.some((row) => row.gsisId === "00-0036963")).toBe(false);
  });

  it("retains touchdowns on plays with accepted penalties rather than dropping every penalty", async () => {
    const result = await source(artifact([{ penalty: "1" }])).load(2024);
    expect(result.playerTouchdowns).toHaveLength(2);
    expect(result.observations.find((row) => row.team === "SF")?.fourthDownStops).toBe(0);
  });

  it.each([
    { td_player_id: "" },
    { td_player_id: "00-0000001" },
    { passer_player_id: "invalid" },
    { receiving_yards: "" },
    { receiving_yards: "NaN" },
    { receiving_yards: "41.5" },
    { pass_touchdown: "2" },
    { rush_touchdown: "1" },
    { two_point_attempt: "1" },
    { play_deleted: "1" },
    { play_type: "no_play" },
  ])("rejects the whole artifact for ambiguous positive touchdown evidence%j", async (row) => {
    await expect(source(artifact([{}, { ...row, play_id: "2" }])).load(2024)).rejects.toMatchObject(
      {
        code: "QUALITY_THRESHOLD",
      },
    );
  });

  it("rejects missing event capability, duplicate plays, and corrupt compressed data", async () => {
    await expect(source(artifact([{}], "td_player_id")).load(2024)).rejects.toMatchObject({
      code: "INVALID_CSV",
    });
    await expect(source(artifact([{}, {}])).load(2024)).rejects.toMatchObject({
      code: "QUALITY_THRESHOLD",
    });
    await expect(source(Buffer.from("invalid gzip")).load(2024)).rejects.toMatchObject({
      code: "INVALID_CSV",
    });
  });

  it("shares exactly one immutable season snapshot with the existing fourth-down consumer", async () => {
    const underlying = { load: vi.fn((season: number) => source(artifact()).load(season)) };
    const snapshot = snapshotNflversePlayByPlay(underlying, 2024);
    const [players, defense] = await Promise.all([
      snapshot.load(2024),
      fourthDownStopsFromPlayByPlay(snapshot).load(2024),
    ]);
    expect(underlying.load).toHaveBeenCalledTimes(1);
    expect(defense.checksumSha256).toBe(players.checksumSha256);
    expect(defense.observations).toBe(players.observations);
    expect(() => snapshot.load(2025)).toThrow(/scoped/);
  });

  it("keeps a failed batch failed without caching an invented empty success", async () => {
    const underlying = { load: vi.fn(() => Promise.reject(new Error("source failed"))) };
    const snapshot = snapshotNflversePlayByPlay(underlying, 2024);
    await expect(snapshot.load(2024)).rejects.toThrow("source failed");
    await expect(snapshot.load(2024)).rejects.toThrow("source failed");
    expect(underlying.load).toHaveBeenCalledTimes(1);
  });
});
