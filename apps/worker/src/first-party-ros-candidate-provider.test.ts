import {
  evaluateFirstPartyRosChampionPolicy,
  normalizeLeagueScoringProfile,
  projectionScoringProfileKey,
  runFirstPartyProjectionBacktest,
  type FirstPartyRosChampionPolicy,
  type FirstPartyRosHeldOutForecast,
  type FirstPartyWeeklyStatLine,
  type ProjectionScoringProfile,
} from "@fantasy/projections";
import { describe, expect, it } from "vitest";

import {
  calibrateHistoricalRosAvailability,
  calibrateHistoricalRosKicker,
  calibrateHistoricalRosRole,
} from "./first-party-ros-backtest.js";
import {
  buildFirstPartyRosLeagueTarget,
  enumerateFirstPartyRosScoringMatchedLeagues,
  type FirstPartyRosScoringRuleRow,
} from "./first-party-ros-candidate-provider.js";
import { firstPartyAvailableProjectionComponents } from "./first-party-projections.js";
import type { ProjectionScheduleFact } from "./first-party-projection-inputs.js";
import {
  firstPartyRosChampionArtifactChecksum,
  type FirstPartyRosChampionArtifactPayload,
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

function keyForRules(rules: readonly FirstPartyRosScoringRuleRow[]): string {
  const normalization = normalizeLeagueScoringProfile({
    id: "league:probe",
    label: "League scoring",
    rows: rules.map((rule) => ({
      provider: "yahoo",
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
  return projectionScoringProfileKey(normalization.profile);
}

describe("enumerateFirstPartyRosScoringMatchedLeagues", () => {
  it("keeps only leagues whose exact scoring-profile key equals the artifact's", () => {
    const artifactKey = keyForRules(pprRules);
    const halfPprRules = pprRules.map((rule) =>
      rule.statKey === "Receptions"
        ? { ...rule, leagueSeasonId: "L2", points: "0.5" }
        : { ...rule, leagueSeasonId: "L2" },
    );
    const matched = enumerateFirstPartyRosScoringMatchedLeagues({
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
    expect(matched.map((league) => league.leagueSeasonId)).toEqual(["L1"]);
    expect(projectionScoringProfileKey(matched[0]!.profile)).toBe(artifactKey);
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

function artifact(policy: FirstPartyRosChampionPolicy): LoadedFirstPartyRosChampionArtifact {
  const payload: FirstPartyRosChampionArtifactPayload = {
    season: 2026,
    scoringProfileKey: SCORING_KEY,
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
    rosteredPlayers: readonly {
      playerId: string;
      position: string;
      team: string | null;
    }[];
  }) {
    return buildFirstPartyRosLeagueTarget({
      artifact: artifact(input.policy),
      leagueSeasonId: "22222222-2222-4222-8222-222222222222",
      scoringProfile,
      season: 2026,
      window,
      rosteredPlayers: input.rosteredPlayers,
      featureHistory,
      calibration,
      availabilityCalibration,
      roleCalibration,
      kickerCalibration,
      injuries: [],
      schedules,
      futureWindowComplete: true,
      sourceAsOf: new Date("2026-10-06T12:00:00.000Z"),
      scenarioCount: 128,
    });
  }

  it("builds a target from rostered supported players and audits per-player skips", () => {
    const result = run({
      policy: ninePlusPolicy(),
      rosteredPlayers: [
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
  });

  it("yields no target when no rostered player has an authorizing champion choice", () => {
    // A policy carrying no WR choice cannot authorize any of this WR-only roster, so the whole
    // league fails closed rather than approximating a release.
    const base = ninePlusPolicy();
    const withoutWr: FirstPartyRosChampionPolicy = {
      ...base,
      choices: base.choices.filter((choice) => choice.position !== "WR"),
    };
    const result = run({
      policy: withoutWr,
      rosteredPlayers: [
        { playerId: "wr-0", position: "WR", team: "BUF" },
        { playerId: "wr-1", position: "WR", team: "MIA" },
      ],
    });
    expect(result.target).toBeNull();
    expect(result.leagueReason).toBe("no_releasable_candidates");
    expect(result.skippedPlayers).toBe(2);
  });
});
