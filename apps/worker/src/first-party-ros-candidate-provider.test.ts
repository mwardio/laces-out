import {
  evaluateFirstPartyRosChampionPolicy,
  normalizeLeagueScoringProfile,
  projectionScoringProfileKey,
  projectFirstPartyRestOfSeason,
  runFirstPartyProjectionBacktest,
  type FirstPartyRosChampionPolicy,
  type FirstPartyRosHeldOutForecast,
  type FirstPartyRosProjectionInput,
  type FirstPartyWeeklyStatLine,
  type FirstPartyTeamDefenseWeeklyStatLine,
  type ProjectionScoringProfile,
} from "@laces-out/projections";
import * as projectionModules from "@laces-out/projections";
import { describe, expect, it, vi } from "vitest";

import {
  calibrateHistoricalRosAvailability,
  calibrateHistoricalRosKicker,
  calibrateHistoricalRosRole,
} from "./first-party-ros-backtest.js";
import {
  applyFirstPartyRosPlayerAliases,
  buildFirstPartyRosLeagueTarget,
  buildFirstPartyRosLeagueTargetAsync,
  type FirstPartyRosLeagueTargetInput,
  calibrateFirstPartyRosPlayerHistory,
  currentFantasyPlayerPool,
  enumerateFirstPartyRosScoringMatchedLeagues,
  firstPartyRosArtifactOwnedLeagues,
  firstPartyRosCandidateSourceKeys,
  firstPartyRosEffectiveRosterAliasPosition,
  firstPartyRosPlayerAliasPlan,
  firstPartyRosPlayerAliasPlansChecksum,
  firstPartyRosYahooEvidenceClosure,
  unmatchedCurrentFantasyPlayers,
  type FirstPartyRosScoringRuleRow,
} from "./first-party-ros-candidate-provider.js";
import {
  firstPartyAvailableProjectionComponents,
  firstPartyDefensePlayerId,
} from "./first-party-projections.js";
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
    positionTypes: null,
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
    positionTypes: null,
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
      positionTypes: rule.positionTypes,
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

  it("retains offensive ROS matches when an unknown Yahoo rule is declared kicker-only", () => {
    const scopedOffense = pprRules.map((rule) => ({ ...rule, positionTypes: ["O"] }));
    const artifactKey = keyForRules(scopedOffense);
    const report = enumerateFirstPartyRosScoringMatchedLeagues({
      artifactScoringProfileKey: artifactKey,
      leagues: [{ id: "L1", provider: "yahoo" }],
      rules: [
        ...scopedOffense,
        pprRule("Future Kicker Metric", "1", {
          providerStatId: "9999",
          positionTypes: ["K"],
        }),
      ],
      availableStatIds,
    });

    expect(report.excluded).toEqual([]);
    expect(report.matched[0]!.matchedPositions).toEqual(["QB", "RB", "WR", "TE"]);
    expect(report.matched[0]!.withheldPositions).toEqual([
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
    expect(keys).toContain("nflverse.players");
    expect(keys).toContain("sleeper.players");
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

  it("keeps unmatched active current players visible to the release-completeness audit", () => {
    const unmatched = unmatchedCurrentFantasyPlayers(
      [
        {
          externalPlayerId: "active-unmatched",
          playerId: "older-match",
          position: "WR",
          season: 2026,
          week: 4,
          team: "BUF",
          status: "ACT",
        },
        {
          externalPlayerId: "active-unmatched",
          playerId: null,
          position: "WR",
          season: 2026,
          week: 5,
          team: "BUF",
          status: "ACT",
        },
        {
          externalPlayerId: "latest-cut",
          playerId: null,
          position: "RB",
          season: 2026,
          week: 5,
          team: "MIA",
          status: "CUT",
        },
        {
          externalPlayerId: "old-season",
          playerId: null,
          position: "QB",
          season: 2025,
          week: 18,
          team: "NYJ",
          status: "ACT",
        },
      ],
      2026,
    );

    expect(unmatched).toEqual([{ externalPlayerId: "active-unmatched", positions: ["WR"] }]);
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

describe("live ROS player calibration", () => {
  it("fits center uncertainty from the locked weekly predictions used by historical evidence", () => {
    // Twenty-four relevant players give the held-out residual fit enough player-season groups;
    // a sparse fixture would silently use 0.25 with or without the missing predictions argument.
    const trainingHistory = buildHistory()
      .filter((row) => row.season < 2026)
      .flatMap((row) =>
        Number(row.playerId.slice(3)) < 8
          ? [row, { ...row, playerId: `${row.playerId}-additional` }]
          : [row],
      );
    const schedules = buildSchedules();
    const weeklyBacktest = runFirstPartyProjectionBacktest(trainingHistory);
    const historical = calibrateHistoricalRosRole(
      trainingHistory,
      schedules,
      weeklyBacktest.predictions,
    );
    const missingResiduals = calibrateHistoricalRosRole(trainingHistory, schedules);
    expect(missingResiduals.byPosition.WR?.centerVolatility).toBe(0.25);
    expect(historical.byPosition.WR?.centerVolatility).not.toBe(0.25);

    const live = calibrateFirstPartyRosPlayerHistory({
      trainingHistory,
      schedules,
    });
    // Current-season results must not refit unchanged prior-season football calibration.
    const historicalSchedules = schedules.filter((row) => row.season < 2026);
    expect(calibrateHistoricalRosAvailability(trainingHistory, historicalSchedules)).toEqual(
      live.availability,
    );
    expect(
      calibrateHistoricalRosRole(trainingHistory, historicalSchedules, weeklyBacktest.predictions),
    ).toEqual(live.role);
    expect(
      calibrateHistoricalRosKicker(
        trainingHistory,
        historicalSchedules,
        weeklyBacktest.predictions,
      ),
    ).toEqual(live.kicker);
    expect(live.role).toEqual(historical);
    expect(live.weekly).toEqual(weeklyBacktest.calibration);
    expect(live.kicker).toEqual(
      calibrateHistoricalRosKicker(trainingHistory, schedules, weeklyBacktest.predictions),
    );
  }, 45_000);
});

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

function ninePlusPolicy(position: FirstPartyRosRailPosition = "WR"): FirstPartyRosChampionPolicy {
  const evaluationSeasons = [2023, 2024, 2025].map((season) => ({
    season,
    complete: true,
    forecasts: [6, 7, 8].flatMap((asOfWeek) =>
      Array.from({ length: 7 }, (_, index) => ({
        ...ninePlusForecast(season, asOfWeek, `${season}-${asOfWeek}-${index}`),
        position,
      })),
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
  const availabilityCalibration = calibrateHistoricalRosAvailability(trainingHistory, schedules);
  const roleCalibration = calibrateHistoricalRosRole(trainingHistory, schedules);
  const kickerCalibration = calibrateHistoricalRosKicker(trainingHistory, schedules);

  function targetInput(input: {
    policy: FirstPartyRosChampionPolicy;
    candidatePlayers: readonly {
      playerId: string;
      position: string;
      team: string | null;
      rosterStatus?: string | null;
    }[];
    matchedPositions?: readonly FirstPartyRosRailPosition[];
    supportedPositions?: readonly FirstPartyRosRailPosition[];
    unmatchedCandidateCount?: number;
    unmatchedCandidates?: readonly {
      externalPlayerId: string;
      positions: readonly FirstPartyRosRailPosition[];
    }[];
    history?: readonly FirstPartyWeeklyStatLine[];
    window?: FirstPartyRosWindow;
    asOfAt?: Date;
  }): FirstPartyRosLeagueTargetInput {
    const matchedPositions = input.matchedPositions ?? ["QB", "RB", "WR", "TE", "K"];
    const targetWindow = input.window ?? window;
    const selectedHistory = input.history ?? history;
    const selectedTrainingHistory = selectedHistory.filter((row) => row.season < 2026);
    return {
      artifact: artifact(input.policy),
      leagueSeasonId: "22222222-2222-4222-8222-222222222222",
      scoringProfile,
      matchedPositions,
      supportedPositions: input.supportedPositions ?? matchedPositions,
      season: 2026,
      window: targetWindow,
      candidatePlayers: input.candidatePlayers,
      unmatchedCandidateCount: input.unmatchedCandidateCount ?? 0,
      ...(input.unmatchedCandidates ? { unmatchedCandidates: input.unmatchedCandidates } : {}),
      featureHistory: input.history
        ? selectedHistory.filter(
            (row) => row.season * 32 + row.week <= 2026 * 32 + targetWindow.asOfWeek,
          )
        : targetWindow.asOfWeek === 0
          ? trainingHistory
          : featureHistory,
      calibration: input.history
        ? runFirstPartyProjectionBacktest(selectedTrainingHistory).calibration
        : calibration,
      defenseFeatureHistory: [],
      defenseCalibration: {
        modelVersion: "laces-first-party-v1",
        intervals: {},
      },
      availabilityCalibration: input.history
        ? calibrateHistoricalRosAvailability(selectedTrainingHistory, schedules)
        : availabilityCalibration,
      roleCalibration: input.history
        ? calibrateHistoricalRosRole(selectedTrainingHistory, schedules)
        : roleCalibration,
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
    };
  }

  function run(input: Parameters<typeof targetInput>[0]) {
    return buildFirstPartyRosLeagueTarget(targetInput(input));
  }

  function controlledConvergenceProjector(ratio: (input: FirstPartyRosProjectionInput) => number) {
    return async (input: FirstPartyRosProjectionInput) => ({
      ...projectFirstPartyRestOfSeason(input),
      expectedGames: 2,
      // Reference mean 100 has allowed difference 2; all other checked values are identical.
      meanPoints: 100 + (input.scenarioCount === 128 ? 2 * ratio(input) : 0),
      p15Points: 80,
      p50Points: 100,
      p85Points: 120,
    });
  }

  it.each([128, 256])(
    "rejects reference=128 with release=%s before preparing any candidate projection",
    async (scenarioCount) => {
      const input = targetInput({
        policy: ninePlusPolicy(),
        candidatePlayers: [{ playerId: "wr-0", position: "WR", team: "BUF" }],
        matchedPositions: ["WR"],
      });
      const project = vi.fn(async (projection: FirstPartyRosProjectionInput) =>
        projectFirstPartyRestOfSeason(projection),
      );
      await expect(
        buildFirstPartyRosLeagueTargetAsync(
          { ...input, scenarioCount, convergenceReferenceScenarioCount: 128 },
          project,
        ),
      ).rejects.toThrow("Live ROS convergence reference must exceed the release path count");
      expect(project).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["contextual", 1, 2],
    ["contextual", 2, 1],
    ["availability-aware-recency", 2, 0.5],
    ["availability-aware-recency", 1, 2],
  ] as const)(
    "summarizes selected %s convergence with contextual ratio %s and recency ratio %s",
    async (strategy, contextualRatio, recencyRatio) => {
      const policy = ninePlusPolicy();
      const result = await buildFirstPartyRosLeagueTargetAsync(
        targetInput({
          policy: {
            ...policy,
            choices: policy.choices.map((choice) => ({ ...choice, strategy })),
          },
          candidatePlayers: [{ playerId: "wr-0", position: "WR", team: "BUF" }],
          matchedPositions: ["WR"],
        }),
        controlledConvergenceProjector((input) =>
          input.strategy === "contextual" ? contextualRatio : recencyRatio,
        ),
      );
      expect(result.target).not.toBeNull();
      const target = result.target!;
      const selected = strategy === "contextual" ? "contextual" : "recency";
      const selectedRatio = strategy === "contextual" ? contextualRatio : recencyRatio;
      expect(target.released[0]!.strategy).toBe(strategy);
      expect(target.evidence[0]!.convergence).toMatchObject({
        contextual: { state: contextualRatio <= 1 ? "converged" : "unstable" },
        recency: { state: recencyRatio <= 1 ? "converged" : "unstable" },
      });
      expect(target.convergence).toMatchObject({
        state: selectedRatio <= 1 ? "converged" : "unstable",
        maxToleranceRatio: selectedRatio,
        diagnosticChecksum: target.evidence[0]!.convergence[selected].diagnosticChecksum,
      });
    },
  );

  it("keeps a selected failure worse than an earlier passing boundary across cells", async () => {
    const wrPolicy = ninePlusPolicy();
    const rbPolicy = ninePlusPolicy("RB");
    const runningBackHistory = history.map((row) => ({
      ...row,
      playerId: row.playerId.replace("wr-", "rb-"),
      position: "RB",
      components: {
        ...row.components,
        rushing_attempts: 12,
        rushing_yards: 55,
        rushing_touchdowns: 0,
      },
    }));
    const result = await buildFirstPartyRosLeagueTargetAsync(
      targetInput({
        policy: {
          ...wrPolicy,
          choices: [
            ...wrPolicy.choices
              .filter((choice) => choice.position === "WR")
              .map((choice) => ({ ...choice, strategy: "contextual" as const })),
            ...rbPolicy.choices
              .filter((choice) => choice.position === "RB")
              .map((choice) => ({ ...choice, strategy: "availability-aware-recency" as const })),
          ],
        },
        // The passing ratio=1 cell is deliberately first. Clipping the later failure to 1
        // would make the old strict-greater reduction retain this false passing summary.
        candidatePlayers: [
          { playerId: "wr-0", position: "WR", team: "BUF" },
          { playerId: "rb-0", position: "RB", team: "BUF" },
        ],
        matchedPositions: ["WR", "RB"],
        history: [...history, ...runningBackHistory],
      }),
      controlledConvergenceProjector((input) =>
        input.position === "WR" ? 1 : input.strategy === "contextual" ? 2 : 3,
      ),
    );
    expect(result.target).not.toBeNull();
    const target = result.target!;
    expect(target.evidence.map((cell) => cell.position)).toEqual(["WR", "RB"]);
    expect(target.evidence[0]!.convergence.contextual.state).toBe("converged");
    expect(target.evidence[1]!.convergence.recency.state).toBe("unstable");
    expect(target.convergence).toMatchObject({
      state: "unstable",
      maxToleranceRatio: 3,
      diagnosticChecksum: target.evidence[1]!.convergence.recency.diagnosticChecksum,
    });
  }, 15_000);

  it("fits the shared prior defense game process once per target without caching mutable arrays", () => {
    const defenseFeatureHistory: FirstPartyTeamDefenseWeeklyStatLine[] = [];
    const input = {
      ...targetInput({
        policy: ninePlusPolicy("DST"),
        candidatePlayers: [
          { playerId: "dst-buf", position: "DST", team: "BUF" },
          { playerId: "dst-mia", position: "DST", team: "MIA" },
        ],
        matchedPositions: ["DST"],
      }),
      defenseFeatureHistory,
    };
    const fit = vi.spyOn(projectionModules, "fitFirstPartyDefenseGameCalibration");
    try {
      const result = buildFirstPartyRosLeagueTarget(input);
      expect(result.skippedPlayers).toBe(2);
      expect(fit).toHaveBeenCalledExactlyOnceWith(defenseFeatureHistory, 2026);

      // Another target must inspect its current snapshot even when the array object is reused.
      defenseFeatureHistory.push({ team: "BUF", season: 2025, week: 1, components: {} });
      expect(() => buildFirstPartyRosLeagueTarget(input)).toThrow(
        "Defense calibration defensive_sacks must be a nonnegative safe integer",
      );
      expect(fit).toHaveBeenCalledTimes(2);
    } finally {
      fit.mockRestore();
    }
  });

  it("keeps asynchronous cached-outcome assembly identical to the synchronous release path", async () => {
    const input = targetInput({
      policy: ninePlusPolicy(),
      candidatePlayers: [{ playerId: "wr-0", position: "WR", team: "BUF" }],
      matchedPositions: ["WR"],
      supportedPositions: ["WR"],
    });
    const expected = buildFirstPartyRosLeagueTarget(input);
    const actual = await buildFirstPartyRosLeagueTargetAsync(input, async (projection) => {
      await Promise.resolve();
      return projectFirstPartyRestOfSeason(projection);
    });
    expect(actual).toEqual(expected);
  });

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
    expect(result.target!.candidateUniverse?.skippedCandidates).toEqual([
      {
        playerId: "wr-off",
        externalPlayerId: null,
        position: "WR",
        reason: "projection-unavailable",
      },
    ]);
    // The publication layer re-derives the per-position match for itself, so the target carries
    // the two inputs it needs rather than the already-computed answer.
    expect(result.target!.leagueScoringProfile).toBe(scoringProfile);
    expect(result.target!.supportedPositions).toEqual(["QB", "RB", "WR", "TE", "K"]);
  });

  it("marks the target incomplete when a releasable live player has no internal identity", () => {
    const result = run({
      policy: ninePlusPolicy(),
      candidatePlayers: [{ playerId: "wr-0", position: "WR", team: "BUF" }],
      matchedPositions: ["WR"],
      supportedPositions: ["WR"],
      unmatchedCandidateCount: 1,
      unmatchedCandidates: [{ externalPlayerId: "ESB-MISSING", positions: ["WR"] }],
    });

    expect(result.skippedPlayers).toBe(1);
    expect(result.target?.candidateUniverse).toMatchObject({
      expectedPlayerCount: 2,
      evaluatedPlayerCount: 1,
      skippedPlayerCount: 1,
      complete: false,
      skippedCandidates: [
        {
          playerId: null,
          externalPlayerId: "ESB-MISSING",
          position: "WR",
          reason: "identity-unresolved",
        },
      ],
      skippedCandidatesTruncated: false,
    });
  });

  it("bounds skipped identity diagnostics without reducing the completeness denominator", () => {
    const result = run({
      policy: ninePlusPolicy(),
      candidatePlayers: [{ playerId: "wr-0", position: "WR", team: "BUF" }],
      matchedPositions: ["WR"],
      supportedPositions: ["WR"],
      unmatchedCandidateCount: 25,
      unmatchedCandidates: Array.from({ length: 25 }, (_, index) => ({
        externalPlayerId: `ESB-MISSING-${index}`,
        positions: ["WR"],
      })),
    });
    expect(result.target?.candidateUniverse).toMatchObject({
      expectedPlayerCount: 26,
      evaluatedPlayerCount: 1,
      skippedPlayerCount: 25,
      complete: false,
      skippedCandidatesTruncated: true,
    });
    expect(result.target?.candidateUniverse?.skippedCandidates).toHaveLength(20);
  });

  it("covers a resolved practice-squad running back without personal history", () => {
    const runningBackHistory = history.map((row) => ({
      ...row,
      playerId: row.playerId.replace("wr-", "rb-"),
      position: "RB",
      components: {
        ...row.components,
        rushing_attempts: 12,
        rushing_yards: 55,
        rushing_touchdowns: 0,
      },
    }));
    const result = run({
      policy: ninePlusPolicy("RB"),
      candidatePlayers: [
        { playerId: "resolved-henderson", position: "RB", team: "NYJ", rosterStatus: "DEV" },
      ],
      matchedPositions: ["RB"],
      supportedPositions: ["RB"],
      history: runningBackHistory,
    });
    expect(runningBackHistory.some((row) => row.playerId === "resolved-henderson")).toBe(false);
    expect(result.target?.released.map((player) => player.playerId)).toEqual([
      "resolved-henderson",
    ]);
    expect(result.target?.released[0]?.projection.expectedGames).toBeGreaterThan(0);
    expect(result.target?.candidateUniverse).toMatchObject({
      expectedPlayerCount: 1,
      evaluatedPlayerCount: 1,
      skippedPlayerCount: 0,
      complete: true,
      skippedCandidates: [],
    });
  });

  it("re-keys only the league persistence identity for an unambiguous offensive alias", () => {
    const result = run({
      policy: ninePlusPolicy(),
      candidatePlayers: [{ playerId: "wr-0", position: "WR", team: "BUF" }],
      matchedPositions: ["WR"],
      supportedPositions: ["WR"],
    });
    if (!result.target) throw new Error("expected a target");
    const canonicalPlayerId = "canonical-wr";
    const sourcePlayer = result.target.released[0]!;
    const canonicalTarget = {
      ...result.target,
      released: [
        {
          ...sourcePlayer,
          playerId: canonicalPlayerId,
          projection: {
            ...sourcePlayer.projection,
            playerId: canonicalPlayerId,
          },
        },
      ],
    };
    const plan = firstPartyRosPlayerAliasPlan({
      leagueSeasonId: "11111111-1111-4111-8111-111111111111",
      rosterPlayers: [
        {
          playerId: "provider-wr",
          fullName: "Provider Receiver",
          position: "WR",
          team: "BUF",
        },
      ],
      canonicalPlayers: [
        {
          playerId: canonicalPlayerId,
          fullName: "Canonical Receiver",
          position: "WR",
          team: "BUF",
          gsisId: "00-0031234",
        },
      ],
      externalIds: [
        { playerId: "provider-wr", source: "espn", externalId: "1234" },
        { playerId: canonicalPlayerId, source: "sleeper-espn", externalId: "1234" },
      ],
    });

    const aliased = applyFirstPartyRosPlayerAliases(canonicalTarget, plan);

    expect(aliased.candidateUniverse).toMatchObject({
      complete: true,
      playerAliasIssues: [],
      playerAliases: [{ position: "WR", team: "BUF", canonicalPlayerId, playerId: "provider-wr" }],
    });
    expect(aliased.released[0]?.playerId).toBe("provider-wr");
    // Model provenance remains honest: only the separate persistence ID changes.
    expect(aliased.released[0]?.projection.playerId).toBe(canonicalPlayerId);
  });

  it("resolves a D/ST by unique canonical team and normalizes team aliases", () => {
    const canonicalPlayerId = firstPartyDefensePlayerId("LAR");
    const plan = firstPartyRosPlayerAliasPlan({
      leagueSeasonId: "11111111-1111-4111-8111-111111111111",
      rosterPlayers: [
        {
          playerId: "provider-rams-defense",
          fullName: "Los Angeles Rams",
          position: "D/ST",
          team: "LA",
        },
      ],
      canonicalPlayers: [
        {
          playerId: canonicalPlayerId,
          fullName: "Los Angeles Rams",
          position: "DST",
          team: "LAR",
        },
      ],
    });

    expect(plan).toEqual({
      aliases: [
        {
          position: "DST",
          team: "LAR",
          canonicalPlayerId,
          playerId: "provider-rams-defense",
        },
      ],
      issues: [],
    });
  });

  it("fails closed for conflicting evidence, incompatible positions, and non-bijective aliases", () => {
    const canonicalPlayers = [
      {
        playerId: "canonical-a",
        fullName: "Same Player",
        position: "WR",
        team: "BUF",
        gsisId: "gsis-a",
      },
      {
        playerId: "canonical-b",
        fullName: "Other Player",
        position: "WR",
        team: "BUF",
        gsisId: "gsis-b",
      },
    ];
    const plan = firstPartyRosPlayerAliasPlan({
      leagueSeasonId: "11111111-1111-4111-8111-111111111111",
      rosterPlayers: [
        {
          playerId: "conflict",
          fullName: "Provider Conflict",
          position: "WR",
          team: "BUF",
          gsisId: "gsis-a",
        },
        {
          playerId: "wrong-position",
          fullName: "Provider Wrong Position",
          position: "RB",
          team: "BUF",
        },
        {
          playerId: "duplicate-a",
          fullName: "Same Player",
          position: "WR",
          team: "BUF",
        },
        {
          playerId: "duplicate-b",
          fullName: "Same Player",
          position: "WR",
          team: "BUF",
        },
      ],
      canonicalPlayers,
      externalIds: [
        { playerId: "conflict", source: "espn", externalId: "provider-b" },
        { playerId: "wrong-position", source: "espn", externalId: "provider-b" },
        { playerId: "canonical-b", source: "sleeper-espn", externalId: "provider-b" },
      ],
    });

    expect(plan.aliases).toEqual([]);
    expect(plan.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ playerId: "conflict", code: "identity-evidence-conflict" }),
        expect.objectContaining({ playerId: "wrong-position", code: "identity-incompatible" }),
        expect.objectContaining({
          playerId: "duplicate-a",
          code: "canonical-identity-not-bijective",
        }),
        expect.objectContaining({
          playerId: "duplicate-b",
          code: "canonical-identity-not-bijective",
        }),
      ]),
    );
  });

  it("honors league-scoped ESPN self assertions with direct ESPN fallback", () => {
    const leagueSeasonId = "11111111-1111-4111-8111-111111111111";
    const canonicalPlayers = [
      {
        playerId: "canonical-wr",
        fullName: "Canonical Receiver",
        position: "WR",
        team: "BUF",
        gsisId: "gsis-wr",
      },
    ];
    const rosterPlayers = [
      {
        playerId: "asserted-wr",
        fullName: "Provider Receiver",
        position: "WR",
        team: "BUF",
      },
    ];
    const externalIds = [
      {
        playerId: "asserted-wr",
        source: "espn-self-asserted",
        externalId: `${leagueSeasonId}:9876`,
      },
      { playerId: "canonical-wr", source: "espn", externalId: "9876" },
    ];

    expect(
      firstPartyRosPlayerAliasPlan({
        leagueSeasonId,
        rosterPlayers,
        canonicalPlayers,
        externalIds,
      }).aliases,
    ).toEqual([
      {
        position: "WR",
        team: "BUF",
        canonicalPlayerId: "canonical-wr",
        playerId: "asserted-wr",
      },
    ]);
    expect(
      firstPartyRosPlayerAliasPlan({
        leagueSeasonId: "22222222-2222-4222-8222-222222222222",
        rosterPlayers,
        canonicalPlayers,
        externalIds,
      }),
    ).toMatchObject({
      aliases: [],
      issues: [{ position: "WR", playerId: "asserted-wr", code: "identity-unresolved" }],
    });
  });

  it("uses exact NFKC name fallback only for trusted-GSIS canonical candidates", () => {
    const base = {
      leagueSeasonId: "11111111-1111-4111-8111-111111111111",
      rosterPlayers: [
        {
          playerId: "provider-wr",
          fullName: "Ａ.J. Receiver",
          position: "WR",
          team: "BUF",
        },
      ],
    } as const;
    const canonical = {
      playerId: "canonical-wr",
      fullName: "A.J. Receiver",
      position: "WR",
      team: "BUF",
    } as const;

    expect(
      firstPartyRosPlayerAliasPlan({
        ...base,
        canonicalPlayers: [{ ...canonical, gsisId: null }],
      }).issues[0]?.code,
    ).toBe("identity-unresolved");
    expect(
      firstPartyRosPlayerAliasPlan({
        ...base,
        canonicalPlayers: [{ ...canonical, gsisId: "gsis-wr" }],
      }).aliases[0]?.canonicalPlayerId,
    ).toBe("canonical-wr");
  });

  it("fails closed on conflicting GSIS facts even when only one maps to an active candidate", () => {
    const plan = firstPartyRosPlayerAliasPlan({
      leagueSeasonId: "11111111-1111-4111-8111-111111111111",
      rosterPlayers: [
        {
          playerId: "provider-wr",
          fullName: "Receiver",
          position: "WR",
          team: "BUF",
          gsisId: "gsis-active",
        },
      ],
      canonicalPlayers: [
        {
          playerId: "canonical-wr",
          fullName: "Receiver",
          position: "WR",
          team: "BUF",
          gsisId: "gsis-active",
        },
      ],
      gsisEvidence: [{ playerId: "provider-wr", gsisId: "gsis-stale" }],
    });

    expect(plan.aliases).toEqual([]);
    expect(plan.issues).toEqual([
      { position: "WR", playerId: "provider-wr", code: "identity-ambiguous" },
    ]);
  });

  it("does not fall back to an exact name when stronger identity evidence is unresolved", () => {
    const common = {
      leagueSeasonId: "11111111-1111-4111-8111-111111111111",
      rosterPlayers: [
        {
          playerId: "provider-wr",
          fullName: "Exact Receiver",
          position: "WR",
          team: "BUF",
          gsisId: "gsis-not-in-candidate-pool",
        },
      ],
      canonicalPlayers: [
        {
          playerId: "canonical-wr",
          fullName: "Exact Receiver",
          position: "WR",
          team: "BUF",
          gsisId: "gsis-canonical",
        },
      ],
    } as const;

    expect(firstPartyRosPlayerAliasPlan(common)).toMatchObject({
      aliases: [],
      issues: [{ position: "WR", playerId: "provider-wr", code: "identity-unresolved" }],
    });
    expect(
      firstPartyRosPlayerAliasPlan({
        ...common,
        rosterPlayers: [{ ...common.rosterPlayers[0], gsisId: null }],
        externalIds: [{ playerId: "provider-wr", source: "espn", externalId: "unmapped" }],
      }),
    ).toMatchObject({
      aliases: [],
      issues: [{ position: "WR", playerId: "provider-wr", code: "identity-unresolved" }],
    });
  });

  describe("Yahoo crosswalk identity", () => {
    const roster = {
      playerId: "yahoo-wr",
      fullName: "Provider Name With Suffix",
      position: "WR",
      team: "BUF",
    };
    const canonical = {
      playerId: "canonical-wr",
      fullName: "Different Canonical Name",
      position: "WR",
      team: "BUF",
      gsisId: "00-0031234",
    };
    const common = {
      leagueSeasonId: "11111111-1111-4111-8111-111111111111",
      rosterPlayers: [roster],
      canonicalPlayers: [canonical],
    };

    it.each([
      ["yahoo", "470.p.26686", "sleeper-yahoo", "26686"],
      ["yahoo", "nfl.p.26686", "sleeper-yahoo", "26686"],
      ["yahoo", "26686", "sleeper-yahoo", "nfl.p.26686"],
      ["yahoo", "470.p.26686", "sleeper-yahoo", "469.p.26686"],
      ["sleeper-yahoo", "26686", "yahoo", "470.p.26686"],
    ])(
      "joins %s %s to %s %s despite different display names",
      (rosterSource, rosterKey, canonicalSource, canonicalKey) => {
        const plan = firstPartyRosPlayerAliasPlan({
          ...common,
          externalIds: [
            { playerId: roster.playerId, source: rosterSource, externalId: rosterKey },
            { playerId: canonical.playerId, source: canonicalSource, externalId: canonicalKey },
          ],
        });
        expect(plan).toEqual({
          aliases: [
            {
              playerId: roster.playerId,
              canonicalPlayerId: canonical.playerId,
              position: "WR",
              team: "BUF",
            },
          ],
          issues: [],
        });
      },
    );

    it.each([false, true])(
      "rejects colliding normalized canonical keys without name fallback (reversed=%s)",
      (reverse) => {
        const other = { ...canonical, playerId: "other-canonical", gsisId: "00-0031235" };
        const crosswalks = [
          { playerId: canonical.playerId, source: "sleeper-yahoo", externalId: "26686" },
          { playerId: other.playerId, source: "sleeper-yahoo", externalId: "nfl.p.26686" },
        ];
        const plan = firstPartyRosPlayerAliasPlan({
          ...common,
          // Even a unique exact-name fallback must not override the conflicting crosswalk.
          rosterPlayers: [{ ...roster, fullName: canonical.fullName }],
          canonicalPlayers: [canonical, { ...other, fullName: "Another Receiver" }],
          externalIds: [
            { playerId: roster.playerId, source: "yahoo", externalId: "470.p.26686" },
            ...(reverse ? [...crosswalks].reverse() : crosswalks),
          ],
        });
        expect(plan).toEqual({
          aliases: [],
          issues: [{ position: "WR", playerId: roster.playerId, code: "identity-ambiguous" }],
        });
      },
    );

    it("accepts duplicate normalized keys only when they identify the same canonical player", () => {
      const plan = firstPartyRosPlayerAliasPlan({
        ...common,
        externalIds: [
          { playerId: roster.playerId, source: "yahoo", externalId: "470.p.26686" },
          { playerId: canonical.playerId, source: "sleeper-yahoo", externalId: "26686" },
          { playerId: canonical.playerId, source: "sleeper-yahoo", externalId: "nfl.p.26686" },
        ],
      });
      expect(plan.issues).toEqual([]);
      expect(plan.aliases).toHaveLength(1);
      expect(plan.aliases[0]?.canonicalPlayerId).toBe(canonical.playerId);
    });

    it.each(["470.p.99999", "470.p.26686.extra", "nba.p.26686"])(
      "keeps unresolved or invalid Yahoo evidence strict instead of matching a name: %s",
      (externalId) => {
        const plan = firstPartyRosPlayerAliasPlan({
          ...common,
          rosterPlayers: [{ ...roster, fullName: canonical.fullName }],
          externalIds: [
            { playerId: roster.playerId, source: "yahoo", externalId },
            { playerId: canonical.playerId, source: "sleeper-yahoo", externalId: "26686" },
          ],
        });
        expect(plan).toEqual({
          aliases: [],
          issues: [{ position: "WR", playerId: roster.playerId, code: "identity-unresolved" }],
        });
      },
    );

    it.each([
      { team: "MIA", position: "WR" },
      { team: "BUF", position: "RB" },
    ])("retains team and position guards after the Yahoo key matches: %j", (different) => {
      const plan = firstPartyRosPlayerAliasPlan({
        ...common,
        canonicalPlayers: [{ ...canonical, ...different }],
        externalIds: [
          { playerId: roster.playerId, source: "yahoo", externalId: "470.p.26686" },
          { playerId: canonical.playerId, source: "sleeper-yahoo", externalId: "26686" },
        ],
      });
      expect(plan).toEqual({
        aliases: [],
        issues: [{ position: "WR", playerId: roster.playerId, code: "identity-incompatible" }],
      });
    });

    it("rejects two roster Yahoo keys resolving to the same canonical player", () => {
      const other = { ...roster, playerId: "second-yahoo-wr" };
      const plan = firstPartyRosPlayerAliasPlan({
        ...common,
        rosterPlayers: [roster, other],
        externalIds: [
          { playerId: roster.playerId, source: "yahoo", externalId: "470.p.26686" },
          { playerId: other.playerId, source: "yahoo", externalId: "nfl.p.26686" },
          { playerId: canonical.playerId, source: "sleeper-yahoo", externalId: "26686" },
        ],
      });
      expect(plan.aliases).toEqual([]);
      expect(plan.issues).toHaveLength(2);
      expect(plan.issues).toEqual(
        expect.arrayContaining(
          [roster, other].map((player) => ({
            position: "WR",
            playerId: player.playerId,
            code: "canonical-identity-not-bijective",
          })),
        ),
      );
    });
  });

  describe("unbridged Yahoo identity fallback", () => {
    const roster = {
      playerId: "yahoo-wr",
      fullName: "Ａ.J. Receiver",
      position: "WR",
      team: "WSH",
    };
    const canonical = {
      ...roster,
      playerId: "canonical-wr",
      fullName: "A.J. Receiver",
      team: "WAS",
      gsisId: "00-0031234",
    };
    const yahoo = { playerId: roster.playerId, source: "yahoo", externalId: "470.p.26686" };
    const common = {
      leagueSeasonId: "11111111-1111-4111-8111-111111111111",
      rosterPlayers: [roster],
      canonicalPlayers: [canonical],
      externalIds: [yahoo],
      yahooExternalEvidenceComplete: true,
    };

    it("uses one trusted-GSIS exact identity only with complete outside-pool evidence", () => {
      const accepted = firstPartyRosPlayerAliasPlan(common);
      expect(accepted).toEqual({
        aliases: [
          {
            position: "WR",
            team: "WAS",
            playerId: roster.playerId,
            canonicalPlayerId: canonical.playerId,
          },
        ],
        issues: [],
      });
      const { yahooExternalEvidenceComplete: _complete, ...incomplete } = common;
      expect(firstPartyRosPlayerAliasPlan(incomplete)).toMatchObject({
        aliases: [],
        issues: [{ code: "identity-unresolved" }],
      });
    });

    it.each([
      { gsisId: null },
      { fullName: "A.J. Other Receiver" },
      { team: "BUF" },
      { position: "RB" },
    ])("retains trusted identity, name, team, and position requirements: %j", (change) => {
      expect(
        firstPartyRosPlayerAliasPlan({
          ...common,
          canonicalPlayers: [{ ...canonical, ...change }],
        }),
      ).toMatchObject({ aliases: [], issues: [{ code: "identity-unresolved" }] });
    });

    it.each([
      ["James Cook III", "James Cook"],
      ["KC Concepcion Jr.", "KC Concepcion"],
      ["Travis Etienne Jr.", "Travis Etienne"],
      ["Kyle Pitts Sr.", "Kyle Pitts"],
    ])("resolves a unique Yahoo suffix variant %s to %s", (rosterName, catalogName) => {
      expect(
        firstPartyRosPlayerAliasPlan({
          ...common,
          rosterPlayers: [{ ...roster, fullName: rosterName }],
          canonicalPlayers: [{ ...canonical, fullName: catalogName }],
        }),
      ).toMatchObject({ aliases: [{ canonicalPlayerId: canonical.playerId }], issues: [] });
    });

    it("rejects different suffixes without pruning ambiguous base-name candidates", () => {
      const suffixRoster = { ...roster, fullName: "Same Player Jr." };
      const senior = { ...canonical, fullName: "Same Player Sr." };
      expect(
        firstPartyRosPlayerAliasPlan({
          ...common,
          rosterPlayers: [suffixRoster],
          canonicalPlayers: [senior],
        }),
      ).toMatchObject({ aliases: [], issues: [{ code: "identity-unresolved" }] });
      const unsuffixed = { ...canonical, playerId: "another-player", fullName: "Same Player" };
      for (const canonicalPlayers of [
        [senior, unsuffixed],
        [unsuffixed, senior],
      ]) {
        expect(
          firstPartyRosPlayerAliasPlan({
            ...common,
            rosterPlayers: [suffixRoster],
            canonicalPlayers,
            externalIds: [
              yahoo,
              { playerId: senior.playerId, source: "sleeper-yahoo", externalId: "99999" },
            ],
          }),
        ).toMatchObject({ aliases: [], issues: [{ code: "identity-ambiguous" }] });
      }
    });

    it("keeps exact names authoritative and suffix aliases bijective", () => {
      const sameBase = { ...canonical, playerId: "another-player", fullName: "A.J. Receiver Jr." };
      expect(
        firstPartyRosPlayerAliasPlan({ ...common, canonicalPlayers: [canonical, sameBase] }),
      ).toMatchObject({ aliases: [{ canonicalPlayerId: canonical.playerId }], issues: [] });
      expect(
        firstPartyRosPlayerAliasPlan({
          ...common,
          rosterPlayers: [
            roster,
            { ...roster, playerId: "other-alias", fullName: "A.J. Receiver Jr." },
          ],
          externalIds: [yahoo, { ...yahoo, playerId: "other-alias" }],
        }),
      ).toMatchObject({
        aliases: [],
        issues: [
          { code: "canonical-identity-not-bijective" },
          { code: "canonical-identity-not-bijective" },
        ],
      });
    });

    it("does not widen a Yahoo suffix match with incomplete or contradictory provider evidence", () => {
      const suffixInput = {
        ...common,
        rosterPlayers: [{ ...roster, fullName: "A.J. Receiver Jr." }],
      };
      expect(
        firstPartyRosPlayerAliasPlan({ ...suffixInput, yahooExternalEvidenceComplete: false }),
      ).toMatchObject({ aliases: [], issues: [{ code: "identity-unresolved" }] });
      expect(
        firstPartyRosPlayerAliasPlan({
          ...suffixInput,
          externalIds: [
            yahoo,
            { playerId: canonical.playerId, source: "sleeper-yahoo", externalId: "99999" },
          ],
        }),
      ).toMatchObject({ aliases: [], issues: [{ code: "identity-unresolved" }] });
    });

    it("rejects a scoped ESPN name fallback against a different known ESPN identity", () => {
      const scoped = {
        playerId: roster.playerId,
        source: "espn-self-asserted",
        externalId: `${common.leagueSeasonId}:123`,
      };
      expect(
        firstPartyRosPlayerAliasPlan({
          ...common,
          externalIds: [
            scoped,
            { playerId: canonical.playerId, source: "sleeper-espn", externalId: "456" },
          ],
        }),
      ).toMatchObject({ aliases: [], issues: [{ code: "identity-unresolved" }] });
      expect(
        firstPartyRosPlayerAliasPlan({
          ...common,
          rosterPlayers: [{ ...roster, fullName: "A.J. Receiver Jr." }],
          externalIds: [scoped],
        }),
      ).toMatchObject({ aliases: [], issues: [{ code: "identity-unresolved" }] });
    });

    it.each(["470.p.99999", "nfl.p.99999", "nba.p.26686", "", "26686.extra"])(
      "rejects a candidate's different or malformed Yahoo fact: %s",
      (externalId) => {
        expect(
          firstPartyRosPlayerAliasPlan({
            ...common,
            externalIds: [yahoo, { playerId: canonical.playerId, source: "yahoo", externalId }],
          }),
        ).toMatchObject({ aliases: [], issues: [{ code: "identity-unresolved" }] });
      },
    );

    it("retains conflicting and outside-pool GSIS guards", () => {
      for (const gsisEvidence of [
        [{ playerId: roster.playerId, gsisId: "00-0099999" }],
        [
          { playerId: roster.playerId, gsisId: canonical.gsisId },
          { playerId: roster.playerId, gsisId: "00-0099999" },
        ],
      ]) {
        expect(firstPartyRosPlayerAliasPlan({ ...common, gsisEvidence }).aliases).toEqual([]);
      }
    });

    it("does not use a name when a paired Sleeper bridge points outside today's pool", () => {
      expect(
        firstPartyRosPlayerAliasPlan({
          ...common,
          externalIds: [
            yahoo,
            {
              playerId: "outside-pool",
              source: "sleeper-yahoo",
              externalId: "nfl.p.26686",
            },
          ],
        }),
      ).toMatchObject({ aliases: [], issues: [{ code: "identity-incompatible" }] });
    });

    it("does not treat another roster's Yahoo row as an outside-pool canonical bridge", () => {
      expect(
        firstPartyRosPlayerAliasPlan({
          ...common,
          externalIds: [
            yahoo,
            {
              playerId: "other-roster-alias",
              source: "yahoo",
              externalId: "469.p.26686",
            },
          ],
        }),
      ).toMatchObject({ aliases: [{ canonicalPlayerId: canonical.playerId }], issues: [] });
    });

    it.each([false, true])(
      "rejects one active and one outside-pool bridge in either order: %s",
      (reverse) => {
        const bridges = [
          { playerId: canonical.playerId, source: "sleeper-yahoo", externalId: "26686" },
          { playerId: "outside-pool", source: "sleeper-yahoo", externalId: "nfl.p.26686" },
        ];
        expect(
          firstPartyRosPlayerAliasPlan({
            ...common,
            externalIds: [yahoo, ...(reverse ? bridges.reverse() : bridges)],
          }),
        ).toMatchObject({ aliases: [], issues: [{ code: "identity-ambiguous" }] });
      },
    );

    it("does not use Yahoo facts to prune an ambiguous exact-name cohort", () => {
      const other = { ...canonical, playerId: "other-canonical", gsisId: "00-0031235" };
      expect(
        firstPartyRosPlayerAliasPlan({
          ...common,
          canonicalPlayers: [canonical, other],
          externalIds: [yahoo, { playerId: other.playerId, source: "yahoo", externalId: "99999" }],
        }),
      ).toMatchObject({ aliases: [], issues: [{ code: "identity-ambiguous" }] });
    });

    it("rejects conflicting or malformed anchor facts even when another bridge resolves", () => {
      for (const externalId of ["99999", "nba.p.26686", " "]) {
        expect(
          firstPartyRosPlayerAliasPlan({
            ...common,
            externalIds: [
              yahoo,
              { ...yahoo, externalId },
              { playerId: canonical.playerId, source: "sleeper-yahoo", externalId: "26686" },
            ],
          }).aliases,
        ).toEqual([]);
      }
    });

    it("retains direct canonical authority and bijection after fallback", () => {
      expect(
        firstPartyRosPlayerAliasPlan({
          ...common,
          rosterPlayers: [canonical],
          externalIds: [
            { playerId: canonical.playerId, source: "yahoo", externalId: "nba.p.26686" },
          ],
        }),
      ).toEqual({ aliases: [], issues: [] });
      expect(
        firstPartyRosPlayerAliasPlan({
          ...common,
          rosterPlayers: [roster, { ...roster, playerId: "other-yahoo" }],
          externalIds: [yahoo, { ...yahoo, playerId: "other-yahoo" }],
        }),
      ).toMatchObject({
        aliases: [],
        issues: [
          { code: "canonical-identity-not-bijective" },
          { code: "canonical-identity-not-bijective" },
        ],
      });
    });

    it("keeps ESPN opaque IDs strict even with complete Yahoo evidence", () => {
      expect(
        firstPartyRosPlayerAliasPlan({
          ...common,
          externalIds: [yahoo, { ...yahoo, source: "espn", externalId: "unmapped" }],
        }),
      ).toMatchObject({ aliases: [], issues: [{ code: "identity-unresolved" }] });
    });

    it("closes only requested Yahoo suffixes, preserving outside-pool targets", () => {
      const outside = { playerId: "outside", source: "sleeper-yahoo", externalId: "nfl.p.26686" };
      const closure = firstPartyRosYahooEvidenceClosure({
        externalIds: [yahoo],
        sourceRows: [outside, { ...outside, externalId: "99999" }],
      });
      expect(closure).toEqual({ complete: true, externalIds: [yahoo, outside] });
      expect(
        firstPartyRosPlayerAliasPlan({
          ...common,
          externalIds: closure.externalIds,
          yahooExternalEvidenceComplete: closure.complete,
        }),
      ).toMatchObject({ aliases: [], issues: [{ code: "identity-incompatible" }] });
    });

    it("fails closed beyond the catalog cap without discarding an existing explicit join", () => {
      const bridge = { playerId: canonical.playerId, source: "sleeper-yahoo", externalId: "26686" };
      const atCap = Array.from({ length: 50_000 }, () => ({ ...bridge, externalId: "99999" }));
      expect(
        firstPartyRosYahooEvidenceClosure({ externalIds: [yahoo], sourceRows: atCap }).complete,
      ).toBe(true);
      const overflow = [...atCap, bridge];
      const incomplete = firstPartyRosYahooEvidenceClosure({
        externalIds: [yahoo],
        sourceRows: overflow,
      });
      expect(incomplete).toEqual({ complete: false, externalIds: [yahoo] });
      expect(
        firstPartyRosPlayerAliasPlan({
          ...common,
          externalIds: incomplete.externalIds,
          yahooExternalEvidenceComplete: incomplete.complete,
        }),
      ).toMatchObject({ aliases: [], issues: [{ code: "identity-unresolved" }] });
      const explicit = firstPartyRosYahooEvidenceClosure({
        externalIds: [yahoo, bridge],
        sourceRows: overflow,
      });
      expect(
        firstPartyRosPlayerAliasPlan({
          ...common,
          externalIds: explicit.externalIds,
          yahooExternalEvidenceComplete: explicit.complete,
        }),
      ).toMatchObject({ aliases: [{ canonicalPlayerId: canonical.playerId }], issues: [] });
    });
  });

  it("allows a scoped unbridged ESPN self assertion to use a unique trusted-GSIS identity", () => {
    const leagueSeasonId = "11111111-1111-4111-8111-111111111111";
    const roster = {
      playerId: "provider-rb",
      fullName: "Mike Washington Jr.",
      position: "RB",
      team: "LV",
    };
    const canonical = { ...roster, playerId: "canonical-rb", gsisId: "00-0040878" };
    const common = {
      leagueSeasonId,
      rosterPlayers: [roster],
      canonicalPlayers: [canonical],
      externalIds: [
        {
          playerId: roster.playerId,
          source: "espn-self-asserted",
          externalId: `${leagueSeasonId}:4686658`,
        },
      ],
    };
    expect(firstPartyRosPlayerAliasPlan(common)).toEqual({
      aliases: [
        {
          position: "RB",
          team: "LV",
          canonicalPlayerId: canonical.playerId,
          playerId: roster.playerId,
        },
      ],
      issues: [],
    });
    // A real bridge to a different player still takes precedence and fails incompatible matching.
    const conflicting = { ...canonical, playerId: "other-rb", team: "BUF" };
    expect(
      firstPartyRosPlayerAliasPlan({
        ...common,
        canonicalPlayers: [canonical, conflicting],
        externalIds: [
          ...common.externalIds,
          { playerId: conflicting.playerId, source: "espn", externalId: "4686658" },
        ],
      }),
    ).toMatchObject({ aliases: [], issues: [{ code: "identity-incompatible" }] });
    expect(
      firstPartyRosPlayerAliasPlan({
        ...common,
        canonicalPlayers: [canonical, { ...canonical, playerId: "duplicate-rb" }],
      }),
    ).toMatchObject({ aliases: [], issues: [{ code: "identity-ambiguous" }] });
  });

  it("keeps alias issues position-scoped when applying a plan", () => {
    const result = run({
      policy: ninePlusPolicy(),
      candidatePlayers: [{ playerId: "wr-0", position: "WR", team: "BUF" }],
      matchedPositions: ["WR"],
      supportedPositions: ["WR"],
    });
    if (!result.target) throw new Error("expected a target");

    const applied = applyFirstPartyRosPlayerAliases(result.target, {
      aliases: [],
      issues: [
        { position: "WR", playerId: "ambiguous-wr", code: "effective-position-ambiguous" },
        { position: "RB", playerId: "ambiguous-rb", code: "effective-position-ambiguous" },
      ],
    });

    expect(applied.candidateUniverse.complete).toBe(false);
    expect(applied.candidateUniverse.playerAliasIssues).toEqual([
      { position: "WR", playerId: "ambiguous-wr", code: "effective-position-ambiguous" },
    ]);
  });

  it("does not substitute eligible-only fantasy positions for provider alias catalog position", () => {
    expect(
      firstPartyRosEffectiveRosterAliasPosition({
        playerId: "two-way-player",
        primaryPosition: "DB",
        eligiblePositions: ["WR"],
        candidatePositionByPlayerId: new Map(),
      }),
    ).toEqual({ ambiguousPositions: ["WR"] });
    expect(
      firstPartyRosEffectiveRosterAliasPosition({
        playerId: "canonical-two-way-player",
        primaryPosition: "DB",
        eligiblePositions: ["WR"],
        candidatePositionByPlayerId: new Map([["canonical-two-way-player", "WR"]]),
      }),
    ).toEqual({ position: "WR", ambiguousPositions: [] });
  });

  it("fingerprints resolved league alias plans without depending on insertion order", () => {
    const alias = {
      position: "WR" as const,
      team: "BUF",
      canonicalPlayerId: "canonical-wr",
      playerId: "provider-wr",
    };
    const issue = {
      position: "RB" as const,
      playerId: "provider-rb",
      code: "identity-unresolved",
    };
    const first = firstPartyRosPlayerAliasPlansChecksum(
      new Map([
        ["league-b", { aliases: [], issues: [issue] }],
        ["league-a", { aliases: [alias], issues: [] }],
      ]),
    );
    const reordered = firstPartyRosPlayerAliasPlansChecksum(
      new Map([
        ["league-a", { aliases: [alias], issues: [] }],
        ["league-b", { aliases: [], issues: [issue] }],
      ]),
    );
    const changed = firstPartyRosPlayerAliasPlansChecksum(
      new Map([
        ["league-a", { aliases: [{ ...alias, playerId: "provider-wr-new" }], issues: [] }],
        ["league-b", { aliases: [], issues: [issue] }],
      ]),
    );

    expect(first).toBe(reordered);
    expect(changed).not.toBe(first);
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
