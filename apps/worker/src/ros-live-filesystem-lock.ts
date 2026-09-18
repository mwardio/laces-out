import { spawn } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const LOCK_NAME = ".live-generation.lock";
const MAXIMUM_WAIT_MS = 8 * 60 * 60 * 1_000;

export class RosLiveFilesystemLockError extends Error {
  constructor(
    readonly code:
      "invalid_input" | "unsafe_path" | "unavailable" | "operation_failed" | "wait_timeout",
  ) {
    super(`ROS live filesystem lock ${code}`);
    this.name = "RosLiveFilesystemLockError";
  }
}

function acquireDescriptorLock(
  descriptor: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  return new Promise<boolean>((resolve, reject) => {
    // Short options work in both util-linux and the production image's BusyBox flock.
    // FD 3 duplicates the parent's open-file description: the kernel lock therefore survives
    // this helper's exit until the owner closes its descriptor (or its worker/process exits).
    const child = spawn("flock", ["-x", "-n", "3"], {
      stdio: ["ignore", "ignore", "ignore", descriptor],
    });
    let stopped = false;
    let timedOut = false;
    const abort = () => child.kill("SIGKILL");
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const cleanup = () => {
      stopped = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.once("error", (error) => {
      if (stopped) return;
      cleanup();
      reject(
        new RosLiveFilesystemLockError(
          (error as NodeJS.ErrnoException).code === "ENOENT" ? "unavailable" : "operation_failed",
        ),
      );
    });
    child.once("close", (code) => {
      if (stopped) return;
      cleanup();
      if (signal?.aborted) {
        const reason: unknown = signal.reason;
        reject(reason instanceof Error ? reason : new Error("ROS live filesystem lock aborted"));
      } else if (timedOut) {
        reject(new RosLiveFilesystemLockError("wait_timeout"));
      } else if (code === 0 || code === 1) {
        resolve(code === 0);
      } else {
        reject(new RosLiveFilesystemLockError("operation_failed"));
      }
    });
  });
}

/**
 * Linux live-cache exclusion, held inside the artifact worker for its complete cache lifetime.
 * PostgreSQL cancellation still stops obsolete work, but losing that remote session cannot free
 * this local filesystem lock before the old worker stops using the shared volume.
 *
 * The inode is permanent: NEVER unlink it, including during pruning. openSync descriptors are
 * tracked by Node workers (trackUnmanagedFds defaults to true) and closed on worker.terminate().
 * Callers must await every cache operation before their callback settles. Aborting a callback
 * does not release the descriptor until that callback actually settles.
 */
export async function withRosLiveFilesystemLock<T>(
  rootDirectory: string,
  run: () => Promise<T>,
  options: {
    readonly signal?: AbortSignal;
    readonly maximumWaitMs?: number;
    readonly pollMs?: number;
  } = {},
): Promise<T> {
  const maximumWaitMs = options.maximumWaitMs ?? MAXIMUM_WAIT_MS;
  const pollMs = options.pollMs ?? 1_000;
  if (
    typeof rootDirectory !== "string" ||
    !rootDirectory.trim() ||
    !Number.isSafeInteger(maximumWaitMs) ||
    maximumWaitMs < 1 ||
    maximumWaitMs > MAXIMUM_WAIT_MS ||
    !Number.isSafeInteger(pollMs) ||
    pollMs < 1 ||
    pollMs > 60_000
  )
    throw new RosLiveFilesystemLockError("invalid_input");
  options.signal?.throwIfAborted();
  const root = path.resolve(rootDirectory);
  if (root === path.parse(root).root) throw new RosLiveFilesystemLockError("invalid_input");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw new RosLiveFilesystemLockError("unsafe_path");
  let descriptor: number;
  try {
    descriptor = openSync(
      path.join(root, LOCK_NAME),
      constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0o600,
    );
  } catch (error) {
    if (["ELOOP", "EISDIR", "ENXIO"].includes((error as NodeJS.ErrnoException).code ?? ""))
      throw new RosLiveFilesystemLockError("unsafe_path");
    throw error;
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size !== 0 || stat.nlink !== 1)
      throw new RosLiveFilesystemLockError("unsafe_path");
    const deadline = performance.now() + maximumWaitMs;
    for (;;) {
      options.signal?.throwIfAborted();
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new RosLiveFilesystemLockError("wait_timeout");
      const acquired = await acquireDescriptorLock(
        descriptor,
        Math.max(1, Math.min(10_000, Math.ceil(remaining))),
        options.signal,
      );
      options.signal?.throwIfAborted();
      if (performance.now() >= deadline) throw new RosLiveFilesystemLockError("wait_timeout");
      if (acquired) {
        const result = await run();
        options.signal?.throwIfAborted();
        return result;
      }
      await delay(Math.min(pollMs, Math.max(1, deadline - performance.now())), undefined, {
        signal: options.signal,
      });
    }
  } finally {
    closeSync(descriptor);
  }
}
