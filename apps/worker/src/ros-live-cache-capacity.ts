import { createHash } from "node:crypto";
import { lstat, mkdir, opendir, rm } from "node:fs/promises";
import path from "node:path";

import { rosCacheCompressedWriteBudget } from "./ros-cache-disk-space.js";
import {
  createRosOutcomeCache,
  ROS_OUTCOME_CACHE_LIMITS,
  ROS_OUTCOME_CACHE_VERSION,
  RosOutcomeCacheError,
  type RosOutcomeCache,
  type RosOutcomeCacheEnsemble,
  type RosOutcomeCacheKey,
} from "./ros-outcome-cache.js";

export const ROS_LIVE_OUTCOME_CACHE_MAXIMUM_BYTES = 20 * 1_024 * 1_024 * 1_024;
const SHA256 = /^[a-f0-9]{64}$/u;
const OUTCOME_FILE = /^[a-f0-9]{64}\.ros-outcomes$/u;
const PARTIAL_DIRECTORY = /^\.ros-outcomes-partial-[a-zA-Z0-9]{6}$/u;
const MAXIMUM_INVENTORY_ENTRIES = 200_000;
const MAXIMUM_INVENTORY_DEPTH = 12;
const MANIFEST_AND_HEADER_BYTES = 192 * 1_024 + 12;
const errorCode = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code;

export class RosLiveCacheCapacityError extends Error {
  constructor(readonly code: "invalid_input" | "unsafe_entry" | "capacity_exceeded") {
    super(`ROS live outcome cache ${code}`);
    this.name = "RosLiveCacheCapacityError";
  }
}

/** The v1 outcome format hashes this sorted plain-JSON key; compatibility is pinned by a test. */
function outcomeFileName(key: RosOutcomeCacheKey): string {
  if (
    typeof key.identity !== "string" ||
    !SHA256.test(key.identity) ||
    typeof key.modelVersion !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u.test(key.modelVersion)
  )
    throw new RosOutcomeCacheError("invalid_input");
  const canonical = JSON.stringify({
    identity: key.identity,
    modelVersion: key.modelVersion,
    version: ROS_OUTCOME_CACHE_VERSION,
  });
  return `${createHash("sha256").update(canonical).digest("hex")}.ros-outcomes`;
}

function pendingWriteBytes(ensemble: RosOutcomeCacheEnsemble): number {
  const count = ensemble.scenarioCount;
  const columns = Object.keys(ensemble.columns).length;
  const dataBytes = 24 + count * (columns * Float64Array.BYTES_PER_ELEMENT + 1);
  if (
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > ROS_OUTCOME_CACHE_LIMITS.maximumScenarioCount ||
    columns < 1 ||
    columns > ROS_OUTCOME_CACHE_LIMITS.maximumColumns ||
    !Number.isSafeInteger(dataBytes) ||
    dataBytes > ROS_OUTCOME_CACHE_LIMITS.maximumDataBytes
  )
    throw new RosOutcomeCacheError("invalid_input");
  // The base writer holds data.gz and its prefixed entry concurrently. The final hard link
  // shares the entry's inode, so it adds no third payload allocation.
  return 2 * rosCacheCompressedWriteBudget(dataBytes) + MANIFEST_AND_HEADER_BYTES;
}

/**
 * LIVE CACHE ONLY. The caller must hold the shared Postgres live-generation advisory lock from
 * before prepare() until every returned cache operation and consuming worker has fully settled.
 * That lifetime excludes all other live-generation readers/writers, including other processes.
 * Never point this root at a historical evidence directory. Shared calibration JSON at the root
 * is retained; obsolete generation metadata and vectors are disposable and pruned together.
 *
 * The quota covers current outcome files plus concurrent temporary writes. Metadata has its own
 * per-record limits. The underlying writer separately enforces the 5 GiB filesystem reserve.
 */
export async function prepareRosLiveOutcomeCache(options: {
  readonly rootDirectory: string;
  readonly physicalIdentity: string;
  readonly maximumBytes?: number;
  readonly signal?: AbortSignal;
}): Promise<RosOutcomeCache> {
  const maximumBytes = options.maximumBytes ?? ROS_LIVE_OUTCOME_CACHE_MAXIMUM_BYTES;
  if (
    typeof options.rootDirectory !== "string" ||
    options.rootDirectory.trim() === "" ||
    typeof options.physicalIdentity !== "string" ||
    !SHA256.test(options.physicalIdentity) ||
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    maximumBytes > ROS_LIVE_OUTCOME_CACHE_MAXIMUM_BYTES
  )
    throw new RosLiveCacheCapacityError("invalid_input");
  options.signal?.throwIfAborted();
  const root = path.resolve(options.rootDirectory);
  if (root === path.parse(root).root) throw new RosLiveCacheCapacityError("invalid_input");
  const generations = path.join(root, "generations");
  const current = path.join(generations, options.physicalIdentity);
  const outcomes = path.join(current, "outcomes");
  const ensureDirectory = async (directory: string, recursive = false) => {
    let stat;
    try {
      stat = await lstat(directory);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      await mkdir(directory, { recursive, mode: 0o700 });
      stat = await lstat(directory);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new RosLiveCacheCapacityError("unsafe_entry");
  };
  await ensureDirectory(root, true);
  await ensureDirectory(generations);

  // Validate the entire bounded tree before removing anything. Opendir streams names instead of
  // allocating an unbounded readdir result; lstat never follows a link into another cache/volume.
  let visited = 0;
  const obsolete: string[] = [];
  const partials: string[] = [];
  const sizes = new Map<string, number>();
  let committedBytes = 0;
  const inspect = async (directory: string, depth: number): Promise<void> => {
    if (depth > MAXIMUM_INVENTORY_DEPTH) throw new RosLiveCacheCapacityError("unsafe_entry");
    const entries = await opendir(directory);
    for await (const entry of entries) {
      options.signal?.throwIfAborted();
      if (++visited > MAXIMUM_INVENTORY_ENTRIES)
        throw new RosLiveCacheCapacityError("unsafe_entry");
      const location = path.join(directory, entry.name);
      const stat = await lstat(location);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
        throw new RosLiveCacheCapacityError("unsafe_entry");
      if (directory === generations) {
        if (!SHA256.test(entry.name) || !stat.isDirectory())
          throw new RosLiveCacheCapacityError("unsafe_entry");
        if (entry.name !== options.physicalIdentity) obsolete.push(location);
      }
      if (directory === current && !["metadata", "outcomes"].includes(entry.name))
        throw new RosLiveCacheCapacityError("unsafe_entry");
      if (directory === current && !stat.isDirectory())
        throw new RosLiveCacheCapacityError("unsafe_entry");
      if (directory === outcomes) {
        if (stat.isDirectory() && PARTIAL_DIRECTORY.test(entry.name)) partials.push(location);
        else if (stat.isFile() && OUTCOME_FILE.test(entry.name)) {
          if (!Number.isSafeInteger(stat.size) || stat.size < 1)
            throw new RosLiveCacheCapacityError("unsafe_entry");
          sizes.set(entry.name, stat.size);
          committedBytes += stat.size;
          if (!Number.isSafeInteger(committedBytes))
            throw new RosLiveCacheCapacityError("capacity_exceeded");
        } else throw new RosLiveCacheCapacityError("unsafe_entry");
      }
      if (stat.isDirectory()) await inspect(location, depth + 1);
    }
  };
  await inspect(generations, 0);
  if (committedBytes > maximumBytes) throw new RosLiveCacheCapacityError("capacity_exceeded");
  for (const directory of [...obsolete, ...partials]) {
    options.signal?.throwIfAborted();
    await rm(directory, { recursive: true });
  }
  await ensureDirectory(current);
  await ensureDirectory(outcomes);
  const base = createRosOutcomeCache({ directory: outcomes });
  let reservedBytes = 0;
  let poisoned: Error | undefined;
  const assertUsable = (signal?: AbortSignal) => {
    options.signal?.throwIfAborted();
    signal?.throwIfAborted();
    if (poisoned !== undefined) throw poisoned;
  };
  const sizeOnDisk = async (filename: string): Promise<number | undefined> => {
    try {
      const stat = await lstat(path.join(outcomes, filename));
      if (!stat.isFile() || stat.isSymbolicLink() || !Number.isSafeInteger(stat.size))
        throw new RosLiveCacheCapacityError("unsafe_entry");
      return stat.size;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return undefined;
      throw error;
    }
  };

  return {
    async read(key, readOptions = {}) {
      assertUsable(readOptions.signal);
      const copiedKey = { modelVersion: key.modelVersion, identity: key.identity };
      const filename = outcomeFileName(copiedKey);
      // Protect the base reader from a FIFO or a directory as well as its own O_NOFOLLOW guard.
      await sizeOnDisk(filename);
      assertUsable(readOptions.signal);
      return base.read(copiedKey, readOptions);
    },
    async write(key, ensemble, writeOptions = {}) {
      assertUsable(writeOptions.signal);
      const copiedKey = { modelVersion: key.modelVersion, identity: key.identity };
      const filename = outcomeFileName(copiedKey);
      const reservation = pendingWriteBytes(ensemble);
      if (committedBytes + reservedBytes + reservation > maximumBytes)
        throw new RosLiveCacheCapacityError("capacity_exceeded");
      // Reserve synchronously across concurrent calls, then let the unchanged writer snapshot
      // the caller's Float64 buffers before our first await.
      reservedBytes += reservation;
      try {
        const result = await base.write(copiedKey, ensemble, writeOptions);
        const actual = await sizeOnDisk(filename);
        if (actual === undefined || actual > reservation)
          throw new RosLiveCacheCapacityError("unsafe_entry");
        committedBytes += actual - (sizes.get(filename) ?? 0);
        sizes.set(filename, actual);
        reservedBytes -= reservation;
        return result;
      } catch (error) {
        // If cleanup or reconciliation failed, keep its reservation and stop using this session.
        // A fresh exclusive session inventories/cleans any orphan before writing again.
        poisoned = error instanceof Error ? error : new RosLiveCacheCapacityError("unsafe_entry");
        throw error;
      }
    },
  };
}
