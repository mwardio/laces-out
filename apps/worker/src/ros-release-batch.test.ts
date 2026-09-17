import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { FIRST_PARTY_ROS_MODEL_VERSION } from "@laces-out/projections";
import { rosScoringProfileCatalog } from "@laces-out/projections";

const execute = promisify(execFile);
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function fixture(mode = "withhold-first") {
  const directory = await mkdtemp(path.join(os.tmpdir(), "laces-ros-release-batch-"));
  temporary.push(directory);
  const bin = path.join(directory, "bin");
  await mkdir(bin);
  // Exercise the real shell orchestration and semantic protocol. Only the expensive validator
  // command is replaced, so tests can distinguish modeling from cache-only profile replay.
  await writeFile(
    path.join(bin, "npm"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const option = (name) => args.find((arg) => arg.startsWith(name + "="))?.slice(name.length + 1);
const profile = option("--scoring-profile");
const replay = option("--replay-corpus");
fs.appendFileSync(process.env.BATCH_TEST_CALLS, JSON.stringify({ profile, replay, args }) + "\\n");
if (process.env.BATCH_TEST_MODE === "broken-build" && !replay) {
  process.stdout.write("truncated report");
  process.exit(9);
}
const corpus = process.env.BATCH_TEST_MODE === "wrong-replay" && replay ? "b".repeat(64) : "a".repeat(64);
console.log(JSON.stringify({
  champion: { modelVersion: process.env.BATCH_TEST_MODEL },
  scoringProfile: { digest: JSON.parse(process.env.BATCH_TEST_PROFILES)[profile] },
  outcomeCorpusIdentity: corpus,
  report: { playersPerPosition: 8, maximumForecasts: 6000, forecasts: 3000 },
  sources: [{}]
}));
process.exit(profile === "full-ppr" ? 1 : 0);
`,
    { mode: 0o700 },
  );
  const calls = path.join(directory, "calls.jsonl");
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    XDG_RUNTIME_DIR: directory,
    ROS_VALIDATION_REPORT_DIR: path.join(directory, "reports"),
    ROS_VALIDATION_OUTCOME_CACHE: path.join(directory, "outcomes"),
    ROS_VALIDATION_SOURCE_CACHE: path.join(directory, "sources"),
    ROS_VALIDATION_CORPUS_SHA: "",
    ROS_VALIDATION_SEASON: "2026",
    ROS_VALIDATION_PROFILES: "full-ppr half-ppr",
    ROS_VALIDATION_CONCURRENCY: "2",
    BATCH_TEST_CALLS: calls,
    BATCH_TEST_MODE: mode,
    BATCH_TEST_MODEL: FIRST_PARTY_ROS_MODEL_VERSION,
    BATCH_TEST_PROFILES: JSON.stringify(
      Object.fromEntries(
        rosScoringProfileCatalog().map((profile) => [profile.key, profile.digest]),
      ),
    ),
  };
  return {
    directory,
    run: () => execute("bash", ["scripts/run-ros-release-validation.sh"], { env }),
    calls: async () =>
      (await readFile(calls, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { profile: string; replay?: string; args: string[] }),
  };
}

describe("manual ROS release batch", () => {
  it("builds once despite statistical withholding, replays other profiles, and resumes", async () => {
    const batch = await fixture();
    await batch.run();
    const calls = await batch.calls();
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ profile: "full-ppr" });
    expect(calls[0]!.replay).toBeUndefined();
    expect(calls[0]!.args).toContain("--offline");
    expect(calls[1]).toMatchObject({ profile: "half-ppr", replay: "a".repeat(64) });
    expect(calls[1]!.args).not.toContain("--offline");
    expect(calls.every((call) => call.args.includes("--holdouts=2022,2023,2024,2025"))).toBe(true);
    await batch.run();
    expect(await batch.calls()).toHaveLength(2);
  }, 30_000);

  it("stops after a failed shared build instead of rebuilding per scoring profile", async () => {
    const batch = await fixture("broken-build");
    await expect(batch.run()).rejects.toMatchObject({ code: 1 });
    expect(await batch.calls()).toHaveLength(1);
  }, 30_000);

  it("rejects a replay report from a different immutable corpus", async () => {
    const batch = await fixture("wrong-replay");
    await expect(batch.run()).rejects.toMatchObject({ code: 1 });
    const calls = await batch.calls();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.replay).toBe("a".repeat(64));
  }, 30_000);
});
