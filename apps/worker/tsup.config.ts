import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/worker.ts", "src/ros-worker.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  sourcemap: true,
  clean: true,
  outDir: "dist",
  // Nodemailer is CommonJS and must be loaded by Node rather than folded into the ESM bundle.
  external: ["nodemailer"],
  noExternal: [/^@fantasy\//u],
});
