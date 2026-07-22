import { describe, expect, it, vi } from "vitest";

import {
  StatsCenterService,
  type StatsCenterRepository,
  type StatsCenterSourceRow,
} from "./stats-center.js";

const PLAYER_ID = "10000000-0000-4000-8000-000000000001";
const CHECKSUM = "a".repeat(64);

function source(
  dataset: "stats-player-week" | "snap-counts",
  metadata: StatsCenterSourceRow["metadata"] = {},
): StatsCenterSourceRow {
  return {
    id: dataset === "stats-player-week" ? "stats-source" : "snap-source",
    key: `nflverse.${dataset}.2025`,
    name: dataset === "stats-player-week" ? "Weekly player stats" : "Snap counts",
    attribution: "Data provided by nflverse (CC BY 4.0)",
    attributionUrl: "https://github.com/nflverse/nflverse-data",
    lastSuccessfulAt: new Date("2026-01-02T03:04:05.000Z"),
    lastChecksum: CHECKSUM,
    metadata: {
      publishable: true,
      rowsRead: 2,
      rowsRejected: 0,
      rowsUnmatched: 1,
      matchRate: 0.5,
      coveredWeeks: "1",
      ...metadata,
    },
  };
}

function repository(): StatsCenterRepository {
  return {
    findSource: (key) =>
      Promise.resolve(
        key.includes("stats-player-week")
          ? source("stats-player-week")
          : source("snap-counts", { rowsRead: 1, rowsUnmatched: 0, matchRate: 1 }),
      ),
    listWeeklyStats: () =>
      Promise.resolve([
        {
          externalPlayerId: "00-0000001",
          playerId: PLAYER_ID,
          playerName: "Steady Runner",
          position: "RB",
          season: 2025,
          week: 1,
          gameId: "2025_01_AAA_BBB",
          team: "AAA",
          opponentTeam: "BBB",
          components: { targets: 4, carries: 12 },
        },
        {
          externalPlayerId: "00-0000002",
          playerId: null,
          playerName: null,
          position: null,
          season: 2025,
          week: 1,
          gameId: "2025_01_AAA_BBB",
          team: "AAA",
          opponentTeam: "BBB",
          components: { targets: 6, carries: 0 },
        },
      ]),
    listSnapCounts: () =>
      Promise.resolve([
        {
          externalPlayerId: "RunnSt00",
          playerId: PLAYER_ID,
          playerName: "Steady Runner",
          position: "RB",
          season: 2025,
          week: 1,
          gameId: "2025_01_AAA_BBB",
          team: "AAA",
          opponentTeam: "BBB",
          offenseSnaps: 54,
          offenseShare: "0.75000",
        },
      ]),
  };
}

describe("StatsCenterService", () => {
  it("derives admitted opportunity leaders while excluding unresolved identities", async () => {
    const service = new StatsCenterService(
      repository(),
      () => new Date("2026-01-03T00:00:00.000Z"),
    );
    const result = await service.getPlayers("user", {
      season: 2025,
      week: 1,
      position: "RB",
      search: "runner",
      sort: "opportunities",
      limit: 25,
    });

    expect(result.generatedAt).toBe("2026-01-03T00:00:00.000Z");
    expect(result.totalMatched).toBe(1);
    expect(result.players[0]).toMatchObject({
      playerId: PLAYER_ID,
      targets: 4,
      carries: 12,
      opportunities: 16,
      targetShare: 0.4,
      offensiveSnaps: 54,
      offensiveSnapShare: 0.75,
    });
    expect(result.players.some((player) => player.playerId.includes("unmatched"))).toBe(false);
    expect(result.sources[0]).toMatchObject({
      state: "available",
      checksumSha256: CHECKSUM,
      quality: { rowsUnmatched: 1, matchRate: 0.5 },
    });
    expect(result.availability.redZone).toMatchObject({ state: "unavailable" });
    expect(result.availability.boomBust.reason).toContain("verified league scoring");
  });

  it("fails closed on a source that is not publishable", async () => {
    const listWeeklyStats = vi.fn(() => Promise.resolve([]));
    const repo: StatsCenterRepository = {
      ...repository(),
      findSource: (key) =>
        Promise.resolve(
          key.includes("stats-player-week")
            ? source("stats-player-week", { publishable: false })
            : undefined,
        ),
      listWeeklyStats,
    };
    const result = await new StatsCenterService(repo).getPlayers("user", {
      season: 2025,
      week: null,
      position: null,
      search: "",
      sort: "targets",
      limit: 50,
    });

    expect(listWeeklyStats).not.toHaveBeenCalled();
    expect(result.sources.map((item) => item.state)).toEqual(["quarantined", "unavailable"]);
    expect(result.availability.targets).toMatchObject({ state: "unavailable" });
    expect(result.players).toEqual([]);
  });

  it("withholds target share when rejected rows prevent a completeness assertion", async () => {
    const repo: StatsCenterRepository = {
      ...repository(),
      findSource: (key) =>
        Promise.resolve(
          key.includes("stats-player-week")
            ? source("stats-player-week", { rowsRejected: 1 })
            : source("snap-counts", { rowsRead: 1, rowsUnmatched: 0, matchRate: 1 }),
        ),
    };
    const result = await new StatsCenterService(repo).getPlayers("user", {
      season: 2025,
      week: null,
      position: null,
      search: "",
      sort: "targetShare",
      limit: 50,
    });

    expect(result.availability.targetShare).toMatchObject({ state: "unavailable" });
    expect(result.players[0]?.targetShare).toBeNull();
  });
});
