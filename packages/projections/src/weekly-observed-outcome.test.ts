import { describe, expect, it } from "vitest";
import { scoreObservedWeeklyComponents } from "./weekly-observed-outcome.js";
import { scoreProjectionStatComponents, type ProjectionScoringProfile } from "./scoring.js";
const profile = (rules: ProjectionScoringProfile["rules"]): ProjectionScoringProfile => ({
  id: "captured",
  rules,
});
const ppr = profile([
  { statId: "receiving_yards", points: 0.1 },
  { statId: "receptions", points: 1 },
]);

describe("complete realized weekly scoring", () => {
  it("does not turn absent stats into the ordinary scorer's zero defaults", () => {
    expect(scoreProjectionStatComponents({ receiving_yards: 100 }, ppr)).toBe(10);
    const result = scoreObservedWeeklyComponents({
      kind: "player",
      profile: ppr,
      components: { receiving_yards: 100 },
    });
    expect(result).toMatchObject({
      state: "unavailable",
      points: null,
      missingComponents: ["receptions"],
    });
    expect(
      scoreObservedWeeklyComponents({ kind: "player", profile: ppr, components: {} }).state,
    ).toBe("unavailable");
  });
  it("scores explicit zero and negative observed yardage without filtering forecasts by role", () => {
    expect(
      scoreObservedWeeklyComponents({
        kind: "player",
        profile: ppr,
        components: { receiving_yards: -4, receptions: 0 },
      }),
    ).toMatchObject({ state: "scored", points: -0.4 });
    expect(
      scoreObservedWeeklyComponents({
        kind: "player",
        profile: ppr,
        components: { receiving_yards: 0, receptions: 0 },
      }),
    ).toMatchObject({ state: "scored", points: 0 });
  });
  it("requires a component even for bonus-only rules and a zero threshold", () => {
    const bonus = profile([
      {
        statId: "passing_yards",
        points: 0,
        bonuses: [
          { atLeast: 0, points: 2 },
          { atLeast: 300, points: 4 },
        ],
      },
    ]);
    expect(scoreProjectionStatComponents({}, bonus)).toBe(2);
    expect(
      scoreObservedWeeklyComponents({ kind: "player", profile: bonus, components: {} }).state,
    ).toBe("unavailable");
    expect(
      scoreObservedWeeklyComponents({
        kind: "player",
        profile: bonus,
        components: { passing_yards: 301 },
      }),
    ).toMatchObject({ state: "scored", points: 6 });
  });
  it("derives exact realized yardage bonuses and whole groups from complete raw values", () => {
    const scoring = profile([
      { statId: "receiving_yards_100_199_probability", points: 3 },
      { statId: "receiving_yards_200_plus_probability", points: 5 },
      { statId: "receiving_yards_per_10_units", points: 1 },
    ]);
    expect(
      scoreObservedWeeklyComponents({
        kind: "player",
        profile: scoring,
        components: { receiving_yards: 209 },
      }),
    ).toMatchObject({ state: "scored", points: 25 });
    expect(
      scoreObservedWeeklyComponents({ kind: "player", profile: scoring, components: {} })
        .missingComponents,
    ).toHaveLength(3);
  });
  it("requires all raw aggregate dependencies and refuses contradictory canonical aliases", () => {
    const scoring = profile([
      { statId: "turnovers", points: -2 },
      { statId: "two_point_conversions", points: 2 },
    ]);
    const raw = {
      fumbles_lost_total: 1,
      passing_interceptions: 0,
      passing_two_point_conversions: 1,
      rushing_two_point_conversions: 0,
    };
    expect(
      scoreObservedWeeklyComponents({ kind: "player", profile: scoring, components: raw })
        .missingComponents,
    ).toEqual(["two_point_conversions"]);
    expect(
      scoreObservedWeeklyComponents({
        kind: "player",
        profile: scoring,
        components: { ...raw, receiving_two_point_conversions: 1 },
      }),
    ).toMatchObject({ state: "scored", points: 2 });
    expect(
      scoreObservedWeeklyComponents({
        kind: "player",
        profile: ppr,
        components: {
          receiving_yards: 200,
          receptions: 1,
          receiving_yards_200_plus_probability: 0,
        },
      }),
    ).toMatchObject({
      state: "unavailable",
      conflictingComponents: ["receiving_yards_200_plus_probability"],
    });
  });
  it("derives zero long touchdowns only from observed parent counts and rejects nested conflicts", () => {
    const scoring = profile([
      { statId: "receiving_touchdowns_40_plus", points: 2 },
      { statId: "receiving_touchdowns_50_plus", points: 3 },
    ]);
    expect(
      scoreObservedWeeklyComponents({
        kind: "player",
        profile: scoring,
        components: { receiving_touchdowns: 0 },
      }),
    ).toMatchObject({ state: "scored", points: 0 });
    expect(
      scoreObservedWeeklyComponents({
        kind: "player",
        profile: scoring,
        components: { receiving_touchdowns: 1 },
      }).state,
    ).toBe("unavailable");
    expect(
      scoreObservedWeeklyComponents({
        kind: "player",
        profile: scoring,
        components: {
          receiving_touchdowns: 1,
          receiving_touchdowns_40_plus: 0,
          receiving_touchdowns_50_plus: 1,
        },
      }),
    ).toMatchObject({
      state: "unavailable",
      conflictingComponents: ["receiving_touchdowns_50_plus"],
    });
  });
  it("derives defense buckets only from observed totals and never imports rare-event zero assumptions", () => {
    const scoring = profile([
      { statId: "points_allowed_0_probability", points: 10 },
      { statId: "receiving_yards", points: 0.1 },
    ]);
    expect(
      scoreObservedWeeklyComponents({
        kind: "team-defense",
        profile: scoring,
        components: { points_allowed: 0 },
      }),
    ).toMatchObject({ state: "scored", points: 10, inapplicableComponents: ["receiving_yards"] });
    expect(
      scoreObservedWeeklyComponents({
        kind: "player",
        profile: scoring,
        components: { receiving_yards: 10 },
      }),
    ).toMatchObject({
      state: "scored",
      points: 1,
      inapplicableComponents: ["points_allowed_0_probability"],
    });
    const rare = profile([{ statId: "defensive_two_point_returns", points: 2 }]);
    expect(
      scoreObservedWeeklyComponents({ kind: "team-defense", profile: rare, components: {} }),
    ).toMatchObject({ state: "unavailable", missingComponents: ["defensive_two_point_returns"] });
  });
  it("scores genuine blocked kicks while rejecting contradictory canonical totals", () => {
    const kicks = profile([
      { statId: "field_goals_missed", points: -1 },
      { statId: "extra_points_missed", points: -1 },
    ]);
    const raw = {
      field_goals_attempted: 1,
      field_goals_made: 0,
      field_goals_missed: 0,
      field_goals_blocked: 1,
      extra_points_attempted: 1,
      extra_points_made: 0,
      extra_points_missed: 0,
    };
    expect(
      scoreObservedWeeklyComponents({ kind: "player", profile: kicks, components: raw }),
    ).toMatchObject({ state: "scored", points: -2 });
    expect(
      scoreObservedWeeklyComponents({
        kind: "player",
        profile: kicks,
        components: { ...raw, field_goals_missed: 1, field_goals_missed_unblocked: 0 },
      }),
    ).toMatchObject({ state: "scored", points: -2 });
    expect(
      scoreObservedWeeklyComponents({
        kind: "player",
        profile: kicks,
        components: { ...raw, field_goals_missed_unblocked: 0 },
      }),
    ).toMatchObject({ state: "unavailable", conflictingComponents: ["field_goals_missed"] });
    expect(
      scoreObservedWeeklyComponents({
        kind: "player",
        profile: profile([{ statId: "extra_points_missed", points: -1 }]),
        components: { extra_points_missed: 0 },
      }),
    ).toMatchObject({ state: "unavailable", missingComponents: ["extra_points_missed"] });
  });
  it("rejects probabilities that are forecasts, nonfinite components and overflowing actual scores", () => {
    const bonus = profile([{ statId: "receiving_yards_200_plus_probability", points: 5 }]);
    expect(
      scoreObservedWeeklyComponents({
        kind: "player",
        profile: bonus,
        components: { receiving_yards_200_plus_probability: 0.4 },
      }).state,
    ).toBe("unavailable");
    expect(
      scoreObservedWeeklyComponents({
        kind: "player",
        profile: ppr,
        components: { receiving_yards: NaN, receptions: 1 },
      }).state,
    ).toBe("unavailable");
    expect(
      scoreObservedWeeklyComponents({
        kind: "player",
        profile: profile([{ statId: "receiving_yards", points: 1e308 }]),
        components: { receiving_yards: 1e308 },
      }),
    ).toMatchObject({ state: "unavailable", invalidComponents: ["scored-total-overflow"] });
  });
});
