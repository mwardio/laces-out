import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, rm } from "node:fs/promises";
import path from "node:path";
import { assertRosCacheHeadroom } from "./ros-cache-disk-space.js";
import type { RosCorpusLock } from "./ros-corpus-lock.js";
import {
  createRosHistoricalCorpusStore,
  createRetainedV12RosHistoricalCorpusReader,
  ROS_HISTORICAL_ACTUAL_DEFINITION_VERSION,
  requireRosHistoricalPointsAllowedDefinition,
  type RosHistoricalCorpus,
} from "./ros-historical-corpus.js";
import {
  hasCurrentRosHistoricalCoverageThresholds,
  hasRosHistoricalCorpusReleaseThresholds,
} from "./ros-historical-corpus-protocol.js";
import {
  restoreCachedRosHistoricalOutcome,
  restoreRetainedV12CachedRosHistoricalOutcome,
} from "./ros-historical-outcome-replay.js";
import { createRosOutcomeCache } from "./ros-outcome-cache.js";
import {
  ROS_MARGINAL_CORPUS_BUNDLE_VERSION,
  type RosMarginalCorpusBundle,
} from "./ros-profile-marginal-evidence.js";
import {
  ROS_SHARED_CORPUS_BUILD_LOCK,
  rosSharedCorpusRequest,
} from "./ros-shared-corpus-runner.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_BYTES = 2 * 1024 * 1024;
const FORMAT = "laces-ros-marginal-ready-bundle-v1";
const POSITIONS = ["QB", "RB", "WR", "TE", "K", "DST"];
import {
  RosMarginalDependencyError,
  type RosMarginalDependency,
  type RosMarginalDependencyReason,
} from "./ros-marginal-dependency.js";
export {
  RosMarginalDependencyError,
  type RosMarginalDependencyDiagnostic,
} from "./ros-marginal-dependency.js";
interface Manifest {
  readonly format: typeof FORMAT;
  readonly bundle: RosMarginalCorpusBundle;
  readonly sourceLineageChecksum: string;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function fail(dependency: RosMarginalDependency, reason: RosMarginalDependencyReason): never {
  throw new RosMarginalDependencyError({ dependency, reason });
}
function validateManifest(value: unknown, season: number): asserts value is Manifest {
  if (
    !object(value) ||
    Object.keys(value).sort().join() !== "bundle,format,sourceLineageChecksum" ||
    value.format !== FORMAT ||
    typeof value.sourceLineageChecksum !== "string" ||
    !SHA256.test(value.sourceLineageChecksum) ||
    !object(value.bundle)
  )
    fail("bundle", "corrupt");
  const bundle = value.bundle;
  const allowed = new Set([
    "version",
    "forecastSeason",
    "candidateCorpusIdentity",
    "previousCorpusIdentity",
    "intervalTrainingCorpusIdentity",
    "qualificationProtocolText",
    "qualificationProtocolChecksum",
  ]);
  if (
    Object.keys(bundle).some((k) => !allowed.has(k)) ||
    bundle.version !== ROS_MARGINAL_CORPUS_BUNDLE_VERSION ||
    typeof bundle.qualificationProtocolText !== "string" ||
    !bundle.qualificationProtocolText.trim() ||
    Buffer.byteLength(bundle.qualificationProtocolText) > 1024 * 1024 ||
    hash(bundle.qualificationProtocolText) !== bundle.qualificationProtocolChecksum
  )
    fail("bundle", "corrupt");
  const identities = [
    bundle.candidateCorpusIdentity,
    bundle.previousCorpusIdentity,
    ...(bundle.intervalTrainingCorpusIdentity === undefined
      ? []
      : [bundle.intervalTrainingCorpusIdentity]),
  ];
  if (
    !identities.every((id) => typeof id === "string" && SHA256.test(id)) ||
    new Set(identities).size !== identities.length
  )
    fail("bundle", "corrupt");
  // This release protocol has fixed historical years. Future seasons require an explicit version.
  if (season !== 2026 || bundle.forecastSeason !== season) fail("bundle", "incompatible");
}
function lineage(corpus: RosHistoricalCorpus): string {
  return hash(
    canonical({ sourceChecksums: corpus.sourceChecksums, sourceAudit: corpus.sourceAudit }),
  );
}
function rowKey(row: RosHistoricalCorpus["forecasts"][number]): string {
  return `${row.forecast.forecastSeason}:${row.forecast.asOfWeek}:${row.forecast.position}:${row.forecast.playerId}`;
}
function target(row: RosHistoricalCorpus["forecasts"][number]): string {
  return canonical({
    actualComponents: row.actualComponents,
    actualGames: row.actualGames,
    scheduledGames: row.scheduledGames,
    start: row.forecast.windowStartWeek,
    end: row.forecast.windowEndWeek,
  });
}
async function readCorpora(
  directory: string,
  manifest: Manifest,
  signal: AbortSignal,
  verifyVectors: boolean,
): Promise<void> {
  const request = rosSharedCorpusRequest(manifest.bundle.forecastSeason).protocol;
  let evaluationRows: Map<string, string> | undefined;
  const dependencies: (readonly [RosMarginalDependency, string])[] = [
    ["candidate", manifest.bundle.candidateCorpusIdentity],
    ["previous", manifest.bundle.previousCorpusIdentity],
    ...(manifest.bundle.intervalTrainingCorpusIdentity === undefined
      ? []
      : [["training", manifest.bundle.intervalTrainingCorpusIdentity] as const]),
  ];
  const validatedCorpora: (readonly [RosMarginalDependency, RosHistoricalCorpus])[] = [];
  for (const [dependency, identity] of dependencies) {
    signal.throwIfAborted();
    const store =
      dependency === "previous"
        ? createRetainedV12RosHistoricalCorpusReader({ directory: path.join(directory, "corpora") })
        : createRosHistoricalCorpusStore({ directory: path.join(directory, "corpora") });
    const loaded = await store.read(identity, { signal });
    if (loaded.state !== "hit") fail(dependency, loaded.state);
    const corpus = loaded.corpus;
    try {
      const definition = requireRosHistoricalPointsAllowedDefinition(corpus);
      if (
        validatedCorpora.length > 0 &&
        definition !== validatedCorpora[0]![1].pointsAllowedDefinition
      )
        fail(dependency, "incompatible");
    } catch {
      fail(dependency, "incompatible");
    }
    const training = dependency === "training";
    const positions = training ? ["DST"] : POSITIONS;
    const count = training ? 32 : 8;
    if (
      !Object.hasOwn(corpus, "actualDefinitionVersion") ||
      corpus.actualDefinitionVersion !== ROS_HISTORICAL_ACTUAL_DEFINITION_VERSION ||
      lineage(corpus) !== manifest.sourceLineageChecksum ||
      canonical(corpus.seasons) !== canonical(request.heldOutSeasons) ||
      canonical(corpus.sourceAudit.map((row) => row.season).sort()) !==
        canonical([...request.sourceSeasons].sort()) ||
      !hasRosHistoricalCorpusReleaseThresholds(corpus.options) ||
      !hasCurrentRosHistoricalCoverageThresholds(corpus.coverage.thresholds) ||
      corpus.coverage.state !== "qualified" ||
      canonical(corpus.coverage.heldOutSeasonsRequested) !== canonical(request.heldOutSeasons) ||
      canonical(corpus.coverage.fullyHeldOutSeasons) !== canonical(request.heldOutSeasons) ||
      corpus.coverage.completeAsOfBatches <
        request.heldOutSeasons.length * request.asOfWeeks.length ||
      corpus.weeklyModelVersion !== request.weeklyModelVersion ||
      corpus.productionBasis !== request.productionBasis ||
      corpus.outcomeSchemaVersion !== request.outcomeSchemaVersion ||
      corpus.options.maximumForecasts !== request.maximumForecasts ||
      corpus.skippedForecasts !== 0 ||
      corpus.options.playersPerPosition !== count ||
      corpus.forecasts.length !== positions.length * 4 * 17 * count ||
      canonical([...corpus.options.positions].sort()) !== canonical([...positions].sort()) ||
      canonical([...corpus.options.asOfWeeks].sort()) !==
        canonical([...request.asOfWeeks].sort()) ||
      canonical(corpus.options.heldOutSeasons) !== canonical(request.heldOutSeasons)
    )
      fail(dependency, "incompatible");
    const rows = new Map<string, string>();
    const groups = new Map<string, number>();
    for (const row of corpus.forecasts) {
      const f = row.forecast;
      if (
        !request.heldOutSeasons.includes(f.forecastSeason) ||
        !request.asOfWeeks.includes(f.asOfWeek) ||
        !positions.includes(f.position) ||
        rows.has(rowKey(row))
      )
        fail(dependency, "incompatible");
      rows.set(rowKey(row), target(row));
      const group = `${f.forecastSeason}:${f.asOfWeek}:${f.position}`;
      groups.set(group, (groups.get(group) ?? 0) + 1);
    }
    if (groups.size !== positions.length * 4 * 17 || [...groups.values()].some((n) => n !== count))
      fail(dependency, "incompatible");
    if (dependency === "candidate") evaluationRows = rows;
    else
      for (const [key, expected] of evaluationRows!) {
        if ((!training || key.split(":")[2] === "DST") && rows.get(key) !== expected)
          fail(dependency, "incompatible");
      }
    validatedCorpora.push([dependency, corpus]);
  }
  // A stale actual definition anywhere in the bundle invalidates its evidence before any
  // candidate or retained benchmark vectors are read.
  if (verifyVectors) {
    for (const [dependency, corpus] of validatedCorpora) {
      const cache = createRosOutcomeCache({ directory });
      for (const row of corpus.forecasts)
        for (const [strategy, key] of [
          ["contextual", row.contextualKey],
          ["availability-aware-recency", row.recencyKey],
        ] as const) {
          signal.throwIfAborted();
          const entry = await cache.read(key, {
            signal,
            expectedScenarioCount: corpus.buildProtocol.referenceScenarioCount,
          });
          if (entry.state !== "hit") fail(dependency, entry.state);
          try {
            (dependency === "previous"
              ? restoreRetainedV12CachedRosHistoricalOutcome
              : restoreCachedRosHistoricalOutcome)(entry.ensemble, key, {
              ...row.forecast,
              strategy,
              weeklyModelVersion: corpus.weeklyModelVersion,
              scheduledGames: row.scheduledGames,
            });
          } catch {
            fail(dependency, "corrupt");
          }
        }
    }
  }
}
/** Reads only. Missing or corrupt dependencies never become per-profile model builds. */
export function createRosMarginalCorpusBundleResolver(options: {
  readonly directory: string;
  readonly bundleChecksum?: string | undefined;
}) {
  return async (season: number, signal: AbortSignal): Promise<RosMarginalCorpusBundle> => {
    signal.throwIfAborted();
    if (!options.bundleChecksum) fail("bundle", "unconfigured");
    if (!SHA256.test(options.bundleChecksum)) fail("bundle", "corrupt");
    let handle;
    try {
      handle = await open(
        path.join(options.directory, "marginal-bundles", `${options.bundleChecksum}.json`),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
    } catch (error) {
      signal.throwIfAborted();
      fail("bundle", (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "corrupt");
    }
    let manifest: unknown;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_BYTES) fail("bundle", "corrupt");
      // Read at most one bounded buffer even if a concurrent writer grows the file after stat.
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        signal.throwIfAborted();
        const read = await handle.read(buffer, length, buffer.length - length);
        if (read.bytesRead === 0) break;
        length += read.bytesRead;
      }
      const bytes = buffer.subarray(0, length);
      signal.throwIfAborted();
      if (length > MAX_BYTES || hash(bytes) !== options.bundleChecksum) fail("bundle", "corrupt");
      try {
        manifest = JSON.parse(
          new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
        );
      } catch {
        fail("bundle", "corrupt");
      }
    } finally {
      await handle.close();
    }
    validateManifest(manifest, season);
    await readCorpora(options.directory, manifest, signal, false);
    signal.throwIfAborted();
    return manifest.bundle;
  };
}
/** Explicit shared preparation, never called by an individual scoring-profile proof. */
export async function prepareRosMarginalCorpusBundle(options: {
  readonly directory: string;
  readonly bundle: RosMarginalCorpusBundle;
  readonly sourceLineageChecksum: string;
  readonly lock: RosCorpusLock;
  readonly signal: AbortSignal;
}): Promise<string> {
  const manifest: Manifest = {
    format: FORMAT,
    bundle: options.bundle,
    sourceLineageChecksum: options.sourceLineageChecksum,
  };
  validateManifest(manifest, options.bundle.forecastSeason);
  const bytes = canonical(manifest);
  if (Buffer.byteLength(bytes) > MAX_BYTES) fail("bundle", "corrupt");
  const checksum = hash(bytes);
  return options.lock(ROS_SHARED_CORPUS_BUILD_LOCK, options.signal, async (guard) => {
    await readCorpora(options.directory, manifest, guard.signal, true);
    await guard.assertHeld();
    const directory = path.join(options.directory, "marginal-bundles");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await assertRosCacheHeadroom(directory, Buffer.byteLength(bytes), guard.signal);
    const destination = path.join(directory, `${checksum}.json`);
    const temporary = path.join(directory, `${checksum}.${randomUUID()}.partial`);
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
      try {
        await link(temporary, destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await createRosMarginalCorpusBundleResolver({
          directory: options.directory,
          bundleChecksum: checksum,
        })(options.bundle.forecastSeason, guard.signal);
      }
      const folder = await open(directory, "r");
      try {
        await folder.sync();
      } finally {
        await folder.close();
      }
      return checksum;
    } finally {
      await rm(temporary, { force: true });
    }
  });
}
/** Public source-only digest for a manifest created by explicit preparation. */
export const rosMarginalCorpusSourceLineageChecksum = lineage;
