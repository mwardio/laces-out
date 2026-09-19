/** Forward-only ROS interval contract against disposable PostgreSQL; no application DB access. */
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildRosMarginalIntervalQualificationFullFixture,
  rosMarginalIntervalQualificationFullFixtureInput,
} from "../../projections/src/ros-marginal-interval-test-fixtures.js";
import {
  buildRosMarginalIntervalStorage,
  buildRosMarginalIntervalStoredCells,
  type RosMarginalIntervalStorage,
} from "../../projections/src/ros-marginal-interval-storage.js";
import { evaluateFirstPartyRosChampionPolicy } from "../../projections/src/rest-of-season.js";
import { sha256Hex } from "../../projections/src/sha256.js";
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
const LEGACY = {
  schemaVersion: 1,
  state: "calibrated",
  method: "season-blocked-split-conformal-cqr-v1",
  evidenceChecksum: "a".repeat(64),
  heldOutSeasons: 3,
  batches: 30,
  samples: 300,
  nominalCoverage: 0.7,
  empiricalCoverage: 0.7,
  maximumAllowedCoverageError: 0.1,
};
const NOW = new Date("2026-09-18T12:00:00Z");
const IDENTITY = {
  season: 2026,
  horizon: "rest-of-season" as const,
  windowStartWeek: 15,
  windowEndWeek: 18,
  asOfWeek: 14,
  asOfAt: NOW,
};
const CELL = { position: "DST", bucket: "one-to-four" } as const;
const METHOD = "season-prior-weighted-quantile-residuals-v1";
const POLICY = "season-walk-forward-mean-rmse-marginal-quantiles-v8";
const CONVERGENCE = {
  schemaVersion: 1,
  state: "converged",
  method: "deterministic-reference-v1",
  evidenceChecksum: "b".repeat(64),
  lowerScenarioCount: 12288,
  referenceScenarioCount: 16384,
  maxToleranceRatio: 0.5,
};
type Json = Record<string, unknown>;

// Deliberately mutable JSON for adversarial stored-payload controls.
function json<T>(value: T): Json {
  return structuredClone(value) as Json;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function rehash(value: Json, key: string) {
  delete value[key];
  value[key] = sha256Hex(canonical(value));
}
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, child]) => [key, reverseKeys(child)]),
    );
  return value;
}

describe.skipIf(!dockerAvailable())("0053 immutable ROS marginal persistence", () => {
  const container = `laces-ros-marginal-pg-${randomUUID().slice(0, 8)}`;
  let handle: ReturnType<typeof createDatabase>;
  let artifact: typeof firstPartyRosChampionArtifacts.$inferInsert;
  let envelope: RosMarginalIntervalStorage;
  let configuration: Json;
  let sourceId: string;
  let qualifications: ReturnType<typeof buildRosMarginalIntervalQualificationFullFixture>;
  let historic: ReturnType<typeof fixture>;
  beforeAll(async () => {
    qualifications = buildRosMarginalIntervalQualificationFullFixture();
    const input = rosMarginalIntervalQualificationFullFixtureInput();
    const policy = evaluateFirstPartyRosChampionPolicy(
      input.candidate.heldOutSeasons,
      qualifications[0]!.meanSelectorOptions,
    ).livePolicy;
    const artifactChecksum = sha256Hex("full-scope-immutable-test-champion");
    artifact = {
      season: 2026,
      scoringProfileKey: input.candidate.source.scoringProfileKey,
      modelVersion: input.candidate.source.modelVersion,
      policyVersion: POLICY,
      calibrationVersion: METHOD,
      evidenceThroughSeason: 2025,
      sourceChecksums: [
        { key: "fixture.physical", checksum: input.candidate.source.physicalCorpusChecksum },
      ],
      policy: json(policy),
      releaseGate: {
        marginalIntervals: {
          schemaVersion: 1,
          qualificationMethod: "ros-marginal-interval-qualification-v1",
          qualifications,
          cells: buildRosMarginalIntervalStoredCells({
            qualifications,
            releasedCells: qualifications.filter((q) => q.state === "qualified").map((q) => q.cell),
          }),
        },
      },
      artifactChecksum,
      admittedAt: NOW,
    };
    envelope = buildRosMarginalIntervalStorage({
      qualifications,
      championArtifactChecksum: artifactChecksum,
      releasedCells: [CELL],
    });
    const qualification = qualifications.find(
      (q) => q.cell.position === CELL.position && q.cell.bucket === CELL.bucket,
    )!;
    configuration = {
      mode: "release",
      simulationModelVersion: artifact.modelVersion,
      orchestrationVersion: "fixture-orchestration-v1",
      policyVersion: POLICY,
      calibrationVersion: METHOD,
      championArtifactChecksum: artifactChecksum,
      scoringProfileKey: artifact.scoringProfileKey,
      releasingBuckets: [
        {
          ...CELL,
          strategy: qualification.strategy,
          intervalCalibration: {
            method: METHOD,
            qualificationChecksum: qualification.qualificationChecksum,
            artifactChecksum: qualification.liveArtifact.artifactChecksum,
            releaseGateEvidenceChecksum: sha256Hex("live-cell-gate"),
            artifact: qualification.liveArtifact,
          },
        },
      ],
    };
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
        "POSTGRES_USER=interval_test",
        "-e",
        `POSTGRES_PASSWORD=${password}`,
        "-e",
        "POSTGRES_DB=interval_test",
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
    if (!Number.isInteger(port) || port <= 0) throw new Error("Disposable database port missing");
    handle = createDatabase(
      `postgres://interval_test:${password}@127.0.0.1:${port}/interval_test`,
      3,
    );
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        execFileSync(
          "docker",
          ["exec", container, "pg_isready", "-h", "127.0.0.1", "-U", "interval_test"],
          { stdio: "ignore" },
        );
        break;
      } catch {
        if (Date.now() > deadline) throw new Error("Disposable database did not start");
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));
    const priorMigrations = mkdtempSync(join(tmpdir(), "laces-ros-prior-migrations-"));
    try {
      cpSync(migrationsFolder, priorMigrations, { recursive: true });
      const journalPath = join(priorMigrations, "meta/_journal.json");
      const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
        entries: { idx: number }[];
      };
      journal.entries = journal.entries.filter((entry) => entry.idx < 53);
      writeFileSync(journalPath, JSON.stringify(journal));
      await migrate(handle.db, { migrationsFolder: priorMigrations });
    } finally {
      rmSync(priorMigrations, { recursive: true, force: true });
    }
    const [source] = await handle.db
      .insert(dataSources)
      .values({ key: "marginal.pg-test", name: "ROS marginal test", kind: "test" })
      .returning();
    sourceId = source!.id;
    historic = fixture();
    await handle.db
      .insert(syncRuns)
      .values({ id: historic.run.sourceSyncRunId, kind: "pre-0053", idempotencyKey: randomUUID() });
    await handle.db.insert(players).values(historic.player);
    await handle.db.insert(projectionSets).values(historic.set);
    await handle.db.insert(playerProjections).values(historic.total);
    await handle.db.execute(sql`insert into projection_model_runs
      (source_sync_run_id,source_id,season,horizon,window_start_week,window_end_week,as_of_week,as_of_at,model_version,
       training_window_start_season,trained_through_season,quality_state,players_evaluated,players_published,
       input_checksum,configuration,calibration,metrics,source_as_of)
      values (${historic.run.sourceSyncRunId},${sourceId},2026,'rest-of-season',15,18,14,${NOW.toISOString()},${artifact.modelVersion},
        2022,2025,'publishable',1,1,${historic.run.inputChecksum},${JSON.stringify(historic.run.configuration)}::jsonb,
        ${JSON.stringify(historic.run.calibration)}::jsonb,${JSON.stringify(historic.run.metrics)}::jsonb,${NOW.toISOString()})`);
    await migrate(handle.db, { migrationsFolder });
    await handle.db.insert(firstPartyRosChampionArtifacts).values(artifact);
  }, 90_000);
  afterAll(async () => {
    try {
      await handle?.close();
    } finally {
      try {
        execFileSync("docker", ["rm", "-f", "-v", container], { stdio: "ignore" });
      } catch {
        /* Startup can fail before creation. */
      }
    }
  }, 30_000);

  function fixture(legacy = false) {
    const checksum = sha256Hex(randomUUID());
    const projectionSetId = randomUUID(),
      sourceSyncRunId = randomUUID(),
      playerId = randomUUID();
    const cell = envelope.cells[0]!;
    return {
      set: {
        id: projectionSetId,
        ...IDENTITY,
        visibility: "global",
        identityState: "explicit",
        source: "marginal-test",
        version: randomUUID(),
        fetchedAt: NOW,
        inputChecksum: checksum,
      } as typeof projectionSets.$inferInsert,
      run: {
        sourceSyncRunId,
        sourceId,
        ...IDENTITY,
        modelVersion: artifact.modelVersion,
        trainingWindowStartSeason: 2022,
        trainedThroughSeason: 2025,
        qualityState: "publishable",
        playersEvaluated: 1,
        playersPublished: 1,
        inputChecksum: checksum,
        configuration: json(configuration),
        calibration: { rosIntervals: legacy ? json(LEGACY) : json(envelope) },
        metrics: { rosConvergence: json(CONVERGENCE) },
        sourceAsOf: NOW,
      } as typeof projectionModelRuns.$inferInsert,
      player: {
        id: playerId,
        fullName: "Mutable catalog does not control immutable interval scope",
        primaryPosition: "WR",
        eligiblePositions: ["WR"],
      } as typeof players.$inferInsert,
      total: {
        projectionSetId,
        playerId,
        meanPoints: "40.000",
        floorPoints: "20.000",
        ceilingPoints: "60.000",
      } as typeof playerProjections.$inferInsert,
      summary: {
        projectionSetId,
        sourceSyncRunId,
        playerId,
        season: 2026,
        windowStartWeek: 15,
        windowEndWeek: 18,
        asOfWeek: 14,
        asOfAt: NOW,
        scheduledGames: 4,
        expectedGames: "4.000000",
        aggregateMeanPoints: "40.000",
        p15Points: "20.000",
        p50Points: "40.000",
        p85Points: "60.000",
        meanPointsPerExpectedGame: "10.000000",
        pointsStddev: "10.000",
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
        intervalCalibration: legacy
          ? null
          : {
              schemaVersion: 1,
              ...CELL,
              strategy: cell.strategy,
              qualificationChecksum: cell.qualificationChecksum,
              calibrationArtifactChecksum: cell.artifactChecksum,
              releaseEvidenceChecksum: envelope.evidenceChecksum,
            },
        scenarioCount: 12288,
        methodVersion: artifact.modelVersion,
        seedHash: "c".repeat(64),
        inputChecksum: checksum,
      } as typeof playerRosProjectionSummaries.$inferInsert,
    };
  }
  async function prepare(value: ReturnType<typeof fixture>) {
    await handle.db.insert(syncRuns).values({
      id: value.run.sourceSyncRunId,
      kind: "marginal-pg",
      state: "complete",
      idempotencyKey: randomUUID(),
    });
    await handle.db.insert(players).values(value.player);
    await handle.db.insert(projectionSets).values(value.set);
    await handle.db.insert(projectionModelRuns).values(value.run);
    await handle.db.insert(playerProjections).values(value.total);
  }
  async function insert(value: ReturnType<typeof fixture>) {
    await prepare(value);
    return handle.db.insert(playerRosProjectionSummaries).values(value.summary).returning();
  }
  const runEnvelope = (value: ReturnType<typeof fixture>) =>
    value.run.calibration.rosIntervals as Json;
  const runCell = (value: ReturnType<typeof fixture>) => (runEnvelope(value).cells as Json[])[0]!;

  it("retains the0025 noninterval guards verbatim and records the new nullable schema column", () => {
    const old = readFileSync(
      new URL("../migrations/0025_ros_scenario_contract.sql", import.meta.url),
      "utf8",
    );
    const next = readFileSync(
      new URL("../migrations/0053_ros_marginal_interval_contract.sql", import.meta.url),
      "utf8",
    );
    expect(next).toContain(old.slice(old.indexOf("  convergence_diagnostic :=")));
    expect(next.replace(', "marginal_interval_contract_version"', "")).toContain(
      old.slice(old.indexOf('  SELECT\n    "season"'), old.indexOf("  interval_calibration :=")),
    );
  });
  it("persists valid schema2 with immutable position scope and JSONB key ordering", async () => {
    const value = fixture();
    value.run.configuration = reverseKeys(value.run.configuration) as Json;
    value.run.calibration = reverseKeys(value.run.calibration) as Json;
    const [row] = await insert(value);
    expect(row!.intervalCalibration).toEqual(value.summary.intervalCalibration);
    expect(row!.scenarioCount).toBe(12288);
    const [run] = await handle.db
      .select()
      .from(projectionModelRuns)
      .where(eq(projectionModelRuns.sourceSyncRunId, value.run.sourceSyncRunId));
    expect(run!.marginalIntervalContractVersion).toBe(2);
  });
  it("keeps valid legacy summaries null without reinterpreting their intervals", async () => {
    const [row] = await insert(fixture(true));
    expect(row!.intervalCalibration).toBeNull();
  });
  it("does not trust caller stamps and keeps legacy runs unstamped", async () => {
    const invalid = fixture();
    invalid.run.marginalIntervalContractVersion = 2;
    (invalid.run.calibration.rosIntervals as Json).cells = [];
    await expect(prepare(invalid)).rejects.toThrow();
    const legacy = fixture(true);
    legacy.run.marginalIntervalContractVersion = 2;
    await prepare(legacy);
    const [run] = await handle.db
      .select()
      .from(projectionModelRuns)
      .where(eq(projectionModelRuns.sourceSyncRunId, legacy.run.sourceSyncRunId));
    expect(run!.marginalIntervalContractVersion).toBeNull();
  });
  it("leaves pre0053 runs unstamped and rejects backfill or mutation even without summaries", async () => {
    const [run] = await handle.db
      .select()
      .from(projectionModelRuns)
      .where(eq(projectionModelRuns.sourceSyncRunId, historic.run.sourceSyncRunId));
    expect(run!.marginalIntervalContractVersion).toBeNull();
    await expect(
      handle.db.insert(playerRosProjectionSummaries).values(historic.summary),
    ).rejects.toThrow();
    await expect(
      handle.db
        .update(projectionModelRuns)
        .set({ marginalIntervalContractVersion: 2 })
        .where(eq(projectionModelRuns.sourceSyncRunId, historic.run.sourceSyncRunId)),
    ).rejects.toThrow();
    const fresh = fixture();
    await prepare(fresh);
    await expect(
      handle.db
        .update(projectionModelRuns)
        .set({ marginalIntervalContractVersion: null })
        .where(eq(projectionModelRuns.sourceSyncRunId, fresh.run.sourceSyncRunId)),
    ).rejects.toThrow();
    await expect(
      handle.db
        .update(projectionModelRuns)
        .set({ calibration: {} })
        .where(eq(projectionModelRuns.sourceSyncRunId, fresh.run.sourceSyncRunId)),
    ).rejects.toThrow();
  });
  it("rejects a legacy summary falsely claiming marginal metadata", async () => {
    const value = fixture(true);
    value.summary.intervalCalibration = fixture().summary.intervalCalibration;
    await expect(insert(value)).rejects.toThrow();
  });
  it.each([
    [
      "missing row scope",
      (v: ReturnType<typeof fixture>) => {
        v.summary.intervalCalibration = null;
      },
    ],
    [
      "different row position",
      (v: ReturnType<typeof fixture>) => {
        v.summary.intervalCalibration = { ...v.summary.intervalCalibration!, position: "WR" };
      },
    ],
    [
      "different row bucket",
      (v: ReturnType<typeof fixture>) => {
        v.summary.intervalCalibration = { ...v.summary.intervalCalibration!, bucket: "nine-plus" };
      },
    ],
    [
      "different row strategy",
      (v: ReturnType<typeof fixture>) => {
        v.summary.intervalCalibration = {
          ...v.summary.intervalCalibration!,
          strategy: "contextual",
        };
      },
    ],
    [
      "different qualification",
      (v: ReturnType<typeof fixture>) => {
        v.summary.intervalCalibration = {
          ...v.summary.intervalCalibration!,
          qualificationChecksum: "a".repeat(64),
        };
      },
    ],
    [
      "different fit",
      (v: ReturnType<typeof fixture>) => {
        v.summary.intervalCalibration = {
          ...v.summary.intervalCalibration!,
          calibrationArtifactChecksum: "a".repeat(64),
        };
      },
    ],
    [
      "different release envelope",
      (v: ReturnType<typeof fixture>) => {
        v.summary.intervalCalibration = {
          ...v.summary.intervalCalibration!,
          releaseEvidenceChecksum: "a".repeat(64),
        };
      },
    ],
    [
      "extra row field",
      (v: ReturnType<typeof fixture>) => {
        Object.assign(v.summary.intervalCalibration!, { approved: true });
      },
    ],
    [
      "empty released cells",
      (v: ReturnType<typeof fixture>) => {
        runEnvelope(v).releasedCells = [];
        runEnvelope(v).cells = [];
      },
    ],
    [
      "extra envelope field",
      (v: ReturnType<typeof fixture>) => {
        runEnvelope(v).approved = true;
      },
    ],
    [
      "extra compact field",
      (v: ReturnType<typeof fixture>) => {
        runCell(v).approved = true;
      },
    ],
    [
      "unknown method",
      (v: ReturnType<typeof fixture>) => {
        runEnvelope(v).method = "something-else";
      },
    ],
    [
      "wrong quantiles",
      (v: ReturnType<typeof fixture>) => {
        runEnvelope(v).quantiles = [0.1, 0.5, 0.9];
      },
    ],
    [
      "wrong nominal",
      (v: ReturnType<typeof fixture>) => {
        runEnvelope(v).nominalCoverage = 0.8;
      },
    ],
    [
      "null strategy",
      (v: ReturnType<typeof fixture>) => {
        runCell(v).strategy = null;
      },
    ],
    [
      "short annual support",
      (v: ReturnType<typeof fixture>) => {
        (runCell(v).annualSupport as Json[])[0]!.samples = 17;
      },
    ],
    [
      "few cutoffs",
      (v: ReturnType<typeof fixture>) => {
        (runCell(v).annualSupport as Json[])[0]!.cutoffs = [15, 16];
      },
    ],
    [
      "dropped year",
      (v: ReturnType<typeof fixture>) => {
        (runCell(v).requiredEvaluationSeasons as number[]).pop();
        (runCell(v).annualSupport as Json[]).pop();
      },
    ],
    [
      "forged aggregate",
      (v: ReturnType<typeof fixture>) => {
        runCell(v).aggregate = {
          coverage: { numerator: "3", denominator: "5" },
          lowerTail: { numerator: "1", denominator: "5" },
          upperTail: { numerator: "1", denominator: "5" },
        };
      },
    ],
    [
      "worse benchmark WIS",
      (v: ReturnType<typeof fixture>) => {
        runCell(v).candidateWis = 1;
        (runCell(v).benchmarkWis as Json)["previous-deployed"] = 0;
      },
    ],
    [
      "wrong scoring",
      (v: ReturnType<typeof fixture>) => {
        v.run.configuration.scoringProfileKey = "other";
      },
    ],
    [
      "wrong champion",
      (v: ReturnType<typeof fixture>) => {
        v.run.configuration.championArtifactChecksum = "a".repeat(64);
      },
    ],
    [
      "wrong run policy",
      (v: ReturnType<typeof fixture>) => {
        v.run.configuration.policyVersion = "v7";
      },
    ],
    [
      "wrong run calibration",
      (v: ReturnType<typeof fixture>) => {
        v.run.configuration.calibrationVersion = "legacy";
      },
    ],
    [
      "missing bucket configuration",
      (v: ReturnType<typeof fixture>) => {
        v.run.configuration.releasingBuckets = [];
      },
    ],
    [
      "mutated executable fit",
      (v: ReturnType<typeof fixture>) => {
        const bucket = (v.run.configuration.releasingBuckets as Json[])[0]!;
        (bucket.intervalCalibration as Json).artifact = {};
      },
    ],
    [
      "wrong season",
      (v: ReturnType<typeof fixture>) => {
        runEnvelope(v).forecastSeason = 2027;
      },
    ],
  ] as const)("rejects %s with fresh outer checksums", async (_name, mutate) => {
    const value = fixture();
    mutate(value);
    for (const cell of runEnvelope(value).cells as Json[]) rehash(cell, "cellChecksum");
    rehash(runEnvelope(value), "evidenceChecksum");
    if (value.summary.intervalCalibration && _name !== "different release envelope")
      value.summary.intervalCalibration = {
        ...value.summary.intervalCalibration,
        releaseEvidenceChecksum: runEnvelope(value).evidenceChecksum as string,
      };
    await expect(insert(value)).rejects.toThrow();
  });
  it.each([
    [
      "scenario too small",
      (v: ReturnType<typeof fixture>) => {
        v.summary.scenarioCount = 127;
      },
    ],
    [
      "scenario above reference",
      (v: ReturnType<typeof fixture>) => {
        v.summary.scenarioCount = 16385;
      },
    ],
    [
      "different input",
      (v: ReturnType<typeof fixture>) => {
        v.summary.inputChecksum = "d".repeat(64);
      },
    ],
    [
      "different method",
      (v: ReturnType<typeof fixture>) => {
        v.summary.methodVersion = "wrong";
      },
    ],
    [
      "different total",
      (v: ReturnType<typeof fixture>) => {
        v.total.meanPoints = "41.000";
      },
    ],
    [
      "unordered quantiles",
      (v: ReturnType<typeof fixture>) => {
        v.summary.p50Points = "100.000";
      },
    ],
    [
      "unreconciled mean",
      (v: ReturnType<typeof fixture>) => {
        v.summary.meanPointsPerExpectedGame = "9.000000";
      },
    ],
    [
      "duplicate availability week",
      (v: ReturnType<typeof fixture>) => {
        v.summary.availability = {
          ...v.summary.availability,
          weeks: [v.summary.availability.weeks[0]!, ...v.summary.availability.weeks.slice(0, 3)],
        };
      },
    ],
    [
      "failed convergence",
      (v: ReturnType<typeof fixture>) => {
        (v.run.metrics.rosConvergence as Json).state = "failed";
      },
    ],
    [
      "invalid tolerance",
      (v: ReturnType<typeof fixture>) => {
        (v.run.metrics.rosConvergence as Json).maxToleranceRatio = 1.0001;
      },
    ],
    [
      "degraded run",
      (v: ReturnType<typeof fixture>) => {
        v.run.qualityState = "degraded";
      },
    ],
    [
      "mismatched window",
      (v: ReturnType<typeof fixture>) => {
        v.summary.asOfWeek = 13;
      },
    ],
  ] as const)("preserves legacy numeric/scope guard: %s", async (_name, mutate) => {
    const value = fixture();
    mutate(value);
    await expect(insert(value)).rejects.toThrow();
  });
  it.each([
    "missing",
    "duplicate",
    "changedMean",
    "changedFit",
    "missingCompact",
    "fakeQualified",
    "missingHistoricalFit",
    "emptyAuditBlocks",
    "missingLinkage",
    "futureHistoricalFit",
    "extraFitContext",
    "wrongEvidenceMethod",
  ] as const)("rejects incomplete or altered immutable admission: %s", async (mutation) => {
    const changed = structuredClone(artifact);
    changed.artifactChecksum = sha256Hex(randomUUID());
    const marginal = changed.releaseGate.marginalIntervals as Json;
    const proof = marginal.qualifications as Json[];
    if (mutation === "missing") proof.pop();
    if (mutation === "duplicate") proof[0] = proof[1]!;
    if (mutation === "changedMean") (proof[0]!.meanChoice as Json).strategy = "contextual";
    if (mutation === "changedFit")
      (proof[0]!.liveArtifact as Json).artifactChecksum = "a".repeat(64);
    if (mutation === "missingCompact") (marginal.cells as Json[]).pop();
    if (mutation === "fakeQualified") proof[0]!.state = "admitted";
    if (mutation === "missingHistoricalFit")
      (proof[0]!.historicalArtifacts as Json[])[0]!.artifact = {};
    if (mutation === "emptyAuditBlocks") (proof[0]!.evidence as Json).blocks = [];
    if (mutation === "missingLinkage") (proof[0]!.linkage as Json[]).pop();
    if (mutation === "futureHistoricalFit")
      ((proof[0]!.historicalArtifacts as Json[])[0]!.artifact as Json).fit = {
        forecastSeason: 2099,
      };
    if (mutation === "extraFitContext")
      ((proof[0]!.liveArtifact as Json).context as Json).unknown = true;
    if (mutation === "wrongEvidenceMethod") (proof[0]!.evidence as Json).version = "invented";
    await handle.db.insert(firstPartyRosChampionArtifacts).values(changed);
    const value = fixture();
    value.run.configuration.championArtifactChecksum = changed.artifactChecksum;
    runEnvelope(value).championArtifactChecksum = changed.artifactChecksum;
    rehash(runEnvelope(value), "evidenceChecksum");
    value.summary.intervalCalibration = {
      ...value.summary.intervalCalibration!,
      releaseEvidenceChecksum: runEnvelope(value).evidenceChecksum as string,
    };
    await expect(insert(value)).rejects.toThrow();
  });
  it("preserves append-only retention on summaries, runs and champion evidence", async () => {
    const value = fixture();
    await insert(value);
    await expect(
      handle.db
        .update(playerRosProjectionSummaries)
        .set({ intervalCalibration: null })
        .where(eq(playerRosProjectionSummaries.projectionSetId, value.set.id!)),
    ).rejects.toThrow();
    await expect(
      handle.db
        .delete(playerRosProjectionSummaries)
        .where(eq(playerRosProjectionSummaries.projectionSetId, value.set.id!)),
    ).rejects.toThrow();
    await expect(
      handle.db
        .update(projectionModelRuns)
        .set({ calibration: {} })
        .where(eq(projectionModelRuns.sourceSyncRunId, value.run.sourceSyncRunId)),
    ).rejects.toThrow();
    await expect(
      handle.db
        .update(firstPartyRosChampionArtifacts)
        .set({ releaseGate: {} })
        .where(eq(firstPartyRosChampionArtifacts.artifactChecksum, artifact.artifactChecksum)),
    ).rejects.toThrow();
    await expect(
      handle.db
        .delete(firstPartyRosChampionArtifacts)
        .where(eq(firstPartyRosChampionArtifacts.artifactChecksum, artifact.artifactChecksum)),
    ).rejects.toThrow();
    await expect(
      handle.db
        .update(projectionSets)
        .set({ asOfWeek: 13 })
        .where(eq(projectionSets.id, value.set.id!)),
    ).rejects.toThrow();
  });
  it("bounds adversarial rational work and preserves strict SQL thresholds", async () => {
    const cell = json(envelope.cells[0]);
    const denominator = (10n ** 1000n + 1n).toString();
    for (const year of cell.annualSupport as Json[])
      Object.assign(year, {
        coverage: { numerator: (BigInt(denominator) - 2n).toString(), denominator },
        lowerTail: { numerator: "1", denominator },
        upperTail: { numerator: "1", denominator },
      });
    const result = await handle.db.execute<{ valid: boolean }>(
      sql`select ros_marginal_cell(${JSON.stringify(cell)}::jsonb) as valid`,
    );
    expect(result[0]!.valid).toBe(false);
    const valid = json(envelope.cells[0]);
    const metrics = {
      coverage: { numerator: "3", denominator: "5" },
      lowerTail: { numerator: "1", denominator: "4" },
      upperTail: { numerator: "3", denominator: "20" },
    };
    valid.aggregate = metrics;
    for (const year of valid.annualSupport as Json[]) Object.assign(year, metrics);
    expect(
      (
        await handle.db.execute<{ valid: boolean }>(
          sql`select ros_marginal_cell(${JSON.stringify(valid)}::jsonb) as valid`,
        )
      )[0]!.valid,
    ).toBe(true);
  });
  it("measures 300 summaries sharing one immutable run and admitted full scope", async () => {
    const value = fixture();
    await prepare(value);
    const extraPlayers = Array.from({ length: 299 }, () => ({ ...value.player, id: randomUUID() }));
    await handle.db.insert(players).values(extraPlayers);
    await handle.db
      .insert(playerProjections)
      .values(extraPlayers.map((player) => ({ ...value.total, playerId: player.id })));
    const summaries = [
      value.summary,
      ...extraPlayers.map((player) => ({ ...value.summary, playerId: player.id })),
    ];
    const started = performance.now();
    await handle.db.insert(playerRosProjectionSummaries).values(summaries);
    const milliseconds = performance.now() - started;
    writeFileSync(
      "/tmp/laces-0053-persistence-benchmark.json",
      JSON.stringify({
        rows: 300,
        totalMilliseconds: milliseconds,
        millisecondsPerRow: milliseconds / 300,
      }),
    );
    console.info(
      `ROS schema2 PostgreSQL: 300 rows ${milliseconds.toFixed(1)} ms total; ${(milliseconds / 300).toFixed(2)} ms/row`,
    );
    const count = await handle.db.execute<{ count: number }>(
      sql`select count(*)::integer as count from player_ros_projection_summaries where projection_set_id=${value.set.id}`,
    );
    expect(count[0]!.count).toBe(300);
  }, 120_000);
  it.each([
    ["coverage", "599999", "200001", "200000"],
    ["lower tail", "600000", "250001", "149999"],
    ["upper tail", "600000", "149999", "250001"],
  ] as const)(
    "rejects exact rational %s just outside the fixed bound",
    async (_name, covered, lower, upper) => {
      const cell = json(envelope.cells[0]);
      const reduce = (numerator: string) => {
        let n = BigInt(numerator),
          d = 1_000_000n,
          a = n,
          b = d;
        while (b !== 0n) [a, b] = [b, a % b];
        n /= a;
        d /= a;
        return { numerator: n.toString(), denominator: d.toString() };
      };
      const metrics = {
        coverage: reduce(covered),
        lowerTail: reduce(lower),
        upperTail: reduce(upper),
      };
      cell.aggregate = metrics;
      for (const year of cell.annualSupport as Json[]) Object.assign(year, metrics);
      expect(
        (
          await handle.db.execute<{ valid: boolean }>(
            sql`select ros_marginal_cell(${JSON.stringify(cell)}::jsonb) as valid`,
          )
        )[0]!.valid,
      ).toBe(false);
    },
  );
});
