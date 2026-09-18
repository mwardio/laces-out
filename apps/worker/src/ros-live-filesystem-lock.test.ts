import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";

import { withRosLiveFilesystemLock } from "./ros-live-filesystem-lock.js";

const directories: string[] = [];
const workers: Worker[] = [];
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ros-live-lock-"));
  directories.push(root);
  return { root, file: path.join(root, ".live-generation.lock") };
}
function otherProcessCanLock(file: string): boolean {
  const result = spawnSync("flock", ["-x", "-n", file, "true"], { timeout: 2_000 });
  if (result.error) throw result.error;
  if (result.status !== 0 && result.status !== 1)
    throw new Error(`Unexpected flock probe status ${String(result.status)}`);
  return result.status === 0;
}
afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.terminate()));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe.skipIf(process.platform !== "linux")("live ROS kernel filesystem lock (Linux)", () => {
  it("keeps the descriptor lock after the flock helper exits, and retains one permanent inode across sessions", async () => {
    const { root, file } = await fixture();
    let inode: number | undefined;
    expect(
      await withRosLiveFilesystemLock(root, async () => {
        inode = (await stat(file)).ino;
        expect((await stat(file)).mode & 0o777).toBe(0o600);
        expect(otherProcessCanLock(file)).toBe(false);
        return "finished";
      }),
    ).toBe("finished");
    expect(otherProcessCanLock(file)).toBe(true);
    await withRosLiveFilesystemLock(root, async () => {
      expect((await stat(file)).ino).toBe(inode);
      expect(otherProcessCanLock(file)).toBe(false);
    });
    expect(await readdir(root)).toEqual([".live-generation.lock"]);
  });

  it("serializes independent open descriptions until the first callback settles", async () => {
    const { root, file } = await fixture();
    let begin!: () => void;
    let release!: () => void;
    const began = new Promise<void>((resolve) => {
      begin = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const events: string[] = [];
    const first = withRosLiveFilesystemLock(root, async () => {
      events.push("first-start");
      begin();
      await hold;
      events.push("first-end");
    });
    await began;
    const second = withRosLiveFilesystemLock(
      root,
      async () => {
        events.push("second-start");
        expect(otherProcessCanLock(file)).toBe(false);
      },
      { pollMs: 5, maximumWaitMs: 2_000 },
    );
    await delay(25);
    expect(events).toEqual(["first-start"]);
    release();
    await Promise.all([first, second]);
    expect(events).toEqual(["first-start", "first-end", "second-start"]);
    expect(otherProcessCanLock(file)).toBe(true);
  });

  it("releases on callback failure, rejects timed out/aborted waiters, and never unlocks another holder", async () => {
    const { root, file } = await fixture();
    await expect(
      withRosLiveFilesystemLock(root, async () => {
        throw new Error("build failed");
      }),
    ).rejects.toThrow("build failed");
    expect(otherProcessCanLock(file)).toBe(true);
    const run = vi.fn(async () => {});
    await withRosLiveFilesystemLock(root, async () => {
      await expect(
        withRosLiveFilesystemLock(root, run, { pollMs: 5, maximumWaitMs: 20 }),
      ).rejects.toMatchObject({ code: "wait_timeout" });
      const controller = new AbortController();
      const waiting = withRosLiveFilesystemLock(root, run, {
        signal: controller.signal,
        pollMs: 5,
      });
      const rejection = expect(waiting).rejects.toThrow("cancel wait");
      controller.abort(new Error("cancel wait"));
      await rejection;
      expect(run).not.toHaveBeenCalled();
      expect(otherProcessCanLock(file)).toBe(false);
    });
    expect(otherProcessCanLock(file)).toBe(true);
  });

  it("retains the lock through an aborted callback's asynchronous cleanup", async () => {
    const { root, file } = await fixture();
    const controller = new AbortController();
    await expect(
      withRosLiveFilesystemLock(
        root,
        async () => {
          controller.abort(new Error("stopping"));
          await delay(20);
          expect(otherProcessCanLock(file)).toBe(false);
        },
        { signal: controller.signal },
      ),
    ).rejects.toThrow("stopping");
    expect(otherProcessCanLock(file)).toBe(true);
  });

  it("releases the tracked open descriptor when its owning Node worker is terminated", async () => {
    const { root, file } = await fixture();
    const source = await readFile(
      new URL("./ros-live-filesystem-lock.ts", import.meta.url),
      "utf8",
    );
    const module = path.join(root, "lock-under-test.mjs");
    await writeFile(
      module,
      transpileModule(source, {
        compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
      }).outputText,
    );
    const worker = new Worker(
      `
      const { parentPort, workerData } = require("node:worker_threads");
      import(workerData.module).then(({ withRosLiveFilesystemLock }) =>
        withRosLiveFilesystemLock(workerData.root, async () => {
          parentPort.postMessage("locked");
          await new Promise(() => setInterval(() => {}, 1000));
        })
      ).catch(error => { throw error; });
    `,
      {
        eval: true,
        workerData: { module: pathToFileURL(module).href, root },
        resourceLimits: { maxOldGenerationSizeMb: 64 },
      },
    );
    workers.push(worker);
    await new Promise<void>((resolve, reject) => {
      worker.once("message", (message: unknown) =>
        message === "locked" ? resolve() : reject(new Error("Unexpected worker message")),
      );
      worker.once("error", reject);
      worker.once("exit", () => reject(new Error("Worker exited before acquisition")));
    });
    expect(otherProcessCanLock(file)).toBe(false);
    await worker.terminate();
    expect(otherProcessCanLock(file)).toBe(true);
    expect((await stat(file)).isFile()).toBe(true);
  });

  it.each(["symlink", "fifo", "contents"])(
    "fails closed on a %s lock path without modifying its target",
    async (kind) => {
      const { root, file } = await fixture();
      const outside = path.join(root, "outside");
      await writeFile(outside, "preserve");
      if (kind === "symlink") await symlink(outside, file);
      else if (kind === "fifo") execFileSync("mkfifo", [file]);
      else await writeFile(file, "unexpected");
      await expect(withRosLiveFilesystemLock(root, async () => {})).rejects.toMatchObject({
        code: "unsafe_path",
      });
      expect(await readFile(outside, "utf8")).toBe("preserve");
    },
  );

  it("rejects invalid configuration or already cancelled calls before creating a lock", async () => {
    const { root } = await fixture();
    for (const options of [{ pollMs: 0 }, { maximumWaitMs: 0 }]) {
      await expect(withRosLiveFilesystemLock(root, async () => {}, options)).rejects.toMatchObject({
        code: "invalid_input",
      });
    }
    await expect(withRosLiveFilesystemLock("/", async () => {})).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(
      withRosLiveFilesystemLock(root, async () => {}, {
        signal: AbortSignal.abort(new Error("cancelled")),
      }),
    ).rejects.toThrow("cancelled");
    expect(await readdir(root)).toEqual([]);
  });
});
