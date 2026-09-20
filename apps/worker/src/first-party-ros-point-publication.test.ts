import { describe, expect, it } from "vitest";
import {
  FIRST_PARTY_ROS_MODEL_VERSION,
  extractFirstPartyRosPointConvergence,
  type FirstPartyRosLiveReleaseEvidence,
} from "@laces-out/projections";
import {
  pointRosReleaseFixture,
  pointConvergenceFixture,
} from "../../../packages/projections/src/point-ros-release.test-fixtures.js";
import {
  buildFirstPartyRosPlayerPersistenceRow,
  buildFirstPartyRosRunPayload,
  calibrateFirstPartyRosReleasedPlayers,
  evaluateFirstPartyRosPublication,
  firstPartyRosChampionArtifactChecksum,
  type FirstPartyRosPublicationPlayerIdentity,
  type FirstPartyRosReleasedPlayer,
} from "./first-party-ros-publication.js";
import { HISTORICAL_ROS_CANDIDATE_PAIR_VERSION } from "./first-party-ros-backtest.js";
import {
  applyFirstPartyRosPlayerAliases,
  firstPartyRosPlayerAliasPlan,
} from "./first-party-ros-candidate-provider.js";

const fixture = pointRosReleaseFixture();
const artifact = {
  ...fixture.artifact,
  artifactChecksum: firstPartyRosChampionArtifactChecksum(fixture.artifact),
};
function decide(live: FirstPartyRosLiveReleaseEvidence = fixture.live) {
  return evaluateFirstPartyRosPublication({
    artifact,
    leagueScoringProfileKey: artifact.scoringProfileKey,
    evidence: [live],
    futureWindowComplete: true,
  });
}
function player(): FirstPartyRosReleasedPlayer {
  const strategy = fixture.policy.choices.find(
    (c) => c.position === "DST" && c.bucket === "one-to-four",
  )!.strategy;
  return {
    playerId: "DST:CHI",
    bucket: "one-to-four",
    strategy,
    projection: {
      playerId: "DST:CHI",
      position: "DST",
      state: "projected",
      scheduledGames: 2,
      expectedGames: 2,
      meanPoints: 10,
      standardDeviation: 3,
      p15Points: 8,
      p50Points: 10,
      p85Points: 15,
      expectedComponents: { defensive_sacks: 2 },
      weekly: [17, 18].map((week) => ({
        week,
        scheduled: true,
        bye: false,
        availabilityProbability: 1,
      })),
      weeklyMeanSemantics: "unconditional-includes-zero-for-bye-or-unavailable",
      simulation: {
        availabilityLagOneCorrelation: null,
        roleLagOneCorrelation: null,
        boundedRoleSamples: 0,
      },
      diagnostics: [],
      provenance: {
        modelVersion: FIRST_PARTY_ROS_MODEL_VERSION,
        weeklyModelVersion: HISTORICAL_ROS_CANDIDATE_PAIR_VERSION,
        strategy,
        season: 2026,
        asOfWeek: 16,
        asOfAt: "2026-12-29T00:00:00.000Z",
        windowStartWeek: 17,
        windowEndWeek: 18,
        scenarioCount: 12288,
        randomGenerator: "xoshiro128**-sha256-128",
        seedHash: "a".repeat(64),
        inputChecksum: "b".repeat(64),
        scoringProfileKey: artifact.scoringProfileKey,
        intervalCalibration: "simulation-only",
      },
    },
  };
}
describe("separate expected-point ROS publication", () => {
  it("publishes unchanged means with every unqualified interval field explicitly null", () => {
    const decision = decide();
    expect(decision.canPublish).toBe(true);
    const [released] = calibrateFirstPartyRosReleasedPlayers({
      artifact,
      decision,
      players: [player()],
    });
    const row = buildFirstPartyRosPlayerPersistenceRow(released!);
    expect(row.playerProjection).toMatchObject({
      meanPoints: "10.000",
      floorPoints: null,
      ceilingPoints: null,
    });
    expect(row.summary).toMatchObject({
      forecastKind: "point-only",
      aggregateMeanPoints: "10.000",
      expectedGames: "2.000000",
      p15Points: null,
      p50Points: null,
      p85Points: null,
      pointsStddev: null,
      pointEvidence: { position: "DST", bucket: "one-to-four" },
    });
    expect(row.summary.intervalCalibration).toBeUndefined();
    const live = fixture.live;
    const convergence = extractFirstPartyRosPointConvergence({
      position: live.position,
      scoringProfileKey: live.scoringProfileKey,
      diagnostic: live.pointConvergence!.contextual,
    });
    const run = buildFirstPartyRosRunPayload({
      artifact,
      decision,
      convergence,
      orchestrationVersion: "test",
    });
    expect(run.calibration).toMatchObject({
      state: "unavailable",
      rosPoints: { state: "validated", intervalAvailable: false },
    });
    expect(run.calibration.rosIntervals).toBeUndefined();
    expect(run.metrics).toMatchObject({
      rosPointConvergence: { state: "converged", method: "live-bounded-ros-point-convergence-v1" },
    });
  });
  it("withholds genuinely unstable point forecasts and missing point evidence", () => {
    expect(
      decide({
        ...fixture.live,
        pointConvergence: {
          contextual: pointConvergenceFixture("DST", artifact.scoringProfileKey, "mean"),
          recency: pointConvergenceFixture("DST", artifact.scoringProfileKey, "mean"),
        },
      }).canPublish,
    ).toBe(false);
    const { pointConvergence, ...without } = fixture.live;
    void pointConvergence;
    expect(decide(without).canPublish).toBe(false);
  });
  it("rejects forged decisions, players, and a point marker without its receipt", () => {
    const decision = decide();
    const altered = structuredClone(decision);
    Object.assign(altered.releasingBuckets[0]!.gate, { evidenceChecksum: "0".repeat(64) });
    expect(() =>
      calibrateFirstPartyRosReleasedPlayers({ artifact, decision: altered, players: [player()] }),
    ).toThrow();
    expect(() =>
      calibrateFirstPartyRosReleasedPlayers({
        artifact,
        decision,
        players: [{ ...player(), playerId: "DST:NYJ" }],
      }),
    ).toThrow();
    expect(() =>
      buildFirstPartyRosPlayerPersistenceRow({ ...player(), forecastKind: "point-only" }),
    ).toThrow(/exact release evidence/);
  });
  it("publishes a provider-resolved alias while preserving the canonical simulation exactly", () => {
    const raw = player();
    const plan = firstPartyRosPlayerAliasPlan({
      leagueSeasonId: "league",
      rosterPlayers: [
        { playerId: "provider-defense", fullName: "Chicago", position: "DST", team: "CHI" },
      ],
      canonicalPlayers: [
        { playerId: raw.playerId, fullName: "Chicago", position: "DST", team: "CHI" },
      ],
    });
    const target = applyFirstPartyRosPlayerAliases(
      {
        leagueSeasonId: "league",
        leagueScoringProfileKey: artifact.scoringProfileKey,
        candidateUniverse: {
          expectedPlayerCount: 1,
          evaluatedPlayerCount: 1,
          skippedPlayerCount: 0,
          expectedPositions: ["DST"],
          evaluatedPositions: ["DST"],
          playerAliases: [],
          playerAliasIssues: [],
          complete: true,
        },
        evidence: [fixture.live],
        futureWindowComplete: true,
        convergence: extractFirstPartyRosPointConvergence({
          position: "DST",
          scoringProfileKey: artifact.scoringProfileKey,
          diagnostic: fixture.live.pointConvergence!.contextual,
        }),
        released: [raw],
        sourceAsOf: new Date(raw.projection.provenance.asOfAt),
      },
      plan,
    );
    expect(target.candidateUniverse.playerAliases).toHaveLength(1);
    const [released] = calibrateFirstPartyRosReleasedPlayers({
      artifact,
      decision: decide(),
      players: target.released,
      playerIdentity: target.candidateUniverse,
    });
    expect(released?.playerId).toBe("provider-defense");
    expect(released?.projection).toBe(raw.projection);
    expect(released?.projection.playerId).toBe("DST:CHI");
    const row = buildFirstPartyRosPlayerPersistenceRow(released!);
    expect(row.playerId).toBe("provider-defense");
    expect(row.summary.aggregateMeanPoints).toBe("10.000");
    expect(row.summary.seedHash).toBe(raw.projection.provenance.seedHash);
  });
  it.each([
    "missing",
    "canonical",
    "persistence",
    "position",
    "duplicate-persistence",
    "duplicate-canonical",
    "unresolved",
    "unbound",
    "canonical-collision",
    "duplicate-projection",
    "chain",
  ])("rejects a %s alias mismatch before granting point evidence", (kind) => {
    const raw = player();
    const aliased = { ...raw, playerId: "provider-defense" };
    let players = [aliased];
    const alias = {
      position: "DST" as const,
      canonicalPlayerId: raw.playerId,
      playerId: aliased.playerId,
    };
    let identity: FirstPartyRosPublicationPlayerIdentity = {
      playerAliases: [alias],
      playerAliasIssues: [],
    };
    if (kind === "missing") identity = { ...identity, playerAliases: [] };
    if (kind === "canonical")
      identity = { ...identity, playerAliases: [{ ...alias, canonicalPlayerId: "DST:NYJ" }] };
    if (kind === "persistence")
      identity = { ...identity, playerAliases: [{ ...alias, playerId: "other-provider" }] };
    if (kind === "position")
      identity = { ...identity, playerAliases: [{ ...alias, position: "WR" }] };
    if (kind === "duplicate-persistence")
      identity = {
        ...identity,
        playerAliases: [alias, { ...alias, canonicalPlayerId: "DST:NYJ" }],
      };
    if (kind === "duplicate-canonical")
      identity = { ...identity, playerAliases: [alias, { ...alias, playerId: "other-provider" }] };
    if (kind === "unresolved")
      identity = { ...identity, playerAliasIssues: [{ code: "identity-unresolved" }] };
    if (kind === "unbound")
      identity = {
        ...identity,
        playerAliases: [
          alias,
          { ...alias, canonicalPlayerId: "DST:NYJ", playerId: "other-provider" },
        ],
      };
    if (kind === "canonical-collision")
      players = [
        aliased,
        {
          ...raw,
          playerId: aliased.playerId,
          projection: { ...raw.projection, playerId: aliased.playerId },
        },
      ];
    if (kind === "duplicate-projection")
      players = [aliased, { ...raw, playerId: "other-provider" }];
    if (kind === "chain")
      identity = {
        ...identity,
        playerAliases: [
          alias,
          { position: "WR", canonicalPlayerId: aliased.playerId, playerId: "other-provider" },
        ],
      };
    expect(() =>
      calibrateFirstPartyRosReleasedPlayers({
        artifact,
        decision: decide(),
        players,
        playerIdentity: identity,
      }),
    ).toThrow(/Point ROS player/);
  });
  it("does not apply aliases for withheld positions to a releasing position", () => {
    const raw = player();
    const [released] = calibrateFirstPartyRosReleasedPlayers({
      artifact,
      decision: decide(),
      players: [raw],
      playerIdentity: {
        playerAliases: [
          { position: "WR", canonicalPlayerId: "canonical-wr", playerId: "provider-wr" },
        ],
        playerAliasIssues: [],
      },
    });
    expect(released?.projection).toBe(raw.projection);
  });
  it.each(["checksum", "mean", "window", "bucket"])(
    "rejects malformed raw %s before granting point evidence",
    (kind) => {
      const raw = structuredClone(player());
      if (kind === "checksum")
        Object.assign(raw.projection.provenance, { inputChecksum: "invalid" });
      if (kind === "mean") Object.assign(raw.projection, { meanPoints: Number.NaN });
      if (kind === "window") Object.assign(raw.projection.provenance, { asOfWeek: 12 });
      if (kind === "bucket") Object.assign(raw, { bucket: "nine-plus" });
      expect(() =>
        calibrateFirstPartyRosReleasedPlayers({ artifact, decision: decide(), players: [raw] }),
      ).toThrow();
    },
  );
});
