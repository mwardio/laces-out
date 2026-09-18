import { describe, expect, it } from "vitest";
import {
  MARGINAL_INTERVAL_CALIBRATION_MAX_ROWS,
  applyMarginalIntervalCalibration,
  fitMarginalIntervalCalibration,
  type MarginalIntervalCalibrationFit,
  type MarginalIntervalForecast,
  type MarginalIntervalHistoryRow,
} from "./marginal-interval-calibration.js";

const seriesKey = "fixed-model:full-ppr:DST:five-to-eight:contextual";
function row(
  index: number,
  overrides: Partial<MarginalIntervalHistoryRow> = {},
): MarginalIntervalHistoryRow {
  const asOfWeek = 1 + Math.floor(index / 6);
  return {
    identity: `row-${index}`,
    playerId: `player-${index}`,
    seriesKey,
    forecastSeason: 2022,
    asOfWeek,
    windowStartWeek: asOfWeek + 1,
    windowEndWeek: 18,
    scheduledGames: 1,
    p15Points: -10,
    p50Points: 0,
    p85Points: 10,
    actualPoints: 10,
    ...overrides,
  };
}
const rows = () => Array.from({ length: 18 }, (_, index) => row(index));
function fit(history = rows(), forecastSeason = 2023) {
  return fitMarginalIntervalCalibration({
    seriesKey,
    forecastSeason,
    completedSeasons: [2022],
    rows: history,
  });
}
function forecast(overrides: Partial<MarginalIntervalForecast> = {}): MarginalIntervalForecast {
  return {
    ...row(0),
    forecastSeason: 2023,
    p15Points: 0,
    p50Points: 12,
    p85Points: 13,
    ...overrides,
  };
}

// Frozen full-ppr-v7.json SHA c45345a1d67d91070cbe2180e53e15e23eb89df057a48f7a158200b9888490c7.
// Actual 2022 contextual D/ST 5–8-week rows; the original pilot remained REJECTED.
// Tuple: player, cutoff, start, end, scheduled games, actual, raw P15/P50/P85.
const goldenRows: readonly (readonly [
  string,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
])[] = [
  ["DST:NE", 10, 11, 18, 8, 77, 70.1954616452605, 74.0172713707488, 78.00263373518709],
  ["DST:ARI", 10, 11, 18, 7, 23, 44.16642237274157, 47.01425076014998, 50.096436501618214],
  ["DST:MIN", 10, 11, 18, 8, 30, 59.67798369591684, 63.111998670168475, 66.76902911200476],
  ["DST:PHI", 10, 11, 18, 8, 64, 65.26722713298936, 68.6617881456445, 72.25209999273635],
  ["DST:KC", 10, 11, 18, 8, 69, 50.163155517693795, 52.823753941667675, 55.640625143597234],
  ["DST:LAC", 10, 11, 18, 8, 63, 39.76199793125298, 42.05603412080151, 44.45812651247226],
  ["DST:HOU", 10, 11, 18, 8, 56, 37.96142200742893, 40.1847988894228, 42.579187444060324],
  ["DST:CHI", 10, 11, 18, 7, 14, 25.447785988186908, 27.286592641011318, 29.26622039610544],
  ["DST:NE", 11, 12, 18, 7, 60, 65.71981537682586, 69.49312546339198, 73.52001744470195],
  ["DST:WAS", 11, 12, 18, 6, 39, 42.551877904925135, 45.08512838734177, 47.81629291440238],
  ["DST:DET", 11, 12, 18, 7, 49, 38.42821033364365, 41.03940275729242, 43.77061987484005],
  ["DST:PHI", 11, 12, 18, 7, 57, 54.94681115031739, 57.98100502590535, 61.19951019684644],
  ["DST:ATL", 11, 12, 18, 6, 19, 32.51196730616765, 34.76950211844843, 37.18638797899547],
  ["DST:ARI", 11, 12, 18, 6, 27, 31.192419894475726, 33.564409801295454, 36.08245828045528],
  ["DST:CLE", 11, 12, 18, 7, 66, 25.163512344656244, 26.858495077039656, 28.674469854683863],
  ["DST:CHI", 11, 12, 18, 6, 10, 21.610888359194565, 23.274891731900922, 25.045453635433674],
  ["DST:NE", 12, 13, 18, 6, 58, 47.519516356468976, 50.63008946669582, 53.922009141656766],
  ["DST:WAS", 12, 13, 18, 5, 32, 34.093669679402716, 36.22806823495033, 38.51284250819611],
  ["DST:NYJ", 12, 13, 18, 6, 23, 40.85607306029132, 43.355583758815804, 46.04677119927446],
  ["DST:DAL", 12, 13, 18, 6, 47, 51.54953599367511, 54.38172663178182, 57.38245603337386],
  ["DST:SEA", 12, 13, 18, 6, 36, 37.962706991971416, 40.52328128993278, 43.291423209201994],
  ["DST:MIN", 12, 13, 18, 6, 25, 38.45357216904676, 41.121548929049325, 44.020871998094364],
  ["DST:NYG", 12, 13, 18, 6, 44, 28.345642504017267, 30.15375989989004, 32.0794618087667],
  ["DST:CHI", 12, 13, 18, 5, 10, 13.814009571888024, 15.233853882487107, 16.78899372640542],
  ["DST:NE", 13, 14, 18, 5, 54, 37.02993916881712, 39.66088192991642, 42.49782835643536],
  ["DST:WAS", 13, 14, 18, 4, 25, 26.03761736635017, 27.892819977312193, 29.883577795117915],
  ["DST:BAL", 13, 14, 18, 5, 33, 34.81601749189682, 37.02273353279373, 39.38565188903968],
  ["DST:DET", 13, 14, 18, 5, 39, 26.907154206722883, 28.904298622462825, 31.11788075755027],
  ["DST:PIT", 13, 14, 18, 5, 40, 27.985858564237315, 29.98071693517462, 32.137852238351364],
  ["DST:DEN", 13, 14, 18, 5, 23, 28.082298967664915, 29.773593795626837, 31.602044778259444],
  ["DST:ATL", 13, 14, 18, 4, 15, 18.767881190209824, 20.301725858802556, 21.97899231020743],
  ["DST:CHI", 13, 14, 18, 4, 11, 7.978412833631091, 9.07188634336048, 10.262996371757929],
];

describe("isolated marginal quantile correction candidate", () => {
  it("matches the frozen rejected pilot's actual prior-season fit and later forecast exactly", () => {
    const history = goldenRows.map(
      ([
        playerId,
        asOfWeek,
        windowStartWeek,
        windowEndWeek,
        scheduledGames,
        actualPoints,
        p15Points,
        p50Points,
        p85Points,
      ]) => ({
        identity: `2022:${asOfWeek}:${playerId}`,
        playerId,
        seriesKey,
        forecastSeason: 2022,
        asOfWeek,
        windowStartWeek,
        windowEndWeek,
        scheduledGames,
        actualPoints,
        p15Points,
        p50Points,
        p85Points,
      }),
    );
    const fitted = fit(history);
    // Pilot fitSha256 942df27b6436e188d074912d57dc7e2442740b5f8c8e23728020b48bb94bfbba.
    expect(fitted).toMatchObject({
      state: "fitted",
      priorSeasons: [2022],
      samples: 32,
      blocks: 4,
      corrections: [-2.24226202817446, -0.8045467065587459, 1.6776015694924595],
    });
    expect(
      fitted.rows.every(
        (evidence) => evidence.weight.numerator === "1" && evidence.weight.denominator === "32",
      ),
    ).toBe(true);
    const corrected = applyMarginalIntervalCalibration(
      forecast({
        asOfWeek: 10,
        windowStartWeek: 11,
        scheduledGames: 8,
        p15Points: 70.80622716494484,
        p50Points: 74.36959434249835,
        p85Points: 78.17803015002441,
      }),
      fitted,
    );
    expect(corrected).toMatchObject({
      p15Points: 52.86813093954916,
      p50Points: 67.93322069002838,
      p85Points: 91.59884270596409,
      rearrangement: { crossed: false, permutation: [0, 1, 2], maximumMovement: 0 },
    });
    expect(fitted).not.toHaveProperty("admitted");
    expect(fitted).not.toHaveProperty("qualified");
    expect(fitted).not.toHaveProperty("observedCoverage");
    expect(corrected).not.toHaveProperty("meanPoints");
  });

  it("gives seasons and cutoffs equal mass despite different cohort sizes", () => {
    const history = [
      row(0, { actualPoints: 0, asOfWeek: 1 }),
      row(1, { actualPoints: 10, asOfWeek: 2, windowStartWeek: 3 }),
      ...Array.from({ length: 18 }, (_, i) =>
        row(i + 2, { actualPoints: 20, asOfWeek: 3, windowStartWeek: 4 }),
      ),
      row(20, { forecastSeason: 2021, asOfWeek: 1, windowStartWeek: 2, actualPoints: 30 }),
      row(21, { forecastSeason: 2021, asOfWeek: 2, windowStartWeek: 3, actualPoints: 40 }),
    ].map((r) => ({ ...r, p15Points: 0, p50Points: 0, p85Points: 0 }));
    const fitted = fitMarginalIntervalCalibration({
      seriesKey,
      forecastSeason: 2023,
      completedSeasons: [2021, 2022],
      rows: history,
    });
    expect(fitted).toMatchObject({
      state: "fitted",
      corrections: [0, 20, 40],
      samples: 22,
      blocks: 5,
    });
    expect(
      fitted.rows.filter((r) => r.forecastSeason === 2021).map((r) => r.weight.denominator),
    ).toEqual(["4", "4"]);
    expect(
      fitted.rows
        .filter((r) => r.forecastSeason === 2022 && r.asOfWeek === 3)
        .every((r) => r.weight.denominator === "108"),
    ).toBe(true);
  });

  it("selects exact 15/50/85 rational boundaries without interpolation", () => {
    const history = Array.from({ length: 20 }, (_, i) =>
      row(i, {
        asOfWeek: 1 + Math.floor(i / 5),
        windowStartWeek: 2 + Math.floor(i / 5),
        actualPoints: i,
        p15Points: 0,
        p50Points: 0,
        p85Points: 0,
      }),
    );
    expect(fit(history)).toMatchObject({ corrections: [2, 9, 16] });
    expect(fit([...history].reverse())).toEqual(fit(history));
  });

  it("records one stable sorting permutation and publishes its actual changed median", () => {
    const fitted = fit();
    expect(fitted).toMatchObject({ corrections: [20, 10, 0] });
    expect(applyMarginalIntervalCalibration(forecast(), fitted)).toMatchObject({
      p15Points: 13,
      p50Points: 20,
      p85Points: 22,
      rearrangement: {
        crossed: true,
        unsorted: [20, 22, 13],
        permutation: [2, 0, 1],
        maximumMovement: 9,
      },
    });
    const tied = applyMarginalIntervalCalibration(
      forecast({ p15Points: -20, p50Points: -10, p85Points: 0 }),
      fitted,
    );
    expect(tied).toMatchObject({
      p15Points: 0,
      p50Points: 0,
      p85Points: 0,
      rearrangement: { crossed: false, permutation: [0, 1, 2], maximumMovement: 0 },
    });
    expect(
      applyMarginalIntervalCalibration(
        forecast({ p15Points: -30, p50Points: -20, p85Points: -10 }),
        fitted,
      ),
    ).toMatchObject({
      p15Points: -10,
      p50Points: -10,
      p85Points: -10,
    });
  });

  it("survives JSON round trips without BigInt values and never mutates inputs", () => {
    const history = rows();
    const original = structuredClone(history);
    const fitted = fit(history);
    const before = JSON.stringify(fitted);
    const restored = JSON.parse(before) as MarginalIntervalCalibrationFit;
    expect(applyMarginalIntervalCalibration(forecast(), restored)).toEqual(
      applyMarginalIntervalCalibration(forecast(), fitted),
    );
    expect(history).toEqual(original);
    expect(JSON.stringify(fitted)).toBe(before);
  });

  it("canonicalizes signed zero so fitted evidence and corrections survive JSON exactly", () => {
    const fitted = fit(
      rows().map((r) => ({
        ...r,
        actualPoints: -0,
        p15Points: 0,
        p50Points: 0,
        p85Points: 0,
      })),
    );
    expect(fitted.corrections).toEqual([0, 0, 0]);
    expect(JSON.parse(JSON.stringify(fitted))).toEqual(fitted);
    const corrected = applyMarginalIntervalCalibration(
      forecast({
        p15Points: -0,
        p50Points: -0,
        p85Points: -0,
      }),
      fitted,
    );
    expect(JSON.parse(JSON.stringify(corrected))).toEqual(corrected);
  });

  it("cannot train on own-season or later outcomes and locks application to the fit season", () => {
    const future = row(100, {
      forecastSeason: 2023,
      asOfWeek: 2,
      windowStartWeek: 3,
      actualPoints: 1_000,
    });
    expect(fit([...rows(), future])).toEqual(fit());
    expect(
      fit([
        ...rows(),
        { ...future, actualPoints: -1_000, p15Points: -2_000, p50Points: 0, p85Points: 2_000 },
      ]),
    ).toEqual(fit());
    expect(fit(rows(), 2022)).toMatchObject({
      state: "insufficient-evidence",
      priorSeasons: [],
      samples: 0,
    });
    expect(() => fit([...rows(), future], 2024)).toThrow("prior season is not complete");
    expect(() =>
      applyMarginalIntervalCalibration(forecast({ forecastSeason: 2024 }), fit()),
    ).toThrow("forecast season mismatch");
    expect(() =>
      applyMarginalIntervalCalibration(forecast(), { ...fit(), priorSeasons: [2023] }),
    ).toThrow("strictly prior season");
  });

  it("reports fit support independently of any release eligibility", () => {
    const insufficient = fit(rows().slice(0, 17));
    expect(insufficient).toMatchObject({
      state: "insufficient-evidence",
      corrections: null,
      reasons: ["fewer-than-18-rows"],
    });
    expect(() => applyMarginalIntervalCalibration(forecast(), insufficient)).toThrow("not fitted");
    expect(fit(rows().map((r) => ({ ...r, asOfWeek: 1, windowStartWeek: 2 })))).toMatchObject({
      state: "insufficient-evidence",
      reasons: ["fewer-than-3-cutoffs", "fewer-than-3-blocks"],
    });
    expect(fit()).toMatchObject({ state: "fitted", priorSeasons: [2022] });
  });

  it.each([
    { scheduledGames: 0 },
    { scheduledGames: 18 },
    { scheduledGames: 1.5 },
    { scheduledGames: undefined },
    { asOfWeek: 18 },
    { windowStartWeek: 1 },
    { windowEndWeek: 1 },
    { windowEndWeek: 19 },
    { windowStartWeek: 18, scheduledGames: 2 },
    { p15Points: NaN },
    { p50Points: Infinity },
    { p85Points: undefined },
    { p15Points: 1 },
    { p85Points: -1 },
    { actualPoints: NaN },
    { actualPoints: Number.MAX_VALUE, p15Points: -Number.MAX_VALUE },
    { seriesKey: "different-profile-or-candidate" },
    { identity: "" },
    { playerId: "" },
  ])("rejects malformed row evidence without silently omitting it: %j", (patch) => {
    const history = rows();
    history[0] = { ...history[0], ...patch } as MarginalIntervalHistoryRow;
    expect(() => fit(history)).toThrow();
  });

  it("rejects duplicate identities, renamed duplicate forecasts, mixed scope and missing completion", () => {
    expect(() => fit([...rows(), row(0)])).toThrow("Duplicate");
    expect(() => fit([...rows(), row(0, { identity: "renamed" })])).toThrow("Duplicate");
    expect(() => fit([...rows(), row(100, { identity: "row-0" })])).toThrow("Duplicate");
    expect(() =>
      fitMarginalIntervalCalibration({
        seriesKey,
        forecastSeason: 2023,
        completedSeasons: [],
        rows: rows(),
      }),
    ).toThrow("not complete");
    expect(() =>
      fitMarginalIntervalCalibration({
        seriesKey,
        forecastSeason: 2023,
        completedSeasons: [2022, 2022],
        rows: rows(),
      }),
    ).toThrow("Duplicate");
    expect(() =>
      applyMarginalIntervalCalibration(forecast({ seriesKey: "another-profile" }), fit()),
    ).toThrow("scope");
  });

  it("bounds workload and rejects invalid serialized executable fit fields", () => {
    expect(() =>
      fit(Array.from({ length: MARGINAL_INTERVAL_CALIBRATION_MAX_ROWS + 1 }, () => row(0))),
    ).toThrow("row bound");
    for (const patch of [
      { version: "unknown" },
      { target: "simultaneous-eight" },
      { nominalCoverage: 0.85 },
      { quantiles: [0.15, 0.85] },
      { quantiles: Array<number>(3) },
      { quantiles: Object.assign(Array<number>(3), { 0: 0.15, 2: 0.85 }) },
      { weighting: "equal-rows" },
      { scale: "actual-games" },
      { priorSeasons: [] },
      { priorSeasons: Array<number>(1) },
      { priorSeasons: [2022, 2022] },
      { samples: 0 },
      { blocks: 0 },
      { distinctCutoffs: 0 },
      { corrections: [0, 1] },
      { corrections: Array<number>(3) },
      { corrections: [0, Infinity, 0] },
    ]) {
      expect(() =>
        applyMarginalIntervalCalibration(forecast(), {
          ...fit(),
          ...patch,
        } as MarginalIntervalCalibrationFit),
      ).toThrow();
    }
    const extreme = {
      ...fit(),
      corrections: [Number.MAX_VALUE, 0, 0],
    } as MarginalIntervalCalibrationFit;
    expect(() =>
      applyMarginalIntervalCalibration(forecast({ scheduledGames: 2 }), extreme),
    ).toThrow("finite");
  });

  it("rejects sparse history and completion arrays instead of skipping missing evidence", () => {
    expect(() => fit(Array<MarginalIntervalHistoryRow>(18))).toThrow();
    expect(() =>
      fitMarginalIntervalCalibration({
        seriesKey,
        forecastSeason: 2023,
        completedSeasons: Array<number>(1),
        rows: rows(),
      }),
    ).toThrow("completed season");
  });
});
