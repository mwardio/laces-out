import { loadEnvironment } from "@fantasy/config";
import { createDatabase } from "@fantasy/db";

import { NflverseCatalogRefresher } from "../src/nflverse-catalog.js";

const environment = loadEnvironment();
const database = createDatabase(environment.DATABASE_URL, 1);

try {
  const refresher = new NflverseCatalogRefresher({ database: database.db });
  const result = await refresher.refresh(true);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await database.close();
}
