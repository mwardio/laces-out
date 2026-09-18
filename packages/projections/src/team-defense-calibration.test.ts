import { describe, expect, it } from "vitest";
import type { FirstPartyTeamDefenseWeeklyStatLine } from "./first-party.js";
import type { ProjectionStatComponents } from "./scoring.js";
import { fitFirstPartyDefenseGameCalibration } from "./team-defense-calibration.js";
import {
  DEFENSE_COPULA_COMPONENTS,
  DEFENSE_EVENT_COMPONENTS,
  type DefenseGameDependence,
} from "./team-defense-game.js";

function unpackRanks(dependence: DefenseGameDependence) {
  const bytes = Buffer.from(dependence.packedRanks, "base64");
  return Array.from({ length: dependence.rowCount }, (_, row) =>
    DEFENSE_COPULA_COMPONENTS.map((_, column) => {
      const offset = (row * DEFENSE_COPULA_COMPONENTS.length + column) * 4;
      return {
        lower: bytes.readUInt16LE(offset) / dependence.rowCount,
        upper: bytes.readUInt16LE(offset + 2) / dependence.rowCount,
      };
    }),
  );
}

function game(
  team: string,
  week: number,
  components: ProjectionStatComponents = {},
  season = 2024,
): FirstPartyTeamDefenseWeeklyStatLine {
  return {
    team,
    season,
    week,
    played: true,
    components: {
      ...Object.fromEntries(DEFENSE_COPULA_COMPONENTS.map((component) => [component, 0])),
      defensive_touchdowns: 0,
      ...components,
    },
  };
}

const pooled = [
  game("NE", 1, { defensive_sacks: 0, fourth_down_stops: 0, points_allowed: 20 }),
  game("NE", 2, { defensive_sacks: 4, fourth_down_stops: 2, points_allowed: 30 }),
  game("KC", 1, { defensive_sacks: 1, points_allowed: 30 }),
  game("KC", 2, { defensive_sacks: 1, points_allowed: 20 }),
  game("KC", 3, { defensive_sacks: 1, points_allowed: 10 }),
] as const;

describe("prior-season defense game calibration", () => {
  it("pools within-team-season unbiased variance rather than between-team differences", () => {
    const result = fitFirstPartyDefenseGameCalibration(pooled, 2025);
    expect(result.state).toBe("fitted");
    if (result.state !== "fitted") throw new Error("Expected a fitted calibration");
    // NE: n=2, mean=2, unbiased variance=8. KC: n=3, mean=1, variance=0.
    // Numerator = (8-2) + 2*(0-1) = 4; denominator = 2² + 2*1² = 6.
    expect(result.overdispersion.defensive_sacks).toBeCloseTo(2 / 3, 14);
    expect(result.componentEvidence.defensive_sacks).toEqual({
      numerator: 4,
      denominator: 6,
      groups: 2,
      rows: 5,
      degreesOfFreedom: 3,
      zeroMeanGroups: 0,
    });
    expect(result.overdispersion.fourth_down_stops).toBe(1);
    expect(result.componentEvidence.fourth_down_stops).toMatchObject({
      numerator: 1,
      denominator: 1,
      zeroMeanGroups: 1,
    });
    expect(result).toMatchObject({
      forecastSeason: 2025,
      throughSeason: 2024,
      rows: 5,
      groups: 2,
      singletonGroups: 0,
    });
  });

  it("excludes current/future outcomes and nonplayed rows before reading their components", () => {
    const expected = fitFirstPartyDefenseGameCalibration(pooled, 2025);
    const irrelevant = [
      { ...game("NE", 1, {}, 2025), components: {} },
      { ...game("NE", 1, {}, 2026), components: { defensive_sacks: Infinity } },
      { ...game("NE", 1, {}, 2023), played: false, components: {} },
    ];
    expect(fitFirstPartyDefenseGameCalibration([...pooled, ...irrelevant], 2025)).toEqual(expected);
    expect(
      fitFirstPartyDefenseGameCalibration(
        pooled.map((row) => {
          const withoutPlayed = { ...row };
          delete withoutPlayed.played;
          return withoutPlayed;
        }),
        2025,
      ),
    ).toEqual(expected);
  });

  it("is shuffle deterministic and does not mutate historical rows", () => {
    const original = structuredClone(pooled);
    expect(fitFirstPartyDefenseGameCalibration([...pooled].reverse(), 2025)).toEqual(
      fitFirstPartyDefenseGameCalibration(pooled, 2025),
    );
    expect(pooled).toEqual(original);
  });

  it("centers all copula dimensions within prior team-seasons, preserving tied ranks", () => {
    const result = fitFirstPartyDefenseGameCalibration(pooled, 2025);
    if (result.state !== "fitted") throw new Error("Expected a fitted calibration");
    const sacks = DEFENSE_COPULA_COMPONENTS.indexOf("defensive_sacks");
    const allowed = DEFENSE_COPULA_COMPONENTS.indexOf("points_allowed");
    // Stable season/week/team ordering: KC1, NE1, KC2, NE2, KC3.
    expect(unpackRanks(result.dependence).map((row) => row[sacks])).toEqual([
      { lower: 1 / 5, upper: 4 / 5 },
      { lower: 0, upper: 1 / 5 },
      { lower: 1 / 5, upper: 4 / 5 },
      { lower: 4 / 5, upper: 1 },
      { lower: 1 / 5, upper: 4 / 5 },
    ]);
    expect(unpackRanks(result.dependence).map((row) => row[allowed])).toEqual([
      { lower: 4 / 5, upper: 1 },
      { lower: 1 / 5, upper: 2 / 5 },
      { lower: 2 / 5, upper: 3 / 5 },
      { lower: 3 / 5, upper: 4 / 5 },
      { lower: 0, upper: 1 / 5 },
    ]);
    const shifted = fitFirstPartyDefenseGameCalibration(
      pooled.map((row) => ({
        ...row,
        components: {
          ...row.components,
          points_allowed: row.components.points_allowed! + (row.team === "NE" ? 100 : 0),
        },
      })),
      2025,
    );
    if (shifted.state !== "fitted") throw new Error("Expected a fitted calibration");
    expect(shifted.dependence).toEqual(result.dependence);
    expect(result.assumptions.join(" ")).toContain("not conditional forecast calibration");
  });

  it("keeps team-season groups separate and records singletons without fitting their variance", () => {
    const rows = [
      game("NE", 1, { defensive_sacks: 1 }, 2023),
      game("NE", 2, { defensive_sacks: 1 }, 2023),
      game("NE", 1, { defensive_sacks: 10 }, 2024),
      game("NE", 2, { defensive_sacks: 10 }, 2024),
      game("KC", 1, { defensive_sacks: 100 }, 2024),
    ];
    const result = fitFirstPartyDefenseGameCalibration(rows, 2025);
    if (result.state !== "fitted") throw new Error("Expected a fitted calibration");
    expect(result).toMatchObject({ rows: 5, groups: 3, singletonGroups: 1 });
    expect(result.componentEvidence.defensive_sacks).toEqual({
      numerator: -11,
      denominator: 101,
      groups: 2,
      rows: 4,
      degreesOfFreedom: 2,
      zeroMeanGroups: 0,
    });
    expect(result.overdispersion.defensive_sacks).toBe(0);
    expect(result.dependence.rowCount).toBe(5);
  });

  it("distinguishes missing history and singleton groups from valid all-zero evidence", () => {
    expect(fitFirstPartyDefenseGameCalibration([], 2025)).toMatchObject({
      state: "insufficient-history",
      reason: "no-prior-played-games",
      throughSeason: null,
      rows: 0,
      groups: 0,
    });
    expect(fitFirstPartyDefenseGameCalibration([game("NE", 1), game("KC", 1)], 2025)).toMatchObject(
      {
        state: "insufficient-history",
        reason: "no-repeated-team-season-group",
        throughSeason: 2024,
        rows: 2,
        groups: 2,
        singletonGroups: 2,
      },
    );
    const result = fitFirstPartyDefenseGameCalibration([game("NE", 1), game("NE", 2)], 2025);
    if (result.state !== "fitted") throw new Error("Expected all-zero evidence to remain fitted");
    for (const component of DEFENSE_EVENT_COMPONENTS) {
      expect(result.overdispersion[component]).toBe(0);
      expect(result.componentEvidence[component]).toEqual({
        numerator: 0,
        denominator: 0,
        groups: 1,
        rows: 2,
        degreesOfFreedom: 1,
        zeroMeanGroups: 1,
      });
    }
    expect(unpackRanks(result.dependence)).toEqual([
      DEFENSE_COPULA_COMPONENTS.map(() => ({ lower: 0, upper: 1 })),
      DEFENSE_COPULA_COMPONENTS.map(() => ({ lower: 0, upper: 1 })),
    ]);
  });

  it.each([...DEFENSE_COPULA_COMPONENTS, "defensive_touchdowns"])(
    "rejects an eligible row missing %s instead of imputing zero",
    (component) => {
      const components = { ...game("NE", 1).components };
      delete components[component];
      expect(() =>
        fitFirstPartyDefenseGameCalibration(
          [{ ...game("NE", 1), components }, game("NE", 2)],
          2025,
        ),
      ).toThrow(/nonnegative safe integer/u);
    },
  );

  it.each([-1, NaN, Infinity, -Infinity])("rejects invalid primitive values: %s", (value) => {
    expect(() =>
      fitFirstPartyDefenseGameCalibration(
        [game("NE", 1, { yards_allowed: value }), game("NE", 2)],
        2025,
      ),
    ).toThrow(/nonnegative safe integer/u);
  });

  it.each([...DEFENSE_COPULA_COMPONENTS, "defensive_touchdowns"])(
    "rejects fractional or unsafe historical %s instead of fitting projected rates",
    (component) => {
      for (const value of [0.5, 1.25, Number.MAX_SAFE_INTEGER + 1]) {
        expect(() =>
          fitFirstPartyDefenseGameCalibration(
            [game("NE", 1, { [component]: value }), game("NE", 2)],
            2025,
          ),
        ).toThrow(`${component} must be a nonnegative safe integer`);
      }
    },
  );

  it("excludes current/future and nonplayed rows before validating their actual totals", () => {
    const expected = fitFirstPartyDefenseGameCalibration(pooled, 2025);
    const invalidComponents = Object.fromEntries(
      [...DEFENSE_COPULA_COMPONENTS, "defensive_touchdowns"].map((component) => [component, 0.5]),
    );
    expect(
      fitFirstPartyDefenseGameCalibration(
        [
          ...pooled,
          game("NE", 1, invalidComponents, 2025),
          game("NE", 1, invalidComponents, 2026),
          { ...game("NE", 1, invalidComponents, 2023), played: false },
        ],
        2025,
      ),
    ).toEqual(expected);
  });

  it("rejects defensive touchdowns above their turnover opportunities", () => {
    expect(() =>
      fitFirstPartyDefenseGameCalibration(
        [
          game("NE", 1, {
            defensive_interceptions: 1,
            defensive_fumble_recoveries: 0,
            defensive_touchdowns: 2,
          }),
          game("NE", 2),
        ],
        2025,
      ),
    ).toThrow(/touchdowns exceed/u);
  });

  it.each([
    ["NE", "NE"],
    ["ne", " NE "],
    ["OAK", "LV"],
    ["SD", "LAC"],
    ["STL", "LAR"],
    ["LA", "LAR"],
  ])("rejects identical and conflicting duplicates after alias normalization: %s/%s", (a, b) => {
    for (const sacks of [0, 3]) {
      expect(() =>
        fitFirstPartyDefenseGameCalibration(
          [game(a, 1), game(b, 1, { defensive_sacks: sacks }), game(a, 2)],
          2025,
        ),
      ).toThrow(/Duplicate defense calibration team\/week/u);
    }
  });

  it("accepts equivalent aliases without changing grouping or fitted evidence", () => {
    const canonical = [game("LV", 1), game("LV", 2, { defensive_sacks: 2 })];
    expect(
      fitFirstPartyDefenseGameCalibration(
        canonical.map((row) => ({ ...row, team: " OAK " })),
        2025,
      ),
    ).toEqual(fitFirstPartyDefenseGameCalibration(canonical, 2025));
  });

  it.each([
    { team: "unknown" },
    { team: "" },
    { season: NaN },
    { week: 0 },
    { week: 1.5 },
    { week: 26 },
  ])("rejects invalid eligible identities: %j", (patch) => {
    expect(() =>
      fitFirstPartyDefenseGameCalibration([{ ...game("NE", 1), ...patch }, game("NE", 2)], 2025),
    ).toThrow();
  });

  it("bounds history and rejects unsafe raw totals without a fabricated fallback", () => {
    expect(() => fitFirstPartyDefenseGameCalibration([], 2025.5)).toThrow(/positive safe integer/u);
    expect(() =>
      fitFirstPartyDefenseGameCalibration(
        Array.from({ length: 20_001 }, () => game("NE", 1)),
        2025,
      ),
    ).toThrow(/20000 rows/u);
    expect(() =>
      fitFirstPartyDefenseGameCalibration(
        [game("NE", 1, { defensive_sacks: 1e200 }), game("NE", 2)],
        2025,
      ),
    ).toThrow(/nonnegative safe integer/u);
  });
});
