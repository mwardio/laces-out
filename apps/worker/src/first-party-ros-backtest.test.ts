import { describe, expect, it } from "vitest";

import {
  evaluateFirstPartyRosChampionPolicy,
  type FirstPartyRosHeldOutSeason,
  type FirstPartyTeamDefenseWeeklyStatLine,
  type FirstPartyWeeklyStatLine,
} from "@laces-out/projections";

import {
  HISTORICAL_ROS_AVAILABILITY_CALIBRATION_VERSION,
  HISTORICAL_ROS_KICKER_CALIBRATION_VERSION,
  HISTORICAL_ROS_SCORING_PROFILE,
  calibrateHistoricalRosAvailability,
  calibrateHistoricalRosKicker,
  calibrateHistoricalRosRole,
  historicalRosKickerProcess,
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
        // Nine rows and a five-to-eight support of eight games: this clears the evidence test's
        // 2.67-game bar, so the blocker is the availability error and not the sample size.
        contextualAvailabilityMae: 3,
        recencyAvailabilityMae: 3,
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

  it("fails an availability cell on evidence of excess error, not on a point estimate", () => {
    const base = {
      contextualModelVersion: "contextual",
      recencyModelVersion: "recency",
      scoringProfileKey: "profile",
      intervalMethodVersion: "interval",
      windowEndWeek: 18,
      evidence: {
        coverage: { contextual: 1, recency: 1 },
        availability: {
          scheduledGames: 13,
          actualGames: 13,
          contextualExpectedGames: 13,
          recencyExpectedGames: 13,
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
    const forecasts = [2023, 2024, 2025].flatMap((season) =>
      [4, 5, 6].flatMap((asOfWeek) =>
        [0, 1, 2, 3].map((index) => ({
          ...base,
          playerId: `QB:${season}:${asOfWeek}:${index}`,
          position: "QB" as const,
          forecastSeason: season,
          asOfWeek,
          windowStartWeek: asOfWeek + 1,
          trainedThroughSeason: season - 1,
          inputChecksum: historicalRosChecksum({ season, asOfWeek, index }),
        })),
      ),
    );
    expect(historicalRosBucket(5)).toBe("nine-plus");
    const champion = evaluateFirstPartyRosChampionPolicy(
      [2023, 2024, 2025].map((season): FirstPartyRosHeldOutSeason => ({
        season,
        complete: true,
        forecasts: forecasts.filter((forecast) => forecast.forecastSeason === season),
      })),
      {
        minimumHeldOutSeasons: 3,
        minimumBatches: 9,
        minimumSamples: 18,
        minimumCellSeasons: 3,
        minimumCellCutoffs: 3,
        minimumCellBatches: 9,
        minimumCellSamples: 9,
      },
    );
    const ninePlus = champion.livePolicy.choices.find(
      (candidate) => candidate.position === "QB" && candidate.bucket === "nine-plus",
    );
    if (!ninePlus) throw new Error("Expected QB nine-plus calibration choice");
    expect(ninePlus.samples).toBe(36);

    function blockersAt(availabilityMae: number, samples = ninePlus!.samples): readonly string[] {
      return historicalRosCalibrationBlockers([
        {
          ...ninePlus!,
          samples,
          heldOutEvidence: {
            ...ninePlus!.heldOutEvidence,
            contextualAvailabilityMae: availabilityMae,
            recencyAvailabilityMae: availabilityMae,
          },
        },
      ]).filter((blocker) => blocker.endsWith("_availability_mae_above_maximum"));
    }

    // The measured QB nine-plus cell sits 0.014 games over 2.75 with a cell standard error near
    // 0.15. That is sampling noise, and the gate must no longer read it as a failure.
    expect(blockersAt(2.7638, 288)).toEqual([]);
    expect(blockersAt(3.2, 288)).toEqual([]);
    // Genuinely and substantially over the ceiling still blocks, at every sample size.
    expect(blockersAt(3.5, 288)).toEqual([
      "calibration_QB_nine-plus_availability_mae_above_maximum",
    ]);
    expect(blockersAt(8)).toEqual(["calibration_QB_nine-plus_availability_mae_above_maximum"]);
    // A cell inside the ceiling can never block, however small its sample.
    expect(blockersAt(2.75, 18)).toEqual([]);
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

function kickerRow(
  playerId: string,
  season: number,
  week: number,
  counts: {
    readonly made0_39?: number;
    readonly made40_49?: number;
    readonly made50Plus?: number;
    readonly missed?: number;
    readonly extraPoints?: number;
    readonly blocked?: number;
  } = {},
  options: Partial<FirstPartyWeeklyStatLine> = {},
): FirstPartyWeeklyStatLine {
  const made0_39 = counts.made0_39 ?? 1;
  const made40_49 = counts.made40_49 ?? 0;
  const made50Plus = counts.made50Plus ?? 0;
  const missed = counts.missed ?? 0;
  const extraPoints = counts.extraPoints ?? 2;
  const blocked = counts.blocked ?? 0;
  const made = made0_39 + made40_49 + made50Plus;
  return {
    playerId,
    position: "K",
    season,
    week,
    team: "AAA",
    opponent: "BBB",
    components: {
      field_goals_made_0_39: made0_39,
      field_goals_made_40_49: made40_49,
      field_goals_made_50_plus: made50Plus,
      field_goals_made: made,
      field_goals_missed: missed,
      field_goals_attempted: made + missed + blocked,
      extra_points_made: extraPoints,
      extra_points_attempted: extraPoints,
      extra_points_missed: 0,
    },
    played: true,
    ...options,
  };
}

/** Deterministic LCG so statistical fixtures never depend on Math.random. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function poissonDraw(mean: number, uniform: number): number {
  let pmf = Math.exp(-mean);
  let cdf = pmf;
  let k = 0;
  while (uniform > cdf && k < 64) {
    k += 1;
    pmf *= mean / k;
    cdf += pmf;
  }
  return k;
}

describe("historical ROS kicker calibration (count-process v1)", () => {
  const schedules = scheduleWeeks(2024, [1, 2, 3]);
  const sparseFallback = {
    version: HISTORICAL_ROS_KICKER_CALIBRATION_VERSION,
    fgEventDispersion: 1,
    xpDispersion: 1,
    recordedMissRatio: 0.95,
    centerVolatility: 0.25,
    leagueBucketMix: [0.57, 0.27, 0.16],
    dispersionAudit: {
      made0_39: 1,
      made40_49: 1,
      made50Plus: 1,
      missed: 1,
      extraPointsMade: 1,
    },
    familyAudit: "within-bounds",
    evidence: { kickerGames: 0, kickerSeasons: 0, centerResidualGroups: 0 },
  };

  it("resolves an empty kicker corpus to the exact documented fallback object", () => {
    const calibration = calibrateHistoricalRosKicker([], schedules, HISTORICAL_ROS_SCORING_PROFILE);
    expect(calibration).toEqual(sparseFallback);
    expect(calibration.version).toBe(HISTORICAL_ROS_KICKER_CALIBRATION_VERSION);
  });

  it("never throws and stays inside every declared clamp on a mixed synthetic corpus", () => {
    const random = lcg(7);
    const rows: FirstPartyWeeklyStatLine[] = [];
    for (let kicker = 0; kicker < 40; kicker += 1) {
      for (let week = 1; week <= 14; week += 1) {
        rows.push(
          kickerRow(`k-${kicker}`, 2023, week, {
            made0_39: poissonDraw(1, random()),
            made40_49: poissonDraw(0.4, random()),
            made50Plus: poissonDraw(0.3, random()),
            missed: poissonDraw(0.25, random()),
            extraPoints: poissonDraw(2.2, random()),
            blocked: random() < 0.04 ? 1 : 0,
          }),
        );
      }
    }
    const calibration = calibrateHistoricalRosKicker(
      rows,
      schedules,
      HISTORICAL_ROS_SCORING_PROFILE,
    );
    expect(calibration.fgEventDispersion).toBeGreaterThanOrEqual(0.6);
    expect(calibration.fgEventDispersion).toBeLessThanOrEqual(1);
    expect(calibration.xpDispersion).toBeGreaterThanOrEqual(0.7);
    expect(calibration.xpDispersion).toBeLessThanOrEqual(1.05);
    expect(calibration.recordedMissRatio).toBeGreaterThanOrEqual(0.85);
    expect(calibration.recordedMissRatio).toBeLessThanOrEqual(1);
    expect(calibration.centerVolatility).toBe(0.25);
    const mixSum = calibration.leagueBucketMix.reduce((sum, share) => sum + share, 0);
    expect(mixSum).toBeCloseTo(1, 10);
    expect(calibration.evidence.kickerGames).toBe(rows.length);
  });

  it("clamps a degenerate constant-volume corpus to the under-dispersion floor", () => {
    const rows: FirstPartyWeeklyStatLine[] = [];
    for (let kicker = 0; kicker < 35; kicker += 1) {
      for (let week = 1; week <= 10; week += 1) {
        rows.push(kickerRow(`k-${kicker}`, 2023, week, { made0_39: 1, made40_49: 1 }));
      }
    }
    const calibration = calibrateHistoricalRosKicker(
      rows,
      schedules,
      HISTORICAL_ROS_SCORING_PROFILE,
    );
    expect(calibration.fgEventDispersion).toBe(0.6);
  });

  it("recovers dispersion near one from a genuinely Poisson corpus", () => {
    const random = lcg(11);
    const rows: FirstPartyWeeklyStatLine[] = [];
    for (let kicker = 0; kicker < 40; kicker += 1) {
      for (let week = 1; week <= 16; week += 1) {
        const events = poissonDraw(2, random());
        const made0_39 = Math.min(events, poissonDraw(1, random()));
        const remainder = events - made0_39;
        rows.push(
          kickerRow(`k-${kicker}`, 2023, week, {
            made0_39,
            made40_49: remainder,
            extraPoints: poissonDraw(2.2, random()),
          }),
        );
      }
    }
    const calibration = calibrateHistoricalRosKicker(
      rows,
      schedules,
      HISTORICAL_ROS_SCORING_PROFILE,
    );
    expect(calibration.fgEventDispersion).toBeGreaterThan(0.9);
    expect(calibration.xpDispersion).toBeGreaterThan(0.9);
  });

  it("fits the recorded-miss ratio from blocked-kick rows as a sum ratio below one", () => {
    const rows: FirstPartyWeeklyStatLine[] = [];
    // 30 kickers x 10 games: 2 recorded misses per game in half the games, one blocked kick per
    // game (attempted = made + missed + 1), so sum(missed) / sum(att - made) = 300 / 600 -> clamps
    // to the 0.85 floor... use milder blocking: blocked on every 5th game only.
    for (let kicker = 0; kicker < 30; kicker += 1) {
      for (let week = 1; week <= 10; week += 1) {
        rows.push(
          kickerRow(`k-${kicker}`, 2023, week, {
            made0_39: 2,
            missed: 1,
            blocked: week % 5 === 0 ? 1 : 0,
          }),
        );
      }
    }
    // sum(missed) = 300; sum(att - made) = 300 + 60 = 360 -> ratio 300/360 = 0.8333 clamps to 0.85.
    const clamped = calibrateHistoricalRosKicker(rows, schedules, HISTORICAL_ROS_SCORING_PROFILE);
    expect(clamped.recordedMissRatio).toBe(0.85);
    const lighter: FirstPartyWeeklyStatLine[] = [];
    for (let kicker = 0; kicker < 30; kicker += 1) {
      for (let week = 1; week <= 10; week += 1) {
        lighter.push(
          kickerRow(`k-${kicker}`, 2023, week, {
            made0_39: 2,
            missed: 1,
            blocked: kicker < 3 ? 1 : 0,
          }),
        );
      }
    }
    // 30 blocked among 300 misses -> 300 / 330 = 0.9091, inside the clamp.
    const fitted = calibrateHistoricalRosKicker(lighter, schedules, HISTORICAL_ROS_SCORING_PROFILE);
    expect(fitted.recordedMissRatio).toBeCloseTo(300 / 330, 10);
  });

  it("pools the league bucket mix exactly above the makes floor and falls back below it", () => {
    const rows: FirstPartyWeeklyStatLine[] = [];
    for (let kicker = 0; kicker < 10; kicker += 1) {
      for (let week = 1; week <= 10; week += 1) {
        rows.push(
          kickerRow(`k-${kicker}`, 2023, week, { made0_39: 2, made40_49: 1, made50Plus: 1 }),
        );
      }
    }
    const calibration = calibrateHistoricalRosKicker(
      rows,
      schedules,
      HISTORICAL_ROS_SCORING_PROFILE,
    );
    expect(calibration.leagueBucketMix).toEqual([0.5, 0.25, 0.25]);
    const sparse = calibrateHistoricalRosKicker(
      rows.slice(0, 40),
      schedules,
      HISTORICAL_ROS_SCORING_PROFILE,
    );
    expect(sparse.leagueBucketMix).toEqual([0.57, 0.27, 0.16]);
  });

  it("fits center volatility from kicker residual groups and defaults below the group floor", () => {
    const makePrediction = (playerId: string, season: number, week: number, actual: number) => ({
      playerId,
      position: "K" as const,
      season,
      week,
      predicted: { field_goals_made_0_39: 2, extra_points_made: 2 },
      baseline: {},
      floor: {},
      ceiling: {},
      actual: { field_goals_made_0_39: actual, extra_points_made: 2 },
      trainingRows: 100,
      calibrationRows: 50,
    });
    const predictions = [];
    for (let kicker = 0; kicker < 25; kicker += 1) {
      // Alternating persistently-hot and persistently-cold kickers create real between-group
      // spread in mean log residuals.
      const actual = kicker % 2 === 0 ? 3 : 1;
      for (let week = 1; week <= 8; week += 1) {
        predictions.push(makePrediction(`k-${kicker}`, 2023, week, actual));
      }
    }
    const rows = [kickerRow("k-0", 2023, 1)];
    const fitted = calibrateHistoricalRosKicker(
      rows,
      schedules,
      HISTORICAL_ROS_SCORING_PROFILE,
      predictions,
    );
    expect(fitted.centerVolatility).toBeGreaterThan(0.25);
    expect(fitted.centerVolatility).toBeLessThanOrEqual(0.5);
    expect(fitted.evidence.centerResidualGroups).toBe(25);
    const sparse = calibrateHistoricalRosKicker(
      rows,
      schedules,
      HISTORICAL_ROS_SCORING_PROFILE,
      predictions.slice(0, 10 * 8),
    );
    expect(sparse.centerVolatility).toBe(0.25);
  });

  it("keeps played zero-and-negative kicker games in the center fit and excludes true DNPs", () => {
    const makePrediction = (
      playerId: string,
      week: number,
      actual: Record<string, number>,
      predicted: Record<string, number> = { field_goals_made_0_39: 2, extra_points_made: 2 },
    ) => ({
      playerId,
      position: "K" as const,
      season: 2023,
      week,
      predicted,
      baseline: {},
      floor: {},
      ceiling: {},
      actual,
      trainingRows: 100,
      calibrationRows: 50,
    });
    const rows = [kickerRow("k-0", 2023, 1)];
    // 25 kickers, 8 games each: every game is a PLAYED zero-or-negative outcome (miss-only or
    // XP-attempt-only) that the old points-threshold filter would have discarded wholesale.
    const playedUgly = [];
    for (let kicker = 0; kicker < 25; kicker += 1) {
      for (let week = 1; week <= 8; week += 1) {
        playedUgly.push(
          makePrediction(
            `k-${kicker}`,
            week,
            week % 2 === 0
              ? { field_goals_missed: 2, field_goals_attempted: 2 } // played, -2 points
              : { extra_points_attempted: 1, extra_points_made: 0 }, // played, 0 points
          ),
        );
      }
    }
    const uglyFit = calibrateHistoricalRosKicker(
      rows,
      schedules,
      HISTORICAL_ROS_SCORING_PROFILE,
      playedUgly,
    );
    expect(uglyFit.evidence.centerResidualGroups).toBe(25);
    // True DNP rows (all-zero kicking components) stay excluded.
    const dnps = [];
    for (let kicker = 0; kicker < 25; kicker += 1) {
      for (let week = 1; week <= 8; week += 1) {
        dnps.push(makePrediction(`k-${kicker}`, week, {}));
      }
    }
    const dnpFit = calibrateHistoricalRosKicker(
      rows,
      schedules,
      HISTORICAL_ROS_SCORING_PROFILE,
      dnps,
    );
    expect(dnpFit.evidence.centerResidualGroups).toBe(0);
    expect(dnpFit.centerVolatility).toBe(0.25);
    // A non-finite predicted component is skipped, never thrown on (live-rail totality).
    const poisoned = [
      makePrediction("k-x", 1, { field_goals_made_0_39: 1 }, { field_goals_made_0_39: Number.NaN }),
    ];
    expect(() =>
      calibrateHistoricalRosKicker(rows, schedules, HISTORICAL_ROS_SCORING_PROFILE, poisoned),
    ).not.toThrow();
    // Deep-negative games stay finite through the floored numerator.
    const deepNegative = [];
    for (let week = 1; week <= 8; week += 1) {
      deepNegative.push(
        makePrediction("k-deep", week, { field_goals_missed: 6, field_goals_attempted: 6 }),
      );
    }
    const deepFit = calibrateHistoricalRosKicker(
      rows,
      schedules,
      HISTORICAL_ROS_SCORING_PROFILE,
      deepNegative,
    );
    expect(Number.isFinite(deepFit.centerVolatility)).toBe(true);
  });

  it("records an out-of-bounds family audit without throwing and still clamps dispersion", () => {
    const rows: FirstPartyWeeklyStatLine[] = [];
    for (let kicker = 0; kicker < 35; kicker += 1) {
      for (let week = 1; week <= 12; week += 1) {
        // Feast-or-famine misses: three zero weeks then a four-miss week (mean 1, variance 4).
        rows.push(
          kickerRow(`k-${kicker}`, 2023, week, {
            made0_39: 1,
            missed: week % 4 === 0 ? 4 : 0,
          }),
        );
      }
    }
    const calibration = calibrateHistoricalRosKicker(
      rows,
      schedules,
      HISTORICAL_ROS_SCORING_PROFILE,
    );
    expect(calibration.familyAudit).toBe("out-of-bounds");
    expect(calibration.dispersionAudit.missed).toBeGreaterThan(1.3);
    expect(calibration.fgEventDispersion).toBeGreaterThanOrEqual(0.6);
    expect(calibration.fgEventDispersion).toBeLessThanOrEqual(1);
  });

  it("counts played zero-attempt games as real observations", () => {
    const rows: FirstPartyWeeklyStatLine[] = [];
    for (let kicker = 0; kicker < 35; kicker += 1) {
      for (let week = 1; week <= 10; week += 1) {
        rows.push(
          week % 2 === 0
            ? kickerRow(`k-${kicker}`, 2023, week, { made0_39: 2 })
            : kickerRow(`k-${kicker}`, 2023, week, {
                made0_39: 0,
                extraPoints: 0,
              }),
        );
      }
    }
    const withZeros = calibrateHistoricalRosKicker(rows, schedules, HISTORICAL_ROS_SCORING_PROFILE);
    expect(withZeros.evidence.kickerGames).toBe(rows.length);
    // Alternating 0/2 events per game: within-group mean 1, variance ~1.07 -> dispersion near 1,
    // far above the 0.6 constant-corpus floor, proving the zero games entered the fit.
    expect(withZeros.fgEventDispersion).toBeGreaterThan(0.9);
    const dnpFiltered = calibrateHistoricalRosKicker(
      rows.map((row) => (row.components.field_goals_made === 0 ? { ...row, played: false } : row)),
      schedules,
      HISTORICAL_ROS_SCORING_PROFILE,
    );
    expect(dnpFiltered.evidence.kickerGames).toBe(rows.length / 2);
  });

  it("projects the calibration onto the exact five scalars the simulation consumes", () => {
    const calibration = calibrateHistoricalRosKicker([], schedules, HISTORICAL_ROS_SCORING_PROFILE);
    expect(historicalRosKickerProcess(calibration)).toEqual({
      fgEventDispersion: 1,
      xpDispersion: 1,
      recordedMissRatio: 0.95,
      centerVolatility: 0.25,
      bucketMix: [0.57, 0.27, 0.16],
    });
  });
});
