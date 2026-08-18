import { loadEnvironment } from "@laces-out/config";
import { createDatabase } from "@laces-out/db";
import { PgBoss } from "pg-boss";
import pino from "pino";

import { databaseFirstPartyRosCandidateProvider } from "./first-party-ros-candidate-provider.js";
import { FirstPartyRosProjectionShadowService } from "./first-party-ros-projections.js";
import { buildFirstPartyRosTargetsInWorker } from "./first-party-ros-worker-thread.js";
import { registerQueues, registerRosProjectionWorker } from "./jobs.js";

const environment = loadEnvironment();
const database = createDatabase(environment.DATABASE_URL, 4);
const logger = pino({ level: environment.LOG_LEVEL });
const databaseCandidateProvider = databaseFirstPartyRosCandidateProvider({ database: database.db });
const service = new FirstPartyRosProjectionShadowService({
  database: database.db,
  candidateProvider: {
    sourceChecksum: (input) => databaseCandidateProvider.sourceChecksum(input),
    buildTargets: buildFirstPartyRosTargetsInWorker,
  },
});
const boss = new PgBoss({
  connectionString: environment.DATABASE_URL,
  application_name: "fantasy-ros-worker",
  schema: "pgboss",
  supervise: true,
  schedule: false,
});

async function start(): Promise<void> {
  await boss.start();
  await registerQueues(boss);
  await registerRosProjectionWorker(boss, logger, service);
  logger.info("fantasy ROS worker started");
}

let stopping = false;
async function stop(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, "stopping fantasy ROS worker");
  await boss.stop({ graceful: true, timeout: 30_000 });
  await database.close();
  process.exitCode = 0;
}

process.once("SIGINT", () => void stop("SIGINT"));
process.once("SIGTERM", () => void stop("SIGTERM"));

try {
  await start();
} catch (error) {
  logger.fatal({ err: error }, "fantasy ROS worker failed to start");
  process.exitCode = 1;
}
