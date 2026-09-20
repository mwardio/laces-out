import { loadEnvironment } from "@laces-out/config";
import { createDatabase, firstPartyRosProfileValidations } from "@laces-out/db";
import { and, eq, inArray } from "drizzle-orm";
import { firstPartyRosReleaseIdentity } from "@laces-out/projections";
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
import path from "node:path";
import { RosMarginalDependencyError } from "./ros-marginal-corpus-bundle.js";
import { createRosDerivedProfileProvider } from "./ros-derived-profile-provider.js";

import { RosProfileValidationService } from "./ros-profile-validation.js";
import {
  createRosProfileValidationRunner,
  ROS_PROFILE_VALIDATION_JOB_TIMEOUT_MS,
} from "./ros-profile-validation-runner.js";
import { createPostgresRosCorpusLock } from "./ros-corpus-lock.js";
import {
  createSharedRosCorpusValidationRunner,
  readyRosSharedCorpusIdentity,
} from "./ros-shared-corpus-runner.js";
import { RosProfileRecoveryService } from "./ros-profile-recovery.js";
import { RosCorpusBootstrapService, rosBootstrapSeasons } from "./ros-corpus-bootstrap.js";
import {
  RosBootstrapSourceSnapshots,
  ROS_BOOTSTRAP_SOURCE_SNAPSHOT_MAX_BYTES,
} from "./ros-bootstrap-source-snapshots.js";
import { RosExecutionCapacity } from "./ros-execution-capacity.js";
import { currentNflSeason } from "./nfl-season.js";
import {
  createRosDefinitionAwareMarginalResolver,
  createRosDefinitionAwareMarginalValidationRunner,
  createRosDefinitionAwareReadiness,
  rosCorpusDemandGroups,
} from "./ros-corpus-routing.js";

const environment = loadEnvironment();
const releaseIdentity = firstPartyRosReleaseIdentity(environment.ROS_RELEASE_RAIL);
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
const resolveMarginalSelection = createRosDefinitionAwareMarginalResolver({
  directory: outcomeCacheDirectory,
  bundleChecksums: {
    ...((environment.ROS_MARGINAL_BUNDLE_CHECKSUM_YAHOO ?? environment.ROS_MARGINAL_BUNDLE_CHECKSUM)
      ? {
          "yahoo-2022-v1": (environment.ROS_MARGINAL_BUNDLE_CHECKSUM_YAHOO ??
            environment.ROS_MARGINAL_BUNDLE_CHECKSUM)!,
        }
      : {}),
    ...(environment.ROS_MARGINAL_BUNDLE_CHECKSUM_ESPN
      ? { "espn-2019-v1": environment.ROS_MARGINAL_BUNDLE_CHECKSUM_ESPN }
      : {}),
  },
  derivedProviderFactory: (definition, packageChecksum) =>
    createRosDerivedProfileProvider({
      directory: outcomeCacheDirectory,
      packageChecksums: { [definition]: packageChecksum },
      sourceRoots: {
        "original-v12": path.join(outcomeCacheDirectory, "derived-vectors", "original-v12"),
        "native-dst-v13": path.join(outcomeCacheDirectory, "derived-vectors", "native-dst-v13"),
        "expanded-dst-v13": {
          [definition]: path.join(
            outcomeCacheDirectory,
            "derived-vectors",
            "expanded-dst-v13",
            definition,
          ),
        },
      },
    }),
});
const sharedCorpus = createRosDefinitionAwareReadiness({
  releaseRail: environment.ROS_RELEASE_RAIL,
  ensure: (season, signal, definition) => bootstrap.ensure(season, signal, definition),
  ready: (season, signal, definition) =>
    readyRosSharedCorpusIdentity(outcomeCacheDirectory, season, signal, definition),
  marginal: resolveMarginalSelection,
});
const marginalRunner = createRosDefinitionAwareMarginalValidationRunner({
  resolveSelection: resolveMarginalSelection,
  reportDirectory: path.join(outcomeCacheDirectory, "marginal-reports"),
  runnerOptions: { outcomeCacheDirectory, sourceCacheDirectory, offline: true },
});
const replay = createRosProfileValidationRunner({ outcomeCacheDirectory });
const service = new RosProfileValidationService({
  releaseRail: environment.ROS_RELEASE_RAIL,
  marginalRunner,
  database: database.db,
  sharedCorpus,
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
  releaseRail: environment.ROS_RELEASE_RAIL,
  database: database.db,
  sharedCorpus,
  onReadinessFailure: ({ season, definition, error }) => {
    logger.warn(
      {
        season,
        definition,
        ...(error instanceof RosMarginalDependencyError
          ? error.diagnostic
          : { reason: "definition-group-readiness-failed" }),
      },
      "ROS corpus group needs preparation; other groups continue",
    );
  },
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
      .select({
        season: firstPartyRosProfileValidations.season,
        scoringProfileKey: firstPartyRosProfileValidations.scoringProfileKey,
      })
      .from(firstPartyRosProfileValidations)
      .where(
        and(
          inArray(firstPartyRosProfileValidations.season, [...seasons]),
          inArray(firstPartyRosProfileValidations.state, ["pending", "failed", "withheld"]),
          eq(firstPartyRosProfileValidations.modelVersion, releaseIdentity.modelVersion),
          eq(firstPartyRosProfileValidations.policyVersion, releaseIdentity.policyVersion),
          eq(
            firstPartyRosProfileValidations.calibrationVersion,
            releaseIdentity.calibrationVersion,
          ),
        ),
      );
    if (demand.length === 0) return;
    const requested = rosCorpusDemandGroups(demand);
    if (requested.invalidProfiles > 0)
      logger.warn(
        { invalidProfiles: requested.invalidProfiles },
        "Legacy or invalid PA profiles cannot request a corpus group",
      );
    if (environment.ROS_RELEASE_RAIL === "legacy-v7") {
      for (const group of requested.groups) {
        try {
          await sharedCorpus(group.season, shutdown.signal, group.scoringProfileKey);
        } catch (error) {
          shutdown.signal.throwIfAborted();
          logger.warn(
            { season: group.season, definition: group.pointsAllowedDefinition, err: error },
            "ROS bootstrap group could not prepare; other groups continue",
          );
        }
      }
    }
    for (const season of seasons) await recovery.recover(season, shutdown.signal);
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
        // A paired proof holds one complete slot through replay AND admission. Two retained
        // report sets plus child heaps must not overlap another builder or marginal proof.
        if (environment.ROS_RELEASE_RAIL === "marginal-v8")
          await capacity.run(2, signal, () =>
            service.validateProfile(job.data, { jobId: job.id, signal }),
          );
        else await service.validateProfile(job.data, { jobId: job.id, signal });
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
