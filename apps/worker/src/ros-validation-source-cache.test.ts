import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { rosValidationSourceCache } from "./ros-validation-source-cache.js";

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
