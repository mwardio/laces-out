import path from "node:path";

import { loadEnvironment } from "@laces-out/config";

import { createPostgresRosCorpusLock } from "../src/ros-corpus-lock.js";
import { RosCacheDiskSpaceError } from "../src/ros-cache-disk-space.js";
import { adoptRosSharedCorpus } from "../src/ros-shared-corpus-runner.js";

function adoptionOptions(args: readonly string[]) {
  const allowed = new Set(["--season", "--corpus", "--outcome-cache"]);
  const options = new Map<string, string>();
  for (const argument of args) {
    const separator = argument.indexOf("=");
    const name = argument.slice(0, separator);
    if (separator < 0 || !allowed.has(name) || options.has(name)) {
      throw new Error(
        "Pass each of --season=YYYY, --corpus=<64 lowercase hexadecimal characters>, and --outcome-cache=/absolute/path exactly once.",
      );
    }
    options.set(name, argument.slice(separator + 1));
  }

  const rawSeason = options.get("--season") ?? "";
  const season = Number(rawSeason);
  if (!/^\d{4}$/u.test(rawSeason) || season < 2007 || season > 2200) {
    throw new Error("--season must be an explicit four-digit season between 2007 and 2200.");
  }
  const corpusIdentity = options.get("--corpus") ?? "";
  if (!/^[a-f0-9]{64}$/u.test(corpusIdentity)) {
    throw new Error("--corpus must be an explicit 64-character lowercase hexadecimal identity.");
  }
  const directory = options.get("--outcome-cache") ?? "";
  if (!path.isAbsolute(directory) || /\p{Cc}/u.test(directory)) {
    throw new Error("--outcome-cache must be an explicit absolute directory path.");
  }
  return { season, corpusIdentity, directory };
}

async function main(): Promise<void> {
  let options: ReturnType<typeof adoptionOptions>;
  try {
    // Reject malformed operator input before loading configuration or connecting to PostgreSQL.
    options = adoptionOptions(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ state: "invalid-arguments", reason: (error as Error).message })}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const cancellation = new AbortController();
  let interrupted: "SIGINT" | "SIGTERM" | undefined;
  const interrupt = (signal: "SIGINT" | "SIGTERM") => {
    interrupted ??= signal;
    cancellation.abort(new Error("ROS corpus adoption interrupted"));
  };
  const onInterrupt = () => interrupt("SIGINT");
  const onTerminate = () => interrupt("SIGTERM");
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  let stage: "configuration" | "adoption" = "configuration";
  try {
    const environment = loadEnvironment();
    stage = "adoption";
    const result = await adoptRosSharedCorpus({
      ...options,
      lock: createPostgresRosCorpusLock(environment.DATABASE_URL),
      signal: cancellation.signal,
    });
    process.stdout.write(
      `${JSON.stringify({ state: result.state, requestIdentity: result.requestIdentity, corpusIdentity: result.corpusIdentity })}\n`,
    );
  } catch (error) {
    // Database and filesystem errors may include credentials or paths. Keep console output bounded.
    process.stderr.write(
      `${JSON.stringify({
        state: interrupted ? "interrupted" : "failed",
        reason: interrupted
          ? "ROS corpus adoption was interrupted."
          : error instanceof RosCacheDiskSpaceError
            ? error.message
            : stage === "configuration"
              ? "Worker environment configuration is invalid."
              : "Corpus adoption failed; verify database access, model scope, and cached corpus/outcome integrity.",
      })}\n`,
    );
    process.exitCode = interrupted === "SIGINT" ? 130 : interrupted === "SIGTERM" ? 143 : 1;
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
  }
}

await main();
