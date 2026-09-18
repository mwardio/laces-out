import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import type * as FileSystemPromises from "node:fs/promises";
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { assertRosCacheHeadroom } from "./ros-cache-disk-space.js";
import {
  createRosLiveGenerationStore,
  ROS_LIVE_GENERATION_STORE_VERSION,
} from "./ros-live-generation-store.js";

vi.mock("./ros-cache-disk-space.js", () => ({ assertRosCacheHeadroom: vi.fn(async () => {}) }));
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof FileSystemPromises>()),
  link: vi.fn((await original<typeof FileSystemPromises>()).link),
}));
const directories: string[] = [];
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const identity = digest("public football generation");
const cutoff = "2026-09-18T03:00:00.000Z";
beforeEach(() => {
  vi.mocked(assertRosCacheHeadroom).mockReset().mockResolvedValue();
});
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ros-live-generation-"));
  directories.push(directory);
  return {
    directory,
    store: createRosLiveGenerationStore({ directory }),
    file: (kind: string, key = identity) =>
      path.join(directory, ROS_LIVE_GENERATION_STORE_VERSION, kind, `${key}.json`),
  };
}

describe("durable ROS live generation store", () => {
  it("pins the original cutoff across restarts and retains older physical generations", async () => {
    const { directory, store } = await fixture();
    expect(await store.getOrCreateGeneration(identity, cutoff)).toEqual({
      physicalIdentity: identity,
      asOfAt: cutoff,
    });
    const restarted = createRosLiveGenerationStore({ directory });
    const later = "2026-09-18T05:00:00.000Z";
    expect(await restarted.getOrCreateGeneration(identity, later)).toEqual({
      physicalIdentity: identity,
      asOfAt: cutoff,
    });
    expect((await restarted.getOrCreateGeneration(digest("changed football"), later)).asOfAt).toBe(
      later,
    );
    expect((await restarted.getOrCreateGeneration(identity, later)).asOfAt).toBe(cutoff);
  });

  it("has one atomic first writer across concurrent independent store instances", async () => {
    const { directory } = await fixture();
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        createRosLiveGenerationStore({ directory }).getOrCreateGeneration(identity, cutoff),
      ),
    );
    expect(new Set(results.map((result) => result.asOfAt)).size).toBe(1);
    const files = await readdir(
      path.join(directory, ROS_LIVE_GENERATION_STORE_VERSION, "generation"),
    );
    expect(files).toEqual([`${identity}.json`]);
  });

  it("rejects an existing future cutoff when the caller's clock or requested history moves backwards", async () => {
    const { store, file } = await fixture();
    await store.getOrCreateGeneration(identity, cutoff);
    const original = await readFile(file("generation"));
    await expect(
      store.getOrCreateGeneration(identity, "2026-09-18T02:59:59.999Z"),
    ).rejects.toMatchObject({ code: "identity_conflict" });
    expect(await readFile(file("generation"))).toEqual(original);
  });

  it("round-trips calibration and canonical templates exactly, independently of key order and namespace kind", async () => {
    const { directory, store, file } = await fixture();
    const value = {
      intervals: {
        QB: { yards: { lower: -0, upper: 1.0000000000000002, tiny: Number.MIN_VALUE } },
      },
      count: 12,
    };
    const result = await store.writeCalibration(identity, value);
    expect(result.state).toBe("written");
    expect(
      await store.writeCalibration(identity, { count: 12, intervals: value.intervals }),
    ).toEqual({ state: "existing", checksum: result.checksum });
    const restarted = createRosLiveGenerationStore({ directory });
    const read = await restarted.readCalibration(identity);
    expect(read).toEqual({ state: "hit", value, checksum: result.checksum });
    if (read.state !== "hit") throw new Error("Expected hit");
    expect(Object.is((read.value as typeof value).intervals.QB.yards.lower, -0)).toBe(true);
    const targets = [{ playerId: "00-0036825", meanPoints: 0, conditions: [true, null] }];
    await store.writeTargets(identity, targets);
    expect(await restarted.readTargets(identity)).toMatchObject({ state: "hit", value: targets });
    expect((await stat(file("calibration"))).mode & 0o777).toBe(0o600);
    expect(await restarted.readCalibration(digest("absent"))).toEqual({ state: "missing" });
  });

  it("snapshots caller-owned objects before asynchronous I/O", async () => {
    const { store } = await fixture();
    const value = { nested: { mean: 42 } };
    const pending = store.writeCalibration(identity, value);
    value.nested.mean = 999;
    await pending;
    expect(await store.readCalibration(identity)).toMatchObject({
      state: "hit",
      value: { nested: { mean: 42 } },
    });
  });

  it("rejects conflicting immutable data without replacing the original", async () => {
    const { store } = await fixture();
    const results = await Promise.allSettled([
      store.writeTargets(identity, { mean: 1 }),
      store.writeTargets(identity, { mean: 2 }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ reason: { code: "identity_conflict" } });
    const read = await store.readTargets(identity);
    expect(read.state).toBe("hit");
    await expect(store.writeTargets(identity, { mean: 3 })).rejects.toMatchObject({
      code: "identity_conflict",
    });
    expect(await store.readTargets(identity)).toEqual(read);
  });

  it("rejects truncation, tampering, appended data, wrong identity, and malformed envelopes without overwriting", async () => {
    const { store, file } = await fixture();
    await store.writeCalibration(identity, { mean: 42 });
    const original = await readFile(file("calibration"), "utf8");
    for (const broken of [
      original.slice(0, -1),
      original.replace('"mean":42', '"mean":43'),
      `${original}\n`,
      original.replace(identity, digest("other")),
      "{}",
      "not-json",
    ]) {
      await writeFile(file("calibration"), broken);
      await expect(store.readCalibration(identity)).rejects.toMatchObject({
        code: "corrupt_entry",
      });
      await expect(store.writeCalibration(identity, { mean: 42 })).rejects.toMatchObject({
        code: "corrupt_entry",
      });
      expect(await readFile(file("calibration"), "utf8")).toBe(broken);
    }
  });

  it("fails closed on semantically malformed but checksummed generation pins", async () => {
    const { store, file } = await fixture();
    await store.getOrCreateGeneration(identity, cutoff);
    const entry = `{"identity":"${identity}","kind":"generation","namespace":"${ROS_LIVE_GENERATION_STORE_VERSION}","payload":{"asOfAt":"tomorrow"}}`;
    await writeFile(file("generation"), `{"checksum":"${digest(entry)}","entry":${entry}}`);
    await expect(store.getOrCreateGeneration(identity, cutoff)).rejects.toMatchObject({
      code: "corrupt_entry",
    });
  });

  it("rejects symlink entries, symlink directories, and FIFO entries without following or blocking", async () => {
    const { store, file, directory } = await fixture();
    await store.writeTargets(identity, null);
    const destination = path.join(directory, "outside.json");
    await writeFile(destination, "outside");
    await rm(file("targets"));
    await symlink(destination, file("targets"));
    await expect(store.readTargets(identity)).rejects.toMatchObject({ code: "corrupt_entry" });
    await expect(store.writeTargets(identity, null)).rejects.toMatchObject({
      code: "corrupt_entry",
    });
    expect(await readFile(destination, "utf8")).toBe("outside");
    await rm(file("targets"));
    execFileSync("mkfifo", [file("targets")]);
    await expect(store.readTargets(identity)).rejects.toMatchObject({ code: "corrupt_entry" });
    await rm(path.join(directory, ROS_LIVE_GENERATION_STORE_VERSION, "targets"), {
      recursive: true,
    });
    await symlink(directory, path.join(directory, ROS_LIVE_GENERATION_STORE_VERSION, "targets"));
    await expect(store.readTargets(identity)).rejects.toMatchObject({ code: "unsafe_directory" });
  });

  it("bounds input and disk reads before large allocation, retaining already committed values under low space", async () => {
    const { directory, store, file } = await fixture();
    await store.writeCalibration(identity, { mean: 1 });
    vi.mocked(assertRosCacheHeadroom).mockRejectedValue(new Error("disk reserve"));
    expect((await store.writeCalibration(identity, { mean: 1 })).state).toBe("existing");
    await expect(store.writeCalibration(digest("new"), { mean: 1 })).rejects.toThrow(
      "disk reserve",
    );
    expect(await store.readCalibration(identity)).toMatchObject({ state: "hit" });
    const bounded = createRosLiveGenerationStore({
      directory,
      limits: {
        maximumCalibrationBytes: 32,
        maximumTargetsBytes: 64,
        maximumNodes: 20,
        maximumDepth: 4,
      },
    });
    await expect(bounded.writeCalibration(identity, "x".repeat(33))).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(bounded.writeTargets(identity, Array(21).fill(0))).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(bounded.writeTargets(identity, [[[[[0]]]]])).rejects.toMatchObject({
      code: "invalid_input",
    });
    await writeFile(file("calibration"), "x".repeat(1_057));
    await expect(bounded.readCalibration(identity)).rejects.toMatchObject({
      code: "corrupt_entry",
    });
  });

  it("rejects non-JSON values without calling accessors or toJSON", async () => {
    const { store } = await fixture();
    const accessor = vi.fn(() => 1);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const custom = { toJSON: vi.fn(() => ({})) };
    for (const value of [
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      1n,
      new Date(),
      new Map(),
      new Float64Array(1),
      { value: undefined },
      Array(2),
      {
        get value() {
          return accessor();
        },
      },
      custom,
      cycle,
    ]) {
      await expect(store.writeCalibration(identity, value)).rejects.toMatchObject({
        code: "invalid_input",
      });
    }
    expect(accessor).not.toHaveBeenCalled();
    expect(custom.toJSON).not.toHaveBeenCalled();
    await expect(store.readTargets("../escape")).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      store.getOrCreateGeneration(identity, "2026-09-18T03:00:00Z"),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("cleans unpublished temporary files after a link failure and honors cancellation", async () => {
    const { store, directory } = await fixture();
    const fs = await import("node:fs/promises");
    vi.mocked(fs.link).mockRejectedValueOnce(new Error("injected link failure"));
    await expect(store.writeTargets(identity, { value: 1 })).rejects.toThrow(
      "injected link failure",
    );
    expect(
      await readdir(path.join(directory, ROS_LIVE_GENERATION_STORE_VERSION, "targets")),
    ).toEqual([]);
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      store.writeCalibration(identity, {}, { signal: controller.signal }),
    ).rejects.toThrow("cancelled");
    await expect(store.readTargets(identity, { signal: controller.signal })).rejects.toThrow(
      "cancelled",
    );
  });
});
