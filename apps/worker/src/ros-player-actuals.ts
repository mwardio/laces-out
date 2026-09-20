import { canonicalNflTeamCode } from "@laces-out/domain";
import {
  firstPartyProjectionComponentsForPosition,
  type FirstPartyWeeklyStatLine,
} from "@laces-out/projections";
import type { NflversePlayerStatLedger } from "@laces-out/source-nflverse";

import type { ProjectionScheduleFact } from "./first-party-projection-inputs.js";

/** These observations never enter training, player selection, forecast checksums, or seeds. */
export function historicalPlayerActualsFromLedgers(input: {
  readonly history: readonly FirstPartyWeeklyStatLine[];
  readonly schedules: readonly ProjectionScheduleFact[];
  readonly ledgers: readonly NflversePlayerStatLedger[];
}) {
  const ledgers = new Map<number, NflversePlayerStatLedger>();
  const playerWeeks = new Set<string>();
  const coveredTeamGames = new Set<string>();
  for (const ledger of input.ledgers) {
    if (ledgers.has(ledger.season)) throw new Error("Duplicate historical player stat ledger");
    ledgers.set(ledger.season, ledger);
    if (
      ledger.version !== "nflverse-player-zero-ledger-v1" ||
      ledger.state !== "complete" ||
      ledger.unknownPlayerProductionRows !== 0 ||
      !/^[a-f0-9]{64}$/u.test(ledger.sourceChecksum)
    )
      continue;
    for (const playerWeek of ledger.playerWeeks) playerWeeks.add(playerWeek);
    for (const game of ledger.games) {
      if (game.season !== ledger.season) throw new Error("Player stat ledger season mismatch");
      coveredTeamGames.add(
        `${game.season}:${game.week}:${game.gameId}:${canonicalNflTeamCode(game.team)}:${canonicalNflTeamCode(game.opponentTeam)}`,
      );
    }
  }
  const games = new Map<string, ProjectionScheduleFact>();
  for (const game of input.schedules) {
    if (
      game.awayScore === null ||
      game.homeScore === null ||
      (game.status !== undefined && game.status !== "final")
    )
      continue;
    for (const team of [game.awayTeam, game.homeTeam]) {
      const key = `${game.season}:${game.week}:${canonicalNflTeamCode(team)}`;
      if (games.has(key)) throw new Error("Duplicate completed player team schedule");
      games.set(key, game);
    }
  }
  const componentIds = new Set([
    ...["QB", "RB", "WR", "TE", "K"].flatMap(firstPartyProjectionComponentsForPosition),
  ]);
  for (const row of input.history) {
    for (const key of Object.keys(row.components)) componentIds.add(key);
  }
  const zeroObservations: Array<{
    readonly playerId: string;
    readonly season: number;
    readonly week: number;
    readonly gameId: string;
    readonly sourceChecksum: string;
    readonly reason: "played-without-recorded-player-stats";
  }> = [];
  const history = input.history.map((row) => {
    if (
      row.played !== true ||
      row.snapShare === undefined ||
      !Number.isFinite(row.snapShare) ||
      row.snapShare < 0 ||
      row.snapShare > 1 ||
      !Object.values(row.components).every((value) => value === 0)
    )
      return row;
    const ledger = ledgers.get(row.season);
    const game = games.get(`${row.season}:${row.week}:${canonicalNflTeamCode(row.team)}`);
    if (
      !ledger ||
      ledger.state !== "complete" ||
      ledger.unknownPlayerProductionRows !== 0 ||
      !game ||
      playerWeeks.has(`${row.season}:${row.week}:${row.playerId}`)
    )
      return row;
    const away = canonicalNflTeamCode(game.awayTeam);
    const home = canonicalNflTeamCode(game.homeTeam);
    if (
      !coveredTeamGames.has(`${row.season}:${row.week}:${game.gameId}:${away}:${home}`) ||
      !coveredTeamGames.has(`${row.season}:${row.week}:${game.gameId}:${home}:${away}`) ||
      (row.opponent !== undefined &&
        canonicalNflTeamCode(row.opponent) !==
          (canonicalNflTeamCode(row.team) === away ? home : away))
    )
      return row;
    zeroObservations.push({
      playerId: row.playerId,
      season: row.season,
      week: row.week,
      gameId: game.gameId,
      sourceChecksum: ledger.sourceChecksum,
      reason: "played-without-recorded-player-stats",
    });
    return { ...row, components: Object.fromEntries([...componentIds].map((key) => [key, 0])) };
  });
  return { version: "complete-player-ledger-actuals-v1" as const, history, zeroObservations };
}
