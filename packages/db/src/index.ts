import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema.js";

export * from "./schema.js";

export function createDatabase(connectionString: string, maximumConnections = 10) {
  const client = postgres(connectionString, {
    max: maximumConnections,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false,
  });
  const db = drizzle(client, { schema });

  return {
    db,
    close: async (): Promise<void> => client.end({ timeout: 5 }),
  };
}

export type Database = ReturnType<typeof createDatabase>["db"];
