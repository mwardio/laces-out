import { describe, expect, it } from "vitest";
import { NFLVERSE_DEFENSE_SCORING_EVENT_COMPONENTS } from "../../source-nflverse/src/defense-scoring-components.js";
import {
  DEFENSE_POINTS_ALLOWED_EVENT_POINTS,
  defensePointsAllowedFromScoringEvents,
  inspectDefenseScoringEventComponents,
  type DefensePointsAllowedDefinition,
  type DefenseScoringEventComponent,
} from "./defense-points-allowed.js";

function ledger(
  total: number,
  nonzero: Partial<Record<DefenseScoringEventComponent, number>> = {},
): Record<string, unknown> {
  return {
    ...Object.fromEntries(Object.keys(DEFENSE_POINTS_ALLOWED_EVENT_POINTS).map((key) => [key, 0])),
    ...nonzero,
    scoring_points_total: total,
    scoring_event_totals_complete: 1,
  };
}

// Observed ESPN statSourceId=0/statSplitTypeId=1 records (stat120 and stat187 agree).
// Yahoo expected values apply its current published definition, not captured historical actuals.
// Primary sources, full counts and SHA receipts are pinned in
// reports/ros-v13-full-defense-training-20260918/defense-source-semantics-20260919/
// provider-points-allowed-evidence-20260919.json .
const observedCases = [
  {
    game: "2023 week 1 NYG: blocked-FG return counts only on ESPN",
    final: 40,
    espn: 34,
    yahoo: 28,
    components: ledger(40, {
      scoring_event_blocked_field_goal_touchdown: 1,
      scoring_event_field_goal: 2,
      scoring_event_defensive_interception_touchdown: 1,
      scoring_event_extra_point: 4,
      scoring_event_offensive_rush_touchdown: 3,
    }),
  },
  {
    game: "2023 week 13 IND: defensive conversion return excluded",
    final: 28,
    espn: 26,
    yahoo: 26,
    components: ledger(28, {
      scoring_event_offensive_rush_touchdown: 2,
      scoring_event_extra_point: 2,
      scoring_event_field_goal: 2,
      scoring_event_defensive_two_point_return: 1,
      scoring_event_offensive_pass_touchdown: 1,
    }),
  },
  {
    game: "2023 week 16 DEN: kickoff-fumble TD included",
    final: 26,
    espn: 26,
    yahoo: 26,
    components: ledger(26, {
      scoring_event_field_goal: 2,
      scoring_event_offensive_pass_touchdown: 2,
      scoring_event_extra_point: 2,
      scoring_event_kickoff_fumble_touchdown: 1,
    }),
  },
  {
    game: "2023 week 4 KC: penalty safety excluded; offensive conversion included",
    final: 20,
    espn: 18,
    yahoo: 18,
    components: ledger(20, {
      scoring_event_safety: 1,
      scoring_event_field_goal: 1,
      scoring_event_offensive_pass_touchdown: 2,
      scoring_event_extra_point: 1,
      scoring_event_offensive_two_point_conversion: 1,
    }),
  },
  {
    game: "2023 week 5 BAL: blocked-punt safety excluded",
    final: 17,
    espn: 15,
    yahoo: 15,
    components: ledger(17, {
      scoring_event_field_goal: 3,
      scoring_event_safety: 1,
      scoring_event_offensive_pass_touchdown: 1,
    }),
  },
  {
    game: "2023 week 8 LAR: pick-six and blocked-punt safety excluded",
    final: 43,
    espn: 35,
    yahoo: 35,
    components: ledger(43, {
      scoring_event_offensive_pass_touchdown: 4,
      scoring_event_extra_point: 5,
      scoring_event_field_goal: 2,
      scoring_event_defensive_interception_touchdown: 1,
      scoring_event_safety: 1,
    }),
  },
  {
    game: "2024 week 4 NO: punt-muff TD included; pick-six excluded",
    final: 26,
    espn: 20,
    yahoo: 20,
    components: ledger(26, {
      scoring_event_punt_fumble_touchdown: 1,
      scoring_event_defensive_interception_touchdown: 1,
      scoring_event_field_goal: 4,
      scoring_event_extra_point: 2,
    }),
  },
  {
    game: "2024 week 8 LAC: punt-formation fumble safety excluded",
    final: 8,
    espn: 6,
    yahoo: 6,
    components: ledger(8, { scoring_event_safety: 1, scoring_event_field_goal: 2 }),
  },
  {
    game: "2021 week 3 ARI: missed-FG return included under explicit modern rules",
    final: 19,
    espn: 19,
    yahoo: 19,
    components: ledger(19, {
      scoring_event_field_goal_return_touchdown: 1,
      scoring_event_offensive_pass_touchdown: 1,
      scoring_event_offensive_rush_touchdown: 1,
      scoring_event_extra_point: 1,
    }),
  },
] as const;

describe("provider-specific defense points allowed", () => {
  it("uses the complete upstream event vocabulary without losing an event family", () => {
    expect(Object.keys(DEFENSE_POINTS_ALLOWED_EVENT_POINTS).sort()).toEqual(
      Object.values(NFLVERSE_DEFENSE_SCORING_EVENT_COMPONENTS).sort(),
    );
    expect(Object.keys(DEFENSE_POINTS_ALLOWED_EVENT_POINTS)).toHaveLength(18);
  });

  it.each(observedCases)("matches primary-source evidence: $game", (row) => {
    for (const [definition, expected] of [
      ["espn-2019-v1", row.espn],
      ["yahoo-2022-v1", row.yahoo],
    ] as const) {
      expect(
        defensePointsAllowedFromScoringEvents({
          definition,
          opponentComponents: row.components,
          opponentFinalScore: row.final,
        }),
      ).toEqual({
        state: "complete",
        definition,
        pointsAllowed: expected,
        excludedPoints: row.final - expected,
        opponentFinalScore: row.final,
      });
    }
  });

  it("distinguishes offensive recovery scores from opponent defensive fumble TDs", () => {
    expect(
      defensePointsAllowedFromScoringEvents({
        definition: "yahoo-2022-v1",
        opponentComponents: ledger(14, {
          scoring_event_offensive_fumble_touchdown: 1,
          scoring_event_defensive_fumble_touchdown: 1,
          scoring_event_extra_point: 2,
        }),
        opponentFinalScore: 14,
      }),
    ).toMatchObject({ state: "complete", pointsAllowed: 8, excludedPoints: 6 });
  });

  it("leaves a try safety unresolved only for ESPN while the neutral ledger remains complete", () => {
    const components = ledger(1, { scoring_event_one_point_safety: 1 });
    expect(inspectDefenseScoringEventComponents({ components, finalScore: 1 })).toMatchObject({
      state: "complete",
      scoringPointsTotal: 1,
      counts: { scoring_event_one_point_safety: 1 },
    });
    expect(
      defensePointsAllowedFromScoringEvents({
        definition: "yahoo-2022-v1",
        opponentComponents: components,
        opponentFinalScore: 1,
      }),
    ).toMatchObject({ state: "complete", pointsAllowed: 0, excludedPoints: 1 });
    expect(
      defensePointsAllowedFromScoringEvents({
        definition: "espn-2019-v1",
        opponentComponents: components,
        opponentFinalScore: 1,
      }),
    ).toMatchObject({
      state: "unresolved",
      pointsAllowed: null,
      reason: "unsupported-scoring-event",
      component: "scoring_event_one_point_safety",
    });
  });

  it("requires an explicit definition rather than assuming a default provider", () => {
    expect(
      defensePointsAllowedFromScoringEvents({
        definition: "generic" as DefensePointsAllowedDefinition,
        opponentComponents: ledger(0),
        opponentFinalScore: 0,
      }),
    ).toMatchObject({ state: "unresolved", reason: "unsupported-definition", pointsAllowed: null });
  });
});

describe("complete neutral scoring ledger inspection", () => {
  it("accepts a fully evidenced zero and unrelated team stats", () => {
    const components = { ...ledger(0), defensive_sacks: 3 };
    expect(inspectDefenseScoringEventComponents({ components, finalScore: 0 })).toMatchObject({
      state: "complete",
      scoringPointsTotal: 0,
      counts: { scoring_event_safety: 0, scoring_event_one_point_safety: 0 },
    });
  });

  it.each([undefined, null, false, 0, "1", 2])("rejects completeness marker %s", (marker) => {
    const components = { ...ledger(0), scoring_event_totals_complete: marker };
    expect(inspectDefenseScoringEventComponents({ components, finalScore: 0 })).toMatchObject({
      state: "unresolved",
      reason: "incomplete-scoring-events",
    });
  });

  it.each([undefined, null, false, "0", -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid or missing counts even for excluded event categories: %s",
    (value) => {
      const components = { ...ledger(0), scoring_event_defensive_fumble_touchdown: value };
      expect(inspectDefenseScoringEventComponents({ components, finalScore: 0 })).toMatchObject({
        state: "unresolved",
        reason: "invalid-scoring-event-count",
        component: "scoring_event_defensive_fumble_touchdown",
      });
    },
  );

  it("rejects absent and inherited event counts rather than inferring zeros", () => {
    const components = ledger(0);
    delete components.scoring_event_one_point_safety;
    for (const value of [
      components,
      Object.assign(Object.create({ scoring_event_one_point_safety: 0 }) as object, components),
    ])
      expect(
        inspectDefenseScoringEventComponents({
          components: value,
          finalScore: 0,
        }),
      ).toMatchObject({ state: "unresolved", component: "scoring_event_one_point_safety" });
  });

  it.each([
    {
      components: ledger(0, { scoring_event_field_goal: 1 }),
      finalScore: 0,
      reason: "scoring-points-total-mismatch",
    },
    {
      components: ledger(3, { scoring_event_field_goal: 1 }),
      finalScore: 6,
      reason: "final-score-mismatch",
    },
    {
      components: { ...ledger(0), scoring_points_total: "0" },
      finalScore: 0,
      reason: "invalid-scoring-points-total",
    },
    { components: ledger(0), finalScore: NaN, reason: "invalid-final-score" },
    { components: ledger(0), finalScore: -1, reason: "invalid-final-score" },
  ])("rejects unreconciled ledger: $reason", ({ components, finalScore, reason }) => {
    expect(inspectDefenseScoringEventComponents({ components, finalScore })).toMatchObject({
      state: "unresolved",
      reason,
    });
  });

  it("rejects count arithmetic exceeding exact integer precision", () => {
    expect(
      inspectDefenseScoringEventComponents({
        components: ledger(Number.MAX_SAFE_INTEGER, {
          scoring_event_offensive_pass_touchdown: Number.MAX_SAFE_INTEGER,
        }),
        finalScore: Number.MAX_SAFE_INTEGER,
      }),
    ).toMatchObject({ state: "unresolved", reason: "invalid-scoring-event-count" });
  });

  it("rejects an unrecognized future event category, even if its supplied count is zero", () => {
    expect(
      inspectDefenseScoringEventComponents({
        components: { ...ledger(0), scoring_event_unknown_score: 0 },
        finalScore: 0,
      }),
    ).toMatchObject({ state: "unresolved", reason: "unrecognized-scoring-event" });
  });

  it("passes ledger failures through the provider mapper with no numeric PA", () => {
    expect(
      defensePointsAllowedFromScoringEvents({
        definition: "espn-2019-v1",
        opponentComponents: { scoring_points_total: 0, scoring_event_totals_complete: 1 },
        opponentFinalScore: 0,
      }),
    ).toMatchObject({
      state: "unresolved",
      reason: "invalid-scoring-event-count",
      pointsAllowed: null,
    });
  });
});
