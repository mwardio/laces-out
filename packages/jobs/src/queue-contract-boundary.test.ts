import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The API and the worker are separate processes and neither may import the other (ADR 0001), so the
 * pg-boss contract used to be hand-copied into both. The copy drifted: `apps/api/src/server.ts`
 * declared `data-refresh` and `projection-refresh` without the `deadLetter`, `retentionSeconds`, or
 * `deleteAfterSeconds` the worker set, so every API-dispatched job lost the dead-letter behavior
 * `ENHANCEMENT_PLAN.md` §2.4 requires — silently, because no test compared the two files.
 *
 * A shared constant both sides merely happen to use would not have prevented that; nothing stopped
 * a second literal from being written next to it. These tests make the second literal fail the
 * build. Queue reliability settings and dispatch serialization keys may exist in exactly one place,
 * and it is not inside an app.
 */

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

/** pg-boss `Queue` configuration keys. Any of these in an app is a second queue declaration. */
const queueConfigurationKeys = [
  "retryLimit",
  "retryDelay",
  "retryDelayMax",
  "retryBackoff",
  "expireInSeconds",
  "retentionSeconds",
  "deleteAfterSeconds",
  "deadLetter",
  "warningQueueSize",
] as const;

/** pg-boss `SendOptions` serialization keys. Any of these in an app is a second singleton key. */
const dispatchSerializationKeys = ["singletonKey", "singletonSeconds", "singletonMinutes"] as const;

async function collectSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".next")
        continue;
      files.push(...(await collectSourceFiles(path)));
      continue;
    }
    if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) continue;
    // Tests assert against the contract by name on purpose; they are not a second declaration.
    if (entry.name.includes(".test.")) continue;
    files.push(path);
  }
  return files;
}

async function appSources(): Promise<readonly { path: string; source: string }[]> {
  const roots = ["apps/api", "apps/worker"].map((relative) => join(repositoryRoot, relative));
  const files = (await Promise.all(roots.map(collectSourceFiles))).flat();
  return await Promise.all(
    files.map(async (path) => ({
      path: path.slice(repositoryRoot.length),
      source: await readFile(path, "utf8"),
    })),
  );
}

function offenders(
  sources: readonly { path: string; source: string }[],
  pattern: RegExp,
): readonly string[] {
  return sources
    .filter((file) => pattern.test(file.source))
    .map((file) => file.path)
    .toSorted();
}

describe("queue contract boundary", () => {
  it("lets no app declare a pg-boss queue", async () => {
    const sources = await appSources();

    expect(offenders(sources, /\b(?:createQueue|updateQueue)\s*\(/u)).toEqual([]);
  });

  it("lets no app restate a queue reliability setting", async () => {
    const sources = await appSources();
    const pattern = new RegExp(String.raw`\b(?:${queueConfigurationKeys.join("|")})\s*:`, "u");

    expect(offenders(sources, pattern)).toEqual([]);
  });

  it("lets no app restate a dispatch serialization key", async () => {
    const sources = await appSources();
    const pattern = new RegExp(String.raw`\b(?:${dispatchSerializationKeys.join("|")})\s*:`, "u");

    expect(offenders(sources, pattern)).toEqual([]);
  });

  it("still detects a reintroduced hand-copied queue configuration", () => {
    // The regressions above pass vacuously if the patterns never match anything, so pin them
    // against the exact text `apps/api/src/server.ts` carried while the drift was live.
    const drifted = [
      { path: "/apps/api/src/drifted.ts", source: 'await jobs.createQueue("data-refresh", {' },
      { path: "/apps/api/src/drifted.ts", source: "  retryLimit: 5," },
      { path: "/apps/api/src/drifted.ts", source: '        singletonKey: "shared-nfl-data",' },
    ];

    expect(offenders([drifted[0]!], /\b(?:createQueue|updateQueue)\s*\(/u)).toHaveLength(1);
    expect(
      offenders(
        [drifted[1]!],
        new RegExp(String.raw`\b(?:${queueConfigurationKeys.join("|")})\s*:`, "u"),
      ),
    ).toHaveLength(1);
    expect(
      offenders(
        [drifted[2]!],
        new RegExp(String.raw`\b(?:${dispatchSerializationKeys.join("|")})\s*:`, "u"),
      ),
    ).toHaveLength(1);
  });
});
