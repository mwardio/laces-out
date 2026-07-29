/**
 * Change detection for a live draft room: a debounced mutation watcher plus a periodic full rescan.
 *
 * Every timer and DOM hook is injected, so the whole state machine — attach, debounce, rescan,
 * pick, sale, rollback, completion, heartbeat, and the bounded transient auction rate — is
 * exercised in node without a browser.
 *
 * The observer never touches the network and never sees the device credential. It hands sanitized
 * snapshots to a sink; the content script forwards them and only the service worker uploads.
 */

import {
  transientAuctionSignature,
  type EspnLiveDraftSnapshot,
  type EspnLiveDraftSnapshotFailure,
  type EspnLiveDraftSnapshotResult,
} from "./observation.js";
import { ESPN_LIVE_DRAFT_LIMITS, type EspnLiveDraftState } from "./dom-contract.js";

/**
 * Why a full snapshot is being emitted. Full snapshots are required on attach, reconnect, reload,
 * failover, completed pick, completed sale, rollback, and completion.
 */
export type LiveDraftSnapshotReason =
  "attach" | "reconnect" | "rescan" | "completed-pick" | "completed-sale" | "rollback" | "complete";

export interface LiveDraftTimers {
  now(): number;
  setTimeout(handler: () => void, delayMs: number): number;
  clearTimeout(handle: number): void;
  setInterval(handler: () => void, periodMs: number): number;
  clearInterval(handle: number): void;
}

/** The MutationObserver seam. The content script supplies a real observer; tests supply a stub. */
export interface LiveDraftMutationSource {
  start(onMutation: () => void): void;
  stop(): void;
}

export interface LiveDraftObserverSink {
  snapshot(snapshot: EspnLiveDraftSnapshot, reason: LiveDraftSnapshotReason): void;
  /** Bounded nomination/high-bid update: the durable board did not change. */
  transientAuction(snapshot: EspnLiveDraftSnapshot): void;
  heartbeat(state: EspnLiveDraftState): void;
  failure(reason: EspnLiveDraftSnapshotFailure): void;
}

export interface LiveDraftObserverTuning {
  /** Short debounce so a burst of render mutations becomes one evaluation. */
  readonly debounceMs: number;
  /** Full rescan cadence, recovering from mutations the observer never saw. */
  readonly rescanIntervalMs: number;
  /** Slow rescan retained after completion, in case a commissioner reopens the room. */
  readonly completedRescanIntervalMs: number;
  readonly heartbeatIntervalMs: number;
  readonly transientUploadsPerSecond: number;
}

export const LIVE_DRAFT_OBSERVER_TUNING: LiveDraftObserverTuning = {
  debounceMs: 250,
  rescanIntervalMs: 5_000,
  completedRescanIntervalMs: 30_000,
  heartbeatIntervalMs: ESPN_LIVE_DRAFT_LIMITS.heartbeatIntervalMs,
  transientUploadsPerSecond: ESPN_LIVE_DRAFT_LIMITS.transientUploadsPerSecond,
};

export interface LiveDraftObserverOptions {
  /** Reads the DOM and returns a sanitized board. Injected so the observer stays DOM-free. */
  readonly scan: () => EspnLiveDraftSnapshotResult;
  readonly sink: LiveDraftObserverSink;
  readonly timers: LiveDraftTimers;
  readonly mutations: LiveDraftMutationSource;
  readonly tuning?: Partial<LiveDraftObserverTuning>;
}

export interface LiveDraftObserver {
  /** Attaches the mutation source and timers and emits the first full snapshot. */
  start(): void;
  /** Forces an immediate evaluation, e.g. after the service worker asks for a resend. */
  evaluate(reason: "reconnect" | "rescan"): void;
  stop(): void;
  readonly running: boolean;
  readonly lastDigestSource: string | null;
}

function tuned(tuning: Partial<LiveDraftObserverTuning> | undefined): LiveDraftObserverTuning {
  return {
    debounceMs: tuning?.debounceMs ?? LIVE_DRAFT_OBSERVER_TUNING.debounceMs,
    rescanIntervalMs: tuning?.rescanIntervalMs ?? LIVE_DRAFT_OBSERVER_TUNING.rescanIntervalMs,
    completedRescanIntervalMs:
      tuning?.completedRescanIntervalMs ?? LIVE_DRAFT_OBSERVER_TUNING.completedRescanIntervalMs,
    heartbeatIntervalMs:
      tuning?.heartbeatIntervalMs ?? LIVE_DRAFT_OBSERVER_TUNING.heartbeatIntervalMs,
    transientUploadsPerSecond:
      tuning?.transientUploadsPerSecond ?? LIVE_DRAFT_OBSERVER_TUNING.transientUploadsPerSecond,
  };
}

/**
 * Classifies a durable board change.
 *
 * A shrinking board, or any change to a pick the previous snapshot already reported, is a rollback:
 * the server holds those until it sees the same destructive snapshot twice, so misreading a
 * half-rendered table here costs a delay rather than corrupted history.
 */
function classify(
  previous: EspnLiveDraftSnapshot | null,
  next: EspnLiveDraftSnapshot,
): LiveDraftSnapshotReason {
  if (previous === null) return "attach";
  if (next.state === "complete" && previous.state !== "complete") return "complete";
  if (next.picks.length < previous.picks.length) return "rollback";
  for (const [index, pick] of previous.picks.entries()) {
    const candidate = next.picks[index];
    if (candidate === undefined) return "rollback";
    if (
      candidate.sequence !== pick.sequence ||
      candidate.playerName !== pick.playerName ||
      candidate.providerPlayerId !== pick.providerPlayerId ||
      candidate.teamName !== pick.teamName ||
      candidate.providerTeamId !== pick.providerTeamId ||
      candidate.price !== pick.price ||
      candidate.keeper !== pick.keeper
    ) {
      return "rollback";
    }
  }
  if (next.picks.length > previous.picks.length) {
    return next.draftType === "auction" ? "completed-sale" : "completed-pick";
  }
  return "rescan";
}

export function createLiveDraftObserver(options: LiveDraftObserverOptions): LiveDraftObserver {
  const tuning = tuned(options.tuning);
  const { scan, sink, timers, mutations } = options;

  let running = false;
  let debounceHandle: number | null = null;
  let rescanHandle: number | null = null;
  let heartbeatHandle: number | null = null;
  let previous: EspnLiveDraftSnapshot | null = null;
  let transientSignature = "none";
  let transientWindowStart = 0;
  let transientWindowCount = 0;

  function clearDebounce(): void {
    if (debounceHandle !== null) {
      timers.clearTimeout(debounceHandle);
      debounceHandle = null;
    }
  }

  function stopInterval(handle: number | null): null {
    if (handle !== null) timers.clearInterval(handle);
    return null;
  }

  // Token bucket. A bidding war must not turn into an upload storm; the durable board still gets
  // through because a real sale changes the digest and takes the full-snapshot path instead.
  function transientAllowed(): boolean {
    const now = timers.now();
    if (now - transientWindowStart >= 1_000) {
      transientWindowStart = now;
      transientWindowCount = 0;
    }
    if (transientWindowCount >= tuning.transientUploadsPerSecond) return false;
    transientWindowCount += 1;
    return true;
  }

  function startHeartbeat(): void {
    if (heartbeatHandle !== null) return;
    heartbeatHandle = timers.setInterval(() => {
      const state = previous?.state;
      if (state === "live" || state === "paused") sink.heartbeat(state);
    }, tuning.heartbeatIntervalMs);
  }

  function restartRescan(periodMs: number): void {
    rescanHandle = stopInterval(rescanHandle);
    rescanHandle = timers.setInterval(() => {
      evaluate("rescan");
    }, periodMs);
  }

  // Completion is the end of high-cadence work: mutations and heartbeats stop, and only a slow
  // reconciliation rescan remains so a reopened or corrected room is still noticed.
  function settleCompleted(): void {
    mutations.stop();
    clearDebounce();
    heartbeatHandle = stopInterval(heartbeatHandle);
    restartRescan(tuning.completedRescanIntervalMs);
  }

  function evaluate(reason: "reconnect" | "rescan"): void {
    if (!running) return;
    clearDebounce();
    const result = scan();
    if (!result.ok) {
      sink.failure(result.reason);
      return;
    }
    const snapshot = result.snapshot;
    if (previous !== null && snapshot.digestSource === previous.digestSource) {
      const signature = transientAuctionSignature(snapshot);
      if (signature !== transientSignature && transientAllowed()) {
        transientSignature = signature;
        previous = snapshot;
        sink.transientAuction(snapshot);
      }
      return;
    }
    const classified =
      previous === null && reason === "reconnect" ? "reconnect" : classify(previous, snapshot);
    previous = snapshot;
    transientSignature = transientAuctionSignature(snapshot);
    sink.snapshot(snapshot, classified);
    if (snapshot.state === "complete") settleCompleted();
  }

  return {
    start(): void {
      if (running) return;
      running = true;
      mutations.start(() => {
        if (!running) return;
        clearDebounce();
        debounceHandle = timers.setTimeout(() => {
          debounceHandle = null;
          evaluate("rescan");
        }, tuning.debounceMs);
      });
      restartRescan(tuning.rescanIntervalMs);
      startHeartbeat();
      transientWindowStart = timers.now();
      evaluate("rescan");
    },
    evaluate(reason): void {
      evaluate(reason);
    },
    stop(): void {
      if (!running) return;
      running = false;
      mutations.stop();
      clearDebounce();
      rescanHandle = stopInterval(rescanHandle);
      heartbeatHandle = stopInterval(heartbeatHandle);
    },
    get running(): boolean {
      return running;
    },
    get lastDigestSource(): string | null {
      return previous?.digestSource ?? null;
    },
  };
}
