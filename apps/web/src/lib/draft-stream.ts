import { draftStreamInvalidationSchema, type DraftStreamInvalidation } from "@laces-out/contracts";

/**
 * Where this client is getting its updates.
 *
 * `polling` is not an error state: the five-second reload loop keeps the room correct on its own.
 * The stream is only a latency optimization, so the UI says "every 5 seconds" rather than warning.
 */
export type DraftStreamState = "connecting" | "streaming" | "polling";

export interface DraftStreamHandlers {
  readonly onOpen: () => void;
  readonly onMessage: (data: unknown) => void;
  readonly onError: () => void;
}

export interface DraftStreamConnection {
  readonly close: () => void;
}

/**
 * Injected so the controller can be exercised without a browser. The component supplies an adapter
 * that builds a real `EventSource`; a test supplies a fake that it drives by hand.
 */
export type DraftStreamConnect = (
  url: string,
  handlers: DraftStreamHandlers,
) => DraftStreamConnection;

export interface DraftStreamOptions {
  readonly draftId: string;
  readonly url: string;
  readonly connect: DraftStreamConnect;
  readonly onInvalidate: (invalidation: DraftStreamInvalidation) => void;
  readonly onStateChange?: (state: DraftStreamState) => void;
  readonly setTimer: (handler: () => void, delayMs: number) => number;
  readonly clearTimer: (handle: number) => void;
  /** Consecutive failed attempts before the UI is told it is polling only. */
  readonly pollingAfterAttempts?: number;
  /** Consecutive failed attempts before reconnection stops entirely. */
  readonly maximumAttempts?: number;
}

export interface DraftStreamSubscription {
  readonly close: () => void;
  /** Restarts a subscription that gave up, e.g. when a backgrounded tab becomes visible. */
  readonly retry: () => void;
  readonly state: () => DraftStreamState;
}

const BASE_DELAY_MS = 1_000;
const MAXIMUM_DELAY_MS = 30_000;
const DEFAULT_POLLING_AFTER_ATTEMPTS = 2;
const DEFAULT_MAXIMUM_ATTEMPTS = 12;

/**
 * Deterministic exponential backoff, capped. No jitter: a fantasy league is a handful of clients,
 * and a predictable delay is worth more in tests than thundering-herd protection is here.
 */
export function draftStreamBackoffMs(attempt: number): number {
  if (attempt <= 1) return BASE_DELAY_MS;
  return Math.min(MAXIMUM_DELAY_MS, BASE_DELAY_MS * 2 ** (attempt - 1));
}

/**
 * True only when the candidate is strictly ahead of what has already been applied.
 *
 * A stream can redeliver on reconnect, and an out-of-order or replayed frame must never trigger a
 * reload that could race a newer one. `preferNewerDraftSnapshot` guards the snapshot itself; this
 * guards the invalidation that asks for it.
 */
export function draftStreamAdvances(
  applied: DraftStreamCoordinate | null,
  candidate: DraftStreamCoordinate,
): boolean {
  if (applied === null) return true;
  if (candidate.sequence > applied.sequence) return true;
  if (candidate.sequence < applied.sequence) return false;
  // Current servers encode source generation plus page revision in this established numeric field,
  // so it cannot rewind on reload/takeover. The comparison also remains compatible with an older
  // revision-only server during a rolling deployment.
  return candidate.feedRevision > applied.feedRevision;
}

type DraftStreamCoordinate = Pick<DraftStreamInvalidation, "sequence" | "feedRevision">;

/**
 * Parses one stream frame. Returns null for anything that is not a valid invalidation for this
 * draft, so a malformed or cross-room frame is dropped rather than reloading the wrong session.
 */
export function parseDraftStreamFrame(
  draftId: string,
  data: unknown,
): DraftStreamInvalidation | null {
  let payload: unknown = data;
  if (typeof data === "string") {
    try {
      payload = JSON.parse(data);
    } catch {
      return null;
    }
  }
  const result = draftStreamInvalidationSchema.safeParse(payload);
  if (!result.success) return null;
  return result.data.draftId === draftId ? result.data : null;
}

export function subscribeToDraftStream(options: DraftStreamOptions): DraftStreamSubscription {
  const pollingAfter = options.pollingAfterAttempts ?? DEFAULT_POLLING_AFTER_ATTEMPTS;
  const maximumAttempts = options.maximumAttempts ?? DEFAULT_MAXIMUM_ATTEMPTS;

  let connection: DraftStreamConnection | null = null;
  let timer: number | null = null;
  let attempts = 0;
  let applied: DraftStreamCoordinate | null = null;
  let state: DraftStreamState = "connecting";
  let closed = false;

  const publish = (next: DraftStreamState) => {
    if (state === next) return;
    state = next;
    options.onStateChange?.(next);
  };

  const clearPendingTimer = () => {
    if (timer !== null) {
      options.clearTimer(timer);
      timer = null;
    }
  };

  const scheduleReconnect = () => {
    if (closed) return;
    if (attempts >= pollingAfter) publish("polling");
    if (attempts >= maximumAttempts) return;
    clearPendingTimer();
    timer = options.setTimer(() => {
      timer = null;
      open();
    }, draftStreamBackoffMs(attempts));
  };

  const handleFailure = () => {
    if (closed) return;
    connection?.close();
    connection = null;
    attempts += 1;
    scheduleReconnect();
  };

  function open() {
    if (closed || connection !== null) return;
    if (state !== "polling") publish("connecting");
    connection = options.connect(options.url, {
      onOpen: () => {
        if (closed) return;
        attempts = 0;
        publish("streaming");
      },
      onMessage: (data) => {
        if (closed) return;
        const invalidation = parseDraftStreamFrame(options.draftId, data);
        if (!invalidation) return;
        if (!draftStreamAdvances(applied, invalidation)) return;
        applied = invalidation;
        options.onInvalidate(invalidation);
      },
      onError: handleFailure,
    });
  }

  open();

  return {
    close: () => {
      closed = true;
      clearPendingTimer();
      connection?.close();
      connection = null;
    },
    retry: () => {
      if (closed || connection !== null) return;
      clearPendingTimer();
      attempts = 0;
      open();
    },
    state: () => state,
  };
}

/** The API tags invalidations with this name; the default `message` type is accepted too. */
export const DRAFT_STREAM_EVENT_NAME = "draft-invalidated";

/**
 * Adapter over the browser `EventSource`. Kept here so the controller above stays DOM-free and the
 * component never has to know the event names.
 *
 * `withCredentials` carries the existing session cookie; the stream is authenticated exactly like
 * every other draft read. Keep-alive comments are dropped by `EventSource` itself, so they never
 * reach the frame parser.
 */
export function browserDraftStreamConnect(
  url: string,
  handlers: DraftStreamHandlers,
): DraftStreamConnection {
  const source = new EventSource(url, { withCredentials: true });
  const onOpen = () => handlers.onOpen();
  const onMessage = (event: MessageEvent<unknown>) => handlers.onMessage(event.data);
  const onError = () => handlers.onError();
  source.addEventListener("open", onOpen);
  source.addEventListener("message", onMessage);
  source.addEventListener(DRAFT_STREAM_EVENT_NAME, onMessage);
  source.addEventListener("error", onError);
  return {
    close: () => {
      source.removeEventListener("open", onOpen);
      source.removeEventListener("message", onMessage);
      source.removeEventListener(DRAFT_STREAM_EVENT_NAME, onMessage);
      source.removeEventListener("error", onError);
      source.close();
    },
  };
}
