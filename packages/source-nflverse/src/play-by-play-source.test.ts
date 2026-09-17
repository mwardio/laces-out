import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import {
  NflversePlayByPlaySource,
  fourthDownStopsFromPlayByPlay,
  snapshotNflversePlayByPlay,
} from "./play-by-play-source.js";

const base = {
  play_id: "1",
  game_id: "2024_17_DET_SF",
  season: "2024",
  week: "17",
  season_type: "REG",
  home_team: "SF",
  away_team: "DET",
  defteam: "SF",
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
function source(bytes: Buffer) {
  return new NflversePlayByPlaySource({
    fetch: () => Promise.resolve(new Response(new Uint8Array(bytes))),
  });
}

describe("complete play-by-play football event snapshots", () => {
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
