import assert from "node:assert/strict";
import { canonicalNflTeamCode, NFL_TEAMS } from "@laces-out/domain";
import { firstPartyProjectionComponentsForPosition } from "@laces-out/projections";
import type { RosHistoricalCorpus, RosHistoricalCorpusForecast } from "./ros-historical-corpus.js";

const object = (value: unknown): Record<string, unknown> => {
  assert(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
};
const array = (value: unknown): readonly unknown[] => {
  assert(Array.isArray(value));
  return value;
};
const playerComponents = [
  ...new Set(["QB", "RB", "WR", "TE", "K"].flatMap(firstPartyProjectionComponentsForPosition)),
];

/**
 * A closed, byte-authenticated raw ledger can establish an empty player's observed window as
 * zero. Merely having zero appearances cannot. Proof documents must already be authenticated
 * by the package loader; this performs their semantic and source/coverage bindings.
 */
export function completeVerifiedEmptyRosPlayerLabels(input: {
  readonly forecasts: readonly RosHistoricalCorpusForecast[];
  readonly corpus: Pick<RosHistoricalCorpus, "coverage" | "sourceAudit">;
  readonly certification: unknown;
  readonly zeroEvidence: unknown;
  readonly actualVerification: unknown;
}): readonly RosHistoricalCorpusForecast[] {
  const certification = object(input.certification);
  const evidence = object(input.zeroEvidence);
  const verification = object(input.actualVerification);
  const historyInputs = array(certification.normalizedInputs)
    .map(object)
    .filter((row) => row.name === "history");
  assert.equal(historyInputs.length, 1, "Unique certified player history required");
  const history = historyInputs[0]!;
  assert.equal(history.exactMatch, true);
  assert.equal(history.oldSha256, history.newSha256);
  assert(typeof history.newSha256 === "string");
  assert(/^[a-f0-9]{64}$/u.test(history.newSha256));
  assert.equal(evidence.version, "complete-player-ledger-actuals-v1");
  assert.equal(evidence.originalForecastHistorySha256, history.newSha256);
  assert.equal(verification.state, "current-actuals-recomputed");
  assert.equal(verification.actualDefinitionVersion, evidence.version);
  assert.equal(verification.currentHistorySha256, history.newSha256);
  assert.equal(verification.requested, input.forecasts.length);
  assert.equal(verification.completed, input.forecasts.length);
  assert.equal(array(verification.errors).length, 0);
  assert.equal(verification.certifiedZeroObservations, array(evidence.zeroObservations).length);

  const sources = new Map(input.corpus.sourceAudit.map((source) => [source.season, source]));
  assert.equal(sources.size, input.corpus.sourceAudit.length);
  const ledgers = new Map<
    number,
    { readonly playerWeeks: ReadonlySet<string>; readonly gamesByWeek: ReadonlyMap<number, number> }
  >();
  const knownTeams = new Set<string>(NFL_TEAMS);
  for (const value of array(evidence.ledgers)) {
    const ledger = object(value);
    const season = ledger.season;
    assert(typeof season === "number" && Number.isSafeInteger(season));
    assert(!ledgers.has(season), "Duplicate empty-window player ledger");
    assert.equal(ledger.version, "nflverse-player-zero-ledger-v1");
    assert.equal(ledger.state, "complete", "Incomplete empty-window player ledger");
    assert.equal(ledger.unknownPlayerProductionRows, 0);
    const source = sources.get(season);
    assert(source, "Unbound empty-window player ledger season");
    assert.equal(ledger.sourceChecksum, source.playerWeeklyRawChecksum);
    const playerWeeks = new Set<string>();
    for (const key of array(ledger.playerWeeks)) {
      assert(typeof key === "string" && /^\d{4}:\d{1,2}:00-\d{7}$/u.test(key));
      const [year, week] = key.split(":").map(Number);
      assert(year === season && week! >= 1 && week! <= 18);
      assert(!playerWeeks.has(key), "Duplicate empty-window player observation");
      playerWeeks.add(key);
    }
    const games = new Map<string, { readonly week: number; readonly teams: Set<string> }>();
    const teamWeeks = new Set<string>();
    for (const value of array(ledger.games)) {
      const game = object(value);
      const week = game.week;
      assert.equal(game.season, season);
      assert(typeof week === "number" && Number.isSafeInteger(week) && week >= 1 && week <= 18);
      assert(typeof game.gameId === "string" && typeof game.team === "string");
      assert(typeof game.opponentTeam === "string");
      const team = canonicalNflTeamCode(game.team);
      const opponent = canonicalNflTeamCode(game.opponentTeam);
      assert(knownTeams.has(team) && knownTeams.has(opponent) && team !== opponent);
      const parts = game.gameId.split("_");
      assert(parts.length === 4 && Number(parts[0]) === season && Number(parts[1]) === week);
      const pair = parts.slice(2).map(canonicalNflTeamCode).sort();
      assert.deepEqual(pair, [team, opponent].sort(), "Player ledger game identity differs");
      const teamWeek = `${week}:${team}`;
      assert(!teamWeeks.has(teamWeek), "Duplicate player ledger team game");
      teamWeeks.add(teamWeek);
      const existing = games.get(game.gameId) ?? { week, teams: new Set<string>() };
      assert.equal(existing.week, week);
      existing.teams.add(team);
      games.set(game.gameId, existing);
    }
    const gamesByWeek = new Map<number, number>();
    for (const game of games.values()) {
      assert.equal(game.teams.size, 2, "Player ledger game lacks both teams");
      gamesByWeek.set(game.week, (gamesByWeek.get(game.week) ?? 0) + 1);
    }
    ledgers.set(season, { playerWeeks, gamesByWeek });
  }
  assert.equal(ledgers.size, sources.size, "Player ledger season population differs");

  const coveredWeeks = new Set<string>();
  for (const season of input.corpus.coverage.seasons) {
    const ledger = ledgers.get(season.season);
    assert(ledger, "Missing held-out player ledger");
    for (const week of season.weeks) {
      assert(week.complete && week.scheduleGames === week.completedScheduleGames);
      assert.equal(
        ledger.gamesByWeek.get(week.targetWeek),
        week.completedScheduleGames,
        "Player ledger differs from complete held-out schedule coverage",
      );
      const key = `${season.season}:${week.targetWeek}`;
      assert(!coveredWeeks.has(key));
      coveredWeeks.add(key);
    }
  }
  return input.forecasts.map((row) => {
    if (Object.keys(row.actualComponents).length > 0 || row.scheduledGames === 0) return row;
    assert(row.forecast.position !== "DST", "Empty player ledger cannot certify defense");
    assert.equal(row.actualGames, 0, "Empty components contradict observed player appearances");
    const forecast = row.forecast;
    const ledger = ledgers.get(forecast.forecastSeason);
    assert(ledger);
    for (let week = forecast.windowStartWeek; week <= forecast.windowEndWeek; week += 1) {
      assert(coveredWeeks.has(`${forecast.forecastSeason}:${week}`), "Uncovered empty window");
      assert(
        !ledger.playerWeeks.has(`${forecast.forecastSeason}:${week}:${forecast.playerId}`),
        "Empty historical window contains a raw player observation",
      );
    }
    return {
      ...row,
      actualComponents: Object.fromEntries(playerComponents.map((key) => [key, 0])),
    };
  });
}
