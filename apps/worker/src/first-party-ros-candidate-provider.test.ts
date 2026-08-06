import {
  evaluateFirstPartyRosChampionPolicy,
  normalizeLeagueScoringProfile,
  projectionScoringProfileKey,
  runFirstPartyProjectionBacktest,
  type FirstPartyRosChampionPolicy,
  type FirstPartyRosHeldOutForecast,
  type FirstPartyWeeklyStatLine,
  type ProjectionScoringProfile,
} from "@laces-out/projections";
import { describe, expect, it } from "vitest";

import {
  calibrateHistoricalRosAvailability,
  calibrateHistoricalRosKicker,
  calibrateHistoricalRosRole,
} from "./first-party-ros-backtest.js";
import {
  buildFirstPartyRosLeagueTarget,
  currentFantasyPlayerPool,
  enumerateFirstPartyRosScoringMatchedLeagues,
  firstPartyRosArtifactOwnedLeagues,
  firstPartyRosCandidateSourceKeys,
  type FirstPartyRosScoringRuleRow,
} from "./first-party-ros-candidate-provider.js";
import { firstPartyAvailableProjectionComponents } from "./first-party-projections.js";
import type { ProjectionScheduleFact } from "./first-party-projection-inputs.js";
import {
  firstPartyRosArtifactScoringProfile,
  firstPartyRosChampionArtifactChecksum,
  type FirstPartyRosChampionArtifactPayload,
  type FirstPartyRosRailPosition,
  type LoadedFirstPartyRosChampionArtifact,
} from "./first-party-ros-publication.js";
import type { FirstPartyRosWindow } from "./first-party-ros-projections.js";

const availableStatIds = firstPartyAvailableProjectionComponents();

function pprRule(
  statKey: string,
  points: string,
  overrides: Partial<FirstPartyRosScoringRuleRow> = {},
): FirstPartyRosScoringRuleRow {
  return {
    leagueSeasonId: "L1",
    statKey,
    providerStatId: null,
    operation: "multiply",
    points,
    thresholdLow: null,
    thresholdHigh: null,
    ...overrides,
  };
}

const pprRules: readonly FirstPartyRosScoringRuleRow[] = [
  pprRule("Receptions", "1"),
  pprRule("Receiving Yards", "0.1"),
  pprRule("Receiving Touchdowns", "6"),
  pprRule("Rushing Yards", "0.1"),
  pprRule("Rushing Touchdowns", "6"),
];

function espnRule(
  providerStatId: string,
  points: string,
  overrides: Partial<FirstPartyRosScoringRuleRow> = {},
): FirstPartyRosScoringRuleRow {
  return {
    leagueSeasonId: "L1",
    statKey: providerStatId,
    providerStatId,
    operation: "multiply",
    points,
    thresholdLow: null,
    thresholdHigh: null,
    ...overrides,
  };
}

/**
 * ESPN-shaped offense rules plus the two kicker bracket shapes the real leagues actually differ
 * on: the admitted catalog prices `field_goals_made_50_plus`, every synced ESPN league splits
 * 50-59 (198) from 60+ (201).
 */
const espnOffenseRules: readonly FirstPartyRosScoringRuleRow[] = [
  espnRule("53", "1"), // receptions
  espnRule("42", "0.1"), // receiving_yards
  espnRule("43", "6"), // receiving_touchdowns
  espnRule("24", "0.1"), // rushing_yards
  espnRule("25", "6"), // rushing_touchdowns
];
const espnAggregateKickerRules: readonly FirstPartyRosScoringRuleRow[] = [
  espnRule("80", "3"), // field_goals_made_0_39
  espnRule("77", "4"), // field_goals_made_40_49
  espnRule("74", "5"), // field_goals_made_50_plus
];
const espnSplitKickerRules: readonly FirstPartyRosScoringRuleRow[] = [
  espnRule("80", "3"),
  espnRule("77", "4"),
  espnRule("198", "5"), // field_goals_made_50_59
  espnRule("201", "6"), // field_goals_made_60_plus
];

function normalizedProfile(
  rules: readonly FirstPartyRosScoringRuleRow[],
  provider: string,
): ProjectionScoringProfile {
  const normalization = normalizeLeagueScoringProfile({
    id: "league:probe",
    label: "League scoring",
    rows: rules.map((rule) => ({
      provider,
      statKey: rule.statKey,
      providerStatId: rule.providerStatId,
      operation: rule.operation,
      points: rule.points,
      thresholdLow: rule.thresholdLow,
      thresholdHigh: rule.thresholdHigh,
    })),
    availableStatIds,
  });
  if (normalization.state !== "available") throw new Error("probe profile did not normalize");
  return normalization.profile;
}

function keyForRules(rules: readonly FirstPartyRosScoringRuleRow[], provider = "yahoo"): string {
  return projectionScoringProfileKey(normalizedProfile(rules, provider));
}

function withLeague(
  rules: readonly FirstPartyRosScoringRuleRow[],
  leagueSeasonId: string,
): readonly FirstPartyRosScoringRuleRow[] {
  return rules.map((rule) => ({ ...rule, leagueSeasonId }));
}

describe("enumerateFirstPartyRosScoringMatchedLeagues", () => {
  it("lets only the winning artifact reach candidate simulation", () => {
    const fullPprProfile = normalizedProfile(pprRules, "yahoo");
    const halfPprRows = pprRules.map((rule) =>
      rule.statKey === "Receptions" ? { ...rule, points: "0.5" } : rule,
    );
    const halfPprProfile = normalizedProfile(halfPprRows, "yahoo");
    const policy = ninePlusPolicy();
    const fullPprArtifact = artifact(policy, projectionScoringProfileKey(fullPprProfile));
    const halfPprArtifact = artifact(policy, projectionScoringProfileKey(halfPprProfile));
    const artifacts = [fullPprArtifact, halfPprArtifact];
    const leagues = [{ id: "L1", provider: "yahoo" }];

    const fullPprMatches = enumerateFirstPartyRosScoringMatchedLeagues({
      artifactScoringProfileKey: fullPprArtifact.scoringProfileKey,
      leagues,
      rules: halfPprRows,
      availableStatIds,
    }).matched;
    const halfPprMatches = enumerateFirstPartyRosScoringMatchedLeagues({
      artifactScoringProfileKey: halfPprArtifact.scoringProfileKey,
      leagues,
      rules: halfPprRows,
      availableStatIds,
    }).matched;

    expect(fullPprMatches).toHaveLength(1);
    expect(
      firstPartyRosArtifactOwnedLeagues({
        artifact: fullPprArtifact,
        artifacts,
        leagues: fullPprMatches,
      }),
    ).toEqual([]);
    expect(
      firstPartyRosArtifactOwnedLeagues({
        artifact: halfPprArtifact,
        artifacts,
        leagues: halfPprMatches,
      }).map((league) => league.leagueSeasonId),
    ).toEqual(["L1"]);
  });

  it("matches per position and never widens a mismatched or unnormalizable league", () => {
    const artifactKey = keyForRules(pprRules);
    const halfPprRules = pprRules.map((rule) =>
      rule.statKey === "Receptions"
        ? { ...rule, leagueSeasonId: "L2", points: "0.5" }
        : { ...rule, leagueSeasonId: "L2" },
    );
    const report = enumerateFirstPartyRosScoringMatchedLeagues({
      artifactScoringProfileKey: artifactKey,
      leagues: [
        { id: "L1", provider: "yahoo" },
        { id: "L2", provider: "yahoo" },
        { id: "L3", provider: "yahoo" },
      ],
      rules: [
        ...pprRules,
        ...halfPprRules,
        // L3 has no rules and cannot be normalized: excluded, never approximated.
      ],
      availableStatIds,
    });

    expect(report.matched.map((league) => league.leagueSeasonId)).toEqual(["L1", "L2"]);
    // L1 is the artifact's own profile: every position it prices is releasable. It prices no
    // kicker rule at all, so K is withheld by normalization rather than silently zero-scored.
    expect(report.matched[0]!.matchedPositions).toEqual(["QB", "RB", "WR", "TE"]);
    expect(report.matched[0]!.withheldPositions).toEqual([
      { position: "K", reason: "position-unsupported" },
      { position: "DST", reason: "position-unsupported" },
    ]);
    expect(projectionScoringProfileKey(report.matched[0]!.profile)).toBe(artifactKey);

    // Half PPR: receptions is in RB/WR/TE's vocabulary but not QB's, so QB scores byte-identically
    // under both profiles and is the only position the artifact may serve.
    expect(report.matched[1]!.matchedPositions).toEqual(["QB"]);
    expect(report.matched[1]!.withheldPositions).toEqual([
      { position: "RB", reason: "scoring-profile-position-mismatch" },
      { position: "WR", reason: "scoring-profile-position-mismatch" },
      { position: "TE", reason: "scoring-profile-position-mismatch" },
      { position: "K", reason: "position-unsupported" },
      { position: "DST", reason: "position-unsupported" },
    ]);

    // L3 stays excluded entirely — now with a stated reason per position instead of a bare skip.
    expect(report.excluded.map((league) => league.leagueSeasonId)).toEqual(["L3"]);
    expect(report.excluded[0]!.withheldPositions).toEqual([
      { position: "QB", reason: "position-unsupported" },
      { position: "RB", reason: "position-unsupported" },
      { position: "WR", reason: "position-unsupported" },
      { position: "TE", reason: "position-unsupported" },
      { position: "K", reason: "position-unsupported" },
      { position: "DST", reason: "position-unsupported" },
    ]);
  });

  it("withholds only the kicker when a league splits the field-goal brackets", () => {
    const artifactKey = keyForRules([...espnOffenseRules, ...espnAggregateKickerRules], "espn");
    const report = enumerateFirstPartyRosScoringMatchedLeagues({
      artifactScoringProfileKey: artifactKey,
      leagues: [{ id: "L1", provider: "espn" }],
      rules: withLeague([...espnOffenseRules, ...espnSplitKickerRules], "L1"),
      availableStatIds,
    });

    expect(report.matched).toHaveLength(1);
    expect(report.matched[0]!.matchedPositions).toEqual(["QB", "RB", "WR", "TE"]);
    expect(report.matched[0]!.withheldPositions).toEqual([
      { position: "K", reason: "scoring-profile-position-mismatch" },
      { position: "DST", reason: "position-unsupported" },
    ]);
    // 5 for 50-59 plus 6 for 60+ is close to 5 for 50+, and close is exactly what is refused.
    expect(projectionScoringProfileKey(report.matched[0]!.profile)).not.toBe(artifactKey);
  });

  it("matches a position whose artifact-side rule is a scoring no-op", () => {
    // A zero-point rule scores nothing, so a league that discarded it must still match. The
    // whole-profile key cannot express that; the position-scoped keys can.
    const artifactKey = projectionScoringProfileKey({
      id: "artifact-with-noop",
      rules: [
        ...normalizedProfile(pprRules, "yahoo").rules,
        { statId: "special_teams_touchdowns", points: 0 },
      ],
    });
    const report = enumerateFirstPartyRosScoringMatchedLeagues({
      artifactScoringProfileKey: artifactKey,
      leagues: [{ id: "L1", provider: "yahoo" }],
      rules: pprRules,
      availableStatIds,
    });

    expect(artifactKey).not.toBe(keyForRules(pprRules));
    expect(report.matched[0]!.matchedPositions).toEqual(["QB", "RB", "WR", "TE"]);
  });

  it("fits the shared reference calibration profile from the artifact, not from whichever league matched first", () => {
    // Two leagues that match QB/RB/WR/TE and differ only in their kicker brackets: A splits
    // 50-59/60+, B prices 50+ like the artifact, so B matches K and A does not. Before this fix
    // the run's availability/role/kicker calibrations were fitted from `matched[0].profile`, which
    // means B's kicker calibration was fitted under A's brackets purely because A sorted first.
    const artifactKey = keyForRules([...espnOffenseRules, ...espnAggregateKickerRules], "espn");
    const leagueA = withLeague([...espnOffenseRules, ...espnSplitKickerRules], "A");
    const leagueB = withLeague([...espnOffenseRules, ...espnAggregateKickerRules], "B");
    const enumerate = (leagues: readonly { id: string; provider: string }[]) =>
      enumerateFirstPartyRosScoringMatchedLeagues({
        artifactScoringProfileKey: artifactKey,
        leagues,
        rules: [...leagueA, ...leagueB],
        availableStatIds,
      });

    const forward = enumerate([
      { id: "A", provider: "espn" },
      { id: "B", provider: "espn" },
    ]);
    const reversed = enumerate([
      { id: "B", provider: "espn" },
      { id: "A", provider: "espn" },
    ]);

    // The old reference (`matched[0].profile`) genuinely flips with league order...
    expect(forward.matched[0]!.leagueSeasonId).toBe("A");
    expect(reversed.matched[0]!.leagueSeasonId).toBe("B");
    expect(projectionScoringProfileKey(forward.matched[0]!.profile)).not.toBe(
      projectionScoringProfileKey(reversed.matched[0]!.profile),
    );
    expect(forward.matched[0]!.matchedPositions).not.toContain("K");
    expect(reversed.matched[0]!.matchedPositions).toContain("K");

    // ...while the reference actually used is the artifact's own profile: order-independent,
    // league-independent, and exactly the artifact's scoring identity.
    const reference = firstPartyRosArtifactScoringProfile(artifactKey);
    expect(projectionScoringProfileKey(reference)).toBe(artifactKey);
    // Neither matched league's profile is the reference: A differs, and B only coincides because
    // this fixture makes B whole-key identical to the artifact.
    expect(projectionScoringProfileKey(forward.matched[0]!.profile)).not.toBe(artifactKey);
  });

  it("matches nothing when the artifact's stored scoring key is not canonical", () => {
    const report = enumerateFirstPartyRosScoringMatchedLeagues({
      artifactScoringProfileKey: "full-ppr:v1",
      leagues: [{ id: "L1", provider: "yahoo" }],
      rules: pprRules,
      availableStatIds,
    });

    expect(report.matched).toEqual([]);
    expect(report.excluded[0]!.withheldPositions).toEqual([
      { position: "QB", reason: "artifact-scoring-profile-key-unreadable" },
      { position: "RB", reason: "artifact-scoring-profile-key-unreadable" },
      { position: "WR", reason: "artifact-scoring-profile-key-unreadable" },
      { position: "TE", reason: "artifact-scoring-profile-key-unreadable" },
      { position: "K", reason: "artifact-scoring-profile-key-unreadable" },
      { position: "DST", reason: "artifact-scoring-profile-key-unreadable" },
    ]);
  });
});

describe("currentFantasyPlayerPool", () => {
  it("pins current-season team stats so live D/ST form invalidates the candidate cache", () => {
    const keys = firstPartyRosCandidateSourceKeys(2026);

    expect(keys).toContain("nflverse.stats-team-week.2026");
    expect(keys).toContain("nflverse.stats-team-week.2025");
  });

  it("builds a preseason candidate pool without fantasy-team roster snapshots", () => {
    const pool = currentFantasyPlayerPool(
      [
        { playerId: "qb-1", position: "QB", season: 2026, week: 1, team: "buf", status: "ACT" },
        // The roster feed's fantasy position wins even when the canonical NFL catalog describes a
        // two-way player's primary position differently before this fact reaches the pool builder.
        {
          playerId: "two-way-wr",
          position: "WR",
          season: 2026,
          week: 1,
          team: "JAX",
          status: "ACT",
        },
        { playerId: "rb-cut", position: "RB", season: 2026, week: 1, team: "MIA", status: "CUT" },
        { playerId: "old", position: "WR", season: 2025, week: 18, team: "NYJ", status: "ACT" },
      ],
      [
        {
          season: 2026,
          week: 1,
          gameId: "2026-1-BUF-MIA",
          awayTeam: "BUF",
          homeTeam: "MIA",
          awayScore: null,
          homeScore: null,
          kickoffAt: new Date("2026-09-10T00:00:00.000Z"),
          status: "scheduled",
        },
        {
          season: 2026,
          week: 1,
          gameId: "2026-1-JAX-TEN",
          awayTeam: "JAX",
          homeTeam: "TEN",
          awayScore: null,
          homeScore: null,
          kickoffAt: new Date("2026-09-10T00:00:00.000Z"),
          status: "scheduled",
        },
      ],
      2026,
    );

    expect(
      pool
        .filter((row) => row.position === "DST")
        .map((row) => row.team)
        .sort(),
    ).toEqual(["BUF", "JAX", "MIA", "TEN"]);
    expect(
      pool
        .filter((row) => row.position === "DST")
        .every(
          (row) => row.playerId.length === 36 && row.rosterStatus === "active" && row.team !== null,
        ),
    ).toBe(true);
    expect(pool).toContainEqual({
      playerId: "qb-1",
      position: "QB",
      team: "BUF",
      rosterStatus: "ACT",
    });
    expect(pool).toContainEqual({
      playerId: "two-way-wr",
      position: "WR",
      team: "JAX",
      rosterStatus: "ACT",
    });
    expect(pool).toHaveLength(6);
  });
});

const scoringProfile: ProjectionScoringProfile = {
  id: "provider-test-ppr",
  version: "1",
  rules: [
    { statId: "receptions", points: 1 },
    { statId: "receiving_yards", points: 0.1 },
    { statId: "receiving_touchdowns", points: 6 },
    { statId: "rushing_yards", points: 0.1 },
    { statId: "rushing_touchdowns", points: 6 },
  ],
};
const SCORING_KEY = projectionScoringProfileKey(scoringProfile);

const seasons = [2024, 2025, 2026] as const;
const teams = ["BUF", "MIA", "NYJ", "NEP"] as const;

function opponentOf(team: string): string {
  const index = teams.indexOf(team as (typeof teams)[number]);
  return teams[(index + 1) % teams.length]!;
}

function pseudo(seed: number): number {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}

function buildHistory(): readonly FirstPartyWeeklyStatLine[] {
  const rows: FirstPartyWeeklyStatLine[] = [];
  for (const season of seasons) {
    const lastWeek = season === 2026 ? 6 : 16;
    for (let week = 1; week <= lastWeek; week += 1) {
      for (let playerIndex = 0; playerIndex < 16; playerIndex += 1) {
        const team = teams[playerIndex % teams.length]!;
        const noise = pseudo(season * 1000 + week * 37 + playerIndex);
        const targets = 6 + Math.round(noise * 6);
        const receptions = Math.max(1, Math.round(targets * (0.6 + noise * 0.2)));
        rows.push({
          playerId: `wr-${playerIndex}`,
          position: "WR",
          season,
          week,
          team,
          opponent: opponentOf(team),
          snapShare: 0.6 + noise * 0.3,
          targetShare: 0.15 + noise * 0.1,
          played: true,
          components: {
            targets,
            receptions,
            receiving_yards: 40 + Math.round(noise * 70),
            receiving_touchdowns: noise > 0.75 ? 1 : 0,
            rushing_yards: 0,
            rushing_touchdowns: 0,
          },
        });
      }
    }
  }
  return rows;
}

function buildSchedules(): readonly ProjectionScheduleFact[] {
  const schedules: ProjectionScheduleFact[] = [];
  for (const season of seasons) {
    for (let week = 1; week <= 18; week += 1) {
      for (let pairIndex = 0; pairIndex < teams.length; pairIndex += 2) {
        const home = teams[pairIndex]!;
        const away = teams[pairIndex + 1]!;
        const completed = season < 2026 || week <= 6;
        schedules.push({
          season,
          week,
          gameId: `${season}-${week}-${home}`,
          homeTeam: home,
          awayTeam: away,
          awayScore: completed ? 20 : null,
          homeScore: completed ? 23 : null,
          kickoffAt: new Date(Date.UTC(season, 8, week)),
          status: completed ? "final" : "scheduled",
        });
      }
    }
  }
  return schedules;
}

function ninePlusForecast(
  season: number,
  asOfWeek: number,
  playerId: string,
): FirstPartyRosHeldOutForecast {
  const actual = 100;
  const contextualMean = actual + 1;
  const recencyMean = actual + 8;
  return {
    playerId,
    position: "WR",
    contextualModelVersion: "contextual-v1",
    recencyModelVersion: "recency-v1",
    scoringProfileKey: SCORING_KEY,
    intervalMethodVersion: "simulation-p15-p85-v1",
    forecastSeason: season,
    asOfWeek,
    windowStartWeek: asOfWeek + 1,
    windowEndWeek: 18,
    trainedThroughSeason: season - 1,
    inputChecksum: "b".repeat(64),
    evidence: {
      coverage: { contextual: 1, recency: 1 },
      availability: {
        scheduledGames: 18 - asOfWeek,
        actualGames: 17 - asOfWeek,
        contextualExpectedGames: 17 - asOfWeek,
        recencyExpectedGames: 16.5 - asOfWeek,
      },
      convergence: {
        contextual: { state: "converged", diagnosticChecksum: "c".repeat(64) },
        recency: { state: "converged", diagnosticChecksum: "d".repeat(64) },
      },
    },
    contextual: {
      meanPoints: contextualMean,
      p15Points: contextualMean - 15,
      p50Points: contextualMean,
      p85Points: contextualMean + 15,
    },
    recency: {
      meanPoints: recencyMean,
      p15Points: recencyMean - 25,
      p50Points: recencyMean,
      p85Points: recencyMean + 25,
    },
    actualPoints: actual,
  };
}

function ninePlusPolicy(): FirstPartyRosChampionPolicy {
  const evaluationSeasons = [2023, 2024, 2025].map((season) => ({
    season,
    complete: true,
    forecasts: [6, 7, 8].flatMap((asOfWeek) =>
      Array.from({ length: 7 }, (_, index) =>
        ninePlusForecast(season, asOfWeek, `${season}-${asOfWeek}-${index}`),
      ),
    ),
  }));
  return evaluateFirstPartyRosChampionPolicy(evaluationSeasons, {
    minimumHeldOutSeasons: 2,
    minimumBatches: 4,
    minimumSamples: 4,
    minimumCellSeasons: 2,
    minimumCellSamples: 4,
    minimumCellCutoffs: 2,
    minimumCellBatches: 4,
  }).livePolicy;
}

function artifact(
  policy: FirstPartyRosChampionPolicy,
  scoringProfileKey = SCORING_KEY,
): LoadedFirstPartyRosChampionArtifact {
  const payload: FirstPartyRosChampionArtifactPayload = {
    season: 2026,
    scoringProfileKey,
    modelVersion: "laces-ros-distribution-v4",
    policyVersion: "season-walk-forward-block-wis-cqr-v4",
    calibrationVersion: "season-blocked-split-conformal-cqr-v1",
    evidenceThroughSeason: 2025,
    sourceChecksums: [{ key: "nflverse.schedules.2026", checksum: "a".repeat(64) }],
    policy,
    releaseGate: { state: "release" },
  };
  return { ...payload, artifactChecksum: firstPartyRosChampionArtifactChecksum(payload) };
}

const window: FirstPartyRosWindow = {
  asOfWeek: 6,
  currentWeek: 7,
  windowStartWeek: 7,
  windowEndWeek: 18,
  currentWeekStarted: false,
};

describe("buildFirstPartyRosLeagueTarget", () => {
  const history = buildHistory();
  const schedules = buildSchedules();
  const trainingHistory = history.filter((row) => row.season < 2026);
  const featureHistory = history.filter((row) => row.season * 32 + row.week <= 2026 * 32 + 6);
  const calibration = runFirstPartyProjectionBacktest(trainingHistory).calibration;
  const availabilityCalibration = calibrateHistoricalRosAvailability(
    trainingHistory,
    schedules,
    scoringProfile,
  );
  const roleCalibration = calibrateHistoricalRosRole(trainingHistory, schedules, scoringProfile);
  const kickerCalibration = calibrateHistoricalRosKicker(
    trainingHistory,
    schedules,
    scoringProfile,
  );

  function run(input: {
    policy: FirstPartyRosChampionPolicy;
    candidatePlayers: readonly {
      playerId: string;
      position: string;
      team: string | null;
    }[];
    matchedPositions?: readonly FirstPartyRosRailPosition[];
    supportedPositions?: readonly FirstPartyRosRailPosition[];
    window?: FirstPartyRosWindow;
    asOfAt?: Date;
  }) {
    const matchedPositions = input.matchedPositions ?? ["QB", "RB", "WR", "TE", "K"];
    const targetWindow = input.window ?? window;
    return buildFirstPartyRosLeagueTarget({
      artifact: artifact(input.policy),
      leagueSeasonId: "22222222-2222-4222-8222-222222222222",
      scoringProfile,
      matchedPositions,
      supportedPositions: input.supportedPositions ?? matchedPositions,
      season: 2026,
      window: targetWindow,
      candidatePlayers: input.candidatePlayers,
      featureHistory: targetWindow.asOfWeek === 0 ? trainingHistory : featureHistory,
      calibration,
      defenseFeatureHistory: [],
      defenseCalibration: {
        modelVersion: "laces-first-party-v1",
        intervals: {},
      },
      availabilityCalibration,
      roleCalibration,
      kickerCalibration,
      injuries: [],
      schedules,
      futureWindowComplete: true,
      sourceAsOf: new Date("2026-10-06T12:00:00.000Z"),
      asOfAt: input.asOfAt ?? new Date("2026-10-06T12:00:00.000Z"),
      // A downscaled release must carry a downscaled reference: the two counts are one contract,
      // and the production pair (12288/16384) is exercised end to end in the PostgreSQL suite.
      scenarioCount: 128,
      convergenceReferenceScenarioCount: 256,
    });
  }

  it("builds a target from supported candidates and audits per-player skips", () => {
    const result = run({
      policy: ninePlusPolicy(),
      candidatePlayers: [
        { playerId: "wr-0", position: "WR", team: "BUF" },
        { playerId: "wr-1", position: "WR", team: "MIA" },
        // Unsupported position: filtered before release, not an audited skip.
        { playerId: "dst-buf", position: "D/ST", team: "NYJ" },
        // Missing NFL team: cannot be modelled, filtered without approximation.
        { playerId: "wr-2", position: "WR", team: null },
        // A team with no scheduled remaining games yields zero expected games: audited skip.
        { playerId: "wr-off", position: "WR", team: "LAR" },
      ],
    });
    expect(result.target).not.toBeNull();
    expect(result.target!.leagueScoringProfileKey).toBe(SCORING_KEY);
    expect(new Set(result.target!.released.map((player) => player.playerId))).toEqual(
      new Set(["wr-0", "wr-1"]),
    );
    expect(result.target!.evidence.length).toBeGreaterThan(0);
    expect(result.target!.evidence[0]!.bucket).toBe("nine-plus");
    expect(result.target!.evidence[0]!.inputChecksum).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.skippedPlayers).toBe(1);
    // The publication layer re-derives the per-position match for itself, so the target carries
    // the two inputs it needs rather than the already-computed answer.
    expect(result.target!.leagueScoringProfile).toBe(scoringProfile);
    expect(result.target!.supportedPositions).toEqual(["QB", "RB", "WR", "TE", "K"]);
  });

  it("publishes veteran candidates before Week 1 without a fantasy roster", () => {
    const liveCutoff = new Date("2026-08-04T12:00:00.000Z");
    const result = run({
      policy: ninePlusPolicy(),
      window: {
        asOfWeek: 0,
        currentWeek: 1,
        windowStartWeek: 1,
        windowEndWeek: 18,
        currentWeekStarted: false,
      },
      candidatePlayers: [
        { playerId: "wr-0", position: "WR", team: "BUF" },
        { playerId: "wr-1", position: "WR", team: "MIA" },
      ],
      asOfAt: liveCutoff,
    });

    expect(result.target?.released.map((player) => player.playerId)).toEqual(["wr-0", "wr-1"]);
    expect(result.target?.released.every((player) => player.bucket === "nine-plus")).toBe(true);
    expect(
      result.target?.released.every(
        (player) => player.projection.provenance.asOfAt === liveCutoff.toISOString(),
      ),
    ).toBe(true);
  });

  it("withholds players whose position the league did not match", () => {
    const withheldWr = run({
      policy: ninePlusPolicy(),
      matchedPositions: ["QB", "RB", "TE", "K"],
      supportedPositions: ["QB", "RB", "WR", "TE", "K"],
      candidatePlayers: [
        { playerId: "wr-0", position: "WR", team: "BUF" },
        { playerId: "wr-1", position: "WR", team: "MIA" },
      ],
    });
    // A withheld position never becomes a candidate, so it is not an audited per-player skip: the
    // league simply produces nothing for it.
    expect(withheldWr.target).toBeNull();
    expect(withheldWr.leagueReason).toBe("no_releasable_candidates");
    expect(withheldWr.skippedPlayers).toBe(0);

    const releasedWr = run({
      policy: ninePlusPolicy(),
      matchedPositions: ["WR"],
      supportedPositions: ["QB", "RB", "WR", "TE", "K"],
      candidatePlayers: [
        { playerId: "wr-0", position: "WR", team: "BUF" },
        { playerId: "wr-1", position: "WR", team: "MIA" },
      ],
    });
    expect(releasedWr.target!.released.map((player) => player.playerId)).toEqual(["wr-0", "wr-1"]);
    expect(releasedWr.target!.supportedPositions).toEqual(["QB", "RB", "WR", "TE", "K"]);
  });

  it("yields no target when no candidate has an authorizing champion choice", () => {
    // A policy carrying no WR choice cannot authorize any of these WR candidates, so the whole
    // league fails closed rather than approximating a release.
    const base = ninePlusPolicy();
    const withoutWr: FirstPartyRosChampionPolicy = {
      ...base,
      choices: base.choices.filter((choice) => choice.position !== "WR"),
    };
    const result = run({
      policy: withoutWr,
      candidatePlayers: [
        { playerId: "wr-0", position: "WR", team: "BUF" },
        { playerId: "wr-1", position: "WR", team: "MIA" },
      ],
    });
    expect(result.target).toBeNull();
    expect(result.leagueReason).toBe("no_releasable_candidates");
    expect(result.skippedPlayers).toBe(2);
  });
});
