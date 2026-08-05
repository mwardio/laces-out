import type { BridgeLiveDraftStatus } from "./live-draft/uplink.js";

export const maximumLeagueCount = 32;

export interface BridgeConfiguration {
  readonly apiBaseUrl: string;
  readonly deviceToken: string;
  readonly leagueIds: readonly string[];
  readonly season: number;
  readonly automaticSync: boolean;
}

export type BridgeLeagueResultState =
  "synced" | "espn-login-required" | "laces-out-auth-failed" | "error";

export interface BridgeLeagueResult {
  readonly leagueId: string;
  readonly state: BridgeLeagueResultState;
  readonly message: string;
}

export type BridgeStatusState =
  | "not-configured"
  | "ready"
  | "syncing"
  | "healthy"
  | "partial-failure"
  | "espn-login-required"
  | "laces-out-auth-failed"
  | "error";

export interface BridgeStatus {
  readonly configured: boolean;
  readonly state: BridgeStatusState;
  readonly message: string;
  readonly lastAttemptAt: string | null;
  readonly lastSuccessfulAt: string | null;
  readonly results: readonly BridgeLeagueResult[];
}

// Live draft messages. They are part of the same `BridgeRequest` union so the
// message listener sees one type, but they answer with `BridgeLiveDraftResponse` rather than the
// league-sync `BridgeResponse`, and the service worker routes them to their own handler. They must
// never fall through to a league sync: see `handleRequest` in the service worker.
export type BridgeLiveDraftRequest =
  | {
      readonly type: "LIVE_DRAFT_OBSERVATION";
      readonly observation: unknown;
      /** True for a bounded nomination/high-bid update rather than a material board change. */
      readonly transient: boolean;
    }
  | { readonly type: "LIVE_DRAFT_HEARTBEAT"; readonly heartbeat: unknown }
  | { readonly type: "LIVE_DRAFT_PAGE_LEFT"; readonly leagueId: string; readonly season: number }
  | {
      readonly type: "GET_LIVE_DRAFT_STATUS";
      readonly leagueId?: string;
      readonly season?: number;
    };

export type BridgeRequest =
  | { readonly type: "GET_STATUS" }
  | { readonly type: "GET_SERVER_SESSION_STATUS" }
  | { readonly type: "ENABLE_SERVER_SESSION" }
  | { readonly type: "ESPN_SESSION_PAGE_READY" }
  | { readonly type: "CONFIGURE"; readonly configuration: BridgeConfiguration }
  | { readonly type: "SYNC_NOW" }
  | { readonly type: "DISCONNECT" }
  | BridgeLiveDraftRequest;

export const liveDraftRequestTypes = [
  "LIVE_DRAFT_OBSERVATION",
  "LIVE_DRAFT_HEARTBEAT",
  "LIVE_DRAFT_PAGE_LEFT",
  "GET_LIVE_DRAFT_STATUS",
] as const;

export function isBridgeLiveDraftRequest(
  request: BridgeRequest,
): request is BridgeLiveDraftRequest {
  return (liveDraftRequestTypes as readonly string[]).includes(request.type);
}

export interface BridgeResponse {
  readonly ok: boolean;
  readonly status: BridgeStatus;
}

export type BridgeServerSessionState =
  "not-enabled" | "enabling" | "enabled" | "login-required" | "unavailable" | "error";

export interface BridgeServerSessionStatus {
  readonly state: BridgeServerSessionState;
  readonly message: string;
  readonly connectionId: string | null;
  readonly updatedAt: string | null;
}

export interface BridgeServerSessionResponse {
  readonly ok: boolean;
  readonly status: BridgeServerSessionStatus;
}

export interface BridgeLiveDraftResponse {
  readonly ok: boolean;
  readonly status: BridgeLiveDraftStatus;
}

export interface BridgeResultSummary {
  readonly state: Extract<
    BridgeStatusState,
    "healthy" | "partial-failure" | "espn-login-required" | "laces-out-auth-failed" | "error"
  >;
  readonly message: string;
}

export type { BridgeLiveDraftStatus };

export const configurationStorageKey = "lacesOutEspnConfiguration";
export const statusStorageKey = "lacesOutEspnStatus";
export const pendingPairingStorageKey = "lacesOutEspnPendingPairing";
export const syncAlarmName = "laces-out-espn-sync";
export const maintenanceStorageKey = "lacesOutEspnMaintenance";
export const serverSessionStatusStorageKey = "lacesOutEspnServerSessionStatus";
export const serverSessionPendingStorageKey = "lacesOutEspnServerSessionPending";

// A web page can offer to pair the bridge with itself. Offers are held as
// pending (never auto-configured) and expire quickly so a stale offer can never
// silently reconfigure the bridge on a later popup open.
export const pairingOfferTtlMs = 10 * 60 * 1000;
export const pairingCodePattern = /^[A-HJ-NP-Z2-9]{4}(?:-[A-HJ-NP-Z2-9]{4}){3}$/u;

// The message a Laces Out page posts through `chrome.runtime.sendMessage` to the
// extension via `externally_connectable`. The offered configuration is only
// applied after an explicit in-popup confirmation gesture.
export type BridgePairingOfferMessage = {
  readonly type: "PAIRING_OFFER";
  readonly apiBaseUrl: string;
  readonly deviceToken: string;
  readonly leagues?: readonly string[];
  readonly season: number;
  readonly automaticSync?: boolean;
};

export type BridgeServerSessionOfferMessage = {
  readonly type: "ENABLE_SERVER_SESSION";
};

export type BridgePairingOfferResponse =
  | { readonly ok: true; readonly state: "pending-confirmation" }
  | { readonly ok: false; readonly reason: string };

export type BridgeServerSessionOfferResponse = BridgeServerSessionResponse;

export interface PendingPairingOffer {
  readonly origin: string;
  readonly configuration: BridgeConfiguration;
  readonly receivedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeApiBaseUrl(value: unknown): string {
  const apiBaseUrl = typeof value === "string" ? value.trim() : "";
  const apiUrl = new URL(apiBaseUrl);
  const localDevelopment =
    apiUrl.protocol === "http:" && ["localhost", "127.0.0.1"].includes(apiUrl.hostname);
  if (
    (apiUrl.protocol !== "https:" && !localDevelopment) ||
    apiUrl.username !== "" ||
    apiUrl.password !== "" ||
    apiUrl.search !== "" ||
    apiUrl.hash !== ""
  ) {
    throw new TypeError("Laces Out URL must be HTTPS or a loopback development URL");
  }
  return apiUrl.origin;
}

export function normalizePairingCode(value: unknown): string {
  const pairingCode = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (!pairingCodePattern.test(pairingCode)) {
    throw new TypeError("Laces Out pairing code is invalid");
  }
  return pairingCode;
}

export function parseLeagueIds(value: string): readonly string[] {
  const leagueIds = value
    .split(/[\s,]+/u)
    .map((leagueId) => leagueId.trim())
    .filter(Boolean);
  return validateLeagueIds(leagueIds);
}

export function validateLeagueIds(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError("Enter at least one ESPN league ID");
  }
  if (value.length > maximumLeagueCount) {
    throw new TypeError(`A bridge can sync at most ${maximumLeagueCount} ESPN leagues`);
  }
  const leagueIds = value.map((candidate) => {
    if (typeof candidate !== "string") throw new TypeError("ESPN league IDs must be text");
    const leagueId = candidate.trim();
    if (!/^\d{1,20}$/u.test(leagueId)) {
      throw new TypeError("Each ESPN league ID must contain 1 to 20 digits");
    }
    return leagueId;
  });
  if (new Set(leagueIds).size !== leagueIds.length) {
    throw new TypeError("ESPN league IDs must be unique");
  }
  return leagueIds;
}

export function validateBridgeConfiguration(value: unknown): BridgeConfiguration {
  if (!isRecord(value)) throw new TypeError("Bridge configuration is missing");
  const apiBaseUrl = normalizeApiBaseUrl(value.apiBaseUrl);
  const deviceToken = typeof value.deviceToken === "string" ? value.deviceToken.trim() : "";
  const leagueIds = validateLeagueIds(value.leagueIds);
  const season = value.season;
  const automaticSync = value.automaticSync;
  if (deviceToken.length < 32 || deviceToken.length > 512) {
    throw new TypeError("Laces Out device token is invalid");
  }
  if (
    typeof season !== "number" ||
    !Number.isSafeInteger(season) ||
    season < 2000 ||
    season > 2100
  ) {
    throw new TypeError("ESPN season is invalid");
  }
  if (typeof automaticSync !== "boolean") throw new TypeError("Automatic sync setting is invalid");
  return {
    apiBaseUrl,
    deviceToken,
    leagueIds,
    season,
    automaticSync,
  };
}

export function configurationFromPairingRedemption(
  value: unknown,
  apiBaseUrl: unknown,
): BridgeConfiguration {
  if (!isRecord(value)) throw new TypeError("Laces Out pairing response is invalid");
  if (
    typeof value.deviceId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value.deviceId,
    )
  ) {
    throw new TypeError("Laces Out pairing response is missing a device identifier");
  }
  if (
    typeof value.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(value.expiresAt)) ||
    Date.parse(value.expiresAt) <= Date.now()
  ) {
    throw new TypeError("Laces Out pairing response has an invalid expiry");
  }
  if (value.automaticSync !== true) {
    throw new TypeError("Laces Out pairing response is not an automatic-sync credential");
  }
  return validateBridgeConfiguration({
    apiBaseUrl,
    deviceToken: value.deviceToken,
    leagueIds: value.leagueIds,
    season: value.season,
    automaticSync: value.automaticSync,
  });
}

function normalizeOrigin(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError("Pairing offer is missing a browser-attested origin");
  }
  try {
    return new URL(value).origin;
  } catch {
    throw new TypeError("Pairing offer sender origin is invalid");
  }
}

// Validates a PAIRING_OFFER message. Reuses the configuration validator (token
// length, URL normalization, league/season checks) and additionally requires
// the browser-attested `senderOrigin` to exactly equal the normalized origin of
// the offered `apiBaseUrl`: a page can only offer pairing to itself.
export function validateBridgePairingOffer(
  message: unknown,
  senderOrigin: unknown,
): BridgeConfiguration {
  if (!isRecord(message) || message.type !== "PAIRING_OFFER") {
    throw new TypeError("Not a bridge pairing offer");
  }
  const configuration = validateBridgeConfiguration({
    apiBaseUrl: message.apiBaseUrl,
    deviceToken: message.deviceToken,
    leagueIds: message.leagues ?? message.leagueIds,
    season: message.season,
    automaticSync: typeof message.automaticSync === "boolean" ? message.automaticSync : true,
  });
  if (normalizeOrigin(senderOrigin) !== configuration.apiBaseUrl) {
    throw new TypeError("A page can only offer pairing to its own origin");
  }
  return configuration;
}

export function createPendingPairingOffer(
  configuration: BridgeConfiguration,
  receivedAt: string,
): PendingPairingOffer {
  return { origin: configuration.apiBaseUrl, configuration, receivedAt };
}

// Reads a stored pending offer, failing closed on anything malformed so a
// corrupt or foreign storage value can never be presented as a real offer.
export function validateStoredPendingOffer(value: unknown): PendingPairingOffer | undefined {
  if (!isRecord(value)) return undefined;
  try {
    const configuration = validateBridgeConfiguration(value.configuration);
    if (value.origin !== configuration.apiBaseUrl) return undefined;
    if (typeof value.receivedAt !== "string" || !Number.isFinite(Date.parse(value.receivedAt))) {
      return undefined;
    }
    return { origin: configuration.apiBaseUrl, configuration, receivedAt: value.receivedAt };
  } catch {
    return undefined;
  }
}

export function pairingOfferIsFresh(offer: PendingPairingOffer, now: number): boolean {
  const receivedAt = Date.parse(offer.receivedAt);
  return Number.isFinite(receivedAt) && receivedAt <= now && now - receivedAt < pairingOfferTtlMs;
}

export function summarizeBridgeResults(
  results: readonly BridgeLeagueResult[],
): BridgeResultSummary {
  if (results.length === 0) throw new TypeError("Bridge sync results cannot be empty");
  const synced = results.filter((result) => result.state === "synced").length;
  const loginRequired = results.filter((result) => result.state === "espn-login-required").length;
  const pairingFailed = results.filter((result) => result.state === "laces-out-auth-failed").length;
  if (synced === results.length) {
    return {
      state: "healthy",
      message: `Synced ${synced} ESPN ${synced === 1 ? "league" : "leagues"}.`,
    };
  }
  if (synced > 0) {
    return {
      state: "partial-failure",
      message: `Synced ${synced} of ${results.length} ESPN leagues; ${results.length - synced} ${results.length - synced === 1 ? "needs" : "need"} attention.`,
    };
  }
  if (loginRequired > 0) {
    return {
      state: "espn-login-required",
      message:
        loginRequired === results.length
          ? "Sign in to ESPN in this browser, then sync again."
          : `${loginRequired} of ${results.length} leagues require ESPN sign-in; review the league results.`,
    };
  }
  if (pairingFailed > 0) {
    return {
      state: "laces-out-auth-failed",
      message: "Laces Out pairing was rejected. Create and configure a new bridge device token.",
    };
  }
  return {
    state: "error",
    message: `None of the ${results.length} ESPN leagues synced; review the league results.`,
  };
}
