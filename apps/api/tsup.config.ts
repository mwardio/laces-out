import { defineConfig } from "tsup";

export default defineConfig({
  // Explicit output names keep operational entrypoints at dist/*.js even though the audit CLI
  // lives outside src/. An array spanning both directories makes tsup preserve src/ and scripts/
  // in the output tree, which breaks the fixed container commands.
  entry: {
    server: "src/server.ts",
    migrate: "src/migrate.ts",
    "create-owner": "src/create-owner.ts",
    "reset-password": "src/reset-password.ts",
    "mint-draft-read": "src/mint-draft-read.ts",
    "yahoo-draft-audit": "scripts/yahoo-draft-audit.ts",
  },
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
