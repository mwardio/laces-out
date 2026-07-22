import type {
  FirstPartyScoredBacktestEvaluation,
  FirstPartyScoredTeamDefenseEvaluation,
} from "@fantasy/projections";
import { describe, expect, it } from "vitest";

import {
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
