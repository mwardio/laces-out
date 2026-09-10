import { playerExposureResponseSchema } from "@laces-out/contracts";
import { describe, expect, it } from "vitest";

import { buildPlayerExposureSummary, type PlayerExposureRow } from "./player-exposure.js";

const NOW = new Date("2026-09-10T12:00:00.000Z");
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function row(overrides: Partial<PlayerExposureRow> = {}): PlayerExposureRow {
  return {
    leagueId: id(1),
    leagueName: "League A",
    archived: false,
    provider: "espn",
    season: 2026,
    currentSeason: 2026,
    teamId: id(10),
    teamName: "Einhorn's End Zone",
    snapshotId: id(20),
    rosterUpdatedAt: NOW,
    week: 1,
    playerId: id(30),
    playerName: "Shared Player",
    position: "WR",
    nflTeam: "CIN",
    isStarter: true,
    ...overrides,
  };
}

describe("Player exposure aggregation", () => {
  it("deduplicates canonical players and league ownership, keeps starters a subset, and counts empty rosters", () => {
    const result = buildPlayerExposureSummary(
      [
        row({ isStarter: false }),
        row(),
        row(),
        row({ leagueId: id(2), leagueName: "League B", isStarter: false }),
        row({ leagueId: id(3), playerId: null, playerName: null, isStarter: null }),
        row({ leagueId: id(4), snapshotId: null, rosterUpdatedAt: null, playerId: null }),
      ],
      NOW,
    );
    expect(result.players).toEqual([
      {
        id: id(30),
        name: "Shared Player",
        position: "WR",
        nflTeam: "CIN",
        leagueIds: [id(1), id(2)],
        starterLeagueIds: [id(1)],
        rosterPercentage: 67,
      },
    ]);
    expect(result.leagues.filter((league) => league.status === "included")).toHaveLength(3);
    expect(result.leagues.find((league) => league.id === id(4))?.status).toBe("roster-missing");
  });

  it("explains exclusion coverage and never includes excluded players in ownership", () => {
    const result = buildPlayerExposureSummary(
      [
        row(),
        row({ leagueId: id(2), archived: true, season: 2027 }),
        row({ leagueId: id(3), season: 2025 }),
        row({ leagueId: id(4), season: null, provider: null }),
        row({ leagueId: id(5), teamId: null, teamName: null }),
        row({ leagueId: id(6), snapshotId: null, rosterUpdatedAt: null }),
      ],
      NOW,
    );
    expect(Object.fromEntries(result.leagues.map((league) => [league.id, league.status]))).toEqual({
      [id(1)]: "included",
      [id(2)]: "archived",
      [id(3)]: "other-season",
      [id(4)]: "no-season",
      [id(5)]: "team-unclaimed",
      [id(6)]: "roster-missing",
    });
    expect(result.players[0]?.leagueIds).toEqual([id(1)]);
    expect(result.players[0]?.rosterPercentage).toBe(100);
  });

  it("orders by ownership then starting count and distinguishes stale roster observations", () => {
    const result = buildPlayerExposureSummary(
      [
        row({ playerId: id(31), playerName: "Starter", isStarter: true }),
        row({ playerName: "Benched", isStarter: false }),
        row({ leagueId: id(2), rosterUpdatedAt: "2026-09-01T12:00:00.000Z" }),
        row({ leagueId: id(3), playerId: id(32), rosterUpdatedAt: "2026-09-10T00:00:00.000Z" }),
      ],
      NOW,
    );
    expect(result.players.map((player) => player.id)).toEqual([id(30), id(32), id(31)]);
    expect(result.leagues.find((league) => league.id === id(1))?.freshness?.state).toBe("fresh");
    expect(result.leagues.find((league) => league.id === id(2))?.freshness?.state).toBe("stale");
    expect(result.leagues.find((league) => league.id === id(3))?.freshness?.state).toBe("aging");
  });

  it("returns honest empty and all-excluded summaries", () => {
    expect(buildPlayerExposureSummary([], NOW)).toEqual({
      generatedAt: NOW.toISOString(),
      season: null,
      leagues: [],
      players: [],
    });
    expect(
      buildPlayerExposureSummary([row({ archived: true, currentSeason: null })], NOW).players,
    ).toEqual([]);
  });

  it("rejects inconsistent ownership, starter references, duplicate players, and percentages at the boundary", () => {
    const result = buildPlayerExposureSummary([row()], NOW);
    const player = result.players[0]!;
    for (const invalidPlayers of [
      [player, player],
      [{ ...player, leagueIds: [id(1), id(1)] }],
      [{ ...player, leagueIds: [id(999)] }],
      [{ ...player, starterLeagueIds: [id(999)] }],
      [{ ...player, rosterPercentage: 50 }],
    ]) {
      expect(
        playerExposureResponseSchema.safeParse({ ...result, players: invalidPlayers }).success,
      ).toBe(false);
    }
  });
});
