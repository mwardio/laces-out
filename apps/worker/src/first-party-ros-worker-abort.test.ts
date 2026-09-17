import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  worker: undefined as
    | undefined
    | {
        emit(event: string, message: unknown): boolean;
        terminate: ReturnType<typeof vi.fn>;
      },
  completeTermination: undefined as undefined | (() => void),
  options: undefined as undefined | { resourceLimits?: { maxOldGenerationSizeMb?: number } },
}));

vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    Worker: class extends EventEmitter {
      terminate = vi.fn(
        () =>
          new Promise<number>((resolve) => {
            state.completeTermination = () => resolve(1);
          }),
      );
      constructor(_entry: unknown, options: typeof state.options) {
        super();
        state.worker = this;
        state.options = options;
      }
    },
  };
});

import { buildFirstPartyRosTargetsInWorker } from "./first-party-ros-worker-thread.js";
import type { FirstPartyRosCandidateContext } from "./first-party-ros-projections.js";

afterEach(() => {
  state.worker = undefined;
  state.completeTermination = undefined;
  state.options = undefined;
});

describe("ROS model worker cancellation", () => {
  it("waits for worker termination and ignores a late success message before allowing retry", async () => {
    const artifact = {
      artifactChecksum: "b".repeat(64),
    } as FirstPartyRosCandidateContext["artifact"];
    const context: FirstPartyRosCandidateContext = {
      season: 2026,
      window: {
        asOfWeek: 1,
        currentWeek: 2,
        windowStartWeek: 2,
        windowEndWeek: 18,
        currentWeekStarted: false,
      },
      now: new Date("2026-09-17T12:00:00Z"),
      candidateProviderChecksum: "a".repeat(64),
      artifact,
      artifacts: [artifact],
    };
    const controller = new AbortController();
    let completed = false;
    const result = buildFirstPartyRosTargetsInWorker(context, controller.signal).finally(() => {
      completed = true;
    });
    const assertion = expect(result).rejects.toThrow(/aborted/);
    expect(state.options?.resourceLimits?.maxOldGenerationSizeMb).toBe(2_048);
    controller.abort();
    expect(state.worker?.terminate).toHaveBeenCalledTimes(1);
    state.worker?.emit("message", {
      ok: true,
      result: { [context.artifact.artifactChecksum]: [] },
    });
    state.worker?.emit("exit", 1);
    await Promise.resolve();
    expect(completed).toBe(false);
    state.completeTermination?.();
    await assertion;
    expect(completed).toBe(true);
  });
});
