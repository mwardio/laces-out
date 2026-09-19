import { describe, expect, it } from "vitest";
import {
  CONDITIONAL_INTERVAL_ARTIFACT_VERSION,
  fitConditionalIntervalCalibration,
  prepareConditionalIntervalCalibration,
  type ConditionalIntervalHistoryRow,
  type ConditionalIntervalCalibrationFit,
} from "./conditional-interval-calibration.js";
import { sha256Hex } from "./sha256.js";

const seriesKey = "synthetic:exact-profile:position:horizon:strategy";
function history(constantGames = false): ConditionalIntervalHistoryRow[] {
  return Array.from({ length: 24 }, (_, index) => {
    const asOfWeek = 1 + Math.floor(index / 8);
    const player = index % 8;
    const scheduledGames = constantGames ? 2 : 2 + (index % 3);
    const meanPoints = scheduledGames * (20 + 2 * (player - 3.5));
    return {
      seriesKey,
      identity: `2022:${index}`,
      playerId: `player-${player}`,
      forecastSeason: 2022,
      asOfWeek,
      windowStartWeek: asOfWeek + 1,
      windowEndWeek: 18,
      scheduledGames,
      meanPoints,
      p15Points: meanPoints - 2 * scheduledGames,
      p50Points: meanPoints,
      p85Points: meanPoints + 2 * scheduledGames,
      actualPoints: meanPoints + scheduledGames * (player - 3.5),
    };
  });
}
function fitted(rows = history()) {
  const fit = fitConditionalIntervalCalibration({
    seriesKey,
    forecastSeason: 2023,
    completedSeasons: [2022],
    rows,
  });
  expect(fit.state, JSON.stringify(fit.state === "unavailable" ? fit.reasons : null)).toBe(
    "fitted",
  );
  if (fit.state !== "fitted") throw new Error(fit.reasons.join(","));
  return fit;
}
function transform(
  row: ConditionalIntervalHistoryRow,
  a: number,
  b: number,
): ConditionalIntervalHistoryRow {
  return {
    ...row,
    meanPoints: a * row.meanPoints + b,
    actualPoints: a * row.actualPoints + b,
    p15Points: a * (a < 0 ? row.p85Points : row.p15Points) + b,
    p50Points: a * row.p50Points + b,
    p85Points: a * (a < 0 ? row.p15Points : row.p85Points) + b,
  };
}
function sealAgain(fit: ConditionalIntervalCalibrationFit): ConditionalIntervalCalibrationFit {
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value !== null && typeof value === "object")
      return `{${Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
        .join(",")}}`;
    return JSON.stringify(value);
  };
  const payload = Object.fromEntries(Object.entries(fit).filter(([key]) => key !== "checksum"));
  return { ...fit, checksum: sha256Hex(canonical(payload)) };
}

describe("prior-only conditional interval development candidate", () => {
  it("fits a known conditional signal with exact weights and independently verified solutions", () => {
    const fit = fitted();
    expect(fit).toMatchObject({
      artifactVersion: CONDITIONAL_INTERVAL_ARTIFACT_VERSION,
      canAuthorizeRelease: false,
      priorSeasons: [2022],
      samples: 24,
      blocks: 3,
      distinctCutoffs: 3,
      preprocessing: { scale: 4, constantScheduledGames: null },
    });
    expect(fit.history.every((row) => row.weightDenominator === 24)).toBe(true);
    expect(fit.solutions.every((solution) => solution.slope > 0)).toBe(true);
    const apply = prepareConditionalIntervalCalibration(fit);
    for (const row of history()) {
      const forecast = { ...row, forecastSeason: 2023 };
      const result = apply(forecast);
      expect(result.meanPoints).toBe(forecast.meanPoints);
      expect(result.p15Points).toBeLessThanOrEqual(result.p50Points);
      expect(result.p50Points).toBeLessThanOrEqual(result.p85Points);
      expect(result.rearrangement.unsorted).toHaveLength(3);
    }
  });

  it.each([
    [2.5, 7],
    [-1.75, 13],
    [0.125, -32],
  ])("preserves signed affine behavior with unequal games: A=%s B=%s", (a, b) => {
    const rows = history();
    const original = prepareConditionalIntervalCalibration(fitted(rows));
    const changedFit = fitted(rows.map((row) => transform(row, a, b)));
    const changed = prepareConditionalIntervalCalibration(changedFit);
    for (const row of rows) {
      const before = original({ ...row, forecastSeason: 2023 });
      const after = changed({ ...transform(row, a, b), forecastSeason: 2023 });
      expect(after.meanPoints).toBeCloseTo(a * before.meanPoints + b, 8);
      expect(after.p15Points).toBeCloseTo(a * (a < 0 ? before.p85Points : before.p15Points) + b, 8);
      expect(after.p50Points).toBeCloseTo(a * before.p50Points + b, 8);
      expect(after.p85Points).toBeCloseTo(a * (a < 0 ? before.p15Points : before.p85Points) + b, 8);
    }
  });

  it("keeps constant-game affine behavior on its valid domain and rejects different application games", () => {
    const rows = history(true);
    const apply = prepareConditionalIntervalCalibration(fitted(rows));
    const shifted = prepareConditionalIntervalCalibration(
      fitted(rows.map((row) => transform(row, 1, 2))),
    );
    const forecast = { ...rows[0]!, forecastSeason: 2023 };
    expect(shifted(transform(forecast, 1, 2)).p50Points).toBeCloseTo(
      apply(forecast).p50Points + 2,
      9,
    );
    expect(() => apply({ ...forecast, scheduledGames: 1 })).toThrow(/different games/u);
  });

  it("ignores current/future outcomes and covariates in preprocessing, weights and fit digests", () => {
    const prior = history();
    const fit = fitted(prior);
    const future = prior.map((row) => ({
      ...row,
      identity: `future:${row.identity}`,
      forecastSeason: 2023,
      meanPoints: 1e6,
      actualPoints: -1e6,
    }));
    expect(fitted([...prior, ...future])).toEqual(fit);
    expect(fitted([...prior].reverse())).toEqual(fit);
    expect(() => fitted([...prior, { ...future[0]!, meanPoints: Infinity }])).toThrow(/raw mean/u);
  });

  it("balances seasons and cutoffs instead of giving larger populations more total weight", () => {
    const prior = history();
    const later = prior
      .slice(0, 16)
      .map((row) => ({ ...row, identity: `later:${row.identity}`, forecastSeason: 2023 }));
    const fit = fitConditionalIntervalCalibration({
      seriesKey,
      forecastSeason: 2024,
      completedSeasons: [2022, 2023],
      rows: [...prior, ...later],
    });
    expect(fit.state).toBe("fitted");
    expect(
      fit.history
        .filter(({ row }) => row.forecastSeason === 2022)
        .every((row) => row.weightDenominator === 48),
    ).toBe(true);
    expect(
      fit.history
        .filter(({ row }) => row.forecastSeason === 2023)
        .every((row) => row.weightDenominator === 32),
    ).toBe(true);
  });

  it("requires chronological completion and retains support failures", () => {
    expect(() =>
      fitConditionalIntervalCalibration({
        seriesKey,
        forecastSeason: 2023,
        completedSeasons: [],
        rows: history(),
      }),
    ).toThrow(/not complete/u);
    const result = fitConditionalIntervalCalibration({
      seriesKey,
      forecastSeason: 2023,
      completedSeasons: [2022],
      rows: history().slice(0, 8),
    });
    expect(result).toMatchObject({
      state: "unavailable",
      reasons: ["fewer-than-18-rows", "fewer-than-3-cutoffs", "fewer-than-3-blocks"],
    });
    expect(() => prepareConditionalIntervalCalibration(result)).toThrow(/unavailable/u);
  });

  it("does not drop zero-game, duplicate or malformed rows to manufacture a fit", () => {
    const rows = history();
    for (const patch of [
      { scheduledGames: 0 },
      { scheduledGames: 18 },
      { p15Points: 1e5 },
      { actualPoints: NaN },
    ]) {
      expect(() => fitted([{ ...rows[0]!, ...patch }, ...rows.slice(1)])).toThrow();
    }
    expect(() => fitted([...rows, rows[0]!])).toThrow(/Duplicate/u);
  });

  it("makes zero-scale fits unavailable and rejects overflow before clipping", () => {
    const flat = history(true).map((row) => ({
      ...row,
      meanPoints: 0,
      actualPoints: 0,
      p15Points: 0,
      p50Points: 0,
      p85Points: 0,
    }));
    expect(
      fitConditionalIntervalCalibration({
        seriesKey,
        forecastSeason: 2023,
        completedSeasons: [2022],
        rows: flat,
      }),
    ).toMatchObject({ state: "unavailable", reasons: ["zero-forecast-scale"] });
    const tiny = flat.map((row) => ({ ...row, p15Points: -1e-310, p85Points: 1e-310 }));
    const apply = prepareConditionalIntervalCalibration(fitted(tiny));
    expect(() => apply({ ...tiny[0]!, forecastSeason: 2023, meanPoints: 1e308 })).toThrow(
      /standardized feature is nonfinite/u,
    );
  });

  it("retains finite clipping diagnostics and the mean while limiting extrapolated strength", () => {
    const fit = fitted();
    const forecast = { ...history()[0]!, forecastSeason: 2023, meanPoints: 1e5 };
    const result = prepareConditionalIntervalCalibration(fit)(forecast);
    expect(result).toMatchObject({ feature: 2, featureClipped: true, meanPoints: 1e5 });
    expect(result.unclippedFeature).toBeGreaterThan(2);
  });

  it("sorts actually crossed endpoints and records their full movement", () => {
    const row = history()[0]!;
    const result = prepareConditionalIntervalCalibration(fitted())({
      ...row,
      forecastSeason: 2023,
      p15Points: row.meanPoints,
      p50Points: row.meanPoints,
      p85Points: row.meanPoints,
    });
    expect(result).toMatchObject({
      p15Points: 15,
      p50Points: 19,
      p85Points: 23,
      rearrangement: {
        crossed: true,
        unsorted: [23, 19, 15],
        permutation: [2, 1, 0],
        maximumMovement: 8,
      },
    });
  });

  it("supports unseen game counts only with variable prior games and preserves affine clipping", () => {
    const rows = history();
    const apply = prepareConditionalIntervalCalibration(fitted(rows));
    const changed = prepareConditionalIntervalCalibration(
      fitted(rows.map((row) => transform(row, -2, 7))),
    );
    const forecast = { ...rows[0]!, forecastSeason: 2023, scheduledGames: 7, meanPoints: 1e4 };
    const before = apply(forecast);
    const after = changed(transform(forecast, -2, 7));
    expect(before.feature).toBe(2);
    expect(after.feature).toBe(-2);
    expect(after.p15Points).toBeCloseTo(-2 * before.p85Points + 7, 8);
    expect(after.p85Points).toBeCloseTo(-2 * before.p15Points + 7, 8);
    expect(() => apply({ ...forecast, scheduledGames: 0 })).toThrow(/scheduled games/u);
    expect(() => apply({ ...forecast, scheduledGames: 2.5 })).toThrow(/scheduled games/u);
  });

  it("records finite-input arithmetic overflow as unavailable without dropping a row", () => {
    const rows = history().map((row) => ({
      ...row,
      meanPoints: 0,
      p15Points: -1e308,
      p50Points: -1e308,
      p85Points: -1e308 + 1e300,
      actualPoints: 1e308,
    }));
    const result = fitConditionalIntervalCalibration({
      seriesKey,
      forecastSeason: 2023,
      completedSeasons: [2022],
      rows,
    });
    expect(result).toMatchObject({
      state: "unavailable",
      samples: 24,
      reasons: ["Conditional interval raw residual is nonfinite"],
    });
  });

  it("binds means, schedule and proof; even a freshly rehashed nonoptimal solution is refused", () => {
    const fit = fitted();
    expect(() =>
      prepareConditionalIntervalCalibration({ ...fit, checksum: "0".repeat(64) }),
    ).toThrow(/checksum/u);
    const changed = structuredClone(fit);
    Object.assign(changed.solutions[1], { slope: changed.solutions[1].slope + 0.1 });
    expect(() => prepareConditionalIntervalCalibration(sealAgain(changed))).toThrow(/uncertified/u);
    const changedMean = structuredClone(fit);
    Object.assign(changedMean.history[0]!.row, {
      meanPoints: changedMean.history[0]!.row.meanPoints + 10,
    });
    expect(() => prepareConditionalIntervalCalibration(sealAgain(changedMean))).toThrow();
    const zeroIterations = structuredClone(fit);
    Object.assign(zeroIterations.solutions[0], { iterations: 0 });
    expect(() => prepareConditionalIntervalCalibration(sealAgain(zeroIterations))).toThrow(
      /uncertified/u,
    );
  });

  it("rejects inconsistent stored metadata and accepts JSON object key reordering", () => {
    const fit = fitted();
    const mutations = [
      (copy: typeof fit) => Object.assign(copy.preprocessing, { scale: 999 }),
      (copy: typeof fit) => Object.assign(copy, { canAuthorizeRelease: true }),
      (copy: typeof fit) => Object.assign(copy, { samples: 999 }),
      (copy: typeof fit) => Object.assign(copy, { inputChecksum: "0".repeat(64) }),
      (copy: typeof fit) =>
        Object.assign(copy.solutions[0].certificate.diagnostics, { primalObjective: 999 }),
      (copy: typeof fit) => Object.assign(copy.rows[0]!, { feature: 0.125 }),
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(fit);
      mutate(changed);
      expect(() => prepareConditionalIntervalCalibration(changed)).toThrow(/checksum/u);
      expect(() => prepareConditionalIntervalCalibration(sealAgain(changed))).toThrow(/checksum/u);
    }
    const reorder = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(reorder);
      if (value !== null && typeof value === "object")
        return Object.fromEntries(
          Object.entries(value)
            .reverse()
            .map(([key, item]) => [key, reorder(item)]),
        );
      return value;
    };
    const forecast = { ...history()[0]!, forecastSeason: 2023 };
    expect(prepareConditionalIntervalCalibration(reorder(fit) as typeof fit)(forecast)).toEqual(
      prepareConditionalIntervalCalibration(fit)(forecast),
    );
  });

  it("owns a detached fit snapshot and checks exact application season/profile", () => {
    const fit = fitted();
    const apply = prepareConditionalIntervalCalibration(fit);
    const forecast = { ...history()[0]!, forecastSeason: 2023 };
    const before = apply(forecast);
    Object.assign(fit.solutions[1], { slope: 123 });
    Object.assign(fit.preprocessing, { scale: 999 });
    expect(apply(forecast)).toEqual(before);
    expect(() => apply({ ...forecast, forecastSeason: 2024 })).toThrow(/season mismatch/u);
    expect(() => apply({ ...forecast, seriesKey: "other-profile" })).toThrow(
      /series identity mismatch/u,
    );
  });
});
