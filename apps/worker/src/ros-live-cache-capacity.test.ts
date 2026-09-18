import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import type * as FileSystemPromises from "node:fs/promises";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { rosCacheCompressedWriteBudget } from "./ros-cache-disk-space.js";
import { prepareRosLiveOutcomeCache } from "./ros-live-cache-capacity.js";
import { createRosLiveGenerationStore } from "./ros-live-generation-store.js";
import {
  createRosOutcomeCache,
  type RosOutcomeCacheEnsemble,
  type RosOutcomeCacheKey,
} from "./ros-outcome-cache.js";

vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof FileSystemPromises>()),
  statfs: vi.fn().mockResolvedValue({ bsize: 4_096n, bavail: 16_777_216n }),
}));

const directories: string[] = [];
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const physicalIdentity = hash("generation");
const key: RosOutcomeCacheKey = {
  modelVersion: "laces-live-test-v1",
  identity: hash("capacity-key"),
};
const filename = "bf43e053968d5f090e022bef176cc487c6efea3092dc4cb652a56dcb321be067.ros-outcomes";
const expectedReservation = 2 * rosCacheCompressedWriteBudget(24 + 4 * 9) + 192 * 1_024 + 12;
const ensemble = (): RosOutcomeCacheEnsemble => ({
  scenarioCount: 4,
  columns: { receptions: new Float64Array([0, 1.0000000000000002, -0, Number.MIN_VALUE]) },
  games: new Uint8Array([0, 1, 1, 1]),
  metadata: { seed: 1234, strategy: "contextual" },
});
async function fixture() {
  const rootDirectory = await mkdtemp(path.join(os.tmpdir(), "ros-live-capacity-"));
  directories.push(rootDirectory);
  return {
    rootDirectory,
    current: path.join(rootDirectory, "generations", physicalIdentity),
    outcomes: path.join(rootDirectory, "generations", physicalIdentity, "outcomes"),
    prepare: (maximumBytes?: number) =>
      prepareRosLiveOutcomeCache({
        rootDirectory,
        physicalIdentity,
        ...(maximumBytes === undefined ? {} : { maximumBytes }),
      }),
  };
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("exclusive live ROS outcome cache capacity", () => {
  it("delegates byte-identical v1 files, with a pinned canonical filename and exact Float64 round trip", async () => {
    const { prepare, rootDirectory, outcomes } = await fixture();
    const cache = await prepare();
    const original = ensemble();
    expect(await cache.read(key)).toEqual({ state: "missing" });
    await cache.write(key, original);
    expect(await readdir(outcomes)).toEqual([filename]);
    const directDirectory = path.join(rootDirectory, "historical-control");
    await createRosOutcomeCache({ directory: directDirectory }).write(key, original);
    expect(await readFile(path.join(outcomes, filename))).toEqual(
      await readFile(path.join(directDirectory, filename)),
    );
    const read = await cache.read(key, { expectedScenarioCount: 4 });
    expect(read.state).toBe("hit");
    if (read.state !== "hit") throw new Error("Expected hit");
    expect(Buffer.from(read.ensemble.columns.receptions!.buffer)).toEqual(
      Buffer.from(original.columns.receptions!.buffer),
    );
    expect((await cache.write(key, original)).state).toBe("existing");
    expect((await (await prepare()).read(key)).state).toBe("hit");
  });

  it("prunes only obsolete generations and abandoned current partials under the exclusive session", async () => {
    const { prepare, rootDirectory, outcomes, current } = await fixture();
    const cache = await prepare();
    await cache.write(key, ensemble());
    const old = path.join(rootDirectory, "generations", hash("old-generation"));
    await mkdir(path.join(old, "outcomes"), { recursive: true });
    await writeFile(path.join(old, "outcomes", filename), "old cache");
    const oldStore = createRosLiveGenerationStore({ directory: path.join(old, "metadata") });
    await oldStore.getOrCreateGeneration(hash("old-generation"), "2026-09-17T01:00:00.000Z");
    const currentStore = createRosLiveGenerationStore({
      directory: path.join(current, "metadata"),
    });
    await currentStore.getOrCreateGeneration(physicalIdentity, "2026-09-18T01:00:00.000Z");
    const calibration = createRosLiveGenerationStore({
      directory: path.join(rootDirectory, "calibrations"),
    });
    await calibration.writeCalibration(hash("calibration"), { mean: 12 });
    await mkdir(path.join(outcomes, ".ros-outcomes-partial-Abc123"));
    await writeFile(path.join(outcomes, ".ros-outcomes-partial-Abc123", "data.gz"), "partial");
    await writeFile(path.join(rootDirectory, "historical-sentinel"), "preserve");
    const restarted = await prepare();
    expect(await readdir(path.join(rootDirectory, "generations"))).toEqual([physicalIdentity]);
    expect(await readdir(outcomes)).toEqual([filename]);
    expect((await restarted.read(key)).state).toBe("hit");
    expect(
      (await currentStore.getOrCreateGeneration(physicalIdentity, "2026-09-18T02:00:00.000Z"))
        .asOfAt,
    ).toBe("2026-09-18T01:00:00.000Z");
    expect(await calibration.readCalibration(hash("calibration"))).toMatchObject({
      state: "hit",
      value: { mean: 12 },
    });
    expect(await readFile(path.join(rootDirectory, "historical-sentinel"), "utf8")).toBe(
      "preserve",
    );
  });

  it.each(["generation", "metadata", "outcomes", "entry"])(
    "rejects a symlink at %s before pruning anything",
    async (kind) => {
      const { prepare, rootDirectory, current, outcomes } = await fixture();
      await prepare();
      const old = path.join(rootDirectory, "generations", hash("safe-old"));
      await mkdir(old);
      await writeFile(path.join(old, "sentinel"), "old intact");
      const outside = path.join(rootDirectory, "outside");
      await mkdir(outside);
      await writeFile(path.join(outside, "sentinel"), "outside intact");
      const target =
        kind === "generation"
          ? current
          : kind === "entry"
            ? path.join(outcomes, filename)
            : path.join(current, kind);
      await rm(target, { recursive: true, force: true });
      await symlink(outside, target);
      await expect(prepare()).rejects.toMatchObject({ code: "unsafe_entry" });
      expect(await readFile(path.join(old, "sentinel"), "utf8")).toBe("old intact");
      expect(await readFile(path.join(outside, "sentinel"), "utf8")).toBe("outside intact");
    },
  );

  it("rejects FIFO entries without blocking both at inventory and on reads", async () => {
    const { prepare, outcomes } = await fixture();
    const cache = await prepare();
    execFileSync("mkfifo", [path.join(outcomes, filename)]);
    await expect(cache.read(key)).rejects.toMatchObject({ code: "unsafe_entry" });
    await expect(prepare()).rejects.toMatchObject({ code: "unsafe_entry" });
  });

  it("accounts for concurrent temporary copies, then releases the reservation to actual committed bytes", async () => {
    const { prepare, outcomes } = await fixture();
    const maximumBytes = expectedReservation * 2 - 1;
    const cache = await prepare(maximumBytes);
    const next = { ...key, identity: hash("second forecast") };
    const results = await Promise.allSettled([
      cache.write(key, ensemble()),
      cache.write(next, ensemble()),
    ]);
    expect(results[0]?.status).toBe("fulfilled");
    expect(results[1]).toMatchObject({ status: "rejected", reason: { code: "capacity_exceeded" } });
    expect((await cache.write(next, ensemble())).state).toBe("written");
    const files = await readdir(outcomes);
    expect(files).toHaveLength(2);
    const sizes = await Promise.all(
      files.map(async (file) => (await lstat(path.join(outcomes, file))).size),
    );
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBeLessThan(maximumBytes);
  });

  it("includes inventory bytes in later write budgets and fails closed when already over quota", async () => {
    const { prepare, outcomes } = await fixture();
    await (await prepare()).write(key, ensemble());
    const bytes = (await lstat(path.join(outcomes, filename))).size;
    await expect(prepare(bytes - 1)).rejects.toMatchObject({ code: "capacity_exceeded" });
    const next = { ...key, identity: hash("new forecast") };
    const tight = await prepare(bytes + expectedReservation - 1);
    await expect(tight.write(next, ensemble())).rejects.toMatchObject({
      code: "capacity_exceeded",
    });
    expect((await tight.read(key)).state).toBe("hit");
    const exact = await prepare(bytes + expectedReservation);
    expect((await exact.write(next, ensemble())).state).toBe("written");
  });

  it("keeps caller buffer snapshots and immutable conflicts exactly as the base writer", async () => {
    const { prepare } = await fixture();
    const cache = await prepare();
    const original = ensemble();
    const writing = cache.write(key, original);
    original.columns.receptions![0] = 99;
    await writing;
    const read = await cache.read(key);
    if (read.state !== "hit") throw new Error("Expected hit");
    expect(read.ensemble.columns.receptions![0]).toBe(0);
    await expect(cache.write(key, original)).rejects.toMatchObject({ code: "identity_conflict" });
    // An uncertain write fails this session closed; restarting under the exclusive lease safely
    // inventories the immutable winner and restores use without replacing or deleting it.
    await expect(cache.read(key)).rejects.toMatchObject({ code: "identity_conflict" });
    expect((await (await prepare()).read(key)).state).toBe("hit");
  });

  it("honors cancellation and rejects invalid roots, generation identities, limits, or unknown cache files", async () => {
    const { rootDirectory, prepare, outcomes } = await fixture();
    const signal = AbortSignal.abort(new Error("cancelled"));
    await expect(
      prepareRosLiveOutcomeCache({ rootDirectory, physicalIdentity, signal }),
    ).rejects.toThrow("cancelled");
    expect(await readdir(rootDirectory)).toEqual([]);
    for (const options of [
      { rootDirectory: "", physicalIdentity },
      { rootDirectory: "/", physicalIdentity },
      { rootDirectory, physicalIdentity: "../escape" },
      { rootDirectory, physicalIdentity, maximumBytes: 0 },
    ])
      await expect(prepareRosLiveOutcomeCache(options)).rejects.toMatchObject({
        code: "invalid_input",
      });
    const cache = await prepare();
    await expect(cache.write(key, ensemble(), { signal })).rejects.toThrow("cancelled");
    expect(await readdir(outcomes)).toEqual([]);
    await writeFile(path.join(outcomes, "unknown"), "unexpected");
    await expect(prepare()).rejects.toMatchObject({ code: "unsafe_entry" });
  });
});
