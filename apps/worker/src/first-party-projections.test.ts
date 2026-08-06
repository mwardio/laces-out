import {
  applyFirstPartyProjectionChampionPolicy,
  applyFirstPartyProjectionFinalPolicy,
  evaluateFirstPartyBacktestForScoringProfile,
  FIRST_PARTY_PROJECTION_MODEL_VERSION,
} from "@laces-out/projections";
import type {
  FirstPartyBacktestPrediction,
  FirstPartyProjectionBacktest,
  FirstPartyScoredBacktestEvaluation,
  FirstPartyScoredTeamDefenseEvaluation,
  FirstPartyTeamDefenseBacktest,
  FirstPartyTeamDefenseBacktestPrediction,
} from "@laces-out/projections";
import { describe, expect, it } from "vitest";

import {
  buildFirstPartyLeaguePublications,
  canonicalProjectionPlayerId,
  firstPartyAvailableProjectionComponents,
  firstPartyDefensePlayerId,
  firstPartyStatusForKickoff,
  espnSelfAssertedProjectionLeague,
  leagueScoredInterval,
  leagueScoredMean,
  projectionGameIsConservativelyFinal,
  projectionHistorySeasons,
  projectionModelGate,
  projectionRawObservationIsUnlocked,
  projectionStatusWeek,
  projectionStatusWindow,
  projectionTrainingCacheKey,
  projectionTargetWeeks,
  projectionUnlockedRawRows,
  projectionWeekHasUnknownKickoff,
  rescoreFrozenProjection,
  requiredFirstPartyProjectionSourceKeys,
  sourceIsUsableForProjection,
} from "./first-party-projections.js";

function playerEvaluation(
  input: {
    readonly samples?: number;
    readonly mae?: number;
    readonly baselineMae?: number;
  } = {},
): FirstPartyScoredBacktestEvaluation {
  const overall = {
    samples: input.samples ?? 500,
    centerAdjustment: 0,
    lowerError: -3,
    upperError: 4,
    mae: input.mae ?? 5,
    rmse: 7,
    bias: 0,
    baselineMae: input.baselineMae ?? 5.2,
    improvement: 0.04,
    beatsBaseline: true,
    intervalCoverage: 0.7,
    intervalCoverageSamples: 400,
  } as const;
  return {
    modelVersion: "model",
    scoringProfileKey: "profile",
    baseline: "recency-only",
    byPosition: {
      QB: overall,
      RB: overall,
      WR: overall,
      TE: overall,
      K: overall,
    },
    byPlayer: {},
    overall,
  };
}

function defenseEvaluation(
  input: {
    readonly samples?: number;
    readonly mae?: number;
    readonly baselineMae?: number;
  } = {},
): FirstPartyScoredTeamDefenseEvaluation {
  return {
    modelVersion: "model",
    scoringProfileKey: "profile",
    baseline: "recency-only",
    byTeam: {},
    overall: {
      samples: input.samples ?? 250,
      centerAdjustment: 0,
      lowerError: -4,
      upperError: 5,
      mae: input.mae ?? 4,
      rmse: 6,
      bias: 0,
      baselineMae: input.baselineMae ?? 4.1,
      improvement: 0.02,
      beatsBaseline: true,
      intervalCoverage: 0.7,
      intervalCoverageSamples: 200,
    },
  };
}

describe("first-party projection publication policy", () => {
  it("rejects a retained artifact when its upstream dataset is no longer published", () => {
    const now = new Date("2026-09-10T12:00:00.000Z");
    const source = {
      key: "nflverse.schedules.2026",
      lastCheckedAt: new Date("2026-09-10T11:55:00.000Z"),
      lastSuccessfulAt: new Date("2026-09-10T11:55:00.000Z"),
      lastChecksum: "a".repeat(64),
      consecutiveFailures: 0,
      checkIntervalMinutes: 45,
      metadata: { publishable: true, availability: "available" },
    } as const;

    expect(sourceIsUsableForProjection(source, now)).toBe(true);
    expect(
      sourceIsUsableForProjection(
        { ...source, metadata: { ...source.metadata, availability: "not-published" } },
        now,
      ),
    ).toBe(false);
    expect(
      sourceIsUsableForProjection(
        { ...source, metadata: { ...source.metadata, availability: "pending" } },
        now,
      ),
    ).toBe(false);
    expect(
      sourceIsUsableForProjection(
        { ...source, metadata: { ...source.metadata, refreshClaimedAt: now.toISOString() } },
        now,
      ),
    ).toBe(false);
    expect(
      sourceIsUsableForProjection(
        { ...source, lastSuccessfulAt: new Date("2026-09-10T08:00:00.000Z") },
        now,
      ),
    ).toBe(false);
  });

  it("keeps an admitted completed-season artifact usable without a freshness clock", () => {
    const now = new Date("2026-09-10T12:00:00.000Z");
    const source = {
      key: "nflverse.stats-player-week.2025",
      lastCheckedAt: new Date("2026-03-01T00:00:00.000Z"),
      lastSuccessfulAt: new Date("2026-03-01T00:00:00.000Z"),
      lastChecksum: "a".repeat(64),
      consecutiveFailures: 2,
      checkIntervalMinutes: 1440,
      metadata: {
        season: 2025,
        publishable: true,
        availability: "available",
        refreshClaimedAt: now.toISOString(),
      },
    } as const;

    expect(sourceIsUsableForProjection(source, now, 2026)).toBe(true);
    expect(
      sourceIsUsableForProjection(
        {
          ...source,
          key: "nflverse.stats-player-week.2026",
          metadata: { ...source.metadata, season: 2026 },
        },
        now,
        2026,
      ),
    ).toBe(false);
  });

  it("locks training to four seasons and requires complete historical source rails", () => {
    expect(projectionHistorySeasons(2026)).toEqual([2023, 2024, 2025, 2026]);
    const keys = requiredFirstPartyProjectionSourceKeys(2026);
    expect(keys.required).toContain("nflverse.players");
    expect(keys.required).toContain("sleeper.players");
    expect(keys.required).toContain("nflverse.schedules.2023");
    expect(keys.required).toContain("nflverse.schedules.2026");
    expect(keys.required).toContain("nflverse.stats-player-week.2025");
    expect(keys.required).toContain("nflverse.snap-counts.2025");
    expect(keys.required).toContain("nflverse.weekly-rosters.2025");
    expect(keys.required).toContain("nflverse.injuries.2025");
    expect(keys.required).not.toContain("nflverse.stats-player-week.2026");
    expect(keys.optional).toContain("nflverse.stats-player-week.2026");
    expect(keys.optional).not.toContain("nflverse.snap-counts.2023");
    expect(keys.optional).toContain("nflverse.snap-counts.2026");
    expect(keys.optional).toContain("nflverse.weekly-rosters.2026");
    expect(keys.optional).toContain("nflverse.injuries.2026");
  });

  it("keeps partially played weeks actionable while excluding completed weeks", () => {
    const schedule = [
      { season: 2026, week: 1, awayScore: 17, homeScore: 20 },
      { season: 2026, week: 2, awayScore: 17, homeScore: 20 },
      { season: 2026, week: 2, awayScore: null, homeScore: null },
      { season: 2026, week: 3, awayScore: null, homeScore: null },
      { season: 2026, week: 4, awayScore: null, homeScore: null },
      { season: 2025, week: 1, awayScore: null, homeScore: null },
    ];
    expect(projectionTargetWeeks(schedule, 2026)).toEqual([2, 3]);
    expect(projectionStatusWeek(schedule, 2026)).toBe(2);
    expect(() => projectionTargetWeeks(schedule, 2026, 1)).toThrow(/already finished/u);
    expect(projectionTargetWeeks(schedule, 2026, 3)).toEqual([3]);
    expect(projectionTargetWeeks(schedule, 2026, 4)).toEqual([4]);
  });

  it("never trusts a score-derived final until a conservative post-kickoff floor elapses", () => {
    const kickoffAt = new Date("2026-09-13T17:00:00.000Z");

    // The nflverse feed only distinguishes scheduled/final by score presence; an explicit
    // in-progress status must never satisfy the final check even with scores already present.
    expect(
      projectionGameIsConservativelyFinal(
        { awayScore: 17, homeScore: 20, kickoffAt, status: "in-progress" },
        new Date("2026-09-13T21:00:00.000Z"),
      ),
    ).toBe(false);

    // Authoritative final status, scores present, and enough elapsed time since kickoff.
    expect(
      projectionGameIsConservativelyFinal(
        { awayScore: 17, homeScore: 20, kickoffAt, status: "final" },
        new Date("2026-09-13T21:00:00.000Z"),
      ),
    ).toBe(true);

    // Final status and scores present, but kickoff was too recent to trust a live-feed score.
    expect(
      projectionGameIsConservativelyFinal(
        { awayScore: 17, homeScore: 20, kickoffAt, status: "final" },
        new Date("2026-09-13T20:59:00.000Z"),
      ),
    ).toBe(false);

    // An unknown kickoff falls back to the score-presence signal alone.
    expect(
      projectionGameIsConservativelyFinal(
        { awayScore: 17, homeScore: 20, kickoffAt: null, status: "final" },
        new Date("2026-09-13T17:05:00.000Z"),
      ),
    ).toBe(true);
    expect(
      projectionGameIsConservativelyFinal(
        { awayScore: null, homeScore: null, kickoffAt: null, status: "scheduled" },
        new Date("2026-09-13T17:05:00.000Z"),
      ),
    ).toBe(false);

    const schedule = [
      {
        season: 2026,
        week: 1,
        awayScore: 17,
        homeScore: 20,
        kickoffAt,
        status: "final" as const,
      },
      {
        season: 2026,
        week: 2,
        awayScore: null,
        homeScore: null,
        kickoffAt: null,
        status: "scheduled" as const,
      },
    ];
    expect(projectionStatusWeek(schedule, 2026, new Date("2026-09-13T17:30:00.000Z"))).toBe(1);
    expect(
      projectionTargetWeeks(schedule, 2026, undefined, new Date("2026-09-13T17:30:00.000Z")),
    ).toEqual([1, 2]);
    expect(projectionStatusWeek(schedule, 2026, new Date("2026-09-13T21:00:00.000Z"))).toBe(2);
    expect(
      projectionTargetWeeks(schedule, 2026, undefined, new Date("2026-09-13T21:00:00.000Z")),
    ).toEqual([2]);
  });

  it("withholds unresolved kickoff slates and freezes raw observations at kickoff", () => {
    const schedule = [
      {
        season: 2026,
        week: 1,
        kickoffAt: null,
        awayScore: null,
        homeScore: null,
        status: "scheduled" as const,
      },
      {
        season: 2026,
        week: 2,
        kickoffAt: new Date("2026-09-20T17:00:00.000Z"),
        awayScore: null,
        homeScore: null,
        status: "scheduled" as const,
      },
      {
        season: 2026,
        week: 3,
        kickoffAt: null,
        awayScore: 20,
        homeScore: 17,
        status: "final" as const,
      },
      {
        season: 2026,
        week: 4,
        kickoffAt: new Date("2026-09-27T17:00:00.000Z"),
        awayScore: null,
        homeScore: null,
        status: "postponed" as const,
      },
      {
        season: 2026,
        week: 5,
        kickoffAt: null,
        awayScore: null,
        homeScore: null,
        status: "cancelled" as const,
      },
    ];

    expect(projectionWeekHasUnknownKickoff(schedule, 2026, 1)).toBe(true);
    expect(projectionWeekHasUnknownKickoff(schedule, 2026, 2)).toBe(false);
    expect(projectionWeekHasUnknownKickoff(schedule, 2026, 3)).toBe(false);
    expect(projectionWeekHasUnknownKickoff(schedule, 2026, 4)).toBe(true);
    expect(projectionWeekHasUnknownKickoff(schedule, 2026, 5)).toBe(false);
    expect(projectionRawObservationIsUnlocked(false)).toBe(true);
    expect(projectionRawObservationIsUnlocked(true)).toBe(false);
  });

  it("offers only pre-kickoff player and defense rows to raw publication", () => {
    const rows = [
      { id: "player-before-lock", gameStarted: false },
      { id: "player-after-lock", gameStarted: true },
      { id: "defense-before-lock", gameStarted: false },
      { id: "defense-after-lock", gameStarted: true },
    ] as const;

    expect(projectionUnlockedRawRows(rows)).toEqual([rows[0], rows[2]]);
  });

  it("applies current availability only to the earliest wholly untouched week", () => {
    const schedule = [
      { season: 2026, week: 1, awayScore: 17, homeScore: 20 },
      { season: 2026, week: 2, awayScore: null, homeScore: null },
      { season: 2026, week: 3, awayScore: null, homeScore: null },
    ];
    expect(projectionStatusWeek(schedule, 2026)).toBe(2);
  });

  it("bounds short-term and reserve statuses by time to kickoff", () => {
    const now = new Date("2026-09-01T12:00:00.000Z");
    expect(
      firstPartyStatusForKickoff(["questionable"], new Date("2026-09-06T17:00:00.000Z"), now),
    ).toBe("questionable");
    expect(
      firstPartyStatusForKickoff(["questionable"], new Date("2026-09-13T17:00:00.000Z"), now),
    ).toBe("unknown");
    expect(firstPartyStatusForKickoff(["IR"], new Date("2026-09-20T17:00:00.000Z"), now)).toBe(
      "ir",
    );
    expect(firstPartyStatusForKickoff(["PUP"], new Date("2026-10-11T17:00:00.000Z"), now)).toBe(
      "unknown",
    );
  });

  it("fingerprints status horizons without changing inside the same clock window", () => {
    const kickoff = new Date("2026-09-29T12:00:00.000Z");
    expect(projectionStatusWindow(kickoff, new Date("2026-09-01T11:59:59.000Z"))).toBe(
      "outside-28d",
    );
    expect(projectionStatusWindow(kickoff, new Date("2026-09-01T12:00:00.000Z"))).toBe(
      "reserve-window",
    );
    expect(projectionStatusWindow(kickoff, new Date("2026-09-22T12:00:00.000Z"))).toBe(
      "short-window",
    );
    expect(projectionStatusWindow(kickoff, new Date("2026-09-29T12:00:00.000Z"))).toBe("started");
    expect(projectionStatusWindow(null, new Date("2026-09-01T12:00:00.000Z"))).toBe("unknown-time");
  });

  it("invalidates cached training artifacts after a canonical position correction", () => {
    const common = {
      firstTargetWeek: 4,
      statisticalSources: [{ key: "nflverse.stats-player-week.2025", checksum: "a".repeat(64) }],
      completedSchedule: [
        {
          season: 2025,
          week: 3,
          gameId: "2025_03_AAA_BBB",
          awayTeam: "AAA",
          homeTeam: "BBB",
          awayScore: 17,
          homeScore: 20,
        },
      ],
    } as const;
    const receiver = projectionTrainingCacheKey({
      ...common,
      playerPositions: [{ id: "player", position: "WR" }],
    });
    const tightEnd = projectionTrainingCacheKey({
      ...common,
      playerPositions: [{ id: "player", position: "TE" }],
    });
    expect(receiver).not.toBe(tightEnd);
  });

  it("extracts only valid league scopes from self-asserted ESPN keys", () => {
    expect(
      espnSelfAssertedProjectionLeague("10000000-0000-4000-8000-000000000001:provider-player-7"),
    ).toBe("10000000-0000-4000-8000-000000000001");
    expect(espnSelfAssertedProjectionLeague("provider-player-7")).toBeUndefined();
  });

  it("prefers a provider crosswalk even when an alias cannot match by display name", () => {
    expect(
      canonicalProjectionPlayerId({
        playerId: "espn-roster-alias",
        hasGsisId: false,
        explicitMatchId: "canonical-gsis-player",
      }),
    ).toBe("canonical-gsis-player");
    expect(
      canonicalProjectionPlayerId({
        playerId: "espn-roster-alias",
        hasGsisId: false,
        exactMatchId: "different-exact-name-match",
      }),
    ).toBe("different-exact-name-match");
  });

  it("fails closed on thin backtests and preserves prior output on baseline regression", () => {
    expect(
      projectionModelGate({
        player: playerEvaluation({ samples: 20 }),
        defense: defenseEvaluation(),
        playerPredictions: 20,
        defensePredictions: 250,
      }).state,
    ).toBe("rejected");
    expect(
      projectionModelGate({
        player: playerEvaluation({ mae: 5.4, baselineMae: 5 }),
        defense: defenseEvaluation(),
        playerPredictions: 500,
        defensePredictions: 250,
      }).state,
    ).toBe("degraded");
    expect(
      projectionModelGate({
        player: playerEvaluation(),
        defense: defenseEvaluation(),
        playerPredictions: 500,
        defensePredictions: 250,
      }).state,
    ).toBe("publishable");
  });

  it("rejects thin position cohorts and degrades miscalibrated intervals or biased means", () => {
    const thin = playerEvaluation();
    const thinGate = projectionModelGate({
      player: {
        ...thin,
        byPosition: { ...thin.byPosition, TE: { ...thin.overall, samples: 12 } },
      },
      defense: defenseEvaluation(),
      playerPredictions: 500,
      defensePredictions: 250,
    });
    expect(thinGate.state).toBe("rejected");
    expect(thinGate.reasons).toContain("player_te_sample_too_small");

    const coverageGate = projectionModelGate({
      player: {
        ...thin,
        overall: { ...thin.overall, intervalCoverage: 0.5 },
      },
      defense: defenseEvaluation(),
      playerPredictions: 500,
      defensePredictions: 250,
    });
    expect(coverageGate.state).toBe("degraded");
    expect(coverageGate.reasons).toContain("player_interval_miscalibrated");

    const biasGate = projectionModelGate({
      player: {
        ...thin,
        byPosition: { ...thin.byPosition, QB: { ...thin.overall, bias: -2 } },
      },
      defense: defenseEvaluation(),
      playerPredictions: 500,
      defensePredictions: 250,
    });
    expect(biasGate.state).toBe("degraded");
    expect(biasGate.reasons).toContain("player_qb_bias_exceeded");
  });

  it("builds point intervals from league-scored residuals and always contains the mean", () => {
    const calibration = playerEvaluation().overall;
    expect(leagueScoredInterval(12, calibration)).toEqual({ floor: 9, ceiling: 16 });
    expect(leagueScoredInterval(12, { ...calibration, lowerError: 2, upperError: 5 })).toEqual({
      floor: 12,
      ceiling: 17,
    });
    expect(leagueScoredMean(12, { ...calibration, centerAdjustment: -1.25 })).toBe(10.75);
  });

  it("freezes raw components but rescores them after a midweek scoring correction", () => {
    const row = {
      playerId: "locked-player",
      mean: 12,
      floor: 9,
      ceiling: 16,
      confidence: 0.8,
      components: { passing_touchdowns: 2 },
    };
    const rescored = rescoreFrozenProjection(
      row,
      {
        id: "corrected-scoring",
        version: "2",
        rules: [{ statId: "passing_touchdowns", points: 6 }],
      },
      playerEvaluation().overall,
    );

    expect(rescored.components).toEqual(row.components);
    expect(rescored.mean).toBe(12);
    expect(rescored.floor).toBe(9);
    expect(rescored.ceiling).toBe(16);

    const oldProfile = {
      id: "old-scoring",
      version: "1",
      rules: [{ statId: "passing_touchdowns", points: 4 }],
    } as const;
    expect(rescoreFrozenProjection(row, oldProfile, playerEvaluation().overall).mean).toBe(8);
  });

  it("advertises only model-emitted player, kicker, and D/ST scoring components", () => {
    const components = firstPartyAvailableProjectionComponents();
    expect(components).toContain("passing_yards");
    expect(components).toContain("field_goals_made_50_plus");
    expect(components).toContain("defensive_blocked_kicks");
    expect(components).toContain("points_allowed_35_plus_probability");
    expect(components).not.toContain("solo_tackles");
  });

  it("derives deterministic app-owned UUIDs for all team-defense entities", () => {
    const bears = firstPartyDefensePlayerId("chi");
    expect(bears).toBe("a6462168-1fe5-8824-8d57-974b1b182838");
    expect(bears).toBe(firstPartyDefensePlayerId(" CHI "));
    expect(bears).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
    expect(bears).not.toBe(firstPartyDefensePlayerId("GB"));
    expect(() => firstPartyDefensePlayerId("Chicago")).toThrow(/team code/u);
  });
});

/*
 * Per-position weekly publication coverage.
 *
 * `buildFirstPartyLeaguePublications` is the only place the weekly rail decides what a league may
 * publish. Driving it directly (rather than through `FirstPartyProjectionService.refreshProjections`)
 * is deliberate: the service reaches this planner only behind a publishable whole-model release
 * gate, which needs several seasons of seeded observations to open. The planner is a pure function
 * of its inputs, so the fixtures below reproduce exactly the inputs the service hands it.
 */

const PUBLICATION_SEASON = 2026;
const PUBLICATION_WEEK = 1;
const BACKTEST_SEASON = 2025;
const BACKTEST_WEEKS = 20;
const BACKTEST_PLAYERS_PER_POSITION = 12;
const BACKTEST_POSITIONS = ["QB", "RB", "WR", "TE", "K"] as const;
const BACKTEST_DEFENSE_TEAMS = ["BUF", "CIN", "DAL", "DEN", "KC", "PHI", "SF", "TB"] as const;
const LEAGUE_SEASON_ID = "11111111-1111-4111-8111-111111111111";
const PUBLICATION_NOW = new Date("2026-09-10T12:00:00.000Z");

/**
 * The single component each position's synthetic backtest is expressed in, and the per-unit points
 * the fixture leagues assign it. Residuals are authored in FANTASY POINTS and divided back through
 * `pointsPerUnit`, so a position's error distribution is the same no matter how a league prices it.
 */
const BACKTEST_COMPONENT = {
  QB: { component: "passing_yards", pointsPerUnit: 0.04, actual: 260 },
  RB: { component: "rushing_yards", pointsPerUnit: 0.1, actual: 70 },
  WR: { component: "receiving_yards", pointsPerUnit: 0.1, actual: 65 },
  TE: { component: "receiving_yards", pointsPerUnit: 0.1, actual: 45 },
  K: { component: "field_goals_made_0_39", pointsPerUnit: 3, actual: 2 },
} as const;

const BACKTEST_CONFIGURATION = {
  recencyHalfLifeWeeks: 6,
  playerPriorGames: 4,
  opponentPriorGames: 20,
  teamPriorGames: 16,
  maxPlayerGames: 24,
  minimumCalibrationSamples: 24,
  lowerIntervalQuantile: 0.15,
  upperIntervalQuantile: 0.85,
  backtestEvaluationWeeks: 20,
} as const;

const EMPTY_COMPONENT_METRICS = {
  samples: 0,
  mae: 0,
  rmse: 0,
  bias: 0,
  intervalCoverage: 0,
} as const;

/** Deterministic uniform sequence; these fixtures must never depend on `Math.random`. */
function pseudoRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * One week-batch of fantasy-point residuals, spread evenly over `±spread` and shifted to sum to
 * exactly zero. The zero mean is what keeps the publication gate's bias limit satisfied without
 * hand-tuning, and the even spread is what puts the 15th/85th residual quantiles roughly 70% apart
 * — the interval-coverage band the gate requires.
 */
function residualBatch(seed: number, count: number, spread: number): readonly number[] {
  const next = pseudoRandom(seed);
  const raw = Array.from({ length: count }, () => (next() - 0.5) * 2 * spread);
  const offset = raw.reduce((total, value) => total + value, 0) / count;
  return raw.map((value) => value - offset);
}

function playerBacktestFixture(
  input: { readonly omitPositions?: readonly string[] } = {},
): FirstPartyProjectionBacktest {
  const predictions: FirstPartyBacktestPrediction[] = [];
  let seed = 1;
  for (let week = 1; week <= BACKTEST_WEEKS; week += 1) {
    for (const position of BACKTEST_POSITIONS) {
      seed += 1;
      if (input.omitPositions?.includes(position)) continue;
      const spec = BACKTEST_COMPONENT[position];
      const errors = residualBatch(seed, BACKTEST_PLAYERS_PER_POSITION, 6);
      errors.forEach((error, index) => {
        const predicted = spec.actual - error / spec.pointsPerUnit;
        const baseline = spec.actual - (error * 1.25) / spec.pointsPerUnit;
        predictions.push({
          playerId: `backtest-${position}-${index}`,
          position,
          season: BACKTEST_SEASON,
          week,
          predicted: { [spec.component]: predicted },
          baseline: { [spec.component]: baseline },
          floor: { [spec.component]: predicted - 40 / spec.pointsPerUnit },
          ceiling: { [spec.component]: predicted + 40 / spec.pointsPerUnit },
          actual: { [spec.component]: spec.actual },
          trainingRows: 48,
          calibrationRows: 48,
        });
      });
    }
  }
  return {
    modelVersion: FIRST_PARTY_PROJECTION_MODEL_VERSION,
    configuration: BACKTEST_CONFIGURATION,
    predictions,
    metrics: {},
    overall: EMPTY_COMPONENT_METRICS,
    calibration: { modelVersion: FIRST_PARTY_PROJECTION_MODEL_VERSION, intervals: {} },
    evaluation: {
      policy: "recent-fantasy-relevant",
      maximumWeekBatches: BACKTEST_WEEKS,
      completedWeekBatches: BACKTEST_WEEKS,
      fantasyRelevantTargets: predictions.length,
    },
  };
}

/**
 * A team-defense backtest expressed in `defensive_sacks`. A league that does not price sacks scores
 * every prediction here identically, which is exactly how a D/ST gate fails for a league whose D/ST
 * rules could not be normalized.
 */
function defenseBacktestFixture(): FirstPartyTeamDefenseBacktest {
  const predictions: FirstPartyTeamDefenseBacktestPrediction[] = [];
  let seed = 5000;
  for (let week = 1; week <= BACKTEST_WEEKS; week += 1) {
    seed += 1;
    const errors = residualBatch(seed, BACKTEST_DEFENSE_TEAMS.length, 3);
    errors.forEach((error, index) => {
      const team = BACKTEST_DEFENSE_TEAMS[index] as string;
      const predicted = 2.5 - error;
      const baseline = 2.5 - error * 1.25;
      predictions.push({
        team,
        season: BACKTEST_SEASON,
        week,
        predicted: { defensive_sacks: predicted },
        baseline: { defensive_sacks: baseline },
        lower: { defensive_sacks: predicted - 4 },
        upper: { defensive_sacks: predicted + 4 },
        actual: { defensive_sacks: 2.5 },
        trainingRows: 48,
        calibrationRows: 48,
      });
    });
  }
  return {
    modelVersion: FIRST_PARTY_PROJECTION_MODEL_VERSION,
    predictions,
    metrics: {},
    overall: EMPTY_COMPONENT_METRICS,
    calibration: { modelVersion: FIRST_PARTY_PROJECTION_MODEL_VERSION, intervals: {} },
  };
}

function weeklyProjectionFixture(
  playerId: string,
  position: string,
  components: Record<string, number>,
) {
  return {
    state: "projected" as const,
    playerId,
    position,
    components,
    floorComponents: components,
    ceilingComponents: components,
    coverage: {
      playerGames: 12,
      recentPlayerGames: 4,
      positionGames: 240,
      opponentGames: 20,
      teamGames: 16,
      calibratedComponents: 1,
      fallbackComponents: 0,
    },
    quality: { grade: "high" as const, confidence: 0.82, degraded: false, flags: [] },
    reasons: [],
    provenance: {
      modelVersion: FIRST_PARTY_PROJECTION_MODEL_VERSION,
      independenceKey: "laces-out-first-party" as const,
      strategy: "first-party-model" as const,
      target: { season: PUBLICATION_SEASON, week: PUBLICATION_WEEK },
      trainingCutoff: { season: BACKTEST_SEASON, week: BACKTEST_WEEKS },
      inputFingerprint: "fixture",
    },
  };
}

function leaguePlayerId(position: string): string {
  return `player-${position.toLowerCase()}`;
}

function publishedPlayerFixture(
  position: string,
  team: string,
  options: { readonly gameStarted?: boolean } = {},
) {
  const spec = BACKTEST_COMPONENT[position as keyof typeof BACKTEST_COMPONENT];
  const playerId = leaguePlayerId(position);
  const projection = weeklyProjectionFixture(playerId, position, {
    [spec.component]: spec.actual,
  });
  return {
    playerId,
    externalPlayerId: `GSIS-${position}`,
    position,
    team,
    projection,
    modelProjection: projection,
    baselineProjection: projection,
    leagueSeasonScopes: [],
    gameStarted: options.gameStarted ?? false,
  };
}

function publishedDefenseFixture(team: string) {
  const components = { defensive_sacks: 2.5, special_teams_touchdowns: 0.1 };
  return {
    team,
    gameStarted: false,
    projection: {
      state: "projected" as const,
      team,
      components,
      lowerComponents: components,
      upperComponents: components,
      coverage: {
        teamGames: 16,
        opponentGames: 16,
        leagueGames: 240,
        calibratedComponents: 2,
        fallbackComponents: 0,
      },
      quality: { grade: "high" as const, confidence: 0.7, degraded: false, flags: [] },
      reasons: [],
      provenance: {
        modelVersion: FIRST_PARTY_PROJECTION_MODEL_VERSION,
        independenceKey: "laces-out-first-party-defense" as const,
        target: { season: PUBLICATION_SEASON, week: PUBLICATION_WEEK },
        trainingCutoff: { season: BACKTEST_SEASON, week: BACKTEST_WEEKS },
        inputFingerprint: "fixture",
      },
    },
  };
}

const PUBLICATION_TEAMS = ["BUF", "KC"] as const;

function espnRule(providerStatId: string, points: number) {
  return {
    leagueSeasonId: LEAGUE_SEASON_ID,
    statKey: providerStatId,
    operation: "multiply",
    points: points.toFixed(4),
    thresholdLow: null,
    thresholdHigh: null,
    providerStatId,
  };
}

/**
 * A minimal Garagely-shaped ESPN rule set: ordinary offence and kicking rules, plus one rule that
 * makes D/ST unpriceable — a bare `205` (ESPN's "Defensive 2pt Return", a category with no ingested
 * data source and no recorded occurrence bound). The `132:slot:16` yards-allowed bracket override
 * is an accepted, mapped tier-probability rule, but it stays out of the emitted profile while D/ST
 * is unsupported. `101` (special-teams touchdowns) is kept because it is scored for both
 * offensive skill positions and D/ST: it is the rule that used to drag the whole league into the
 * D/ST gate.
 *
 * The blocker used to be `206`. That ID became a priced de minimis zero component on 2026-07-29
 * (`docs/dst-stat-id-evidence-2026-07-29.md` §4), so the real Garagely league's D/ST is now
 * SUPPORTED — see `PUBLISHES_DST_RULES` below, which exercises that path. This fixture keeps a
 * D/ST-unpriceable league in the suite deliberately: the behavior it holds down (one position
 * withheld must never take the other five with it) has to keep working, and it needs an ID that
 * still fails closed to demonstrate it.
 */
const GARAGELY_SHAPED_RULES = [
  espnRule("3", 0.04),
  espnRule("4", 4),
  espnRule("20", -2),
  espnRule("24", 0.1),
  espnRule("25", 6),
  espnRule("42", 0.1),
  espnRule("43", 6),
  espnRule("53", 1),
  espnRule("72", -2),
  espnRule("77", 4),
  espnRule("80", 3),
  espnRule("86", 1),
  espnRule("101", 6),
  espnRule("132:slot:16", -1),
  espnRule("205", 2),
] as const;

/**
 * A kicker-only league, shaped after a real production league whose ESPN rule set prices nothing
 * but field goals and extra points: no rule touches any QB/RB/WR/TE/D-ST component, so
 * normalization supports K alone.
 */
const KICKER_ONLY_RULES = [
  espnRule("86", 1), // extra_points_made
  espnRule("80", 3), // field_goals_made_0_39
  espnRule("77", 4), // field_goals_made_40_49
  espnRule("198", 5), // field_goals_made_50_59
  espnRule("201", 6), // field_goals_made_60_plus
  espnRule("85", -1), // field_goals_missed
] as const;

/** The same offence, with D/ST priced through per-unit rules the model can actually project. */
const DST_SUPPORTED_RULES = [
  espnRule("3", 0.04),
  espnRule("4", 4),
  espnRule("24", 0.1),
  espnRule("25", 6),
  espnRule("42", 0.1),
  espnRule("43", 6),
  espnRule("53", 1),
  espnRule("77", 4),
  espnRule("80", 3),
  espnRule("86", 1),
  espnRule("99", 1),
  espnRule("95", 2),
  espnRule("94", 6),
] as const;

interface RosterFixtureEntry {
  readonly playerId: string;
  readonly primaryPosition: string;
  readonly nflTeam: string | null;
}

/**
 * A roster naming every published player plus a team defense, which is what puts the roster-gap
 * and locked-roster branches — the only two remaining whole-league withholding paths — on the
 * execution path alongside per-position withholding.
 */
const FULL_ROSTER: readonly RosterFixtureEntry[] = [
  ...BACKTEST_POSITIONS.map((position) => ({
    playerId: leaguePlayerId(position),
    primaryPosition: position,
    nflTeam: PUBLICATION_TEAMS[0],
  })),
  {
    playerId: "roster-alias-dst-buf",
    primaryPosition: "D/ST",
    nflTeam: PUBLICATION_TEAMS[0],
  },
];

/**
 * The sentinel `#loadLatestRosters` appends when a league's roster snapshots do not add up — every
 * team snapshotted but empty (pre-draft), or fewer snapshots than teams (partial sync). It carries
 * no NFL team and an unresolvable position, so it can never be mistaken for a rostered player.
 */
const INCOMPLETE_ROSTER_SENTINEL: RosterFixtureEntry = {
  playerId: `INCOMPLETE-ROSTER:${LEAGUE_SEASON_ID}`,
  primaryPosition: "UNRESOLVED",
  nflTeam: null,
};

/** Pre-draft: every team snapshotted, every snapshot empty, so nothing but the sentinel loads. */
const PRE_DRAFT_ROSTER: readonly RosterFixtureEntry[] = [INCOMPLETE_ROSTER_SENTINEL];

/** Partially synced: real rostered players AND the sentinel. Must keep failing closed. */
const PARTIALLY_SYNCED_ROSTER: readonly RosterFixtureEntry[] = [
  ...FULL_ROSTER,
  INCOMPLETE_ROSTER_SENTINEL,
];

function planPublications(input: {
  readonly rules: readonly ReturnType<typeof espnRule>[];
  readonly playerBacktest?: FirstPartyProjectionBacktest;
  readonly defenseBacktest?: FirstPartyTeamDefenseBacktest;
  readonly rosters?: readonly RosterFixtureEntry[];
  readonly startedPositions?: readonly string[];
}) {
  const playerBacktest = input.playerBacktest ?? playerBacktestFixture();
  return buildFirstPartyLeaguePublications({
    season: PUBLICATION_SEASON,
    week: PUBLICATION_WEEK,
    now: PUBLICATION_NOW,
    sourceAsOf: PUBLICATION_NOW,
    inputChecksum: "a".repeat(64),
    playerBacktest,
    basePlayerBacktest: playerBacktest,
    defenseBacktest: input.defenseBacktest ?? defenseBacktestFixture(),
    players: PUBLICATION_TEAMS.map((team) => ({
      id: firstPartyDefensePlayerId(team),
      gsisId: null,
      fullName: `${team} D/ST`,
      nflTeam: team,
      primaryPosition: "D/ST",
      status: null,
      lastSeason: PUBLICATION_SEASON,
    })),
    leagues: [
      { id: LEAGUE_SEASON_ID, provider: "espn", currentWeek: PUBLICATION_WEEK, teamCount: 12 },
    ],
    rules: [...input.rules],
    rosters: (input.rosters ?? []).map((entry) => ({
      leagueSeasonId: LEAGUE_SEASON_ID,
      ...entry,
    })),
    publishedPlayers: BACKTEST_POSITIONS.map((position) =>
      publishedPlayerFixture(position, PUBLICATION_TEAMS[0], {
        gameStarted: input.startedPositions?.includes(position) ?? false,
      }),
    ),
    publishedDefenses: PUBLICATION_TEAMS.map((team) => publishedDefenseFixture(team)),
    previousRowsByLeague: new Map(),
  });
}

const DEFENSE_ROW_IDS = new Set(PUBLICATION_TEAMS.map((team) => firstPartyDefensePlayerId(team)));

describe("weekly league publication withholds unsupported positions, not leagues", () => {
  it("publishes every position a league can be priced for and withholds only D/ST", () => {
    const plan = planPublications({ rules: GARAGELY_SHAPED_RULES });

    expect(plan.publications).toHaveLength(1);
    const publication = plan.publications[0];
    expect(publication?.rows.map((row) => row.playerId).sort()).toEqual([
      "player-k",
      "player-qb",
      "player-rb",
      "player-te",
      "player-wr",
    ]);
    // No D/ST row under any identity: the league cannot be priced for D/ST, so publishing one
    // would mean inventing a D/ST score from an offence-only rule set.
    expect(publication?.rows.some((row) => DEFENSE_ROW_IDS.has(row.playerId))).toBe(false);
    expect(publication?.metadata.supportedPositions).toEqual(["QB", "RB", "WR", "TE", "K"]);
    expect(publication?.metadata.publishedPositions).toEqual(["QB", "RB", "WR", "TE", "K"]);

    // Fixture integrity: those five positions cleared a real numeric gate rather than being
    // waved through as "this league prices nothing for you".
    const backtest = publication?.metadata.backtest as
      { readonly samples: number; readonly intervalCoverage: number | null } | undefined;
    expect(backtest?.samples).toBeGreaterThanOrEqual(100);
    expect(backtest?.intervalCoverage).toBeGreaterThan(0.62);
    expect(backtest?.intervalCoverage).toBeLessThan(0.78);

    expect(plan.withheld).toHaveLength(1);
    const entry = plan.withheld[0];
    expect(entry?.leagueSeasonId).toBe(LEAGUE_SEASON_ID);
    // The league still published, so this entry must not read as "nothing was published".
    expect(entry?.scope).toBe("positions");
    expect(entry?.positions).toEqual([
      {
        position: "DST",
        source: "normalization",
        reasons: [expect.stringContaining("UNSUPPORTED_PLAYER_RULE:") as unknown as string],
      },
    ]);
    // The pre-existing flat strings stay populated for readers that predate `positions`, and the
    // per-ID reason names the established meaning and the data gap, not a generic category.
    expect(entry?.reasons.every((reason) => reason.startsWith("DST withheld: "))).toBe(true);
    expect(entry?.reasons.join(" ")).toMatch(/"Defensive 2pt Return" rule \(stat 205\)/u);
    expect(entry?.reasons.join(" ")).toMatch(/neither projected nor backtested/u);
  });

  it("keeps every offensive position when a failing D/ST gate meets an unpriceable D/ST", () => {
    const plan = planPublications({ rules: GARAGELY_SHAPED_RULES });
    const publication = plan.publications[0];

    // The regression this guards: `special_teams_touchdowns` survives normalization because
    // QB/RB/WR/TE score it, and it is also a D/ST-scoring stat. The old gate therefore evaluated
    // the D/ST backtest for this league and — because the D/ST evaluation cannot clear (nothing it
    // predicts is priced, so model and baseline score identically) — withheld ALL five offensive
    // positions along with D/ST.
    expect(publication?.profile.rules.map((rule) => rule.statId)).toContain(
      "special_teams_touchdowns",
    );
    const defenseBacktest = publication?.metadata.defenseBacktest as
      { readonly baselineMae: number } | undefined;
    expect(defenseBacktest?.baselineMae).toBe(0);

    expect(publication?.rows).toHaveLength(BACKTEST_POSITIONS.length);
    expect(plan.withheld[0]?.positions?.map((item) => item.position)).toEqual(["DST"]);
  });

  it("publishes D/ST rows when the league can be priced for D/ST and its gate clears", () => {
    const plan = planPublications({ rules: DST_SUPPORTED_RULES });

    const publication = plan.publications[0];
    expect(publication?.metadata.supportedPositions).toEqual(["QB", "RB", "WR", "TE", "K", "DST"]);
    expect(publication?.metadata.publishedPositions).toEqual(["QB", "RB", "WR", "TE", "K", "DST"]);
    expect(
      publication?.rows.filter((row) => DEFENSE_ROW_IDS.has(row.playerId)).map((row) => row.mean),
    ).toHaveLength(PUBLICATION_TEAMS.length);
    expect(plan.withheld).toHaveLength(0);

    // Every D/ST modelling choice a reader cannot infer from the number is disclosed with it. The
    // de minimis entry is load-bearing: 206/209 no longer produce a withheld reason, so this is the
    // only place the "priced at zero" claim reaches a user (requirement: nothing silently vanishes).
    const warnings = (publication?.metadata as { readonly warnings?: readonly string[] }).warnings;
    expect(warnings).toBeDefined();
    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("points_allowed_method="),
        expect.stringContaining("blocked_kicks_classification="),
        expect.stringContaining("yards_allowed_method="),
        expect.stringContaining("de_minimis_zero_components="),
      ]),
    );
    const deMinimis = warnings?.find((warning) =>
      warning.startsWith("de_minimis_zero_components="),
    );
    expect(deMinimis).toContain("defensive_two_point_returns (ESPN 206)");
    expect(deMinimis).toContain("one_point_safeties (ESPN 209)");
    expect(deMinimis).toContain("constant zero");
    expect(deMinimis).toContain("0.01 expected points per team-week");
    expect(deMinimis).toContain("docs/dst-stat-id-evidence-2026-07-29.md");
  });

  it("withholds a single position whose own backtest gate fails, not the league", () => {
    const plan = planPublications({
      rules: GARAGELY_SHAPED_RULES,
      playerBacktest: playerBacktestFixture({ omitPositions: ["K"] }),
    });

    const publication = plan.publications[0];
    expect(publication?.rows.map((row) => row.playerId)).not.toContain("player-k");
    expect(publication?.rows).toHaveLength(BACKTEST_POSITIONS.length - 1);
    expect(publication?.metadata.publishedPositions).toEqual(["QB", "RB", "WR", "TE"]);
    // Normalization still supports K — this is a backtest verdict, and the two must stay
    // distinguishable in the run metrics.
    expect(publication?.metadata.supportedPositions).toContain("K");

    const withheldPositions = plan.withheld[0]?.positions ?? [];
    expect(withheldPositions.map((item) => `${item.position}:${item.source}`)).toEqual([
      "DST:normalization",
      "K:backtest-gate",
    ]);
    expect(withheldPositions.find((item) => item.position === "K")?.reasons).toEqual([
      "The K league-scored backtest did not clear the recency-only baseline gate.",
    ]);
  });

  it("still withholds the whole league when no position normalizes", () => {
    const plan = planPublications({
      rules: [espnRule("3", 0.04), espnRule("9999", 1)],
    });

    expect(plan.publications).toEqual([]);
    expect(plan.withheld).toHaveLength(1);
    const entry = plan.withheld[0];
    expect(entry?.scope).toBe("league");
    expect(entry?.reasons.every((reason) => reason.startsWith("UNKNOWN_NONZERO_RULE: "))).toBe(
      true,
    );
    // Per-position provenance is additive here too: every position names its own reason rather
    // than sharing one flat league-wide union.
    expect(entry?.positions?.map((item) => item.position)).toEqual([
      "QB",
      "RB",
      "WR",
      "TE",
      "K",
      "DST",
    ]);
    expect(
      entry?.positions?.every((item) => item.source === "normalization" && item.reasons.length > 0),
    ).toBe(true);
  });

  it("withholds D/ST alone when D/ST is supported but its own backtest gate fails", () => {
    // A D/ST backtest too thin to clear `minimumPositionScoredSamples`; the offence is untouched.
    const thinDefense = defenseBacktestFixture();
    const plan = planPublications({
      rules: DST_SUPPORTED_RULES,
      defenseBacktest: { ...thinDefense, predictions: thinDefense.predictions.slice(0, 16) },
    });

    const publication = plan.publications[0];
    expect(publication?.metadata.supportedPositions).toContain("DST");
    expect(publication?.metadata.publishedPositions).toEqual(["QB", "RB", "WR", "TE", "K"]);
    expect(publication?.rows.some((row) => DEFENSE_ROW_IDS.has(row.playerId))).toBe(false);
    expect(plan.withheld[0]?.scope).toBe("positions");
    expect(plan.withheld[0]?.positions).toEqual([
      {
        position: "DST",
        source: "backtest-gate",
        reasons: ["The D/ST league-scored backtest did not clear the recency-only baseline gate."],
      },
    ]);
  });

  it("publishes D/ST under its roster alias rather than the canonical defense identity", () => {
    const plan = planPublications({ rules: DST_SUPPORTED_RULES, rosters: FULL_ROSTER });

    const publication = plan.publications[0];
    expect(publication?.metadata.rosterCoverageChecked).toBe(true);
    expect(publication?.rows.map((row) => row.playerId)).toContain("roster-alias-dst-buf");
    // The canonical UUID is replaced by the alias for the rostered team, never emitted alongside.
    expect(publication?.rows.some((row) => row.playerId === firstPartyDefensePlayerId("BUF"))).toBe(
      false,
    );
    expect(publication?.metadata.publishedPositions).toContain("DST");
  });
});

describe("published backtest MAE reflects only the league's supported positions", () => {
  it("equals the K-position evaluation, not the all-position aggregate, for a kicker-only league", () => {
    const plan = planPublications({ rules: KICKER_ONLY_RULES });

    const publication = plan.publications[0];
    expect(publication).toBeDefined();
    if (!publication) throw new Error("expected a publication");

    // Fixture integrity: the league's rules only normalize K, and only a K row publishes.
    expect(publication.metadata.supportedPositions).toEqual(["K"]);
    expect(publication.rows.map((row) => row.playerId)).toEqual(["player-k"]);

    // Reproduce the exact evaluation the planner computed internally (same base backtest fixture
    // and the same league profile), so the assertions below are exact rather than loose bounds.
    const basePlayerBacktest = playerBacktestFixture();
    const champion = applyFirstPartyProjectionChampionPolicy(
      basePlayerBacktest,
      publication.profile,
    );
    const finalBacktest = applyFirstPartyProjectionFinalPolicy(basePlayerBacktest, champion.policy);
    const evaluation = evaluateFirstPartyBacktestForScoringProfile(
      finalBacktest,
      publication.profile,
    );
    const kEvaluation = evaluation.byPosition.K;
    expect(kEvaluation).toBeDefined();
    if (!kEvaluation) throw new Error("expected a K-position evaluation");

    // Contamination check: under a K-only profile every QB/RB/WR/TE prediction scores
    // actual === projected === baseline === 0, so `overall` (mixing in those 960 exactly-zero
    // samples alongside K's 240 real ones) is far lower than K's own MAE.
    expect(evaluation.overall.samples).toBeGreaterThan(kEvaluation.samples);
    expect(evaluation.overall.mae).toBeLessThan(kEvaluation.mae * 0.5);

    const backtest = publication.metadata.backtest as {
      readonly samples: number;
      readonly mae: number;
      readonly baselineMae: number;
      readonly intervalCoverage: number | null;
    };

    // The fix: the displayed summary equals the K-position slice of `byPosition`, never `overall`.
    expect(backtest).toEqual({
      samples: kEvaluation.samples,
      mae: kEvaluation.mae,
      baselineMae: kEvaluation.baselineMae,
      intervalCoverage: kEvaluation.intervalCoverage,
    });
    expect(backtest.mae).not.toBeCloseTo(evaluation.overall.mae, 5);
    expect(backtest.samples).not.toBe(evaluation.overall.samples);
  });
});

/*
 * Per-position withholding against a NON-EMPTY roster.
 *
 * The roster-gap and locked-roster branches are the two remaining paths that can still withhold a
 * whole league, and both run outside the position filter. They are correct only because
 * `playerById` and `leagueRosterIds` are built from the UNFILTERED league players: a rostered
 * player in a withheld position must still count as covered, and must not count as a locked player
 * missing a baseline. Moving the position filter onto `leaguePlayers` instead of the loop body
 * would satisfy every other test in this file while silently resurrecting whole-league withholding
 * for any league that rosters a kicker — these tests exist to make that mutation fail.
 */
describe("weekly league publication against a rostered league", () => {
  it("keeps publishing when a rostered position is withheld, instead of reporting a roster gap", () => {
    const plan = planPublications({
      rules: GARAGELY_SHAPED_RULES,
      playerBacktest: playerBacktestFixture({ omitPositions: ["K"] }),
      rosters: FULL_ROSTER,
    });

    expect(plan.publications).toHaveLength(1);
    const publication = plan.publications[0];
    // Proves the roster branches actually ran rather than being skipped by an empty roster.
    expect(publication?.metadata.rosterCoverageChecked).toBe(true);
    expect(publication?.rows.map((row) => row.playerId).sort()).toEqual([
      "player-qb",
      "player-rb",
      "player-te",
      "player-wr",
    ]);
    // The rostered D/ST is not a roster gap either, even though D/ST cannot be priced here.
    expect(publication?.rows.some((row) => row.playerId === "roster-alias-dst-buf")).toBe(false);
    expect(publication?.rows.some((row) => DEFENSE_ROW_IDS.has(row.playerId))).toBe(false);

    expect(plan.withheld).toHaveLength(1);
    expect(plan.withheld[0]?.scope).toBe("positions");
    expect(plan.withheld[0]?.reasons.some((reason) => reason.includes("Roster coverage"))).toBe(
      false,
    );
    expect(plan.withheld[0]?.positions?.map((item) => item.position)).toEqual(["DST", "K"]);
  });

  it("does not treat a locked, baseline-less player in a withheld position as a league blocker", () => {
    // Control: with K publishable, this exact fixture withholds the whole league, because a
    // rostered K whose game has started has no pre-kickoff row to freeze.
    const control = planPublications({
      rules: GARAGELY_SHAPED_RULES,
      rosters: FULL_ROSTER,
      startedPositions: ["K"],
    });
    expect(control.publications).toEqual([]);
    expect(control.withheld[0]?.scope).toBe("league");
    expect(control.withheld[0]?.reasons[0]).toContain("No pre-kickoff forecast was available");

    // Same fixture, K withheld by its own backtest gate: the withheld position contributes no
    // locked-roster accounting, so the league publishes its four remaining positions.
    const plan = planPublications({
      rules: GARAGELY_SHAPED_RULES,
      playerBacktest: playerBacktestFixture({ omitPositions: ["K"] }),
      rosters: FULL_ROSTER,
      startedPositions: ["K"],
    });
    expect(plan.publications).toHaveLength(1);
    expect(plan.publications[0]?.rows).toHaveLength(BACKTEST_POSITIONS.length - 1);
    expect(plan.withheld[0]?.scope).toBe("positions");
  });
});

/*
 * Pre-draft leagues.
 *
 * A synced-but-undrafted league has a roster snapshot per fantasy team and zero roster entries in
 * all of them, so `#loadLatestRosters` emits only its `INCOMPLETE-ROSTER:` sentinel. The roster-gap
 * branch then withheld the whole league — every real league is in this state before the draft, so
 * the weekly rail published nothing at all for them.
 *
 * The operator's rule: publish when the league is UNAMBIGUOUSLY pre-draft (no team has a single
 * rostered player), and keep failing closed the moment any real roster data is present alongside
 * the sentinel, because that is a partial sync rather than an undrafted league.
 */
describe("weekly league publication for a pre-draft league", () => {
  it("publishes the player pool for a league whose every roster snapshot is empty", () => {
    const plan = planPublications({ rules: DST_SUPPORTED_RULES, rosters: PRE_DRAFT_ROSTER });

    expect(plan.publications).toHaveLength(1);
    const publication = plan.publications[0];
    expect(publication?.rows.length).toBeGreaterThan(0);
    // Scored exactly as a rostered league would be: supported positions only, D/ST as normalized.
    expect(publication?.metadata.publishedPositions).toEqual(["QB", "RB", "WR", "TE", "K", "DST"]);
    expect(publication?.rows.filter((row) => DEFENSE_ROW_IDS.has(row.playerId))).toHaveLength(
      PUBLICATION_TEAMS.length,
    );

    // Honesty marker, and no roster coverage was actually verified for this set.
    expect(publication?.metadata.rosterCoverage).toBe("pre-draft");
    expect(publication?.metadata.rosterCoverageChecked).toBe(false);

    // The league is published, not withheld — and the run metrics say why it published anyway.
    expect(plan.withheld).toEqual([]);
    expect(plan.notes).toEqual([
      {
        leagueSeasonId: LEAGUE_SEASON_ID,
        code: "pre-draft-roster",
        message:
          "No team has a rostered player yet, so this league published its player pool without a roster coverage check.",
      },
    ]);
  });

  it("does not let roster-dependent branches fire for a pre-draft league", () => {
    // A started player with no pre-kickoff baseline is the locked-roster trigger; it must no-op
    // here because no team rosters anybody. No roster alias exists either, so D/ST publishes under
    // its canonical identity.
    const plan = planPublications({
      rules: DST_SUPPORTED_RULES,
      rosters: PRE_DRAFT_ROSTER,
      startedPositions: ["K"],
    });

    expect(plan.publications).toHaveLength(1);
    expect(plan.withheld).toEqual([]);
    const publication = plan.publications[0];
    expect(publication?.rows.map((row) => row.playerId)).not.toContain("player-k");
    expect(publication?.rows.map((row) => row.playerId)).toContain(
      firstPartyDefensePlayerId("BUF"),
    );
    expect(publication?.rows.map((row) => row.playerId)).not.toContain("roster-alias-dst-buf");
  });

  it("still publishes a pre-draft league that also withholds a position", () => {
    const plan = planPublications({ rules: GARAGELY_SHAPED_RULES, rosters: PRE_DRAFT_ROSTER });

    expect(plan.publications).toHaveLength(1);
    expect(plan.publications[0]?.metadata.rosterCoverage).toBe("pre-draft");
    // D/ST is withheld on its own merits; that is orthogonal to the roster state.
    expect(plan.withheld.map((entry) => entry.scope)).toEqual(["positions"]);
    expect(plan.notes.map((note) => note.code)).toEqual(["pre-draft-roster"]);
  });

  it("keeps failing closed for a partially synced league, exactly as before", () => {
    const plan = planPublications({
      rules: DST_SUPPORTED_RULES,
      rosters: PARTIALLY_SYNCED_ROSTER,
    });

    expect(plan.publications).toEqual([]);
    expect(plan.withheld).toHaveLength(1);
    expect(plan.withheld[0]).toMatchObject({
      leagueSeasonId: LEAGUE_SEASON_ID,
      scope: "league",
      reasons: ["League roster snapshots are incomplete."],
    });
    expect(plan.notes).toEqual([]);
  });

  it("leaves a fully drafted league unchanged and marks its roster coverage complete", () => {
    const plan = planPublications({ rules: DST_SUPPORTED_RULES, rosters: FULL_ROSTER });

    expect(plan.publications).toHaveLength(1);
    const publication = plan.publications[0];
    expect(publication?.metadata.rosterCoverage).toBe("complete");
    expect(publication?.metadata.rosterCoverageChecked).toBe(true);
    expect(publication?.rows.map((row) => row.playerId)).toContain("roster-alias-dst-buf");
    expect(plan.withheld).toEqual([]);
    expect(plan.notes).toEqual([]);
  });

  it("reports an unobserved roster as unknown rather than claiming pre-draft", () => {
    // No snapshot rows at all: nothing was observed either way. This league published before this
    // change too, so its behaviour is unchanged — only the marker is new.
    const plan = planPublications({ rules: DST_SUPPORTED_RULES });

    expect(plan.publications).toHaveLength(1);
    expect(plan.publications[0]?.metadata.rosterCoverage).toBe("unknown");
    expect(plan.publications[0]?.metadata.rosterCoverageChecked).toBe(false);
    expect(plan.notes).toEqual([]);
  });
});
