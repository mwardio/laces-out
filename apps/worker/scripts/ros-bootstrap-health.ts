import path from "node:path";

import { loadEnvironment } from "@laces-out/config";
import { createDatabase } from "@laces-out/db";

import { currentNflSeason } from "../src/nfl-season.js";
import { readRosBootstrapHealth } from "../src/ros-bootstrap-health.js";

// Deliberately read-only: do not import/start the worker or its coordinator here.
let database: ReturnType<typeof createDatabase> | undefined;
try {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && !/^--season=\d{4}$/u.test(args[0]!))) {
    throw new Error("Invalid health probe arguments");
  }
  const season = args.length ? Number(args[0]!.slice("--season=".length)) : currentNflSeason();
  if (season < 2007 || season > 2200) throw new Error("Invalid health probe season");
  const directory = process.env.ROS_VALIDATION_OUTCOME_CACHE ?? "/tmp/laces-ros-outcome-cache";
  if (!path.isAbsolute(directory)) throw new Error("Invalid outcome cache path");
  const environment = loadEnvironment();
  database = createDatabase(environment.DATABASE_URL, 1);
  const result = await readRosBootstrapHealth({
    database: database.db,
    directory,
    season,
    signal: AbortSignal.timeout(30_000),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.attention ? 1 : 0;
} catch {
  // Raw database/filesystem errors may contain credentials or local paths.
  process.stdout.write(
    `${JSON.stringify({ attention: true, reason: "bootstrap-health-unavailable" })}\n`,
  );
  process.exitCode = 2;
} finally {
  await database?.close();
}
