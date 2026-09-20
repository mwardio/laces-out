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
  type FirstPartyRosReleasedPlayer,
} from "./first-party-ros-publication.js";
import { HISTORICAL_ROS_CANDIDATE_PAIR_VERSION } from "./first-party-ros-backtest.js";

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
