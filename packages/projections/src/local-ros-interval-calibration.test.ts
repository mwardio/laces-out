import { describe, expect, it } from "vitest";
import {
  fitLocalRosIntervalCalibration,
  prepareLocalRosIntervalCalibration,
  type LocalRosIntervalFitInput,
  type LocalRosIntervalForecast,
  type LocalRosIntervalHistoryRow,
} from "./local-ros-interval-calibration.js";

const base: LocalRosIntervalForecast = {
  seriesKey: "model/profile/WR/strategy",
  forecastSeason: 2023,
  asOfWeek: 1,
  windowStartWeek: 2,
  windowEndWeek: 18,
  scheduledGames: 3,
  meanPoints: 6,
  p15Points: 0,
  p50Points: 6,
  p85Points: 12,
  referenceProductionRank: null,
};
function constantHistory(): LocalRosIntervalHistoryRow[] {
  return [1, 2, 3].flatMap((asOfWeek) =>
    Array.from({ length: 8 }, (_, player) => ({
      ...base,
      forecastSeason: 2022,
      asOfWeek,
      windowStartWeek: asOfWeek + 1,
      identity: `2022/${asOfWeek}/${player}`,
      playerId: `p${player}`,
      actualPoints: -9 + 3 * player,
    })),
  );
}
function input(rows = constantHistory()): LocalRosIntervalFitInput {
  return {
    seriesKey: base.seriesKey,
    position: "WR",
    forecastSeason: 2023,
    completedSeasons: [2022],
    rows,
  };
}
function variedHistory(): LocalRosIntervalHistoryRow[] {
  return [1, 2, 3, 4, 5, 6].flatMap((asOfWeek) =>
    Array.from({ length: 32 }, (_, player) => {
      const games = 3 + (asOfWeek % 3);
      return {
        ...base,
        forecastSeason: 2022,
        asOfWeek,
        windowStartWeek: asOfWeek + 1,
        scheduledGames: games,
        identity: `2022/${asOfWeek}/${player}`,
        playerId: `p${player}`,
        meanPoints: games * (player + 1),
        p15Points: games * (player - 3),
        p50Points: games * (player + 1),
        p85Points: games * (player + 5),
        actualPoints: games * (player + 1 + (player % 3) - 1),
      };
    }),
  );
}

describe("prior local ROS residual calibration", () => {
  it("retains signed points and the raw mean while interpolating endpoint residuals", () => {
    const fit = fitLocalRosIntervalCalibration(input());
    expect(fit.state).toBe("fitted");
    expect(fit.canAuthorizeRelease).toBe(false);
    expect(fit.history.every((row) => row.weightDenominator === 24)).toBe(true);
    const applied = prepareLocalRosIntervalCalibration(fit)(base);
    expect(applied.state).toBe("corrected");
    if (applied.state !== "corrected") throw new Error("fixture support unavailable");
    expect(applied.correction.meanPoints).toBe(6);
    expect(applied.correction.p15Points).toBeCloseTo(-6.9);
    expect(applied.correction.p50Points).toBeCloseTo(1.5);
    expect(applied.correction.p85Points).toBeCloseTo(9.9);
    expect(applied.correction.support).toMatchObject({
      effectiveRows: 24,
      effectiveCutoffs: 3,
      effectiveBlocks: 3,
      effectiveSeasons: 1,
      extrapolated: false,
    });
  });

  it("does not read current or future outcome values or let them affect checksums", () => {
    const prior = constantHistory();
    const current = { ...prior[0]!, identity: "current", forecastSeason: 2023, actualPoints: NaN };
    const future = {
      ...prior[0]!,
      identity: "future",
      forecastSeason: 2024,
      actualPoints: Infinity,
    };
    expect(fitLocalRosIntervalCalibration(input([...prior, current, future]))).toEqual(
      fitLocalRosIntervalCalibration(input(prior)),
    );
    expect(() =>
      fitLocalRosIntervalCalibration(
        input([{ ...prior[0]!, actualPoints: NaN }, ...prior.slice(1)]),
      ),
    ).toThrow(/nonfinite/);
    expect(fitLocalRosIntervalCalibration({ ...input(prior), forecastSeason: 2022 })).toMatchObject(
      { state: "unavailable", samples: 0 },
    );
    expect(() => fitLocalRosIntervalCalibration({ ...input(prior), completedSeasons: [] })).toThrow(
      /incomplete/,
    );
  });

  it("weights seasons, cutoffs and players equally at their respective levels", () => {
    const old = constantHistory();
    const recent = old
      .filter((row) => row.playerId !== "p7")
      .map((row) => ({ ...row, identity: `next/${row.identity}`, forecastSeason: 2023 }));
    const fit = fitLocalRosIntervalCalibration({
      ...input([...old, ...recent]),
      forecastSeason: 2024,
      completedSeasons: [2022, 2023],
    });
    expect(
      fit.history
        .filter(({ row }) => row.forecastSeason === 2022)
        .every((r) => r.weightDenominator === 48),
    ).toBe(true);
    expect(
      fit.history
        .filter(({ row }) => row.forecastSeason === 2023)
        .every((r) => r.weightDenominator === 42),
    ).toBe(true);
    expect(fit).toEqual(
      fitLocalRosIntervalCalibration({
        ...input([...recent, ...old].toReversed()),
        forecastSeason: 2024,
        completedSeasons: [2023, 2022],
      }),
    );
  });

  it("reconstructs detached fit evidence and rejects corruption and scope substitutions", () => {
    const rows = constantHistory();
    const fit = fitLocalRosIntervalCalibration(input(rows));
    const apply = prepareLocalRosIntervalCalibration(fit);
    const expected = apply(base);
    rows[0] = { ...rows[0]!, actualPoints: 99999 };
    (fit.history[0]!.row as { actualPoints: number }).actualPoints = -99999;
    expect(apply(base)).toEqual(expected);
    expect(() => prepareLocalRosIntervalCalibration(fit)).toThrow(/checksum/);
    expect(() => apply({ ...base, seriesKey: "other-profile" })).toThrow(/scope/);
    expect(() => apply({ ...base, forecastSeason: 2024 })).toThrow(/scope/);
    const another = fitLocalRosIntervalCalibration(input());
    expect(() => prepareLocalRosIntervalCalibration({ ...another, position: "DST" })).toThrow(
      /checksum/,
    );
  });

  it("marks unsupported constant features and insufficient global history explicitly", () => {
    const apply = prepareLocalRosIntervalCalibration(fitLocalRosIntervalCalibration(input()));
    expect(apply({ ...base, meanPoints: 7 })).toMatchObject({
      state: "unavailable",
      reasons: ["Local ROS constant feature mismatch: meanPerScheduledGame"],
    });
    expect(apply({ ...base, scheduledGames: 4, meanPoints: 8 })).toMatchObject({
      state: "unavailable",
      reasons: ["Local ROS constant feature mismatch: logScheduledGames"],
    });
    expect(fitLocalRosIntervalCalibration(input(constantHistory().slice(0, 17)))).toMatchObject({
      state: "unavailable",
    });
  });

  it("permits finite nonconstant extrapolation and stays continuous at the historical boundary", () => {
    const apply = prepareLocalRosIntervalCalibration(
      fitLocalRosIntervalCalibration(input(variedHistory())),
    );
    const query = {
      ...base,
      meanPoints: 32 * 4,
      scheduledGames: 4,
      p15Points: 110,
      p50Points: 128,
      p85Points: 146,
    };
    const at = apply(query);
    const outside = apply({ ...query, meanPoints: query.meanPoints + 1e-7 });
    expect(at.state).toBe("corrected");
    expect(outside.state).toBe("corrected");
    if (at.state !== "corrected" || outside.state !== "corrected")
      throw new Error("fixture support unavailable");
    expect(at.correction.support.extrapolated).toBe(false);
    expect(outside.correction.support.extrapolated).toBe(true);
    expect(outside.correction.p15Points).toBeCloseTo(at.correction.p15Points, 5);
    expect(outside.correction.p85Points).toBeCloseTo(at.correction.p85Points, 5);
    expect(outside.correction.meanPoints).toBe(query.meanPoints + 1e-7);
    expect(apply({ ...query, meanPoints: Number.MAX_VALUE })).toMatchObject({
      state: "unavailable",
    });
  });

  it("uses exact scheduled games across horizon boundaries without choosing another fit", () => {
    const apply = prepareLocalRosIntervalCalibration(
      fitLocalRosIntervalCalibration(input(variedHistory())),
    );
    for (const games of [4, 5, 8, 9]) {
      const result = apply({
        ...base,
        scheduledGames: games,
        meanPoints: 16 * games,
        p15Points: 12 * games,
        p50Points: 16 * games,
        p85Points: 20 * games,
      });
      expect(result.state).toBe("corrected");
      if (result.state === "corrected")
        expect(result.correction.support.features[1]!.query).toBe(Math.log(games));
    }
  });

  it("keeps extrapolation flags when standardized distances underflow", () => {
    const rows = [1, 2, 3].flatMap((asOfWeek) =>
      Array.from({ length: 20 }, (_, player) => ({
        ...base,
        forecastSeason: 2022,
        asOfWeek,
        windowStartWeek: asOfWeek + 1,
        scheduledGames: 1,
        meanPoints: player % 2 === 0 ? 0 : 1e154,
        p15Points: 0,
        p50Points: 0,
        p85Points: 0,
        actualPoints: 0,
        identity: `${asOfWeek}/${player}`,
        playerId: `p${player}`,
      })),
    );
    const apply = prepareLocalRosIntervalCalibration(fitLocalRosIntervalCalibration(input(rows)));
    const result = apply({ ...base, meanPoints: -Number.MIN_VALUE, scheduledGames: 1 });
    expect(result.state).toBe("corrected");
    if (result.state !== "corrected") throw new Error("fixture support unavailable");
    expect(result.correction.support.extrapolated).toBe(true);
    expect(result.correction.support.features[0]!.distanceOutsideRange).toBe(0);
  });

  it("requires the exact full-universe defense ordinal and never applies it to other positions", () => {
    const rows = variedHistory().map((row) => ({
      ...row,
      referenceProductionRank: Number(row.playerId.slice(1)) + 1,
    }));
    const fit = fitLocalRosIntervalCalibration({ ...input(rows), position: "DST" });
    const apply = prepareLocalRosIntervalCalibration(fit);
    const result = apply({
      ...base,
      meanPoints: 48,
      scheduledGames: 3,
      referenceProductionRank: 16,
    });
    expect(result.state).toBe("corrected");
    if (result.state === "corrected")
      expect(result.correction.support.features[2]!.query).toBe(15 / 31);
    for (const rank of [null, 0, 33, 1.5])
      expect(() => apply({ ...base, referenceProductionRank: rank })).toThrow(/rank/);
    expect(() => fitLocalRosIntervalCalibration(input(rows))).toThrow(/non-defense rank/);
  });

  it("rejects malformed exposure, duplicated forecasts and nonfinite physical inputs", () => {
    const rows = constantHistory();
    expect(() => fitLocalRosIntervalCalibration(input([...rows, rows[0]!]))).toThrow(/Duplicate/);
    for (const change of [
      { scheduledGames: 0 },
      { scheduledGames: 18 },
      { windowEndWeek: 1 },
      { meanPoints: Infinity },
      { p15Points: 99 },
    ]) {
      expect(() =>
        fitLocalRosIntervalCalibration(input([{ ...rows[0]!, ...change }, ...rows.slice(1)])),
      ).toThrow();
    }
  });
});
