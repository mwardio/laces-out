/** Point-only storage contract in a disposable database; no application DB access. */
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FIRST_PARTY_ROS_MODEL_VERSION } from "@laces-out/projections";
import { pointRosReleaseFixture } from "../../projections/src/point-ros-release.test-fixtures.js";
import {
  createDatabase,
  dataSources,
  firstPartyRosChampionArtifacts,
  playerProjections,
  playerRosProjectionSummaries,
  players,
  projectionModelRuns,
  projectionSets,
  syncRuns,
} from "./index.js";

function dockerAvailable() {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const NOW = new Date("2026-09-20T12:00:00Z");
const H = "a".repeat(64),
  Q = "b".repeat(64),
  R = "c".repeat(64);
// This constructor exercises the real point qualification and unchanged mean selector on a
// complete synthetic historical population. It is not production admission evidence.
const evidence = pointRosReleaseFixture();
const meanPolicy = evidence.policy;
const qualifications = evidence.qualifications;
const PROFILE = evidence.artifact.scoringProfileKey;
const selectedQualification = qualifications.find(
  (q) => q.position === "DST" && q.bucket === "one-to-four",
)!;
const POLICY = "season-walk-forward-mean-only-v1",
  CALIBRATION = "unavailable-point-only-v1";
const CELL = {
  position: "DST",
  bucket: "one-to-four",
  strategy: selectedQualification.selectedStrategy,
  qualificationChecksum: selectedQualification.evidenceChecksum,
  releaseEvidenceChecksum: R,
} as const;
const CONVERGENCE = {
  schemaVersion: 1,
  state: "converged",
  method: "live-bounded-ros-point-convergence-v1",
  evidenceChecksum: H,
  lowerScenarioCount: 12288,
  referenceScenarioCount: 16384,
  maxToleranceRatio: 0.5,
};
const IDENTITY = {
  season: 2026,
  horizon: "rest-of-season" as const,
  windowStartWeek: 15,
  windowEndWeek: 18,
  asOfWeek: 14,
  asOfAt: NOW,
};
type Json = Record<string, unknown>;
const clone = (value: unknown) => structuredClone(value) as Json;
const admitted = {
  schemaVersion: 1,
  method: "point-ros-release-v1",
  intervalAvailable: false,
  qualifications,
};
const sources = evidence.artifact.sourceChecksums;
const envelope = {
  schemaVersion: 1,
  method: "point-ros-release-v1",
  state: "validated",
  championArtifactChecksum: H,
  scoringProfileKey: PROFILE,
  intervalAvailable: false,
  cells: [CELL],
};
const configuration = {
  mode: "release",
  simulationModelVersion: FIRST_PARTY_ROS_MODEL_VERSION,
  orchestrationVersion: "point-test-v1",
  policyVersion: POLICY,
  calibrationVersion: CALIBRATION,
  championArtifactChecksum: H,
  scoringProfileKey: PROFILE,
  releasingBuckets: [CELL],
};

describe.skipIf(!dockerAvailable())("0055 immutable ROS point forecast contract", () => {
  const container = `laces-ros-point-pg-${randomUUID().slice(0, 8)}`;
  let handle: ReturnType<typeof createDatabase>, sourceId: string;
  beforeAll(async () => {
    const password = randomBytes(16).toString("hex");
    execFileSync(
      "docker",
      [
        "run",
        "-d",
        "--rm",
        "--name",
        container,
        "--cpus=1",
        "--memory=256m",
        "--memory-swap=256m",
        "--tmpfs",
        "/var/lib/postgresql/data",
        "-e",
        "POSTGRES_USER=point_test",
        "-e",
        `POSTGRES_PASSWORD=${password}`,
        "-e",
        "POSTGRES_DB=point_test",
        "-p",
        "127.0.0.1::5432",
        "postgres:17-alpine",
      ],
      { stdio: "ignore" },
    );
    const port = Number(
      execFileSync("docker", ["port", container, "5432/tcp"], { encoding: "utf8" })
        .trim()
        .split(":")
        .pop(),
    );
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        execFileSync(
          "docker",
          ["exec", container, "pg_isready", "-h", "127.0.0.1", "-U", "point_test"],
          { stdio: "ignore" },
        );
        break;
      } catch {
        if (Date.now() > deadline) throw new Error("Disposable DB not ready");
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    handle = createDatabase(`postgres://point_test:${password}@127.0.0.1:${port}/point_test`, 3);
    await migrate(handle.db, {
      migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)),
    });
    const [source] = await handle.db
      .insert(dataSources)
      .values({ key: "point.test", name: "Point test", kind: "test" })
      .returning();
    sourceId = source!.id;
    await handle.db.insert(firstPartyRosChampionArtifacts).values({
      season: 2026,
      scoringProfileKey: PROFILE,
      modelVersion: FIRST_PARTY_ROS_MODEL_VERSION,
      policyVersion: POLICY,
      calibrationVersion: CALIBRATION,
      evidenceThroughSeason: 2025,
      sourceChecksums: sources,
      policy: clone(meanPolicy),
      releaseGate: { pointForecasts: admitted },
      artifactChecksum: H,
      admittedAt: NOW,
    });
  }, 90_000);
  afterAll(async () => {
    try {
      await handle?.close();
    } finally {
      try {
        execFileSync("docker", ["rm", "-f", "-v", container], { stdio: "ignore" });
      } catch {
        /* creation may fail */
      }
    }
  }, 30_000);
  function fixture() {
    const projectionSetId = randomUUID(),
      sourceSyncRunId = randomUUID(),
      playerId = randomUUID();
    return {
      run: {
        sourceSyncRunId,
        sourceId,
        ...IDENTITY,
        modelVersion: FIRST_PARTY_ROS_MODEL_VERSION,
        trainingWindowStartSeason: 2022,
        trainedThroughSeason: 2025,
        qualityState: "publishable",
        playersEvaluated: 1,
        playersPublished: 1,
        inputChecksum: H,
        configuration: clone(configuration),
        calibration: { state: "unavailable", rosPoints: clone(envelope) },
        metrics: { rosPointConvergence: clone(CONVERGENCE) },
        sourceAsOf: NOW,
      } as typeof projectionModelRuns.$inferInsert,
      set: {
        id: projectionSetId,
        ...IDENTITY,
        identityState: "explicit",
        visibility: "global",
        source: "point-test",
        version: randomUUID(),
        fetchedAt: NOW,
        inputChecksum: H,
      } as typeof projectionSets.$inferInsert,
      player: {
        id: playerId,
        fullName: "Immutable point scope",
        primaryPosition: "WR",
        eligiblePositions: ["WR"],
      } as typeof players.$inferInsert,
      total: {
        projectionSetId,
        playerId,
        meanPoints: "40",
        floorPoints: null,
        ceilingPoints: null,
      } as typeof playerProjections.$inferInsert,
      summary: {
        projectionSetId,
        sourceSyncRunId,
        playerId,
        ...IDENTITY,
        scheduledGames: 4,
        expectedGames: "4",
        aggregateMeanPoints: "40",
        p15Points: null,
        p50Points: null,
        p85Points: null,
        pointsStddev: null,
        meanPointsPerExpectedGame: "10",
        availability: {
          schemaVersion: 1,
          semantics: "unconditional-active-probability",
          weeks: [15, 16, 17, 18].map((week) => ({
            week,
            scheduled: true,
            bye: false,
            availabilityProbability: 1,
          })),
        },
        intervalCalibration: null,
        forecastKind: "point-only",
        pointEvidence: { schemaVersion: 1, ...CELL },
        scenarioCount: 12288,
        methodVersion: FIRST_PARTY_ROS_MODEL_VERSION,
        seedHash: H,
        inputChecksum: H,
      } as typeof playerRosProjectionSummaries.$inferInsert,
    };
  }
  async function insert(value: ReturnType<typeof fixture>) {
    // Distinct source IDs prevent unrelated uniqueness from masking the attacked contract.
    const [source] = await handle.db
      .insert(dataSources)
      .values({ key: `point.${randomUUID()}`, name: "point", kind: "test" })
      .returning();
    value.run.sourceId = source!.id;
    await handle.db
      .insert(syncRuns)
      .values({ id: value.run.sourceSyncRunId, kind: "point-test", idempotencyKey: randomUUID() });
    await handle.db.insert(players).values(value.player);
    await handle.db.insert(projectionSets).values(value.set);
    await handle.db.insert(projectionModelRuns).values(value.run);
    await handle.db.insert(playerProjections).values(value.total);
    return handle.db.insert(playerRosProjectionSummaries).values(value.summary).returning();
  }
  it("persists means with null uncertainty and DB-derived immutable point proof", async () => {
    const f = fixture();
    f.run.pointForecastContractVersion = 1;
    const [saved] = await insert(f);
    expect(saved!.forecastKind).toBe("point-only");
    expect(saved!.p50Points).toBeNull();
    const [run] = await handle.db
      .select()
      .from(projectionModelRuns)
      .where(eq(projectionModelRuns.sourceSyncRunId, f.run.sourceSyncRunId));
    expect(run!.pointForecastContractVersion).toBe(1);
    expect(run!.marginalIntervalContractVersion).toBeNull();
    await expect(
      handle.db
        .update(playerRosProjectionSummaries)
        .set({ aggregateMeanPoints: "41" })
        .where(eq(playerRosProjectionSummaries.playerId, f.summary.playerId)),
    ).rejects.toThrow();
    await expect(
      handle.db
        .update(projectionModelRuns)
        .set({ pointForecastContractVersion: 1 })
        .where(eq(projectionModelRuns.sourceSyncRunId, f.run.sourceSyncRunId)),
    ).rejects.toThrow();
  });
  it.each([
    "interval",
    "null-mean-rate",
    "quantile",
    "stddev",
    "bound",
    "mean",
    "cell",
    "bucket",
    "proof",
    "kind",
    "availability",
    "scope",
    "checksum",
    "scenarios",
  ])("rejects invalid point summary: %s", async (attack) => {
    const f = fixture();
    if (attack === "interval")
      f.summary.intervalCalibration = { schemaVersion: 1, ...CELL, calibrationArtifactChecksum: H };
    if (attack === "null-mean-rate") f.summary.meanPointsPerExpectedGame = null;
    if (attack === "quantile") f.summary.p50Points = "40";
    if (attack === "stddev") f.summary.pointsStddev = "0";
    if (attack === "bound") f.total.floorPoints = "40";
    if (attack === "mean") f.total.meanPoints = "41";
    if (attack === "cell")
      f.summary.pointEvidence = { ...f.summary.pointEvidence!, position: "WR" };
    if (attack === "bucket")
      f.summary.pointEvidence = { ...f.summary.pointEvidence!, bucket: "nine-plus" };
    if (attack === "proof")
      f.summary.pointEvidence = { ...f.summary.pointEvidence!, releaseEvidenceChecksum: H };
    if (attack === "kind") f.summary.forecastKind = "calibrated-distribution";
    if (attack === "availability") f.summary.expectedGames = "3";
    if (attack === "scope") f.summary.asOfWeek = 13;
    if (attack === "checksum") f.summary.inputChecksum = Q;
    if (attack === "scenarios") f.summary.scenarioCount = 8192;
    await expect(insert(f)).rejects.toThrow();
  });
  it.each([
    "missing",
    "forged-stamp",
    "interval",
    "gate",
    "convergence",
    "negative-ratio",
    "lower-count",
    "reference-count",
    "evaluated-published",
    "selected-proof",
    "extra",
    "duplicate",
    "identity",
  ])("rejects invalid point run: %s", async (attack) => {
    const f = fixture();
    const points = f.run.calibration.rosPoints as Json;
    if (attack === "missing") delete f.run.calibration.rosPoints;
    if (attack === "forged-stamp") {
      delete f.run.calibration.rosPoints;
      f.run.pointForecastContractVersion = 1;
    }
    if (attack === "interval") f.run.calibration.state = "calibrated";
    if (attack === "gate")
      f.run.configuration.policyVersion = "season-walk-forward-mean-rmse-block-wis-cqr-v7";
    if (attack === "convergence")
      (f.run.metrics.rosPointConvergence as Json).maxToleranceRatio = 1.001;
    if (attack === "negative-ratio")
      (f.run.metrics.rosPointConvergence as Json).maxToleranceRatio = -0.001;
    if (attack === "lower-count")
      (f.run.metrics.rosPointConvergence as Json).lowerScenarioCount = 128;
    if (attack === "reference-count")
      (f.run.metrics.rosPointConvergence as Json).referenceScenarioCount = 12288;
    if (attack === "evaluated-published") {
      f.run.qualityState = "degraded";
      f.run.configuration.mode = "release-evaluation";
    }
    if (attack === "selected-proof") {
      (points.cells as Json[])[0]!.qualificationChecksum = R;
      f.run.configuration.releasingBuckets = points.cells;
    }
    if (attack === "extra") points.rosIntervals = {};
    if (attack === "duplicate") {
      (points.cells as Json[]).push((points.cells as Json[])[0]!);
      f.run.configuration.releasingBuckets = points.cells;
    }
    if (attack === "identity") f.run.configuration.scoringProfileKey = "other-profile";
    await expect(insert(f)).rejects.toThrow();
  });
  it("records a fully validated degraded evaluation without publication authority", async () => {
    const f = fixture();
    f.run.qualityState = "degraded";
    f.run.configuration.mode = "release-evaluation";
    f.run.playersPublished = 0;
    f.run.pointForecastContractVersion = 1;
    // Insert reaches the summary only after successfully writing its diagnostic model run.
    await expect(insert(f)).rejects.toThrow();
    const [run] = await handle.db
      .select()
      .from(projectionModelRuns)
      .where(eq(projectionModelRuns.sourceSyncRunId, f.run.sourceSyncRunId));
    expect(run!.pointForecastContractVersion).toBeNull();
    expect(run!.playersPublished).toBe(0);
    const malformed = fixture();
    malformed.run.qualityState = "degraded";
    malformed.run.configuration.mode = "release-evaluation";
    malformed.run.playersPublished = 0;
    delete malformed.run.calibration.rosPoints;
    await expect(insert(malformed)).rejects.toThrow();
  });
  it("rejects mixed and mutated immutable qualification semantics", async () => {
    const accepted = async (
      proof: unknown,
      policy: unknown = meanPolicy,
      sourceChecksums: unknown = sources,
    ) =>
      (
        await handle.db.execute(
          sql`select ros_point_envelope(${JSON.stringify(envelope)}::jsonb,${JSON.stringify(proof)}::jsonb,${JSON.stringify(policy)}::jsonb,${JSON.stringify(configuration)}::jsonb,${JSON.stringify(sourceChecksums)}::jsonb,2026) as valid`,
        )
      )[0]!.valid;
    expect(await accepted(admitted)).toBe(true);
    for (const attack of [
      "source",
      "support",
      "strategy",
      "duplicate",
      "method",
      "extra",
      "selected-convergence",
    ] as const) {
      const proof = clone(admitted),
        rows = proof.qualifications as Json[],
        q = rows.find((q) => q.position === CELL.position && q.bucket === CELL.bucket)!;
      if (attack === "source") q.comparisonManifestChecksum = R;
      if (attack === "support") (q.support as Json).samples = 17;
      if (attack === "strategy")
        q.selectedStrategy =
          CELL.strategy === "contextual" ? "availability-aware-recency" : "contextual";
      if (attack === "duplicate") rows[0] = q;
      if (attack === "method") q.meanPolicyVersion = "invented";
      if (attack === "extra") q.unknown = true;
      if (attack === "selected-convergence")
        (q.convergence as Json)[CELL.strategy === "contextual" ? "contextual" : "recency"] = {
          samples: selectedQualification.support.seasons,
          converged: selectedQualification.support.seasons - 1,
          rate: (selectedQualification.support.seasons - 1) / selectedQualification.support.seasons,
          evidenceChecksum: H,
        };
      expect(await accepted(proof), attack).toBe(false);
    }
    const weakened = clone(meanPolicy);
    weakened.minimumModelImprovement = 0;
    expect(await accepted(admitted, weakened)).toBe(false);
    expect(await accepted(admitted, meanPolicy, sources.slice(1))).toBe(false);
    expect(
      await accepted(admitted, meanPolicy, [...sources, { ...sources[0]!, checksum: R }]),
    ).toBe(false);
  });
});
