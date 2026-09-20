import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { assertRosCacheHeadroom } from "./ros-cache-disk-space.js";
import type { RosCorpusLock, RosCorpusLockGuard } from "./ros-corpus-lock.js";
import { ROS_SHARED_CORPUS_BUILD_LOCK } from "./ros-shared-corpus-runner.js";
import {
  loadVerifiedRosDerivedPackage,
  readPinnedRosDerivedArtifact,
  type RosDerivedSourceRoots,
} from "./ros-derived-package-loader.js";
import {
  parseRosDerivedProductionPackage,
  type RosDerivedProductionPackage,
} from "./ros-derived-production-package.js";

const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const MAX_ARTIFACT = 128 * 1_024 * 1_024;

/** A pin builder, not qualification authority; every referenced artifact must already exist. */
export function createRosDerivedProductionPackage(input: RosDerivedProductionPackage) {
  const packageJson = `${JSON.stringify(input)}\n`;
  const packageChecksum = sha(packageJson);
  return {
    packageJson,
    packageChecksum,
    manifest: parseRosDerivedProductionPackage(packageJson, packageChecksum),
  };
}

async function immutableWrite(
  directory: string,
  filename: string,
  bytes: Uint8Array,
  guard: RosCorpusLockGuard,
): Promise<void> {
  await guard.assertHeld();
  guard.signal.throwIfAborted();
  assert.equal(await realpath(directory), directory, "Derived destination is a symlink");
  await assertRosCacheHeadroom(directory, bytes.byteLength, guard.signal);
  const temporary = path.join(directory, `${filename}.${randomUUID()}.partial`);
  try {
    const handle = await open(temporary, "wx", 0o444);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await guard.assertHeld();
    guard.signal.throwIfAborted();
    assert.equal(await realpath(directory), directory);
    try {
      await link(temporary, path.join(directory, filename));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await readPinnedRosDerivedArtifact(
        directory,
        filename,
        sha(bytes),
        bytes.byteLength,
        guard.signal,
      );
    }
    const folder = await open(directory, "r");
    try {
      await folder.sync();
    } finally {
      await folder.close();
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * Explicit preparation only. Copies pinned proof bytes, validates the complete proof graph and
 * authenticates every referenced physical vector before atomically publishing the ready package.
 * Existing physical vector roots are retained read-only; no simulation or vector rewrite occurs.
 */
export async function prepareRosDerivedProductionPackage(options: {
  readonly directory: string;
  readonly packageJson: string;
  readonly packageChecksum: string;
  /** Explicit operator-selected roots/basenames; logical proof paths never become disk paths. */
  readonly artifacts: Readonly<
    Record<string, { readonly directory: string; readonly filename: string }>
  >;
  readonly sourceRoots: RosDerivedSourceRoots;
  readonly lock: RosCorpusLock;
  readonly signal: AbortSignal;
}): Promise<string> {
  const packageJson = options.packageJson;
  const packageChecksum = options.packageChecksum;
  const manifest = parseRosDerivedProductionPackage(packageJson, packageChecksum);
  assert(
    path.isAbsolute(options.directory) && path.resolve(options.directory) === options.directory,
  );
  const directory = options.directory;
  const artifacts = JSON.parse(JSON.stringify(options.artifacts)) as typeof options.artifacts;
  const sourceRoots = JSON.parse(JSON.stringify(options.sourceRoots)) as RosDerivedSourceRoots;
  assert.deepEqual(
    Object.keys(artifacts).sort(),
    Object.keys(manifest.files).sort(),
    "Exact artifact closure required",
  );
  return options.lock(ROS_SHARED_CORPUS_BUILD_LOCK, options.signal, async (guard) => {
    guard.signal.throwIfAborted();
    assert.equal(await realpath(directory), directory, "Derived preparation root is a symlink");
    const target = path.join(directory, "derived-artifacts");
    const ready = path.join(directory, "marginal-bundles");
    await guard.assertHeld();
    await mkdir(target, { recursive: true, mode: 0o700 });
    await mkdir(ready, { recursive: true, mode: 0o700 });
    let total = 0;
    const copied = new Set<string>();
    for (const [logicalPath, file] of Object.entries(manifest.files)) {
      const source = artifacts[logicalPath]!;
      const bytes = await readPinnedRosDerivedArtifact(
        source.directory,
        source.filename,
        file.sha256,
        MAX_ARTIFACT,
        guard.signal,
      );
      total += bytes.length;
      assert(total <= 384 * 1_024 * 1_024, "Derived artifact closure exceeds bounds");
      if (!copied.has(file.filename)) {
        await immutableWrite(target, file.filename, bytes, guard);
        copied.add(file.filename);
      }
    }
    const verified = await loadVerifiedRosDerivedPackage({
      directory,
      unpublishedPackageJson: packageJson,
      packageChecksum,
      pointsAllowedDefinition: manifest.pointsAllowedDefinition,
      sourceRoots,
      signal: guard.signal,
    });
    // The original candidate covers both player references and old native DST. The retained
    // benchmark adds its own old DST; full32 training adds all corrected current DST vectors.
    const populations = [
      {
        corpus: verified.originalCandidate,
        cache: verified.originalCandidateCache,
        dstOnly: false,
      },
      { corpus: verified.original, cache: verified.originalCache, dstOnly: true },
      { corpus: verified.training, cache: verified.trainingCache, dstOnly: false },
    ];
    let read = 0;
    for (const { corpus, cache, dstOnly } of populations)
      for (const row of corpus.forecasts) {
        if (dstOnly && row.forecast.position !== "DST") continue;
        for (const key of [row.contextualKey, row.recencyKey]) {
          guard.signal.throwIfAborted();
          const result = await cache.read(key, {
            expectedScenarioCount: 16_384,
            signal: guard.signal,
          });
          assert.equal(result.state, "hit", "Missing retained derived vector");
          if (++read % 32 === 0) await guard.assertHeld();
        }
      }
    assert.equal(read, 11_968, "Complete unique physical vector closure required");
    await immutableWrite(ready, `${packageChecksum}.json`, Buffer.from(packageJson), guard);
    await guard.assertHeld();
    return packageChecksum;
  });
}
