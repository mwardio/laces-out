import assert from "node:assert/strict";
import path from "node:path";
import { rosDerivedOperatorDiagnostic } from "../src/ros-derived-operator-diagnostic.js";
import { loadEnvironment } from "@laces-out/config";
import { createPostgresRosCorpusLock } from "../src/ros-corpus-lock.js";
import { prepareRosDerivedProductionPackage } from "../src/ros-derived-package-prepare.js";
import { readPinnedRosDerivedArtifact } from "../src/ros-derived-package-loader.js";
import { parseRosDerivedProductionPackage } from "../src/ros-derived-production-package.js";

/** Explicit operator preparation. No database records, jobs, notifications or qualification edits. */
async function main(): Promise<void> {
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error("Derived package preparation interrupted"));
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  let stage = "arguments";
  try {
    const args = process.argv.slice(2);
    assert(
      args.length === 2 && args[0]?.startsWith("--config=") && args[1]?.startsWith("--sha256="),
      "Usage: prepare-ros-derived-package --config=/absolute/config.json --sha256=<config byte SHA256>",
    );
    const filename = args[0]!.slice("--config=".length),
      checksum = args[1]!.slice("--sha256=".length);
    assert(path.isAbsolute(filename) && path.resolve(filename) === filename);
    stage = "configuration-bytes";
    const bytes = await readPinnedRosDerivedArtifact(
      path.dirname(filename),
      path.basename(filename),
      checksum,
      4 * 1_024 * 1_024,
      controller.signal,
    );
    stage = "configuration-envelope";
    const config = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as Parameters<typeof prepareRosDerivedProductionPackage>[0] & { version: string };
    assert.deepEqual(
      Object.keys(config).sort(),
      ["version", "directory", "packageJson", "packageChecksum", "artifacts", "sourceRoots"].sort(),
    );
    assert.equal(config.version, "ros-derived-package-preparation-v1");
    stage = "package-envelope";
    parseRosDerivedProductionPackage(config.packageJson, config.packageChecksum);
    stage = "environment";
    const environment = loadEnvironment();
    stage = "shared-lock";
    const packageChecksum = await prepareRosDerivedProductionPackage({
      directory: config.directory,
      packageJson: config.packageJson,
      packageChecksum: config.packageChecksum,
      artifacts: config.artifacts,
      sourceRoots: config.sourceRoots,
      signal: controller.signal,
      lock: createPostgresRosCorpusLock(environment.DATABASE_URL),
      onProgress(event) {
        stage = event.stage;
        process.stderr.write(
          `${JSON.stringify({ state: "preparing-derived-package", ...event })}\n`,
        );
      },
    });
    process.stdout.write(
      `${JSON.stringify({ state: "derived-package-ready", packageChecksum, physicalVectorsVerified: 11968, noSimulation: true, canAuthorizeRelease: false })}\n`,
    );
  } catch (error) {
    // Keep database connection strings and artifact paths out of operator logs.
    process.stderr.write(
      `${JSON.stringify({ state: controller.signal.aborted ? "interrupted" : "failed", ...rosDerivedOperatorDiagnostic(error, stage) })}\n`,
    );
    process.exitCode = controller.signal.aborted ? 130 : 1;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}
await main();
