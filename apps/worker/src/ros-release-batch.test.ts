import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import {
  FIRST_PARTY_ROS_INTERVAL_CALIBRATION_VERSION,
  FIRST_PARTY_ROS_MODEL_VERSION,
  FIRST_PARTY_ROS_POLICY_VERSION,
  rosScoringProfileCatalog,
} from "@laces-out/projections";

const execute = promisify(execFile);
const temporary: string[] = [];

interface BatchReport {
  champion: { modelVersion: string; policyVersion?: string };
  publicationPolicy: {
    modelVersion: string;
    policyVersion?: string;
    choices: {
      intervalCalibrationArtifacts: {
        contextual: { calibrationVersion?: string };
        recency: { calibrationVersion?: string };
      };
    }[];
  };
}
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
  champion: { modelVersion: process.env.BATCH_TEST_MODEL, policyVersion: process.env.BATCH_TEST_POLICY },
  publicationPolicy: {
    modelVersion: process.env.BATCH_TEST_MODEL,
    policyVersion: process.env.BATCH_TEST_POLICY,
    choices: Array.from({ length: 18 }, () => ({
      intervalCalibrationArtifacts: {
        contextual: { calibrationVersion: process.env.BATCH_TEST_CALIBRATION },
        recency: { calibrationVersion: process.env.BATCH_TEST_CALIBRATION }
      }
    }))
  },
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
    BATCH_TEST_POLICY: FIRST_PARTY_ROS_POLICY_VERSION,
    BATCH_TEST_CALIBRATION: FIRST_PARTY_ROS_INTERVAL_CALIBRATION_VERSION,
    BATCH_TEST_PROFILES: JSON.stringify(
      Object.fromEntries(
        rosScoringProfileCatalog().map((profile) => [profile.key, profile.digest]),
      ),
    ),
  };
  return {
    directory,
    run: () => execute("bash", ["scripts/run-ros-release-validation.sh"], { env }),
    changeReport: async (change: (report: BatchReport) => void) => {
      const file = path.join(directory, "reports", "full-ppr.json");
      const report = JSON.parse(await readFile(file, "utf8")) as BatchReport;
      change(report);
      await writeFile(file, JSON.stringify(report));
    },
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

  it.each([
    "champion policy",
    "publication policy",
    "contextual calibration",
    "recency calibration",
    "missing calibration",
    "missing policy",
    "empty choices",
  ])(
    "replays the same physical corpus after retired %s evidence",
    async (retired) => {
      const batch = await fixture();
      await batch.run();
      await batch.changeReport((report) => {
        const lastChoice = report.publicationPolicy.choices.at(-1)!;
        switch (retired) {
          case "champion policy":
            report.champion.policyVersion = "season-walk-forward-block-wis-cqr-v5";
            break;
          case "publication policy":
            report.publicationPolicy.policyVersion = "season-walk-forward-block-wis-cqr-v5";
            break;
          case "contextual calibration":
            lastChoice.intervalCalibrationArtifacts.contextual.calibrationVersion = "retired";
            break;
          case "recency calibration":
            lastChoice.intervalCalibrationArtifacts.recency.calibrationVersion = "retired";
            break;
          case "missing calibration":
            delete lastChoice.intervalCalibrationArtifacts.recency.calibrationVersion;
            break;
          case "missing policy":
            delete report.publicationPolicy.policyVersion;
            break;
          case "empty choices":
            report.publicationPolicy.choices = [];
            break;
        }
      });
      await batch.run();
      const calls = await batch.calls();
      expect(calls).toHaveLength(3);
      expect(calls[2]).toMatchObject({ profile: "full-ppr", replay: "a".repeat(64) });
      expect(calls.filter((call) => call.replay === undefined)).toHaveLength(1);
    },
    30_000,
  );

  it("does not recover a corpus from a report for a retired physical model", async () => {
    const batch = await fixture();
    await batch.run();
    await batch.changeReport((report) => {
      report.champion.modelVersion = "laces-ros-distribution-v11";
    });
    await batch.run();
    const calls = await batch.calls();
    expect(calls).toHaveLength(3);
    expect(calls[2]).toMatchObject({ profile: "full-ppr" });
    expect(calls[2]!.replay).toBeUndefined();
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
