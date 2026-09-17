import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { rosProfileDefinitionFromKey } from "@laces-out/projections";

import {
  FIRST_PARTY_ROS_RELEASE_MAXIMUM_FORECASTS,
  FIRST_PARTY_ROS_RELEASE_PLAYERS_PER_POSITION,
} from "./first-party-ros-validation-contract.js";

export interface RosProfileValidationRunInput {
  readonly scoringProfileKey: string;
  readonly season: number;
  readonly signal: AbortSignal;
}
export type RosProfileValidationRunner = (
  input: RosProfileValidationRunInput,
) => Promise<Record<string, unknown>>;

export const ROS_PROFILE_VALIDATION_TIMEOUT_MS = 22 * 60 * 60 * 1_000;
export const ROS_PROFILE_VALIDATION_MAXIMUM_REPORT_BYTES = 8 * 1_024 * 1_024;

/** No inherited NODE_OPTIONS, database URLs, provider tokens, or application secrets. */
export function rosProfileValidationChildEnvironment(): NodeJS.ProcessEnv {
  return { NODE_ENV: "production", TZ: "UTC", NODE_OPTIONS: "--max-old-space-size=2048" };
}

export function createRosProfileValidationRunner(
  options: {
    readonly validatorPath?: string;
    readonly sourceCacheDirectory?: string;
    readonly offline?: boolean;
    readonly timeoutMs?: number;
    readonly maximumReportBytes?: number;
  } = {},
): RosProfileValidationRunner {
  const timeoutMs = options.timeoutMs ?? ROS_PROFILE_VALIDATION_TIMEOUT_MS;
  const maximumReportBytes =
    options.maximumReportBytes ?? ROS_PROFILE_VALIDATION_MAXIMUM_REPORT_BYTES;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > ROS_PROFILE_VALIDATION_TIMEOUT_MS
  ) {
    throw new RangeError("Invalid ROS profile validation timeout");
  }
  if (
    !Number.isSafeInteger(maximumReportBytes) ||
    maximumReportBytes <= 0 ||
    maximumReportBytes > ROS_PROFILE_VALIDATION_MAXIMUM_REPORT_BYTES
  ) {
    throw new RangeError("Invalid ROS profile report size limit");
  }
  if (options.offline && !options.sourceCacheDirectory)
    throw new Error("Offline validation requires a source cache");
  return async (input) => {
    input.signal.throwIfAborted();
    rosProfileDefinitionFromKey(input.scoringProfileKey);
    if (!Number.isSafeInteger(input.season) || input.season < 2007 || input.season > 2200) {
      throw new RangeError("Invalid ROS validation target season");
    }
    const directory = await mkdtemp(path.join(tmpdir(), "laces-ros-profile-"));
    try {
      const keyPath = path.join(directory, "scoring-profile-key.json");
      await writeFile(keyPath, input.scoringProfileKey, { mode: 0o600 });
      input.signal.throwIfAborted();
      const args = [
        options.validatorPath ??
          fileURLToPath(new URL("./ros-profile-validator-entry.js", import.meta.url)),
        `--scoring-profile-key-file=${keyPath}`,
        `--seasons=${Array.from({ length: 7 }, (_, index) => input.season - 7 + index).join(",")}`,
        `--holdouts=${Array.from({ length: 4 }, (_, index) => input.season - 4 + index).join(",")}`,
        `--players-per-position=${FIRST_PARTY_ROS_RELEASE_PLAYERS_PER_POSITION}`,
        `--max-forecasts=${FIRST_PARTY_ROS_RELEASE_MAXIMUM_FORECASTS}`,
        "--full",
        ...(options.sourceCacheDirectory ? [`--source-cache=${options.sourceCacheDirectory}`] : []),
        ...(options.offline ? ["--offline"] : []),
      ];
      return await new Promise<Record<string, unknown>>((resolve, reject) => {
        const child = spawn(process.execPath, args, {
          cwd: directory,
          env: rosProfileValidationChildEnvironment(),
          stdio: ["ignore", "pipe", "pipe"],
        });
        const chunks: Buffer[] = [];
        let outputBytes = 0;
        let stderrBytes = 0;
        let failure: Error | undefined;
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        const stop = (error: Error) => {
          failure ??= error;
          child.kill("SIGTERM");
          killTimer ??= setTimeout(() => child.kill("SIGKILL"), 5_000);
          killTimer.unref();
        };
        const abort = () => stop(new Error("ROS profile validation aborted"));
        const timer = setTimeout(
          () => stop(new Error("ROS profile validation timed out")),
          timeoutMs,
        );
        timer.unref();
        input.signal.addEventListener("abort", abort, { once: true });
        if (input.signal.aborted) abort();
        child.stdout.on("data", (chunk: Buffer) => {
          outputBytes += chunk.length;
          if (outputBytes > maximumReportBytes) {
            stop(new Error("ROS profile validation report exceeded its size limit"));
          } else chunks.push(chunk);
        });
        // Drain logs without persisting public signed URLs or unbounded subprocess output. The
        // runner's caller records structured lifecycle/errors, not arbitrary child stderr.
        child.stderr.on("data", (chunk: Buffer) => {
          stderrBytes += chunk.length;
          if (stderrBytes > 64 * 1_024)
            stop(new Error("ROS profile validation logs exceeded their size limit"));
        });
        child.on("error", () => {
          failure ??= new Error("ROS profile validator process could not start");
        });
        child.on("close", (code, signal) => {
          clearTimeout(timer);
          if (killTimer) clearTimeout(killTimer);
          input.signal.removeEventListener("abort", abort);
          if (failure) {
            reject(failure);
            return;
          }
          if (signal || (code !== 0 && code !== 1)) {
            reject(
              new Error(
                `ROS profile validator process failed (exit ${String(code)}, signal ${signal ?? "none"})`,
              ),
            );
            return;
          }
          try {
            const report: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (report === null || typeof report !== "object" || Array.isArray(report))
              throw new Error("Invalid report");
            resolve(report as Record<string, unknown>);
          } catch {
            reject(new Error("ROS profile validator returned an invalid JSON report"));
          }
        });
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
}
