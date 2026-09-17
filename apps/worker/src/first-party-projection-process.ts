import { fork, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { assertProjectionRefreshJob, type ProjectionRefreshJob } from "@laces-out/jobs";
import type { ProjectionRefreshService, WorkerJobContext } from "./jobs.js";
import {
  WEEKLY_PROJECTION_PROCESS_PROTOCOL,
  weeklyProjectionProcessError,
  type WeeklyProjectionProcessResponse,
} from "./first-party-projection-process-protocol.js";

export const WEEKLY_PROJECTION_PROCESS_HEAP_MB = 2_048;
interface WeeklyProjectionProcessOptions {
  readonly connectionString: string;
  readonly workerEntry?: URL;
  readonly startupTimeoutMs?: number;
  readonly terminationTimeoutMs?: number;
  readonly onEvent?: (event: Readonly<Record<string, unknown>>) => void;
}
interface Pending {
  readonly id: number;
  readonly context: WorkerJobContext;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly abort: () => void;
}
interface Slot {
  readonly child: ChildProcess;
  readonly ready: Promise<void>;
  readonly closed: Promise<void>;
  readonly resolveReady: () => void;
  readonly rejectReady: (error: Error) => void;
  readonly resolveClosed: () => void;
  readonly startupTimer: ReturnType<typeof setTimeout>;
  hasReady: boolean;
  didClose: boolean;
  termination?: Promise<void> | undefined;
  failure?: Error | undefined;
}

/** The ordinary worker keeps polling provider/notification jobs while this process computes. */
export class FirstPartyProjectionProcess implements ProjectionRefreshService {
  readonly #input: WeeklyProjectionProcessOptions;
  #slot: Slot | undefined;
  #pending: Pending | undefined;
  #sequence = 0;
  #closing = false;

  constructor(input: WeeklyProjectionProcessOptions) {
    this.#input = input;
  }

  refreshProjections(job: ProjectionRefreshJob, context: WorkerJobContext): Promise<void> {
    assertProjectionRefreshJob(job);
    const requestContext = { jobId: context.jobId, signal: context.signal };
    const isolatedJob = {
      season: job.season,
      ...(job.week === undefined ? {} : { week: job.week }),
      ...(job.horizon === undefined ? {} : { horizon: job.horizon }),
      ...(job.reason === undefined ? {} : { reason: job.reason }),
    };
    requestContext.signal.throwIfAborted();
    if (this.#closing) return Promise.reject(new Error("Weekly projection process is closed"));
    if (this.#pending)
      return Promise.reject(new Error("Weekly projection process already has an active request"));
    if (
      typeof context.jobId !== "string" ||
      context.jobId.length < 1 ||
      context.jobId.length > 256
    ) {
      return Promise.reject(new Error("Invalid weekly projection job identity"));
    }
    return new Promise<void>((resolve, reject) => {
      const id = ++this.#sequence;
      const abort = () => {
        const slot = this.#slot;
        if (slot) void this.#terminate(slot, new Error("Weekly projection request aborted"));
      };
      this.#pending = { id, context: requestContext, resolve, reject, abort };
      requestContext.signal.addEventListener("abort", abort, { once: true });
      let slot: Slot;
      try {
        slot = this.#slot ?? this.#spawn();
      } catch (error) {
        this.#settle(
          error instanceof Error ? error : new Error("Weekly projection worker could not start"),
        );
        return;
      }
      if (requestContext.signal.aborted) {
        abort();
        return;
      }
      void slot.ready
        .then(() => {
          if (slot.termination || this.#pending?.id !== id) return;
          try {
            slot.child.send(
              { type: "refresh", id, job: isolatedJob, jobId: requestContext.jobId },
              (error) => {
                if (error)
                  void this.#terminate(slot, new Error("Weekly projection IPC send failed"));
              },
            );
          } catch {
            void this.#terminate(slot, new Error("Weekly projection IPC send failed"));
          }
        })
        .catch((error: unknown) => {
          void this.#terminate(
            slot,
            error instanceof Error
              ? error
              : new Error("Weekly projection worker did not become ready"),
          );
        });
    });
  }

  async close(): Promise<void> {
    this.#closing = true;
    if (this.#slot)
      await this.#terminate(this.#slot, new Error("Weekly projection process closed"));
  }

  #emit(event: Readonly<Record<string, unknown>>): void {
    try {
      this.#input.onEvent?.(event);
    } catch {
      /* Logging cannot affect publication. */
    }
  }

  #settle(error?: Error): void {
    const pending = this.#pending;
    if (!pending) return;
    this.#pending = undefined;
    pending.context.signal.removeEventListener("abort", pending.abort);
    if (error) pending.reject(error);
    else pending.resolve();
  }

  #terminate(slot: Slot, error: Error): Promise<void> {
    if (slot.termination) return slot.termination;
    slot.failure = error;
    clearTimeout(slot.startupTimer);
    slot.rejectReady(error);
    slot.termination = (async () => {
      if (!slot.didClose) {
        const timer = setTimeout(() => {
          slot.child.kill("SIGKILL");
        }, this.#input.terminationTimeoutMs ?? 2_000);
        timer.unref();
        slot.child.kill("SIGTERM");
        await slot.closed;
        clearTimeout(timer);
      }
      if (this.#slot === slot) {
        this.#slot = undefined;
        this.#settle(error);
      }
    })();
    return slot.termination;
  }

  #spawn(): Slot {
    const source = import.meta.url.endsWith(".ts");
    const entry =
      this.#input.workerEntry ??
      new URL(
        source
          ? "./first-party-projection-process-entry.ts"
          : "./first-party-projection-process-entry.js",
        import.meta.url,
      );
    const child = fork(fileURLToPath(entry), [], {
      execArgv: [
        `--max-old-space-size=${WEEKLY_PROJECTION_PROCESS_HEAP_MB}`,
        ...(source ? ["--import", createRequire(import.meta.url).resolve("tsx")] : []),
      ],
      env: {
        DATABASE_URL: this.#input.connectionString,
        NODE_ENV: process.env.NODE_ENV,
        TZ: "UTC",
        NODE_OPTIONS: "",
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      serialization: "advanced",
    });
    let resolveReady!: () => void, rejectReady!: (error: Error) => void, resolveClosed!: () => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const slot: Slot = {
      child,
      ready,
      closed,
      resolveReady,
      rejectReady,
      resolveClosed,
      hasReady: false,
      didClose: false,
      startupTimer: setTimeout(() => {
        void this.#terminate(slot, new Error("Weekly projection worker startup timed out"));
      }, this.#input.startupTimeoutMs ?? 30_000),
    };
    this.#slot = slot;
    // Crash diagnostics may include SQL or environment values; drain without copying them to logs.
    child.stderr?.on("data", () => undefined);
    child.on("message", (message: WeeklyProjectionProcessResponse) => {
      if (slot.termination) return;
      if (
        message?.type === "ready" &&
        message.protocol === WEEKLY_PROJECTION_PROCESS_PROTOCOL &&
        !slot.hasReady
      ) {
        slot.hasReady = true;
        clearTimeout(slot.startupTimer);
        slot.resolveReady();
        this.#emit({ event: "weekly-projection-process-ready", pid: child.pid });
        return;
      }
      if (
        !slot.hasReady ||
        message?.type !== "result" ||
        message.id !== this.#pending?.id ||
        typeof message.ok !== "boolean"
      ) {
        void this.#terminate(slot, new Error("Invalid weekly projection worker response"));
        return;
      }
      this.#emit({
        event: "weekly-projection-process-result",
        ok: message.ok,
        pid: child.pid,
        ...(Number.isSafeInteger(message.memory?.rss) &&
        Number.isSafeInteger(message.memory?.heapLimit)
          ? { memory: { rss: message.memory!.rss, heapLimit: message.memory!.heapLimit } }
          : {}),
        ...(message.ok ? {} : { error: weeklyProjectionProcessError(message.error) }),
      });
      const error = weeklyProjectionProcessError(message.error);
      this.#settle(
        message.ok
          ? undefined
          : new Error(
              `Weekly projection service failed in its isolated process (${error.name}${error.code ? `, ${error.code}` : ""})`,
            ),
      );
    });
    child.on("error", () => {
      void this.#terminate(slot, new Error("Weekly projection worker process failed"));
    });
    child.once("disconnect", () => {
      if (!slot.termination && !slot.didClose) {
        void this.#terminate(slot, new Error("Weekly projection worker IPC disconnected"));
      }
    });
    child.once("close", (code, signal) => {
      slot.didClose = true;
      clearTimeout(slot.startupTimer);
      slot.resolveClosed();
      slot.rejectReady(
        slot.failure ?? new Error("Weekly projection worker exited before becoming ready"),
      );
      this.#emit({ event: "weekly-projection-process-closed", code, signal, pid: child.pid });
      if (!slot.termination)
        void this.#terminate(slot, new Error("Weekly projection worker exited unexpectedly"));
    });
    return slot;
  }
}
