import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/worker.ts",
    "src/ros-worker.ts",
    "src/first-party-ros-simulation-worker.ts",
    "src/first-party-ros-artifact-worker.ts",
  ],
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
