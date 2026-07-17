import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/server.ts", "src/migrate.ts", "src/create-owner.ts", "src/reset-password.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  sourcemap: true,
  clean: true,
  outDir: "dist",
  // Workspace package exports point at TypeScript for local development. Bundle only those
  // packages so the production Node entrypoint never attempts to execute .ts files.
  noExternal: [/^@fantasy\//u],
});
