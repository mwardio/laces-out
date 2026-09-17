import { loadEnvironment } from "@laces-out/config";
import { createDatabase } from "@laces-out/db";
import {
  assertRosProfileValidationJob,
  enqueueRosProjectionRefresh,
  queueNames,
  registerQueues,
  type RosProfileValidationJob,
} from "@laces-out/jobs";
import { PgBoss } from "pg-boss";
import pino from "pino";

import { RosProfileValidationService } from "./ros-profile-validation.js";

const environment = loadEnvironment();
const database = createDatabase(environment.DATABASE_URL, 3);
const logger = pino({ level: environment.LOG_LEVEL });
const boss = new PgBoss({
  connectionString: environment.DATABASE_URL,
  application_name: "fantasy-ros-validation-worker",
  schema: "pgboss",
  supervise: true,
  schedule: false,
});
const service = new RosProfileValidationService({
  database: database.db,
  sourceCacheDirectory: process.env.ROS_VALIDATION_SOURCE_CACHE ?? "/tmp/laces-ros-source-cache",
  enqueueProjectionRefresh: async (season) => {
    await enqueueRosProjectionRefresh(boss, { season, horizon: "full", reason: "on-demand" });
  },
});
const shutdown = new AbortController();

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
        const signal = AbortSignal.any([job.signal, shutdown.signal]);
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
  logger.info("fantasy ROS validation worker started");
}

let stopping = false;
async function stop(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, "stopping fantasy ROS validation worker");
  shutdown.abort(new Error("ROS validation worker is stopping"));
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
