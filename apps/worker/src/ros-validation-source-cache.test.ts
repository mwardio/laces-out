import { createHash } from "node:crypto";
import type * as FileSystemPromises from "node:fs/promises";
import { mkdtemp, readFile, readdir, rm, statfs, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { rosValidationSourceCache } from "./ros-validation-source-cache.js";

import { ROS_CACHE_MINIMUM_FREE_BYTES } from "./ros-cache-disk-space.js";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof FileSystemPromises>()),
  statfs: vi.fn(),
}));
beforeEach(() => {
  vi.mocked(statfs)
    .mockReset()
    .mockResolvedValue({ bavail: 100n * 1_024n ** 3n, bsize: 1n } as Awaited<
      ReturnType<typeof statfs>
    >);
});
const directories: string[] = [];
async function directory() {
  const value = await mkdtemp(path.join(os.tmpdir(), "ros-source-cache-"));
  directories.push(value);
  return value;
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((value) => rm(value, { recursive: true, force: true })),
  );
});

describe("frozen ROS validation inputs", () => {
  it("replays a redirect and exact binary response without contacting the network", async () => {
    const dir = await directory();
    const source = "https://github.com/nflverse/example";
    const target = "https://release-assets.githubusercontent.com/example?signature=expired";
    const bytes = new Uint8Array([0, 31, 139, 255, 32]);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: target } }))
      .mockResolvedValueOnce(new Response(bytes, { headers: { etag: '"pinned"' } }));
    const record = rosValidationSourceCache({ directory: dir, offline: false, fetch });
    await record(source);
    await record(target);
    const network = vi.fn().mockRejectedValue(new Error("Network must not be used"));
    const replay = rosValidationSourceCache({ directory: dir, offline: true, fetch: network });
    const redirect = await replay(source);
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe(target);
    const result = await replay(target);
    expect(new Uint8Array(await result.arrayBuffer())).toEqual(bytes);
    expect(result.headers.get("etag")).toBe('"pinned"');
    expect(network).not.toHaveBeenCalled();
  });

  it("fails closed on offline cache misses and corrupted bodies", async () => {
    const dir = await directory();
    const url = "https://github.com/nflverse/example";
    const network = vi.fn().mockResolvedValue(new Response("original"));
    const replay = rosValidationSourceCache({ directory: dir, offline: true, fetch: network });
    await expect(replay(url)).rejects.toThrow("Offline ROS source cache miss");
    expect(network).not.toHaveBeenCalled();
    await rosValidationSourceCache({ directory: dir, offline: false, fetch: network })(url);
    const body = (await readdir(dir)).find((file) => file.endsWith(".body"))!;
    await writeFile(path.join(dir, body), "modified");
    await expect(replay(url)).rejects.toThrow("Corrupt ROS source cache");
    expect(network).toHaveBeenCalledTimes(1);
  });

  it("does not preserve an upstream failure as an offline input", async () => {
    const dir = await directory();
    const url = "https://github.com/nflverse/example";
    const fetch = vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 }));
    const result = await rosValidationSourceCache({ directory: dir, offline: false, fetch })(url);
    expect(result.status).toBe(503);
    expect(await readdir(dir)).toEqual([]);
  });
});

describe("bounded bootstrap source cache", () => {
  it("preserves exact redirects and bodies offline without writes or disk-space requirements", async () => {
    const dir = await directory();
    const source = "https://example.test/source";
    const target = "https://example.test/signed?token=expired";
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: target } }))
      .mockResolvedValueOnce(new Response("fixed bytes", { headers: { etag: '"source-v1"' } }));
    const options = { directory: dir, maxBytes: 8_192, maxResponseBytes: 128 };
    const cache = rosValidationSourceCache({ ...options, offline: false, fetch });
    await cache(source);
    await cache(target);
    const files = await readdir(dir);
    const before = await Promise.all(
      files.map(async (file) => [file, await readFile(path.join(dir, file), "utf8")]),
    );
    vi.mocked(statfs).mockResolvedValue({ bavail: 0n, bsize: 1n } as Awaited<
      ReturnType<typeof statfs>
    >);
    const replay = rosValidationSourceCache({ ...options, offline: true, fetch });
    expect((await replay(source)).headers.get("location")).toBe(target);
    expect(await (await replay(target)).text()).toBe("fixed bytes");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(
      await Promise.all(
        files.map(async (file) => [file, await readFile(path.join(dir, file), "utf8")]),
      ),
    ).toEqual(before);
  });

  it.each([true, false])(
    "cancels an oversized response with content length=%s and writes nothing",
    async (declared) => {
      const dir = await directory();
      const cancel = vi.fn();
      let count = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          count++;
          controller.enqueue(new Uint8Array(40));
        },
        cancel,
      });
      const response = new Response(stream, {
        headers: declared ? { "content-length": "120" } : {},
      });
      const cache = rosValidationSourceCache({
        directory: dir,
        offline: false,
        maxBytes: 8_192,
        maxResponseBytes: 64,
        fetch: vi.fn().mockResolvedValue(response),
      });
      await expect(cache("https://example.test/oversized")).rejects.toThrow("response byte limit");
      expect(cancel).toHaveBeenCalledOnce();
      expect(count).toBeLessThanOrEqual(3);
      expect(await readdir(dir)).toEqual([]);
    },
  );

  it("bounds failed response bodies too without pinning small transient errors", async () => {
    const dir = await directory();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response("x".repeat(65), { status: 503 }));
    const cache = rosValidationSourceCache({
      directory: dir,
      offline: false,
      maxBytes: 8_192,
      maxResponseBytes: 64,
      fetch,
    });
    expect((await cache("https://example.test/failure")).status).toBe(503);
    await expect(cache("https://example.test/failure")).rejects.toThrow("response byte limit");
    expect(await readdir(dir)).toEqual([]);
  });

  it("serializes concurrent captures so combined writes cannot exceed the snapshot quota", async () => {
    const dir = await directory();
    const fetch = vi
      .fn()
      .mockImplementation(
        async (input) =>
          new Response(String(input).endsWith("a") ? "a".repeat(1_000) : "b".repeat(1_000)),
      );
    const cache = rosValidationSourceCache({
      directory: dir,
      offline: false,
      maxBytes: 6_000,
      fetch,
    });
    const results = await Promise.allSettled([
      cache("https://example.test/a"),
      cache("https://example.test/b"),
    ]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(await readdir(dir)).toHaveLength(2);
    const rejection = results[1];
    expect(rejection.status === "rejected" && String(rejection.reason)).toContain(
      "byte or file limit",
    );
  });

  it("deduplicates identical response bodies inside the bounded capture", async () => {
    const dir = await directory();
    const cache = rosValidationSourceCache({
      directory: dir,
      offline: false,
      maxBytes: 6_000,
      fetch: vi.fn().mockImplementation(async () => new Response("same".repeat(250))),
    });
    await cache("https://example.test/a");
    await cache("https://example.test/b");
    expect((await readdir(dir)).filter((file) => file.endsWith(".body"))).toHaveLength(1);
    expect((await readdir(dir)).filter((file) => file.endsWith(".json"))).toHaveLength(2);
  });

  it("rejects an oversized cached body, corruption, and symlinks before replay", async () => {
    const dir = await directory();
    const url = "https://example.test/a";
    await rosValidationSourceCache({
      directory: dir,
      offline: false,
      fetch: vi.fn().mockResolvedValue(new Response("x".repeat(65))),
    })(url);
    const replay = rosValidationSourceCache({
      directory: dir,
      offline: true,
      maxBytes: 8_192,
      maxResponseBytes: 64,
    });
    await expect(replay(url)).rejects.toThrow("read limit");
    const body = (await readdir(dir)).find((file) => file.endsWith(".body"))!;
    await writeFile(path.join(dir, body), "short but corrupt");
    await expect(replay(url)).rejects.toThrow("Corrupt ROS source cache");
    await symlink(path.join(dir, body), path.join(dir, "link.body"));
    await expect(replay(url)).rejects.toThrow("Invalid bounded ROS source cache file");
  });

  it("counts interrupted partial files against the budget without deleting them", async () => {
    const dir = await directory();
    const partial = `${createHash("sha256").update("interrupted").digest("hex")}.body.partial`;
    await writeFile(path.join(dir, partial), "x".repeat(2_000));
    const cache = rosValidationSourceCache({
      directory: dir,
      offline: false,
      maxBytes: 6_000,
      fetch: vi.fn().mockResolvedValue(new Response("a")),
    });
    await expect(cache("https://example.test/a")).rejects.toThrow("byte or file limit");
    expect(await readFile(path.join(dir, partial), "utf8")).toHaveLength(2_000);
    expect(await readdir(dir)).toEqual([partial]);
  });

  it("preserves the 5 GiB filesystem reserve before any capture write", async () => {
    const dir = await directory();
    vi.mocked(statfs).mockResolvedValue({
      bavail: ROS_CACHE_MINIMUM_FREE_BYTES,
      bsize: 1n,
    } as Awaited<ReturnType<typeof statfs>>);
    const cache = rosValidationSourceCache({
      directory: dir,
      offline: false,
      maxBytes: 8_192,
      fetch: vi.fn().mockResolvedValue(new Response("a")),
    });
    await expect(cache("https://example.test/a")).rejects.toMatchObject({
      code: "insufficient_disk_space",
    });
    expect(await readdir(dir)).toEqual([]);
  });

  it("leaves default legacy capture behavior unbounded and independent of disk probes", async () => {
    const dir = await directory();
    vi.mocked(statfs).mockRejectedValue(new Error("must not inspect default cache disk"));
    const result = await rosValidationSourceCache({
      directory: dir,
      offline: false,
      fetch: vi.fn().mockResolvedValue(new Response("legacy pinned source")),
    })("https://example.test/legacy");
    expect(await result.text()).toBe("legacy pinned source");
    expect(statfs).not.toHaveBeenCalled();
  });
});
