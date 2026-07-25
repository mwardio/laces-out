/**
 * Service-worker side of the live draft feed: sender validation, league-scope enforcement, the
 * bounded retry schedule, and the replace-latest upload queue.
 *
 * This lives beside the browser modules rather than inside `service-worker.ts` for one reason: the
 * service worker registers chrome listeners at import time and cannot be loaded in a node test,
 * while every rule in this file — who may send an observation, which league it may claim, how often
 * a failed upload is retried, and what happens to a queued snapshot that a newer one supersedes —
 * has to be tested. The service worker keeps the parts that genuinely need chrome: storage, the
 * device credential, and `fetch`.
 *
 * The device credential never appears here. `LiveDraftUploadTransport` is supplied by the service
 * worker already bound to the authenticated request; nothing in this module can read or echo it.
 */

import { recognizeEspnDraftRoute, type EspnDraftRoute } from "./dom-adapter.js";
import {
  ESPN_LIVE_DRAFT_LIMITS,
  espnLiveDraftBodyBytes,
  type EspnLiveDraftHeartbeatV1,
  type EspnLiveDraftObservationV1,
} from "./dom-contract.js";

export const liveDraftStatusStorageKey = "lacesOutEspnLiveDraftStatus";
export const liveDraftPendingStorageKey = "lacesOutEspnLiveDraftPending";
export const liveDraftIngestPath = "/v1/bridge/espn/live-draft";

/** The chrome `MessageSender` fields this module needs. Structurally satisfied by the real type. */
export interface LiveDraftMessageSender {
  readonly id?: string | undefined;
  readonly url?: string | undefined;
  readonly origin?: string | undefined;
  readonly frameId?: number | undefined;
  readonly tab?: { readonly id?: number | undefined } | undefined;
}

export type LiveDraftSenderRejection =
  "foreign-extension" | "not-a-content-script" | "not-top-frame" | "not-a-draft-route";

export type LiveDraftSenderResult =
  | { readonly ok: true; readonly route: EspnDraftRoute }
  | { readonly ok: false; readonly reason: LiveDraftSenderRejection };

/**
 * Confirms a message came from this extension's own content script running at the top frame of a
 * recognized ESPN draft URL.
 *
 * The ESPN page is untrusted input. Chrome attests `sender.id`, `sender.tab`, `sender.frameId`, and
 * `sender.url`, so this check — not anything in the message body — decides which league the sender
 * is even allowed to claim. A subframe or another extension is refused outright.
 */
export function validateLiveDraftSender(
  sender: LiveDraftMessageSender | undefined,
  extensionId: string,
): LiveDraftSenderResult {
  if (!sender || sender.id !== extensionId) return { ok: false, reason: "foreign-extension" };
  if (!sender.tab || typeof sender.tab.id !== "number") {
    return { ok: false, reason: "not-a-content-script" };
  }
  if (sender.frameId !== 0) return { ok: false, reason: "not-top-frame" };
  const route = recognizeEspnDraftRoute(sender.url ?? "", {
    minimum: ESPN_LIVE_DRAFT_LIMITS.minimumSeason,
    maximum: ESPN_LIVE_DRAFT_LIMITS.maximumSeason,
  });
  if (route === null) return { ok: false, reason: "not-a-draft-route" };
  return { ok: true, route };
}

export type LiveDraftScopeRejection =
  "not-configured" | "league-not-in-scope" | "season-mismatch" | "route-league-mismatch";

export interface LiveDraftScopeConfiguration {
  readonly leagueIds: readonly string[];
  readonly season: number;
}

export type LiveDraftScopeResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: LiveDraftScopeRejection };

/**
 * Requires the claimed league and season to match both the browser-attested URL and the stored
 * bridge scope. A page mutation cannot select another league, and a device cannot submit for a
 * league it was never paired with.
 */
export function validateLiveDraftScope(
  claim: { readonly leagueId: string; readonly season: number },
  route: EspnDraftRoute,
  configuration: LiveDraftScopeConfiguration | undefined,
): LiveDraftScopeResult {
  if (claim.leagueId !== route.leagueId || claim.season !== route.season) {
    return { ok: false, reason: "route-league-mismatch" };
  }
  if (!configuration) return { ok: false, reason: "not-configured" };
  if (!configuration.leagueIds.includes(claim.leagueId)) {
    return { ok: false, reason: "league-not-in-scope" };
  }
  if (configuration.season !== claim.season) return { ok: false, reason: "season-mismatch" };
  return { ok: true };
}

/** Bounded retry schedule for a live upload. */
export const LIVE_DRAFT_RETRY = {
  maximumAttempts: 4,
  baseDelayMs: 1_000,
  maximumDelayMs: 15_000,
} as const;

/**
 * Exponential backoff with full-width jitter over the lower half of each step.
 *
 * Jitter matters more than usual here: every league member's bridge retries against the same API,
 * and a draft is exactly when they are all awake at once.
 */
export function liveDraftRetryDelayMs(attempt: number, random: number): number {
  const step = Math.min(
    LIVE_DRAFT_RETRY.baseDelayMs * 2 ** Math.max(0, attempt - 1),
    LIVE_DRAFT_RETRY.maximumDelayMs,
  );
  const bounded = Math.min(Math.max(random, 0), 1);
  return Math.round(step * (0.5 + 0.5 * bounded));
}

export type LiveDraftUploadOutcome =
  | { readonly kind: "accepted" }
  | { readonly kind: "rejected"; readonly statusCode: number }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "retry" };

export type LiveDraftUploadTransport = (body: string) => Promise<LiveDraftUploadOutcome>;

export type LiveDraftUploadSlot = "snapshot" | "transient";

export type LiveDraftQueueEvent =
  | {
      readonly kind: "settled";
      readonly slot: LiveDraftUploadSlot;
      readonly outcome: LiveDraftUploadOutcome;
    }
  | { readonly kind: "retrying"; readonly slot: LiveDraftUploadSlot; readonly delayMs: number }
  | { readonly kind: "abandoned"; readonly slot: LiveDraftUploadSlot }
  | { readonly kind: "oversized"; readonly slot: LiveDraftUploadSlot };

export interface LiveDraftQueueDependencies {
  readonly transport: LiveDraftUploadTransport;
  readonly sleep: (delayMs: number) => Promise<void>;
  readonly random: () => number;
  readonly onEvent: (event: LiveDraftQueueEvent) => void;
}

/**
 * Holds at most the latest full snapshot plus the latest transient auction state (plan 8.4).
 *
 * Submitting a newer observation replaces the queued one instead of appending, so a slow network
 * never causes a replay of every intermediate mutation — the board is cumulative, so the newest
 * snapshot subsumes all of them. A full snapshot also clears any queued transient update, which the
 * snapshot already carries.
 */
export class LiveDraftUploadQueue {
  #snapshot: EspnLiveDraftObservationV1 | null = null;
  #transient: EspnLiveDraftObservationV1 | null = null;
  #draining: Promise<void> | null = null;

  constructor(private readonly dependencies: LiveDraftQueueDependencies) {}

  get queued(): { readonly snapshot: boolean; readonly transient: boolean } {
    return { snapshot: this.#snapshot !== null, transient: this.#transient !== null };
  }

  get pendingSnapshot(): EspnLiveDraftObservationV1 | null {
    return this.#snapshot;
  }

  submit(observation: EspnLiveDraftObservationV1, slot: LiveDraftUploadSlot): Promise<void> {
    if (slot === "snapshot") {
      this.#snapshot = observation;
      this.#transient = null;
    } else {
      this.#transient = observation;
    }
    return this.drain();
  }

  clear(): void {
    this.#snapshot = null;
    this.#transient = null;
  }

  drain(): Promise<void> {
    this.#draining ??= this.#run().finally(() => {
      this.#draining = null;
    });
    return this.#draining;
  }

  async #run(): Promise<void> {
    for (;;) {
      const slot: LiveDraftUploadSlot = this.#snapshot !== null ? "snapshot" : "transient";
      const observation = slot === "snapshot" ? this.#snapshot : this.#transient;
      if (observation === null) return;
      const body = JSON.stringify(observation);
      if (espnLiveDraftBodyBytes(body) > ESPN_LIVE_DRAFT_LIMITS.maximumBodyBytes) {
        this.#release(slot, observation);
        this.dependencies.onEvent({ kind: "oversized", slot });
        continue;
      }
      const outcome = await this.#attempt(body, slot);
      if (outcome === null) {
        this.#release(slot, observation);
        this.dependencies.onEvent({ kind: "abandoned", slot });
        continue;
      }
      this.#release(slot, observation);
      this.dependencies.onEvent({ kind: "settled", slot, outcome });
    }
  }

  /** Runs the bounded retry loop for one body. Returns null when every attempt was exhausted. */
  async #attempt(body: string, slot: LiveDraftUploadSlot): Promise<LiveDraftUploadOutcome | null> {
    for (let attempt = 1; attempt <= LIVE_DRAFT_RETRY.maximumAttempts; attempt += 1) {
      const outcome = await this.dependencies.transport(body);
      if (outcome.kind !== "retry") return outcome;
      if (attempt === LIVE_DRAFT_RETRY.maximumAttempts) return null;
      const delayMs = liveDraftRetryDelayMs(attempt, this.dependencies.random());
      this.dependencies.onEvent({ kind: "retrying", slot, delayMs });
      await this.dependencies.sleep(delayMs);
      // A newer observation arriving mid-backoff supersedes this one outright: sending the stale
      // body would only be overwritten a moment later.
      const current = slot === "snapshot" ? this.#snapshot : this.#transient;
      if (current !== null && JSON.stringify(current) !== body) return { kind: "accepted" };
    }
    return null;
  }

  /** Clears a slot only when a newer observation has not already replaced its contents. */
  #release(slot: LiveDraftUploadSlot, observation: EspnLiveDraftObservationV1): void {
    if (slot === "snapshot") {
      if (this.#snapshot === observation) this.#snapshot = null;
    } else if (this.#transient === observation) {
      this.#transient = null;
    }
  }
}

export type LiveDraftFeedState =
  | "idle"
  | "observing"
  | "accepted"
  | "standby"
  | "held"
  | "rejected"
  | "offline"
  | "unauthorized"
  | "complete"
  | "error";

/**
 * Bounded status shown in the popup and returned to the content script.
 *
 * Deliberately carries no device token, no ESPN identity, and no provider text beyond a fixed
 * message vocabulary the extension itself writes.
 */
export interface BridgeLiveDraftStatus {
  readonly scope: "not-configured" | "out-of-scope" | "in-scope";
  readonly state: LiveDraftFeedState;
  readonly message: string;
  readonly leagueId: string | null;
  readonly season: number | null;
  readonly draftState: "waiting" | "live" | "paused" | "complete" | null;
  readonly pickCount: number;
  readonly lastObservedAt: string | null;
  readonly lastAcceptedAt: string | null;
  readonly lastChecksumSha256: string | null;
  readonly queuedSnapshot: boolean;
  readonly consecutiveFailures: number;
}

export const defaultLiveDraftStatus: BridgeLiveDraftStatus = {
  scope: "not-configured",
  state: "idle",
  message: "No ESPN draft room is open in this browser.",
  leagueId: null,
  season: null,
  draftState: null,
  pickCount: 0,
  lastObservedAt: null,
  lastAcceptedAt: null,
  lastChecksumSha256: null,
  queuedSnapshot: false,
  consecutiveFailures: 0,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads stored live-draft status, failing closed to the default on anything malformed. */
export function validateStoredLiveDraftStatus(value: unknown): BridgeLiveDraftStatus {
  if (!isRecord(value)) return defaultLiveDraftStatus;
  const scopes = ["not-configured", "out-of-scope", "in-scope"];
  const states: readonly string[] = [
    "idle",
    "observing",
    "accepted",
    "standby",
    "held",
    "rejected",
    "offline",
    "unauthorized",
    "complete",
    "error",
  ];
  const draftStates = ["waiting", "live", "paused", "complete"];
  if (
    !scopes.includes(String(value.scope)) ||
    !states.includes(String(value.state)) ||
    typeof value.message !== "string" ||
    value.message.length > 180 ||
    !(
      value.leagueId === null ||
      (typeof value.leagueId === "string" && /^\d{1,20}$/u.test(value.leagueId))
    ) ||
    !(
      value.season === null ||
      (typeof value.season === "number" && Number.isSafeInteger(value.season))
    ) ||
    !(
      value.draftState === null ||
      (typeof value.draftState === "string" && draftStates.includes(value.draftState))
    ) ||
    typeof value.pickCount !== "number" ||
    !Number.isSafeInteger(value.pickCount) ||
    value.pickCount < 0 ||
    value.pickCount > ESPN_LIVE_DRAFT_LIMITS.maximumPicks ||
    typeof value.queuedSnapshot !== "boolean" ||
    typeof value.consecutiveFailures !== "number" ||
    !Number.isSafeInteger(value.consecutiveFailures) ||
    value.consecutiveFailures < 0
  ) {
    return defaultLiveDraftStatus;
  }
  return {
    scope: value.scope as BridgeLiveDraftStatus["scope"],
    state: value.state as LiveDraftFeedState,
    message: value.message,
    leagueId: value.leagueId,
    season: value.season,
    draftState: value.draftState as BridgeLiveDraftStatus["draftState"],
    pickCount: value.pickCount,
    lastObservedAt: typeof value.lastObservedAt === "string" ? value.lastObservedAt : null,
    lastAcceptedAt: typeof value.lastAcceptedAt === "string" ? value.lastAcceptedAt : null,
    lastChecksumSha256:
      typeof value.lastChecksumSha256 === "string" &&
      /^[a-f0-9]{64}$/u.test(value.lastChecksumSha256)
        ? value.lastChecksumSha256
        : null,
    queuedSnapshot: value.queuedSnapshot,
    consecutiveFailures: value.consecutiveFailures,
  };
}

/** Maps a heartbeat or observation upload response status code to a bounded outcome. */
export function classifyUploadStatus(statusCode: number): LiveDraftUploadOutcome {
  if (statusCode >= 200 && statusCode < 300) return { kind: "accepted" };
  if (statusCode === 401 || statusCode === 403) return { kind: "unauthorized" };
  if (statusCode === 408 || statusCode === 429 || statusCode >= 500) return { kind: "retry" };
  return { kind: "rejected", statusCode };
}

export type { EspnLiveDraftHeartbeatV1, EspnLiveDraftObservationV1 };
