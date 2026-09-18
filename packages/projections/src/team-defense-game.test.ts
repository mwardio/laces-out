import { describe, expect, it } from "vitest";
import {
  DEFENSE_COPULA_COMPONENTS,
  DEFENSE_EVENT_COMPONENTS,
  DEFENSE_GAME_UNIFORMS,
  defenseGameRankDependence,
  prepareFirstPartyDefenseGame,
  sampleFirstPartyDefenseGame,
  type DefenseEventComponent,
} from "./team-defense-game.js";
import { scoreProjectionStatComponents } from "./scoring.js";

function mass(entries: readonly (readonly [number, number])[]) {
  const weights = Array<number>(Math.max(...entries.map(([outcome]) => outcome)) + 1).fill(0);
  for (const [outcome, weight] of entries) weights[outcome] = weight;
  return { weights, totalWeight: weights.reduce((sum, weight) => sum + weight, 0) };
}

function fixture(alpha = 0) {
  return {
    components: {
      defensive_sacks: 2.6,
      defensive_interceptions: 0.85,
      defensive_fumble_recoveries: 0.65,
      defensive_touchdowns: 0.18,
      defensive_safeties: 0.05,
      defensive_blocked_kicks: 0.12,
      fourth_down_stops: 0.85,
      special_teams_touchdowns: 0.08,
      points_allowed: 23,
      yards_allowed: 525,
    },
    allowed: {
      pointsAllowed: mass([
        [0, 1],
        [46, 1],
      ]),
      yardsAllowed: mass([
        [500, 1],
        [550, 1],
      ]),
    },
    overdispersion: Object.fromEntries(
      DEFENSE_EVENT_COMPONENTS.map((key) => [key, alpha]),
    ) as Record<DefenseEventComponent, number>,
    dependence: defenseGameRankDependence([DEFENSE_COPULA_COMPONENTS.map(() => 0)]),
  };
}

function random(seed = 83471) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 2 ** 32;
  };
}

describe("coherent defense game outcomes", () => {
  it.each([0, 0.5])("preserves event means and NB2 variance with alpha=%s", (alpha) => {
    const input = fixture(alpha);
    const game = prepareFirstPartyDefenseGame(input);
    const rng = random();
    const totals: Record<string, number> = {};
    const squares: Record<string, number> = {};
    let zeroTurnovers = 0;
    let invalidOutcomes = 0;
    const samples = 32_768;
    for (let n = 0; n < samples; n += 1) {
      const outcome = sampleFirstPartyDefenseGame(
        game,
        Array.from({ length: DEFENSE_GAME_UNIFORMS }, rng),
      );
      const turnovers = outcome.defensive_interceptions! + outcome.defensive_fumble_recoveries!;
      if (outcome.defensive_touchdowns! > turnovers) invalidOutcomes += 1;
      if (turnovers === 0) {
        zeroTurnovers += 1;
        if (outcome.defensive_touchdowns !== 0) invalidOutcomes += 1;
      }
      for (const [key, value] of Object.entries(outcome)) {
        if (!Number.isSafeInteger(value) || value < 0) invalidOutcomes += 1;
        totals[key] = (totals[key] ?? 0) + value;
        squares[key] = (squares[key] ?? 0) + value * value;
      }
      if (
        outcome.points_allowed_35_plus_probability !==
        outcome.points_allowed_35_45_probability! + outcome.points_allowed_46_plus_probability!
      )
        invalidOutcomes += 1;
      if (
        outcome.yards_allowed_500_plus_probability !==
        outcome.yards_allowed_500_549_probability! + outcome.yards_allowed_550_plus_probability!
      )
        invalidOutcomes += 1;
    }
    expect(invalidOutcomes).toBe(0);
    expect(zeroTurnovers).toBeGreaterThan(samples / 8);
    for (const key of DEFENSE_EVENT_COMPONENTS) {
      const targetMean = input.components[key];
      const targetVariance = targetMean + alpha * targetMean ** 2;
      const measuredMean = totals[key]! / samples;
      const measuredVariance = squares[key]! / samples - measuredMean ** 2;
      expect(Math.abs(measuredMean - targetMean)).toBeLessThan(
        6 * Math.sqrt(targetVariance / samples),
      );
      expect(Math.abs(measuredVariance - targetVariance)).toBeLessThan(
        0.08 + 0.04 * targetVariance,
      );
    }
    expect(totals.defensive_touchdowns! / samples).toBeCloseTo(0.18, 2);
    expect(totals.points_allowed_0_probability! / samples).toBeCloseTo(0.5, 2);
    expect(totals.yards_allowed_550_plus_probability! / samples).toBeCloseTo(0.5, 2);
  });

  it("retains dependence while tied empirical ranks keep uniform margins", () => {
    const input = fixture();
    input.dependence = defenseGameRankDependence(
      Array.from({ length: 10 }, (_, i) =>
        DEFENSE_COPULA_COMPONENTS.map((_, dimension) =>
          dimension < 7 ? Number(i < 5) : Number(i >= 5),
        ),
      ),
    );
    const game = prepareFirstPartyDefenseGame(input);
    const rng = random(23569);
    let firstBucket = 0;
    let highPointsSacks = 0;
    let lowPointsSacks = 0;
    for (let n = 0; n < 4096; n += 1) {
      const outcome = sampleFirstPartyDefenseGame(
        game,
        Array.from({ length: DEFENSE_GAME_UNIFORMS }, rng),
      );
      if (outcome.points_allowed === 0) {
        firstBucket += 1;
        lowPointsSacks += outcome.defensive_sacks!;
        expect(outcome.yards_allowed).toBe(500);
      } else {
        highPointsSacks += outcome.defensive_sacks!;
        expect(outcome.yards_allowed).toBe(550);
      }
    }
    expect(firstBucket / 4096).toBeCloseTo(0.5, 1);
    expect(lowPointsSacks / firstBucket).toBeGreaterThan(highPointsSacks / (4096 - firstBucket));
  });

  it("scores each realized game's custom penalties, overlapping brackets, and bonuses", () => {
    const game = prepareFirstPartyDefenseGame(fixture());
    const low = sampleFirstPartyDefenseGame(game, Array<number>(DEFENSE_GAME_UNIFORMS).fill(0));
    const high = sampleFirstPartyDefenseGame(game, Array<number>(DEFENSE_GAME_UNIFORMS).fill(0.75));
    const profile = {
      id: "custom-defense",
      rules: [
        { statId: "points_allowed", points: -0.1, bonuses: [{ atLeast: 40, points: -7 }] },
        { statId: "points_allowed_46_plus_probability", points: -10 },
        { statId: "yards_allowed_500_plus_probability", points: -3 },
        { statId: "yards_allowed_550_plus_probability", points: -2 },
      ],
    };
    expect(scoreProjectionStatComponents(low, profile)).toBe(-3);
    expect(scoreProjectionStatComponents(high, profile)).toBe(-26.6);
    // A 40-point threshold must not disappear merely because the mean allowed score is 23.
    expect(
      (scoreProjectionStatComponents(low, profile) + scoreProjectionStatComponents(high, profile)) /
        2,
    ).toBe(-14.8);
    expect(low).toEqual(
      sampleFirstPartyDefenseGame(game, Array<number>(DEFENSE_GAME_UNIFORMS).fill(0)),
    );
  });

  it("handles zero-mass support, exact CDF boundaries, and rounded declared totals", () => {
    const input = fixture();
    input.allowed.pointsAllowed = { weights: [0, 1, 0], totalWeight: 1 - 5e-13 };
    const game = prepareFirstPartyDefenseGame(input);
    expect(game.pointsAllowedCdf).toEqual([0, 1, 1]);
    expect(
      sampleFirstPartyDefenseGame(game, Array<number>(DEFENSE_GAME_UNIFORMS).fill(0))
        .points_allowed,
    ).toBe(1);
    const ordinary = prepareFirstPartyDefenseGame(fixture());
    expect(
      sampleFirstPartyDefenseGame(ordinary, Array<number>(DEFENSE_GAME_UNIFORMS).fill(0.5))
        .points_allowed,
    ).toBe(46);
  });

  it("fails closed on malformed masses, impossible event means, and biased rank tables", () => {
    const input = fixture();
    expect(() =>
      prepareFirstPartyDefenseGame({
        ...input,
        allowed: {
          ...input.allowed,
          pointsAllowed: {
            weights: [Number.MAX_VALUE, Number.MAX_VALUE],
            totalWeight: Number.MAX_VALUE,
          },
        },
      }),
    ).toThrow("total");
    expect(() =>
      prepareFirstPartyDefenseGame({
        ...input,
        components: { ...input.components, defensive_touchdowns: 2 },
      }),
    ).toThrow("opportunities");
    expect(() =>
      prepareFirstPartyDefenseGame({
        ...input,
        dependence: {
          rowCount: 2,
          packedRanks: btoa(
            String.fromCharCode(
              ...Array.from({ length: DEFENSE_COPULA_COMPONENTS.length * 4 * 2 }, (_, i) =>
                i % 4 === 2 ? 1 : 0,
              ),
            ),
          ),
        },
      }),
    ).toThrow("uniform");
    expect(() => defenseGameRankDependence([[Number.NaN]])).toThrow("finite");
    const game = prepareFirstPartyDefenseGame(input);
    for (const invalid of [1, -0.01, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        sampleFirstPartyDefenseGame(game, Array<number>(DEFENSE_GAME_UNIFORMS).fill(invalid)),
      ).toThrow("draws");
    }
  });

  it("rejects missing slots in draw, mass, and observation arrays", () => {
    const input = fixture();
    const game = prepareFirstPartyDefenseGame(input);
    const draws = Array<number>(DEFENSE_GAME_UNIFORMS).fill(0.5);
    Reflect.deleteProperty(draws, 1);
    expect(() => sampleFirstPartyDefenseGame(game, draws)).toThrow("draws");
    const weights = Array<number>(2);
    weights[1] = 1;
    expect(() =>
      prepareFirstPartyDefenseGame({
        ...input,
        allowed: { ...input.allowed, pointsAllowed: { weights, totalWeight: 1 } },
      }),
    ).toThrow("mass");
    const observation = Array<number>(DEFENSE_COPULA_COMPONENTS.length).fill(0);
    Reflect.deleteProperty(observation, 0);
    expect(() => defenseGameRankDependence([observation])).toThrow("finite");
  });
});
