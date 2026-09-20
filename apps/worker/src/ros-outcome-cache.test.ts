import { createHash } from "node:crypto";
import type * as FileSystemPromises from "node:fs/promises";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createRosOutcomeCache,
  ROS_OUTCOME_CACHE_VERSION,
  RosOutcomeCacheError,
  type RosOutcomeCacheEnsemble,
  type RosOutcomeCacheKey,
} from "./ros-outcome-cache.js";

// Exercise real immutable I/O independently of the host's available temporary filesystem space.
// Low-space behavior is covered separately in ros-cache-disk-space.test.ts.
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof FileSystemPromises>()),
  statfs: vi.fn().mockResolvedValue({
    type: 0n,
    bsize: 4_096n,
    blocks: 16_777_216n,
    bfree: 16_777_216n,
    bavail: 16_777_216n,
    files: 100_000n,
    ffree: 99_000n,
  }),
}));

const directories: string[] = [];
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const key: RosOutcomeCacheKey = {
  modelVersion: "laces-ros-test-v1",
  identity: hash("pinned football inputs"),
};
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : 1))
      .map(([name, child]) => `${JSON.stringify(name)}:${canonical(child)}`)
      .join(",")}}`;
  return JSON.stringify(value);
};

async function directory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ros-outcome-cache-"));
  directories.push(directory);
  return directory;
}

function ensemble(): RosOutcomeCacheEnsemble {
  return {
    scenarioCount: 4,
    columns: {
      rushing_yards: new Float64Array([Number.MIN_VALUE, -0, -3.5, 1.0000000000000002]),
      receptions: new Float64Array([0, 1, 2, 3]),
    },
    games: new Uint8Array([0, 1, 2, 2]),
    metadata: {
      playerId: "test-rb",
      sourceChecksums: [hash("source")],
      cutoff: { season: 2025, week: 12 },
    },
  };
}

async function entry(directory: string) {
  const files = (await readdir(directory)).filter((file) => file.endsWith(".ros-outcomes"));
  expect(files).toHaveLength(1);
  return path.join(directory, files[0]!);
}

async function readEntry(directory: string) {
  const file = await entry(directory);
  const bytes = await readFile(file);
  const size = bytes.readUInt32LE(8);
  const envelope = JSON.parse(bytes.subarray(12, 12 + size).toString("utf8")) as {
    checksum: string;
    manifest: Record<string, unknown>;
  };
  return { file, bytes, envelope, compressed: bytes.subarray(12 + size) };
}

/** Rehash deliberate malformed content to exercise validation beyond simple checksum mismatch. */
async function alterEntry(
  directory: string,
  mutate: (input: { manifest: Record<string, unknown>; payload: Buffer }) => void,
) {
  const current = await readEntry(directory);
  const payload = gunzipSync(current.compressed);
  mutate({ manifest: current.envelope.manifest, payload });
  const compressed = gzipSync(payload, { level: 1 });
  const manifest = {
    ...current.envelope.manifest,
    compressedChecksum: hash(compressed),
    compressedBytes: compressed.length,
    dataChecksum: hash(payload),
  };
  const envelope = Buffer.from(canonical({ manifest, checksum: hash(canonical(manifest)) }));
  const header = Buffer.alloc(12);
  current.bytes.copy(header, 0, 0, 8);
  header.writeUInt32LE(envelope.length, 8);
  await writeFile(current.file, Buffer.concat([header, envelope, compressed]));
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("bounded reusable ROS outcome storage", () => {
  it("round-trips signed/subnormal Float64 values, aligned games and canonical metadata without loss", async () => {
    const dir = await directory();
    const cache = createRosOutcomeCache({ directory: dir });
    expect(await cache.read(key)).toEqual({ state: "missing" });
    const original = ensemble();
    const written = await cache.write(key, original);
    expect(written.state).toBe("written");
    const read = await cache.read(key, { expectedScenarioCount: 4 });
    expect(read.state).toBe("hit");
    if (read.state !== "hit") throw new Error("Expected cache hit");
    expect(read.manifestChecksum).toBe(written.manifestChecksum);
    expect(Object.keys(read.ensemble.columns)).toEqual(["receptions", "rushing_yards"]);
    for (const name of Object.keys(original.columns)) {
      expect(Buffer.from(read.ensemble.columns[name]!.buffer)).toEqual(
        Buffer.from(original.columns[name]!.buffer),
      );
    }
    expect(Object.is(read.ensemble.columns.rushing_yards![1], -0)).toBe(true);
    expect(read.ensemble.games).toEqual(original.games);
    expect(read.ensemble.metadata).toEqual(original.metadata);
    expect(await readdir(dir)).toHaveLength(1);
    const disk = await readEntry(dir);
    expect(disk.bytes.subarray(0, 8).toString()).toBe("LOROSC01");
    expect(disk.envelope.manifest.version).toBe(ROS_OUTCOME_CACHE_VERSION);
    expect(hash(disk.compressed)).toBe(disk.envelope.manifest.compressedChecksum);
    expect(hash(gunzipSync(disk.compressed))).toBe(disk.envelope.manifest.dataChecksum);
  });

  it.each(["LE", "BE"] as const)(
    "preserves exact values and independent buffers through the %s decoder across inflate chunks",
    async (endianness) => {
      const actualOs = await vi.importActual<typeof os>("node:os");
      vi.doMock("node:os", () => ({ ...actualOs, endianness: () => endianness }));
      vi.resetModules();
      try {
        const { createRosOutcomeCache: createCache } = await import("./ros-outcome-cache.js");
        const dir = await directory();
        const cache = createCache({ directory: dir });
        const values = [
          Number.MIN_VALUE,
          -0,
          0,
          -3.5,
          1.0000000000000002,
          Number.MAX_VALUE,
          -Number.MIN_VALUE,
          -Number.MAX_VALUE,
        ];
        const count = 16_384;
        const original: RosOutcomeCacheEnsemble = {
          scenarioCount: count,
          columns: Object.fromEntries(
            ["first", "middle", "last"].map((name, column) => [
              name,
              Float64Array.from({ length: count }, (_, index) => values[(index + column) % 8]!),
            ]),
          ),
          games: Uint8Array.from({ length: count }, (_, index) => index % 19),
          metadata: { decoder: "exact-format-parity" },
        };
        await cache.write(key, original);
        const diskBefore = await readEntry(dir);
        const first = await cache.read(key);
        const second = await cache.read(key);
        if (first.state !== "hit" || second.state !== "hit") throw new Error("Expected hits");
        expect(first.manifestChecksum).toBe(second.manifestChecksum);
        expect(first.ensemble.metadata).toEqual(original.metadata);
        for (const name of Object.keys(original.columns)) {
          const decoded = first.ensemble.columns[name]!;
          expect(Buffer.from(decoded.buffer)).toEqual(Buffer.from(original.columns[name]!.buffer));
          expect(decoded.buffer.byteLength).toBe(count * 8);
          expect(decoded.buffer).not.toBe(second.ensemble.columns[name]!.buffer);
          decoded.fill(123);
          expect(second.ensemble.columns[name]).toEqual(original.columns[name]);
        }
        first.ensemble.games.fill(255);
        expect(second.ensemble.games).toEqual(original.games);
        expect(
          new Set(Object.values(first.ensemble.columns).map((column) => column.buffer)).size,
        ).toBe(3);
        expect(first.ensemble.games.buffer).not.toBe(second.ensemble.games.buffer);
        expect((await readEntry(dir)).bytes).toEqual(diskBefore.bytes);
      } finally {
        vi.doUnmock("node:os");
        vi.resetModules();
      }
    },
  );

  it("has one atomic winner for concurrent identical writers and preserves immutable conflicting input", async () => {
    const dir = await directory();
    const cache = createRosOutcomeCache({ directory: dir });
    const writes = await Promise.all(Array.from({ length: 5 }, () => cache.write(key, ensemble())));
    expect(writes.filter((write) => write.state === "written")).toHaveLength(1);
    expect(writes.filter((write) => write.state === "existing")).toHaveLength(4);
    expect(new Set(writes.map((write) => write.manifestChecksum)).size).toBe(1);
    const changed = ensemble();
    changed.columns.receptions![0] = 100;
    await expect(cache.write(key, changed)).rejects.toMatchObject({ code: "identity_conflict" });
    const read = await cache.read(key);
    expect(read.state === "hit" && read.ensemble.columns.receptions![0]).toBe(0);
    expect(await readdir(dir)).toHaveLength(1);
  });

  it("snapshots caller-owned buffers and metadata before the first I/O wait", async () => {
    const dir = await directory();
    const cache = createRosOutcomeCache({ directory: dir });
    const original = { ...ensemble() };
    const mutableKey = { ...key };
    const write = cache.write(mutableKey, original);
    original.columns.receptions![0] = 999;
    original.games[0] = 255;
    (original.metadata.cutoff as { season: number; week: number }).week = 99;
    original.scenarioCount = 8;
    mutableKey.modelVersion = "another-model";
    mutableKey.identity = hash("other identity");
    await write;
    const read = await cache.read(key);
    expect(read.state).toBe("hit");
    if (read.state !== "hit") throw new Error("Expected cache hit");
    expect(read.ensemble.columns.receptions![0]).toBe(0);
    expect(read.ensemble.games[0]).toBe(0);
    expect(read.ensemble.metadata.cutoff).toEqual({ season: 2025, week: 12 });
    expect(await cache.read(mutableKey)).toEqual({ state: "missing" });
    const readKey = { ...key };
    const reading = cache.read(readKey);
    readKey.identity = hash("mutated during read");
    expect((await reading).state).toBe("hit");
  });

  it("lets concurrent distinct contents compete without replacing the winner", async () => {
    const dir = await directory();
    const cache = createRosOutcomeCache({ directory: dir });
    const different = ensemble();
    different.columns.receptions![0] = 10;
    const outcomes = await Promise.allSettled([
      cache.write(key, ensemble()),
      cache.write(key, different),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.find((outcome) => outcome.status === "rejected")).toMatchObject({
      reason: { code: "identity_conflict" },
    });
    const read = await cache.read(key);
    expect(read.state).toBe("hit");
    expect(await readdir(dir)).toHaveLength(1);
  });

  it("namespaces identities by model, supports independent forecasts, and never builds a missing entry", async () => {
    const dir = await directory();
    const cache = createRosOutcomeCache({ directory: dir });
    await cache.write(key, ensemble());
    const nextModel = { ...key, modelVersion: "laces-ros-test-v2" };
    expect(await cache.read(nextModel)).toEqual({ state: "missing" });
    const nextInputs = { ...key, identity: hash("different cutoff") };
    expect(await cache.read(nextInputs)).toEqual({ state: "missing" });
    await cache.write(nextModel, ensemble());
    await cache.write(nextInputs, ensemble());
    expect(await readdir(dir)).toHaveLength(3);
    expect((await cache.read(key)).state).toBe("hit");
  });

  it.each([
    [
      "version",
      (manifest: Record<string, unknown>) => {
        manifest.version = 999;
      },
      "manifest_invalid",
    ],
    [
      "identity",
      (manifest: Record<string, unknown>) => {
        manifest.identity = hash("another input");
      },
      "identity_mismatch",
    ],
    [
      "model",
      (manifest: Record<string, unknown>) => {
        manifest.modelVersion = "other-model";
      },
      "identity_mismatch",
    ],
    [
      "count",
      (manifest: Record<string, unknown>) => {
        manifest.scenarioCount = 0;
      },
      "limits_exceeded",
    ],
    [
      "oversized count",
      (manifest: Record<string, unknown>) => {
        manifest.scenarioCount = 1e9;
      },
      "limits_exceeded",
    ],
    [
      "duplicate columns",
      (manifest: Record<string, unknown>) => {
        manifest.columnNames = ["receptions", "receptions"];
      },
      "manifest_invalid",
    ],
    [
      "unknown encoding",
      (manifest: Record<string, unknown>) => {
        manifest.encoding = "float32";
      },
      "manifest_invalid",
    ],
  ] as const)("rejects rehashed %s corruption", async (_name, mutate, reason) => {
    const dir = await directory();
    const cache = createRosOutcomeCache({ directory: dir });
    await cache.write(key, ensemble());
    await alterEntry(dir, ({ manifest }) => mutate(manifest));
    expect(await cache.read(key)).toEqual({ state: "corrupt", reason });
  });

  it("distinguishes wrong expected counts and internal binary counts from missing evidence", async () => {
    const dir = await directory();
    const cache = createRosOutcomeCache({ directory: dir });
    await cache.write(key, ensemble());
    expect(await cache.read(key, { expectedScenarioCount: 8 })).toEqual({
      state: "corrupt",
      reason: "identity_mismatch",
    });
    await alterEntry(dir, ({ payload }) => {
      payload.writeUInt32LE(3, 12);
    });
    expect(await cache.read(key)).toEqual({ state: "corrupt", reason: "payload_invalid" });
  });

  it.each([
    [Number.NaN, 24],
    [Infinity, 24 + 3 * 8],
    [-Infinity, 24 + 7 * 8],
  ])(
    "rejects validly checksummed nonfinite binary components (%s at %s)",
    async (value, offset) => {
      const dir = await directory();
      const cache = createRosOutcomeCache({ directory: dir });
      await cache.write(key, ensemble());
      await alterEntry(dir, ({ payload }) => {
        payload.writeDoubleLE(value, offset);
      });
      expect(await cache.read(key)).toEqual({ state: "corrupt", reason: "nonfinite_component" });
      await expect(cache.write(key, ensemble())).rejects.toMatchObject({
        code: "existing_entry_corrupt",
      });
    },
  );

  it.each([0, 8, 11, 20, -1])(
    "detects an interrupted/truncated entry (%s) and never silently overwrites it",
    async (length) => {
      const dir = await directory();
      const cache = createRosOutcomeCache({ directory: dir });
      await cache.write(key, ensemble());
      const current = await readEntry(dir);
      await writeFile(
        current.file,
        current.bytes.subarray(0, length < 0 ? current.bytes.length - 1 : length),
      );
      expect((await cache.read(key)).state).toBe("corrupt");
      await expect(cache.write(key, ensemble())).rejects.toMatchObject({
        code: "existing_entry_corrupt",
      });
    },
  );

  it("detects manifest checksum corruption and appended payload bytes", async () => {
    const dir = await directory();
    const cache = createRosOutcomeCache({ directory: dir });
    await cache.write(key, ensemble());
    const current = await readEntry(dir);
    const corrupted = Buffer.from(current.bytes);
    const checksumAt = corrupted.indexOf(current.envelope.checksum);
    corrupted[checksumAt] = current.envelope.checksum[0] === "a" ? 98 : 97;
    await writeFile(current.file, corrupted);
    expect(await cache.read(key)).toEqual({
      state: "corrupt",
      reason: "manifest_checksum_mismatch",
    });
    await writeFile(current.file, Buffer.concat([current.bytes, Buffer.from([0])]));
    expect(await cache.read(key)).toEqual({ state: "corrupt", reason: "payload_invalid" });
  });

  it("detects compressed data corruption even when its byte count is unchanged", async () => {
    const dir = await directory();
    const cache = createRosOutcomeCache({ directory: dir });
    await cache.write(key, ensemble());
    const current = await readEntry(dir);
    const corrupted = Buffer.from(current.bytes);
    corrupted[corrupted.length - 1] = corrupted[corrupted.length - 1]! ^ 255;
    await writeFile(current.file, corrupted);
    expect((await cache.read(key)).state).toBe("corrupt");
  });

  it("bounds decompression by the declared exact data size", async () => {
    const dir = await directory();
    const cache = createRosOutcomeCache({ directory: dir });
    await cache.write(key, ensemble());
    await alterEntry(dir, ({ manifest }) => {
      manifest.scenarioCount = 1;
      manifest.dataBytes = 24 + 17;
    });
    expect(await cache.read(key)).toEqual({ state: "corrupt", reason: "limits_exceeded" });
  });

  it("rejects symlink entries instead of reading outside the immutable cache", async () => {
    const dir = await directory();
    const cache = createRosOutcomeCache({ directory: dir });
    await cache.write(key, ensemble());
    const target = await entry(dir);
    const outside = path.join(dir, "outside");
    await writeFile(outside, await readFile(target));
    await rm(target);
    await symlink(outside, target);
    expect(await cache.read(key)).toEqual({ state: "corrupt", reason: "manifest_invalid" });
  });

  it("bounds metadata, columns, scenario/data/compressed bytes and does not leave partial artifacts", async () => {
    const dir = await directory();
    const attempts = [
      { maximumMetadataBytes: 8 },
      { maximumColumns: 1 },
      { maximumScenarioCount: 2 },
      { maximumDataBytes: 24 },
      { maximumCompressedBytes: 8 },
    ];
    for (const limits of attempts) {
      const cache = createRosOutcomeCache({ directory: dir, limits });
      await expect(cache.write(key, ensemble())).rejects.toBeInstanceOf(RosOutcomeCacheError);
      expect(await readdir(dir)).toEqual([]);
    }
  });

  it("fails closed on mismatched lengths, nonfinite inputs, invalid keys and non-JSON metadata", async () => {
    const dir = await directory();
    const cache = createRosOutcomeCache({ directory: dir });
    await expect(
      cache.write(key, { ...ensemble(), games: new Uint8Array(3) }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    const nonfinite = ensemble();
    nonfinite.columns.receptions![0] = Infinity;
    await expect(cache.write(key, nonfinite)).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      cache.write({ ...key, identity: "../elsewhere" }, ensemble()),
    ).rejects.toMatchObject({ code: "invalid_input" });
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    await expect(
      cache.write(key, { ...ensemble(), metadata: cycle as RosOutcomeCacheEnsemble["metadata"] }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(await readdir(dir)).toEqual([]);
  });

  it("cancels pre-aborted reads/writes and in-progress compression without publishing or leaking partial files", async () => {
    const dir = await directory();
    const cache = createRosOutcomeCache({ directory: dir });
    const controller = new AbortController();
    controller.abort(new Error("test cancelled"));
    await expect(cache.read(key, { signal: controller.signal })).rejects.toThrow("test cancelled");
    await expect(cache.write(key, ensemble(), { signal: controller.signal })).rejects.toThrow(
      "test cancelled",
    );
    const active = new AbortController();
    const count = 16_384;
    const columns = Object.fromEntries(
      Array.from({ length: 64 }, (_, index) => [
        `stat_${index}`,
        Float64Array.from({ length: count }, (_, scenario) => Math.sin(scenario + index)),
      ]),
    );
    const write = cache.write(
      key,
      { scenarioCount: count, columns, games: new Uint8Array(count), metadata: {} },
      { signal: active.signal },
    );
    const timer = setTimeout(() => active.abort(new Error("cancel active compression")), 10);
    try {
      await expect(write).rejects.toThrow();
    } finally {
      clearTimeout(timer);
    }
    expect(await cache.read(key)).toEqual({ state: "missing" });
    expect(await readdir(dir)).toEqual([]);
  });
});
