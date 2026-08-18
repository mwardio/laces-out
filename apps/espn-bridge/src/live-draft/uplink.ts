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

import { ESPN_DRAFT_ROUTES, recognizeEspnDraftRoute, type EspnDraftRoute } from "./dom-adapter.js";
import {
  ESPN_LIVE_DRAFT_LIMITS,
  espnLiveDraftBodyBytes,
  type EspnLiveDraftHeartbeatV1,
  type EspnLiveDraftObservationV1,
} from "./dom-contract.js";

export const liveDraftStatusStorageKey = "lacesOutEspnLiveDraftStatus";
export const liveDraftPendingStorageKey = "lacesOutEspnLiveDraftPending";
/** Session-only source lease; never exposed to the ESPN page or popup status. */
export const liveDraftActiveSessionStorageKey = "lacesOutEspnLiveDraftActiveSession";
export const liveDraftIngestPath = "/v1/bridge/espn/live-draft";

export const liveDraftActiveSessionTtlMs = ESPN_LIVE_DRAFT_LIMITS.failoverEligibleMs;

export interface LiveDraftPageSession {
  readonly leagueId: string;
  readonly season: number;
  readonly pageSessionId: string;
  readonly tabId: number;
}

export interface StoredLiveDraftPageSession extends LiveDraftPageSession {
  readonly lastSeenAtMs: number;
  /** Stops queue/status effects after PAGE_LEFT while preserving the server-aligned takeover TTL. */
  readonly departed: boolean;
}

export type LiveDraftPageSessionClaim =
  | {
      readonly outcome: "acquired" | "renewed";
      readonly active: StoredLiveDraftPageSession;
      readonly replaced: StoredLiveDraftPageSession | null;
    }
  | {
      readonly outcome: "standby";
      readonly active: StoredLiveDraftPageSession;
      readonly replaced: null;
    };

const pageSessionIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function validLiveDraftPageSessionId(value: unknown): value is string {
  return typeof value === "string" && pageSessionIdPattern.test(value);
}

export function validateStoredLiveDraftPageSession(
  value: unknown,
): StoredLiveDraftPageSession | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.leagueId !== "string" ||
    !/^\d{1,20}$/u.test(value.leagueId) ||
    typeof value.season !== "number" ||
    !Number.isSafeInteger(value.season) ||
    value.season < ESPN_LIVE_DRAFT_LIMITS.minimumSeason ||
    value.season > ESPN_LIVE_DRAFT_LIMITS.maximumSeason ||
    !validLiveDraftPageSessionId(value.pageSessionId) ||
    typeof value.tabId !== "number" ||
    !Number.isSafeInteger(value.tabId) ||
    value.tabId < 0 ||
    typeof value.lastSeenAtMs !== "number" ||
    !Number.isSafeInteger(value.lastSeenAtMs) ||
    value.lastSeenAtMs < 0 ||
    !(value.departed === undefined || typeof value.departed === "boolean")
  ) {
    return null;
  }
  return {
    leagueId: value.leagueId,
    season: value.season,
    pageSessionId: value.pageSessionId,
    tabId: value.tabId,
    lastSeenAtMs: value.lastSeenAtMs,
    departed: value.departed ?? false,
  };
}

export function sameLiveDraftPageSession(
  left: LiveDraftPageSession,
  right: LiveDraftPageSession,
): boolean {
  return (
    left.leagueId === right.leagueId &&
    left.season === right.season &&
    left.pageSessionId === right.pageSessionId &&
    left.tabId === right.tabId
  );
}

export function liveDraftPageSessionIsCurrent(
  active: StoredLiveDraftPageSession,
  candidate: LiveDraftPageSession,
  nowMs: number,
  ttlMs = liveDraftActiveSessionTtlMs,
): boolean {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    return false;
  }
  const ageMs = nowMs - active.lastSeenAtMs;
  return (
    !active.departed && ageMs >= 0 && ageMs < ttlMs && sameLiveDraftPageSession(active, candidate)
  );
}

/**
 * Browser-local companion to the server source lease. One tab is active at a time; another may
 * take over only after the same failover window the server uses. A backward clock jump expires the
 * local claim instead of pinning a corrupt future timestamp indefinitely.
 */
export function claimLiveDraftPageSession(
  stored: unknown,
  candidate: LiveDraftPageSession,
  nowMs: number,
  ttlMs = liveDraftActiveSessionTtlMs,
): LiveDraftPageSessionClaim {
  if (
    !/^\d{1,20}$/u.test(candidate.leagueId) ||
    !Number.isSafeInteger(candidate.season) ||
    candidate.season < ESPN_LIVE_DRAFT_LIMITS.minimumSeason ||
    candidate.season > ESPN_LIVE_DRAFT_LIMITS.maximumSeason ||
    !validLiveDraftPageSessionId(candidate.pageSessionId) ||
    !Number.isSafeInteger(candidate.tabId) ||
    candidate.tabId < 0 ||
    !Number.isSafeInteger(nowMs) ||
    nowMs < 0 ||
    !Number.isSafeInteger(ttlMs) ||
    ttlMs <= 0
  ) {
    throw new TypeError("Live draft page session claim is invalid");
  }
  const current = validateStoredLiveDraftPageSession(stored);
  const next = { ...candidate, lastSeenAtMs: nowMs, departed: false };
  if (current === null) return { outcome: "acquired", active: next, replaced: null };
  const ageMs = nowMs - current.lastSeenAtMs;
  if (!current.departed && sameLiveDraftPageSession(current, candidate)) {
    return { outcome: "renewed", active: next, replaced: null };
  }
  if (ageMs < 0 || ageMs >= ttlMs) {
    return { outcome: "acquired", active: next, replaced: current };
  }
  return { outcome: "standby", active: current, replaced: null };
}

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
  | { readonly ok: true; readonly route: LiveDraftPageRoute }
  | { readonly ok: false; readonly reason: LiveDraftSenderRejection };

/** A browser-attested draft route may omit its season until paired preflight resolves it. */
export interface LiveDraftPageRoute {
  readonly leagueId: string;
  readonly season?: number;
}

/**
 * Recognizes the same exact ESPN draft route as the DOM adapter while allowing only one additional
 * form: a numeric league ID with no season parameter at all. A present but malformed season still
 * fails closed, and this function never substitutes a calendar year.
 */
export function recognizeLiveDraftPageRoute(
  href: string,
  seasonBounds: { readonly minimum: number; readonly maximum: number },
): LiveDraftPageRoute | null {
  const exact = recognizeEspnDraftRoute(href, seasonBounds);
  if (exact !== null) return exact;

  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== ESPN_DRAFT_ROUTES.host) return null;
  if (!ESPN_DRAFT_ROUTES.pathnames.some((pathname) => pathname === url.pathname)) return null;
  if (ESPN_DRAFT_ROUTES.seasonParameters.some((parameter) => url.searchParams.has(parameter))) {
    return null;
  }
  const leagueIds = ESPN_DRAFT_ROUTES.leagueIdParameters.flatMap((parameter) =>
    url.searchParams.getAll(parameter),
  );
  if (leagueIds.length !== 1) return null;
  const leagueId = leagueIds[0];
  return leagueId !== undefined && /^\d{1,20}$/u.test(leagueId) ? { leagueId } : null;
}

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
  const route = recognizeLiveDraftPageRoute(sender.url ?? "", {
    minimum: ESPN_LIVE_DRAFT_LIMITS.minimumSeason,
    maximum: ESPN_LIVE_DRAFT_LIMITS.maximumSeason,
  });
  if (route === null) return { ok: false, reason: "not-a-draft-route" };
  return { ok: true, route };
}

export type LiveDraftScopeRejection =
  | "not-configured"
  | "league-not-in-scope"
  | "season-mismatch"
  | "season-ambiguous"
  | "route-league-mismatch";

export interface LiveDraftScopeConfiguration {
  readonly leagueIds: readonly string[];
  readonly season: number;
}

export type LiveDraftScopeResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: LiveDraftScopeRejection };

export type LiveDraftScopeResolution =
  | { readonly ok: true; readonly scope: EspnDraftRoute }
  | { readonly ok: false; readonly reason: LiveDraftScopeRejection };

/**
 * Resolves a browser-attested route to one exact paired league-season scope. Multiple configured
 * seasons are accepted only when the URL itself selected one; a seasonless URL must have exactly
 * one distinct paired season for its league.
 */
export function resolveLiveDraftPageScope(
  route: LiveDraftPageRoute,
  configurations: readonly LiveDraftScopeConfiguration[],
): LiveDraftScopeResolution {
  if (configurations.length === 0) return { ok: false, reason: "not-configured" };
  const matching = configurations.filter((configuration) =>
    configuration.leagueIds.includes(route.leagueId),
  );
  if (matching.length === 0) return { ok: false, reason: "league-not-in-scope" };

  if (route.season !== undefined) {
    return matching.some((configuration) => configuration.season === route.season)
      ? { ok: true, scope: { leagueId: route.leagueId, season: route.season } }
      : { ok: false, reason: "season-mismatch" };
  }

  const validSeasons = matching.map((configuration) => configuration.season);
  if (
    validSeasons.some(
      (season) =>
        !Number.isSafeInteger(season) ||
        season < ESPN_LIVE_DRAFT_LIMITS.minimumSeason ||
        season > ESPN_LIVE_DRAFT_LIMITS.maximumSeason,
    )
  ) {
    return { ok: false, reason: "season-ambiguous" };
  }
  const seasons = new Set(validSeasons);
  if (seasons.size !== 1) return { ok: false, reason: "season-ambiguous" };
  const season = seasons.values().next().value;
  return typeof season === "number"
    ? { ok: true, scope: { leagueId: route.leagueId, season } }
    : { ok: false, reason: "season-ambiguous" };
}

/**
 * Requires the claimed league and season to match both the browser-attested URL and the stored
 * bridge scope. A page mutation cannot select another league, and a device cannot submit for a
 * league it was never paired with.
 */
export function validateLiveDraftScope(
  claim: { readonly leagueId: string; readonly season: number },
  route: LiveDraftPageRoute,
  configuration: LiveDraftScopeConfiguration | undefined,
): LiveDraftScopeResult {
  if (
    claim.leagueId !== route.leagueId ||
    (route.season !== undefined && claim.season !== route.season)
  ) {
    return { ok: false, reason: "route-league-mismatch" };
  }
  const resolution = resolveLiveDraftPageScope(route, configuration ? [configuration] : []);
  if (!resolution.ok) return resolution;
  if (claim.leagueId !== resolution.scope.leagueId || claim.season !== resolution.scope.season) {
    return { ok: false, reason: "route-league-mismatch" };
  }
  return { ok: true };
}

/** Bounded retry schedule for a live upload. */
export const LIVE_DRAFT_RETRY = {
  maximumAttempts: 4,
  baseDelayMs: 1_000,
  maximumDelayMs: 15_000,
  requestTimeoutMs: 4_000,
} as const;

export const LIVE_DRAFT_MAXIMUM_RESPONSE_BYTES = 16_384;

export interface LiveDraftRequestDeadline {
  readonly signal: AbortSignal;
  clear(): void;
}

/** A per-attempt deadline keeps one hung fetch from pinning the replace-latest queue forever. */
export function createLiveDraftRequestDeadline(
  timeoutMs = LIVE_DRAFT_RETRY.requestTimeoutMs,
): LiveDraftRequestDeadline {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("Live draft request timeout must be a positive whole number");
  }
  const controller = new AbortController();
  const handle = globalThis.setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  let cleared = false;
  return {
    signal: controller.signal,
    clear(): void {
      if (cleared) return;
      cleared = true;
      globalThis.clearTimeout(handle);
    },
  };
}

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
  | { readonly kind: "accepted"; readonly serverStatus: "accepted" | "idempotent" }
  | { readonly kind: "standby"; readonly sourceLeaseExpiresAt: string | null }
  | { readonly kind: "held"; readonly issueCode: EspnLiveDraftIssueCode | null }
  | {
      readonly kind: "rejected";
      readonly statusCode: number;
      readonly issueCode: EspnLiveDraftIssueCode | null;
    }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "retry" };

export type EspnLiveDraftIssueCode =
  | "UNRESOLVED_TEAM"
  | "UNRESOLVED_PLAYER"
  | "PICK_SEQUENCE_GAP"
  | "DUPLICATE_PICK_SEQUENCE"
  | "EMPTY_RENDER"
  | "PICK_OWNERSHIP_UNKNOWN"
  | "DRAFT_TYPE_MISMATCH"
  | "TEAM_COUNT_MISMATCH"
  | "ROSTER_CAPACITY_EXCEEDED"
  | "PRICE_ILLEGAL"
  | "REDUCER_INVARIANT"
  | "DESTRUCTIVE_PENDING"
  | "MANUAL_BACKUP_ACTIVE"
  | "STALE_PAGE_REVISION"
  | "CHECKSUM_MISMATCH"
  | "SESSION_NOT_READY";

export interface EspnLiveDraftIngestResponseV1 {
  readonly status: "accepted" | "idempotent" | "standby" | "held" | "rejected";
  readonly draftId: string | null;
  readonly serverSequence: number | null;
  readonly feedState: "waiting" | "live" | "paused" | "stale" | "complete" | "degraded";
  readonly acceptedChecksum: string | null;
  readonly unresolvedTeams: number;
  readonly unresolvedPlayers: number;
  readonly issueCode: EspnLiveDraftIssueCode | null;
  readonly sourceLeaseExpiresAt: string | null;
}

const LIVE_DRAFT_ISSUE_CODES: readonly EspnLiveDraftIssueCode[] = [
  "UNRESOLVED_TEAM",
  "UNRESOLVED_PLAYER",
  "PICK_SEQUENCE_GAP",
  "DUPLICATE_PICK_SEQUENCE",
  "EMPTY_RENDER",
  "PICK_OWNERSHIP_UNKNOWN",
  "DRAFT_TYPE_MISMATCH",
  "TEAM_COUNT_MISMATCH",
  "ROSTER_CAPACITY_EXCEEDED",
  "PRICE_ILLEGAL",
  "REDUCER_INVARIANT",
  "DESTRUCTIVE_PENDING",
  "MANUAL_BACKUP_ACTIVE",
  "STALE_PAGE_REVISION",
  "CHECKSUM_MISMATCH",
  "SESSION_NOT_READY",
];

export type LiveDraftResponseExpectation =
  | { readonly kind: "observation"; readonly checksumSha256: string }
  | { readonly kind: "heartbeat" };

/**
 * Recovers the acknowledgement fields from the exact serialized request the transport sent.
 * Invalid internal bodies fail closed before a semantic response can clear the retained board.
 */
export function liveDraftResponseExpectation(body: string): LiveDraftResponseExpectation | null {
  try {
    const value: unknown = JSON.parse(body);
    if (!isRecord(value) || value.schemaVersion !== 1) return null;
    if (value.kind === "espn-live-draft-heartbeat") return { kind: "heartbeat" };
    if (
      value.kind === "espn-live-draft" &&
      typeof value.checksumSha256 === "string" &&
      /^[a-f0-9]{64}$/u.test(value.checksumSha256)
    ) {
      return { kind: "observation", checksumSha256: value.checksumSha256 };
    }
    return null;
  } catch {
    return null;
  }
}

/** Validates every known API field while tolerating additive fields from a newer server. */
export function validateEspnLiveDraftIngestResponse(value: unknown): EspnLiveDraftIngestResponseV1 {
  if (!isRecord(value)) throw new TypeError("Live draft ingest response is missing");
  const statuses = ["accepted", "idempotent", "standby", "held", "rejected"] as const;
  const feedStates = ["waiting", "live", "paused", "stale", "complete", "degraded"] as const;
  if (!(statuses as readonly unknown[]).includes(value.status)) {
    throw new TypeError("Live draft ingest status is invalid");
  }
  if (!(feedStates as readonly unknown[]).includes(value.feedState)) {
    throw new TypeError("Live draft feed state is invalid");
  }
  const nullableUuid = (candidate: unknown, label: string): string | null => {
    if (candidate === null) return null;
    if (
      typeof candidate !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(candidate)
    ) {
      throw new TypeError(`${label} is invalid`);
    }
    return candidate;
  };
  const nullableTimestamp = (candidate: unknown): string | null => {
    if (candidate === null) return null;
    if (
      typeof candidate !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(candidate) ||
      !Number.isFinite(Date.parse(candidate))
    ) {
      throw new TypeError("Live draft lease expiry is invalid");
    }
    return candidate;
  };
  const nonNegativeInteger = (candidate: unknown, label: string): number => {
    if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < 0) {
      throw new TypeError(`${label} is invalid`);
    }
    return candidate;
  };
  const acceptedChecksum =
    value.acceptedChecksum === null
      ? null
      : typeof value.acceptedChecksum === "string" && /^[a-f0-9]{64}$/u.test(value.acceptedChecksum)
        ? value.acceptedChecksum
        : undefined;
  if (acceptedChecksum === undefined) throw new TypeError("Accepted checksum is invalid");
  let issueCode: EspnLiveDraftIssueCode | null;
  if (value.issueCode === null) {
    issueCode = null;
  } else if (typeof value.issueCode === "string") {
    issueCode = (LIVE_DRAFT_ISSUE_CODES as readonly string[]).includes(value.issueCode)
      ? (value.issueCode as EspnLiveDraftIssueCode)
      : null;
  } else {
    throw new TypeError("Live draft issue code is invalid");
  }
  return {
    status: value.status as EspnLiveDraftIngestResponseV1["status"],
    draftId: nullableUuid(value.draftId, "Draft ID"),
    serverSequence:
      value.serverSequence === null
        ? null
        : nonNegativeInteger(value.serverSequence, "Server sequence"),
    feedState: value.feedState as EspnLiveDraftIngestResponseV1["feedState"],
    acceptedChecksum,
    unresolvedTeams: nonNegativeInteger(value.unresolvedTeams, "Unresolved team count"),
    unresolvedPlayers: nonNegativeInteger(value.unresolvedPlayers, "Unresolved player count"),
    issueCode,
    sourceLeaseExpiresAt: nullableTimestamp(value.sourceLeaseExpiresAt),
  };
}

/** Maps a validated semantic response to the queue/status vocabulary. */
export function classifyLiveDraftIngestResponse(
  statusCode: number,
  value: unknown,
  expectation: LiveDraftResponseExpectation,
): LiveDraftUploadOutcome {
  const transportOutcome = classifyUploadStatus(statusCode);
  if (statusCode < 200 || statusCode >= 300) return transportOutcome;
  let response: EspnLiveDraftIngestResponseV1;
  try {
    response = validateEspnLiveDraftIngestResponse(value);
  } catch {
    return { kind: "retry" };
  }
  switch (response.status) {
    case "accepted":
    case "idempotent": {
      if (
        expectation.kind === "observation" &&
        (response.draftId === null || response.acceptedChecksum !== expectation.checksumSha256)
      ) {
        return { kind: "retry" };
      }
      return { kind: "accepted", serverStatus: response.status };
    }
    case "standby":
      return { kind: "standby", sourceLeaseExpiresAt: response.sourceLeaseExpiresAt };
    case "held":
      return { kind: "held", issueCode: response.issueCode };
    case "rejected":
      return { kind: "rejected", statusCode, issueCode: response.issueCode };
  }
}

/**
 * Standby keeps the newest cumulative board so it can claim after lease expiry. Held/rejected and
 * authorization responses clear that exact revision: replaying it cannot improve the semantic
 * result, while the observer's forced publication supplies a newer revision for recovery.
 * Transport exhaustion is represented by an abandoned queue event and remains retained.
 */
export function liveDraftRetainedObservationDisposition(
  outcome: LiveDraftUploadOutcome,
): "retain" | "clear" {
  return outcome.kind === "standby" || outcome.kind === "retry" ? "retain" : "clear";
}

export type LiveDraftUploadTransport = (body: string) => Promise<LiveDraftUploadOutcome>;

export type LiveDraftUploadSlot = "snapshot" | "transient";

export type LiveDraftQueueEvent =
  | {
      readonly kind: "settled";
      readonly slot: LiveDraftUploadSlot;
      readonly observation: EspnLiveDraftObservationV1;
      readonly outcome: LiveDraftUploadOutcome;
    }
  | {
      readonly kind: "retrying";
      readonly slot: LiveDraftUploadSlot;
      readonly observation: EspnLiveDraftObservationV1;
      readonly delayMs: number;
    }
  | {
      readonly kind: "abandoned";
      readonly slot: LiveDraftUploadSlot;
      readonly observation: EspnLiveDraftObservationV1;
    }
  | {
      readonly kind: "oversized";
      readonly slot: LiveDraftUploadSlot;
      readonly observation: EspnLiveDraftObservationV1;
    };

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
    const queued = [this.#snapshot, this.#transient].filter(
      (candidate): candidate is EspnLiveDraftObservationV1 =>
        candidate !== null && candidate.pageSessionId === observation.pageSessionId,
    );
    if (queued.some((candidate) => candidate.revision >= observation.revision)) {
      return this.drain();
    }
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

  /** A departing or superseded tab may clear only observations carrying its random source ID. */
  clearSession(pageSessionId: string): void {
    if (this.#snapshot?.pageSessionId === pageSessionId) this.#snapshot = null;
    if (this.#transient?.pageSessionId === pageSessionId) this.#transient = null;
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
        this.dependencies.onEvent({ kind: "oversized", slot, observation });
        continue;
      }
      const outcome = await this.#attempt(body, slot, observation);
      if (outcome === "superseded") {
        this.#release(slot, observation);
        continue;
      }
      if (outcome === null) {
        this.#release(slot, observation);
        this.dependencies.onEvent({ kind: "abandoned", slot, observation });
        continue;
      }
      this.#release(slot, observation);
      this.dependencies.onEvent({ kind: "settled", slot, observation, outcome });
    }
  }

  /** Runs the bounded retry loop for one body. Returns null when every attempt was exhausted. */
  async #attempt(
    body: string,
    slot: LiveDraftUploadSlot,
    observation: EspnLiveDraftObservationV1,
  ): Promise<LiveDraftUploadOutcome | "superseded" | null> {
    for (let attempt = 1; attempt <= LIVE_DRAFT_RETRY.maximumAttempts; attempt += 1) {
      const outcome = await this.dependencies.transport(body);
      if (outcome.kind !== "retry") return outcome;
      if (attempt === LIVE_DRAFT_RETRY.maximumAttempts) return null;
      const delayMs = liveDraftRetryDelayMs(attempt, this.dependencies.random());
      this.dependencies.onEvent({ kind: "retrying", slot, observation, delayMs });
      await this.dependencies.sleep(delayMs);
      // A newer observation arriving mid-backoff supersedes this one outright: sending the stale
      // body would only be overwritten a moment later. A cleared slot also supersedes the body:
      // retrying after PAGE_LEFT would renew the departed page's server lease and delay takeover.
      const current = slot === "snapshot" ? this.#snapshot : this.#transient;
      if (current !== observation) return "superseded";
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
  // A successful HTTP envelope is insufficient; its bounded semantic body is validated by
  // `classifyLiveDraftIngestResponse` before anything is called accepted.
  if (statusCode >= 200 && statusCode < 300) return { kind: "retry" };
  if (statusCode === 401 || statusCode === 403) return { kind: "unauthorized" };
  if (statusCode === 408 || statusCode === 429 || statusCode >= 500) return { kind: "retry" };
  return { kind: "rejected", statusCode, issueCode: null };
}

export type { EspnLiveDraftHeartbeatV1, EspnLiveDraftObservationV1 };
