import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  simulateFirstPartyRosOutcomes,
  type FirstPartyRosOutcomeInput,
} from "@laces-out/projections";
import { createRosOutcomeSimulationPool } from "./ros-outcome-simulation-pool.js";
import { historicalOutcomeInputFixture } from "./ros-historical-outcome.test-fixtures.js";

function football(): FirstPartyRosOutcomeInput {
  const { scoringProfile: _profile, ...input } = historicalOutcomeInputFixture({
    scenarioCount: 128,
  });
  void _profile;
  return input;
}
class FakeWorker extends EventEmitter {
  readonly sent: { id: number; input: FirstPartyRosOutcomeInput }[] = [];
  readonly postMessage = vi.fn((message: { id: number; input: FirstPartyRosOutcomeInput }) => {
    this.sent.push(message);
  });
  readonly terminate = vi.fn(async () => 0);
  finish() {
    const message = this.sent.at(-1)!;
    this.emit("message", {
      id: message.id,
      ok: true,
      result: simulateFirstPartyRosOutcomes(message.input),
    });
  }
}

describe("bounded ROS outcome simulation isolates", () => {
  it("starts lazily, reuses two workers, and bounds pending work", async () => {
    const workers: FakeWorker[] = [];
    const pool = createRosOutcomeSimulationPool({
      workerFactory: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
    });
    expect(pool.stats().workersCreated).toBe(0);
    const tasks = [1, 2, 3, 4].map(() => pool.simulate(football()));
    await expect(pool.simulate(football())).rejects.toThrow("queue is full");
    expect(pool.stats()).toMatchObject({ workersCreated: 2, active: 2, queued: 2, peakActive: 2 });
    workers[0]!.finish();
    workers[1]!.finish();
    workers[0]!.finish();
    workers[1]!.finish();
    await Promise.all(tasks);
    await pool.close();
    expect(workers.every((worker) => worker.terminate.mock.calls.length === 1)).toBe(true);
    await expect(pool.simulate(football())).rejects.toThrow("pool closed");
  });

  it("rejects active and queued requests only after all workers terminate on abort", async () => {
    const abort = new AbortController();
    const workers: FakeWorker[] = [];
    const terminations: (() => void)[] = [];
    const pool = createRosOutcomeSimulationPool({
      signal: abort.signal,
      workerFactory: () => {
        const worker = new FakeWorker();
        worker.terminate.mockImplementation(
          () => new Promise<number>((resolve) => terminations.push(() => resolve(0))),
        );
        workers.push(worker);
        return worker;
      },
    });
    let rejected = 0;
    const pending = [1, 2, 3].map(() =>
      pool.simulate(football()).catch((error: unknown) => {
        rejected += 1;
        return error;
      }),
    );
    abort.abort(new Error("cancelled build"));
    await Promise.resolve();
    expect(rejected).toBe(0);
    workers[0]!.finish(); // A late result cannot publish after cancellation.
    terminations[0]!();
    await Promise.resolve();
    expect(rejected).toBe(0);
    terminations[1]!();
    const results = await Promise.all(pending);
    expect(
      results.every((error) => error instanceof Error && error.message === "cancelled build"),
    ).toBe(true);
    await pool.close();
    expect(workers.every((worker) => worker.terminate.mock.calls.length === 1)).toBe(true);
  });

  it.each(["error", "exit", "wrong-id", "task-error"])(
    "fails the entire pool on %s",
    async (event) => {
      const worker = new FakeWorker();
      const pool = createRosOutcomeSimulationPool({
        maximumWorkers: 1,
        workerFactory: () => worker,
      });
      const promises = [pool.simulate(football()), pool.simulate(football())].map((pending) =>
        pending.catch((error: unknown) => error),
      );
      if (event === "error") worker.emit("error", new Error("worker failure"));
      if (event === "exit") worker.emit("exit", 9);
      if (event === "wrong-id") worker.emit("message", { id: 99, ok: true, result: {} });
      if (event === "task-error")
        worker.emit("message", { id: 1, ok: false, error: "invalid football" });
      expect((await Promise.all(promises)).every((error) => error instanceof Error)).toBe(true);
      expect(worker.terminate).toHaveBeenCalledOnce();
      await pool.close();
    },
  );

  it("does not start workers for a previously aborted pool or an unused pool", async () => {
    const workerFactory = vi.fn(() => new FakeWorker());
    const abort = new AbortController();
    abort.abort(new Error("already cancelled"));
    const cancelled = createRosOutcomeSimulationPool({ signal: abort.signal, workerFactory });
    await expect(cancelled.simulate(football())).rejects.toThrow("already cancelled");
    await cancelled.close();
    await createRosOutcomeSimulationPool({ workerFactory }).close();
    expect(workerFactory).not.toHaveBeenCalled();
  });

  it("loads the real worker from the source tree and transfers identical vector bytes", async () => {
    const pool = createRosOutcomeSimulationPool();
    try {
      const expected = simulateFirstPartyRosOutcomes(football());
      const actual = await pool.simulate(football());
      expect(actual).toEqual(expected);
      expect(pool.stats()).toMatchObject({ workersCreated: 1, peakActive: 1 });
    } finally {
      await pool.close();
    }
  }, 30_000);
});
