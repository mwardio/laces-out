import type { DraftStreamInvalidation } from "@laces-out/contracts";
import { describe, expect, it } from "vitest";

import {
  draftStreamAdvances,
  draftStreamBackoffMs,
  parseDraftStreamFrame,
  subscribeToDraftStream,
  type DraftStreamHandlers,
  type DraftStreamState,
} from "./draft-stream.js";

const DRAFT_ID = "55555555-5555-4555-8555-555555555555";
const OTHER_DRAFT_ID = "77777777-7777-4777-8777-777777777777";

function invalidation(overrides: Partial<DraftStreamInvalidation> = {}): DraftStreamInvalidation {
  return {
    draftId: DRAFT_ID,
    sequence: 12,
    feedRevision: 1_000_005,
    occurredAt: "2026-08-24T18:00:00.000Z",
    ...overrides,
  };
}

/**
 * Stands in for `EventSource`. The controller only ever sees the injected connect function, so the
 * whole reconnect path is exercised without a DOM.
 */
class FakeStream {
  readonly opened: string[] = [];
  readonly timers: { readonly handle: number; readonly run: () => void; readonly delay: number }[] =
    [];
  handlers: DraftStreamHandlers | null = null;
  closes = 0;
  private nextHandle = 1;

  connect = (url: string, handlers: DraftStreamHandlers) => {
    this.opened.push(url);
    this.handlers = handlers;
    return {
      close: () => {
        this.closes += 1;
      },
    };
  };

  setTimer = (run: () => void, delay: number) => {
    const handle = this.nextHandle++;
    this.timers.push({ handle, run, delay });
    return handle;
  };

  clearTimer = (handle: number) => {
    const index = this.timers.findIndex((timer) => timer.handle === handle);
    if (index >= 0) this.timers.splice(index, 1);
  };

  /** Runs the single pending reconnect timer, mirroring a real timer firing once. */
  advance() {
    const next = this.timers.shift();
    next?.run();
  }
}

function harness() {
  const stream = new FakeStream();
  const received: DraftStreamInvalidation[] = [];
  const states: DraftStreamState[] = [];
  const subscription = subscribeToDraftStream({
    draftId: DRAFT_ID,
    url: "https://api.example.test/v1/drafts/x/stream",
    connect: stream.connect,
    onInvalidate: (value) => received.push(value),
    onStateChange: (value) => states.push(value),
    setTimer: stream.setTimer,
    clearTimer: stream.clearTimer,
  });
  return { stream, received, states, subscription };
}

describe("draft stream backoff", () => {
  it("grows exponentially and then holds at the cap", () => {
    expect(draftStreamBackoffMs(0)).toBe(1_000);
    expect(draftStreamBackoffMs(1)).toBe(1_000);
    expect(draftStreamBackoffMs(2)).toBe(2_000);
    expect(draftStreamBackoffMs(3)).toBe(4_000);
    expect(draftStreamBackoffMs(6)).toBe(30_000);
    expect(draftStreamBackoffMs(40)).toBe(30_000);
  });
});

describe("draft stream monotonicity", () => {
  it("preserves revision-only ordering for legacy stream frames", () => {
    expect(draftStreamAdvances(null, { sequence: 0, feedRevision: 0 })).toBe(true);
    const applied = { sequence: 12, feedRevision: 4 };
    expect(draftStreamAdvances(applied, { sequence: 13, feedRevision: 0 })).toBe(true);
    expect(draftStreamAdvances(applied, { sequence: 12, feedRevision: 5 })).toBe(true);
    expect(draftStreamAdvances(applied, { sequence: 12, feedRevision: 4 })).toBe(false);
    expect(draftStreamAdvances(applied, { sequence: 12, feedRevision: 3 })).toBe(false);
    expect(draftStreamAdvances(applied, { sequence: 11, feedRevision: 99 })).toBe(false);
  });

  it("advances across a page reload or source takeover even when the revision resets", () => {
    const beforeReload = { sequence: 12, feedRevision: 1_000_031 };
    const afterReload = { sequence: 12, feedRevision: 2_000_002 };

    expect(draftStreamAdvances(beforeReload, afterReload)).toBe(true);
    expect(draftStreamAdvances(afterReload, beforeReload)).toBe(false);
  });

  it("supports a rolling upgrade without accepting delayed legacy frames afterward", () => {
    const legacy = { sequence: 12, feedRevision: 30 };
    const current = { sequence: 12, feedRevision: 2_000_002 };

    expect(draftStreamAdvances(legacy, current)).toBe(true);
    expect(draftStreamAdvances(current, legacy)).toBe(false);
  });
});

describe("draft stream frame parsing", () => {
  it("accepts a valid JSON frame for this draft", () => {
    expect(parseDraftStreamFrame(DRAFT_ID, JSON.stringify(invalidation()))).toEqual(invalidation());
    expect(parseDraftStreamFrame(DRAFT_ID, invalidation())).toEqual(invalidation());
  });

  it("drops malformed, foreign, and off-contract frames", () => {
    expect(parseDraftStreamFrame(DRAFT_ID, "{not json")).toBeNull();
    expect(parseDraftStreamFrame(DRAFT_ID, "")).toBeNull();
    expect(parseDraftStreamFrame(DRAFT_ID, null)).toBeNull();
    expect(
      parseDraftStreamFrame(DRAFT_ID, JSON.stringify(invalidation({ draftId: OTHER_DRAFT_ID }))),
    ).toBeNull();
    expect(parseDraftStreamFrame(DRAFT_ID, JSON.stringify({ draftId: DRAFT_ID }))).toBeNull();
    expect(
      parseDraftStreamFrame(DRAFT_ID, JSON.stringify({ ...invalidation(), sequence: -1 })),
    ).toBeNull();
    expect(
      parseDraftStreamFrame(DRAFT_ID, JSON.stringify({ ...invalidation(), extra: "smuggled" })),
    ).toBeNull();
  });
});

describe("draft stream subscription", () => {
  it("connects immediately and reports streaming once open", () => {
    const { stream, states, subscription } = harness();
    expect(stream.opened).toHaveLength(1);
    expect(subscription.state()).toBe("connecting");
    stream.handlers?.onOpen();
    expect(subscription.state()).toBe("streaming");
    expect(states).toEqual(["streaming"]);
  });

  it("emits an invalidation per forward frame and ignores replays", () => {
    const { stream, received } = harness();
    stream.handlers?.onOpen();
    stream.handlers?.onMessage(JSON.stringify(invalidation({ sequence: 12, feedRevision: 4 })));
    stream.handlers?.onMessage(JSON.stringify(invalidation({ sequence: 12, feedRevision: 4 })));
    stream.handlers?.onMessage(JSON.stringify(invalidation({ sequence: 11, feedRevision: 9 })));
    stream.handlers?.onMessage(JSON.stringify(invalidation({ sequence: 12, feedRevision: 5 })));
    stream.handlers?.onMessage(JSON.stringify(invalidation({ sequence: 13, feedRevision: 0 })));
    expect(received.map((item) => [item.sequence, item.feedRevision])).toEqual([
      [12, 4],
      [12, 5],
      [13, 0],
    ]);
  });

  it("emits a same-sequence takeover after its page revision resets", () => {
    const { stream, received } = harness();
    stream.handlers?.onOpen();
    stream.handlers?.onMessage(JSON.stringify(invalidation({ feedRevision: 1_000_031 })));
    stream.handlers?.onMessage(JSON.stringify(invalidation({ feedRevision: 2_000_002 })));
    stream.handlers?.onMessage(JSON.stringify(invalidation({ feedRevision: 1_000_032 })));

    expect(received.map((item) => item.feedRevision)).toEqual([1_000_031, 2_000_002]);
  });

  it("never reloads on a frame for another room or a malformed frame", () => {
    const { stream, received } = harness();
    stream.handlers?.onOpen();
    stream.handlers?.onMessage(JSON.stringify(invalidation({ draftId: OTHER_DRAFT_ID })));
    stream.handlers?.onMessage("<html>404</html>");
    expect(received).toEqual([]);
  });

  it("reconnects with growing backoff after a dropped connection", () => {
    const { stream } = harness();
    stream.handlers?.onOpen();
    stream.handlers?.onError();
    expect(stream.closes).toBe(1);
    expect(stream.timers[0]?.delay).toBe(1_000);
    stream.advance();
    expect(stream.opened).toHaveLength(2);
    stream.handlers?.onError();
    expect(stream.timers[0]?.delay).toBe(2_000);
  });

  it("resets the backoff once a reconnect succeeds", () => {
    const { stream } = harness();
    stream.handlers?.onError();
    stream.advance();
    stream.handlers?.onError();
    stream.advance();
    expect(stream.opened).toHaveLength(3);
    stream.handlers?.onOpen();
    stream.handlers?.onError();
    expect(stream.timers[0]?.delay).toBe(1_000);
  });

  it("falls back to polling after repeated failures, as a 404 endpoint would cause", () => {
    const { stream, states, subscription } = harness();
    stream.handlers?.onError();
    expect(subscription.state()).toBe("connecting");
    stream.advance();
    stream.handlers?.onError();
    expect(subscription.state()).toBe("polling");
    expect(states).toContain("polling");
  });

  it("recovers from the polling fallback when the endpoint comes back", () => {
    const { stream, subscription } = harness();
    stream.handlers?.onError();
    stream.advance();
    stream.handlers?.onError();
    expect(subscription.state()).toBe("polling");
    stream.advance();
    stream.handlers?.onOpen();
    expect(subscription.state()).toBe("streaming");
  });

  it("stops retrying after the attempt ceiling and stays on polling", () => {
    const stream = new FakeStream();
    const subscription = subscribeToDraftStream({
      draftId: DRAFT_ID,
      url: "https://api.example.test/stream",
      connect: stream.connect,
      onInvalidate: () => undefined,
      setTimer: stream.setTimer,
      clearTimer: stream.clearTimer,
      maximumAttempts: 2,
    });
    stream.handlers?.onError();
    stream.advance();
    stream.handlers?.onError();
    expect(stream.timers).toHaveLength(0);
    expect(subscription.state()).toBe("polling");
    expect(stream.opened).toHaveLength(2);

    subscription.retry();
    expect(stream.opened).toHaveLength(3);
  });

  it("stops everything once closed and never reconnects again", () => {
    const { stream, received, subscription } = harness();
    stream.handlers?.onOpen();
    subscription.close();
    expect(stream.closes).toBe(1);
    stream.handlers?.onMessage(JSON.stringify(invalidation()));
    stream.handlers?.onError();
    expect(received).toEqual([]);
    expect(stream.timers).toHaveLength(0);
    subscription.retry();
    expect(stream.opened).toHaveLength(1);
  });

  it("does not open a second connection while one is already live", () => {
    const { stream, subscription } = harness();
    stream.handlers?.onOpen();
    subscription.retry();
    expect(stream.opened).toHaveLength(1);
  });
});
