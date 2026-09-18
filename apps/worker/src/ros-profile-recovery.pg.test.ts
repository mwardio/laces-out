/** Operational recovery against disposable PostgreSQL; no production DB, model run, or queue. */
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  createDatabase,
  firstPartyRosChampionArtifacts,
  firstPartyRosProfileValidations,
} from "@laces-out/db";
import type { RosProfileValidationJob } from "@laces-out/jobs";
import {
  FIRST_PARTY_ROS_INTERVAL_CALIBRATION_VERSION,
  FIRST_PARTY_ROS_MODEL_VERSION,
  FIRST_PARTY_ROS_POLICY_VERSION,
  projectionScoringProfileKey,
  rosProfileDefinitionFromKey,
} from "@laces-out/projections";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { RosProfileRecoveryService } from "./ros-profile-recovery.js";
import {
  ROS_PROFILE_RECOVERY_MAXIMUM_DELAY_MS,
  ROS_PROFILE_RECOVERY_MINIMUM_DELAY_MS,
} from "./ros-profile-recovery-state.js";
import {
  DrizzleRosProfileValidationRepository,
  RosProfileValidationService,
} from "./ros-profile-validation.js";
import { validReport } from "./ros-profile-validation.test-fixtures.js";
import type { RosProfileValidationRunner } from "./ros-profile-validation-runner.js";

const CORPUS_A = "a".repeat(64);
const CORPUS_B = "b".repeat(64);
const NOW = new Date("2026-09-17T22:00:00.000Z");
const PRIOR = new Date("2026-09-17T21:00:00.000Z");
const versions = {
  modelVersion: FIRST_PARTY_ROS_MODEL_VERSION,
  policyVersion: FIRST_PARTY_ROS_POLICY_VERSION,
  calibrationVersion: FIRST_PARTY_ROS_INTERVAL_CALIBRATION_VERSION,
};
type ValidationRow = typeof firstPartyRosProfileValidations.$inferSelect;

function dockerAvailable() {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!dockerAvailable())("Replay-only ROS profile recovery against PostgreSQL", () => {
  const containerName = `laces-ros-recovery-pg-${randomUUID().slice(0, 8)}`;
  let handle: ReturnType<typeof createDatabase>;
  let repository: DrizzleRosProfileValidationRepository;

  beforeAll(async () => {
    const password = randomBytes(16).toString("hex");
    execFileSync(
      "docker",
      [
        "run",
        "-d",
        "--rm",
        "--name",
        containerName,
        "--cpus=1",
        "--tmpfs",
        "/var/lib/postgresql/data",
        "-e",
        "POSTGRES_USER=recovery_test",
        "-e",
        `POSTGRES_PASSWORD=${password}`,
        "-e",
        "POSTGRES_DB=recovery_test",
        "-p",
        "127.0.0.1::5432",
        "postgres:17-alpine",
      ],
      { stdio: "ignore" },
    );
    const port = Number(
      execFileSync("docker", ["port", containerName, "5432/tcp"], { encoding: "utf8" })
        .trim()
        .split(":")
        .pop(),
    );
    if (!Number.isInteger(port) || port <= 0)
      throw new Error("Disposable recovery database port missing");
    handle = createDatabase(
      `postgres://recovery_test:${password}@127.0.0.1:${port}/recovery_test`,
      4,
    );
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        execFileSync(
          "docker",
          ["exec", containerName, "pg_isready", "-h", "127.0.0.1", "-U", "recovery_test"],
          { stdio: "ignore" },
        );
        break;
      } catch {
        if (Date.now() > deadline) throw new Error("Disposable recovery database did not start");
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    await migrate(handle.db, {
      migrationsFolder: fileURLToPath(new URL("../../../packages/db/migrations", import.meta.url)),
    });
    repository = new DrizzleRosProfileValidationRepository(handle.db);
  }, 60_000);

  afterAll(async () => {
    try {
      await handle?.close();
    } finally {
      execFileSync("docker", ["rm", "-f", "-v", containerName], { stdio: "ignore" });
    }
  }, 30_000);

  async function seed(
    season: number,
    options: {
      state?: ValidationRow["state"];
      blockers?: readonly string[];
      points?: number;
      modelVersion?: string;
      policyVersion?: string;
      calibrationVersion?: string;
    } = {},
  ): Promise<ValidationRow> {
    const definition = rosProfileDefinitionFromKey(
      projectionScoringProfileKey({
        id: "recovery-fixture",
        rules: [{ statId: "receptions", points: options.points ?? 1 }],
      }),
    );
    const identity = {
      ...versions,
      modelVersion: options.modelVersion ?? versions.modelVersion,
      policyVersion: options.policyVersion ?? versions.policyVersion,
      calibrationVersion: options.calibrationVersion ?? versions.calibrationVersion,
    };
    let artifactId: string | null = null;
    if (options.state === "admitted") {
      // Structural foreign-key fixture only; this suite does not assert statistical admission.
      const [artifact] = await handle.db
        .insert(firstPartyRosChampionArtifacts)
        .values({
          season,
          ...identity,
          scoringProfileKey: definition.scoringProfileKey,
          evidenceThroughSeason: season - 1,
          sourceChecksums: [{ key: "recovery-fixture", checksum: CORPUS_A }],
          policy: { fixture: "admitted-state-exclusion" },
          releaseGate: {},
          artifactChecksum: CORPUS_B,
          admittedAt: PRIOR,
        })
        .returning({ id: firstPartyRosChampionArtifacts.id });
      artifactId = artifact!.id;
    }
    const blockers = options.blockers ?? ["validation_execution_failed"];
    const [row] = await handle.db
      .insert(firstPartyRosProfileValidations)
      .values({
        season,
        ...identity,
        scoringProfileKey: definition.scoringProfileKey,
        scoringProfileDigest: definition.digest,
        state: options.state ?? "failed",
        blockers,
        artifactId,
        requestedAt: PRIOR,
        startedAt: PRIOR,
        completedAt: PRIOR,
        updatedAt: PRIOR,
        report: {
          report: {
            state: "insufficient",
            blockers,
            forecasts: 128,
            mae: 7.125,
            intervalCoverage: 0.67,
          },
          sources: [{ checksum: CORPUS_A, season: season - 1 }],
          publicationPolicy: { choices: [], source: "original-scientific-result" },
        },
      })
      .returning();
    return row!;
  }

  function fixture(initialCorpus: string | null = CORPUS_A) {
    let corpus = initialCorpus;
    let now = NOW;
    const outstanding = new Set<string>();
    const readyCorpusForSeason = vi.fn(async (_season: number, signal: AbortSignal) => {
      signal.throwIfAborted();
      return corpus;
    });
    const validationJobIsOutstanding = vi.fn(async (id: string) => outstanding.has(id));
    const enqueueValidation = vi.fn(
      async (job: RosProfileValidationJob): Promise<string | null> => {
        outstanding.add(job.profileValidationId);
        return randomUUID();
      },
    );
    const createService = () =>
      new RosProfileRecoveryService({
        database: handle.db,
        readyCorpusForSeason,
        validationJobIsOutstanding,
        enqueueValidation,
        now: () => now,
      });
    return {
      service: createService(),
      createService,
      outstanding,
      readyCorpusForSeason,
      validationJobIsOutstanding,
      enqueueValidation,
      now: () => now,
      selectCorpus: (value: string | null) => {
        corpus = value;
      },
      advance: (milliseconds: number) => {
        now = new Date(now.getTime() + milliseconds);
      },
    };
  }

  async function read(id: string): Promise<ValidationRow> {
    const row = await repository.get(id);
    if (!row) throw new Error("Expected recovery fixture row");
    return row;
  }

  function expectOriginalReport(after: ValidationRow, before: ValidationRow) {
    const report = { ...after.report };
    delete report.automaticRecovery;
    expect(report).toEqual(before.report);
    expect(after.scoringProfileKey).toBe(before.scoringProfileKey);
    expect(after.scoringProfileDigest).toBe(before.scoringProfileDigest);
  }

  it.each([
    { season: 2030, state: "failed", blockers: ["validation_execution_failed"] },
    { season: 2048, state: "withheld", blockers: ["historical_component_coverage_incomplete"] },
  ] as const)(
    "does not queue or mutate a $state result when no verified ready corpus exists",
    async ({ season, state, blockers }) => {
      const row = await seed(season, { state, blockers });
      const prepared = fixture(null);
      const signal = new AbortController().signal;
      await prepared.service.recover(season, signal);
      expect(prepared.readyCorpusForSeason).toHaveBeenCalledWith(season, signal);
      expect(prepared.enqueueValidation).not.toHaveBeenCalled();
      expect(await read(row.id)).toEqual(row);
    },
  );

  it("dispatches only replay jobs with the exact corpus for transient failures and source/component withholding", async () => {
    const rows = await Promise.all([
      seed(2031),
      seed(2031, { points: 0.5, blockers: ["validation_job_lost"] }),
      seed(2031, {
        points: 0.75,
        state: "withheld",
        blockers: ["historical_source_coverage_incomplete"],
      }),
      seed(2031, {
        points: 0.85,
        state: "withheld",
        blockers: ["historical_component_coverage_incomplete"],
      }),
    ]);
    const prepared = fixture();
    await prepared.service.recover(2031, new AbortController().signal);
    expect(prepared.enqueueValidation).toHaveBeenCalledTimes(4);
    for (const before of rows) {
      expect(prepared.enqueueValidation).toHaveBeenCalledWith({
        profileValidationId: before.id,
        recoveryCorpusIdentity: CORPUS_A,
        recoveryAttempt: 1,
      });
      const after = await read(before.id);
      expect(after.state).toBe(before.state);
      expect(after.blockers).toEqual(before.blockers);
      expect(after.completedAt).toEqual(before.completedAt);
      expect(after.report?.automaticRecovery).toMatchObject({
        version: "ready-corpus-replay-v1",
        corpusIdentity: CORPUS_A,
        state: "pending-dispatch",
        requestedAt: NOW.toISOString(),
      });
      expectOriginalReport(after, before);
    }
  });

  it("excludes scientific rejection, admitted results, unsupported failures, and stale model identities", async () => {
    const rows = await Promise.all([
      seed(2032, { points: 0.1, state: "withheld", blockers: ["report_global_blockers_present"] }),
      seed(2032, {
        points: 0.2,
        state: "withheld",
        blockers: [
          "historical_source_coverage_incomplete",
          "release_validation_forecasts_below_minimum",
        ],
      }),
      seed(2032, { points: 0.3, state: "admitted", blockers: [] }),
      seed(2032, { points: 0.4, blockers: ["scoring_profile_mismatch"] }),
      seed(2032, { points: 0.5, modelVersion: "obsolete-model" }),
      seed(2032, { points: 0.6, policyVersion: "obsolete-policy" }),
      seed(2032, { points: 0.7, calibrationVersion: "obsolete-calibration" }),
      seed(2032, { points: 0.8, state: "pending", blockers: [] }),
      seed(2032, { points: 0.9, state: "validating", blockers: [] }),
      seed(2032, {
        points: 0.95,
        state: "withheld",
        blockers: ["historical_component_coverage_incomplete", "report_global_blockers_present"],
      }),
    ]);
    const prepared = fixture();
    await prepared.service.recover(2032, new AbortController().signal);
    expect(prepared.enqueueValidation).not.toHaveBeenCalled();
    for (const row of rows) expect(await read(row.id)).toEqual(row);
  });

  it("serializes concurrent sweeps around durable queue dispatch so only one job is sent", async () => {
    const row = await seed(2033);
    const prepared = fixture();
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    prepared.enqueueValidation.mockImplementation(async (job) => {
      entered();
      await held;
      prepared.outstanding.add(job.profileValidationId);
      return randomUUID();
    });
    const first = prepared.service.recover(2033, new AbortController().signal);
    await started;
    const second = prepared.createService().recover(2033, new AbortController().signal);
    try {
      // Let the independent connection contend while the first queue send is still unresolved.
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(prepared.enqueueValidation).toHaveBeenCalledTimes(1);
    } finally {
      release();
    }
    await Promise.all([first, second]);
    expect(prepared.enqueueValidation).toHaveBeenCalledTimes(1);
    expect((await read(row.id)).state).toBe("failed");
  });

  it("commits the pinned recovery marker before a fast queued worker reads and claims it", async () => {
    const row = await seed(2040);
    const prepared = fixture();
    prepared.enqueueValidation.mockImplementation(async (job) => {
      // A separate database read inside enqueue simulates a worker starting before send returns.
      const committed = await repository.get(job.profileValidationId);
      expect(committed?.state).toBe("failed");
      expect(committed?.report?.automaticRecovery).toMatchObject({
        corpusIdentity: CORPUS_A,
        state: "pending-dispatch",
      });
      if (typeof job.recoveryCorpusIdentity !== "string")
        throw new Error("Expected a replay-only recovery job");
      expect(
        await repository.begin(job.profileValidationId, NOW, job.recoveryCorpusIdentity),
      ).toBeInstanceOf(Date);
      prepared.outstanding.add(job.profileValidationId);
      return randomUUID();
    });
    await prepared.service.recover(2040, new AbortController().signal);
    expect(prepared.enqueueValidation).toHaveBeenCalledTimes(1);
    const after = await read(row.id);
    expect(after.state).toBe("validating");
    expect(after.report?.automaticRecovery).toMatchObject({
      corpusIdentity: CORPUS_A,
      state: "attempted",
    });
    expectOriginalReport(after, row);
  });

  it("protects a live dispatch reservation and retries it after an abandoned lease expires", async () => {
    const row = await seed(2041);
    const reservationId = randomUUID();
    await handle.db
      .update(firstPartyRosProfileValidations)
      .set({
        report: {
          ...row.report,
          automaticRecovery: {
            version: "ready-corpus-replay-v1",
            corpusIdentity: CORPUS_A,
            state: "pending-dispatch",
            requestedAt: PRIOR.toISOString(),
            dispatchReservationId: reservationId,
            dispatchClaimedAt: NOW.toISOString(),
          },
        },
      })
      .where(eq(firstPartyRosProfileValidations.id, row.id));
    const prepared = fixture();
    await prepared.service.recover(2041, new AbortController().signal);
    expect(prepared.enqueueValidation).not.toHaveBeenCalled();
    expect((await read(row.id)).report?.automaticRecovery).toMatchObject({
      dispatchReservationId: reservationId,
      dispatchClaimedAt: NOW.toISOString(),
    });
    prepared.advance(31_000);
    await prepared.service.recover(2041, new AbortController().signal);
    expect(prepared.enqueueValidation).toHaveBeenCalledExactlyOnceWith({
      profileValidationId: row.id,
      recoveryCorpusIdentity: CORPUS_A,
      recoveryAttempt: 1,
    });
    const recovered = await read(row.id);
    expect(recovered.report?.automaticRecovery).toMatchObject({
      corpusIdentity: CORPUS_A,
      state: "pending-dispatch",
      requestedAt: PRIOR.toISOString(),
      dispatchClaimedAt: new Date(NOW.getTime() + 31_000).toISOString(),
    });
    expect(recovered.report?.automaticRecovery).not.toMatchObject({
      dispatchReservationId: reservationId,
    });
    expectOriginalReport(recovered, row);
  });

  it.each(["error", "null"] as const)(
    "preserves a pending marker after a queue %s and retries dispatch",
    async (failure) => {
      const season = failure === "error" ? 2034 : 2035;
      const row = await seed(season);
      const prepared = fixture();
      if (failure === "error")
        prepared.enqueueValidation.mockRejectedValueOnce(new Error("queue unavailable"));
      else prepared.enqueueValidation.mockResolvedValueOnce(null);
      const first = prepared.service.recover(season, new AbortController().signal);
      if (failure === "error") await expect(first).rejects.toThrow("queue unavailable");
      else await first;
      const pending = await read(row.id);
      expect(pending.state).toBe("failed");
      expect(pending.report?.automaticRecovery).toMatchObject({
        corpusIdentity: CORPUS_A,
        state: "pending-dispatch",
      });
      expectOriginalReport(pending, row);
      await prepared.service.recover(season, new AbortController().signal);
      expect(prepared.enqueueValidation).toHaveBeenCalledTimes(2);
      expect(prepared.outstanding.has(row.id)).toBe(true);
      expectOriginalReport(await read(row.id), row);
    },
  );

  it("does not immediately loop a failed replay and permits a different ready corpus", async () => {
    const row = await seed(2036, {
      state: "withheld",
      blockers: ["historical_source_coverage_incomplete"],
    });
    const prepared = fixture();
    await prepared.service.recover(2036, new AbortController().signal);
    expect(await repository.begin(row.id, NOW)).toBeNull();
    expect(await repository.begin(row.id, NOW, CORPUS_B)).toBeNull();
    expect((await read(row.id)).state).toBe("withheld");
    const claim = await repository.begin(row.id, NOW, CORPUS_A);
    expect(claim).toBeInstanceOf(Date);
    if (!claim) throw new Error("Expected exact-corpus recovery claim");
    const active = await read(row.id);
    expect(active.state).toBe("validating");
    expect(active.report?.automaticRecovery).toMatchObject({
      corpusIdentity: CORPUS_A,
      state: "attempted",
    });
    expectOriginalReport(active, row);
    prepared.outstanding.delete(row.id);
    await repository.fail(row.id, claim, new Date(NOW.getTime() + 60_000));
    await prepared.service.recover(2036, new AbortController().signal);
    expect(prepared.enqueueValidation).toHaveBeenCalledTimes(1);
    expect((await read(row.id)).report?.automaticRecovery).toMatchObject({
      corpusIdentity: CORPUS_A,
      state: "attempted",
    });
    prepared.selectCorpus(CORPUS_B);
    await prepared.service.recover(2036, new AbortController().signal);
    expect(prepared.enqueueValidation).toHaveBeenCalledTimes(2);
    expect(prepared.enqueueValidation).toHaveBeenLastCalledWith({
      profileValidationId: row.id,
      recoveryCorpusIdentity: CORPUS_B,
      recoveryAttempt: 1,
    });
    expect((await read(row.id)).report?.automaticRecovery).toMatchObject({
      corpusIdentity: CORPUS_B,
      state: "pending-dispatch",
    });
    expectOriginalReport(await read(row.id), row);
  });

  it("recovers an exhausted operational failure on the same corpus after cooldown and preserves committed admission after dispatch failure", async () => {
    const row = await seed(2026);
    const prepared = fixture();
    const context = { jobId: "recovery-pg", signal: new AbortController().signal };
    const runner = vi.fn<RosProfileValidationRunner>(async () => ({
      ...validReport({ evidenceIdentityOverrides: { scoringProfileKey: row.scoringProfileKey } }),
      outcomeCorpusIdentity: CORPUS_A,
    }));
    runner.mockRejectedValueOnce(new Error("temporary storage outage"));
    const enqueueProjectionRefresh = vi.fn(async () => {});
    const validator = new RosProfileValidationService({
      repository,
      runner,
      enqueueProjectionRefresh,
      now: prepared.now,
    });
    await prepared.service.recover(row.season, context.signal);
    const firstJob = prepared.enqueueValidation.mock.calls[0]![0];
    await expect(validator.validateProfile(firstJob, context)).rejects.toThrow("storage outage");
    expect((await read(row.id)).state).toBe("failed");
    prepared.outstanding.delete(row.id); // The original queue job has exhausted its retries.
    prepared.advance(ROS_PROFILE_RECOVERY_MINIMUM_DELAY_MS - 1);
    await prepared.service.recover(row.season, context.signal);
    expect(prepared.enqueueValidation).toHaveBeenCalledTimes(1);
    prepared.advance(1);
    await Promise.all([
      prepared.service.recover(row.season, context.signal),
      prepared.createService().recover(row.season, context.signal),
    ]);
    expect(prepared.enqueueValidation).toHaveBeenCalledTimes(2);
    const secondJob = prepared.enqueueValidation.mock.calls[1]![0];
    expect(secondJob).toEqual({
      profileValidationId: row.id,
      recoveryCorpusIdentity: CORPUS_A,
      recoveryAttempt: 2,
    });
    expect(await repository.begin(row.id, prepared.now(), CORPUS_A)).toBeNull();
    expect(await repository.begin(row.id, prepared.now(), CORPUS_A, 1)).toBeNull();
    await validator.validateProfile(firstJob, context);
    expect(runner).toHaveBeenCalledTimes(1);

    enqueueProjectionRefresh.mockRejectedValueOnce(new Error("publication queue unavailable"));
    await expect(validator.validateProfile(secondJob, context)).rejects.toThrow(
      "publication queue unavailable",
    );
    const admitted = await read(row.id);
    expect(admitted.state).toBe("admitted");
    expect(admitted.artifactId).not.toBeNull();
    expect(admitted.report?.automaticRecovery).toMatchObject({
      corpusIdentity: CORPUS_A,
      recoveryAttempt: 2,
      state: "attempted",
    });
    await validator.validateProfile(firstJob, context);
    expect(enqueueProjectionRefresh).toHaveBeenCalledTimes(1);
    await validator.validateProfile(secondJob, context);
    expect(enqueueProjectionRefresh).toHaveBeenCalledTimes(2);
    expect(runner).toHaveBeenCalledTimes(2);
    for (const [input] of runner.mock.calls)
      expect(input).toMatchObject({ requiredReadyCorpusIdentity: CORPUS_A });
  });

  it.each([
    [0, 1],
    [-1, 2],
    [1.5, 3],
    [null, 4],
    ["1", 5],
    [Number.MAX_SAFE_INTEGER + 1, 6],
  ] as const)(
    "does not rewrite or claim a malformed recovery attempt %s",
    async (recoveryAttempt, points) => {
      const row = await seed(2050, { points });
      await handle.db
        .update(firstPartyRosProfileValidations)
        .set({
          report: {
            ...row.report,
            automaticRecovery: {
              version: "ready-corpus-replay-v1",
              corpusIdentity: CORPUS_A,
              state: "attempted",
              requestedAt: PRIOR.toISOString(),
              recoveryAttempt,
            },
          },
        })
        .where(eq(firstPartyRosProfileValidations.id, row.id));
      const before = await read(row.id);
      const prepared = fixture();
      prepared.advance(ROS_PROFILE_RECOVERY_MAXIMUM_DELAY_MS);
      await prepared.service.recover(row.season, new AbortController().signal);
      expect(prepared.enqueueValidation).not.toHaveBeenCalled();
      expect(await repository.begin(row.id, prepared.now(), CORPUS_A)).toBeNull();
      expect(await read(row.id)).toEqual(before);
    },
  );

  it.each([
    [null, 1, 1],
    [new Date(NOW.getTime() + 24 * 60 * 60_000), 1, 2],
    [PRIOR, Number.MAX_SAFE_INTEGER, 3],
  ] as const)(
    "preserves failed recovery with completion %s and attempt %s when another cycle is unsafe",
    async (completedAt, recoveryAttempt, points) => {
      const row = await seed(2052, { points });
      await handle.db
        .update(firstPartyRosProfileValidations)
        .set({
          completedAt,
          report: {
            ...row.report,
            automaticRecovery: {
              version: "ready-corpus-replay-v1",
              corpusIdentity: CORPUS_A,
              state: "attempted",
              requestedAt: PRIOR.toISOString(),
              recoveryAttempt,
            },
          },
        })
        .where(eq(firstPartyRosProfileValidations.id, row.id));
      const before = await read(row.id);
      const prepared = fixture();
      prepared.advance(ROS_PROFILE_RECOVERY_MAXIMUM_DELAY_MS);
      await prepared.service.recover(row.season, new AbortController().signal);
      expect(prepared.enqueueValidation).not.toHaveBeenCalled();
      expect(await read(row.id)).toEqual(before);
    },
  );

  it("retains the new cycle after a null dispatch and applies capped backoff to operational failures", async () => {
    const row = await seed(2051);
    await handle.db
      .update(firstPartyRosProfileValidations)
      .set({
        completedAt: NOW,
        report: {
          ...row.report,
          automaticRecovery: {
            version: "ready-corpus-replay-v1",
            corpusIdentity: CORPUS_A,
            state: "attempted",
            requestedAt: PRIOR.toISOString(),
            recoveryAttempt: 20,
          },
        },
      })
      .where(eq(firstPartyRosProfileValidations.id, row.id));
    const prepared = fixture();
    prepared.advance(ROS_PROFILE_RECOVERY_MAXIMUM_DELAY_MS - 1);
    await prepared.service.recover(row.season, new AbortController().signal);
    expect(prepared.enqueueValidation).not.toHaveBeenCalled();
    prepared.advance(1);
    prepared.enqueueValidation.mockResolvedValueOnce(null);
    await prepared.service.recover(row.season, new AbortController().signal);
    expect((await read(row.id)).report?.automaticRecovery).toMatchObject({
      state: "pending-dispatch",
      recoveryAttempt: 21,
    });
    await prepared.service.recover(row.season, new AbortController().signal);
    expect(prepared.enqueueValidation).toHaveBeenCalledTimes(2);
    for (const [job] of prepared.enqueueValidation.mock.calls) expect(job.recoveryAttempt).toBe(21);
  });

  it("does not steal an outstanding validation job or overwrite its scientific result", async () => {
    const row = await seed(2037);
    const prepared = fixture();
    prepared.outstanding.add(row.id);
    await prepared.service.recover(2037, new AbortController().signal);
    expect(prepared.validationJobIsOutstanding).toHaveBeenCalledWith(row.id);
    expect(prepared.enqueueValidation).not.toHaveBeenCalled();
    expect(await read(row.id)).toEqual(row);
  });

  it.each([
    ["scientific rejection", 2038, "report_global_blockers_present", false],
    ["source-coverage withholding", 2039, "historical_source_coverage_incomplete", true],
    ["component-coverage withholding", 2049, "historical_component_coverage_incomplete", true],
  ] as const)(
    "preserves the attempt marker after %s and prevents same-corpus retry loops",
    async (_name, season, blocker, newCorpusCanRecover) => {
      const row = await seed(season);
      const prepared = fixture();
      await prepared.service.recover(season, new AbortController().signal);
      const claim = await repository.begin(row.id, NOW, CORPUS_A);
      if (!claim) throw new Error("Expected recovery claim");
      const scientificReport = {
        report: { state: "rejected", intervalCoverage: 0.42 },
        sources: [{ checksum: CORPUS_A }],
      };
      expect(
        await repository.complete({
          id: row.id,
          startedAt: claim,
          completedAt: new Date(NOW.getTime() + 60_000),
          report: scientificReport,
          blockers: [blocker],
        }),
      ).toBe(true);
      prepared.outstanding.delete(row.id);
      const completed = await read(row.id);
      expect(completed.state).toBe("withheld");
      expect(completed.report).toMatchObject(scientificReport);
      expect(completed.report?.automaticRecovery).toMatchObject({
        corpusIdentity: CORPUS_A,
        state: "attempted",
      });
      await prepared.service.recover(season, new AbortController().signal);
      expect(prepared.enqueueValidation).toHaveBeenCalledTimes(1);
      prepared.advance(2 * ROS_PROFILE_RECOVERY_MAXIMUM_DELAY_MS);
      await prepared.service.recover(season, new AbortController().signal);
      expect(prepared.enqueueValidation).toHaveBeenCalledTimes(1);
      prepared.selectCorpus(CORPUS_B);
      await prepared.service.recover(season, new AbortController().signal);
      expect(prepared.enqueueValidation).toHaveBeenCalledTimes(newCorpusCanRecover ? 2 : 1);
    },
  );
});
