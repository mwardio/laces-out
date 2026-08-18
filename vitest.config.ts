import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const workspacePackages = fileURLToPath(new URL("./packages", import.meta.url));
const isMiniRemoteValidation = process.env.LACES_REMOTE_PLATFORM === "darwin-arm64";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@fantasy\/([^/]+)\/(.+)$/u,
        replacement: `${workspacePackages}/$1/src/$2.ts`,
      },
      {
        find: /^@fantasy\/([^/]+)$/u,
        replacement: `${workspacePackages}/$1/src/index.ts`,
      },
    ],
  },
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    ...(isMiniRemoteValidation ? { maxWorkers: 2 } : {}),
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["packages/*/src/**/*.ts", "apps/api/src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/index.ts"],
    },
  },
});
