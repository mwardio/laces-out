import { createHash } from "node:crypto";
import type { BigIntStatsFs } from "node:fs";
import type * as FileSystemPromises from "node:fs/promises";
import { mkdtemp, readFile, readdir, rm, stat, statfs, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  assertRosCacheHeadroom,
  ROS_CACHE_MINIMUM_FREE_BYTES,
  RosCacheDiskSpaceError,
} from "./ros-cache-disk-space.js";
import { createRosHistoricalCorpusStore } from "./ros-historical-corpus.js";
import { historicalCorpusFixture } from "./ros-historical-outcome.test-fixtures.js";
import {
  createRosOutcomeCache,
  type RosOutcomeCacheEnsemble,
  type RosOutcomeCacheKey,
} from "./ros-outcome-cache.js";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof FileSystemPromises>()),
  statfs: vi.fn(),
}));

const directories: string[] = [];
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const key: RosOutcomeCacheKey = {
  modelVersion: "laces-ros-disk-test-v1",
  identity: hash("immutable disk-headroom fixture"),
};
const disk = (available: bigint, blockSize = 1n): BigIntStatsFs => ({
  type: 0n,
  bsize: blockSize,
  blocks: available / blockSize + 1_000_000_000_000n,
  bfree: available / blockSize + 1_000_000_000_000n,
  bavail: available / blockSize,
  files: 100_000n,
  ffree: 99_000n,
});
const ampleDisk = () => disk(ROS_CACHE_MINIMUM_FREE_BYTES + 1_024n ** 3n);

beforeEach(() => {
  vi.mocked(statfs).mockReset().mockResolvedValue(ampleDisk());
});

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function directory() {
  const value = await mkdtemp(path.join(os.tmpdir(), "ros-cache-headroom-"));
  directories.push(value);
  return value;
}

function ensemble(): RosOutcomeCacheEnsemble {
  return {
    scenarioCount: 4,
    columns: {
      rushing_yards: new Float64Array([Number.MIN_VALUE, -0, -3.5, 1.0000000000000002]),
      receptions: new Float64Array([0, 1, 2, 3]),
    },
    games: new Uint8Array([0, 1, 2, 2]),
    metadata: { playerId: "disk-fixture", cutoff: { season: 2025, week: 12 } },
  };
}

async function immutableFile(directory: string, suffix: string) {
  const files = (await readdir(directory)).filter((file) => file.endsWith(suffix));
  expect(files).toHaveLength(1);
  return path.join(directory, files[0]!);
}

describe("ROS cache disk headroom", () => {
  it("reserves exactly 5 GiB plus the pending write using unprivileged available blocks", async () => {
    const dir = await directory();
    expect(ROS_CACHE_MINIMUM_FREE_BYTES).toBe(5n * 1_024n ** 3n);
    const pending = 8_192;
    vi.mocked(statfs).mockResolvedValue(disk(ROS_CACHE_MINIMUM_FREE_BYTES + BigInt(pending)));
    await expect(assertRosCacheHeadroom(dir, pending)).resolves.toBeUndefined();
    expect(statfs).toHaveBeenLastCalledWith(dir, { bigint: true });
    // Reserved root blocks cannot satisfy the worker's reserve, even if bfree is very large.
    vi.mocked(statfs).mockResolvedValue(disk(ROS_CACHE_MINIMUM_FREE_BYTES + BigInt(pending) - 1n));
    const failure = await assertRosCacheHeadroom(dir, pending).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      name: "RosCacheDiskSpaceError",
      code: "insufficient_disk_space",
    });
    // Operational errors must remain serializable by the worker's structured failure logger.
    expect(() => JSON.stringify(failure)).not.toThrow();
    expect(JSON.parse(JSON.stringify(failure))).toMatchObject({
      availableBytes: String(ROS_CACHE_MINIMUM_FREE_BYTES + BigInt(pending) - 1n),
      requiredFreeBytes: String(ROS_CACHE_MINIMUM_FREE_BYTES + BigInt(pending)),
    });
  });

  it("accounts for filesystem block size and retains bigint precision at large pending sizes", async () => {
    const dir = await directory();
    vi.mocked(statfs).mockResolvedValue(disk(ROS_CACHE_MINIMUM_FREE_BYTES + 4_096n, 4_096n));
    await expect(assertRosCacheHeadroom(dir, 4_096)).resolves.toBeUndefined();
    await expect(assertRosCacheHeadroom(dir, 4_097)).rejects.toBeInstanceOf(RosCacheDiskSpaceError);
    const pending = Number.MAX_SAFE_INTEGER;
    vi.mocked(statfs).mockResolvedValue(disk(ROS_CACHE_MINIMUM_FREE_BYTES + BigInt(pending) - 1n));
    await expect(assertRosCacheHeadroom(dir, pending)).rejects.toMatchObject({
      code: "insufficient_disk_space",
    });
    vi.mocked(statfs).mockResolvedValue(disk(ROS_CACHE_MINIMUM_FREE_BYTES + BigInt(pending)));
    await expect(assertRosCacheHeadroom(dir, pending)).resolves.toBeUndefined();
  });

  it("fails closed when available space cannot be inspected", async () => {
    const dir = await directory();
    vi.mocked(statfs).mockRejectedValue(
      Object.assign(new Error("filesystem unavailable"), { code: "EIO" }),
    );
    await expect(assertRosCacheHeadroom(dir, 1)).rejects.toMatchObject({
      name: "RosCacheDiskSpaceError",
      code: "disk_space_check_failed",
    });
  });

  it("honors cancellation before and during the filesystem probe", async () => {
    const dir = await directory();
    const before = new AbortController();
    const reason = new Error("cancelled disk check");
    before.abort(reason);
    await expect(assertRosCacheHeadroom(dir, 1, before.signal)).rejects.toBe(reason);
    expect(statfs).not.toHaveBeenCalled();
    const during = new AbortController();
    vi.mocked(statfs).mockImplementation(async () => {
      during.abort(reason);
      return ampleDisk();
    });
    await expect(assertRosCacheHeadroom(dir, 1, during.signal)).rejects.toBe(reason);
  });
});

describe("immutable ROS writes under disk pressure", () => {
  it("keeps successful outcome files and Float64 values byte-identical across headroom checks", async () => {
    const first = await directory();
    const second = await directory();
    const original = ensemble();
    const firstCache = createRosOutcomeCache({ directory: first });
    const secondCache = createRosOutcomeCache({ directory: second });
    const firstResult = await firstCache.write(key, original);
    vi.mocked(statfs).mockResolvedValue(disk(ROS_CACHE_MINIMUM_FREE_BYTES + 16n * 1_024n ** 2n));
    expect(await secondCache.write(key, original)).toEqual(firstResult);
    expect(await readFile(await immutableFile(second, ".ros-outcomes"))).toEqual(
      await readFile(await immutableFile(first, ".ros-outcomes")),
    );
    const read = await secondCache.read(key);
    expect(read.state).toBe("hit");
    if (read.state !== "hit") throw new Error("Expected immutable outcome hit");
    for (const [name, values] of Object.entries(original.columns))
      expect(Buffer.from(read.ensemble.columns[name]!.buffer)).toEqual(Buffer.from(values.buffer));
    expect(read.ensemble.games).toEqual(original.games);
    expect(read.ensemble.metadata).toEqual(original.metadata);
    expect(statfs).toHaveBeenCalled();
  });

  it("rejects a new outcome at low space while preserving a verified existing entry", async () => {
    const dir = await directory();
    const cache = createRosOutcomeCache({ directory: dir });
    await cache.write(key, ensemble());
    const existing = await immutableFile(dir, ".ros-outcomes");
    const original = await readFile(existing);
    const originalRead = await cache.read(key);
    expect(originalRead.state).toBe("hit");
    vi.mocked(statfs).mockResolvedValue(disk(ROS_CACHE_MINIMUM_FREE_BYTES - 1n));
    const nextKey = { ...key, identity: hash("next forecast") };
    await expect(cache.write(nextKey, ensemble())).rejects.toMatchObject({
      code: "insufficient_disk_space",
    });
    expect(await cache.read(nextKey)).toEqual({ state: "missing" });
    expect(await cache.read(key)).toEqual(originalRead);
    expect(await readFile(existing)).toEqual(original);
    expect(await readdir(dir)).toEqual([path.basename(existing)]);
  });

  it("cleans only the current partial when space disappears after compressed bytes reach disk", async () => {
    const dir = await directory();
    const cache = createRosOutcomeCache({ directory: dir });
    await cache.write(key, ensemble());
    const existing = await immutableFile(dir, ".ros-outcomes");
    const original = await readFile(existing);
    const unrelated = path.join(dir, "another-job.partial");
    await writeFile(unrelated, "another job owns this artifact");
    let observedPartialBytes = 0;
    vi.mocked(statfs).mockImplementation(async () => {
      const partials = (await readdir(dir)).filter((name) =>
        name.startsWith(".ros-outcomes-partial-"),
      );
      for (const partial of partials) {
        const files = await readdir(path.join(dir, partial));
        for (const file of files)
          observedPartialBytes += (await stat(path.join(dir, partial, file))).size;
      }
      return observedPartialBytes > 0 ? disk(0n) : ampleDisk();
    });
    const nextKey = { ...key, identity: hash("interrupted forecast") };
    await expect(cache.write(nextKey, ensemble())).rejects.toMatchObject({
      code: "insufficient_disk_space",
    });
    expect(observedPartialBytes).toBeGreaterThan(0);
    expect(await cache.read(nextKey)).toEqual({ state: "missing" });
    expect(await readFile(existing)).toEqual(original);
    expect((await cache.read(key)).state).toBe("hit");
    expect(await readFile(unrelated, "utf8")).toBe("another job owns this artifact");
    expect((await readdir(dir)).sort()).toEqual(
      [path.basename(existing), path.basename(unrelated)].sort(),
    );
  });

  it("preserves corpus identity and exact compressed bytes when sufficient space remains", async () => {
    const first = await directory();
    const second = await directory();
    const manifest = historicalCorpusFixture();
    const firstStore = createRosHistoricalCorpusStore({ directory: first });
    const secondStore = createRosHistoricalCorpusStore({ directory: second });
    const saved = await firstStore.write(manifest);
    vi.mocked(statfs).mockResolvedValue(disk(ROS_CACHE_MINIMUM_FREE_BYTES + 16n * 1_024n ** 2n));
    expect(await secondStore.write(manifest)).toEqual(saved);
    expect(await readFile(await immutableFile(second, ".ros-corpus.json.gz"))).toEqual(
      await readFile(await immutableFile(first, ".ros-corpus.json.gz")),
    );
    expect(await secondStore.read(saved.identity)).toEqual({
      state: "hit",
      identity: saved.identity,
      corpus: manifest,
    });
  });

  it("rejects a new corpus at low space and leaves existing immutable evidence readable", async () => {
    const dir = await directory();
    const store = createRosHistoricalCorpusStore({ directory: dir });
    const manifest = historicalCorpusFixture();
    const saved = await store.write(manifest);
    const existing = await immutableFile(dir, ".ros-corpus.json.gz");
    const original = await readFile(existing);
    vi.mocked(statfs).mockResolvedValue(disk(ROS_CACHE_MINIMUM_FREE_BYTES - 1n));
    await expect(
      store.write({
        ...manifest,
        sourceChecksums: { ...manifest.sourceChecksums, catalog: hash("new source") },
      }),
    ).rejects.toMatchObject({ code: "insufficient_disk_space" });
    expect(await readFile(existing)).toEqual(original);
    expect(await store.read(saved.identity)).toEqual({
      state: "hit",
      identity: saved.identity,
      corpus: manifest,
    });
    expect(await readdir(dir)).toEqual([path.basename(existing)]);
  });
});
