import { describe, expect, it } from "vitest";

import {
  FIRST_PARTY_PROJECTION_MODEL_VERSION,
  applyFirstPartyProjectionChampionPolicy,
  applyFirstPartyProjectionFinalPolicy,
  evaluateFirstPartyBacktestForScoringProfile,
  evaluateFirstPartyTeamDefenseBacktestForScoringProfile,
  firstPartyChampionStrategyForPosition,
  firstPartyProjectionComponentsForPosition,
  firstPartyProjectionPositionIsSupported,
  firstPartyTeamDefenseProjectionComponents,
  projectFirstPartyRecencyBaselineComponents,
  projectFirstPartyTeamDefenseComponents,
  projectFirstPartyTeamDefenseRecencyBaselineComponents,
  projectFirstPartyWeeklyComponents,
  runFirstPartyProjectionBacktest,
  runFirstPartyTeamDefenseBacktest,
  type FirstPartyProjectionCalibration,
  type FirstPartyProjectionPosition,
  type FirstPartyTeamDefenseWeeklyStatLine,
  type FirstPartyWeeklyStatLine,
} from "./first-party.js";

const statDefaults: Readonly<
  Record<FirstPartyProjectionPosition, Readonly<Record<string, number>>>
> = {
  QB: {
    passing_attempts: 34,
    passing_completions: 22,
    passing_yards: 245,
    passing_touchdowns: 1.6,
    passing_interceptions: 0.7,
    carries: 4,
    rushing_yards: 20,
    rushing_touchdowns: 0.2,
    fumbles_lost: 0.1,
  },
  RB: {
    carries: 13,
    rushing_yards: 58,
    rushing_touchdowns: 0.4,
    targets: 4,
    receptions: 3,
    receiving_yards: 24,
    receiving_touchdowns: 0.1,
    fumbles_lost: 0.08,
  },
  WR: {
    targets: 7,
    receptions: 4.5,
    receiving_yards: 61,
    receiving_touchdowns: 0.35,
    carries: 0.4,
    rushing_yards: 3,
    rushing_touchdowns: 0.02,
    fumbles_lost: 0.04,
  },
  TE: {
    targets: 5,
    receptions: 3.5,
    receiving_yards: 39,
    receiving_touchdowns: 0.28,
    carries: 0.05,
    rushing_yards: 0.2,
    rushing_touchdowns: 0,
    fumbles_lost: 0.02,
  },
  K: {
    field_goals_attempted: 2.2,
    field_goals_made: 1.85,
    field_goals_missed: 0.35,
    field_goals_made_0_19: 0.08,
    field_goals_made_20_29: 0.3,
    field_goals_made_30_39: 0.62,
    field_goals_made_40_49: 0.55,
    field_goals_made_50_59: 0.27,
    field_goals_made_60_plus: 0.03,
    extra_points_attempted: 2.7,
    extra_points_made: 2.55,
    extra_points_missed: 0.15,
  },
};

function line(
  playerId: string,
  position: FirstPartyProjectionPosition,
  week: number,
  options: Partial<Omit<FirstPartyWeeklyStatLine, "playerId" | "position" | "week">> = {},
): FirstPartyWeeklyStatLine {
  return {
    playerId,
    position,
    season: 2025,
    week,
    team: "AAA",
    opponent: week % 2 === 0 ? "BBB" : "CCC",
    components: statDefaults[position],
    snapShare: position === "QB" ? 1 : 0.68,
    targetShare: position === "WR" ? 0.22 : position === "TE" ? 0.16 : 0.1,
    carryShare: position === "RB" ? 0.48 : 0.03,
    passAttemptShare: position === "QB" ? 1 : 0,
    ...options,
  };
}

function historyForAllPositions(weeks = 8): FirstPartyWeeklyStatLine[] {
  const rows: FirstPartyWeeklyStatLine[] = [];
  for (let week = 1; week <= weeks; week += 1) {
    for (const position of ["QB", "RB", "WR", "TE", "K"] as const) {
      rows.push(line(`${position.toLowerCase()}-one`, position, week));
      rows.push(
        line(`${position.toLowerCase()}-two`, position, week, {
          team: "DDD",
          opponent: week % 2 === 0 ? "CCC" : "BBB",
          components: Object.fromEntries(
            Object.entries(statDefaults[position]).map(([key, value]) => [key, value * 0.72]),
          ),
        }),
      );
    }
  }
  return rows;
}

describe("first-party component projection", () => {
  it("is deterministic regardless of input ordering", () => {
    const history = historyForAllPositions();
    const input = {
      target: {
        playerId: "wr-one",
        position: "WR",
        season: 2025,
        week: 9,
        team: "AAA",
        opponent: "BBB",
      },
      history,
    } as const;

    const forward = projectFirstPartyWeeklyComponents(input);
    const reverse = projectFirstPartyWeeklyComponents({
      ...input,
      history: [...history].reverse(),
    });

    expect(reverse).toEqual(forward);
    expect(forward.provenance.modelVersion).toBe(FIRST_PARTY_PROJECTION_MODEL_VERSION);
    expect(forward.provenance.independenceKey).toBe("laces-out-first-party");
    expect(forward.provenance.trainingCutoff).toEqual({ season: 2025, week: 8 });
    expect(forward.provenance.latestInput).toEqual({ season: 2025, week: 8 });
  });

  it("cannot see same-week or future outcomes", () => {
    const prior = [line("wr-one", "WR", 1), line("wr-one", "WR", 2)];
    const sentinel = line("wr-one", "WR", 4, {
      components: { ...statDefaults.WR, receiving_yards: 9_999 },
    });
    const target = {
      playerId: "wr-one",
      position: "WR",
      season: 2025,
      week: 3,
      team: "AAA",
      opponent: "BBB",
    } as const;

    const withoutFuture = projectFirstPartyWeeklyComponents({ target, history: prior });
    const withFuture = projectFirstPartyWeeklyComponents({ target, history: [...prior, sentinel] });
    const withSameWeek = projectFirstPartyWeeklyComponents({
      target,
      history: [
        ...prior,
        line("other-wr", "WR", 3, {
          components: { ...statDefaults.WR, receiving_yards: 9_999 },
        }),
      ],
    });

    expect(withFuture).toEqual(withoutFuture);
    expect(withSameWeek).toEqual(withoutFuture);
    expect(withSameWeek.provenance.trainingCutoff).toEqual({ season: 2025, week: 2 });
  });

  it("emits exact kicker distance aggregates and player two-point aggregates", () => {
    const history = historyForAllPositions().map((row) =>
      row.position === "QB"
        ? {
            ...row,
            components: {
              ...row.components,
              passing_two_point_conversions: 0.1,
              rushing_two_point_conversions: 0.05,
              receiving_two_point_conversions: 0,
              punt_return_yards: 12,
              kickoff_return_yards: 28,
              special_teams_touchdowns: 0.1,
              fumble_recovery_touchdowns: 0.02,
            },
          }
        : row,
    );
    const kicker = projectFirstPartyWeeklyComponents({
      target: {
        playerId: "k-one",
        position: "K",
        season: 2025,
        week: 9,
        team: "AAA",
        opponent: "BBB",
      },
      history,
    });
    const quarterback = projectFirstPartyWeeklyComponents({
      target: {
        playerId: "qb-one",
        position: "QB",
        season: 2025,
        week: 9,
        team: "AAA",
        opponent: "BBB",
      },
      history,
    });

    expect(kicker.components.field_goals_made_0_39).toBeCloseTo(
      (kicker.components.field_goals_made_0_19 ?? 0) +
        (kicker.components.field_goals_made_20_29 ?? 0) +
        (kicker.components.field_goals_made_30_39 ?? 0),
      10,
    );
    expect(kicker.components.field_goals_made_50_plus).toBeCloseTo(
      (kicker.components.field_goals_made_50_59 ?? 0) +
        (kicker.components.field_goals_made_60_plus ?? 0),
      10,
    );
    expect(kicker.components.field_goals_missed).toBeCloseTo(
      (kicker.components.field_goals_attempted ?? 0) - (kicker.components.field_goals_made ?? 0),
      10,
    );
    expect(kicker.components.extra_points_missed).toBeCloseTo(
      (kicker.components.extra_points_attempted ?? 0) - (kicker.components.extra_points_made ?? 0),
      10,
    );
    expect(quarterback.components.two_point_conversions).toBeCloseTo(
      (quarterback.components.passing_two_point_conversions ?? 0) +
        (quarterback.components.rushing_two_point_conversions ?? 0) +
        (quarterback.components.receiving_two_point_conversions ?? 0),
      10,
    );
    expect(quarterback.components.return_yards).toBeCloseTo(
      (quarterback.components.punt_return_yards ?? 0) +
        (quarterback.components.kickoff_return_yards ?? 0),
      10,
    );
    expect(quarterback.components.return_touchdowns).toBeCloseTo(
      quarterback.components.special_teams_touchdowns ?? 0,
      10,
    );
    const backtest = runFirstPartyProjectionBacktest(history);
    const kickerActual = backtest.predictions.find(
      (row) => row.playerId === "k-one" && row.week === 2,
    )?.actual;
    const quarterbackActual = backtest.predictions.find(
      (row) => row.playerId === "qb-one" && row.week === 2,
    )?.actual;
    expect(kickerActual?.field_goals_made_0_39).toBeCloseTo(
      (kickerActual?.field_goals_made_0_19 ?? 0) +
        (kickerActual?.field_goals_made_20_29 ?? 0) +
        (kickerActual?.field_goals_made_30_39 ?? 0),
      10,
    );
    expect(kickerActual?.field_goals_made_50_plus).toBeCloseTo(
      (kickerActual?.field_goals_made_50_59 ?? 0) + (kickerActual?.field_goals_made_60_plus ?? 0),
      10,
    );
    expect(quarterbackActual?.two_point_conversions).toBeCloseTo(
      (quarterbackActual?.passing_two_point_conversions ?? 0) +
        (quarterbackActual?.rushing_two_point_conversions ?? 0) +
        (quarterbackActual?.receiving_two_point_conversions ?? 0),
      10,
    );
    expect(quarterbackActual?.return_yards).toBeCloseTo(
      (quarterbackActual?.punt_return_yards ?? 0) + (quarterbackActual?.kickoff_return_yards ?? 0),
      10,
    );
    expect(quarterbackActual?.return_touchdowns).toBeCloseTo(
      quarterbackActual?.special_teams_touchdowns ?? 0,
      10,
    );
  });

  it("uses a role-matched position prior for a rookie with no NFL games", () => {
    const history = historyForAllPositions();
    const projection = projectFirstPartyWeeklyComponents({
      target: {
        playerId: "rookie",
        position: "WR",
        season: 2025,
        week: 9,
        team: "AAA",
        opponent: "BBB",
        role: { snapShare: 0.78, targetShare: 0.24 },
      },
      history,
    });

    expect(projection.state).toBe("projected");
    expect(projection.components.receiving_yards).toBeGreaterThan(0);
    expect(projection.coverage.playerGames).toBe(0);
    expect(projection.coverage.positionGames).toBe(16);
    expect(projection.quality.flags).toContain("position_prior_only");
    expect(projection.quality.grade).toBe("low");
  });

  it("retains a traded player's history while applying the new team context", () => {
    const history = historyForAllPositions().map((row) =>
      row.playerId === "rb-one" ? { ...row, team: "OLD" } : row,
    );
    const target = {
      playerId: "rb-one",
      position: "RB",
      season: 2025,
      week: 9,
      team: "NEW",
      opponent: "BBB",
    } as const;
    const neutral = projectFirstPartyWeeklyComponents({ target, history });
    const fasterNewTeam = projectFirstPartyWeeklyComponents({
      target: { ...target, teamContext: { playVolumeMultiplier: 1.15, rushVolumeMultiplier: 1.1 } },
      history,
    });

    expect(neutral.coverage.playerGames).toBe(8);
    expect(fasterNewTeam.coverage.playerGames).toBe(8);
    expect(fasterNewTeam.components.carries).toBeGreaterThan(neutral.components.carries ?? 0);
  });

  it("does not publish a bye projection and returns hard zeroes for confirmed inactive players", () => {
    const history = historyForAllPositions();
    const shared = {
      playerId: "rb-one",
      position: "RB",
      season: 2025,
      week: 9,
      team: "AAA",
      opponent: "BBB",
    } as const;
    const bye = projectFirstPartyWeeklyComponents({
      target: { ...shared, isBye: true },
      history,
    });
    const inactive = projectFirstPartyWeeklyComponents({
      target: { ...shared, status: "out" },
      history,
    });
    const questionable = projectFirstPartyWeeklyComponents({
      target: { ...shared, status: "questionable" },
      history,
    });
    const active = projectFirstPartyWeeklyComponents({ target: shared, history });

    expect(bye.state).toBe("unavailable");
    expect(bye.quality.flags).toEqual(["no_scheduled_game"]);
    expect(Object.values(bye.components).every((value) => value === 0)).toBe(true);
    expect(inactive.state).toBe("zero");
    expect(Object.values(inactive.components).every((value) => value === 0)).toBe(true);
    expect(questionable.components.carries).toBeLessThan(active.components.carries ?? 0);
    expect(questionable.quality.flags).toContain("questionable_status_discount");
  });

  it("degrades visibly but remains defined when there are zero historical games", () => {
    const projection = projectFirstPartyWeeklyComponents({
      target: {
        playerId: "unknown",
        position: "TE",
        season: 2025,
        week: 1,
        team: "AAA",
        opponent: "BBB",
      },
      history: [],
    });

    expect(projection.state).toBe("projected");
    expect(projection.components).toEqual(
      Object.fromEntries(firstPartyProjectionComponentsForPosition("TE").map((key) => [key, 0])),
    );
    expect(projection.quality.grade).toBe("low");
    expect(projection.quality.degraded).toBe(true);
    expect(projection.quality.flags).toEqual(
      expect.arrayContaining(["position_prior_only", "thin_position_baseline"]),
    );
  });

  it("keeps all components finite, non-negative, plausible, and intervals ordered", () => {
    const history = [
      ...historyForAllPositions(),
      line("qb-one", "QB", 7, {
        components: {
          ...statDefaults.QB,
          passing_attempts: 10_000,
          passing_completions: 12_000,
          passing_yards: 20_000,
        },
      }),
    ];

    for (const position of ["QB", "RB", "WR", "TE", "K"] as const) {
      const projection = projectFirstPartyWeeklyComponents({
        target: {
          playerId: `${position.toLowerCase()}-one`,
          position,
          season: 2025,
          week: 9,
          team: "AAA",
          opponent: "BBB",
        },
        history,
      });
      for (const component of firstPartyProjectionComponentsForPosition(position)) {
        const floor = projection.floorComponents[component];
        const center = projection.components[component];
        const ceiling = projection.ceilingComponents[component];
        expect(floor).toBeTypeOf("number");
        expect(center).toBeTypeOf("number");
        expect(ceiling).toBeTypeOf("number");
        expect(Number.isFinite(floor)).toBe(true);
        expect(floor).toBeGreaterThanOrEqual(0);
        expect(center).toBeGreaterThanOrEqual(floor ?? 0);
        expect(ceiling).toBeGreaterThanOrEqual(center ?? 0);
      }
      if (position === "QB") {
        expect(projection.components.passing_completions).toBeLessThanOrEqual(
          projection.components.passing_attempts ?? 0,
        );
        expect(projection.components.passing_attempts).toBeLessThanOrEqual(70);
        expect(projection.components.passing_yards).toBeLessThanOrEqual(600);
      } else if (position !== "K") {
        expect(projection.components.receptions).toBeLessThanOrEqual(
          projection.components.targets ?? 0,
        );
      }
    }
  });

  it("uses sufficiently sampled residual calibration and reports its provenance", () => {
    const history = historyForAllPositions();
    const intervals = Object.fromEntries(
      firstPartyProjectionComponentsForPosition("WR").map((component) => [
        component,
        {
          samples: 30,
          lowerError: -2,
          upperError: 3,
          mae: 1.5,
          rmse: 2,
          fallback: false,
        },
      ]),
    );
    const calibration: FirstPartyProjectionCalibration = {
      modelVersion: FIRST_PARTY_PROJECTION_MODEL_VERSION,
      generatedThrough: { season: 2025, week: 8 },
      intervals: { WR: intervals },
    };
    const projection = projectFirstPartyWeeklyComponents({
      target: {
        playerId: "wr-one",
        position: "WR",
        season: 2025,
        week: 9,
        team: "AAA",
        opponent: "BBB",
      },
      history,
      calibration,
    });

    expect(projection.coverage.calibratedComponents).toBe(
      firstPartyProjectionComponentsForPosition("WR").length,
    );
    expect(projection.coverage.fallbackComponents).toBe(0);
    expect(projection.quality.flags).not.toContain("uncertainty_fallback");
    expect(projection.ceilingComponents.receiving_yards).toBeCloseTo(
      (projection.components.receiving_yards ?? 0) + 3,
    );
  });

  it("models kickers but explicitly excludes DST from the player projection path", () => {
    expect(firstPartyProjectionPositionIsSupported("QB")).toBe(true);
    expect(firstPartyProjectionPositionIsSupported("K")).toBe(true);
    expect(firstPartyProjectionPositionIsSupported("DST")).toBe(false);
    expect(firstPartyProjectionComponentsForPosition("K")).toContain("field_goals_made_50_59");

    const projection = projectFirstPartyWeeklyComponents({
      target: {
        playerId: "defense",
        position: "DST",
        season: 2025,
        week: 1,
        team: "AAA",
        opponent: "BBB",
      },
      history: [],
    });
    expect(projection.state).toBe("unavailable");
    expect(projection.quality.flags).toEqual(["unsupported_position"]);
    expect(projection.components).toEqual({});
  });
});

const defenseDefaults = {
  defensive_sacks: 2.6,
  defensive_interceptions: 0.85,
  defensive_fumble_recoveries: 0.65,
  defensive_safeties: 0.05,
  defensive_touchdowns: 0.18,
  defensive_blocked_kicks: 0.12,
  special_teams_touchdowns: 0.08,
  points_allowed: 22,
  yards_allowed: 338,
} as const;

function defenseLine(
  team: string,
  week: number,
  options: Partial<Omit<FirstPartyTeamDefenseWeeklyStatLine, "team" | "week">> = {},
): FirstPartyTeamDefenseWeeklyStatLine {
  return {
    team,
    season: 2025,
    week,
    opponent: team === "AAA" ? "BBB" : "AAA",
    components: defenseDefaults,
    ...options,
  };
}

describe("first-party team-defense projection", () => {
  it("uses a separate team-week path with complete raw DST components", () => {
    const history = Array.from({ length: 8 }, (_, index) => [
      defenseLine("AAA", index + 1),
      defenseLine("BBB", index + 1, {
        components: Object.fromEntries(
          Object.entries(defenseDefaults).map(([component, value]) => [component, value * 1.15]),
        ),
      }),
    ]).flat();
    const target = {
      team: "AAA",
      season: 2025,
      week: 9,
      opponent: "BBB",
    } as const;
    const projection = projectFirstPartyTeamDefenseComponents({ target, history });
    const reversed = projectFirstPartyTeamDefenseComponents({
      target,
      history: [...history].reverse(),
    });

    expect(reversed).toEqual(projection);
    expect(projection.state).toBe("projected");
    expect(Object.keys(projection.components)).toEqual(firstPartyTeamDefenseProjectionComponents());
    expect(projection.coverage.teamGames).toBe(8);
    expect(projection.provenance.independenceKey).toBe("laces-out-first-party-defense");
    expect(projection.provenance.trainingCutoff).toEqual({ season: 2025, week: 8 });
    expect(projection.provenance.latestInput).toEqual({ season: 2025, week: 8 });
    const yahooPointBucketTotal = [
      "points_allowed_0_probability",
      "points_allowed_1_6_probability",
      "points_allowed_7_13_probability",
      "points_allowed_14_20_probability",
      "points_allowed_21_27_probability",
      "points_allowed_28_34_probability",
      "points_allowed_35_plus_probability",
    ].reduce((sum, component) => sum + (projection.components[component] ?? 0), 0);
    const espnPointBucketTotal = [
      "points_allowed_0_probability",
      "points_allowed_1_6_probability",
      "points_allowed_7_13_probability",
      "points_allowed_14_17_probability",
      "points_allowed_18_21_probability",
      "points_allowed_22_27_probability",
      "points_allowed_28_34_probability",
      "points_allowed_35_45_probability",
      "points_allowed_46_plus_probability",
    ].reduce((sum, component) => sum + (projection.components[component] ?? 0), 0);
    expect(yahooPointBucketTotal).toBeCloseTo(1, 10);
    expect(espnPointBucketTotal).toBeCloseTo(1, 10);
    expect(projection.components.points_allowed_21_27_probability).toBeGreaterThan(0);
    expect(projection.components.points_allowed_22_27_probability).toBeGreaterThan(0);
    for (const component of [
      "points_allowed_0_probability",
      "points_allowed_1_6_probability",
      "points_allowed_7_13_probability",
      "points_allowed_14_17_probability",
      "points_allowed_14_20_probability",
      "points_allowed_18_21_probability",
      "points_allowed_21_27_probability",
      "points_allowed_22_27_probability",
      "points_allowed_28_34_probability",
      "points_allowed_35_plus_probability",
      "points_allowed_35_45_probability",
      "points_allowed_46_plus_probability",
    ]) {
      expect(Number.isFinite(projection.components[component])).toBe(true);
      expect(projection.components[component]).toBeGreaterThanOrEqual(0);
      expect(projection.components[component]).toBeLessThanOrEqual(1);
    }
    for (const component of firstPartyTeamDefenseProjectionComponents()) {
      expect(projection.lowerComponents[component]).toBeLessThanOrEqual(
        projection.components[component] ?? 0,
      );
      expect(projection.upperComponents[component]).toBeGreaterThanOrEqual(
        projection.components[component] ?? 0,
      );
    }
  });

  it("does not leak future defense outcomes and suppresses bye weeks", () => {
    const prior = [defenseLine("AAA", 1), defenseLine("BBB", 1)];
    const target = { team: "AAA", season: 2025, week: 2, opponent: "BBB" } as const;
    const baseline = projectFirstPartyTeamDefenseComponents({ target, history: prior });
    const sentinel = projectFirstPartyTeamDefenseComponents({
      target,
      history: [
        ...prior,
        defenseLine("AAA", 3, {
          components: { ...defenseDefaults, defensive_sacks: 999 },
        }),
      ],
    });
    const bye = projectFirstPartyTeamDefenseComponents({
      target: { ...target, isBye: true },
      history: prior,
    });

    expect(sentinel).toEqual(baseline);
    expect(bye.state).toBe("unavailable");
    expect(Object.values(bye.components).every((value) => value === 0)).toBe(true);

    const recency = projectFirstPartyTeamDefenseRecencyBaselineComponents({
      target,
      history: prior,
    });
    const recencyWithFuture = projectFirstPartyTeamDefenseRecencyBaselineComponents({
      target,
      history: [
        ...prior,
        defenseLine("AAA", 3, {
          components: { ...defenseDefaults, defensive_sacks: 999 },
        }),
      ],
    });
    const recencyBye = projectFirstPartyTeamDefenseRecencyBaselineComponents({
      target: { ...target, isBye: true },
      history: prior,
    });
    expect(recencyWithFuture).toEqual(recency);
    expect(Object.values(recencyBye).every((value) => value === 0)).toBe(true);
  });

  it("backtests team defenses with same-week-locked calibration and metrics", () => {
    const history = Array.from({ length: 8 }, (_, index) => [
      defenseLine("AAA", index + 1, {
        components: {
          ...defenseDefaults,
          defensive_sacks: 1 + (index % 4),
          points_allowed: 17 + index,
        },
      }),
      defenseLine("BBB", index + 1, {
        components: {
          ...defenseDefaults,
          defensive_sacks: 4 - (index % 4),
          points_allowed: 28 - index,
        },
      }),
    ]).flat();
    const changed = history.map((row) =>
      row.week === 8 && row.team === "BBB"
        ? { ...row, components: { ...row.components, defensive_sacks: 999 } }
        : row,
    );
    const backtest = runFirstPartyTeamDefenseBacktest(history, {
      minimumCalibrationSamples: 4,
    });
    const sentinel = runFirstPartyTeamDefenseBacktest(changed, {
      minimumCalibrationSamples: 4,
    });

    expect(
      sentinel.predictions
        .filter((prediction) => prediction.week === 8)
        .map((row) => row.predicted),
    ).toEqual(
      backtest.predictions
        .filter((prediction) => prediction.week === 8)
        .map((row) => row.predicted),
    );
    expect(backtest.predictions).toHaveLength(history.length);
    expect(backtest.calibration.intervals.defensive_sacks?.samples).toBe(history.length);
    expect(backtest.metrics.defensive_sacks?.samples).toBe(history.length);
    expect(backtest.overall.intervalCoverage).toBeGreaterThanOrEqual(0);
    expect(backtest.overall.intervalCoverage).toBeLessThanOrEqual(1);
    const scoring = evaluateFirstPartyTeamDefenseBacktestForScoringProfile(
      backtest,
      {
        id: "dst-test",
        rules: [
          { statId: "defensive_sacks", points: 1 },
          { statId: "defensive_interceptions", points: 2 },
          { statId: "defensive_fumble_recoveries", points: 2 },
          { statId: "defensive_safeties", points: 2 },
          { statId: "defensive_touchdowns", points: 6 },
          { statId: "special_teams_touchdowns", points: 6 },
          { statId: "defensive_blocked_kicks", points: 2 },
          { statId: "points_allowed_0_probability", points: 10 },
          { statId: "points_allowed_1_6_probability", points: 7 },
          { statId: "points_allowed_7_13_probability", points: 4 },
          { statId: "points_allowed_14_20_probability", points: 1 },
          { statId: "points_allowed_21_27_probability", points: 0 },
          { statId: "points_allowed_28_34_probability", points: -1 },
          { statId: "points_allowed_35_plus_probability", points: -4 },
        ],
      },
      { minimumIntervalSamples: 4, minimumPlayerSamples: 4 },
    );
    expect(scoring.byTeam.AAA?.samples).toBe(8);
    expect(scoring.overall.samples).toBe(history.length);
    expect(scoring.overall.baselineMae).toBeGreaterThanOrEqual(0);
  });
});

describe("first-party rolling backtest", () => {
  it("scores only the bounded recent window while retaining earlier training rows", () => {
    const history = Array.from({ length: 24 }, (_, index) => [
      line("wr-one", "WR", index + 1),
      line("wr-two", "WR", index + 1, { team: "DDD" }),
      line("wr-no-touch", "WR", index + 1, {
        team: "EEE",
        snapShare: 0,
        targetShare: 0,
        components: {
          ...statDefaults.WR,
          targets: 0,
          carries: 0,
        },
      }),
    ]).flat();
    const backtest = runFirstPartyProjectionBacktest(history, {
      backtestEvaluationWeeks: 3,
    });

    expect(backtest.evaluation).toMatchObject({
      policy: "recent-fantasy-relevant",
      maximumWeekBatches: 3,
      completedWeekBatches: 3,
      fantasyRelevantTargets: 6,
      firstEvaluated: { season: 2025, week: 22 },
      lastEvaluated: { season: 2025, week: 24 },
    });
    expect(backtest.predictions.every((row) => row.week >= 22)).toBe(true);
    expect(backtest.predictions.find((row) => row.week === 22)?.trainingRows).toBe(63);
    expect(backtest.predictions.some((row) => row.playerId === "wr-no-touch")).toBe(false);
  });

  it("uses only prior-week role context in the forecast under evaluation", () => {
    const stable = Array.from({ length: 5 }, (_, index) => [
      line("wr-one", "WR", index + 1, { targetShare: 0.1, snapShare: 0.4 }),
      line("wr-two", "WR", index + 1, {
        team: "DDD",
        targetShare: 0.2,
        snapShare: 0.7,
      }),
    ]).flat();
    const risingRole = stable.map((row) =>
      row.playerId === "wr-one" && row.week === 4
        ? { ...row, targetShare: 0.9, snapShare: 0.95 }
        : row,
    );
    const sameWeekSentinel = risingRole.map((row) =>
      row.playerId === "wr-one" && row.week === 5 ? { ...row, targetShare: 0, snapShare: 0 } : row,
    );
    const stableWeekFive = runFirstPartyProjectionBacktest(stable).predictions.find(
      (row) => row.playerId === "wr-one" && row.week === 5,
    );
    const risingWeekFive = runFirstPartyProjectionBacktest(risingRole).predictions.find(
      (row) => row.playerId === "wr-one" && row.week === 5,
    );
    const sentinelWeekFive = runFirstPartyProjectionBacktest(sameWeekSentinel).predictions.find(
      (row) => row.playerId === "wr-one" && row.week === 5,
    );

    expect(risingWeekFive?.predicted.receiving_yards).toBeGreaterThan(
      stableWeekFive?.predicted.receiving_yards ?? Number.POSITIVE_INFINITY,
    );
    expect(sentinelWeekFive?.predicted).toEqual(risingWeekFive?.predicted);
  });

  it("locks each week before observing any result from that week", () => {
    const baseline = historyForAllPositions(5);
    const altered = baseline.map((row) =>
      row.season === 2025 && row.week === 5 && row.playerId === "wr-two"
        ? {
            ...row,
            snapShare: 0.01,
            targetShare: 1,
            components: { ...row.components, receiving_yards: 9_999 },
          }
        : row,
    );

    const regular = runFirstPartyProjectionBacktest(baseline, {
      minimumCalibrationSamples: 2,
    });
    const sentinel = runFirstPartyProjectionBacktest(altered, {
      minimumCalibrationSamples: 2,
    });
    const regularWeekFive = regular.predictions.filter(
      (prediction) => prediction.season === 2025 && prediction.week === 5,
    );
    const sentinelWeekFive = sentinel.predictions.filter(
      (prediction) => prediction.season === 2025 && prediction.week === 5,
    );

    expect(sentinelWeekFive.map((prediction) => prediction.predicted)).toEqual(
      regularWeekFive.map((prediction) => prediction.predicted),
    );
    expect(sentinelWeekFive.map((prediction) => prediction.floor)).toEqual(
      regularWeekFive.map((prediction) => prediction.floor),
    );
  });

  it("returns deterministic calibration and finite accuracy/coverage metrics", () => {
    const history = historyForAllPositions(10).map((row, index) => ({
      ...row,
      components: Object.fromEntries(
        Object.entries(row.components).map(([component, value]) => [
          component,
          value * (0.82 + (index % 5) * 0.09),
        ]),
      ),
    }));

    const backtest = runFirstPartyProjectionBacktest(history, {
      minimumCalibrationSamples: 4,
    });
    const repeated = runFirstPartyProjectionBacktest([...history].reverse(), {
      minimumCalibrationSamples: 4,
    });

    expect(repeated).toEqual(backtest);
    expect(backtest.predictions).toHaveLength(history.length - 10);
    expect(backtest.modelVersion).toBe(FIRST_PARTY_PROJECTION_MODEL_VERSION);
    expect(backtest.calibration.generatedThrough).toEqual({ season: 2025, week: 10 });
    expect(backtest.calibration.intervals.QB?.passing_yards?.samples).toBe(18);
    expect(backtest.metrics.WR?.receiving_yards?.samples).toBe(18);
    expect(backtest.overall.samples).toBeGreaterThan(0);
    expect(Number.isFinite(backtest.overall.mae)).toBe(true);
    expect(Number.isFinite(backtest.overall.rmse)).toBe(true);
    expect(Number.isFinite(backtest.overall.bias)).toBe(true);
    expect(backtest.overall.intervalCoverage).toBeGreaterThanOrEqual(0);
    expect(backtest.overall.intervalCoverage).toBeLessThanOrEqual(1);

    const scoringEvaluation = evaluateFirstPartyBacktestForScoringProfile(
      backtest,
      {
        id: "test-ppr",
        rules: [
          { statId: "passing_yards", points: 0.04 },
          { statId: "passing_touchdowns", points: 4 },
          { statId: "passing_interceptions", points: -2 },
          { statId: "rushing_yards", points: 0.1 },
          { statId: "rushing_touchdowns", points: 6 },
          { statId: "receiving_yards", points: 0.1 },
          { statId: "receiving_touchdowns", points: 6 },
          { statId: "receptions", points: 1 },
          { statId: "field_goals_made", points: 3 },
          { statId: "extra_points_made", points: 1 },
        ],
      },
      { minimumIntervalSamples: 4, minimumPlayerSamples: 4 },
    );
    const repeatedEvaluation = evaluateFirstPartyBacktestForScoringProfile(
      repeated,
      {
        id: "same-rules-different-id",
        rules: [
          { statId: "passing_yards", points: 0.04 },
          { statId: "passing_touchdowns", points: 4 },
          { statId: "passing_interceptions", points: -2 },
          { statId: "rushing_yards", points: 0.1 },
          { statId: "rushing_touchdowns", points: 6 },
          { statId: "receiving_yards", points: 0.1 },
          { statId: "receiving_touchdowns", points: 6 },
          { statId: "receptions", points: 1 },
          { statId: "field_goals_made", points: 3 },
          { statId: "extra_points_made", points: 1 },
        ],
      },
      { minimumIntervalSamples: 4, minimumPlayerSamples: 4 },
    );

    expect(repeatedEvaluation).toEqual(scoringEvaluation);
    expect(scoringEvaluation.baseline).toBe("recency-only");
    expect(scoringEvaluation.byPosition.QB?.samples).toBe(18);
    expect(scoringEvaluation.byPosition.QB?.mae).toBeGreaterThanOrEqual(0);
    expect(scoringEvaluation.byPosition.QB?.baselineMae).toBeGreaterThanOrEqual(0);
    expect(scoringEvaluation.byPosition.QB?.lowerError).toBeLessThanOrEqual(
      scoringEvaluation.byPosition.QB?.upperError ?? 0,
    );
    expect(scoringEvaluation.byPosition.QB?.intervalCoverageSamples).toBeGreaterThan(0);
    expect(scoringEvaluation.byPlayer["qb-one"]?.samples).toBe(9);
    expect(scoringEvaluation.overall.samples).toBe(backtest.predictions.length);
  });

  it("learns fantasy-point center corrections only from completed prior week batches", () => {
    const source = runFirstPartyProjectionBacktest(
      Array.from({ length: 8 }, (_, index) => [
        line("wr-one", "WR", index + 1),
        line("wr-two", "WR", index + 1, { team: "DDD" }),
      ]).flat(),
    );
    const biased = {
      ...source,
      predictions: source.predictions.map((prediction) => ({
        ...prediction,
        predicted: {
          ...prediction.actual,
          receiving_yards: (prediction.actual.receiving_yards ?? 0) - 10,
        },
        baseline: {
          ...prediction.actual,
          receiving_yards: (prediction.actual.receiving_yards ?? 0) - 10,
        },
      })),
    };
    const evaluation = evaluateFirstPartyBacktestForScoringProfile(
      biased,
      { id: "receiving-only", rules: [{ statId: "receiving_yards", points: 0.1 }] },
      { minimumIntervalSamples: 2, minimumPlayerSamples: 2 },
    );

    expect(evaluation.byPosition.WR?.centerAdjustment).toBeCloseTo(1);
    expect(evaluation.byPosition.WR?.bias).toBeLessThan(0.2);
    expect(evaluation.byPosition.WR?.mae).toBeLessThan(0.2);
    expect(evaluation.byPosition.WR?.baselineMae).toBeLessThan(0.2);
  });

  it("records expanding training and calibration counts", () => {
    const backtest = runFirstPartyProjectionBacktest([
      line("wr-one", "WR", 1),
      line("wr-two", "WR", 1, { team: "DDD" }),
      line("wr-one", "WR", 2),
      line("wr-two", "WR", 2, { team: "DDD" }),
      line("wr-one", "WR", 3),
    ]);

    const firstWeek = backtest.predictions.filter((prediction) => prediction.week === 1);
    const secondWeek = backtest.predictions.filter((prediction) => prediction.week === 2);
    const thirdWeek = backtest.predictions.filter((prediction) => prediction.week === 3);
    expect(firstWeek).toHaveLength(0);
    expect(secondWeek.every((prediction) => prediction.trainingRows === 2)).toBe(true);
    expect(secondWeek.every((prediction) => prediction.calibrationRows === 0)).toBe(true);
    expect(thirdWeek.every((prediction) => prediction.trainingRows === 4)).toBe(true);
    expect(thirdWeek.every((prediction) => prediction.calibrationRows > 0)).toBe(true);
  });

  it("selects the evaluation cohort from strictly prior opportunity, never target-week usage", () => {
    const history = Array.from({ length: 5 }, (_, index) => {
      const week = index + 1;
      return [
        line("established", "WR", week, {
          snapShare: week === 5 ? 0 : 0.7,
          targetShare: week === 5 ? 0 : 0.2,
          components:
            week === 5
              ? { ...statDefaults.WR, targets: 0, carries: 0, receptions: 0, receiving_yards: 0 }
              : statDefaults.WR,
        }),
        line("surprise-breakout", "WR", week, {
          team: "DDD",
          snapShare: week === 5 ? 0.95 : 0,
          targetShare: week === 5 ? 0.4 : 0,
          components:
            week === 5
              ? { ...statDefaults.WR, targets: 12, receptions: 9, receiving_yards: 150 }
              : { ...statDefaults.WR, targets: 0, carries: 0, receptions: 0, receiving_yards: 0 },
        }),
      ];
    }).flat();

    const backtest = runFirstPartyProjectionBacktest(history);
    expect(
      backtest.predictions.some(
        (prediction) => prediction.playerId === "established" && prediction.week === 5,
      ),
    ).toBe(true);
    expect(
      backtest.predictions.some(
        (prediction) => prediction.playerId === "surprise-breakout" && prediction.week === 5,
      ),
    ).toBe(false);
  });

  it("scores DNP outcomes without leaking an undated final status or fitting the DNP as played", () => {
    const history = [
      line("established", "WR", 1),
      line("established", "WR", 2),
      line("established", "WR", 3, {
        played: false,
        snapShare: 0,
        targetShare: 0,
        components: Object.fromEntries(Object.keys(statDefaults.WR).map((key) => [key, 0])),
      }),
      line("established", "WR", 4),
      line("announced-inactive", "WR", 1, { team: "DDD" }),
      line("announced-inactive", "WR", 2, { team: "DDD" }),
      line("announced-inactive", "WR", 3, {
        team: "DDD",
        played: false,
        status: "inactive",
        snapShare: 0,
        targetShare: 0,
        components: Object.fromEntries(Object.keys(statDefaults.WR).map((key) => [key, 0])),
      }),
    ];

    const backtest = runFirstPartyProjectionBacktest(history);
    const dnp = backtest.predictions.find(
      (prediction) => prediction.playerId === "established" && prediction.week === 3,
    );
    const returnGame = backtest.predictions.find(
      (prediction) => prediction.playerId === "established" && prediction.week === 4,
    );
    const announcedInactive = backtest.predictions.find(
      (prediction) => prediction.playerId === "announced-inactive" && prediction.week === 3,
    );

    expect(dnp?.actual.receiving_yards).toBe(0);
    expect(dnp?.predicted.receiving_yards).toBeGreaterThan(0);
    expect(announcedInactive?.predicted.receiving_yards).toBeGreaterThan(0);
    expect(announcedInactive?.baseline.receiving_yards).toBeGreaterThan(0);
    expect(returnGame?.trainingRows).toBe(4);
  });

  it("uses a whole-week, prior-only champion policy and defends the baseline until proven", () => {
    const source = runFirstPartyProjectionBacktest(
      Array.from({ length: 8 }, (_, index) => [
        line("wr-one", "WR", index + 1),
        line("wr-two", "WR", index + 1, { team: "DDD" }),
      ]).flat(),
    );
    const controlled = {
      ...source,
      predictions: source.predictions.map((prediction) => ({
        ...prediction,
        predicted: prediction.actual,
        baseline: {
          ...prediction.actual,
          receiving_yards: (prediction.actual.receiving_yards ?? 0) + 100,
        },
      })),
    };
    const profile = {
      id: "champion-test",
      version: "1",
      rules: [{ statId: "receiving_yards", points: 0.1 }],
    } as const;
    const result = applyFirstPartyProjectionChampionPolicy(controlled, profile, {
      minimumSamples: 1,
      minimumWeekBatches: 4,
    });

    expect(firstPartyChampionStrategyForPosition(result.policy, "WR")).toBe("first-party-model");
    expect(result.policy.byPosition.WR).toMatchObject({
      reason: "model-cleared-margin",
      completedWeekBatches: 7,
    });
    const weekFive = result.backtest.predictions.find(
      (prediction) => prediction.playerId === "wr-one" && prediction.week === 5,
    );
    const weekSix = result.backtest.predictions.find(
      (prediction) => prediction.playerId === "wr-one" && prediction.week === 6,
    );
    expect(weekFive?.predicted).toEqual(weekFive?.baseline);
    expect(weekSix?.predicted).toEqual(weekSix?.actual);
    const evaluation = evaluateFirstPartyBacktestForScoringProfile(result.backtest, profile);
    expect(evaluation.overall.mae).toBeLessThanOrEqual(evaluation.overall.baselineMae);
    const finalPolicyBacktest = applyFirstPartyProjectionFinalPolicy(controlled, result.policy);
    expect(
      finalPolicyBacktest.predictions.every(
        (prediction) => prediction.predicted === prediction.actual,
      ),
    ).toBe(true);
  });

  it("projects a status-safe recency champion with strictly prior provenance", () => {
    const history = Array.from({ length: 5 }, (_, index) => line("wr-one", "WR", index + 1));
    const active = projectFirstPartyRecencyBaselineComponents({
      target: {
        playerId: "wr-one",
        position: "WR",
        season: 2025,
        week: 6,
        team: "AAA",
        opponent: "BBB",
        status: "active",
      },
      history,
    });
    const questionable = projectFirstPartyRecencyBaselineComponents({
      target: {
        playerId: "wr-one",
        position: "WR",
        season: 2025,
        week: 6,
        team: "AAA",
        opponent: "BBB",
        status: "questionable",
      },
      history,
    });
    expect(active.provenance).toMatchObject({
      strategy: "recency-only",
      trainingCutoff: { season: 2025, week: 5 },
      latestInput: { season: 2025, week: 5 },
    });
    expect(questionable.components.receiving_yards).toBeLessThan(
      active.components.receiving_yards ?? 0,
    );
    expect(questionable.quality.flags).toContain("recency_only_champion");
    expect(questionable.floorComponents.receiving_yards).toBeLessThanOrEqual(
      questionable.components.receiving_yards ?? 0,
    );
    expect(questionable.ceilingComponents.receiving_yards).toBeGreaterThanOrEqual(
      questionable.components.receiving_yards ?? 0,
    );
  });

  it("rejects stale-version and same-week calibration artifacts", () => {
    const history = historyForAllPositions();
    const component = "receiving_yards";
    const interval = {
      samples: 100,
      lowerError: -0.01,
      upperError: 0.01,
      mae: 0.01,
      rmse: 0.01,
      fallback: false,
    } as const;
    const target = {
      playerId: "wr-one",
      position: "WR",
      season: 2025,
      week: 9,
      team: "AAA",
      opponent: "BBB",
    } as const;
    const wrongVersion = projectFirstPartyWeeklyComponents({
      target,
      history,
      calibration: {
        modelVersion: "different-model",
        generatedThrough: { season: 2025, week: 8 },
        intervals: { WR: { [component]: interval } },
      },
    });
    const sameWeek = projectFirstPartyWeeklyComponents({
      target,
      history,
      calibration: {
        modelVersion: FIRST_PARTY_PROJECTION_MODEL_VERSION,
        generatedThrough: { season: 2025, week: 9 },
        intervals: { WR: { [component]: interval } },
      },
    });

    expect(wrongVersion.quality.flags).toContain("uncertainty_fallback");
    expect(sameWeek.quality.flags).toContain("uncertainty_fallback");
    expect(wrongVersion.coverage.calibratedComponents).toBe(0);
    expect(sameWeek.coverage.calibratedComponents).toBe(0);
  });
});
