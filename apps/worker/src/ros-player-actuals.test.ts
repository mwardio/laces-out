import { describe, expect, it } from "vitest";
import type { FirstPartyWeeklyStatLine } from "@laces-out/projections";
import type { NflversePlayerStatLedger } from "@laces-out/source-nflverse";
import { aggregateHistoricalRosPlayerActual } from "./first-party-ros-backtest.js";
import { historicalPlayerActualsFromLedgers } from "./ros-player-actuals.js";
import type { ProjectionScheduleFact } from "./first-party-projection-inputs.js";

const row: FirstPartyWeeklyStatLine = {
  playerId: "00-0039999",
  position: "QB",
  season: 2025,
  week: 2,
  team: "CHI",
  opponent: "GB",
  played: true,
  snapShare: 0.1,
  components: { passing_yards: 0 },
};
const game: ProjectionScheduleFact = {
  season: 2025,
  week: 2,
  gameId: "2025_02_CHI_GB",
  awayTeam: "CHI",
  homeTeam: "GB",
  awayScore: 0,
  homeScore: 7,
  status: "final",
};
const ledger: NflversePlayerStatLedger = {
  version: "nflverse-player-zero-ledger-v1",
  season: 2025,
  sourceChecksum: "a".repeat(64),
  state: "complete",
  unknownPlayerProductionRows: 0,
  unassignedZeroProductionRows: 1,
  playerWeeks: ["2025:2:00-0038888"],
  games: [
    { season: 2025, week: 2, gameId: game.gameId, team: "CHI", opponentTeam: "GB" },
    { season: 2025, week: 2, gameId: game.gameId, team: "GB", opponentTeam: "CHI" },
  ],
};

describe("independently certified historical player actuals", () => {
  it("certifies a snap-only appearance without changing forecast history or its game count", () => {
    const history = [row];
    const result = historicalPlayerActualsFromLedgers({
      history,
      schedules: [game],
      ledgers: [ledger],
    });
    expect(history[0]).toBe(row);
    expect(row.components).toEqual({ passing_yards: 0 });
    expect(result.history[0]?.components).toMatchObject({ receptions: 0, extra_points_made: 0 });
    expect(result.zeroObservations).toEqual([
      {
        playerId: row.playerId,
        season: 2025,
        week: 2,
        gameId: game.gameId,
        sourceChecksum: ledger.sourceChecksum,
        reason: "played-without-recorded-player-stats",
      },
    ]);
    const actual = aggregateHistoricalRosPlayerActual({
      history: result.history,
      playerId: row.playerId,
      season: 2025,
      windowStartWeek: 2,
      windowEndWeek: 2,
      scoringProfile: { id: "trick-play", rules: [{ statId: "receptions", points: 1 }] },
    });
    expect(actual.actualGames).toBe(1);
    expect(actual.actualPoints).toBe(0);
  });

  it.each([
    { ...ledger, state: "incomplete" as const, unknownPlayerProductionRows: 1 },
    { ...ledger, sourceChecksum: "invalid" },
    { ...ledger, games: ledger.games.slice(0, 1) },
    { ...ledger, playerWeeks: [...ledger.playerWeeks, "2025:2:00-0039999"] },
  ])("retains unknown stats when complete absence is not established (%j)", (candidate) => {
    const result = historicalPlayerActualsFromLedgers({
      history: [row],
      schedules: [game],
      ledgers: [candidate],
    });
    expect(result.history[0]).toBe(row);
    expect(result.zeroObservations).toEqual([]);
  });

  it.each([
    { ...row, components: { passing_yards: 1 } },
    { ...row, components: { passing_yards: Number.NaN } },
    { ...row, opponent: "MIN" },
    { ...row, played: false },
  ])("does not overwrite conflicting evidence (%j)", (candidate) => {
    const result = historicalPlayerActualsFromLedgers({
      history: [candidate],
      schedules: [game],
      ledgers: [ledger],
    });
    expect(result.history[0]).toBe(candidate);
    expect(result.zeroObservations).toEqual([]);
  });

  it("requires a completed scheduled game with both teams represented", () => {
    const result = historicalPlayerActualsFromLedgers({
      history: [row],
      schedules: [{ ...game, status: "in-progress" }],
      ledgers: [ledger],
    });
    expect(result.history[0]).toBe(row);
    expect(result.zeroObservations).toEqual([]);
  });
});
