import { describe, expect, it } from "vitest";

import {
  evaluateFirstPartyRosChampionPolicy,
  type FirstPartyRosHeldOutSeason,
  type FirstPartyTeamDefenseWeeklyStatLine,
  type FirstPartyWeeklyStatLine,
} from "@fantasy/projections";

import {
  HISTORICAL_ROS_AVAILABILITY_CALIBRATION_VERSION,
  HISTORICAL_ROS_SCORING_PROFILE,
  calibrateHistoricalRosAvailability,
  calibrateHistoricalRosRole,
  canonicalHistoricalRosDefenseOutcomes,
  evaluateHistoricalRosCells,
  historicalRosActiveStreak,
  historicalRosAsOfAt,
  historicalRosAvailabilityFor,
  historicalRosBucket,
  historicalRosCalibrationBlockers,
  historicalRosChecksum,
  historicalRosComponentElasticities,
  historicalRosDefenseFeatureRows,
  historicalRosDefenseTrainingRows,
  historicalRosFeatureRows,
  historicalRosStreakBucket,
  historicalRosTrainingRows,
  selectHistoricalRosPlayers,
  selectHistoricalRosDefenses,
  type HistoricalRosAvailabilityCalibration,
} from "./first-party-ros-backtest.js";
import type { ProjectionScheduleFact } from "./first-party-projection-inputs.js";

function row(
  playerId: string,
  season: number,
  week: number,
  receivingYards: number,
  options: Partial<FirstPartyWeeklyStatLine> = {},
): FirstPartyWeeklyStatLine {
  return {
    playerId,
    position: "WR",
    season,
    week,
    team: "AAA",
    opponent: "BBB",
    components: { receiving_yards: receivingYards, receptions: 4 },
    played: true,
    snapShare: 0.8,
    ...options,
  };
}

/** A scheduled game for `team` (vs. `opponent`) in the given season/week. */
function scheduledGame(
  season: number,
  week: number,
  team: string,
  opponent = "BBB",
): ProjectionScheduleFact {
  return {
    season,
    week,
    gameId: `${season}-${week}-${team}-${opponent}`,
    awayTeam: team,
    homeTeam: opponent,
    awayScore: 20,
    homeScore: 17,
    kickoffAt: new Date(Date.UTC(season, 8, 1 + week * 7)),
  };
}

/** Schedules `team` for every week in `weeks` (used to build consecutive-opportunity chains). */
function scheduleWeeks(
  season: number,
  weeks: readonly number[],
  team = "AAA",
): readonly ProjectionScheduleFact[] {
  return weeks.map((week) => scheduledGame(season, week, team));
}

describe("historical ROS leakage boundaries", () => {
  it("trains a held-out season only on earlier seasons", () => {
    const history = [row("p", 2022, 18, 50), row("p", 2023, 1, 60), row("p", 2024, 1, 70)];
    expect(historicalRosTrainingRows(history, 2023)).toEqual([history[0]]);
  });

  it("allows observed current-season features but rejects every row after the cutoff", () => {
    const history = [
      row("p", 2022, 18, 50),
      row("p", 2023, 4, 60),
      row("p", 2023, 5, 999),
      row("p", 2024, 1, 999),
    ];
    expect(historicalRosFeatureRows(history, 2023, 4)).toEqual(history.slice(0, 2));
  });

  it("never lets a future roster transaction enter player selection", () => {
    const history = [row("known", 2023, 1, 80), row("future", 2023, 2, 500)];
    const selected = selectHistoricalRosPlayers({
      history: historicalRosFeatureRows(history, 2023, 1),
      rosters: [
        { playerId: "known", position: "WR", season: 2023, week: 1, team: "AAA" },
        { playerId: "future", position: "WR", season: 2023, week: 2, team: "AAA" },
      ],
      season: 2023,
      asOfWeek: 1,
      scoringProfile: HISTORICAL_ROS_SCORING_PROFILE,
      playersPerPosition: 2,
    });
    expect(selected.map((player) => player.playerId)).toEqual(["known"]);
  });

  it("samples high, middle, and lower positive-production tiers deterministically", () => {
    const history = [100, 80, 60, 40, 20].map((yards, index) => row(`p${index}`, 2023, 1, yards));
    const selected = selectHistoricalRosPlayers({
      history,
      rosters: history.map((candidate) => ({
        playerId: candidate.playerId,
        position: "WR",
        season: 2023,
        week: 1,
        team: "AAA",
      })),
      season: 2023,
      asOfWeek: 1,
      scoringProfile: HISTORICAL_ROS_SCORING_PROFILE,
      playersPerPosition: 3,
    });
    expect(selected.map(({ playerId, selectionTier }) => ({ playerId, selectionTier }))).toEqual([
      { playerId: "p0", selectionTier: "high" },
      { playerId: "p2", selectionTier: "middle" },
      { playerId: "p4", selectionTier: "lower" },
    ]);
  });

  it("keeps D/ST training, features, and selection strictly chronological", () => {
    const defense = (
      team: string,
      season: number,
      week: number,
      points: number,
    ): FirstPartyTeamDefenseWeeklyStatLine => ({
      team,
      season,
      week,
      components: { defensive_sacks: points },
      played: true,
    });
    const history = [
      defense("AAA", 2022, 18, 2),
      defense("AAA", 2023, 1, 3),
      defense("FUT", 2023, 2, 99),
      defense("FUT", 2024, 1, 99),
    ];
    expect(historicalRosDefenseTrainingRows(history, 2023)).toEqual([history[0]]);
    const features = historicalRosDefenseFeatureRows(history, 2023, 1);
    expect(features).toEqual(history.slice(0, 2));
    expect(
      selectHistoricalRosDefenses({
        history: features,
        season: 2023,
        asOfWeek: 1,
        scoringProfile: HISTORICAL_ROS_SCORING_PROFILE,
        teams: 3,
      }).map((candidate) => candidate.team),
    ).toEqual(["AAA"]);
  });
});

describe("historical ROS availability calibration (curve-matched v3)", () => {
  function alwaysAvailableTraining(
    season: number,
    weeks: readonly number[],
    players = 10,
  ): readonly FirstPartyWeeklyStatLine[] {
    return Array.from({ length: players }, (_, playerIndex) =>
      weeks.map((weekNumber) => row(`always-${playerIndex}`, season, weekNumber, 50)),
    ).flat();
  }

  it("returns the v3 version and five well-formed calibration maps", () => {
    const weeks = Array.from({ length: 10 }, (_, index) => index + 1);
    const schedules = scheduleWeeks(2022, weeks);
    const training = alwaysAvailableTraining(2022, weeks);
    const calibration = calibrateHistoricalRosAvailability(
      training,
      schedules,
      HISTORICAL_ROS_SCORING_PROFILE,
    );

    expect(calibration.version).toBe(HISTORICAL_ROS_AVAILABILITY_CALIBRATION_VERSION);
    expect(calibration.global.newAbsenceProbability).toBeGreaterThan(0);
    expect(calibration.global.recoveryProbability).toBeGreaterThan(0);
    expect(calibration.global.reserveRecoveryProbability).toBeGreaterThan(0);
    expect(Object.keys(calibration.newAbsenceByPositionStreak).length).toBeGreaterThan(0);
    expect(Object.keys(calibration.recoveryByPositionStreak).length).toBeGreaterThan(0);
    expect(Object.keys(calibration.absentRecoveryByPosition).length).toBeGreaterThan(0);
    expect(Object.keys(calibration.asymptoteByPositionStreak).length).toBeGreaterThan(0);

    for (const value of Object.values(calibration.newAbsenceByPositionStreak)) {
      expect(value).toBeGreaterThanOrEqual(0.005);
      expect(value).toBeLessThanOrEqual(0.3);
    }
    for (const value of Object.values(calibration.recoveryByPositionStreak)) {
      expect(value).toBeGreaterThanOrEqual(0.04);
      expect(value).toBeLessThanOrEqual(0.891);
    }
    for (const value of Object.values(calibration.absentRecoveryByPosition)) {
      expect(value).toBeGreaterThanOrEqual(0.04);
      expect(value).toBeLessThanOrEqual(0.9);
    }
    for (const value of Object.values(calibration.asymptoteByPositionStreak)) {
      expect(value).toBeGreaterThan(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it("fits an established-bucket absence hazard near the grid floor and an asymptote near one for a population that always plays", () => {
    const weeks = Array.from({ length: 12 }, (_, index) => index + 1);
    const schedules = scheduleWeeks(2022, weeks);
    const training = alwaysAvailableTraining(2022, weeks);
    const calibration = calibrateHistoricalRosAvailability(
      training,
      schedules,
      HISTORICAL_ROS_SCORING_PROFILE,
    );

    expect(calibration.newAbsenceByPositionStreak["WR:established"]).toBeLessThanOrEqual(0.01);
    expect(calibration.asymptoteByPositionStreak["WR:established"]).toBeGreaterThanOrEqual(0.95);
  });

  it("fits a substantially lower asymptote when a population stops appearing halfway through the season", () => {
    // Rows only exist for weeks 1-4 (streaks 1-4, i.e. the "settling" bucket), but the team is
    // scheduled through week 12: every remaining scheduled week after a player's last row is an
    // observed non-appearance, which must pull the fitted long-run availability well below one.
    const rowWeeks = [1, 2, 3, 4];
    const scheduledWeeksList = Array.from({ length: 12 }, (_, index) => index + 1);
    const schedules = scheduleWeeks(2022, scheduledWeeksList);
    const training = Array.from({ length: 10 }, (_, playerIndex) =>
      rowWeeks.map((weekNumber) => row(`stops-${playerIndex}`, 2022, weekNumber, 50)),
    ).flat();
    const calibration = calibrateHistoricalRosAvailability(
      training,
      schedules,
      HISTORICAL_ROS_SCORING_PROFILE,
    );

    expect(calibration.asymptoteByPositionStreak["WR:settling"]).toBeLessThanOrEqual(0.7);
  });

  it("blends personal availability toward the stratum asymptote in the correct direction", () => {
    const calibration: HistoricalRosAvailabilityCalibration = {
      version: HISTORICAL_ROS_AVAILABILITY_CALIBRATION_VERSION,
      global: {
        newAbsenceProbability: 0.1,
        recoveryProbability: 0.4,
        reserveRecoveryProbability: 0.2,
        limitedRoleMultiplier: 0.85,
        returnRoleMultiplier: 0.75,
      },
      newAbsenceByPositionStreak: { "WR:established": 0.05 },
      recoveryByPositionStreak: { "WR:established": 0.6 },
      absentRecoveryByPosition: { WR: 0.5 },
      asymptoteByPositionStreak: { "WR:established": 0.6 / (0.6 + 0.05) },
    };

    const bare = historicalRosAvailabilityFor(calibration, "WR", 5);
    const omittedPersonal = historicalRosAvailabilityFor(calibration, "WR", 5, "active");
    const highPersonal = historicalRosAvailabilityFor(calibration, "WR", 5, "active", {
      rate: 1,
      trials: 60,
    });
    const lowPersonal = historicalRosAvailabilityFor(calibration, "WR", 5, "active", {
      rate: 0.2,
      trials: 60,
    });

    expect(bare.newAbsenceProbability).toBe(0.05);
    expect(omittedPersonal.newAbsenceProbability).toBe(bare.newAbsenceProbability);
    expect(highPersonal.newAbsenceProbability).toBeLessThan(bare.newAbsenceProbability);
    expect(lowPersonal.newAbsenceProbability).toBeGreaterThan(bare.newAbsenceProbability);
  });

  it("uses the joint recovery for active starts and the absent-at-cutoff recovery for inactive starts", () => {
    const calibration: HistoricalRosAvailabilityCalibration = {
      version: HISTORICAL_ROS_AVAILABILITY_CALIBRATION_VERSION,
      global: {
        newAbsenceProbability: 0.1,
        recoveryProbability: 0.4,
        reserveRecoveryProbability: 0.2,
        limitedRoleMultiplier: 0.85,
        returnRoleMultiplier: 0.75,
      },
      newAbsenceByPositionStreak: { "RB:settling": 0.07 },
      recoveryByPositionStreak: { "RB:settling": 0.55 },
      absentRecoveryByPosition: { RB: 0.3 },
      asymptoteByPositionStreak: { "RB:settling": 0.55 / (0.55 + 0.07) },
    };

    expect(historicalRosAvailabilityFor(calibration, "RB", 3, "active").recoveryProbability).toBe(
      0.55,
    );
    expect(historicalRosAvailabilityFor(calibration, "RB", 3, "inactive").recoveryProbability).toBe(
      0.3,
    );
  });
});

describe("historical ROS evidence helpers", () => {
  it("uses deterministic identities and deterministic historical as-of instants", () => {
    expect(historicalRosChecksum({ b: 2, a: 1 })).toBe(historicalRosChecksum({ a: 1, b: 2 }));
    expect(
      historicalRosAsOfAt(
        [
          {
            season: 2023,
            week: 1,
            gameId: "game",
            awayTeam: "AAA",
            homeTeam: "BBB",
            awayScore: 10,
            homeScore: 20,
            kickoffAt: new Date("2023-09-10T17:00:00.000Z"),
          },
        ],
        2023,
        1,
      ),
    ).toBe("2023-09-11T05:00:00.000Z");
  });

  it("keeps both supported points-allowed bucket families fixed under ROS shocks", () => {
    const components = {
      points_allowed_14_20_probability: 0.4,
      points_allowed_21_27_probability: 0.6,
      points_allowed_14_17_probability: 0.2,
      points_allowed_18_21_probability: 0.3,
      points_allowed_22_27_probability: 0.5,
      defensive_sacks: 2.5,
    };
    const elasticities = historicalRosComponentElasticities(components, components);
    for (const component of Object.keys(components).filter((key) => key.endsWith("_probability"))) {
      expect(elasticities[component]).toEqual({ role: 0, production: 0 });
    }
    expect(elasticities.defensive_sacks).toEqual({ role: 1, production: 1 });
  });

  it("materializes canonical D/ST points-allowed actuals for both scoring families", () => {
    const outcomes = canonicalHistoricalRosDefenseOutcomes([
      {
        team: "AAA",
        season: 2022,
        week: 1,
        components: { defensive_sacks: 2, points_allowed: 21 },
        played: true,
      },
    ]);
    expect(outcomes[0]?.components).toMatchObject({
      points_allowed_14_20_probability: 0,
      points_allowed_21_27_probability: 1,
      points_allowed_18_21_probability: 1,
      points_allowed_22_27_probability: 0,
    });
  });

  it("holds D/ST to the same season, cutoff, batch, and sample gates", () => {
    const base = {
      contextualModelVersion: "contextual",
      recencyModelVersion: "recency",
      scoringProfileKey: "profile",
      intervalMethodVersion: "interval",
      forecastSeason: 2023,
      asOfWeek: 10,
      windowStartWeek: 11,
      windowEndWeek: 18,
      trainedThroughSeason: 2022,
      inputChecksum: "a".repeat(64),
      evidence: {
        coverage: { contextual: 1, recency: 1 },
        availability: {
          scheduledGames: 8,
          actualGames: 8,
          contextualExpectedGames: 8,
          recencyExpectedGames: 8,
        },
        convergence: {
          contextual: { state: "converged" as const, diagnosticChecksum: "b".repeat(64) },
          recency: { state: "converged" as const, diagnosticChecksum: "c".repeat(64) },
        },
      },
      contextual: { meanPoints: 80, p15Points: 60, p50Points: 80, p85Points: 100 },
      recency: { meanPoints: 75, p15Points: 55, p50Points: 75, p85Points: 95 },
      actualPoints: 82,
    };
    const forecasts = (["WR", "DST"] as const).flatMap((position) =>
      [2023, 2024, 2025].flatMap((season) =>
        [10, 11, 12].map((asOfWeek) => ({
          ...base,
          playerId: `${position}:${season}:${asOfWeek}`,
          position,
          forecastSeason: season,
          asOfWeek,
          windowStartWeek: asOfWeek + 1,
          trainedThroughSeason: season - 1,
          inputChecksum: historicalRosChecksum({ position, season, asOfWeek }),
        })),
      ),
    );
    const cells = evaluateHistoricalRosCells({
      forecasts,
      minimumSamples: 9,
      minimumCutoffs: 3,
      minimumBatches: 9,
      minimumSeasons: 3,
    });
    expect(historicalRosBucket(11)).toBe("five-to-eight");
    expect(
      cells.find((cell) => cell.position === "WR" && cell.bucket === "five-to-eight"),
    ).toMatchObject({ ready: true, seasons: 3, cutoffs: 3, batches: 9, samples: 9 });
    expect(
      cells.find((cell) => cell.position === "DST" && cell.bucket === "five-to-eight"),
    ).toMatchObject({ ready: true, seasons: 3, cutoffs: 3, batches: 9, samples: 9 });
    const heldOut = [2023, 2024, 2025].map((season): FirstPartyRosHeldOutSeason => ({
      season,
      complete: true,
      forecasts: forecasts.filter((forecast) => forecast.forecastSeason === season),
    }));
    const champion = evaluateFirstPartyRosChampionPolicy(heldOut, {
      minimumHeldOutSeasons: 3,
      minimumBatches: 9,
      minimumSamples: 18,
      minimumCellSeasons: 3,
      minimumCellCutoffs: 3,
      minimumCellBatches: 9,
      minimumCellSamples: 9,
    });
    const choice = champion.livePolicy.choices.find(
      (candidate) => candidate.position === "WR" && candidate.bucket === "five-to-eight",
    );
    if (!choice) throw new Error("Expected WR calibration choice");
    expect(historicalRosCalibrationBlockers([choice])).toContain(
      "calibration_WR_five-to-eight_walk_forward_unavailable",
    );
    const degradedChoice = {
      ...choice,
      heldOutEvidence: {
        ...choice.heldOutEvidence,
        contextualMeanInputCoverage: 0.9,
        recencyMeanInputCoverage: 0.9,
        contextualAvailabilityMae: 2,
        recencyAvailabilityMae: 2,
        contextualConvergenceRate: 0.5,
        recencyConvergenceRate: 0.5,
      },
    };
    expect(historicalRosCalibrationBlockers([degradedChoice])).toEqual(
      expect.arrayContaining([
        "calibration_WR_five-to-eight_input_coverage_below_minimum",
        "calibration_WR_five-to-eight_availability_mae_above_maximum",
        "calibration_WR_five-to-eight_convergence_below_minimum",
      ]),
    );
  });

  it("buckets availability streaks into returning, settling, and established", () => {
    expect(historicalRosStreakBucket(0)).toBe("returning");
    expect(historicalRosStreakBucket(1)).toBe("returning");
    expect(historicalRosStreakBucket(2)).toBe("settling");
    expect(historicalRosStreakBucket(4)).toBe("settling");
    expect(historicalRosStreakBucket(5)).toBe("established");
    expect(historicalRosStreakBucket(10)).toBe("established");
    expect(() => historicalRosStreakBucket(-1)).toThrow(RangeError);
  });

  it("falls back to the global availability calibration for an unknown position", () => {
    const calibration: HistoricalRosAvailabilityCalibration = {
      version: HISTORICAL_ROS_AVAILABILITY_CALIBRATION_VERSION,
      global: {
        newAbsenceProbability: 0.1,
        recoveryProbability: 0.4,
        reserveRecoveryProbability: 0.2,
        limitedRoleMultiplier: 0.85,
        returnRoleMultiplier: 0.75,
      },
      newAbsenceByPositionStreak: { "WR:returning": 0.3 },
      recoveryByPositionStreak: { "WR:returning": 0.6 },
      absentRecoveryByPosition: { WR: 0.5 },
      asymptoteByPositionStreak: { "WR:returning": 0.6 / 0.9 },
    };

    expect(historicalRosAvailabilityFor(calibration, "QB", 0)).toEqual(calibration.global);
  });

  describe("historicalRosActiveStreak", () => {
    it("resets to zero after a DNP row", () => {
      const schedules = scheduleWeeks(2022, [1, 2, 3]);
      const history = [
        row("p", 2022, 1, 50),
        row("p", 2022, 2, 0, { played: false, status: "out", snapShare: 0 }),
      ];
      expect(historicalRosActiveStreak(history, "p", 2022, 2, schedules)).toBe(0);
    });

    it("counts consecutive played scheduled rows", () => {
      const schedules = scheduleWeeks(2022, [1, 2, 3]);
      const history = [
        row("p", 2022, 1, 50),
        row("p", 2022, 2, 0, { played: false, status: "out", snapShare: 0 }),
        row("p", 2022, 3, 40),
      ];
      expect(historicalRosActiveStreak(history, "p", 2022, 3, schedules)).toBe(1);
    });

    it("spans a bye week when the team has no scheduled game that week", () => {
      const schedules = scheduleWeeks(2022, [1, 3]);
      const history = [row("p", 2022, 1, 50), row("p", 2022, 3, 40)];
      expect(historicalRosActiveStreak(history, "p", 2022, 3, schedules)).toBe(2);
    });

    it("caps the streak at ten", () => {
      const weeks = Array.from({ length: 12 }, (_, index) => index + 1);
      const schedules = scheduleWeeks(2022, weeks);
      const history = weeks.map((weekNumber) => row("p", 2022, weekNumber, 50));
      expect(historicalRosActiveStreak(history, "p", 2022, 12, schedules)).toBe(10);
    });
  });

  it("calibrates per-position role inputs and falls back to defaults for sparse positions", () => {
    // 25 players x 6 consecutive scheduled weeks clears both the >=30 snap-change and >=20
    // player-season CV thresholds for WR; every other supported position has zero training rows
    // and must fall back to the documented defaults.
    const weeks = [1, 2, 3, 4, 5, 6];
    const yardsByWeek = [50, 70, 40, 80, 30, 60];
    const snapShareByWeek = [0.5, 0.6, 0.55, 0.65, 0.5, 0.6];
    const schedules = scheduleWeeks(2022, weeks);
    const training = Array.from({ length: 25 }, (_, playerIndex) =>
      weeks.map((weekNumber, weekIndex) =>
        row(`role-${playerIndex}`, 2022, weekNumber, yardsByWeek[weekIndex]!, {
          snapShare: snapShareByWeek[weekIndex]!,
        }),
      ),
    ).flat();

    const calibration = calibrateHistoricalRosRole(
      training,
      schedules,
      HISTORICAL_ROS_SCORING_PROFILE,
    );

    const expectedFallback = {
      currentMultiplier: 1,
      persistence: 0.82,
      innovationVolatility: 0.05,
      weeklyProductionVolatility: 0.5,
      centerVolatility: 0.25,
      minimumMultiplier: 0.2,
      maximumMultiplier: 3,
    };
    expect(calibration.fallback).toEqual(expectedFallback);
    // QB, RB, TE, and K never appear in the training rows, so they must use the sparse-data
    // defaults exactly.
    expect(calibration.byPosition.QB).toEqual(expectedFallback);
    expect(calibration.byPosition.RB).toEqual(expectedFallback);
    expect(calibration.byPosition.TE).toEqual(expectedFallback);
    expect(calibration.byPosition.K).toEqual(expectedFallback);
    // WR has plenty of data and must produce bounded, well-formed (though not necessarily
    // default) role inputs.
    const wr = calibration.byPosition.WR!;
    expect(wr.currentMultiplier).toBe(1);
    expect(wr.persistence).toBe(0.82);
    expect(wr.minimumMultiplier).toBe(0.2);
    expect(wr.maximumMultiplier).toBe(3);
    expect(wr.innovationVolatility).toBeGreaterThanOrEqual(0.05);
    expect(wr.innovationVolatility).toBeLessThanOrEqual(0.35);
    expect(wr.weeklyProductionVolatility).toBeGreaterThanOrEqual(0.1);
    expect(wr.weeklyProductionVolatility).toBeLessThanOrEqual(1.2);
  });
});
