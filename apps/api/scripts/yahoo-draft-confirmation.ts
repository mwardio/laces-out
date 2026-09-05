import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

import {
  verifyYahooDraftConfirmation,
  YahooDraftConfirmationError,
} from "../src/yahoo-draft-confirmation.js";

const MAX_INPUT_BYTES = 5 * 1024 * 1024;
const MAX_SOURCE_CAPTURE_BYTES = 25 * 1024 * 1024;

function argument(name: string): string {
  const prefix = `--${name}=`;
  const matches = process.argv.slice(2).filter((value) => value.startsWith(prefix));
  if (matches.length !== 1) throw new Error("ARGUMENT_INVALID");
  const value = matches[0]!.slice(prefix.length);
  if (value.length === 0) throw new Error("ARGUMENT_INVALID");
  return resolve(value);
}

function readBounded(path: string): string {
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > MAX_INPUT_BYTES) throw new Error("INPUT_READ_FAILED");
  return readFileSync(path, "utf8");
}

function readBoundedSource(path: string): Uint8Array {
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > MAX_SOURCE_CAPTURE_BYTES) {
    throw new Error("INPUT_READ_FAILED");
  }
  return readFileSync(path);
}

function git(repositoryRoot: string | undefined, ...args: readonly string[]): string {
  const result = spawnSync("git", args, {
    ...(repositoryRoot === undefined ? {} : { cwd: repositoryRoot }),
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) throw new Error("GIT_CHECK_FAILED");
  return result.stdout.trim();
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeFailure(error: unknown): { readonly code: string; readonly message: string } {
  if (error instanceof YahooDraftConfirmationError) {
    return { code: error.code, message: error.message };
  }
  const knownCode =
    error instanceof Error &&
    ["ARGUMENT_INVALID", "INPUT_READ_FAILED", "GIT_CHECK_FAILED", "WORKTREE_NOT_CLEAN"].includes(
      error.message,
    )
      ? error.message
      : "CONFIRMATION_FAILED";
  const messages: Readonly<Record<string, string>> = {
    ARGUMENT_INVALID:
      "Supply exactly one --source, --manifest, --context, and --artifact path and no other arguments.",
    INPUT_READ_FAILED: "A confirmation input was unavailable, not a regular file, or too large.",
    GIT_CHECK_FAILED: "The confirmation runner could not identify the Git checkout.",
    WORKTREE_NOT_CLEAN: "The confirmation runner requires a clean frozen Git checkout.",
    CONFIRMATION_FAILED: "The confirmation runner failed closed.",
  };
  return { code: knownCode, message: messages[knownCode]! };
}

function main(): void {
  const argumentsProvided = process.argv.slice(2);
  if (
    argumentsProvided.length !== 4 ||
    argumentsProvided.some(
      (value) =>
        !value.startsWith("--source=") &&
        !value.startsWith("--manifest=") &&
        !value.startsWith("--context=") &&
        !value.startsWith("--artifact="),
    )
  ) {
    throw new Error("ARGUMENT_INVALID");
  }
  const sourcePath = argument("source");
  const manifestPath = argument("manifest");
  const contextPath = argument("context");
  const artifactPath = argument("artifact");
  const repositoryRoot = git(undefined, "rev-parse", "--show-toplevel");
  if (git(repositoryRoot, "status", "--porcelain").length > 0) {
    throw new Error("WORKTREE_NOT_CLEAN");
  }
  const actualImplementationGitRevision = git(repositoryRoot, "rev-parse", "HEAD");
  const preregistration = readBounded(
    resolve(repositoryRoot, "docs/yahoo-draft-polling-preregistration-v1.json"),
  );
  const result = verifyYahooDraftConfirmation({
    sourceCapture: readBoundedSource(sourcePath),
    manifestJson: readBounded(manifestPath),
    contextJson: readBounded(contextPath),
    artifactXml: readBounded(artifactPath),
    actualImplementationGitRevision,
    actualPreregistrationSha256: sha256(preregistration),
    evaluatedAt: new Date(),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  const failure = safeFailure(error);
  process.stderr.write(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        evidenceClass: "yahoo-draft-confirmation-checks",
        status: "failed-closed",
        releaseAdmission: false,
        releaseStateChanged: false,
        ...failure,
      },
      null,
      2,
    )}\n`,
  );
  process.exitCode = 1;
}
