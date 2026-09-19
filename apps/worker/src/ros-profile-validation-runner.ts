import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
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
  /** Immutable shared football corpus. Replay must never fetch, fit, or simulate. */
  readonly replayCorpusIdentity?: string;
  /** Recovery requires this exact ready corpus and cannot fall back to building. */
  readonly requiredReadyCorpusIdentity?: string;
  /** Closed retained comparator path; never enables physical rebuilding. */
  readonly replayModel?: "current" | "retained-v12";
  /** Broader interval fitting only; the original audit cohort remains eight per position. */
  readonly replayScope?: "audit" | "full-defense-training";
}
export type RosProfileValidationRunner = (
  input: RosProfileValidationRunInput,
) => Promise<Record<string, unknown>>;

export const ROS_PROFILE_VALIDATION_TIMEOUT_MS = 22 * 60 * 60 * 1_000;
/** Includes shared-build waiting and child execution; leaves 30 minutes inside pg-boss's lease. */
export const ROS_PROFILE_VALIDATION_JOB_TIMEOUT_MS = (22 * 60 + 30) * 60 * 1_000;
export const ROS_PROFILE_VALIDATION_MAXIMUM_REPORT_BYTES = 8 * 1_024 * 1_024;
export const ROS_PROFILE_VALIDATION_MAXIMUM_DIAGNOSTIC_BYTES = 64 * 1_024 * 1_024;

export interface PinnedRosProfileValidationReport {
  readonly report: Record<string, unknown>;
  /** Original UTF-8 stdout bytes, including whitespace; never reconstructed with stringify. */
  readonly reportJson: string;
  readonly reportChecksum: string;
}
export type PinnedRosProfileValidationRunner = (
  input: RosProfileValidationRunInput,
) => Promise<PinnedRosProfileValidationReport>;

export interface RosProfileValidationRunnerOptions {
  readonly validatorPath?: string;
  readonly sourceCacheDirectory?: string;
  readonly outcomeCacheDirectory?: string;
  readonly offline?: boolean;
  readonly timeoutMs?: number;
  readonly maximumReportBytes?: number;
  readonly preflightOnly?: boolean;
  readonly sourceCacheMaximumBytes?: number;
  readonly diagnostics?: boolean;
}

/** No inherited NODE_OPTIONS, database URLs, provider tokens, or application secrets. */
export function rosProfileValidationChildEnvironment(): NodeJS.ProcessEnv {
  return { NODE_ENV: "production", TZ: "UTC", NODE_OPTIONS: "--max-old-space-size=2048" };
}

export function createRosProfileValidationRunner(
  options: RosProfileValidationRunnerOptions = {},
): RosProfileValidationRunner {
  const runner = createPinnedRosProfileValidationRunner(options);
  return async (input) => (await runner(input)).report;
}

export function createPinnedRosProfileValidationRunner(
  options: RosProfileValidationRunnerOptions = {},
): PinnedRosProfileValidationRunner {
  const timeoutMs = options.timeoutMs ?? ROS_PROFILE_VALIDATION_TIMEOUT_MS;
  const hardMaximum = options.diagnostics
    ? ROS_PROFILE_VALIDATION_MAXIMUM_DIAGNOSTIC_BYTES
    : ROS_PROFILE_VALIDATION_MAXIMUM_REPORT_BYTES;
  const maximumReportBytes = options.maximumReportBytes ?? hardMaximum;
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
    maximumReportBytes > hardMaximum
  ) {
    throw new RangeError("Invalid ROS profile report size limit");
  }
  if (options.offline && !options.sourceCacheDirectory)
    throw new Error("Offline validation requires a source cache");
  return async (input) => {
    input.signal.throwIfAborted();
    rosProfileDefinitionFromKey(input.scoringProfileKey);
    if (
      (input.replayModel !== undefined &&
        input.replayModel !== "current" &&
        input.replayModel !== "retained-v12") ||
      (input.replayScope !== undefined &&
        input.replayScope !== "audit" &&
        input.replayScope !== "full-defense-training") ||
      ((input.replayModel === "retained-v12" || input.replayScope === "full-defense-training") &&
        (!input.replayCorpusIdentity || options.preflightOnly)) ||
      (input.replayScope === "full-defense-training" && input.replayModel === "retained-v12")
    )
      throw new Error("ROS comparator and training scopes require an explicit supported replay");
    if (
      input.requiredReadyCorpusIdentity !== undefined &&
      input.requiredReadyCorpusIdentity !== input.replayCorpusIdentity
    )
      throw new Error("ROS recovery requires explicit replay of its ready corpus");
    if (
      input.replayCorpusIdentity !== undefined &&
      (!options.outcomeCacheDirectory ||
        typeof input.replayCorpusIdentity !== "string" ||
        !/^[a-f0-9]{64}$/u.test(input.replayCorpusIdentity))
    )
      throw new Error("ROS corpus replay requires an outcome cache and a valid identity");
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
        `--players-per-position=${input.replayScope === "full-defense-training" ? 32 : FIRST_PARTY_ROS_RELEASE_PLAYERS_PER_POSITION}`,
        `--max-forecasts=${FIRST_PARTY_ROS_RELEASE_MAXIMUM_FORECASTS}`,
        "--full",
        ...(options.diagnostics ? ["--diagnostics"] : []),
        ...(input.replayScope === "full-defense-training" ? ["--positions=DST"] : []),
        ...(options.preflightOnly ? ["--preflight-only"] : []),
        ...(options.sourceCacheMaximumBytes === undefined
          ? []
          : [`--source-cache-max-bytes=${options.sourceCacheMaximumBytes}`]),
        ...(options.sourceCacheDirectory ? [`--source-cache=${options.sourceCacheDirectory}`] : []),
        ...(options.outcomeCacheDirectory
          ? [`--outcome-cache=${options.outcomeCacheDirectory}`]
          : []),
        ...(input.replayCorpusIdentity
          ? [
              `--${input.replayModel === "retained-v12" ? "replay-retained-v12-corpus" : "replay-corpus"}=${input.replayCorpusIdentity}`,
            ]
          : []),
        ...(options.offline ? ["--offline"] : []),
      ];
      return await new Promise<PinnedRosProfileValidationReport>((resolve, reject) => {
        const child = spawn(process.execPath, args, {
          cwd: directory,
          env: rosProfileValidationChildEnvironment(),
          stdio: ["ignore", "pipe", "pipe"],
          // Linux/Darwin: the validator owns every simulator descendant in one process group.
          detached: process.platform !== "win32",
        });
        const chunks: Buffer[] = [];
        let outputBytes = 0;
        let stderrBytes = 0;
        let failure: Error | undefined;
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        const terminate = (signal: NodeJS.Signals) => {
          if (process.platform === "win32" || child.pid === undefined) {
            child.kill(signal);
            return;
          }
          try {
            process.kill(-child.pid, signal);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
              failure ??= new Error("ROS validator process group could not be terminated");
            }
          }
        };
        const stop = (error: Error) => {
          failure ??= error;
          terminate("SIGTERM");
          killTimer ??= setTimeout(() => terminate("SIGKILL"), 5_000);
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
          // A hard-killed leader cannot execute finally. Interrupt any synchronous CPU child
          // before its owning promise settles; an IPC disconnect callback alone is insufficient.
          terminate("SIGKILL");
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
            const bytes = Buffer.concat(chunks);
            // Reject malformed UTF-8 instead of hashing replacement characters as original data.
            const reportJson = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
              bytes,
            );
            const report: unknown = JSON.parse(reportJson);
            if (report === null || typeof report !== "object" || Array.isArray(report))
              throw new Error("Invalid report");
            resolve({
              report: report as Record<string, unknown>,
              reportJson,
              reportChecksum: createHash("sha256").update(bytes).digest("hex"),
            });
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
