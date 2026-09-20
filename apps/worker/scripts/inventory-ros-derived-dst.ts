import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import {
  readPinnedRosDerivedArtifact,
  verifyRosDerivedCorpusScope,
} from "../src/ros-derived-package-loader.js";
import {
  inspectRosDerivedOutcomeSource,
  createRosDerivedOutcomeRecord,
  type RosDerivedOutcomeSource,
} from "../src/ros-derived-outcome-cache.js";
import {
  snapshotRosHistoricalCorpus,
  rosHistoricalCorpusIdentity,
  requireCurrentRosHistoricalActualDefinition,
  requireRosHistoricalPointsAllowedDefinition,
  type RosHistoricalCorpus,
} from "../src/ros-historical-corpus.js";
import { assertRosCacheHeadroom } from "../src/ros-cache-disk-space.js";
import { rosDerivedOperatorDiagnostic } from "../src/ros-derived-operator-diagnostic.js";

/** Read-only physical inventory. Complete codec/seed admission remains explicit package preparation. */
async function main(): Promise<void> {
  const controller = new AbortController(),
    interrupt = () => controller.abort(new Error("Inventory interrupted"));
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  let stage = "arguments";
  try {
    const args = process.argv.slice(2);
    assert(
      args.length === 2 && args[0]?.startsWith("--config=") && args[1]?.startsWith("--sha256="),
    );
    const configPath = args[0]!.slice(9),
      configSha = args[1]!.slice(9);
    assert(path.isAbsolute(configPath) && path.resolve(configPath) === configPath);
    stage = "configuration-bytes";
    const input = await readPinnedRosDerivedArtifact(
      path.dirname(configPath),
      path.basename(configPath),
      configSha,
      64 * 1024,
      controller.signal,
    );
    const config = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input)) as {
      version: string;
      nativeCorpus: {
        directory: string;
        filename: string;
        sha256: string;
        encoding: "json" | "gzip-json";
        identity: string;
      };
      sourceDirectory: string;
      outputDirectory: string;
    };
    assert.deepEqual(
      Object.keys(config).sort(),
      ["version", "nativeCorpus", "sourceDirectory", "outputDirectory"].sort(),
    );
    assert.equal(config.version, "ros-derived-native-inventory-v1");
    assert(config.nativeCorpus.encoding === "json" || config.nativeCorpus.encoding === "gzip-json");
    assert(
      path.isAbsolute(config.outputDirectory) &&
        path.resolve(config.outputDirectory) === config.outputDirectory,
    );
    stage = "native-corpus";
    const archive = await readPinnedRosDerivedArtifact(
      config.nativeCorpus.directory,
      config.nativeCorpus.filename,
      config.nativeCorpus.sha256,
      128 * 1024 * 1024,
      controller.signal,
    );
    const decoded =
      config.nativeCorpus.encoding === "gzip-json"
        ? gunzipSync(archive, { maxOutputLength: 128 * 1024 * 1024 })
        : archive;
    const envelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decoded)) as {
      identity: string;
      corpus: RosHistoricalCorpus;
    };
    const corpus = snapshotRosHistoricalCorpus(envelope.corpus),
      identity = rosHistoricalCorpusIdentity(corpus);
    assert.equal(identity, config.nativeCorpus.identity);
    assert.equal(envelope.identity, identity);
    requireCurrentRosHistoricalActualDefinition(corpus);
    verifyRosDerivedCorpusScope(corpus, true);
    const pointsAllowedDefinition = requireRosHistoricalPointsAllowedDefinition(corpus);
    stage = "artifact-output-preflight";
    await mkdir(config.outputDirectory, { mode: 0o700 });
    assert.equal(await realpath(config.outputDirectory), config.outputDirectory);
    await assertRosCacheHeadroom(config.outputDirectory, 64 * 1024 * 1024, controller.signal);
    const records: RosDerivedOutcomeSource[] = [];
    stage = "physical-inventory";
    for (const row of corpus.forecasts)
      for (const strategy of ["contextual", "availability-aware-recency"] as const) {
        const key = strategy === "contextual" ? row.contextualKey : row.recencyKey;
        const source = await inspectRosDerivedOutcomeSource({
          directory: config.sourceDirectory,
          namespace: "expanded-dst-v13",
          key,
          signal: controller.signal,
        });
        createRosDerivedOutcomeRecord({
          sourceRow: row,
          targetRow: row,
          strategy,
          source,
          sourceCorpusIdentity: identity,
          auditVector: null,
        });
        records.push(source);
        if (records.length % 128 === 0)
          process.stderr.write(
            `${JSON.stringify({ state: "inventorying-native-DST", physicalFiles: records.length, corpusIdentity: identity })}\n`,
          );
      }
    assert.equal(records.length, 4352);
    assert.equal(new Set(records.map((row) => row.filename)).size, 4352);
    const text = JSON.stringify(records) + "\n",
      checksum = createHash("sha256").update(text).digest("hex");
    const receipt = {
      state: "derived-native-inventory-completed",
      version: "ros-derived-native-inventory-v1",
      configSha256: configSha,
      corpusIdentity: identity,
      corpusArchiveSha256: config.nativeCorpus.sha256,
      pointsAllowedDefinition,
      physicalRoot: config.sourceDirectory,
      vectors: records.length,
      references: {
        filename: "native-dst-references.json",
        sha256: checksum,
        bytes: Buffer.byteLength(text),
      },
      noSimulation: true,
      codecAndSeedVerification: "requires-package-preparation",
      canAuthorizeRelease: false,
    };
    stage = "artifact-output";
    for (const [filename, bytes] of [
      [receipt.references.filename, text],
      ["inventory-completion.json", JSON.stringify(receipt, null, 2) + "\n"],
    ]) {
      controller.signal.throwIfAborted();
      assert(filename !== undefined && bytes !== undefined);
      const handle = await open(path.join(config.outputDirectory, filename), "wx", 0o444);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } catch (error) {
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
