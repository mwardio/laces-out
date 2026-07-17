import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./migrations",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://fantasy:fantasy@localhost:5432/fantasy",
  },
  strict: true,
  verbose: true,
});
