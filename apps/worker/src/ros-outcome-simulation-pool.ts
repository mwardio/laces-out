import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { fork } from "node:child_process";
import { EventEmitter } from "node:events";
import type {
  FirstPartyRosOutcomeEnsemble,
  FirstPartyRosOutcomeInput,
} from "@laces-out/projections";

export const ROS_OUTCOME_SIMULATION_WORKERS = 2;
export const ROS_OUTCOME_SIMULATION_WORKER_HEAP_MB = 512;
const MAXIMUM_QUEUED_TASKS = 2;

interface SimulationWorker extends Pick<EventEmitter, "on"> {
  postMessage(message: { readonly id: number; readonly input: FirstPartyRosOutcomeInput }): void;
  terminate(): Promise<number>;
}
interface Pending {
  readonly id: number;
  readonly input: FirstPartyRosOutcomeInput;
  readonly resolve: (result: FirstPartyRosOutcomeEnsemble) => void;
  readonly reject: (error: Error) => void;
}
interface Slot {
  readonly worker: SimulationWorker;
  pending?: Pending | undefined;
}
interface WorkerMessage {
  readonly id: number;
  readonly ok: boolean;
  readonly result?: FirstPartyRosOutcomeEnsemble;
  readonly error?: string;
  readonly memory?: {
    readonly rss: number;
    readonly heapUsed: number;
    readonly external: number;
    readonly heapLimit: number;
  };
}

/** Explicit child-process CLI flags enforce a smaller heap than the corpus builder's own heap. */
function simulationWorker(entry?: URL): SimulationWorker {
  const source = entry === undefined && import.meta.url.endsWith(".ts");
  const url =
    entry ??
    new URL(
      source ? "./ros-outcome-simulation-worker.ts" : "./ros-outcome-simulation-worker.js",
      import.meta.url,
    );
  const child = fork(fileURLToPath(url), [], {
    execArgv: [
      `--max-old-space-size=${ROS_OUTCOME_SIMULATION_WORKER_HEAP_MB}`,
      ...(source ? ["--import", createRequire(import.meta.url).resolve("tsx")] : []),
    ],
    // A child receives public football inputs only. Parent NODE_OPTIONS cannot override its cap.
    env: { NODE_ENV: process.env.NODE_ENV, TZ: "UTC", NODE_OPTIONS: "" },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    serialization: "advanced",
  });
  const events = new EventEmitter();
  child.on("message", (message) => events.emit("message", message));
  child.on("error", (error) => events.emit("error", error));
  child.on("exit", (code) => events.emit("exit", code ?? -1));
  // Drain crash diagnostics without accumulating arbitrary child stderr or filling its pipe.
  child.stderr?.on("data", () => undefined);
  let closed = false;
  child.once("close", () => {
    closed = true;
  });
  let termination: Promise<number> | undefined;
  return {
    on: events.on.bind(events),
    postMessage(message) {
      child.send(message, (error) => {
        if (error) events.emit("error", error);
      });
    },
    terminate() {
      if (termination) return termination;
      if (closed) return Promise.resolve(child.exitCode ?? -1);
      termination = new Promise<number>((resolve) => {
        const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
        timer.unref();
        child.once("close", (code) => {
          clearTimeout(timer);
          resolve(code ?? -1);
        });
        child.kill("SIGTERM");
      });
      return termination;
    },
  };
}

/** Two lazy CPU processes. Only one player's already-fitted football inputs cross this boundary. */
export function createRosOutcomeSimulationPool(
  options: {
    readonly maximumWorkers?: 1 | 2;
    readonly signal?: AbortSignal;
    readonly workerEntry?: URL;
    readonly workerFactory?: () => SimulationWorker;
  } = {},
) {
  const maximumWorkers = options.maximumWorkers ?? ROS_OUTCOME_SIMULATION_WORKERS;
  if (maximumWorkers !== 1 && maximumWorkers !== 2)
    throw new RangeError("Invalid ROS simulation worker limit");
  const slots: Slot[] = [];
  const queue: Pending[] = [];
  let sequence = 0;
  let closing = false;
  let closePromise: Promise<void> | undefined;
  let closedReason = new Error("ROS outcome simulation pool closed");
  let peakActive = 0;
  const peakMemory = { rss: 0, heapUsed: 0, external: 0, heapLimit: 0 };

  const close = (reason = new Error("ROS outcome simulation pool closed")): Promise<void> => {
    if (closePromise) return closePromise;
    closing = true;
    closedReason = reason;
    options.signal?.removeEventListener("abort", abort);
    const pending = [
      ...queue.splice(0),
      ...slots.flatMap((slot) => (slot.pending ? [slot.pending] : [])),
    ];
    for (const slot of slots) slot.pending = undefined;
    closePromise = Promise.allSettled(slots.map((slot) => slot.worker.terminate())).then(() => {
      // A rejected task cannot release its parent build lock while a CPU child is still running.
      for (const task of pending) task.reject(reason);
    });
    return closePromise;
  };
  const abort = () => {
    void close(
      options.signal?.reason instanceof Error
        ? options.signal.reason
        : new Error("ROS outcome simulation aborted"),
    );
  };
  const dispatch = (slot: Slot, task: Pending) => {
    slot.pending = task;
    peakActive = Math.max(peakActive, slots.filter((item) => item.pending !== undefined).length);
    try {
      slot.worker.postMessage({ id: task.id, input: task.input });
    } catch (error) {
      void close(error instanceof Error ? error : new Error("ROS simulation dispatch failed"));
    }
  };
  const spawn = (): Slot => {
    const slot: Slot = {
      worker: options.workerFactory?.() ?? simulationWorker(options.workerEntry),
    };
    slots.push(slot);
    slot.worker.on("message", (message: WorkerMessage) => {
      if (closing) return;
      const pending = slot.pending;
      if (!pending || message?.id !== pending.id || message.ok !== true || !message.result) {
        void close(
          new Error(message?.error?.slice(0, 512) ?? "Invalid ROS simulation worker response"),
        );
        return;
      }
      if (message.memory) {
        for (const key of ["rss", "heapUsed", "external", "heapLimit"] as const) {
          const value = message.memory[key];
          if (Number.isFinite(value) && value >= 0)
            peakMemory[key] = Math.max(peakMemory[key], value);
        }
      }
      slot.pending = undefined;
      pending.resolve(message.result);
      const next = queue.shift();
      if (next) dispatch(slot, next);
    });
    slot.worker.on("error", (error: Error) => {
      if (!closing) void close(error);
    });
    slot.worker.on("exit", (code: number) => {
      if (!closing)
        void close(new Error(`ROS simulation worker exited unexpectedly (code ${code})`));
    });
    return slot;
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  return {
    simulate(this: void, input: FirstPartyRosOutcomeInput): Promise<FirstPartyRosOutcomeEnsemble> {
      if (closing) return Promise.reject(closedReason);
      return new Promise((resolve, reject) => {
        const task: Pending = { id: ++sequence, input, resolve, reject };
        let slot = slots.find((item) => item.pending === undefined);
        if (!slot && slots.length < maximumWorkers) {
          try {
            slot = spawn();
          } catch (error) {
            queue.push(task);
            void close(
              error instanceof Error ? error : new Error("ROS simulation worker creation failed"),
            );
            return;
          }
        }
        if (slot) dispatch(slot, task);
        else if (queue.length < MAXIMUM_QUEUED_TASKS) queue.push(task);
        else reject(new Error("ROS outcome simulation queue is full"));
      });
    },
    close,
    stats: () => ({
      workersCreated: slots.length,
      active: slots.filter((slot) => slot.pending !== undefined).length,
      queued: queue.length,
      peakActive,
      peakMemory: { ...peakMemory },
    }),
  };
}
