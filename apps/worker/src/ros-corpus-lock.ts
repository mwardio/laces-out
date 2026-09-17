import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { createDedicatedDatabaseSession } from "@laces-out/db";

export interface RosCorpusLockGuard {
  readonly signal: AbortSignal;
  assertHeld(): Promise<void>;
}

export type RosCorpusLock = <T>(
  identity: string,
  signal: AbortSignal,
  run: (guard: RosCorpusLockGuard) => Promise<T>,
) => Promise<T>;

/** Session locks must stay on one reserved connection throughout the child process lifetime. */
export function createPostgresRosCorpusLock(
  connectionString: string,
  options: { readonly pollMs?: number; readonly heartbeatMs?: number } = {},
): RosCorpusLock {
  return async (identity, signal, run) => {
    signal.throwIfAborted();
    const digest = createHash("sha256").update(`laces-ros-corpus:${identity}`).digest();
    const first = digest.readInt32BE(0);
    const second = digest.readInt32BE(4);
    const lost = new AbortController();
    const combined = AbortSignal.any([signal, lost.signal]);
    const monitorStop = new AbortController();
    let held = false;
    let backend: number | undefined;
    let monitor: Promise<void> | undefined;
    let disconnected = false;
    let closing = false;
    // An owned client gives this long-lived lease an explicit connection-close signal. A dead
    // postgres-js reserved session must never be queried or returned to an application's pool.
    const database = createDedicatedDatabaseSession(connectionString, () => {
      disconnected = true;
      if (!closing) lost.abort(new Error("ROS corpus build lock connection closed"));
    });
    const session = await database.reserve().catch(async (error: unknown) => {
      closing = true;
      await database.close();
      throw error;
    });
    const assertHeld = async () => {
      combined.throwIfAborted();
      const [row] = await session<{ pid: number; held: boolean }[]>`
        select pg_backend_pid() as pid, exists (
          select 1 from pg_locks
          where locktype = 'advisory' and pid = pg_backend_pid()
            and classid = ${first >>> 0}::bigint and objid = ${second >>> 0}::bigint
            and objsubid = 2 and granted
        ) as held`;
      if (!row?.held || row.pid !== backend) {
        lost.abort(new Error("ROS corpus build lock was lost"));
        combined.throwIfAborted();
      }
    };
    try {
      for (;;) {
        combined.throwIfAborted();
        const [row] = await session<{ held: boolean; pid: number }[]>`
          select pg_try_advisory_lock(${first}, ${second}) as held, pg_backend_pid() as pid`;
        if (row?.held) {
          held = true;
          backend = row.pid;
          break;
        }
        await delay(options.pollMs ?? 2_000, undefined, { signal: combined });
      }
      monitor = (async () => {
        try {
          while (!monitorStop.signal.aborted) {
            await delay(options.heartbeatMs ?? 10_000, undefined, {
              signal: monitorStop.signal,
            });
            await assertHeld();
          }
        } catch (error) {
          if (!monitorStop.signal.aborted) lost.abort(error);
        }
      })();
      // The subprocess runner settles only after its child exits, so cancellation cannot unlock
      // a build while its child still writes outcomes or a corpus manifest.
      const result = await run({ signal: combined, assertHeld });
      await assertHeld();
      return result;
    } finally {
      monitorStop.abort();
      await monitor;
      try {
        if (held && !disconnected) await session`select pg_advisory_unlock(${first}, ${second})`;
      } finally {
        closing = true;
        if (!disconnected) session.release();
        await database.close();
      }
    }
  };
}
