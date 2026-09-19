import {
  applyFirstPartyProjectionChampionPolicy,
  applyFirstPartyProjectionFinalPolicy,
  evaluateFirstPartyBacktestForScoringProfile,
  evaluateFirstPartyTeamDefenseBacktestForScoringProfile,
  evaluateWeeklyPointCalibration,
  WEEKLY_POINT_CALIBRATION_POLICY_VERSION,
  WEEKLY_INTERVAL_CALIBRATION_POLICY_VERSION,
  applyWeeklyIntervalPolicy,
  applyWeeklyPointCalibration,
  storedWeeklyIntervalPolicyVersion,
  storedWeeklyIntervalPolicyProvenance,
  storedWeeklyPointPolicyVersion,
  projectionScoringProfileKey,
  firstPartyProjectionComponentsForPosition,
  FIRST_PARTY_PROJECTION_MODEL_VERSION,
} from "@laces-out/projections";
import type {
  FirstPartyBacktestPrediction,
  WeeklyPointResidualCalibration,
  FirstPartyProjectionBacktest,
  FirstPartyScoredBacktestEvaluation,
  FirstPartyScoredTeamDefenseEvaluation,
  FirstPartyTeamDefenseBacktest,
  FirstPartyTeamDefenseBacktestPrediction,
  ProjectionScoringProfile,
} from "@laces-out/projections";
import { describe, expect, it, vi } from "vitest";

import {
  FIRST_PARTY_PLAYER_HISTORY_VERSION,
  projectionInputChecksum,
} from "./first-party-projection-inputs.js";
import {
  buildFirstPartyLeaguePublications,
  type ScoredProjectionRow,
  canonicalProjectionPlayerId,
  projectionProviderCanonicalMatches,
  projectionStatusCanonicalMatches,
  projectionNameCanonicalMatches,
  effectiveFirstPartyProjectionPositions,
  evaluateFirstPartyPublicationCandidates,
  FirstPartyPublicationEvidenceMemo,
  firstPartyAvailableProjectionComponents,
  firstPartyDefensePlayerId,
  firstPartyStatusForKickoff,
  frozenProjectionSupportsScoringProfile,
  espnSelfAssertedProjectionLeague,
  leagueScoredInterval,
  leagueScoredMean,
  projectionGameIsConservativelyFinal,
  projectionHistorySeasons,
  projectionModelGate,
  projectionPublicationClockGuard,
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

describe("weekly name identity resolution", () => {
  const alias = {
    id: "alias",
    gsisId: null,
    fullName: "James Cook III",
    nflTeam: "BUF",
    primaryPosition: "RB",
  };
  const canonical = { ...alias, id: "canonical", gsisId: "00-0037249", fullName: "James Cook" };
  const yahoo = { playerId: alias.id, source: "yahoo", externalId: "470.p.99999" };
  const resolve = (input: Partial<Parameters<typeof projectionNameCanonicalMatches>[0]> = {}) =>
    projectionNameCanonicalMatches({
      players: [alias, canonical],
      externalIds: [yahoo],
      explicitMatches: new Map(),
      ...input,
    });

  it.each([
    ["James Cook III", "James Cook"],
    ["KC Concepcion Jr.", "KC Concepcion"],
    ["Travis Etienne Jr.", "Travis Etienne"],
    ["Kyle Pitts Sr.", "Kyle Pitts"],
  ])("binds a unique suffix variant %s to %s", (rosterName, catalogName) => {
    expect(
      resolve({
        players: [
          { ...alias, fullName: rosterName },
          { ...canonical, fullName: catalogName },
        ],
      }).get(alias.id),
    ).toBe(canonical.id);
  });

  it("rejects differing suffixes and the entire ambiguous base-name cohort", () => {
    expect(
      resolve({ players: [alias, { ...canonical, fullName: "James Cook II" }] }).get(alias.id),
    ).toBeNull();
    const sameBase = {
      ...canonical,
      id: "other",
      gsisId: "other-gsis",
      fullName: "James Cook Jr.",
    };
    for (const players of [
      [alias, canonical, sameBase],
      [sameBase, canonical, alias],
    ]) {
      expect(resolve({ players }).get(alias.id)).toBeNull();
    }
  });

  it("prefers a unique exact full name before considering other same-base candidates", () => {
    const exact = { ...canonical, fullName: alias.fullName };
    const unsuffixed = { ...canonical, id: "other", gsisId: "other-gsis" };
    for (const players of [
      [alias, exact, unsuffixed],
      [unsuffixed, exact, alias],
    ]) {
      expect(resolve({ players }).get(alias.id)).toBe(canonical.id);
    }
  });

  it("does not use provider facts to prune an ambiguous name cohort", () => {
    expect(
      resolve({
        players: [alias, canonical, { ...canonical, id: "other", gsisId: "other-gsis" }],
        externalIds: [yahoo, { playerId: "other", source: "sleeper-yahoo", externalId: "12345" }],
      }).get(alias.id),
    ).toBeNull();
  });

  it.each(["James Cook", "James Cook III"])(
    "rejects contradictory provider facts for exact or suffix names: %s",
    (fullName) => {
      for (const externalId of ["12345", "nba.p.99999", ""]) {
        expect(
          resolve({
            players: [{ ...alias, fullName }, canonical],
            externalIds: [yahoo, { playerId: canonical.id, source: "sleeper-yahoo", externalId }],
          }).get(alias.id),
        ).toBeNull();
      }
    },
  );

  it("keeps unavailable explicit evidence and outside-catalog bridges unavailable", () => {
    for (const id of [null, "outside-catalog"]) {
      expect(resolve({ explicitMatches: new Map([[alias.id, id]]) }).get(alias.id)).toBeNull();
    }
  });

  it("retains an explicit compatible bridge even when names differ", () => {
    expect(
      resolve({
        players: [alias, { ...canonical, fullName: "Different Display Name" }],
        explicitMatches: new Map([[alias.id, canonical.id]]),
      }).get(alias.id),
    ).toBe(canonical.id);
  });

  it.each([{ nflTeam: "NYJ" }, { primaryPosition: "WR" }])(
    "rejects an explicit bridge incompatible with current roster facts: %j",
    (change) => {
      expect(
        resolve({
          players: [alias, { ...canonical, ...change }],
          explicitMatches: new Map([[alias.id, canonical.id]]),
        }).get(alias.id),
      ).toBeNull();
    },
  );

  it("requires trusted GSIS and retains catalog GSIS authority", () => {
    expect(
      resolve({ players: [alias, { ...canonical, gsisId: null }] }).get(alias.id),
    ).toBeUndefined();
    expect(
      resolve({
        players: [alias, canonical],
        explicitMatches: new Map([[canonical.id, null]]),
      }).get(canonical.id),
    ).toBeNull();
    expect(
      canonicalProjectionPlayerId({
        playerId: canonical.id,
        hasGsisId: true,
        explicitMatchId: null,
      }),
    ).toBe(canonical.id);
  });

  it("blocks scoped ESPN candidate conflicts and leaves unrelated punctuation intact", () => {
    expect(
      resolve({
        externalIds: [
          {
            playerId: alias.id,
            source: "espn-self-asserted",
            externalId: "10000000-0000-4000-8000-000000000001:123",
          },
          { playerId: canonical.id, source: "sleeper-espn", externalId: "456" },
        ],
      }).get(alias.id),
    ).toBeNull();
    expect(
      resolve({
        players: [
          { ...alias, fullName: "K.C. Concepcion Jr." },
          { ...canonical, fullName: "KC Concepcion" },
        ],
      }).get(alias.id),
    ).toBeUndefined();
  });
});

describe("weekly publication clock fence", () => {
  const kickoffAt = new Date("2026-09-13T17:00:00Z");
  const game = {
    season: 2026,
    week: 1,
    gameId: "2026_01_BUF_NYJ",
    awayTeam: "BUF",
    homeTeam: "NYJ",
    awayScore: null,
    homeScore: null,
    kickoffAt,
    status: "scheduled" as const,
  };
  const guard = (preparedAt: Date) =>
    projectionPublicationClockGuard({
      schedules: [game],
      season: 2026,
      week: 1,
      statsThrough: null,
      preparedAt,
    });

  it.each([0, 7 * 86_400_000, 28 * 86_400_000])(
    "rejects crossing the kickoff or availability boundary %i milliseconds before kickoff",
    (beforeKickoff) => {
      const boundary = kickoffAt.getTime() - beforeKickoff;
      const clock = guard(new Date(boundary - 60_000));
      expect(() => clock.check(new Date(boundary - 1))).not.toThrow();
      expect(() => clock.check(new Date(boundary))).toThrow(
        expect.objectContaining({ code: "PROJECTION_INPUT_EPOCH_CHANGED" }),
      );
    },
  );

  it("reserves the bounded write budget without marking the game started early", () => {
    const clock = guard(new Date(kickoffAt.getTime() - 60_000));
    expect(() => clock.check(new Date(kickoffAt.getTime() - 10_001), true)).not.toThrow();
    expect(() => clock.check(new Date(kickoffAt.getTime() - 10_000), true)).toThrow();
    expect(() => guard(kickoffAt).check(new Date(kickoffAt.getTime() + 1), true)).not.toThrow();
  });

  it("rejects a prior week's statistics-coverage deadline even with unchanged source bytes", () => {
    const boundary = kickoffAt.getTime() + 8 * 3_600_000;
    const clock = projectionPublicationClockGuard({
      schedules: [
        game,
        { ...game, week: 2, gameId: "next", kickoffAt: new Date("2026-09-20T17:00:00Z") },
      ],
      season: 2026,
      week: 2,
      statsThrough: null,
      preparedAt: new Date(boundary - 1),
    });
    expect(() => clock.check(new Date(boundary))).toThrow();
  });

  it("rejects newly eligible historical games at the conservative final-time boundary", () => {
    const boundary = kickoffAt.getTime() + 4 * 3_600_000;
    const clock = projectionPublicationClockGuard({
      schedules: [{ ...game, status: "final", awayScore: 10, homeScore: 17 }],
      season: 2026,
      week: 2,
      statsThrough: null,
      preparedAt: new Date(boundary - 1),
    });
    expect(() => clock.check(new Date(boundary))).toThrow();
  });

  it("rejects nonfinite or backwards clocks instead of backdating a publication", () => {
    const start = new Date("2026-09-10T12:00:00Z");
    expect(() => guard(new Date(Number.NaN))).toThrow();
    expect(() => guard(start).check(new Date(Number.NaN))).toThrow();
    const clock = guard(start);
    clock.check(new Date(start.getTime() + 1000));
    expect(() => clock.check(start)).toThrow();
  });
});

function playerEvaluation(
  input: {
    readonly samples?: number;
    readonly mae?: number;
    readonly baselineMae?: number;
    readonly rmse?: number;
    readonly baselineRmse?: number;
  } = {},
): FirstPartyScoredBacktestEvaluation {
  const overall = {
    samples: input.samples ?? 500,
    centerAdjustment: 0,
    lowerError: -3,
    upperError: 4,
    mae: input.mae ?? 5,
    rmse: input.rmse ?? 7,
    bias: 0,
    baselineMae: input.baselineMae ?? 5.2,
    baselineRmse: input.baselineRmse ?? 7.2,
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
      ...Object.fromEntries(
        (["RB", "WR", "TE"] as const).map((position) => [
          position,
          {
            ...overall,
            starterMeanQuality: {
              state: "available",
              cohort: "prior-baseline-position-rank",
              topPlayersPerWeek: { RB: 24, WR: 36, TE: 12 }[position],
              samples: overall.samples,
              mae: overall.mae,
              rmse: overall.rmse,
              baselineRmse: overall.baselineRmse,
              bias: 0,
              biasLimit: overall.mae * 0.15,
              minimumSamples: 100,
              maximumRelativeBias: 0.15,
            },
          },
        ]),
      ),
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
    readonly rmse?: number;
    readonly baselineRmse?: number;
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
      rmse: input.rmse ?? 6,
      bias: 0,
      baselineMae: input.baselineMae ?? 4.1,
      baselineRmse: input.baselineRmse ?? 6.2,
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

  it("invalidates pre-correction history assembly caches even with identical source bytes", () => {
    const input = {
      season: 2026,
      firstTargetWeek: 4,
      playerHistory: [],
      defenseHistory: [],
    } as const;
    const legacyIdentity = {
      modelVersion: FIRST_PARTY_PROJECTION_MODEL_VERSION,
      sourceSchemaVersion: 7,
      ...input,
    };
    const current = projectionTrainingCacheKey(input);
    expect(current).not.toBe(projectionInputChecksum(legacyIdentity));
    expect(current).not.toBe(
      projectionInputChecksum({
        ...legacyIdentity,
        playerHistoryVersion: FIRST_PARTY_PLAYER_HISTORY_VERSION,
      }),
    );
  });

  it("keys fits by every exact prior history field, preserving order and duplicates", () => {
    const input = {
      season: 2026,
      firstTargetWeek: 4,
      playerHistory: [
        {
          playerId: "player",
          position: "WR",
          season: 2025,
          week: 3,
          team: "BUF",
          opponent: "MIA",
          components: { receiving_yards: 80 },
          status: "active" as const,
          played: true,
          snapShare: 0.8,
          targetShare: 0.2,
        },
      ],
      defenseHistory: [
        {
          team: "MIA",
          opponent: "BUF",
          season: 2025,
          week: 3,
          components: { defensive_points_allowed: 20 },
          played: true,
        },
      ],
    };
    const original = projectionTrainingCacheKey(input);
    for (const patch of [
      { position: "TE" },
      { status: "out" as const },
      { played: false },
      { snapShare: 0.5 },
      { targetShare: 0.3 },
      { opponent: "NYJ" },
      { components: { receiving_yards: 81 } },
    ])
      expect(
        projectionTrainingCacheKey({
          ...input,
          playerHistory: [{ ...input.playerHistory[0]!, ...patch }],
        }),
      ).not.toBe(original);
    for (const patch of [
      { opponent: "NYJ" },
      { played: false },
      { components: { defensive_points_allowed: 21 } },
    ])
      expect(
        projectionTrainingCacheKey({
          ...input,
          defenseHistory: [{ ...input.defenseHistory[0]!, ...patch }],
        }),
      ).not.toBe(original);
    expect(projectionTrainingCacheKey({ ...input, firstTargetWeek: 5 })).not.toBe(original);
    expect(projectionTrainingCacheKey({ ...input, season: 2027 })).not.toBe(original);
    expect(
      projectionTrainingCacheKey({
        ...input,
        playerHistory: [...input.playerHistory, input.playerHistory[0]!],
      }),
    ).not.toBe(original);
    const second = { ...input.playerHistory[0]!, playerId: "second" };
    expect(
      projectionTrainingCacheKey({ ...input, playerHistory: [input.playerHistory[0]!, second] }),
    ).not.toBe(
      projectionTrainingCacheKey({ ...input, playerHistory: [second, input.playerHistory[0]!] }),
    );
    expect(
      projectionTrainingCacheKey({
        ...input,
        playerHistory: structuredClone(input.playerHistory),
      }),
    ).toBe(original);
    const sourceOnlyChange = {
      ...input,
      statisticalSources: [{ key: "current", checksum: "new" }],
      historicalRolesChecksum: "new",
      playerPositions: [{ id: "unrelated", position: "TE" }],
    };
    expect(projectionTrainingCacheKey(sourceOnlyChange)).toBe(original);
  });

  it("canonicalizes component property order without dropping values", () => {
    const input = {
      season: 2026,
      firstTargetWeek: 2,
      defenseHistory: [],
      playerHistory: [
        {
          playerId: "player",
          position: "WR",
          season: 2025,
          week: 3,
          team: "BUF",
          components: { receiving_yards: 80, receptions: 5 },
        },
      ],
    };
    expect(projectionTrainingCacheKey(input)).toBe(
      projectionTrainingCacheKey({
        ...input,
        playerHistory: [
          { ...input.playerHistory[0]!, components: { receptions: 5, receiving_yards: 80 } },
        ],
      }),
    );
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

  it("uses Yahoo numeric crosswalks for compound roster keys across NFL seasons", () => {
    const rows = [
      { playerId: "canonical", source: "sleeper-yahoo", externalId: "26686" },
      { playerId: "old-roster", source: "yahoo", externalId: "461.p.26686" },
      { playerId: "current-roster", source: "yahoo", externalId: "470.p.26686" },
      { playerId: "nfl-roster", source: "yahoo", externalId: "nfl.p.26686" },
    ];
    const matches = projectionProviderCanonicalMatches(rows);
    expect([...matches]).toEqual([
      ["old-roster", "canonical"],
      ["current-roster", "canonical"],
      ["nfl-roster", "canonical"],
    ]);
    expect(
      canonicalProjectionPlayerId({
        playerId: "current-roster",
        hasGsisId: false,
        explicitMatchId: matches.get("current-roster") ?? null,
        exactMatchId: "different-name-match",
      }),
    ).toBe("canonical");
  });

  it("retains conflicting crosswalks in either order without falling back to names", () => {
    const rows = [
      { playerId: "canonical-a", source: "sleeper-yahoo", externalId: "26686" },
      { playerId: "canonical-b", source: "sleeper-yahoo", externalId: "470.p.26686" },
      { playerId: "alias", source: "yahoo", externalId: "470.p.26686" },
    ];
    for (const input of [rows, [...rows].reverse()]) {
      const matches = projectionProviderCanonicalMatches(input);
      expect(matches.get("alias")).toBeNull();
      expect(
        canonicalProjectionPlayerId({
          playerId: "alias",
          hasGsisId: false,
          explicitMatchId: matches.get("alias") ?? null,
          exactMatchId: "canonical-a",
        }),
      ).toBeUndefined();
      expect(
        canonicalProjectionPlayerId({
          playerId: "already-canonical",
          hasGsisId: true,
          explicitMatchId: matches.get("alias") ?? null,
        }),
      ).toBe("already-canonical");
    }
  });

  it("accepts repeated crosswalks to the same player and rejects conflicting status evidence", () => {
    const rows = [
      { playerId: "canonical", source: "sleeper-yahoo", externalId: "26686" },
      { playerId: "canonical", source: "sleeper-yahoo", externalId: "nfl.p.26686" },
      { playerId: "alias", source: "yahoo", externalId: "470.p.26686" },
    ];
    expect(projectionProviderCanonicalMatches(rows).get("alias")).toBe("canonical");
    expect(
      projectionProviderCanonicalMatches(rows, new Map([["alias", "another-player"]])).get("alias"),
    ).toBeNull();
  });

  it("retains direct and league-scoped ESPN crosswalk behavior", () => {
    const rows = [
      { playerId: "canonical", source: "sleeper-espn", externalId: "provider-7" },
      { playerId: "direct", source: "espn", externalId: "provider-7" },
      {
        playerId: "scoped",
        source: "espn-self-asserted",
        externalId: "10000000-0000-4000-8000-000000000001:provider-7",
      },
    ];
    expect(projectionProviderCanonicalMatches(rows)).toEqual(
      new Map([
        ["direct", "canonical"],
        ["scoped", "canonical"],
      ]),
    );
    expect(projectionProviderCanonicalMatches(rows.slice(1)).get("scoped")).toBe("direct");
  });

  it("does not hide malformed Yahoo crosswalk evidence behind a display name", () => {
    const matches = projectionProviderCanonicalMatches([
      { playerId: "alias", source: "yahoo", externalId: "nba.p.26686" },
      { playerId: "canonical", source: "sleeper-yahoo", externalId: "26686" },
    ]);
    expect(matches.get("alias")).toBeNull();
    expect(
      canonicalProjectionPlayerId({
        playerId: "alias",
        hasGsisId: false,
        explicitMatchId: matches.get("alias") ?? null,
        exactMatchId: "canonical",
      }),
    ).toBeUndefined();
  });

  it("does not replace an ambiguous ESPN crosswalk with the direct-provider fallback", () => {
    const rows = [
      { playerId: "canonical-a", source: "sleeper-espn", externalId: "provider-7" },
      { playerId: "canonical-b", source: "sleeper-espn", externalId: "provider-7" },
      { playerId: "direct", source: "espn", externalId: "provider-7" },
      {
        playerId: "scoped",
        source: "espn-self-asserted",
        externalId: "10000000-0000-4000-8000-000000000001:provider-7",
      },
    ];
    for (const input of [rows, [...rows].reverse()]) {
      const matches = projectionProviderCanonicalMatches(input);
      expect(matches.get("direct")).toBeNull();
      expect(matches.get("scoped")).toBeNull();
      expect(
        canonicalProjectionPlayerId({
          playerId: "scoped",
          hasGsisId: false,
          explicitMatchId: matches.get("scoped") ?? null,
          exactMatchId: "canonical-a",
        }),
      ).toBeUndefined();
    }
  });

  it("does not override unknown or conflicting status GSIS with a provider or name match", () => {
    const known = new Map([["00-0000001", "canonical"]]);
    const rows = [
      { playerId: "alias", gsisId: "00-0000001" },
      { playerId: "alias", gsisId: "00-0000002" },
    ];
    for (const input of [rows, [...rows].reverse(), rows.slice(1)]) {
      const status = projectionStatusCanonicalMatches(input, known);
      const matches = projectionProviderCanonicalMatches(
        [
          { playerId: "alias", source: "yahoo", externalId: "470.p.26686" },
          { playerId: "canonical", source: "sleeper-yahoo", externalId: "26686" },
        ],
        status,
      );
      expect(matches.get("alias")).toBeNull();
      expect(
        canonicalProjectionPlayerId({
          playerId: "alias",
          hasGsisId: false,
          explicitMatchId: matches.get("alias") ?? null,
          exactMatchId: "canonical",
        }),
      ).toBeUndefined();
    }
    expect(projectionStatusCanonicalMatches([rows[0]!, rows[0]!], known).get("alias")).toBe(
      "canonical",
    );
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
        player: playerEvaluation({ rmse: 7.4, baselineRmse: 7 }),
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

  it("admits an expected mean that improves squared loss despite higher absolute loss", () => {
    // Y is 0 with probability .9 and 20 with probability .1: mean 2, median 0.
    // Mean loss: MSE 36 / MAE 3.6. Median loss: MSE 40 / MAE 2.
    const expectedMean = playerEvaluation({
      mae: 3.6,
      baselineMae: 2,
      rmse: 6,
      baselineRmse: Math.sqrt(40),
    });
    const input = {
      player: expectedMean,
      defense: defenseEvaluation(),
      playerPredictions: 500,
      defensePredictions: 250,
    };
    expect(projectionModelGate(input).state).toBe("publishable");
    expect(
      projectionModelGate({
        ...input,
        player: playerEvaluation({
          mae: 2,
          baselineMae: 3.6,
          rmse: Math.sqrt(40),
          baselineRmse: 6,
        }),
      }).state,
    ).toBe("degraded");
    expect(
      projectionModelGate({ ...input, defense: defenseEvaluation({ rmse: 7, baselineRmse: 6 }) })
        .reasons,
    ).toContain("defense_model_did_not_clear_recency_baseline");
  });

  it.each([0.1, 1, 10, 100])(
    "keeps admission invariant when fantasy-point units scale by %s",
    (scale) => {
      const player = playerEvaluation({
        mae: 30 * scale,
        baselineMae: 36 * scale,
        rmse: 40 * scale,
        baselineRmse: 45 * scale,
      });
      const transform = (value: (typeof player)["overall"]) => ({ ...value, bias: 1.5 * scale });
      const scaled = {
        ...player,
        overall: transform(player.overall),
        byPosition: Object.fromEntries(
          Object.entries(player.byPosition).map(([position, value]) => [
            position,
            transform(value),
          ]),
        ),
      };
      expect(
        projectionModelGate({
          player: scaled,
          defense: defenseEvaluation(),
          playerPredictions: 500,
          defensePredictions: 250,
        }).state,
      ).toBe("publishable");
      expect(
        projectionModelGate({
          player: { ...scaled, overall: { ...scaled.overall, bias: 4.6 * scale } },
          defense: defenseEvaluation(),
          playerPredictions: 500,
          defensePredictions: 250,
        }).state,
      ).toBe("degraded");
    },
  );

  it("fails closed on missing mean benchmarks and conditional starter mean regression", () => {
    const player = playerEvaluation();
    const gate = (next: FirstPartyScoredBacktestEvaluation) =>
      projectionModelGate({
        player: next,
        defense: defenseEvaluation(),
        playerPredictions: 500,
        defensePredictions: 250,
      });
    const { baselineRmse: originalBenchmark, ...legacy } = player.overall;
    expect(originalBenchmark).toBeGreaterThan(0);
    for (const baselineRmse of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const overall = baselineRmse === undefined ? legacy : { ...legacy, baselineRmse };
      expect(gate({ ...player, overall }).state).toBe("degraded");
    }
    const wr = player.byPosition.WR as WeeklyPointResidualCalibration;
    const missingStarter: WeeklyPointResidualCalibration = {
      ...wr,
      starterMeanQuality: undefined,
    };
    expect(
      gate({
        ...player,
        byPosition: { ...player.byPosition, WR: missingStarter },
      }).state,
    ).toBe("rejected");
    const regressed: WeeklyPointResidualCalibration = {
      ...wr,
      starterMeanQuality: {
        ...wr.starterMeanQuality!,
        rmse: wr.starterMeanQuality!.baselineRmse! + 1,
      },
    };
    expect(
      gate({ ...player, byPosition: { ...player.byPosition, WR: regressed } }).reasons,
    ).toContain("player_wr_starter_did_not_clear_recency_baseline");
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

  it("uses raw magnitude for affine intervals and refuses a missing raw forecast", () => {
    const calibration: WeeklyPointResidualCalibration = {
      ...playerEvaluation().overall,
      pointPolicy: {
        version: WEEKLY_POINT_CALIBRATION_POLICY_VERSION,
        slope: 0.5,
        intercept: 2,
        intervalScale: "sqrt-absolute-raw",
        lowerNormalizedError: -1,
        upperNormalizedError: 2,
        trainingSamples: 100,
        intervalSamples: 100,
      },
    };
    expect(leagueScoredMean(16, calibration)).toBe(10);
    expect(leagueScoredInterval(10, calibration, 16)).toEqual({ floor: 6, ceiling: 18 });
    expect(() => leagueScoredInterval(10, calibration)).toThrow("raw scored forecast");
    expect(() => leagueScoredInterval(16, calibration, 16)).toThrow("does not match");
    const profile = { id: "receiving", rules: [{ statId: "receiving_yards", points: 1 }] };
    const row = {
      playerId: "wr",
      mean: 20,
      floor: 18,
      ceiling: 22,
      confidence: 0.95,
      components: { receiving_yards: 16 },
    };
    const corrected = rescoreFrozenProjection(row, profile, calibration, "WR");
    expect(corrected).toMatchObject({ mean: 10, floor: 6, ceiling: 18, confidence: 0.49 });
    expect(corrected.components).toBe(row.components);
    const locked = { ...row, scoringProfileKey: projectionScoringProfileKey(profile) };
    expect(rescoreFrozenProjection(locked, profile, calibration, "WR")).toMatchObject({
      mean: 20,
      floor: 18,
      ceiling: 22,
      confidence: 0.49,
    });
    // Legacy policy metadata must not bypass the new conditional-evidence requirement.
    expect(
      rescoreFrozenProjection(locked, profile, playerEvaluation().overall, "WR").confidence,
    ).toBe(0.49);
    const zero = {
      ...locked,
      mean: 0,
      floor: 0,
      ceiling: 0,
      confidence: 1,
      components: { receiving_yards: 0 },
    };
    expect(rescoreFrozenProjection(zero, profile, calibration, "WR")).toEqual(zero);
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

  it("keeps a locked forecast unchanged when new residuals arrive under the same scoring rules", () => {
    const profile = {
      id: "original",
      rules: [{ statId: "passing_touchdowns", points: 4 }],
    };
    const row = {
      playerId: "locked-player",
      mean: 9,
      floor: 6,
      ceiling: 13,
      confidence: 0.8,
      components: { passing_touchdowns: 2 },
      scoringProfileKey: projectionScoringProfileKey(profile),
    };

    expect(
      rescoreFrozenProjection(
        row,
        { ...profile, id: "same-rules-new-label" },
        { ...playerEvaluation().overall, centerAdjustment: -2, lowerError: -8, upperError: 10 },
      ),
    ).toEqual(row);
  });

  it("preserves a confirmed zero after kickoff even when scoring and position calibration change", () => {
    const row = {
      playerId: "inactive-player",
      mean: 0,
      floor: 0,
      ceiling: 0,
      confidence: 1,
      components: { passing_yards: 0, passing_touchdowns: 0 },
    };
    const rescored = rescoreFrozenProjection(
      row,
      { id: "corrected", rules: [{ statId: "passing_touchdowns", points: 6 }] },
      { ...playerEvaluation().overall, centerAdjustment: 2.5 },
    );

    expect(rescored).toMatchObject({ mean: 0, floor: 0, ceiling: 0, components: row.components });
  });

  it("requires frozen components for a new rule while ignoring other positions' scoring categories", () => {
    const frozen = {
      playerId: "locked-receiver",
      mean: 6,
      floor: 2,
      ceiling: 10,
      confidence: 0.8,
      components: { receiving_yards: 60 },
    };
    expect(
      frozenProjectionSupportsScoringProfile(
        frozen,
        {
          id: "yards-and-defense",
          rules: [
            { statId: "receiving_yards", points: 0.1 },
            { statId: "defensive_sacks", points: 1 },
          ],
        },
        "WR",
      ),
    ).toBe(true);
    expect(
      frozenProjectionSupportsScoringProfile(
        frozen,
        {
          id: "new-ppr",
          rules: [
            { statId: "receiving_yards", points: 0.1 },
            { statId: "receptions", points: 1 },
          ],
        },
        "WR",
      ),
    ).toBe(false);
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
    expect(firstPartyDefensePlayerId("LA")).toBe(firstPartyDefensePlayerId("LAR"));
    expect(() => firstPartyDefensePlayerId("Chicago")).toThrow(/team code/u);
  });

  it("uses unambiguous current weekly-roster roles for two-way fantasy players", () => {
    const positions = effectiveFirstPartyProjectionPositions(
      [
        { id: "hunter", primaryPosition: "CB" },
        { id: "ordinary", primaryPosition: "RB" },
        { id: "conflict", primaryPosition: "TE" },
      ],
      [
        { playerId: "hunter", season: 2025, week: 18, position: "CB" },
        { playerId: "hunter", season: 2026, week: 1, position: "WR" },
        { playerId: "hunter", season: 2026, week: 1, position: "WR" },
        { playerId: "conflict", season: 2026, week: 1, position: "WR" },
        { playerId: "conflict", season: 2026, week: 1, position: "TE" },
      ],
      2026,
    );

    expect(positions.get("hunter")).toBe("WR");
    expect(positions.get("ordinary")).toBe("RB");
    expect(positions.get("conflict")).toBe("TE");
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
        // Distinct player roles prevent an affine calibrator from learning an artificial
        // constant outcome shared by every player in every week.
        const actual = spec.actual + (index * 1.5) / spec.pointsPerUnit;
        const predicted = actual - error / spec.pointsPerUnit;
        const baseline = actual - (error * 1.25) / spec.pointsPerUnit;
        predictions.push({
          playerId: `backtest-${position}-${index}`,
          position,
          season: BACKTEST_SEASON,
          week,
          predicted: { [spec.component]: predicted },
          baseline: { [spec.component]: baseline },
          floor: { [spec.component]: predicted - 40 / spec.pointsPerUnit },
          ceiling: { [spec.component]: predicted + 40 / spec.pointsPerUnit },
          actual: { [spec.component]: actual },
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

/** Most outcomes follow the recency center; symmetric outliers pull the squared-error slope away
 * from the MAE-optimal center. This exercises calibration selection without a physical-model fit. */
function meanVsMaeBacktestFixture(
  position: "RB" | "WR" | "TE" = "WR",
): FirstPartyProjectionBacktest {
  const source = playerBacktestFixture();
  const spec = BACKTEST_COMPONENT[position];
  const rows: FirstPartyBacktestPrediction[] = Array.from({ length: BACKTEST_WEEKS }, (_, week) =>
    Array.from({ length: 48 }, (_, player) => {
      const raw = 4 + player / 2;
      const noise = (((player * 17 + week * 11) % 47) / 46 - 0.5) * 2;
      const outlier = (player + week) % 3 === 0 ? -(raw - 15.75) * 1.5 : 0;
      return {
        playerId: `additive-${position}-${String(player).padStart(2, "0")}`,
        position,
        season: BACKTEST_SEASON,
        week: week + 1,
        predicted: { [spec.component]: raw / spec.pointsPerUnit },
        baseline: { [spec.component]: raw / spec.pointsPerUnit },
        actual: { [spec.component]: (raw + 1.25 + noise + outlier) / spec.pointsPerUnit },
        floor: {},
        ceiling: {},
        trainingRows: 48,
        calibrationRows: 48,
      };
    }),
  ).flat();
  return {
    ...source,
    predictions: [...source.predictions.filter((row) => row.position !== position), ...rows],
  };
}

/** A true unit slope with alternating noise correlation makes early affine fits overfit prior
 * batches. The prior-only additive candidate keeps the correct center without changing gates. */
function additiveRecencyBacktestFixture(
  position: "RB" | "WR" | "TE" = "WR",
): FirstPartyProjectionBacktest {
  const source = playerBacktestFixture();
  const spec = BACKTEST_COMPONENT[position];
  return {
    ...source,
    predictions: [
      ...source.predictions.filter((row) => row.position !== position),
      ...Array.from({ length: BACKTEST_WEEKS }, (_, week) =>
        Array.from({ length: 48 }, (_, player) => {
          const raw = 4 + player / 2;
          const noise = ((player % 8) - 3.5) * 0.5 * (week % 2 === 0 ? -1 : 1);
          return {
            playerId: `unit-slope-${position}-${String(player).padStart(2, "0")}`,
            position,
            season: BACKTEST_SEASON,
            week: week + 1,
            predicted: { [spec.component]: raw / spec.pointsPerUnit },
            baseline: { [spec.component]: raw / spec.pointsPerUnit },
            actual: { [spec.component]: (raw + noise) / spec.pointsPerUnit },
            floor: {},
            ceiling: {},
            trainingRows: 48,
            calibrationRows: 48,
          };
        }),
      ).flat(),
    ],
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
    positionTypes: null,
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
  readonly zeroPositions?: readonly string[];
  readonly modelMultiplier?: number;
  readonly previousRows?: ReadonlyMap<string, ScoredProjectionRow>;
  readonly leagueSeasonId?: string;
  readonly scoringEvidenceMemo?: FirstPartyPublicationEvidenceMemo;
}) {
  const playerBacktest = input.playerBacktest ?? playerBacktestFixture();
  const leagueSeasonId = input.leagueSeasonId ?? LEAGUE_SEASON_ID;
  return buildFirstPartyLeaguePublications({
    season: PUBLICATION_SEASON,
    week: PUBLICATION_WEEK,
    now: PUBLICATION_NOW,
    sourceAsOf: PUBLICATION_NOW,
    inputChecksum: "a".repeat(64),
    playerBacktest,
    basePlayerBacktest: playerBacktest,
    defenseBacktest: input.defenseBacktest ?? defenseBacktestFixture(),
    ...(input.scoringEvidenceMemo === undefined
      ? {}
      : { scoringEvidenceMemo: input.scoringEvidenceMemo }),
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
      { id: leagueSeasonId, provider: "espn", currentWeek: PUBLICATION_WEEK, teamCount: 12 },
    ],
    rules: input.rules.map((rule) => ({ ...rule, leagueSeasonId })),
    rosters: (input.rosters ?? []).map((entry) => ({
      leagueSeasonId,
      ...entry,
    })),
    publishedPlayers: BACKTEST_POSITIONS.map((position) => {
      const player = publishedPlayerFixture(position, PUBLICATION_TEAMS[0], {
        gameStarted: input.startedPositions?.includes(position) ?? false,
      });
      if (input.zeroPositions?.includes(position)) {
        const zero = {
          ...player.baselineProjection,
          state: "zero" as const,
          components: Object.fromEntries(
            Object.keys(player.baselineProjection.components).map((key) => [key, 0]),
          ),
          quality: { ...player.baselineProjection.quality, confidence: 1 },
        };
        return { ...player, projection: zero, modelProjection: zero, baselineProjection: zero };
      }
      return input.modelMultiplier === undefined
        ? player
        : {
            ...player,
            modelProjection: {
              ...player.modelProjection,
              components: Object.fromEntries(
                Object.entries(player.modelProjection.components).map(([component, value]) => [
                  component,
                  value * input.modelMultiplier!,
                ]),
              ),
            },
          };
    }),
    publishedDefenses: PUBLICATION_TEAMS.map((team) => publishedDefenseFixture(team)),
    previousRowsByLeague:
      input.previousRows === undefined
        ? new Map()
        : new Map([[leagueSeasonId, input.previousRows]]),
  });
}

const DEFENSE_ROW_IDS = new Set(PUBLICATION_TEAMS.map((team) => firstPartyDefensePlayerId(team)));

describe("weekly roster alias bijection", () => {
  const secondLeagueId = "20000000-0000-4000-8000-000000000002";
  const canonicalId = leaguePlayerId("RB");

  function planAliases(input: {
    readonly aliases: readonly {
      readonly playerId: string;
      readonly leagueSeasonScopes: readonly string[];
    }[];
    readonly rosters: readonly { readonly leagueSeasonId: string; readonly playerId: string }[];
    readonly reverse?: boolean;
  }) {
    const leagues = [...new Set(input.rosters.map((row) => row.leagueSeasonId))].map((id) => ({
      id,
      provider: "espn",
      currentWeek: PUBLICATION_WEEK,
      teamCount: 12,
    }));
    const backtest = playerBacktestFixture();
    const canonical = publishedPlayerFixture("RB", PUBLICATION_TEAMS[0]);
    const publishedPlayers = [
      ...BACKTEST_POSITIONS.map((position) =>
        publishedPlayerFixture(position, PUBLICATION_TEAMS[0]),
      ),
      ...input.aliases.map((alias) => ({ ...canonical, ...alias, canonicalMatchId: canonicalId })),
    ];
    return buildFirstPartyLeaguePublications({
      season: PUBLICATION_SEASON,
      week: PUBLICATION_WEEK,
      now: PUBLICATION_NOW,
      sourceAsOf: PUBLICATION_NOW,
      inputChecksum: "b".repeat(64),
      playerBacktest: backtest,
      basePlayerBacktest: backtest,
      defenseBacktest: defenseBacktestFixture(),
      players: PUBLICATION_TEAMS.map((team) => ({
        id: firstPartyDefensePlayerId(team),
        gsisId: null,
        fullName: `${team} D/ST`,
        nflTeam: team,
        primaryPosition: "D/ST",
        status: null,
        lastSeason: PUBLICATION_SEASON,
      })),
      leagues,
      rules: leagues.flatMap((league) =>
        DST_SUPPORTED_RULES.map((rule) => ({
          ...rule,
          leagueSeasonId: league.id,
        })),
      ),
      rosters: input.rosters.map((row) => ({
        ...row,
        primaryPosition: "RB",
        nflTeam: PUBLICATION_TEAMS[0],
      })),
      publishedPlayers: input.reverse ? publishedPlayers.reverse() : publishedPlayers,
      publishedDefenses: PUBLICATION_TEAMS.map((team) => publishedDefenseFixture(team)),
      previousRowsByLeague: new Map(),
    });
  }

  it.each([false, true])(
    "rejects both aliases of one NFL player in the same league (reversed=%s)",
    (reverse) => {
      const plan = planAliases({
        aliases: ["alias-a", "alias-b"].map((playerId) => ({
          playerId,
          leagueSeasonScopes: [LEAGUE_SEASON_ID],
        })),
        rosters: ["alias-a", "alias-b"].map((playerId) => ({
          playerId,
          leagueSeasonId: LEAGUE_SEASON_ID,
        })),
        reverse,
      });
      expect(plan.publications).toEqual([]);
      expect(plan.withheld).toEqual([
        {
          leagueSeasonId: LEAGUE_SEASON_ID,
          scope: "league",
          reasons: [
            "Roster identity is ambiguous for 2 players: multiple roster entries resolve to the same NFL player.",
          ],
        },
      ]);
    },
  );

  it("preserves separate league aliases for the same canonical player", () => {
    const plan = planAliases({
      aliases: [
        { playerId: "alias-a", leagueSeasonScopes: [LEAGUE_SEASON_ID] },
        { playerId: "alias-b", leagueSeasonScopes: [secondLeagueId] },
      ],
      rosters: [
        { playerId: "alias-a", leagueSeasonId: LEAGUE_SEASON_ID },
        { playerId: "alias-b", leagueSeasonId: secondLeagueId },
      ],
    });
    expect(plan.withheld).toEqual([]);
    expect(plan.publications).toHaveLength(2);
    for (const [league, alias, otherAlias] of [
      [LEAGUE_SEASON_ID, "alias-a", "alias-b"],
      [secondLeagueId, "alias-b", "alias-a"],
    ] as const) {
      const ids = plan.publications
        .find((entry) => entry.league.id === league)
        ?.rows.map((row) => row.playerId);
      expect(ids).toContain(alias);
      expect(ids).not.toContain(otherAlias);
      expect(ids).not.toContain(canonicalId);
    }
  });

  it("withholds only the colliding league in a shared multi-league plan", () => {
    const plan = planAliases({
      aliases: [
        { playerId: "alias-a", leagueSeasonScopes: [LEAGUE_SEASON_ID, secondLeagueId] },
        { playerId: "alias-b", leagueSeasonScopes: [LEAGUE_SEASON_ID] },
      ],
      rosters: [
        { playerId: "alias-a", leagueSeasonId: LEAGUE_SEASON_ID },
        { playerId: "alias-b", leagueSeasonId: LEAGUE_SEASON_ID },
        { playerId: "alias-a", leagueSeasonId: secondLeagueId },
      ],
    });
    expect(plan.publications.map((entry) => entry.league.id)).toEqual([secondLeagueId]);
    expect(plan.publications[0]?.rows.map((row) => row.playerId)).toContain("alias-a");
    expect(plan.withheld).toMatchObject([{ leagueSeasonId: LEAGUE_SEASON_ID, scope: "league" }]);
  });

  it("continues to reject a canonical player and its alias both on the roster", () => {
    const plan = planAliases({
      aliases: [{ playerId: "alias-a", leagueSeasonScopes: [LEAGUE_SEASON_ID] }],
      rosters: [canonicalId, "alias-a"].map((playerId) => ({
        playerId,
        leagueSeasonId: LEAGUE_SEASON_ID,
      })),
    });
    expect(plan.publications).toEqual([]);
    expect(plan.withheld).toMatchObject([
      {
        leagueSeasonId: LEAGUE_SEASON_ID,
        scope: "league",
        reasons: [expect.stringContaining("2 players")],
      },
    ]);
  });

  it("does not count repeated occurrences of the same roster ID as different aliases", () => {
    const plan = planAliases({
      aliases: [{ playerId: "alias-a", leagueSeasonScopes: [LEAGUE_SEASON_ID] }],
      rosters: [
        { playerId: "alias-a", leagueSeasonId: LEAGUE_SEASON_ID },
        { playerId: "alias-a", leagueSeasonId: LEAGUE_SEASON_ID },
      ],
    });
    expect(plan.withheld).toEqual([]);
    expect(plan.publications).toHaveLength(1);
    expect(plan.publications[0]?.rows.filter((row) => row.playerId === "alias-a")).toHaveLength(1);
  });
});

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
  it("adds qualified conditional intervals without changing the selected point policy or allowing higher confidence", () => {
    const backtest = playerBacktestFixture();
    const publication = planPublications({ rules: DST_SUPPORTED_RULES, playerBacktest: backtest })
      .publications[0]!;
    const candidates = evaluateFirstPartyPublicationCandidates(backtest, publication.profile);
    const receiver = publication.rows.find((row) => row.playerId === "player-wr")!;
    const interval = candidates.weeklyIntervals.WR!;
    expect(interval.state).toBe("applied");
    const calibration = candidates.liveCalibration.byPosition.WR!;
    const raw = receiver.components.receiving_yards! * 0.1;
    const expectedMean = leagueScoredMean(raw, calibration);
    const priorBounds = leagueScoredInterval(expectedMean, calibration, raw);
    const expected = applyWeeklyIntervalPolicy(
      raw,
      { mean: expectedMean, ...priorBounds },
      interval.policy,
    );
    expect(receiver).toMatchObject(expected);
    expect(receiver.confidence).toBeLessThanOrEqual(0.49);
    expect(receiver.pointPolicyVersion).toBe(WEEKLY_POINT_CALIBRATION_POLICY_VERSION);
    expect(receiver.intervalPolicyVersion).toBe(WEEKLY_INTERVAL_CALIBRATION_POLICY_VERSION);
    expect(storedWeeklyIntervalPolicyVersion(publication.metadata, receiver.playerId)).toBe(
      WEEKLY_INTERVAL_CALIBRATION_POLICY_VERSION,
    );
    expect(publication.metadata.weeklyIntervalCalibration).toMatchObject({
      evidenceStatus: "development-validated",
      confidenceCap: 0.49,
    });
    const oldSelected = evaluateWeeklyPointCalibration(
      applyFirstPartyProjectionChampionPolicy(backtest, publication.profile).backtest,
      publication.profile,
    );
    expect(candidates.adaptiveEvaluation).toEqual(oldSelected);
    expect(candidates.liveCalibration.byPosition.WR?.starterIntervalQuality).toEqual(
      candidates.playerEvaluation.byPosition.WR?.starterIntervalQuality,
    );
    expect(candidates.liveCalibration.byPosition.WR?.starterMeanQuality).toEqual(
      candidates.playerEvaluation.byPosition.WR?.starterMeanQuality,
    );
    expect(publication.metadata.livePointCalibration).toMatchObject({
      admissionLoss: "root-mean-squared-error",
      meanEvidenceSource: "locked-chronological-release-forecasts",
      byPosition: {
        WR: {
          rmse: candidates.playerEvaluation.byPosition.WR?.rmse,
          baselineRmse: candidates.playerEvaluation.byPosition.WR?.baselineRmse,
          starterMeanQuality: candidates.playerEvaluation.byPosition.WR?.starterMeanQuality,
        },
      },
    });
    expect(storedWeeklyPointPolicyVersion(publication.metadata)).toBe(
      WEEKLY_POINT_CALIBRATION_POLICY_VERSION,
    );
  });

  it("preserves a conditional-mean warning and confidence cap when the interval overlay applies", () => {
    const memo = new FirstPartyPublicationEvidenceMemo();
    const original = memo.get.bind(memo);
    vi.spyOn(memo, "get").mockImplementation((...args) => {
      const result = original(...args);
      const calibration = result.candidates.liveCalibration.byPosition.WR!;
      const quality = calibration.starterMeanQuality!;
      return {
        ...result,
        candidates: {
          ...result.candidates,
          liveCalibration: {
            ...result.candidates.liveCalibration,
            byPosition: {
              ...result.candidates.liveCalibration.byPosition,
              WR: {
                ...calibration,
                starterMeanQuality: {
                  ...quality,
                  state: "miscalibrated",
                  bias: quality.mae,
                  qualityFlag: "uncalibrated_starter_means",
                },
              },
            },
          },
        },
      };
    });
    const publication = planPublications({ rules: DST_SUPPORTED_RULES, scoringEvidenceMemo: memo })
      .publications[0]!;
    const receiver = publication.rows.find((row) => row.playerId === "player-wr")!;
    expect(receiver.intervalPolicyVersion).toBe(WEEKLY_INTERVAL_CALIBRATION_POLICY_VERSION);
    expect(receiver.confidence).toBe(0.49);
    expect(publication.metadata.warnings).toEqual(
      expect.arrayContaining([
        "conditional_interval_development: WR forecast ranges use prior-only conditional residuals; advice confidence remains limited pending separate confirmation.",
        "uncalibrated_starter_means: WR point forecasts have insufficient or biased historical starter evidence; advice confidence is limited.",
      ]),
    );
    expect(publication.metadata.livePointCalibration).toMatchObject({
      byPosition: { WR: { starterMeanQuality: { qualityFlag: "uncalibrated_starter_means" } } },
    });
  });

  it("preserves deterministic zero/inactive/bye rows and their confidence when interval evidence qualifies", () => {
    const publication = planPublications({
      rules: DST_SUPPORTED_RULES,
      zeroPositions: ["RB", "WR", "TE"],
    }).publications[0]!;
    for (const position of ["rb", "wr", "te"]) {
      const player = publication.rows.find((row) => row.playerId === `player-${position}`)!;
      expect(player).toMatchObject({ mean: 0, floor: 0, ceiling: 0, confidence: 1 });
      expect(player.intervalPolicyVersion).toBeUndefined();
    }
  });

  it("retains a locked conditional interval and its conservative confidence despite a newly fitted policy", () => {
    const publication = planPublications({ rules: DST_SUPPORTED_RULES }).publications[0]!;
    const original = publication.rows.find((row) => row.playerId === "player-wr")!;
    const previous = {
      ...original,
      mean: 8,
      floor: 1,
      ceiling: 19,
      confidence: 0.32,
      scoringProfileKey: publication.profileKey,
      components: {
        ...Object.fromEntries(
          firstPartyProjectionComponentsForPosition("WR").map((key) => [key, 0]),
        ),
        ...original.components,
      },
    };
    const next = planPublications({
      rules: DST_SUPPORTED_RULES,
      startedPositions: ["WR"],
      previousRows: new Map([[previous.playerId, previous]]),
    }).publications[0]!;
    expect(next.rows.find((row) => row.playerId === previous.playerId)).toEqual(previous);
    expect(next.metadata.frozenIntervalPolicyVersions).toEqual({
      [previous.playerId]: WEEKLY_INTERVAL_CALIBRATION_POLICY_VERSION,
    });
    expect(next.metadata.intervalPolicyByPlayer).toMatchObject({
      [previous.playerId]: {
        origin: "frozen",
        version: WEEKLY_INTERVAL_CALIBRATION_POLICY_VERSION,
      },
    });
    const corrected = rescoreFrozenProjection(
      previous,
      { id: "changed", rules: [{ statId: "receiving_yards", points: 0.2 }] },
      playerEvaluation().overall,
      "WR",
    );
    expect(corrected.intervalPolicyVersion).toBeUndefined();
    expect(corrected.intervalPolicyPosition).toBeUndefined();
    expect(corrected.components).toBe(previous.components);
  });

  it("keeps a frozen interval's original role when current provider evidence changes the player role", () => {
    const publication = planPublications({ rules: DST_SUPPORTED_RULES }).publications[0]!;
    const previous = {
      ...publication.rows.find((row) => row.playerId === "player-rb")!,
      // The fixture's current player is now a WR; the locked forecast was generated as an RB.
      playerId: "player-wr",
      scoringProfileKey: publication.profileKey,
      confidence: 0.32,
    };
    expect(previous.intervalPolicyPosition).toBe("RB");
    const next = planPublications({
      rules: DST_SUPPORTED_RULES,
      startedPositions: ["WR"],
      previousRows: new Map([[previous.playerId, previous]]),
      playerBacktest: playerBacktestFixture({ omitPositions: ["RB"] }),
    }).publications[0]!;
    expect(next.rows.find((row) => row.playerId === previous.playerId)).toEqual(previous);
    expect(next.metadata.intervalPolicyByPlayer).toMatchObject({
      [previous.playerId]: {
        origin: "frozen",
        version: WEEKLY_INTERVAL_CALIBRATION_POLICY_VERSION,
        position: "RB",
      },
    });
    expect(next.metadata.weeklyIntervalCalibration).not.toHaveProperty("byPosition.RB");
    const persisted = JSON.parse(JSON.stringify(next.metadata)) as Record<string, unknown>;
    const provenance = storedWeeklyIntervalPolicyProvenance(persisted, previous.playerId)!;
    expect(provenance).toEqual({
      version: WEEKLY_INTERVAL_CALIBRATION_POLICY_VERSION,
      position: "RB",
    });
    const restored = {
      ...previous,
      intervalPolicyVersion: provenance.version,
      intervalPolicyPosition: provenance.position,
    };
    const again = planPublications({
      rules: DST_SUPPORTED_RULES,
      startedPositions: ["WR"],
      previousRows: new Map([[restored.playerId, restored]]),
      playerBacktest: playerBacktestFixture({ omitPositions: ["RB"] }),
    }).publications[0]!;
    expect(again.rows.find((row) => row.playerId === previous.playerId)).toEqual(previous);
    expect(storedWeeklyIntervalPolicyProvenance(again.metadata, previous.playerId)).toEqual(
      provenance,
    );
  });

  it("does not invent an interval role for a legacy frozen row with missing provenance", () => {
    const publication = planPublications({ rules: DST_SUPPORTED_RULES }).publications[0]!;
    const previous = {
      ...publication.rows.find((row) => row.playerId === "player-wr")!,
      intervalPolicyPosition: undefined,
      scoringProfileKey: publication.profileKey,
      confidence: 0.32,
    };
    const next = planPublications({
      rules: DST_SUPPORTED_RULES,
      startedPositions: ["WR"],
      previousRows: new Map([[previous.playerId, previous]]),
    }).publications[0]!;
    expect(next.rows.find((row) => row.playerId === previous.playerId)).toEqual(previous);
    expect(next.metadata.intervalPolicyByPlayer).not.toHaveProperty(previous.playerId);
  });

  it("includes frozen point-policy provenance in the publication identity while preserving locked points", () => {
    const first = planPublications({ rules: DST_SUPPORTED_RULES }).publications[0];
    if (first === undefined) throw new Error("Missing publication fixture");
    const receiver = first.rows.find((row) => row.playerId === "player-wr");
    if (receiver === undefined) throw new Error("Missing receiver fixture");
    const row = {
      ...receiver,
      confidence: 0.49,
      scoringProfileKey: first.profileKey,
      components: {
        ...Object.fromEntries(
          firstPartyProjectionComponentsForPosition("WR").map((key) => [key, 0]),
        ),
        ...receiver.components,
      },
    };
    const current = planPublications({
      rules: DST_SUPPORTED_RULES,
      startedPositions: ["WR"],
      previousRows: new Map([
        [row.playerId, { ...row, pointPolicyVersion: WEEKLY_POINT_CALIBRATION_POLICY_VERSION }],
      ]),
    }).publications[0];
    const legacy = planPublications({
      rules: DST_SUPPORTED_RULES,
      startedPositions: ["WR"],
      previousRows: new Map([[row.playerId, { ...row, pointPolicyVersion: "unknown" }]]),
    }).publications[0];
    expect(current?.rows.find((entry) => entry.playerId === row.playerId)).toMatchObject({
      mean: row.mean,
      floor: row.floor,
      ceiling: row.ceiling,
      confidence: 0.49,
    });
    expect(legacy?.rows.find((entry) => entry.playerId === row.playerId)).toMatchObject({
      mean: row.mean,
      floor: row.floor,
      ceiling: row.ceiling,
      confidence: 0.49,
    });
    expect(current?.inputChecksum).not.toBe(legacy?.inputChecksum);
    expect(legacy?.metadata.frozenPointPolicyVersions).toEqual({ "player-wr": "unknown" });
    expect(legacy?.metadata.livePointCalibration).toMatchObject({ byPosition: { WR: null } });
    expect(storedWeeklyPointPolicyVersion(legacy?.metadata)).toBe(
      WEEKLY_POINT_CALIBRATION_POLICY_VERSION,
    );
  });

  it("refuses legacy live forecasts missing a newly priced long-TD component without losing unaffected positions", () => {
    const source = playerBacktestFixture();
    const completeHistory = {
      ...source,
      predictions: source.predictions.map((row) => ({
        ...row,
        predicted: { ...row.predicted, receiving_touchdowns_40_plus: 0 },
        baseline: { ...row.baseline, receiving_touchdowns_40_plus: 0 },
        actual: { ...row.actual, receiving_touchdowns_40_plus: 0 },
      })),
    };
    const plan = planPublications({
      rules: [...DST_SUPPORTED_RULES, espnRule("45", 2)],
      playerBacktest: completeHistory,
    });
    // Receiving-only bonus evidence is required for RB/WR/TE; QB does not model that family.
    expect(plan.publications[0]?.metadata.publishedPositions).toEqual(["QB", "K", "DST"]);
    expect(plan.withheld.flatMap((entry) => entry.positions ?? [])).toContainEqual({
      position: "WR",
      source: "component-coverage",
      reasons: ["Current player forecasts are missing required long-touchdown event evidence."],
    });
  });

  it("publishes useful points with cautious confidence when starter intervals lack enough evidence", () => {
    const source = playerBacktestFixture();
    const receiverRows: FirstPartyBacktestPrediction[] = Array.from({ length: 3 }, (_, week) =>
      Array.from({ length: 100 }, (_, player) => ({
        playerId: `receiver-${String(player).padStart(3, "0")}`,
        position: "WR" as const,
        season: BACKTEST_SEASON,
        week: week + 1,
        predicted: { receiving_yards: 100 },
        baseline: { receiving_yards: 100 },
        actual: { receiving_yards: 100 + (((player * 37) % 100) - 49.5) / 2.5 },
        floor: {},
        ceiling: {},
        trainingRows: 48,
        calibrationRows: 48,
      })),
    ).flat();
    const plan = planPublications({
      rules: DST_SUPPORTED_RULES,
      playerBacktest: {
        ...source,
        predictions: [
          ...source.predictions.filter((row) => row.position !== "WR"),
          ...receiverRows,
        ],
      },
    });
    const publication = plan.publications[0];
    expect(publication?.metadata.publishedPositions).toContain("WR");
    const receiver = publication?.rows.find((row) => row.playerId === "player-wr");
    expect(receiver?.mean).toBeGreaterThan(0);
    expect(receiver?.confidence).toBe(0.49);
    expect(receiver?.pointPolicyVersion).toBe(WEEKLY_POINT_CALIBRATION_POLICY_VERSION);
    expect(publication?.metadata.livePointCalibration).toMatchObject({
      policyVersion: WEEKLY_POINT_CALIBRATION_POLICY_VERSION,
      byPosition: {
        WR: {
          starterIntervalQuality: {
            state: "insufficient",
            samples: 72,
            qualityFlag: "uncalibrated_starter_intervals",
          },
        },
      },
    });
    expect(publication?.metadata.weeklyIntervalCalibration).toMatchObject({
      byPosition: { WR: { state: "retained" } },
    });
    expect(receiver?.intervalPolicyVersion).toBeUndefined();
    expect(publication?.metadata.warnings).toContain(
      "uncalibrated_starter_intervals: WR forecast ranges have insufficient or unreliable historical starter coverage; advice confidence is limited.",
    );
  });

  it("publishes a separately qualified constant recency candidate when the adaptive strategy loses", () => {
    const source = playerBacktestFixture();
    const backtest = {
      ...source,
      predictions: source.predictions.map((prediction) => {
        if (prediction.position !== "WR") return prediction;
        const actual = prediction.actual.receiving_yards!;
        const error = actual - prediction.predicted.receiving_yards!;
        return {
          ...prediction,
          predicted: { receiving_yards: actual - error * (prediction.week <= 12 ? 0.1 : 4) },
        };
      }),
    };
    const plan = planPublications({
      rules: DST_SUPPORTED_RULES,
      playerBacktest: backtest,
      modelMultiplier: 2,
    });
    const publication = plan.publications[0]!;
    expect(publication.metadata.publishedPositions).toContain("WR");
    const evidence = publication.metadata.publicationCandidateEvidence as {
      position: string;
      selected: string;
      adaptive: { mae: number; baselineMae: number };
      fixedRecency: { mae: number; baselineMae: number; intervalCoverage: number };
    }[];
    const receiver = evidence.find((row) => row.position === "WR")!;
    expect(receiver.selected).toBe("fixed-recency");
    expect(receiver.adaptive.mae).toBeGreaterThan(receiver.adaptive.baselineMae);
    expect(receiver.fixedRecency.mae).toBeLessThanOrEqual(receiver.fixedRecency.baselineMae);
    expect(receiver.fixedRecency.intervalCoverage).toBeGreaterThanOrEqual(0.62);
    expect(receiver.fixedRecency.intervalCoverage).toBeLessThanOrEqual(0.78);
    expect(publication.rows.find((row) => row.playerId === "player-wr")?.components).toEqual({
      receiving_yards: BACKTEST_COMPONENT.WR.actual,
    });
    expect(evidence.find((row) => row.position === "RB")?.selected).toBe("adaptive-champion");
  });

  it("does not let a hindsight model winner or its residuals change the constant candidate's evidence", () => {
    const source = playerBacktestFixture();
    const profile = { id: "receiving-yards", rules: [{ statId: "receiving_yards", points: 0.1 }] };
    const original = evaluateFirstPartyPublicationCandidates(source, profile);
    const perfectModel = evaluateFirstPartyPublicationCandidates(
      {
        ...source,
        predictions: source.predictions.map((prediction) => ({
          ...prediction,
          predicted: prediction.actual,
        })),
      },
      profile,
    );
    const direct = evaluateWeeklyPointCalibration(
      {
        ...source,
        predictions: source.predictions.map((prediction) => ({
          ...prediction,
          predicted: prediction.baseline,
        })),
      },
      profile,
    );
    expect(perfectModel.fixedRecencyEvaluation).toEqual(original.fixedRecencyEvaluation);
    expect(original.fixedRecencyEvaluation).toEqual(direct);
    expect(perfectModel.additiveRecencyEvaluation).toEqual(original.additiveRecencyEvaluation);
    expect(original.additiveRecencyEvaluation).toEqual(
      evaluateWeeklyPointCalibration(
        {
          ...source,
          predictions: source.predictions.map((row) => ({ ...row, predicted: row.baseline })),
        },
        profile,
        { centerStrategyByPosition: { RB: "additive", WR: "additive", TE: "additive" } },
      ),
    );
  });

  it.each(["RB", "WR", "TE"] as const)(
    "retains a qualified affine expected mean for %s when the additive center only improves MAE",
    (position) => {
      const backtest = meanVsMaeBacktestFixture(position);
      const snapshot = structuredClone(backtest);
      const spec = BACKTEST_COMPONENT[position];
      const profile = {
        id: "additive-candidate",
        rules: [{ statId: spec.component, points: spec.pointsPerUnit }],
      };
      const candidates = evaluateFirstPartyPublicationCandidates(backtest, profile);
      const adaptive = candidates.adaptiveEvaluation.byPosition[position]!;
      const affine = candidates.fixedRecencyEvaluation.byPosition[position]!;
      const additive = candidates.additiveRecencyEvaluation.byPosition[position]!;
      expect(adaptive.mae).toBeGreaterThan(adaptive.baselineMae);
      expect(affine.mae).toBeGreaterThan(affine.baselineMae);
      expect(additive.mae).toBe(additive.baselineMae);
      expect(adaptive.rmse).toBeLessThan(adaptive.baselineRmse!);
      expect(affine.rmse).toBeLessThan(affine.baselineRmse!);
      expect(additive.rmse).toBe(additive.baselineRmse);
      expect(additive.intervalCoverage).toBeGreaterThanOrEqual(0.62);
      expect(additive.intervalCoverage).toBeLessThanOrEqual(0.78);
      expect(candidates.additiveRecencyPositions).not.toContain(position);
      expect(candidates.fixedRecencyPositions).not.toContain(position);
      expect(candidates.playerEvaluation.byPosition[position]).toEqual(adaptive);
      expect(candidates.liveCalibration.byPosition[position]?.pointPolicy?.slope).toBeLessThan(1);
      expect(backtest).toEqual(snapshot);
    },
  );

  it("publishes the selected additive center and its own intervals with explicit candidate evidence", () => {
    const backtest = additiveRecencyBacktestFixture();
    const plan = planPublications({
      rules: DST_SUPPORTED_RULES,
      playerBacktest: backtest,
      modelMultiplier: 2,
    });
    const publication = plan.publications[0]!;
    const row = publication.rows.find((candidate) => candidate.playerId === "player-wr")!;
    const candidates = evaluateFirstPartyPublicationCandidates(backtest, publication.profile);
    const calibration = candidates.liveCalibration.byPosition.WR!;
    const rawMean = BACKTEST_COMPONENT.WR.actual * BACKTEST_COMPONENT.WR.pointsPerUnit;
    const interval = applyWeeklyPointCalibration(rawMean, calibration);
    const overlay = candidates.weeklyIntervals.WR;
    const expected =
      overlay?.state === "applied"
        ? applyWeeklyIntervalPolicy(rawMean, interval, overlay.policy)
        : interval;
    expect(row.components).toEqual({ receiving_yards: BACKTEST_COMPONENT.WR.actual });
    expect(row).toMatchObject(expected);
    expect(row.mean).toBe(rawMean + calibration.centerAdjustment);
    expect(calibration.pointPolicy?.slope).toBe(1);
    expect(calibration.starterIntervalQuality).toEqual(
      candidates.playerEvaluation.byPosition.WR?.starterIntervalQuality,
    );
    expect(calibration.starterMeanQuality).toEqual(
      candidates.playerEvaluation.byPosition.WR?.starterMeanQuality,
    );
    expect(publication.metadata.publicationCandidateEvidence).toContainEqual({
      position: "WR",
      selected: "fixed-additive-recency",
      adaptive: candidates.adaptiveEvaluation.byPosition.WR,
      fixedRecency: candidates.fixedRecencyEvaluation.byPosition.WR,
      additiveRecency: candidates.additiveRecencyEvaluation.byPosition.WR,
    });
    expect(publication.metadata.livePointCalibration).toMatchObject({
      policyVersion: WEEKLY_POINT_CALIBRATION_POLICY_VERSION,
      byPosition: {
        WR: { pointPolicy: { version: WEEKLY_POINT_CALIBRATION_POLICY_VERSION, slope: 1 } },
      },
    });
  });

  it("withholds a position whose hindsight winner conceals a losing walk-forward strategy", () => {
    const source = playerBacktestFixture();
    const basePlayerBacktest = {
      ...source,
      predictions: source.predictions.map((prediction) => {
        if (prediction.position !== "WR") return prediction;
        const actual = prediction.actual.receiving_yards!;
        const error = actual - prediction.predicted.receiving_yards!;
        return {
          ...prediction,
          predicted: { receiving_yards: actual - error * (prediction.week <= 12 ? 1 / 6 : 1) },
          baseline: { receiving_yards: actual - error * (prediction.week <= 12 ? 5 / 6 : 1 / 6) },
        };
      }),
    };
    const profile = {
      id: "receiving-yards",
      rules: [{ statId: "receiving_yards", points: 0.1 }],
    };
    const champion = applyFirstPartyProjectionChampionPolicy(basePlayerBacktest, profile);
    const hindsight = evaluateWeeklyPointCalibration(
      applyFirstPartyProjectionFinalPolicy(basePlayerBacktest, champion.policy),
      profile,
    );
    const locked = evaluateWeeklyPointCalibration(champion.backtest, profile);
    expect(champion.policy.byPosition.WR?.strategy).toBe("first-party-model");
    expect(hindsight.byPosition.WR!.mae).toBeLessThan(hindsight.byPosition.WR!.baselineMae);
    expect(locked.byPosition.WR!.mae).toBeGreaterThan(locked.byPosition.WR!.baselineMae);
    const candidates = evaluateFirstPartyPublicationCandidates(basePlayerBacktest, profile);
    expect(candidates.liveCalibration.byPosition.WR).toEqual({
      ...hindsight.byPosition.WR,
      starterIntervalQuality: locked.byPosition.WR?.starterIntervalQuality,
      starterMeanQuality: locked.byPosition.WR?.starterMeanQuality,
    });
    expect(candidates.playerEvaluation.byPosition.WR).toEqual(locked.byPosition.WR);
    expect(candidates.fixedRecencyEvaluation.byPosition.WR!.mae).toBeLessThanOrEqual(
      candidates.fixedRecencyEvaluation.byPosition.WR!.baselineMae,
    );
    // A defended baseline MAE alone is insufficient: this regime change leaves its interval evidence
    // outside the unchanged coverage gate. Both strategies must therefore remain withheld.
    expect(candidates.fixedRecencyPositions).not.toContain("WR");

    const plan = planPublications({
      rules: DST_SUPPORTED_RULES,
      playerBacktest: basePlayerBacktest,
    });
    const publication = plan.publications[0];
    expect(publication).toBeDefined();
    expect(publication!.metadata.publishedPositions).not.toContain("WR");
    expect(publication!.metadata.publishedPositions).toContain("RB");
    expect(publication!.rows.some((row) => row.playerId === "player-wr")).toBe(false);
    expect(plan.withheld.flatMap((entry) => entry.positions ?? [])).toContainEqual({
      position: "WR",
      source: "backtest-gate",
      reasons: ["The WR league-scored backtest did not clear the recency-only baseline gate."],
    });
  });

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
    const evaluation = evaluateFirstPartyBacktestForScoringProfile(
      champion.backtest,
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
      rmse: kEvaluation.rmse,
      baselineRmse: kEvaluation.baselineRmse,
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
  it("accepts a rostered two-way player when a supported projection exists for that identity", () => {
    const plan = planPublications({
      rules: GARAGELY_SHAPED_RULES,
      rosters: FULL_ROSTER.map((entry) =>
        entry.playerId === "player-wr" ? { ...entry, primaryPosition: "CB" } : entry,
      ),
    });

    expect(plan.publications).toHaveLength(1);
    expect(plan.publications[0]?.rows.map((row) => row.playerId)).toContain("player-wr");
    expect(plan.withheld.some((entry) => entry.scope === "league")).toBe(false);
  });

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

describe("bounded weekly publication evidence memo", () => {
  function profile(multiplier = 1): ProjectionScoringProfile {
    return {
      id: "memo-league-a",
      label: "First league",
      version: "fixture-v1",
      rules: [
        { statId: "passing_yards", points: 0.04 * multiplier },
        { statId: "rushing_yards", points: 0.1 * multiplier },
        { statId: "receiving_yards", points: 0.1 * multiplier },
        { statId: "field_goals_made_0_39", points: 3 * multiplier },
        { statId: "defensive_sacks", points: multiplier },
      ],
    };
  }

  it("matches fresh scientific evaluation exactly on cold and semantic warm hits without retaining raw predictions", () => {
    const players = playerBacktestFixture();
    const defense = defenseBacktestFixture();
    const scoring = profile();
    const evaluated = evaluateFirstPartyPublicationCandidates(players, scoring);
    const { champion, ...compactCandidates } = evaluated;
    const expected = {
      candidates: { ...compactCandidates, champion: { policy: champion.policy } },
      player: evaluated.playerEvaluation,
      defense: evaluateFirstPartyTeamDefenseBacktestForScoringProfile(defense, scoring),
    };
    const memo = new FirstPartyPublicationEvidenceMemo();
    const cold = memo.get(players, defense, scoring);
    expect(cold).toStrictEqual(expected);
    const warm = memo.get(players, defense, {
      ...scoring,
      id: "memo-league-b",
      label: "A different league name",
      version: "fixture-v2",
      rules: [...scoring.rules].reverse(),
    });
    expect(warm).toBe(cold);
    expect(warm).toStrictEqual(expected);

    const rawInputs = new Set<object>([players, defense, players.predictions, defense.predictions]);
    const seen = new Set<object>();
    const retained: string[] = [];
    const inspect = (value: unknown, location: string): void => {
      if (value === null || typeof value !== "object" || seen.has(value)) return;
      seen.add(value);
      if (rawInputs.has(value)) retained.push(location);
      for (const [key, child] of Object.entries(value)) {
        const childLocation = `${location}.${key}`;
        if (key === "predictions") retained.push(childLocation);
        inspect(child, childLocation);
      }
    };
    inspect(cold, "evidence");
    expect(retained).toEqual([]);
    expect(cold.candidates.champion).not.toHaveProperty("backtest");
  });

  it("recomputes exact evidence when a scoring coefficient changes", () => {
    const players = playerBacktestFixture();
    const defense = defenseBacktestFixture();
    const memo = new FirstPartyPublicationEvidenceMemo();
    const original = memo.get(players, defense, profile());
    const changedProfile = profile(2);
    const changed = memo.get(players, defense, changedProfile);
    expect(changed).not.toBe(original);
    expect(changed.player.scoringProfileKey).not.toBe(original.player.scoringProfileKey);
    expect(changed.player.byPosition.WR?.mae).not.toBe(original.player.byPosition.WR?.mae);
    expect(changed.player).toStrictEqual(
      evaluateFirstPartyPublicationCandidates(players, changedProfile).playerEvaluation,
    );
    expect(changed.defense).toStrictEqual(
      evaluateFirstPartyTeamDefenseBacktestForScoringProfile(defense, changedProfile),
    );
    expect(memo.get(players, defense, profile())).toBe(original);
  });

  it("releases an invalidated generation without changing rebuilt evidence or another memo", () => {
    const players = playerBacktestFixture();
    const defense = defenseBacktestFixture();
    const memo = new FirstPartyPublicationEvidenceMemo();
    const other = new FirstPartyPublicationEvidenceMemo();
    const original = memo.get(players, defense, profile());
    const independent = other.get(players, defense, profile());
    memo.clear();
    const rebuilt = memo.get(players, defense, profile());
    expect(rebuilt).not.toBe(original);
    expect(rebuilt).toStrictEqual(original);
    expect(memo.get(players, defense, profile())).toBe(rebuilt);
    expect(other.get(players, defense, profile())).toBe(independent);
  });

  it("invalidates every stored profile when either immutable backtest reference changes", () => {
    const players = playerBacktestFixture();
    const defense = defenseBacktestFixture();
    const memo = new FirstPartyPublicationEvidenceMemo();
    const first = memo.get(players, defense, profile());
    const second = memo.get(players, defense, profile(2));
    const nextPlayers = {
      ...players,
      predictions: players.predictions.map((row) => ({
        ...row,
        actual: Object.fromEntries(
          Object.entries(row.actual).map(([component, value]) => [component, value + 10]),
        ),
      })),
    };
    const replacedFirst = memo.get(nextPlayers, defense, profile());
    const replacedSecond = memo.get(nextPlayers, defense, profile(2));
    expect(replacedFirst).not.toBe(first);
    expect(replacedSecond).not.toBe(second);
    expect(replacedFirst.player).not.toStrictEqual(first.player);
    expect(replacedFirst.player).toStrictEqual(
      evaluateFirstPartyPublicationCandidates(nextPlayers, profile()).playerEvaluation,
    );
    const nextDefense = {
      ...defense,
      predictions: defense.predictions.map((row) => ({
        ...row,
        actual: { ...row.actual, defensive_sacks: row.actual.defensive_sacks! + 2 },
      })),
    };
    const defenseFirst = memo.get(nextPlayers, nextDefense, profile());
    const defenseSecond = memo.get(nextPlayers, nextDefense, profile(2));
    expect(defenseFirst).not.toBe(replacedFirst);
    expect(defenseSecond).not.toBe(replacedSecond);
    expect(defenseFirst.defense).not.toStrictEqual(replacedFirst.defense);
    expect(defenseFirst.defense).toStrictEqual(
      evaluateFirstPartyTeamDefenseBacktestForScoringProfile(nextDefense, profile()),
    );
    // The memo retains only the current training pair, even if an older pair is requested again.
    expect(memo.get(players, defense, profile())).not.toBe(first);
  });

  it("evicts the least recently used profile within its configured capacity", () => {
    const players = playerBacktestFixture();
    const defense = defenseBacktestFixture();
    const memo = new FirstPartyPublicationEvidenceMemo(2);
    const first = memo.get(players, defense, profile());
    const second = memo.get(players, defense, profile(2));
    expect(memo.get(players, defense, profile())).toBe(first);
    memo.get(players, defense, profile(3));
    expect(memo.get(players, defense, profile())).toBe(first);
    const reloaded = memo.get(players, defense, profile(2));
    expect(reloaded).not.toBe(second);
    expect(reloaded).toStrictEqual(second);
  });

  it("reuses historical evidence across league, roster and kickoff changes while rebuilding exact current publication results", () => {
    const sourcePlayers = playerBacktestFixture();
    const sourceDefense = defenseBacktestFixture();
    const reads = { players: 0, defense: 0 };
    const players: FirstPartyProjectionBacktest = {
      ...sourcePlayers,
      get predictions() {
        reads.players += 1;
        return sourcePlayers.predictions;
      },
    };
    const defense: FirstPartyTeamDefenseBacktest = {
      ...sourceDefense,
      get predictions() {
        reads.defense += 1;
        return sourceDefense.predictions;
      },
    };
    const memo = new FirstPartyPublicationEvidenceMemo();
    const get = vi.spyOn(memo, "get");
    const common = { playerBacktest: players, defenseBacktest: defense, scoringEvidenceMemo: memo };
    const original = planPublications({
      ...common,
      rules: DST_SUPPORTED_RULES,
      rosters: FULL_ROSTER,
    });
    expect(original.publications).toHaveLength(1);
    expect(reads.players).toBeGreaterThan(0);
    expect(reads.defense).toBeGreaterThan(0);
    const coldReads = { ...reads };
    const secondLeague = "22222222-2222-4222-8222-222222222222";
    const cases = [
      {
        leagueSeasonId: secondLeague,
        rules: [...DST_SUPPORTED_RULES].reverse(),
        rosters: FULL_ROSTER,
      },
      { leagueSeasonId: secondLeague, rules: DST_SUPPORTED_RULES, rosters: PRE_DRAFT_ROSTER },
      {
        leagueSeasonId: secondLeague,
        rules: DST_SUPPORTED_RULES,
        rosters: PARTIALLY_SYNCED_ROSTER,
      },
      {
        leagueSeasonId: secondLeague,
        rules: DST_SUPPORTED_RULES,
        rosters: FULL_ROSTER,
        startedPositions: ["WR"],
      },
    ];
    const warmPlans = cases.map((changed) => planPublications({ ...common, ...changed }));
    expect(reads).toEqual(coldReads);
    expect(get).toHaveBeenCalledTimes(cases.length + 1);
    const firstEvidence = get.mock.results[0]?.value as unknown;
    for (const result of get.mock.results) expect(result.value).toBe(firstEvidence);
    expect(warmPlans[0]?.publications[0]?.league.id).toBe(secondLeague);
    expect(warmPlans[0]?.publications[0]?.profile.id).toBe(`league:${secondLeague}`);
    expect(warmPlans[1]?.publications[0]?.metadata.rosterCoverage).toBe("pre-draft");
    expect(warmPlans[2]?.publications).toEqual([]);
    expect(warmPlans[3]?.publications).toEqual([]);
    for (const [index, changed] of cases.entries()) {
      const cold = planPublications({
        playerBacktest: sourcePlayers,
        defenseBacktest: sourceDefense,
        scoringEvidenceMemo: new FirstPartyPublicationEvidenceMemo(),
        ...changed,
      });
      expect(warmPlans[index]).toStrictEqual(cold);
    }
    get.mockRestore();
  });

  it("rejects capacities that could disable the bound or grow beyond the supported limit", () => {
    for (const capacity of [0, -1, 33, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => new FirstPartyPublicationEvidenceMemo(capacity)).toThrow();
  });
});
