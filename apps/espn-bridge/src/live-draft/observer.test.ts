import { describe, expect, it } from "vitest";

import type { EspnLiveDraftPickV1, EspnLiveDraftState, EspnLiveDraftType } from "./dom-contract.js";
import { espnLiveDraftDigestSource, type EspnLiveDraftCurrentAuctionV1 } from "./dom-contract.js";
import type { EspnLiveDraftSnapshot, EspnLiveDraftSnapshotResult } from "./observation.js";
import {
  createLiveDraftObserver,
  LIVE_DRAFT_OBSERVER_TUNING,
  type LiveDraftMutationSource,
  type LiveDraftObserverSink,
  type LiveDraftSnapshotReason,
  type LiveDraftTimers,
} from "./observer.js";

/** Deterministic scheduler: nothing here waits on real time. */
class ManualClock implements LiveDraftTimers {
  #now = 1_000;
  #next = 1;
  readonly #timeouts = new Map<number, { at: number; handler: () => void }>();
  readonly #intervals = new Map<number, { period: number; next: number; handler: () => void }>();

  now(): number {
    return this.#now;
  }

  setTimeout(handler: () => void, delayMs: number): number {
    const handle = this.#next++;
    this.#timeouts.set(handle, { at: this.#now + delayMs, handler });
    return handle;
  }

  clearTimeout(handle: number): void {
    this.#timeouts.delete(handle);
  }

  setInterval(handler: () => void, periodMs: number): number {
    const handle = this.#next++;
    this.#intervals.set(handle, { period: periodMs, next: this.#now + periodMs, handler });
    return handle;
  }

  clearInterval(handle: number): void {
    this.#intervals.delete(handle);
  }

  /** Fires exactly the callbacks due in the window, one at a time, in timestamp order. */
  advance(milliseconds: number): void {
    const target = this.#now + milliseconds;
    for (;;) {
      let soonest = Number.POSITIVE_INFINITY;
      let chosen: { kind: "timeout" | "interval"; handle: number } | null = null;
      for (const [handle, timeout] of this.#timeouts) {
        if (timeout.at < soonest) {
          soonest = timeout.at;
          chosen = { kind: "timeout", handle };
        }
      }
      for (const [handle, interval] of this.#intervals) {
        if (interval.next < soonest) {
          soonest = interval.next;
          chosen = { kind: "interval", handle };
        }
      }
      if (chosen === null || soonest > target) break;
      this.#now = soonest;
      if (chosen.kind === "timeout") {
        const timeout = this.#timeouts.get(chosen.handle);
        this.#timeouts.delete(chosen.handle);
        timeout?.handler();
      } else {
        const interval = this.#intervals.get(chosen.handle);
        if (interval) {
          interval.next = this.#now + interval.period;
          interval.handler();
        }
      }
    }
    this.#now = target;
  }
}

function snapshot(options: {
  picks?: readonly Partial<EspnLiveDraftPickV1>[];
  state?: EspnLiveDraftState;
  draftType?: EspnLiveDraftType;
  currentAuction?: EspnLiveDraftCurrentAuctionV1 | null;
}): EspnLiveDraftSnapshot {
  const picks: EspnLiveDraftPickV1[] = (options.picks ?? []).map((pick, index) => ({
    sequence: index + 1,
    round: 1,
    roundPick: index + 1,
    keeper: false,
    providerTeamId: "1",
    teamName: "Ditka's Revenge",
    providerPlayerId: "3139477",
    playerName: "Patrick Mahomes",
    proTeam: "KC",
    position: "QB",
    price: null,
    nominatingProviderTeamId: null,
    ...pick,
  }));
  const board = {
    leagueId: "1234567",
    season: 2026,
    state: options.state ?? "live",
    draftType: options.draftType ?? "snake",
    expectedTeamCount: 12,
    expectedRosterSize: 16,
    pickOwnership: [],
    picks,
  } as const;
  return {
    ...board,
    currentAuction: options.currentAuction ?? null,
    completeness: {
      contiguousThrough: picks.length,
      duplicateSequences: 0,
      unresolvedRows: 0,
    },
    digestSource: espnLiveDraftDigestSource(board),
  };
}

function harness(initial: EspnLiveDraftSnapshotResult) {
  const clock = new ManualClock();
  const snapshots: LiveDraftSnapshotReason[] = [];
  const transients: EspnLiveDraftSnapshot[] = [];
  const heartbeats: EspnLiveDraftState[] = [];
  const failures: string[] = [];
  let scans = 0;
  let current = initial;
  let onMutation: (() => void) | null = null;

  const mutations: LiveDraftMutationSource = {
    start(handler): void {
      onMutation = handler;
    },
    stop(): void {
      onMutation = null;
    },
  };
  const sink: LiveDraftObserverSink = {
    snapshot: (_snapshot, reason) => snapshots.push(reason),
    transientAuction: (value) => transients.push(value),
    heartbeat: (state) => heartbeats.push(state),
    failure: (reason) => failures.push(reason),
  };
  const observer = createLiveDraftObserver({
    scan: () => {
      scans += 1;
      return current;
    },
    sink,
    timers: clock,
    mutations,
  });
  return {
    clock,
    observer,
    snapshots,
    transients,
    heartbeats,
    failures,
    get scans() {
      return scans;
    },
    get attached() {
      return onMutation !== null;
    },
    set board(next: EspnLiveDraftSnapshotResult) {
      current = next;
    },
    mutate(times = 1): void {
      for (let index = 0; index < times; index += 1) onMutation?.();
    },
  };
}

const oneSnapshot = (value: EspnLiveDraftSnapshot): EspnLiveDraftSnapshotResult => ({
  ok: true,
  snapshot: value,
});

describe("live draft observer", () => {
  it("emits a full snapshot on attach", () => {
    const test = harness(oneSnapshot(snapshot({ picks: [{}] })));
    test.observer.start();
    expect(test.snapshots).toEqual(["attach"]);
    expect(test.scans).toBe(1);
  });

  it("coalesces a burst of mutations into one debounced evaluation", () => {
    const test = harness(oneSnapshot(snapshot({ picks: [{}] })));
    test.observer.start();
    test.board = oneSnapshot(snapshot({ picks: [{}, { playerName: "Josh Allen" }] }));

    test.mutate(12);
    expect(test.scans).toBe(1);
    test.clock.advance(LIVE_DRAFT_OBSERVER_TUNING.debounceMs - 1);
    expect(test.scans).toBe(1);
    test.clock.advance(1);
    expect(test.scans).toBe(2);
    expect(test.snapshots).toEqual(["attach", "completed-pick"]);
  });

  it("rescans periodically so a mutation the observer never saw is still recovered", () => {
    const test = harness(oneSnapshot(snapshot({ picks: [{}] })));
    test.observer.start();
    // No mutation is delivered at all; only the periodic full rescan notices.
    test.board = oneSnapshot(snapshot({ picks: [{}, { playerName: "Josh Allen" }] }));
    test.clock.advance(LIVE_DRAFT_OBSERVER_TUNING.rescanIntervalMs);
    expect(test.snapshots).toEqual(["attach", "completed-pick"]);
  });

  it("says nothing when a rescan finds an unchanged board", () => {
    const test = harness(oneSnapshot(snapshot({ picks: [{}] })));
    test.observer.start();
    test.clock.advance(LIVE_DRAFT_OBSERVER_TUNING.rescanIntervalMs * 3);
    expect(test.snapshots).toEqual(["attach"]);
  });

  it("labels a completed auction sale distinctly from a snake pick", () => {
    const auction = (count: number) =>
      snapshot({
        draftType: "auction",
        picks: Array.from({ length: count }, (_, index) => ({ price: 10 + index })),
      });
    const test = harness(oneSnapshot(auction(1)));
    test.observer.start();
    test.board = oneSnapshot(auction(2));
    test.clock.advance(LIVE_DRAFT_OBSERVER_TUNING.rescanIntervalMs);
    expect(test.snapshots).toEqual(["attach", "completed-sale"]);
  });

  it("reports a rollback when the board shrinks or an accepted pick changes", () => {
    const test = harness(oneSnapshot(snapshot({ picks: [{}, { playerName: "Josh Allen" }] })));
    test.observer.start();
    test.board = oneSnapshot(snapshot({ picks: [{}] }));
    test.clock.advance(LIVE_DRAFT_OBSERVER_TUNING.rescanIntervalMs);

    const replaced = harness(oneSnapshot(snapshot({ picks: [{ playerName: "Josh Allen" }] })));
    replaced.observer.start();
    replaced.board = oneSnapshot(snapshot({ picks: [{ playerName: "Bijan Robinson" }] }));
    replaced.clock.advance(LIVE_DRAFT_OBSERVER_TUNING.rescanIntervalMs);

    expect(test.snapshots).toEqual(["attach", "rollback"]);
    expect(replaced.snapshots).toEqual(["attach", "rollback"]);
  });

  it("heartbeats about every five seconds while the draft is live", () => {
    const test = harness(oneSnapshot(snapshot({ picks: [{}] })));
    test.observer.start();
    test.clock.advance(LIVE_DRAFT_OBSERVER_TUNING.heartbeatIntervalMs * 3);
    expect(test.heartbeats).toEqual(["live", "live", "live"]);
  });

  it("does not heartbeat before the draft starts", () => {
    const test = harness(oneSnapshot(snapshot({ state: "waiting" })));
    test.observer.start();
    test.clock.advance(LIVE_DRAFT_OBSERVER_TUNING.heartbeatIntervalMs * 3);
    expect(test.heartbeats).toEqual([]);
  });

  it("stops high-cadence work once the draft completes but keeps a slow reconciliation rescan", () => {
    const test = harness(oneSnapshot(snapshot({ picks: [{}] })));
    test.observer.start();
    test.board = oneSnapshot(snapshot({ picks: [{}], state: "complete" }));
    test.clock.advance(LIVE_DRAFT_OBSERVER_TUNING.rescanIntervalMs);
    expect(test.snapshots).toEqual(["attach", "complete"]);
    expect(test.attached).toBe(false);

    const scansAtCompletion = test.scans;
    const heartbeatsAtCompletion = test.heartbeats.length;
    test.clock.advance(LIVE_DRAFT_OBSERVER_TUNING.rescanIntervalMs * 2);
    expect(test.scans).toBe(scansAtCompletion);
    expect(test.heartbeats).toHaveLength(heartbeatsAtCompletion);

    test.clock.advance(LIVE_DRAFT_OBSERVER_TUNING.completedRescanIntervalMs);
    expect(test.scans).toBeGreaterThan(scansAtCompletion);
  });

  it("bounds transient auction updates to two per second", () => {
    const nomination = (highBid: number): EspnLiveDraftCurrentAuctionV1 => ({
      nominationNumber: 4,
      nominatingProviderTeamId: "2",
      providerPlayerId: "4241389",
      playerName: "CeeDee Lamb",
      proTeam: "DAL",
      position: "WR",
      highBidProviderTeamId: "9",
      highBid,
    });
    const bidding = (highBid: number) =>
      snapshot({
        draftType: "auction",
        picks: [{ price: 12 }],
        currentAuction: nomination(highBid),
      });

    const test = harness(oneSnapshot(bidding(10)));
    test.observer.start();
    for (const bid of [11, 12, 13, 14]) {
      test.board = oneSnapshot(bidding(bid));
      test.observer.evaluate("rescan");
    }
    expect(test.transients).toHaveLength(2);
    expect(test.snapshots).toEqual(["attach"]);

    // The next second opens a fresh allowance.
    test.clock.advance(1_000);
    test.board = oneSnapshot(bidding(20));
    test.observer.evaluate("rescan");
    expect(test.transients).toHaveLength(3);
    expect(test.transients.at(-1)?.currentAuction?.highBid).toBe(20);
  });

  it("reports a failed scan without publishing anything and keeps the last good board", () => {
    const test = harness(oneSnapshot(snapshot({ picks: [{}] })));
    test.observer.start();
    const good = test.observer.lastDigestSource;
    test.board = { ok: false, reason: "draft-state-unknown" };
    test.clock.advance(LIVE_DRAFT_OBSERVER_TUNING.rescanIntervalMs);
    expect(test.failures).toEqual(["draft-state-unknown"]);
    expect(test.snapshots).toEqual(["attach"]);
    expect(test.observer.lastDigestSource).toBe(good);
  });

  it("stops every timer and detaches the mutation source on stop", () => {
    const test = harness(oneSnapshot(snapshot({ picks: [{}] })));
    test.observer.start();
    test.observer.stop();
    const scansAtStop = test.scans;
    test.clock.advance(LIVE_DRAFT_OBSERVER_TUNING.rescanIntervalMs * 4);
    test.mutate(5);
    expect(test.scans).toBe(scansAtStop);
    expect(test.heartbeats).toEqual([]);
    expect(test.attached).toBe(false);
    expect(test.observer.running).toBe(false);
  });
});
