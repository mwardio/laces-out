import { describe, expect, it } from "vitest";
import type { FirstPartyWeeklyStatLine } from "./first-party.js";
import {
  buildLineupColdStartForecasts,
  evaluateLineupColdStartForecasts,
} from "./lineup-cold-start-audit.js";

const line = (
  playerId: string,
  week: number,
  yards: number,
  played = true,
): FirstPartyWeeklyStatLine => ({
  playerId,
  position: "WR",
  season: 2025,
  week,
  team: "DEN",
  opponent: "KC",
  played,
  components: { targets: 10, receptions: 8, receiving_yards: yards, receiving_touchdowns: 0 },
});
const week = (value: number) => ({ season: 2025, week: value });
const profile = { id: "receiving", rules: [{ statId: "receiving_yards", points: 0.1 }] };

describe("bounded cold-start lineup diagnostics", () => {
  it("uses only earlier played history and ignores target-week status/usage/outcome", () => {
    const prior = line("peer", 1, 100);
    const target = {
      ...line("rookie", 2, 5),
      status: "out" as const,
      snapShare: 0,
      targetShare: 0,
    };
    const result = buildLineupColdStartForecasts({
      history: [prior, target],
      evaluationWeeks: [week(2)],
    });
    const changed = buildLineupColdStartForecasts({
      history: [
        line("future", 3, 5_000),
        {
          ...target,
          status: "active",
          snapShare: 1,
          targetShare: 1,
          components: { receiving_yards: 1_000 },
        },
        prior,
      ],
      evaluationWeeks: [week(2)],
    });
    expect(result.eligibleTargets).toBe(1);
    expect(result.forecasts[0]?.model.state).toBe("projected");
    expect(result.forecasts[0]?.model.coverage.playerGames).toBe(0);
    expect(result.forecasts[0]?.baseline.components.receiving_yards).toBeCloseTo(100);
    expect(changed.forecasts[0]?.model.components).toEqual(result.forecasts[0]?.model.components);
    expect(changed.forecasts[0]?.baseline.components).toEqual(
      result.forecasts[0]?.baseline.components,
    );
    const metrics = evaluateLineupColdStartForecasts(result, profile);
    expect(metrics.overall).toMatchObject({
      samples: 1,
      actualMean: 0.5,
      baselineMean: 10,
      baselineMae: 9.5,
      baselineBias: 9.5,
    });
    expect(metrics.withPositionHistory.samples).toBe(1);
  });

  it("keeps no-history DNPs in the observed population while excluding targets after a played game", () => {
    const result = buildLineupColdStartForecasts({
      history: [
        line("peer", 1, 100),
        line("rookie", 1, 0, false),
        line("rookie", 2, 0, false),
        line("rookie", 3, 20),
        line("rookie", 4, 40),
      ],
      evaluationWeeks: [week(2), week(3), week(4)],
    });
    expect(result.forecasts.map((row) => row.actual.week)).toEqual([2, 3]);
    const metrics = evaluateLineupColdStartForecasts(result, profile);
    expect(metrics.observedDnp.samples).toBe(1);
    expect(metrics.observedAppearances.samples).toBe(1);
  });

  it("locks same-week cold forecasts together without treating another debut as prior history", () => {
    const result = buildLineupColdStartForecasts({
      history: [line("first", 1, 500), line("second", 1, 0)],
      evaluationWeeks: [week(1)],
    });
    expect(result.forecasts).toHaveLength(2);
    expect(result.forecasts[0]?.model.components).toEqual(result.forecasts[1]?.model.components);
    expect(result.forecasts.every((row) => row.model.coverage.positionGames === 0)).toBe(true);
    expect(
      evaluateLineupColdStartForecasts(result, profile).withoutPositionHistory.sampledTargets,
    ).toBe(2);
  });

  it("bounds computation with outcome-independent deterministic sampling and rejects duplicate rows", () => {
    const history = Array.from({ length: 10 }, (_, index) =>
      line(`rookie-${index}`, index + 1, index),
    );
    const input = {
      history,
      evaluationWeeks: history.map(({ season, week }) => ({ season, week })),
      maximumTargets: 3,
    };
    const result = buildLineupColdStartForecasts(input);
    expect(result.eligibleTargets).toBe(10);
    expect(result.sampledTargets).toBe(3);
    const changed = buildLineupColdStartForecasts({
      ...input,
      history: history.map((row) => ({ ...row, components: { receiving_yards: 500 } })).reverse(),
    });
    expect(changed.forecasts.map((row) => row.actual.playerId)).toEqual(
      result.forecasts.map((row) => row.actual.playerId),
    );
    expect(() => buildLineupColdStartForecasts({ ...input, maximumTargets: 1_001 })).toThrow(
      /limit/,
    );
    expect(() =>
      buildLineupColdStartForecasts({ ...input, history: [...history, history[0]!] }),
    ).toThrow(/Duplicate/);
    const unsupported = { ...history[0]!, position: "DE" };
    expect(() =>
      buildLineupColdStartForecasts({ ...input, history: [...history, unsupported, unsupported] }),
    ).not.toThrow();
  });
});
