import { loadEnvironment } from "@laces-out/config";
import { createDatabase } from "@laces-out/db";
import { inspectProjectionRetention, pruneProjectionHistory } from "../src/projection-retention.js";

const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--apply")) throw new Error("Usage: projections:prune [--apply]");
const database = createDatabase(loadEnvironment().DATABASE_URL, 1);
try {
  const before = await inspectProjectionRetention(database.db);
  const result = args.includes("--apply") ? await pruneProjectionHistory(database.db) : null;
  process.stdout.write(`${JSON.stringify({ before, result, dryRun: result === null })}\n`);
} finally {
  await database.close();
}
