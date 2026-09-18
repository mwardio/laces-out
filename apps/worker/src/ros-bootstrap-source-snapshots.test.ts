import { randomUUID } from "node:crypto";
import type * as FileSystemPromises from "node:fs/promises";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  statfs,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ROS_CACHE_MINIMUM_FREE_BYTES } from "./ros-cache-disk-space.js";
import {
  RosBootstrapSourceSnapshots,
  ROS_BOOTSTRAP_SOURCE_SNAPSHOT_OWNER_FILE,
} from "./ros-bootstrap-source-snapshots.js";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof FileSystemPromises>()),
  statfs: vi.fn(),
}));
const directories: string[] = [];
const requestIdentity = "a".repeat(64);
const cacheFile = `${"b".repeat(64)}.body`;
beforeEach(() => {
  vi.mocked(statfs)
    .mockReset()
    .mockResolvedValue({ bavail: 100n * 1_024n ** 3n, bsize: 1n } as Awaited<
      ReturnType<typeof statfs>
    >);
});
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function fixture(maxNamespaceBytes = 16_384) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ros-bootstrap-sources-"));
  directories.push(root);
  const store = new RosBootstrapSourceSnapshots({
    sourceRoot: root,
    maxSnapshotBytes: 8_192,
    maxNamespaceBytes,
  });
  const prepare = (snapshotId: string = randomUUID(), protectedSnapshotIds: string[] = []) =>
    store.prepare({ requestIdentity, snapshotId, protectedSnapshotIds, allowCreate: true });
  return { root, store, prepare };
}

describe("owned ROS bootstrap source captures", () => {
  it("resumes the exact capturing snapshot, freezes qualified state and refuses missing qualified data", async () => {
    const { store, prepare } = await fixture();
    const capture = await prepare();
    await writeFile(path.join(capture.directory, cacheFile), "pinned football source");
    expect(await prepare(capture.snapshotId)).toEqual(capture);
    const qualified = await store.markQualified(requestIdentity, capture.snapshotId);
    expect(qualified).toMatchObject({
      ...capture,
      state: "qualified",
      qualifiedAt: qualified.qualifiedAt,
    });
    expect(qualified.qualifiedAt).toBeTypeOf("string");
    expect(await prepare(capture.snapshotId)).toEqual(qualified);
    expect(await store.getPath(requestIdentity, capture.snapshotId)).toBe(capture.directory);
    await expect(store.markUnqualified(requestIdentity, capture.snapshotId)).rejects.toMatchObject({
      code: "source_snapshot_integrity",
    });
    await expect(
      store.prepare({
        requestIdentity,
        snapshotId: randomUUID(),
        allowCreate: false,
        protectedSnapshotIds: [],
      }),
    ).rejects.toMatchObject({ code: "source_snapshot_integrity" });
  });

  it("creates different retry namespaces, retaining unqualified diagnostics while capacity permits", async () => {
    const { store, prepare } = await fixture();
    const first = await prepare();
    await writeFile(path.join(first.directory, cacheFile), "old source");
    await store.markUnqualified(requestIdentity, first.snapshotId);
    const second = await prepare();
    expect(second.snapshotId).not.toBe(first.snapshotId);
    expect(await readdir(first.directory)).toContain(cacheFile);
    expect(await readdir(second.directory)).toEqual([ROS_BOOTSTRAP_SOURCE_SNAPSHOT_OWNER_FILE]);
    expect((await prepare(first.snapshotId)).state).toBe("unqualified");
  });

  it("reclaims only owned unused unqualified captures and never touches legacy or frozen files", async () => {
    const { root, store, prepare } = await fixture(12_000);
    await writeFile(path.join(root, "frozen-source.body"), "unchanged");
    const old = await prepare();
    await writeFile(path.join(old.directory, cacheFile), "x".repeat(5_000));
    await store.markUnqualified(requestIdentity, old.snapshotId);
    const next = await prepare();
    await expect(readdir(old.directory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(next.directory)).toEqual([ROS_BOOTSTRAP_SOURCE_SNAPSHOT_OWNER_FILE]);
    expect(await readFile(path.join(root, "frozen-source.body"), "utf8")).toBe("unchanged");
  });

  it.each(["capturing", "qualified", "protected-unqualified"] as const)(
    "never reclaims %s data when bounded capacity is exhausted",
    async (state) => {
      const { store, prepare } = await fixture(12_000);
      const capture = await prepare();
      await writeFile(path.join(capture.directory, cacheFile), "x".repeat(5_000));
      if (state === "qualified") await store.markQualified(requestIdentity, capture.snapshotId);
      if (state === "protected-unqualified")
        await store.markUnqualified(requestIdentity, capture.snapshotId);
      await expect(
        prepare(randomUUID(), state === "protected-unqualified" ? [capture.snapshotId] : []),
      ).rejects.toMatchObject({ code: "source_snapshot_capacity" });
      expect(await readFile(path.join(capture.directory, cacheFile), "utf8")).toHaveLength(5_000);
    },
  );

  it("reclaims older diagnostics before the most recent capture", async () => {
    const { store, prepare } = await fixture(19_000);
    const older = await prepare();
    await writeFile(path.join(older.directory, cacheFile), "x".repeat(5_000));
    await store.markUnqualified(requestIdentity, older.snapshotId);
    const recent = await prepare();
    await writeFile(path.join(recent.directory, cacheFile), "x".repeat(6_000));
    await store.markUnqualified(requestIdentity, recent.snapshotId);
    const fresh = await prepare();
    await expect(readdir(older.directory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(recent.directory)).toContain(cacheFile);
    expect(fresh.state).toBe("capturing");
  });

  it.each(["unknown", "symlink", "hardlink", "nested", "forged-owner"])(
    "preserves %s files and fails closed without deleting diagnostic data",
    async (kind) => {
      const { root, store, prepare } = await fixture(12_000);
      const capture = await prepare();
      await writeFile(path.join(capture.directory, cacheFile), "x".repeat(5_000));
      await store.markUnqualified(requestIdentity, capture.snapshotId);
      const external = path.join(root, "outside");
      await writeFile(external, "do not change");
      if (kind === "unknown")
        await writeFile(path.join(capture.directory, "unknown.txt"), "preserve");
      if (kind === "symlink")
        await symlink(external, path.join(capture.directory, `${"c".repeat(64)}.body`));
      if (kind === "hardlink")
        await link(external, path.join(capture.directory, `${"c".repeat(64)}.body`));
      if (kind === "nested") await mkdir(path.join(capture.directory, `${"c".repeat(64)}.body`));
      if (kind === "forged-owner") {
        const file = path.join(capture.directory, ROS_BOOTSTRAP_SOURCE_SNAPSHOT_OWNER_FILE);
        const owner = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
        await writeFile(file, JSON.stringify({ ...owner, requestIdentity: "d".repeat(64) }));
      }
      await expect(prepare()).rejects.toMatchObject({ code: "source_snapshot_integrity" });
      expect(await readFile(path.join(capture.directory, cacheFile), "utf8")).toHaveLength(5_000);
      expect(await readFile(external, "utf8")).toBe("do not change");
    },
  );

  it("does not follow namespace symlinks or accept path traversal identifiers", async () => {
    const { root, store, prepare } = await fixture();
    const outside = await mkdtemp(path.join(os.tmpdir(), "ros-outside-sources-"));
    directories.push(outside);
    await symlink(outside, path.join(root, "bootstrap-snapshots-v1"));
    await expect(prepare()).rejects.toMatchObject({ code: "source_snapshot_integrity" });
    expect(await readdir(outside)).toEqual([]);
    await expect(store.getPath("../outside", randomUUID())).rejects.toMatchObject({
      code: "source_snapshot_integrity",
    });
  });

  it("enforces the existing 5 GiB disk reserve while qualified offline sources remain readable", async () => {
    const { store, prepare } = await fixture();
    const capture = await prepare();
    await store.markQualified(requestIdentity, capture.snapshotId);
    vi.mocked(statfs).mockResolvedValue({
      bavail: ROS_CACHE_MINIMUM_FREE_BYTES - 1n,
      bsize: 1n,
    } as Awaited<ReturnType<typeof statfs>>);
    expect((await prepare(capture.snapshotId)).state).toBe("qualified");
    await expect(prepare()).rejects.toMatchObject({ code: "source_snapshot_capacity" });
  });
});
