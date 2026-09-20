import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  NFLVERSE_WEEKLY_STATS_SOURCE_KEY,
  NFLVERSE_WEEKLY_STATS_COMPONENT_SCHEMA,
  NflverseDatasetSourceError,
  NflverseWeeklyStatsSource,
  buildNflverseWeeklyStatsUrl,
  inspectNflversePlayerStatLedger,
  type NflverseDatasetState,
} from "./index.js";

import {
  weeklyStatsPlayByPlayFixture,
  weeklyStatsPlayByPlayLoader,
} from "./weekly-stats-source.test-fixtures.js";

const fixture = readFileSync(
  new URL("./fixtures/player-weekly-stats.csv", import.meta.url),
  "utf8",
);
const EMPTY_STATE: NflverseDatasetState = {
  etag: null,
  lastModified: null,
  checksumSha256: null,
};

describe("player-stat zero-production ledger", () => {
  it("records every player identity and game without relying on position", () => {
    const ledger = inspectNflversePlayerStatLedger(fixture, 2025);
    expect(ledger.state).toBe("complete");
    expect(ledger.playerWeeks).toHaveLength(2);
    expect(ledger.sourceChecksum).toBe(createHash("sha256").update(fixture).digest("hex"));
  });

  it("does not forgive a rejected identity with observed player production", () => {
    const ledger = inspectNflversePlayerStatLedger(
      fixture.replace("00-0039999", "bad-player-id"),
      2025,
    );
    expect(ledger.state).toBe("incomplete");
    expect(ledger.unknownPlayerProductionRows).toBe(1);
  });

  it("rejects duplicate player games as completeness evidence", () => {
    const lines = fixture.trimEnd().split("\n");
    const ledger = inspectNflversePlayerStatLedger(`${fixture.trimEnd()}\n${lines[1]}\n`, 2025);
    expect(ledger.state).toBe("incomplete");
  });

  it("permits an unassigned team row only with explicit zero player components", () => {
    const lines = fixture.trimEnd().split("\n");
    const columns = lines[0]!.split(",");
    const original = lines[1]!.split(",");
    const zero = original.map((value, index) => {
      const key = columns[index]!;
      if (
        ["player_id", "player_name", "player_display_name", "position", "fg_blocked_list"].includes(
          key,
        )
      )
        return "";
      if (["season", "week", "season_type", "game_id", "team", "opponent_team"].includes(key))
        return value;
      return "0";
    });
    const body = `${fixture.trimEnd()}\n${zero.join(",")}\n`;
    const ledger = inspectNflversePlayerStatLedger(body, 2025);
    expect(ledger.state).toBe("complete");
    expect(ledger.unassignedZeroProductionRows).toBe(1);
    zero[columns.indexOf("passing_yards")] = "1";
    expect(
      inspectNflversePlayerStatLedger(`${fixture.trimEnd()}\n${zero.join(",")}\n`, 2025).state,
    ).toBe("incomplete");
    zero[columns.indexOf("passing_yards")] = "";
    expect(
      inspectNflversePlayerStatLedger(`${fixture.trimEnd()}\n${zero.join(",")}\n`, 2025).state,
    ).toBe("incomplete");
  });
});

function replaceCell(body: string, playerId: string, column: string, value: string): string {
  const rows = body
    .trimEnd()
    .split("\n")
    .map((line) => line.split(","));
  const header = rows[0] ?? [];
  const playerIndex = header.indexOf("player_id");
  const columnIndex = header.indexOf(column);
  const row = rows.find((candidate, index) => index > 0 && candidate[playerIndex] === playerId);
  if (!row || columnIndex < 0) throw new Error(`Fixture omitted ${playerId}:${column}`);
  row[columnIndex] = value;
  return rows.map((candidate) => candidate.join(",")).join("\n");
}

describe("NflverseWeeklyStatsSource", () => {
  it("normalizes an official weekly-stat CSV into scoring and usage observations", async () => {
    const requests: Array<{ readonly url: string; readonly headers: Headers }> = [];
    const source = new NflverseWeeklyStatsSource({
      playByPlay: weeklyStatsPlayByPlayLoader,
      now: () => new Date("2026-07-21T15:00:00.000Z"),
      fetch: (input, init) => {
        requests.push({ url: input.toString(), headers: new Headers(init?.headers) });
        return Promise.resolve(
          new Response(fixture, {
            headers: {
              "content-type": "text/csv; charset=utf-8",
              etag: '"stats-2025-v2"',
              "last-modified": "Tue, 21 Jul 2026 14:00:00 GMT",
            },
          }),
        );
      },
    });

    const result = await source.check(2025, {
      ...EMPTY_STATE,
      etag: '"stats-2025-v1"',
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(buildNflverseWeeklyStatsUrl(2025));
    expect(requests[0]?.headers.get("if-none-match")).toBeNull();
    expect(result).toMatchObject({
      state: "changed",
      sourceKey: NFLVERSE_WEEKLY_STATS_SOURCE_KEY,
      season: 2025,
      rowsRead: 2,
      rowsRejected: 0,
      coveredWeeks: [1],
      coveredSeasonTypes: ["REG"],
      etag: '"stats-2025-v2"',
    });
    if (result.state === "changed") {
      expect(result.checksumSha256).toMatch(/^[a-f0-9]{64}$/u);
      const receiver = result.observations[0];
      expect(receiver).toMatchObject({
        gsisId: "00-0039999",
        displayName: "Example Runner",
        team: "CHI",
        opponentTeam: "GB",
        sourceFantasyPoints: { standard: 16.3, ppr: 23.3 },
      });
      expect(receiver?.components).toMatchObject({
        receptions: 7,
        targets: 10,
        receiving_yards: 98,
        receiving_touchdowns: 1,
        fumbles_lost_total: 0,
      });
      expect(receiver?.advanced).toMatchObject({ targetShare: 0.31, airYardsShare: 0.44 });
      expect(result.observations[1]?.components).toMatchObject({
        passing_attempts: 35,
        sack_fumbles_lost: 1,
        fumbles_lost_total: 1,
      });
    }
  });

  it("rejects an unconditioned304 because it cannot establish a complete composite snapshot", async () => {
    const source = new NflverseWeeklyStatsSource({
      playByPlay: weeklyStatsPlayByPlayLoader,
      fetch: () => Promise.resolve(new Response(null, { status: 304 })),
    });
    await expect(
      source.check(2025, {
        etag: '"same"',
        lastModified: "Tue, 21 Jul 2026 14:00:00 GMT",
        checksumSha256: "a".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "UPSTREAM" });
  });

  it("versions the normalized observation checksum independently from unchanged upstream bytes", async () => {
    const source = new NflverseWeeklyStatsSource({
      playByPlay: weeklyStatsPlayByPlayLoader,
      fetch: () => Promise.resolve(new Response(fixture)),
    });
    const first = await source.check(2025, EMPTY_STATE);
    if (first.state !== "changed") throw new Error("Expected changed player stats");

    const second = await source.check(2025, {
      etag: null,
      lastModified: null,
      checksumSha256: first.checksumSha256,
    });

    expect(second).toMatchObject({
      state: "unchanged",
      checksumSha256: first.checksumSha256,
    });
    const rawChecksum = createHash("sha256").update(fixture).digest("hex");
    const previousChecksum = createHash("sha256")
      .update(`nflverse-player-week-components-v2:${rawChecksum}`)
      .digest("hex");
    expect(first.checksumSha256).toBe(
      createHash("sha256")
        .update(`${NFLVERSE_WEEKLY_STATS_COMPONENT_SCHEMA}:${rawChecksum}:${"b".repeat(64)}`)
        .digest("hex"),
    );
    expect(first.checksumSha256).not.toBe(previousChecksum);
    await expect(
      source.check(2025, { ...EMPTY_STATE, checksumSha256: previousChecksum }),
    ).resolves.toMatchObject({ state: "changed", checksumSha256: first.checksumSha256 });
  });

  it("detects PBP-only corrections while the player CSV stays byte-identical", async () => {
    const original = weeklyStatsPlayByPlayFixture();
    let corrected = false;
    const source = new NflverseWeeklyStatsSource({
      fetch: () => Promise.resolve(new Response(fixture)),
      playByPlay: {
        load: () =>
          Promise.resolve(
            corrected
              ? {
                  ...original,
                  checksumSha256: "c".repeat(64),
                  playerTouchdowns: original.playerTouchdowns.map((row) =>
                    row.gsisId === "00-0039999" ? { ...row, receiving_touchdowns_40_plus: 0 } : row,
                  ),
                }
              : original,
          ),
      },
    });
    const first = await source.check(2025, EMPTY_STATE);
    corrected = true;
    const second = await source.check(2025, {
      ...EMPTY_STATE,
      checksumSha256: first.checksumSha256,
    });
    expect(second.state).toBe("changed");
    expect(second.checksumSha256).not.toBe(first.checksumSha256);
    if (second.state === "changed")
      expect(second.observations[0]!.components.receiving_touchdowns_40_plus).toBe(0);
  });

  it.each(["missing-game", "missing-player", "wrong-total", "nested-count", "wrong-season"])(
    "withholds the entire snapshot for %s PBP evidence",
    async (failure) => {
      const original = weeklyStatsPlayByPlayFixture();
      const invalid = {
        ...original,
        ...(failure === "wrong-season" ? { season: 2024 } : {}),
        ...(failure === "missing-game" ? { observations: [] } : {}),
        ...(failure === "missing-player"
          ? { playerTouchdowns: original.playerTouchdowns.slice(1) }
          : {}),
        ...(["wrong-total", "nested-count"].includes(failure)
          ? {
              playerTouchdowns: original.playerTouchdowns.map((row) =>
                row.gsisId === "00-0039999"
                  ? {
                      ...row,
                      ...(failure === "wrong-total"
                        ? { receiving_touchdowns: 2 }
                        : { receiving_touchdowns_50_plus: 2 }),
                    }
                  : row,
              ),
            }
          : {}),
      };
      const source = new NflverseWeeklyStatsSource({
        fetch: () => Promise.resolve(new Response(fixture)),
        playByPlay: { load: () => Promise.resolve(invalid) },
      });
      await expect(source.check(2025, EMPTY_STATE)).rejects.toMatchObject({
        code: "QUALITY_THRESHOLD",
      });
    },
  );

  it("includes the official blocked-kick distances in both total and fine misses", async () => {
    // Joshua Karty 2025 week 3: two blocks at 36 and 44 yards, no ordinary misses.
    let body = replaceCell(fixture, "00-0039999", "fg_att", "2");
    body = replaceCell(body, "00-0039999", "fg_blocked", "2");
    body = replaceCell(body, "00-0039999", "fg_blocked_list", "36;44");
    const result = await new NflverseWeeklyStatsSource({
      playByPlay: weeklyStatsPlayByPlayLoader,
      fetch: () => Promise.resolve(new Response(body)),
    }).check(2025, EMPTY_STATE);
    if (result.state !== "changed") throw new Error("Expected changed player stats");
    expect(result.rejections.invalidStats).toBe(0);
    expect(result.observations[0]?.components).toMatchObject({
      field_goals_missed: 2,
      field_goals_missed_unblocked: 0,
      field_goals_blocked: 2,
      field_goals_blocked_30_39: 1,
      field_goals_blocked_40_49: 1,
      field_goals_missed_30_39: 1,
      field_goals_missed_40_49: 1,
    });
  });

  it("attributes blocked kicks exactly at fine-distance boundaries and preserves explicit zero", async () => {
    let body = replaceCell(fixture, "00-0039999", "fg_att", "11");
    body = replaceCell(body, "00-0039999", "fg_blocked", "11");
    body = replaceCell(body, "00-0039999", "fg_blocked_list", "19;20;29;30;39;40;49;50;59;60;100");
    const result = await new NflverseWeeklyStatsSource({
      playByPlay: weeklyStatsPlayByPlayLoader,
      fetch: () => Promise.resolve(new Response(body)),
    }).check(2025, EMPTY_STATE);
    if (result.state !== "changed") throw new Error("Expected changed player stats");
    expect(result.observations[0]?.components).toMatchObject({
      field_goals_missed: 11,
      field_goals_missed_0_19: 1,
      field_goals_missed_20_29: 2,
      field_goals_missed_30_39: 2,
      field_goals_missed_40_49: 2,
      field_goals_missed_50_59: 2,
      field_goals_missed_60_plus: 2,
    });
    expect(result.observations[1]?.components).toMatchObject({
      field_goals_blocked: 0,
      field_goals_missed: 0,
      field_goals_missed_unblocked: 0,
    });
  });

  it.each(["", "36;", "36;44;50", "36;NaN", "36;4e1", "36;44.5", "36;101", "36;0", "36;-1"])(
    "rejects missing, malformed, mismatched, or out-of-bounds blocked distances: %s",
    async (list) => {
      let body = replaceCell(fixture, "00-0039999", "fg_att", "2");
      body = replaceCell(body, "00-0039999", "fg_blocked", "2");
      body = replaceCell(body, "00-0039999", "fg_blocked_list", list);
      await expect(
        new NflverseWeeklyStatsSource({
          playByPlay: weeklyStatsPlayByPlayLoader,
          fetch: () => Promise.resolve(new Response(body)),
        }).check(2025, EMPTY_STATE),
      ).rejects.toMatchObject({ code: "QUALITY_THRESHOLD" });
    },
  );

  it("rejects inconsistent attempt totals and a missing blocked-distance column", async () => {
    const inconsistent = replaceCell(fixture, "00-0039999", "fg_att", "1");
    await expect(
      new NflverseWeeklyStatsSource({
        playByPlay: weeklyStatsPlayByPlayLoader,
        fetch: () => Promise.resolve(new Response(inconsistent)),
      }).check(2025, EMPTY_STATE),
    ).rejects.toMatchObject({ code: "QUALITY_THRESHOLD" });
    const missingColumn = fixture
      .split("\n")
      .map((row) => row.split(",").slice(0, -1).join(","))
      .join("\n");
    await expect(
      new NflverseWeeklyStatsSource({
        playByPlay: weeklyStatsPlayByPlayLoader,
        fetch: () => Promise.resolve(new Response(missingColumn)),
      }).check(2025, EMPTY_STATE),
    ).rejects.toMatchObject({ code: "INVALID_CSV" });
  });

  it("retains exact kicker miss buckets and total made-field-goal distance", async () => {
    const playerId = "00-0039999";
    let kicker = replaceCell(fixture, playerId, "position", "K");
    kicker = replaceCell(kicker, playerId, "position_group", "SPEC");
    kicker = replaceCell(kicker, playerId, "fg_made", "2");
    kicker = replaceCell(kicker, playerId, "fg_att", "5");
    kicker = replaceCell(kicker, playerId, "fg_missed", "2");
    kicker = replaceCell(kicker, playerId, "fg_made_20_29", "1");
    kicker = replaceCell(kicker, playerId, "fg_made_50_59", "1");
    kicker = replaceCell(kicker, playerId, "fg_missed_0_19", "1");
    kicker = replaceCell(kicker, playerId, "fg_missed_20_29", "1");
    kicker = replaceCell(kicker, playerId, "fg_blocked", "1");
    kicker = replaceCell(kicker, playerId, "fg_blocked_list", "27");
    kicker = replaceCell(kicker, playerId, "fg_made_distance", "79");
    const source = new NflverseWeeklyStatsSource({
      playByPlay: weeklyStatsPlayByPlayLoader,
      fetch: () => Promise.resolve(new Response(kicker)),
    });

    const result = await source.check(2025, EMPTY_STATE);
    if (result.state !== "changed") throw new Error("Expected changed player stats");
    expect(result.observations[0]?.components).toMatchObject({
      field_goals_missed_0_19: 1,
      field_goals_missed_20_29: 2,
      field_goals_missed: 3,
      field_goals_missed_unblocked: 2,
      field_goals_blocked: 1,
      field_goals_total_yards: 79,
    });
  });

  it("accounts for duplicate observations without admitting them", async () => {
    const [header, row, ...remaining] = fixture.trimEnd().split("\n");
    const body = [header, row, ...remaining, row].join("\n");
    const source = new NflverseWeeklyStatsSource({
      playByPlay: weeklyStatsPlayByPlayLoader,
      fetch: () => Promise.resolve(new Response(body)),
    });
    const result = await source.check(2025, EMPTY_STATE);
    expect(result).toMatchObject({
      state: "changed",
      rowsRead: 3,
      rowsRejected: 1,
      rejections: { duplicate: 1 },
    });
    if (result.state === "changed") expect(result.observations).toHaveLength(2);
  });

  it("fails closed when row rejections exceed the admission threshold", async () => {
    const [header, valid] = fixture.trimEnd().split("\n");
    const invalid = valid?.replace("00-0039999", "invalid-id") ?? "";
    const body = [header, valid, ...Array.from({ length: 26 }, () => invalid)].join("\n");
    const source = new NflverseWeeklyStatsSource({
      playByPlay: weeklyStatsPlayByPlayLoader,
      fetch: () => Promise.resolve(new Response(body)),
    });
    await expect(source.check(2025, EMPTY_STATE)).rejects.toMatchObject({
      code: "QUALITY_THRESHOLD",
      retryable: false,
    });
  });

  it.each([
    {
      name: "redirect to an unapproved host",
      response: new Response(null, {
        status: 302,
        headers: { location: "https://attacker.example/stats.csv" },
      }),
      code: "REDIRECT",
    },
    {
      name: "unexpected response type",
      response: new Response(fixture, { headers: { "content-type": "text/html" } }),
      code: "CONTENT_TYPE",
    },
    {
      name: "season artifact that is not published yet",
      response: new Response(null, { status: 404 }),
      code: "NOT_AVAILABLE",
    },
    {
      name: "oversized declared response",
      response: new Response(fixture, {
        headers: { "content-length": String(24 * 1024 * 1024 + 1) },
      }),
      code: "TOO_LARGE",
    },
  ])("rejects $name", async ({ response, code }) => {
    const source = new NflverseWeeklyStatsSource({
      playByPlay: weeklyStatsPlayByPlayLoader,
      fetch: () => Promise.resolve(response.clone()),
    });
    const error = await source.check(2025, EMPTY_STATE).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NflverseDatasetSourceError);
    expect(error).toMatchObject({ code, retryable: false });
  });

  it("validates season context before fetching", async () => {
    let fetched = false;
    const source = new NflverseWeeklyStatsSource({
      playByPlay: weeklyStatsPlayByPlayLoader,
      fetch: () => {
        fetched = true;
        return Promise.resolve(new Response(fixture));
      },
    });
    await expect(source.check(1998, EMPTY_STATE)).rejects.toMatchObject({
      code: "INVALID_CONTEXT",
    });
    expect(fetched).toBe(false);
  });
});
