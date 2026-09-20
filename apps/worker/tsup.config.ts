import { defineConfig } from "tsup";

export default defineConfig({
  // Explicit output names keep service commands and sibling worker URLs stable when a CLI
  // entry outside src/ joins the bundle; inferred roots would otherwise move services to src/.
  entry: {
    worker: "src/worker.ts",
    "ros-worker": "src/ros-worker.ts",
    "ros-validation-worker": "src/ros-validation-worker.ts",
    "ros-profile-validator-entry": "src/ros-profile-validator-entry.ts",
    "ros-outcome-simulation-worker": "src/ros-outcome-simulation-worker.ts",
    "first-party-ros-simulation-worker": "src/first-party-ros-simulation-worker.ts",
    "first-party-ros-artifact-worker": "src/first-party-ros-artifact-worker.ts",
    "first-party-projection-process-entry": "src/first-party-projection-process-entry.ts",
    "adopt-ros-shared-corpus": "scripts/adopt-ros-shared-corpus.ts",
    "prepare-ros-derived-package": "scripts/prepare-ros-derived-package.ts",
    "ros-bootstrap-health": "scripts/ros-bootstrap-health.ts",
  },
  format: ["esm"],
  platform: "node",
  target: "node22",
  sourcemap: true,
  clean: true,
  outDir: "dist",
  // Nodemailer is CommonJS and must be loaded by Node rather than folded into the ESM bundle.
  external: ["nodemailer"],
  // Workspace package exports point at TypeScript for local development. Bundle only those
  // packages so the production image never follows npm workspace symlinks to packages that are
  // intentionally absent from the runtime layer.
  noExternal: [/^@laces-out\//u],
});
