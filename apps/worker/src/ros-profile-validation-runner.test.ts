import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  it("passes an explicit cache-only corpus identity without weakening release arguments", async () => {
    const validatorPath = await validator(
      `process.stdout.write(JSON.stringify({args: process.argv.slice(2)}));`,
    );
    const identity = "a".repeat(64);
    const report = await createRosProfileValidationRunner({
      validatorPath,
      outcomeCacheDirectory: "/pinned/outcomes",
    })({ ...input(), replayCorpusIdentity: identity });
    expect(report.args).toEqual(
      expect.arrayContaining([
        "--outcome-cache=/pinned/outcomes",
        `--replay-corpus=${identity}`,
        "--full",
      ]),
    );
    await expect(
      createRosProfileValidationRunner({ validatorPath })({
        ...input(),
        replayCorpusIdentity: identity,
      }),
    ).rejects.toThrow(/requires an outcome cache/);
  });
  it("refuses recovery without the exact explicit replay argument before starting a validator", async () => {
    const identity = "a".repeat(64);
    const runner = createRosProfileValidationRunner({
      validatorPath: "/must-not-start-a-builder.js",
      outcomeCacheDirectory: "/pinned/outcomes",
    });
    await expect(runner({ ...input(), requiredReadyCorpusIdentity: identity })).rejects.toThrow(
      "requires explicit replay",
    );
    await expect(
      runner({
        ...input(),
        requiredReadyCorpusIdentity: identity,
        replayCorpusIdentity: "b".repeat(64),
      }),
    ).rejects.toThrow("requires explicit replay");
    const validatorPath = await validator(
      `process.stdout.write(JSON.stringify({args: process.argv.slice(2)}));`,
    );
    const report = await createRosProfileValidationRunner({
      validatorPath,
      outcomeCacheDirectory: "/pinned/outcomes",
    })({ ...input(), requiredReadyCorpusIdentity: identity, replayCorpusIdentity: identity });
    expect(report.args).toContain(`--replay-corpus=${identity}`);
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
  it.skipIf(process.platform === "win32")(
    "kills a CPU-bound grandchild when the validator leader exits on abort",
    async () => {
      const controller = new AbortController();
      const validatorPath = await validator(`
      import { spawn } from 'node:child_process';
      import { fileURLToPath } from 'node:url';
      const marker = fileURLToPath(new URL('./grandchild.pid', import.meta.url));
      process.on('SIGTERM', () => process.exit(0));
      spawn(process.execPath, ['-e', \
        "process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(process.argv[1],String(process.pid));while(true){}", marker], {stdio:'ignore'});
      setInterval(() => {}, 1000);
    `);
      const marker = path.join(path.dirname(validatorPath), "grandchild.pid");
      const pending = createRosProfileValidationRunner({ validatorPath })({
        ...input(),
        signal: controller.signal,
      });
      // Handle rejection immediately while waiting for the nested process to establish its handler.
      const rejection = expect(pending).rejects.toThrow(/abort/i);
      let pid: number | undefined;
      try {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (existsSync(marker)) {
            pid = Number(await readFile(marker, "utf8"));
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(pid).toBeGreaterThan(1);
        controller.abort();
        await rejection;
        let running = true;
        for (let attempt = 0; attempt < 100 && running; attempt += 1) {
          try {
            process.kill(pid!, 0);
            if (process.platform === "linux") {
              const stat = await readFile(`/proc/${pid}/stat`, "utf8");
              // A reparented zombie consumes no CPU and cannot resume; init owns its reaping.
              if (stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z ")) running = false;
            }
          } catch (error) {
            if (["ESRCH", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? ""))
              running = false;
            else throw error;
          }
          if (running) await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(running).toBe(false);
      } finally {
        controller.abort();
        if (pid !== undefined) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            /* already terminated */
          }
        }
        await rejection;
      }
    },
    10_000,
  );
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
