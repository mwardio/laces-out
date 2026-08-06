import { fileURLToPath } from "node:url";

import { loadEnvironment } from "@laces-out/config";
import { createDatabase } from "@laces-out/db";
import { migrate } from "drizzle-orm/postgres-js/migrator";

const environment = loadEnvironment();
const database = createDatabase(environment.DATABASE_URL, 1);
const migrationsFolder = fileURLToPath(new URL("../../../packages/db/migrations", import.meta.url));

try {
  await migrate(database.db, { migrationsFolder });
  process.stdout.write("Database migrations are current.\n");
} finally {
  await database.close();
}
