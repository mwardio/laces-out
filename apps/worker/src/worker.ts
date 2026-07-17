import { loadEnvironment } from "@fantasy/config";
import { createDatabase } from "@fantasy/db";
import { PgBoss } from "pg-boss";
import pino from "pino";

import { ensureDailyRefresh, registerQueues, registerSchedules, registerWorkers } from "./jobs.js";
import { NflverseCatalogRefresher } from "./nflverse-catalog.js";

const environment = loadEnvironment();
const database = createDatabase(environment.DATABASE_URL, 4);
const catalogRefresher = new NflverseCatalogRefresher({ database: database.db });
const logger = pino({
  level: environment.LOG_LEVEL,
  redact: {
    paths: ["*.authorization", "*.cookie", "*.access_token", "*.refresh_token", "*.espn_s2"],
    censor: "[REDACTED]",
  },
});

const boss = new PgBoss({
  connectionString: environment.DATABASE_URL,
  application_name: "fantasy-worker",
  schema: "pgboss",
  supervise: true,
  schedule: true,
});

boss.on("error", (error) => logger.error({ err: error }, "job queue error"));
boss.on("warning", (warning) => logger.warn({ warning }, "job queue warning"));

async function start(): Promise<void> {
  await boss.start();
  await registerQueues(boss);
  await registerWorkers(boss, logger, {
    refreshPlayerCatalog: (force) => catalogRefresher.refresh(force),
  });
  await registerSchedules(boss);
  await ensureDailyRefresh(boss);
  logger.info("fantasy worker started");
}

let stopping = false;
async function stop(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, "stopping fantasy worker");
  await boss.stop({ graceful: true, timeout: 30_000 });
  await database.close();
  process.exitCode = 0;
}

process.once("SIGINT", () => void stop("SIGINT"));
process.once("SIGTERM", () => void stop("SIGTERM"));

try {
  await start();
} catch (error) {
  logger.fatal({ err: error }, "fantasy worker failed to start");
  process.exitCode = 1;
}
