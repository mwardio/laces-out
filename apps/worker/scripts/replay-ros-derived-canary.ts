import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";
import { rosProfileDefinitionFromKey } from "@laces-out/projections";
import { assertRosCacheHeadroom } from "../src/ros-cache-disk-space.js";
import { createRosDerivedProfileProvider } from "../src/ros-derived-profile-provider.js";
import {
  readPinnedRosDerivedArtifact,
  type RosDerivedSourceRoots,
} from "../src/ros-derived-package-loader.js";
import { parseRosDerivedProductionPackage } from "../src/ros-derived-production-package.js";
import { rosDerivedOperatorDiagnostic } from "../src/ros-derived-operator-diagnostic.js";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
/** One exact-profile proof replay. No database client, queues, network fetch, simulator or adoption. */
async function main(): Promise<void> {
  const controller = new AbortController(),
    interrupt = () => controller.abort(new Error("Canary interrupted"));
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  let stage = "arguments";
  const started = performance.now(),
    cpu = process.cpuUsage();
  try {
    const args = process.argv.slice(2);
    const names = ["--config=", "--sha256=", "--profile=", "--profile-sha256=", "--output="];
    assert(
      args.length === names.length && names.every((name, index) => args[index]?.startsWith(name)),
    );
    const values = names.map((name, index) => args[index]!.slice(name.length));
    const [configPath, configSha, profilePath, profileSha, output] = values as [
      string,
      string,
      string,
      string,
      string,
    ];
    for (const filename of [configPath, profilePath, output])
      assert(path.isAbsolute(filename) && path.resolve(filename) === filename);
    stage = "configuration-bytes";
    const configBytes = await readPinnedRosDerivedArtifact(
      path.dirname(configPath),
      path.basename(configPath),
      configSha,
      4 * 1024 * 1024,
      controller.signal,
    );
    const config = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(configBytes)) as {
      version: string;
      directory: string;
      packageJson: string;
      packageChecksum: string;
      sourceRoots: RosDerivedSourceRoots;
    };
    assert.equal(config.version, "ros-derived-package-preparation-v1");
    stage = "package-envelope";
    const manifest = parseRosDerivedProductionPackage(config.packageJson, config.packageChecksum);
    stage = "scoring-profile";
    const profileBytes = await readPinnedRosDerivedArtifact(
      path.dirname(profilePath),
      path.basename(profilePath),
      profileSha,
      128 * 1024,
      controller.signal,
    );
    const profile = rosProfileDefinitionFromKey(
      new TextDecoder("utf-8", { fatal: true }).decode(profileBytes).trim(),
    );
    stage = "artifact-output-preflight";
    await mkdir(output, { mode: 0o700 });
    assert.equal(await realpath(output), output);
    await assertRosCacheHeadroom(output, 64 * 1024 * 1024, controller.signal);
    const provider = createRosDerivedProfileProvider({
      directory: config.directory,
      packageChecksums: { [manifest.pointsAllowedDefinition]: config.packageChecksum },
      sourceRoots: config.sourceRoots,
      onProgress(event) {
        process.stderr.write(
          `${JSON.stringify({ state: "derived-canary-replay-progress", ...event })}\n`,
        );
      },
    });
    stage = "proof-graph";
    const { bundle } = await provider.resolveCorpora(
      2026,
      controller.signal,
      profile.scoringProfileKey,
    );
    const readyWallSeconds = (performance.now() - started) / 1000;
    process.stderr.write(
      `${JSON.stringify({ state: "derived-canary-metadata-ready", packageChecksum: config.packageChecksum, profileDigest: profile.digest, readyWallSeconds, rssBytes: process.memoryUsage().rss })}\n`,
    );
    stage = "physical-replay";
    const result = await provider.derivedEvidenceProvider(
      {
        season: 2026,
        scoringProfileKey: profile.scoringProfileKey,
        requiredReadyCorpusIdentity: bundle.candidateCorpusIdentity,
        signal: controller.signal,
      },
      bundle,
    );
    stage = "artifact-output";
    assert.equal(await realpath(output), output);
    const receipts: Record<string, { filename: string; sha256: string; bytes: number }> = {};
    async function artifact(role: string, text: string, checksum: string) {
      controller.signal.throwIfAborted();
      assert.equal(sha(text), checksum);
      const bytes = Buffer.byteLength(text);
      assert(bytes <= 64 * 1024 * 1024);
      await assertRosCacheHeadroom(output, bytes, controller.signal);
      const filename = `${role}-${checksum}.json`,
        handle = await open(path.join(output, filename), "wx", 0o444);
      try {
        await handle.writeFile(text);
        await handle.sync();
      } finally {
        await handle.close();
      }
      receipts[role] = { filename, sha256: checksum, bytes };
    }
    await artifact("candidate", result.candidateReportJson, result.candidateReportChecksum);
    await artifact("previous", result.previousReportJson, result.previousReportChecksum);
    await artifact(
      "training",
      result.intervalTrainingReportJson,
      result.intervalTrainingReportChecksum,
    );
    const lineage = result.derivedEvaluation;
    await artifact(
      "comparison-manifest",
      lineage.comparisonManifestJson,
      lineage.comparisonManifestChecksum,
    );
    await artifact(
      "original-candidate",
      lineage.originalCandidateReportJson,
      lineage.originalCandidateReportChecksum,
    );
    await artifact(
      "original-previous",
      lineage.originalPreviousReportJson,
      lineage.originalPreviousReportChecksum,
    );
    await artifact("production-package", config.packageJson, config.packageChecksum);
    const elapsed = process.cpuUsage(cpu);
    const receipt = {
      state: "derived-profile-canary-completed",
      version: "ros-derived-profile-canary-v1",
      configSha256: configSha,
      profileFileSha256: profileSha,
      profileDigest: profile.digest,
      scoringProfileKey: profile.scoringProfileKey,
      packageChecksum: config.packageChecksum,
      pointsAllowedDefinition: manifest.pointsAllowedDefinition,
      candidateCorpusIdentity: bundle.candidateCorpusIdentity,
      previousCorpusIdentity: bundle.previousCorpusIdentity,
      trainingCorpusIdentity: bundle.intervalTrainingCorpusIdentity,
      qualificationProtocolChecksum: bundle.qualificationProtocolChecksum,
      readyWallSeconds,
      wallSeconds: (performance.now() - started) / 1000,
      cpuSeconds: (elapsed.user + elapsed.system) / 1e6,
      maximumRssBytes: process.resourceUsage().maxRSS * 1024,
      artifacts: receipts,
      noDatabaseWrites: true,
      noSimulation: true,
      canAuthorizeRelease: false,
    };
    controller.signal.throwIfAborted();
    const handle = await open(path.join(output, "completion.json"), "wx", 0o444);
    try {
      await handle.writeFile(JSON.stringify(receipt, null, 2) + "\n");
      await handle.sync();
    } finally {
      await handle.close();
    }
    process.stdout.write(
      `${JSON.stringify({ state: receipt.state, profileDigest: profile.digest, packageChecksum: config.packageChecksum, wallSeconds: receipt.wallSeconds, cpuSeconds: receipt.cpuSeconds, maximumRssBytes: receipt.maximumRssBytes, noSimulation: true, canAuthorizeRelease: false })}\n`,
    );
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
