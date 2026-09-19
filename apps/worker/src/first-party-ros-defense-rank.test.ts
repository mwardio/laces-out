import { describe, expect, it } from "vitest";
import { NFL_TEAMS } from "@laces-out/domain";
import type { FirstPartyTeamDefenseWeeklyStatLine } from "@laces-out/projections";
import { buildFirstPartyRosDefenseRank } from "./first-party-ros-defense-rank.js";
import {
  HISTORICAL_ROS_SCORING_PROFILE,
  selectHistoricalRosDefenses,
} from "./first-party-ros-backtest.js";

const source = {
  season: 2026,
  asOfWeek: 5,
  sourceHistoryChecksum: "a".repeat(64),
  finalityChecksum: "b".repeat(64),
};
const history = (): FirstPartyTeamDefenseWeeklyStatLine[] =>
  NFL_TEAMS.flatMap((team, i) =>
    [1, 2, 3, 4, 5].map((week) => ({
      team,
      season: 2026,
      week,
      components: {
        defensive_sacks: (i % 5) + week,
        defensive_interceptions: i % 3,
        defensive_touchdowns: 0,
      },
    })),
  );

describe("full32 ROS reference defense rank", () => {
  it("matches the frozen reference selector and is invariant to input row order", () => {
    const rows = history();
    const result = buildFirstPartyRosDefenseRank({ ...source, history: rows });
    expect(result.state).toBe("ready");
    if (result.state !== "ready") throw new Error("fixture unavailable");
    const expected = selectHistoricalRosDefenses({
      ...source,
      history: rows,
      scoringProfile: HISTORICAL_ROS_SCORING_PROFILE,
      teams: 32,
    });
    expect(result.ranks).toEqual(
      expected.map((row, i) => ({ canonicalTeam: row.team, ordinalRank: i + 1 })),
    );
    expect(buildFirstPartyRosDefenseRank({ ...source, history: rows.toReversed() })).toEqual(
      result,
    );
    expect(result.canAuthorizeRelease).toBe(false);
  });
  it("ignores future and previous-season outcomes while binding the selected source evidence", () => {
    const rows = history();
    const expected = buildFirstPartyRosDefenseRank({ ...source, history: rows });
    const extra = [
      { ...rows[0]!, week: 6, components: { defensive_sacks: NaN } },
      { ...rows[0]!, season: 2025, components: { defensive_sacks: Infinity } },
    ];
    expect(buildFirstPartyRosDefenseRank({ ...source, history: [...rows, ...extra] })).toEqual(
      expected,
    );
    const changed = buildFirstPartyRosDefenseRank({
      ...source,
      sourceHistoryChecksum: "c".repeat(64),
      history: rows,
    });
    expect(changed.state).toBe("ready");
    if (expected.state === "ready" && changed.state === "ready") {
      expect(changed.ranks).toEqual(expected.ranks);
      expect(changed.checksum).not.toBe(expected.checksum);
    }
  });
  it("canonicalizes aliases without changing historical LA tie order", () => {
    const rows = NFL_TEAMS.map((team) => ({
      team: team === "LAR" ? "LA" : team,
      season: 2026,
      week: 1,
      components: { defensive_sacks: 1 },
    }));
    const result = buildFirstPartyRosDefenseRank({ ...source, history: rows });
    expect(result.state).toBe("ready");
    if (result.state !== "ready") throw new Error("fixture unavailable");
    const teams = result.ranks.map((row) => row.canonicalTeam);
    expect(teams.indexOf("LAR")).toBeLessThan(teams.indexOf("LAC"));
    expect(teams).not.toContain("LA");
    expect(
      buildFirstPartyRosDefenseRank({
        ...source,
        history: [...rows, { ...rows.find((row) => row.team === "LA")!, team: "LAR" }],
      }),
    ).toMatchObject({ state: "unavailable", reason: "duplicate-canonical-defense-week" });
  });
  it("refuses incomplete, unplayed and preseason universes", () => {
    const rows = history();
    expect(buildFirstPartyRosDefenseRank({ ...source, asOfWeek: 0, history: rows })).toMatchObject({
      state: "unavailable",
      reason: "preseason-reference-rank-unavailable",
    });
    expect(
      buildFirstPartyRosDefenseRank({ ...source, history: rows.filter((r) => r.team !== "BUF") }),
    ).toMatchObject({ state: "unavailable", reason: "full-defense-universe-unavailable" });
    expect(
      buildFirstPartyRosDefenseRank({
        ...source,
        history: rows.map((r) => (r.team === "BUF" ? { ...r, played: false } : r)),
      }),
    ).toMatchObject({ state: "unavailable", reason: "full-eligible-defense-universe-unavailable" });
  });
  it("requires authenticatable source identities and rejects invalid current components", () => {
    const rows = history();
    expect(() =>
      buildFirstPartyRosDefenseRank({ ...source, finalityChecksum: "missing", history: rows }),
    ).toThrow();
    expect(
      buildFirstPartyRosDefenseRank({
        ...source,
        history: [{ ...rows[0]!, components: { defensive_sacks: NaN } }, ...rows.slice(1)],
      }),
    ).toMatchObject({ state: "unavailable", reason: "invalid-history-components" });
    expect(
      buildFirstPartyRosDefenseRank({
        ...source,
        history: [{ ...rows[0]!, team: "unknown" }, ...rows.slice(1)],
      }),
    ).toMatchObject({ state: "unavailable", reason: "unknown-defense-team" });
  });
});
