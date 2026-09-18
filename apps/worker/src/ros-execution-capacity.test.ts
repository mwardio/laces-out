import { describe, expect, it, vi } from "vitest";

import { RosExecutionCapacity } from "./ros-execution-capacity.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("shared ROS execution capacity", () => {
  it("allows two replays and gives a waiting builder exclusive FIFO capacity", async () => {
    const capacity = new RosExecutionCapacity();
    const signal = new AbortController().signal;
    const first = deferred();
    const second = deferred();
    const build = deferred();
    const events: string[] = [];
    const one = capacity.run(1, signal, async () => {
      events.push("replay-one");
      await first.promise;
    });
    const two = capacity.run(1, signal, async () => {
      events.push("replay-two");
      await second.promise;
    });
    const builder = capacity.run(2, signal, async () => {
      events.push("builder");
      await build.promise;
    });
    const later = capacity.run(1, signal, async () => {
      events.push("later-replay");
    });
    await tick();
    expect(events).toEqual(["replay-one", "replay-two"]);
    first.resolve();
    await one;
    await tick();
    expect(events).toEqual(["replay-one", "replay-two"]);
    second.resolve();
    await two;
    await tick();
    expect(events).toEqual(["replay-one", "replay-two", "builder"]);
    build.resolve();
    await Promise.all([builder, later]);
    expect(events).toEqual(["replay-one", "replay-two", "builder", "later-replay"]);
  });

  it("removes an aborted queued builder and releases capacity after an action fails", async () => {
    const capacity = new RosExecutionCapacity();
    const signal = new AbortController().signal;
    const first = deferred();
    const active = capacity.run(1, signal, async () => {
      await first.promise;
    });
    const cancelled = new AbortController();
    const forbidden = vi.fn(async () => {});
    const builder = capacity.run(2, cancelled.signal, forbidden);
    const failed = capacity.run(1, signal, async () => {
      throw new Error("replay failed");
    });
    const builderCheck = expect(builder).rejects.toThrow("cancelled builder");
    const failedCheck = expect(failed).rejects.toThrow("replay failed");
    cancelled.abort(new Error("cancelled builder"));
    await Promise.all([builderCheck, failedCheck]);
    expect(forbidden).not.toHaveBeenCalled();
    const resumed = vi.fn(async () => {});
    await capacity.run(1, signal, resumed);
    expect(resumed).toHaveBeenCalledOnce();
    first.resolve();
    await active;
    await capacity.run(2, signal, async () => {});
  });

  it("does not run an action when aborted immediately after reservation", async () => {
    const capacity = new RosExecutionCapacity();
    const controller = new AbortController();
    const action = vi.fn(async () => {});
    const operation = capacity.run(2, controller.signal, action);
    const checked = expect(operation).rejects.toThrow("shutdown");
    controller.abort(new Error("shutdown"));
    await checked;
    expect(action).not.toHaveBeenCalled();
    await capacity.run(2, new AbortController().signal, async () => {});
  });
});
