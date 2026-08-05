import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/worker.ts", "src/ros-worker.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  sourcemap: true,
  clean: true,
  outDir: "dist",
  noExternal: [/^@fantasy\//u],
});
