import { describe, expect, it } from "vitest";

import {
  buildFirstPartyDefenseHistory,
  buildFirstPartyPlayerHistory,
  firstPartyInputEpoch,
  firstPartyPlayerStatus,
  projectionInputChecksum,
  recentRoleContext,
  FIRST_PARTY_INPUT_EPOCH_VERSION,
} from "./first-party-projection-inputs.js";

describe("first-party projection input assembly", () => {
  it("derives canonical fumbles and role shares from immutable weekly facts", () => {
    const history = buildFirstPartyPlayerHistory(
      [
        {
          playerId: "player-a",
          position: "WR",
          season: 2025,
          week: 1,
          gameId: "game-1",
          team: "CHI",
          opponentTeam: "GB",
          components: {
            targets: 8,
            receptions: 5,
            carries: 1,
            rushing_fumbles_lost: 1,
            receiving_fumbles_lost: 0,
            fumbles_lost_total: 1,
            passing_two_point_conversions: 1,
            receiving_two_point_conversions: 1,
            field_goals_made_20_29: 1,
            field_goals_made_30_39: 1,
            field_goals_made_50_59: 1,
            field_goals_made_60_plus: 1,
            punt_return_yards: 12,
            kickoff_return_yards: 28,
            special_teams_touchdowns: 1,
          },
          advanced: { targetShare: 0.25 },
        },
        {
          playerId: "player-b",
          position: "WR",
          season: 2025,
          week: 1,
          gameId: "game-1",
          team: "CHI",
          opponentTeam: "GB",
          components: { targets: 12, receptions: 8, carries: 3 },
          advanced: {},
        },
      ],
      [
        {
          playerId: "player-a",
          position: "WR",
          season: 2025,
          week: 1,
          gameId: "game-1",
          team: "CHI",
          opponentTeam: "GB",
          offenseShare: 0.8,
          specialTeamsShare: 0,
        },
      ],
    );
    expect(history[0]).toMatchObject({
      playerId: "player-a",
      snapShare: 0.8,
      targetShare: 0.25,
      carryShare: 0.25,
      components: {
        fumbles_lost: 1,
        two_point_conversions: 2,
        field_goals_made_0_39: 2,
        field_goals_made_50_plus: 2,
        return_yards: 40,
        return_touchdowns: 1,
      },
    });
    expect(history[1]?.targetShare).toBeCloseTo(0.6);
    expect(recentRoleContext(history, "player-a")).toMatchObject({
      snapShare: 0.8,
      targetShare: 0.25,
    });
  });

  it("retains snap-only zero-production appearances for honest evaluation", () => {
    const history = buildFirstPartyPlayerHistory(
      [],
      [
        {
          playerId: "player-a",
          position: "WR",
          season: 2025,
          week: 2,
          gameId: "game-2",
          team: "CHI",
          opponentTeam: "GB",
          offenseShare: 0.44,
          specialTeamsShare: 0,
        },
        {
          playerId: "kicker-a",
          position: "K",
          season: 2025,
          week: 2,
          gameId: "game-2",
          team: "CHI",
          opponentTeam: "GB",
          offenseShare: 0,
          specialTeamsShare: 0.31,
        },
        {
          playerId: "inactive-a",
          position: "RB",
          season: 2025,
          week: 2,
          gameId: "game-2",
          team: "CHI",
          opponentTeam: "GB",
          offenseShare: 0,
          specialTeamsShare: 0,
        },
      ],
    );

    expect(history.map((row) => row.playerId)).toEqual(["kicker-a", "player-a"]);
    expect(history.find((row) => row.playerId === "player-a")).toMatchObject({
      team: "CHI",
      opponent: "GB",
      snapShare: 0.44,
      played: true,
      components: { fumbles_lost: 0, two_point_conversions: 0 },
    });
  });

  it("adds completed rostered DNPs without inventing future or bye-week zeroes", () => {
    const history = buildFirstPartyPlayerHistory(
      [],
      [],
      [
        { playerId: "dnp", position: "WR", season: 2025, week: 2, team: "CHI" },
        {
          playerId: "dnp",
          position: "WR",
          season: 2025,
          week: 2,
          team: "CHI",
          status: "INA",
        },
        { playerId: "future", position: "RB", season: 2025, week: 3, team: "CHI" },
        { playerId: "bye", position: "TE", season: 2025, week: 2, team: "DAL" },
      ],
      [
        {
          season: 2025,
          week: 2,
          gameId: "game-2",
          awayTeam: "CHI",
          homeTeam: "GB",
          awayScore: 17,
          homeScore: 20,
        },
        {
          season: 2025,
          week: 3,
          gameId: "game-3",
          awayTeam: "CHI",
          homeTeam: "MIN",
          awayScore: null,
          homeScore: null,
        },
      ],
    );

    expect(history).toEqual([
      expect.objectContaining({
        playerId: "dnp",
        team: "CHI",
        opponent: "GB",
        played: false,
        snapShare: 0,
        status: "inactive",
      }),
    ]);
    expect(Object.values(history[0]?.components ?? {}).every((value) => value === 0)).toBe(true);
  });

  it("uses the most restrictive status across catalog and injury sources", () => {
    expect(firstPartyPlayerStatus("ACT", "Questionable")).toBe("questionable");
    expect(firstPartyPlayerStatus("active", "IR")).toBe("ir");
    expect(firstPartyPlayerStatus("RES")).toBe("inactive");
    expect(firstPartyPlayerStatus("DEV")).toBe("inactive");
    expect(firstPartyPlayerStatus("SUS")).toBe("suspended");
    expect(firstPartyPlayerStatus("Probable")).toBe("active");
    expect(firstPartyPlayerStatus("Did Not Participate")).toBe("unknown");
    expect(firstPartyPlayerStatus(null, "n/a")).toBe("unknown");
  });

  it("attaches the most restrictive historical report status to played outcomes", () => {
    const history = buildFirstPartyPlayerHistory(
      [
        {
          playerId: "player-a",
          position: "WR",
          season: 2025,
          week: 4,
          gameId: "game-4",
          team: "CHI",
          opponentTeam: "GB",
          components: { targets: 8, receptions: 5, receiving_yards: 70 },
          advanced: {},
        },
      ],
      [],
      [],
      [],
      [
        {
          playerId: "player-a",
          season: 2025,
          week: 4,
          reportStatus: "Questionable",
          practiceStatus: "full",
        },
      ],
    );

    expect(history[0]?.status).toBe("questionable");
    expect(history[0]?.played).toBe(true);
  });

  it("derives defense allowed and blocked-kick facts from reciprocal team rows", () => {
    const history = buildFirstPartyDefenseHistory(
      [
        {
          season: 2025,
          week: 1,
          gameId: "game-1",
          team: "CHI",
          opponentTeam: "GB",
          components: {
            defensive_sacks: 3,
            defensive_interceptions: 1,
            defensive_fumbles_recovered: 2,
            defensive_safeties: 0,
            defensive_touchdowns: 1,
            special_teams_touchdowns: 0,
            total_offensive_yards: 310,
          },
        },
        {
          season: 2025,
          week: 1,
          gameId: "game-1",
          team: "GB",
          opponentTeam: "CHI",
          components: {
            field_goals_blocked: 1,
            extra_points_blocked: 0,
            punts_blocked: 1,
            total_offensive_yards: 275,
          },
        },
      ],
      [
        {
          season: 2025,
          week: 1,
          gameId: "game-1",
          awayTeam: "CHI",
          homeTeam: "GB",
          awayScore: 24,
          homeScore: 17,
        },
      ],
    );
    expect(history.find((row) => row.team === "CHI")?.components).toMatchObject({
      defensive_sacks: 3,
      defensive_fumble_recoveries: 2,
      defensive_blocked_kicks: 2,
      points_allowed: 17,
      yards_allowed: 275,
    });
  });

  it("excludes opposing defensive touchdowns and safeties from D/ST points allowed", () => {
    const history = buildFirstPartyDefenseHistory(
      [
        {
          season: 2025,
          week: 2,
          gameId: "game-2",
          team: "CHI",
          opponentTeam: "GB",
          components: {},
        },
        {
          season: 2025,
          week: 2,
          gameId: "game-2",
          team: "GB",
          opponentTeam: "CHI",
          components: {
            defensive_touchdowns: 1,
            defensive_safeties: 1,
            special_teams_touchdowns: 1,
            total_offensive_yards: 280,
          },
        },
      ],
      [
        {
          season: 2025,
          week: 2,
          gameId: "game-2",
          awayTeam: "CHI",
          homeTeam: "GB",
          awayScore: 20,
          homeScore: 30,
        },
      ],
    );

    // The defensive TD (6) and safety (2) are excluded; the special-teams TD remains charged.
    expect(history.find((row) => row.team === "CHI")?.components.points_allowed).toBe(22);
  });

  it("hashes canonical content rather than object insertion order", () => {
    expect(projectionInputChecksum({ b: 2, a: [1, { d: 4, c: 3 }] })).toBe(
      projectionInputChecksum({ a: [1, { c: 3, d: 4 }], b: 2 }),
    );
    expect(projectionInputChecksum({ a: 1 })).not.toBe(projectionInputChecksum({ a: 2 }));
  });

  describe("firstPartyInputEpoch", () => {
    const sourceA = {
      key: "nflverse.stats-player-week.2025",
      checksum: "a".repeat(64),
      asOf: "2026-09-01T00:00:00.000Z",
    };
    const sourceB = {
      key: "nflverse.snap-counts.2025",
      checksum: "b".repeat(64),
      asOf: "2026-09-01T00:05:00.000Z",
    };
    const sourceC = {
      key: "sleeper.players",
      checksum: "c".repeat(64),
      asOf: "2026-09-01T00:10:00.000Z",
    };

    it("is a 64-character sha256 hex identity", () => {
      expect(firstPartyInputEpoch([sourceA, sourceB, sourceC])).toMatch(/^[0-9a-f]{64}$/u);
    });

    it("is deterministic with respect to source ordering", () => {
      expect(firstPartyInputEpoch([sourceA, sourceB, sourceC])).toBe(
        firstPartyInputEpoch([sourceC, sourceA, sourceB]),
      );
      expect(firstPartyInputEpoch([sourceA, sourceB, sourceC])).toBe(
        firstPartyInputEpoch([sourceB, sourceC, sourceA]),
      );
    });

    it("normalizes a Date asOf identically to its own ISO string", () => {
      const asOfDate = new Date("2026-09-01T00:00:00.000Z");
      expect(firstPartyInputEpoch([{ ...sourceA, asOf: asOfDate }])).toBe(
        firstPartyInputEpoch([{ ...sourceA, asOf: asOfDate.toISOString() }]),
      );
    });

    it("changes when any one source's checksum, asOf, or key membership changes", () => {
      const base = firstPartyInputEpoch([sourceA, sourceB, sourceC]);
      expect(
        firstPartyInputEpoch([{ ...sourceA, checksum: "d".repeat(64) }, sourceB, sourceC]),
      ).not.toBe(base);
      expect(
        firstPartyInputEpoch([{ ...sourceA, asOf: "2026-09-01T00:00:00.001Z" }, sourceB, sourceC]),
      ).not.toBe(base);
      expect(firstPartyInputEpoch([sourceA, sourceB])).not.toBe(base);
    });

    it("is pinned to its own version constant so a future serialization change is auditable", () => {
      expect(FIRST_PARTY_INPUT_EPOCH_VERSION).toBe("first-party-input-epoch-v1");
    });
  });
});
