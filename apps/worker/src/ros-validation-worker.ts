import { loadEnvironment } from "@laces-out/config";
import { createDatabase, firstPartyRosProfileValidations } from "@laces-out/db";
import { and, eq, inArray } from "drizzle-orm";
import {
  FIRST_PARTY_ROS_INTERVAL_CALIBRATION_VERSION,
  FIRST_PARTY_ROS_MODEL_VERSION,
  FIRST_PARTY_ROS_POLICY_VERSION,
} from "@laces-out/projections";
import {
  assertRosProfileValidationJob,
  assertRosCorpusBootstrapJob,
  enqueueRosCorpusBootstrap,
  type RosCorpusBootstrapJob,
  createJobQueue,
  enqueueRosProjectionRefresh,
  enqueueRosProfileValidation,
  queueNames,
  registerQueues,
  type RosProfileValidationJob,
} from "@laces-out/jobs";
import pino from "pino";

import { RosProfileValidationService } from "./ros-profile-validation.js";
import {
  createRosProfileValidationRunner,
  ROS_PROFILE_VALIDATION_JOB_TIMEOUT_MS,
} from "./ros-profile-validation-runner.js";
import { createPostgresRosCorpusLock } from "./ros-corpus-lock.js";
import {
  createSharedRosCorpusValidationRunner,
  rosSharedCorpusRequest,
} from "./ros-shared-corpus-runner.js";
import { RosProfileRecoveryService } from "./ros-profile-recovery.js";
import { RosCorpusBootstrapService, rosBootstrapSeasons } from "./ros-corpus-bootstrap.js";
import {
  RosBootstrapSourceSnapshots,
  ROS_BOOTSTRAP_SOURCE_SNAPSHOT_MAX_BYTES,
} from "./ros-bootstrap-source-snapshots.js";
import { RosExecutionCapacity } from "./ros-execution-capacity.js";
import { currentNflSeason } from "./nfl-season.js";

const environment = loadEnvironment();
const database = createDatabase(environment.DATABASE_URL, 3);
const logger = pino({ level: environment.LOG_LEVEL });
const boss = createJobQueue(
  {
    connectionString: environment.DATABASE_URL,
    application_name: "fantasy-ros-validation-worker",
    schema: "pgboss",
    supervise: true,
    schedule: false,
  },
  logger,
);
const sourceCacheDirectory =
  process.env.ROS_VALIDATION_SOURCE_CACHE ?? "/tmp/laces-ros-source-cache";
const outcomeCacheDirectory =
  process.env.ROS_VALIDATION_OUTCOME_CACHE ?? "/tmp/laces-ros-outcome-cache";
const capacity = new RosExecutionCapacity();
const corpusLock = createPostgresRosCorpusLock(environment.DATABASE_URL);
const bootstrap = new RosCorpusBootstrapService({
  database: database.db,
  directory: outcomeCacheDirectory,
  lock: corpusLock,
  snapshots: new RosBootstrapSourceSnapshots({ sourceRoot: sourceCacheDirectory }),
  capacity,
  runner: (options) =>
    createRosProfileValidationRunner({
      ...options,
      outcomeCacheDirectory,
      sourceCacheMaximumBytes: ROS_BOOTSTRAP_SOURCE_SNAPSHOT_MAX_BYTES,
    }),
  enqueue: (job) => enqueueRosCorpusBootstrap(boss, job),
  jobIsOutstanding: async (requestIdentity) => {
    const jobs = await boss.findJobs(queueNames.bootstrapRosCorpus, { data: { requestIdentity } });
    return jobs.some(
      (job) => job.state === "created" || job.state === "retry" || job.state === "active",
    );
  },
  jobIsTerminal: async (requestIdentity, attempt) => {
    const jobs = await boss.findJobs(queueNames.bootstrapRosCorpus, {
      data: { requestIdentity, attempt },
    });
    return jobs.some(
      (job) => job.state === "completed" || job.state === "cancelled" || job.state === "failed",
    );
  },
});
const replay = createRosProfileValidationRunner({ outcomeCacheDirectory });
const service = new RosProfileValidationService({
  database: database.db,
  sharedCorpus: async (season, signal) => ({
    requestIdentity: rosSharedCorpusRequest(season).identity,
    corpusIdentity: await bootstrap.ensure(season, signal),
  }),
  runner: createSharedRosCorpusValidationRunner({
    directory: outcomeCacheDirectory,
    lock: corpusLock,
    runner: (input) => {
      if (
        !input.requiredReadyCorpusIdentity ||
        input.replayCorpusIdentity !== input.requiredReadyCorpusIdentity
      )
        throw new Error("Profile proofs require an explicit verified shared corpus");
      return capacity.run(1, input.signal, () => replay(input));
    },
  }),
  enqueueProjectionRefresh: async (season) => {
    await enqueueRosProjectionRefresh(boss, { season, horizon: "full", reason: "on-demand" });
  },
});
const shutdown = new AbortController();
const recovery = new RosProfileRecoveryService({
  database: database.db,
  readyCorpusForSeason: (season, signal) => bootstrap.ensure(season, signal),
  enqueueValidation: (job) => enqueueRosProfileValidation(boss, job),
  validationJobIsTerminal: async (id, corpusIdentity, recoveryAttempt) => {
    const jobs = await boss.findJobs(queueNames.validateRosProfile, {
      data: { profileValidationId: id, recoveryCorpusIdentity: corpusIdentity },
    });
    return jobs.some((job) => {
      const data = job.data as Partial<RosProfileValidationJob>;
      return (
        (data.recoveryAttempt ?? 1) === recoveryAttempt &&
        (job.state === "completed" || job.state === "cancelled" || job.state === "failed")
      );
    });
  },
  validationJobIsOutstanding: async (id) => {
    const jobs = await boss.findJobs(queueNames.validateRosProfile, {
      data: { profileValidationId: id },
    });
    return jobs.some(
      (job) => job.state === "created" || job.state === "retry" || job.state === "active",
    );
  },
});
let recoveryRun: Promise<void> | undefined;
let recoveryTimer: ReturnType<typeof setInterval> | undefined;
function recoverReadyProfiles(): void {
  if (shutdown.signal.aborted || recoveryRun) return;
  recoveryRun = (async () => {
    const seasons = rosBootstrapSeasons(currentNflSeason());
    const demand = await database.db
      .select({ id: firstPartyRosProfileValidations.id })
      .from(firstPartyRosProfileValidations)
      .where(
        and(
          inArray(firstPartyRosProfileValidations.season, [...seasons]),
          eq(firstPartyRosProfileValidations.modelVersion, FIRST_PARTY_ROS_MODEL_VERSION),
          eq(firstPartyRosProfileValidations.policyVersion, FIRST_PARTY_ROS_POLICY_VERSION),
          eq(
            firstPartyRosProfileValidations.calibrationVersion,
            FIRST_PARTY_ROS_INTERVAL_CALIBRATION_VERSION,
          ),
        ),
      )
      .limit(1);
    if (demand.length === 0) return;
    for (const season of seasons) {
      await bootstrap.ensure(season, shutdown.signal);
      await recovery.recover(season, shutdown.signal);
    }
  })()
    .catch((error: unknown) => {
      if (!shutdown.signal.aborted)
        logger.warn({ err: error }, "ready-corpus ROS profile recovery failed; sweep will retry");
    })
    .finally(() => {
      recoveryRun = undefined;
    });
}

async function start(): Promise<void> {
  await boss.start();
  await registerQueues(boss);
  await boss.work<RosProfileValidationJob>(
    queueNames.validateRosProfile,
    {
      batchSize: 1,
      localConcurrency: 2,
      groupConcurrency: 2,
      pollingIntervalSeconds: 10,
    },
    async (jobs) => {
      for (const job of jobs) {
        assertRosProfileValidationJob(job.data);
        const signal = AbortSignal.any([
          job.signal,
          shutdown.signal,
          AbortSignal.timeout(ROS_PROFILE_VALIDATION_JOB_TIMEOUT_MS),
        ]);
        signal.throwIfAborted();
        logger.info(
          { jobId: job.id, profileValidationId: job.data.profileValidationId },
          "validating exact ROS scoring profile",
        );
        await service.validateProfile(job.data, { jobId: job.id, signal });
        logger.info({ jobId: job.id }, "ROS scoring profile validation finished");
      }
    },
  );
  await boss.work<RosCorpusBootstrapJob>(
    queueNames.bootstrapRosCorpus,
    {
      batchSize: 1,
      localConcurrency: 1,
      groupConcurrency: 1,
      pollingIntervalSeconds: 10,
    },
    async (jobs) => {
      for (const job of jobs) {
        assertRosCorpusBootstrapJob(job.data);
        const signal = AbortSignal.any([
          job.signal,
          shutdown.signal,
          AbortSignal.timeout(ROS_PROFILE_VALIDATION_JOB_TIMEOUT_MS),
        ]);
        await bootstrap.run(job.data, { jobId: job.id, signal });
        await recovery.recover(job.data.season, signal);
      }
    },
  );
  recoverReadyProfiles();
  recoveryTimer = setInterval(recoverReadyProfiles, 5 * 60_000);
  recoveryTimer.unref();
  logger.info("fantasy ROS validation worker started");
}

let stopping = false;
async function stop(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, "stopping fantasy ROS validation worker");
  shutdown.abort(new Error("ROS validation worker is stopping"));
  if (recoveryTimer) clearInterval(recoveryTimer);
  await recoveryRun;
  await boss.stop({ graceful: true, timeout: 30_000 });
  await database.close();
  process.exitCode = 0;
}
process.once("SIGINT", () => void stop("SIGINT"));
process.once("SIGTERM", () => void stop("SIGTERM"));
try {
  await start();
} catch (error) {
  logger.fatal({ err: error }, "fantasy ROS validation worker failed to start");
  process.exitCode = 1;
}
