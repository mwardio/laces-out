import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/server.ts",
    "src/migrate.ts",
    "src/create-owner.ts",
    "src/reset-password.ts",
    "src/mint-draft-read.ts",
    "scripts/yahoo-draft-audit.ts",
  ],
  format: ["esm"],
  platform: "node",
  target: "node22",
  sourcemap: true,
  clean: true,
  outDir: "dist",
  // Nodemailer is CommonJS and relies on runtime requires for Node built-ins. Keep it outside the
  // ESM bundle; the API image installs it as a production dependency.
  external: ["nodemailer"],
  // Workspace package exports point at TypeScript for local development. Bundle only those
  // packages so the production Node entrypoint never attempts to execute .ts files.
  noExternal: [/^@laces-out\//u],
});
