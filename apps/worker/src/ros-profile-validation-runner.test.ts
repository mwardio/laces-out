import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { rosScoringProfile } from "@laces-out/projections";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createRosProfileValidationRunner } from "./ros-profile-validation-runner.js";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function validator(code: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "ros-validator-test-"));
  directories.push(directory);
  const file = path.join(directory, "validator.mjs");
  await writeFile(file, code);
  return file;
}
const key = rosScoringProfile("full-ppr").scoringProfileKey;
const input = () => ({
  scoringProfileKey: key,
  season: 2026,
  signal: new AbortController().signal,
});

describe("isolated ROS profile validation runner", () => {
  it("uses locked release arguments, removes temporary files, and withholds application secrets", async () => {
    vi.stubEnv("DATABASE_URL", "private-database-url");
    vi.stubEnv("OPENAI_API_KEY", "private-provider-key");
    const validatorPath = await validator(`
      import fs from 'node:fs';
      const keyFile = process.argv.find(a => a.startsWith('--scoring-profile-key-file=')).split('=').slice(1).join('=');
      process.stdout.write(JSON.stringify({args: process.argv.slice(2), keyFile, key: fs.readFileSync(keyFile,'utf8'), secretSeen: Boolean(process.env.DATABASE_URL || process.env.OPENAI_API_KEY)}));
    `);
    const report = await createRosProfileValidationRunner({ validatorPath })(input());
    expect(report.key).toBe(key);
    expect(report.secretSeen).toBe(false);
    expect(report.args).toEqual(
      expect.arrayContaining([
        "--players-per-position=8",
        "--max-forecasts=6000",
        "--full",
        "--seasons=2019,2020,2021,2022,2023,2024,2025",
        "--holdouts=2022,2023,2024,2025",
      ]),
    );
    expect(existsSync(report.keyFile as string)).toBe(false);
  });
  it("returns a statistical rejection report from the validator's ordinary exit 1", async () => {
    const validatorPath = await validator(
      `process.stdout.write(JSON.stringify({state:'blocked-before-modeling'})); process.exitCode=1;`,
    );
    await expect(createRosProfileValidationRunner({ validatorPath })(input())).resolves.toEqual({
      state: "blocked-before-modeling",
    });
  });
  it("stops a timed-out process", async () => {
    const validatorPath = await validator("setInterval(() => {}, 1000);");
    await expect(
      createRosProfileValidationRunner({ validatorPath, timeoutMs: 50 })(input()),
    ).rejects.toThrow(/timed out/);
  });
  it("stops an aborted process", async () => {
    const validatorPath = await validator("setInterval(() => {}, 1000);");
    const controller = new AbortController();
    const promise = createRosProfileValidationRunner({ validatorPath })({
      ...input(),
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);
    await expect(promise).rejects.toThrow(/abort/i);
  });
  it("rejects oversized output before parsing", async () => {
    const validatorPath = await validator("process.stdout.write('x'.repeat(1000));");
    await expect(
      createRosProfileValidationRunner({ validatorPath, maximumReportBytes: 100 })(input()),
    ).rejects.toThrow(/size limit/);
  });
  it("retries infrastructure failures instead of treating them as withheld evidence", async () => {
    const validatorPath = await validator("process.exitCode=7;");
    await expect(createRosProfileValidationRunner({ validatorPath })(input())).rejects.toThrow(
      /process failed/,
    );
  });
});
