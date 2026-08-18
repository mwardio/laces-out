import {
  configurationStorageKey,
  createPendingPairingOffer,
  isBridgeLiveDraftRequest,
  maintenanceStorageKey,
  pairingOfferIsFresh,
  pendingPairingStorageKey,
  serverSessionPendingStorageKey,
  serverSessionStatusStorageKey,
  statusStorageKey,
  summarizeBridgeResults,
  syncAlarmName,
  validateBridgeConfiguration,
  validateBridgePairingOffer,
  validateDiscoverLeaguesMessage,
  validateStoredPendingOffer,
  type BridgeConfiguration,
  type BridgeDiscoverLeaguesResponse,
  type BridgeLeagueResult,
  type BridgeLiveDraftRequest,
  type BridgeLiveDraftResponse,
  type BridgeLiveDraftScope,
  type BridgePairingOfferResponse,
  type BridgePingResponse,
  type BridgeRequest,
  type BridgeResponse,
  type BridgeServerSessionOfferResponse,
  type BridgeServerSessionResponse,
  type BridgeServerSessionStatus,
  type BridgeStatus,
  type BridgeStatusState,
} from "./protocol.js";
import { fanProfileEndpoint, parseFanProfileLeagues } from "./discovery.js";
import {
  defaultMaintenanceState,
  loginRequiredBackoffMs,
  maintenancePlan,
  maintenancePollIntervalMinutes,
  pollFailureBackoffUntil,
  retryableLeagueBackoffMs,
  validateAgentPollResponse,
  validateMaintenanceState,
  type AgentRefreshRequest,
  type EspnArtifactFamily,
  type MaintenanceState,
} from "./maintenance.js";
import {
  validateEspnLiveDraftHeartbeat,
  validateEspnLiveDraftObservation,
  espnLiveDraftChecksum,
  espnLiveDraftDigestSource,
  type EspnLiveDraftObservationV1,
} from "./live-draft/dom-contract.js";
import {
  LiveDraftUploadQueue,
  claimLiveDraftPageSession,
  classifyLiveDraftIngestResponse,
  createLiveDraftRequestDeadline,
  defaultLiveDraftStatus,
  liveDraftActiveSessionStorageKey,
  liveDraftActiveSessionTtlMs,
  liveDraftIngestPath,
  LIVE_DRAFT_MAXIMUM_RESPONSE_BYTES,
  liveDraftPendingStorageKey,
  liveDraftResponseExpectation,
  liveDraftRetainedObservationDisposition,
  liveDraftStatusStorageKey,
  resolveLiveDraftPageScope,
  sameLiveDraftPageSession,
  validLiveDraftPageSessionId,
  validateLiveDraftScope,
  validateLiveDraftSender,
  validateStoredLiveDraftPageSession,
  validateStoredLiveDraftStatus,
  type BridgeLiveDraftStatus,
  type LiveDraftPageSession,
  type LiveDraftPageSessionClaim,
  type LiveDraftUploadOutcome,
} from "./live-draft/uplink.js";
import {
  capturedEspnSessionFromCookies,
  isValidSwid,
  type CapturedEspnSession,
} from "./session-credential.js";

const ESPN_ORIGIN = "https://lm-api-reads.fantasy.espn.com";
const MAX_ESPN_BYTES = 5 * 1024 * 1024;
const supplementalTransactionTypes = [
  "DRAFT",
  "TRADE_ACCEPT",
  "WAIVER",
  "TRADE_VETO",
  "FUTURE_ROSTER",
  "ROSTER",
  "RETRO_ROSTER",
  "TRADE_PROPOSAL",
  "TRADE_UPHOLD",
  "FREEAGENT",
  "TRADE_DECLINE",
  "WAIVER_ERROR",
  "TRADE_ERROR",
] as const;
const statusStates = new Set<BridgeStatusState>([
  "not-configured",
  "ready",
  "syncing",
  "healthy",
  "partial-failure",
  "espn-login-required",
  "laces-out-auth-failed",
  "error",
]);
const DEFAULT_STATUS: BridgeStatus = {
  configured: false,
  state: "not-configured",
  message: "Pair this bridge with Laces Out to begin ESPN sync.",
  lastAttemptAt: null,
  lastSuccessfulAt: null,
  results: [],
};
const DEFAULT_SERVER_SESSION_STATUS: BridgeServerSessionStatus = {
  state: "not-enabled",
  message: "Always-on ESPN sync is not enabled.",
  connectionId: null,
  updatedAt: null,
};
const SERVER_SESSION_PENDING_TTL_MS = 10 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validStoredStatus(value: unknown): value is BridgeStatus {
  if (!isRecord(value) || !Array.isArray(value.results) || value.results.length > 32) return false;
  return (
    typeof value.configured === "boolean" &&
    typeof value.state === "string" &&
    statusStates.has(value.state as BridgeStatusState) &&
    typeof value.message === "string" &&
    value.message.length <= 240 &&
    (value.lastAttemptAt === null || typeof value.lastAttemptAt === "string") &&
    (value.lastSuccessfulAt === null || typeof value.lastSuccessfulAt === "string") &&
    value.results.every(
      (result) =>
        isRecord(result) &&
        typeof result.leagueId === "string" &&
        /^\d{1,20}$/u.test(result.leagueId) &&
        ["synced", "espn-login-required", "laces-out-auth-failed", "error"].includes(
          String(result.state),
        ) &&
        typeof result.message === "string" &&
        result.message.length <= 180,
    )
  );
}

async function getConfiguration(): Promise<BridgeConfiguration | undefined> {
  const stored = await chrome.storage.local.get(configurationStorageKey);
  if (stored[configurationStorageKey] === undefined) return undefined;
  return validateBridgeConfiguration(stored[configurationStorageKey]);
}

async function getStatus(): Promise<BridgeStatus> {
  const stored = await chrome.storage.local.get(statusStorageKey);
  return validStoredStatus(stored[statusStorageKey]) ? stored[statusStorageKey] : DEFAULT_STATUS;
}

async function setStatus(status: BridgeStatus): Promise<BridgeStatus> {
  await chrome.storage.local.set({ [statusStorageKey]: status });
  return status;
}

function validServerSessionStatus(value: unknown): value is BridgeServerSessionStatus {
  return (
    isRecord(value) &&
    ["not-enabled", "enabling", "enabled", "login-required", "unavailable", "error"].includes(
      String(value.state),
    ) &&
    typeof value.message === "string" &&
    value.message.length <= 240 &&
    (value.connectionId === null ||
      (typeof value.connectionId === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
          value.connectionId,
        ))) &&
    (value.updatedAt === null ||
      (typeof value.updatedAt === "string" && Number.isFinite(Date.parse(value.updatedAt))))
  );
}

async function getServerSessionStatus(): Promise<BridgeServerSessionStatus> {
  const stored = await chrome.storage.local.get(serverSessionStatusStorageKey);
  return validServerSessionStatus(stored[serverSessionStatusStorageKey])
    ? stored[serverSessionStatusStorageKey]
    : DEFAULT_SERVER_SESSION_STATUS;
}

async function setServerSessionStatus(
  status: BridgeServerSessionStatus,
): Promise<BridgeServerSessionStatus> {
  await chrome.storage.local.set({ [serverSessionStatusStorageKey]: status });
  return status;
}

async function getMaintenanceState(): Promise<MaintenanceState> {
  const stored = await chrome.storage.local.get(maintenanceStorageKey);
  return validateMaintenanceState(stored[maintenanceStorageKey]);
}

async function setMaintenanceState(state: MaintenanceState): Promise<MaintenanceState> {
  await chrome.storage.local.set({ [maintenanceStorageKey]: state });
  return state;
}

async function readBoundedText(response: Response, maximumBytes = MAX_ESPN_BYTES): Promise<string> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maximumBytes) {
    throw new Error("Response exceeded the safety limit");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new Error("Response exceeded the safety limit");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function validateEspnPayload(payload: unknown, leagueId: string): void {
  if (!isRecord(payload)) throw new Error("ESPN returned an invalid league document");
  const id = typeof payload.id === "number" ? String(payload.id) : payload.id;
  if (id !== leagueId || !Array.isArray(payload.teams) || !isRecord(payload.settings)) {
    throw new Error("ESPN league response did not match the requested league");
  }
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function leagueEndpoint(configuration: BridgeConfiguration, leagueId: string): URL {
  const endpoint = new URL(
    `/apis/v3/games/ffl/seasons/${configuration.season}/segments/0/leagues/${leagueId}`,
    ESPN_ORIGIN,
  );
  for (const view of ["mSettings", "mTeam", "mRoster", "mStandings", "mMatchup"]) {
    endpoint.searchParams.append("view", view);
  }
  return endpoint;
}

type SupplementalRequest =
  | {
      readonly kind: "available-free-agents" | "available-waivers" | "structured-transactions";
      readonly week: number;
      readonly views: readonly string[];
      readonly filter: Record<string, unknown>;
    }
  | {
      readonly kind: "weekly-box-scores";
      readonly week: number;
      readonly matchupPeriodId: number;
      readonly views: readonly string[];
      readonly filter: Record<string, unknown>;
    }
  | {
      readonly kind: "completed-draft";
      readonly week: null;
      readonly views: readonly string[];
      readonly filter: null;
    };

function currentScoringPeriod(payload: unknown): number {
  if (!isRecord(payload)) return 0;
  const value = payload.scoringPeriodId;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 30
    ? value
    : 0;
}

function matchupPeriodForWeek(payload: unknown, week: number): number {
  if (!isRecord(payload) || !isRecord(payload.settings)) return week;
  const scheduleSettings = payload.settings.scheduleSettings;
  if (!isRecord(scheduleSettings) || !isRecord(scheduleSettings.matchupPeriods)) return week;
  for (const [period, weeks] of Object.entries(scheduleSettings.matchupPeriods)) {
    if (
      Array.isArray(weeks) &&
      weeks.some((value) => value === week) &&
      /^\d+$/u.test(period) &&
      Number(period) >= 1 &&
      Number(period) <= 30
    ) {
      return Number(period);
    }
  }
  return week;
}

function supplementalArtifact(request: SupplementalRequest): Exclude<EspnArtifactFamily, "core"> {
  if (request.kind === "available-free-agents" || request.kind === "available-waivers") {
    return "available-players";
  }
  if (request.kind === "structured-transactions") return "transactions";
  return request.kind;
}

function supplementalRequests(
  payload: unknown,
  requiredArtifacts?: readonly EspnArtifactFamily[],
): readonly SupplementalRequest[] {
  const week = currentScoringPeriod(payload);
  const requests: SupplementalRequest[] = [
    {
      kind: "available-free-agents",
      week,
      views: ["kona_player_info"],
      filter: {
        players: {
          filterStatus: { value: ["FREEAGENT"] },
          limit: 250,
          sortPercOwned: { sortPriority: 1, sortAsc: false },
          sortDraftRanks: { sortPriority: 100, sortAsc: true, value: "STANDARD" },
        },
      },
    },
    {
      kind: "available-waivers",
      week,
      views: ["kona_player_info"],
      filter: {
        players: {
          filterStatus: { value: ["WAIVERS"] },
          limit: 250,
          sortPercOwned: { sortPriority: 1, sortAsc: false },
          sortDraftRanks: { sortPriority: 100, sortAsc: true, value: "STANDARD" },
        },
      },
    },
    {
      kind: "structured-transactions",
      week,
      views: ["mTransactions2"],
      filter: {
        transactions: {
          filterType: { value: [...supplementalTransactionTypes] },
        },
      },
    },
    {
      kind: "completed-draft",
      week: null,
      views: ["mDraftDetail"],
      filter: null,
    },
  ];
  if (week >= 1) {
    const matchupPeriodId = matchupPeriodForWeek(payload, week);
    requests.splice(2, 0, {
      kind: "weekly-box-scores",
      week,
      matchupPeriodId,
      views: ["mMatchupScore", "mScoreboard"],
      filter: {
        schedule: {
          filterMatchupPeriodIds: { value: [matchupPeriodId] },
        },
      },
    });
  }
  return requiredArtifacts
    ? requests.filter((request) => requiredArtifacts.includes(supplementalArtifact(request)))
    : requests;
}

function supplementalEndpoint(
  configuration: BridgeConfiguration,
  leagueId: string,
  request: SupplementalRequest,
): URL {
  const endpoint = new URL(
    `/apis/v3/games/ffl/seasons/${configuration.season}/segments/0/leagues/${leagueId}`,
    ESPN_ORIGIN,
  );
  for (const view of request.views) endpoint.searchParams.append("view", view);
  if (request.week !== null) endpoint.searchParams.set("scoringPeriodId", String(request.week));
  return endpoint;
}

async function synchronizeSupplemental(
  configuration: BridgeConfiguration,
  leagueId: string,
  corePayload: unknown,
  requiredArtifacts?: readonly EspnArtifactFamily[],
): Promise<{
  readonly accepted: number;
  readonly attempted: number;
  readonly authorizationFailed: boolean;
}> {
  let accepted = 0;
  let authorizationFailed = false;
  const requests = supplementalRequests(corePayload, requiredArtifacts);
  for (const request of requests) {
    try {
      const endpoint = supplementalEndpoint(configuration, leagueId, request);
      const response = await fetch(endpoint, {
        method: "GET",
        headers: {
          Accept: "application/json",
          ...(request.filter ? { "x-fantasy-filter": JSON.stringify(request.filter) } : {}),
        },
        credentials: "include",
        cache: "no-store",
        redirect: "error",
      });
      if (!response.ok) throw new Error(`ESPN returned status ${response.status}`);
      if (!(response.headers.get("content-type") ?? "").toLowerCase().includes("json")) {
        throw new Error("ESPN did not return JSON");
      }
      const payload = JSON.parse(await readBoundedText(response)) as unknown;
      const capturedAt = new Date().toISOString();
      const envelope = {
        schemaVersion: 1,
        provider: "espn",
        authority: "browser-local",
        readOnly: true,
        leagueId,
        season: configuration.season,
        capturedAt,
        endpoint: endpoint.toString(),
        checksumSha256: await sha256(JSON.stringify(payload)),
        payload,
        kind: request.kind,
        week: request.week,
        ...(request.kind === "weekly-box-scores"
          ? { matchupPeriodId: request.matchupPeriodId }
          : {}),
      };
      const upload = await fetch(`${configuration.apiBaseUrl}/v1/bridge/espn/supplemental`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bridge ${configuration.deviceToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(envelope),
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
      });
      if (upload.status === 401 || upload.status === 403) authorizationFailed = true;
      if (!upload.ok) throw new Error(`Laces Out returned status ${upload.status}`);
      accepted += 1;
    } catch {
      // Supplemental endpoints are admitted independently. Core roster sync and other successful
      // artifacts remain useful when any one undocumented ESPN view drifts or is unavailable.
    }
  }
  return { accepted, attempted: requests.length, authorizationFailed };
}

async function synchronizeLeague(
  configuration: BridgeConfiguration,
  leagueId: string,
  requiredArtifacts?: readonly EspnArtifactFamily[],
): Promise<BridgeLeagueResult> {
  const endpoint = leagueEndpoint(configuration, leagueId);
  try {
    const espnResponse = await fetch(endpoint, {
      method: "GET",
      headers: { Accept: "application/json" },
      credentials: "include",
      cache: "no-store",
      redirect: "error",
    });
    if ([401, 403, 404].includes(espnResponse.status)) {
      return {
        leagueId,
        state: "espn-login-required",
        message: "ESPN sign-in or league access is required.",
      };
    }
    if (!espnResponse.ok) throw new Error(`ESPN returned status ${espnResponse.status}`);
    if (!(espnResponse.headers.get("content-type") ?? "").toLowerCase().includes("json")) {
      throw new Error("ESPN did not return JSON");
    }
    const raw = await readBoundedText(espnResponse);
    const payload = JSON.parse(raw) as unknown;
    validateEspnPayload(payload, leagueId);
    const canonicalPayload = JSON.stringify(payload);
    const capturedAt = new Date().toISOString();

    if (!requiredArtifacts || requiredArtifacts.includes("core")) {
      const uploadResponse = await fetch(`${configuration.apiBaseUrl}/v1/bridge/espn/snapshots`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bridge ${configuration.deviceToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          schemaVersion: 1,
          provider: "espn",
          authority: "browser-local",
          readOnly: true,
          leagueId,
          season: configuration.season,
          capturedAt,
          endpoint: endpoint.toString(),
          checksumSha256: await sha256(canonicalPayload),
          payload,
        }),
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
      });
      if (uploadResponse.status === 401 || uploadResponse.status === 403) {
        return {
          leagueId,
          state: "laces-out-auth-failed",
          message: "Laces Out pairing was rejected.",
        };
      }
      if (!uploadResponse.ok) {
        throw new Error(`Laces Out returned status ${uploadResponse.status}`);
      }
    }
    const supplemental = await synchronizeSupplemental(
      configuration,
      leagueId,
      payload,
      requiredArtifacts,
    );
    if (supplemental.authorizationFailed) {
      return {
        leagueId,
        state: "laces-out-auth-failed",
        message: "Laces Out pairing was rejected.",
      };
    }
    if (requiredArtifacts && supplemental.accepted !== supplemental.attempted) {
      return {
        leagueId,
        state: "error",
        message: `${supplemental.accepted} of ${supplemental.attempted} requested supplemental feeds updated.`,
      };
    }
    return {
      leagueId,
      state: "synced",
      message:
        supplemental.accepted === supplemental.attempted
          ? "League and supplemental data synced."
          : `League synced; ${supplemental.accepted} of ${supplemental.attempted} supplemental feeds updated.`,
    };
  } catch (error) {
    return {
      leagueId,
      state: "error",
      message: error instanceof Error ? error.message.slice(0, 180) : "ESPN sync failed",
    };
  }
}

let activeSynchronization: Promise<BridgeStatus> | undefined;

async function runSynchronization(
  requested: readonly AgentRefreshRequest[] | null = null,
  baselineLeagueIds?: readonly string[],
): Promise<BridgeStatus> {
  let configuration: BridgeConfiguration | undefined;
  try {
    configuration = await getConfiguration();
  } catch {
    return setStatus({
      ...DEFAULT_STATUS,
      state: "error",
      message: "Stored bridge configuration is invalid. Pair this browser again.",
    });
  }
  if (!configuration) return setStatus(DEFAULT_STATUS);
  const previous = await getStatus();
  const attemptedAt = new Date().toISOString();
  const results: BridgeLeagueResult[] = [];
  const targets =
    requested ??
    (baselineLeagueIds ?? configuration.leagueIds).map((externalLeagueId): AgentRefreshRequest => ({
      requestId: "00000000-0000-4000-8000-000000000000",
      externalLeagueId,
      season: configuration.season,
      minimumCaptureAt: attemptedAt,
      expiresAt: attemptedAt,
      requiredArtifacts: [
        "core",
        "available-players",
        "weekly-box-scores",
        "transactions",
        "completed-draft",
      ],
    }));
  for (const [index, target] of targets.entries()) {
    const leagueId = target.externalLeagueId;
    await setStatus({
      ...previous,
      configured: true,
      state: "syncing",
      message: `Syncing ESPN league ${index + 1} of ${targets.length}…`,
      lastAttemptAt: attemptedAt,
      results: [...results],
    });
    if (requested) {
      await reportAgentAttempt(configuration, target.requestId, {
        state: "started",
      });
    }
    const result = await synchronizeLeague(
      configuration,
      leagueId,
      requested ? target.requiredArtifacts : undefined,
    );
    results.push(result);
    if (requested && result.state !== "synced") {
      await reportAgentAttempt(
        configuration,
        target.requestId,
        result.state === "espn-login-required"
          ? { state: "login-required", errorCode: "ESPN_LOGIN_REQUIRED" }
          : result.state === "laces-out-auth-failed"
            ? { state: "rejected", errorCode: "LACES_OUT_AUTH_REJECTED" }
            : { state: "retryable-error", errorCode: "AGENT_SYNC_FAILED" },
      );
    }
  }
  const summary = summarizeBridgeResults(results);
  return setStatus({
    configured: true,
    state: summary.state,
    message: summary.message,
    lastAttemptAt: attemptedAt,
    lastSuccessfulAt: results.some((result) => result.state === "synced")
      ? attemptedAt
      : previous.lastSuccessfulAt,
    results,
  });
}

function synchronize(
  requested: readonly AgentRefreshRequest[] | null = null,
  baselineLeagueIds?: readonly string[],
): Promise<BridgeStatus> {
  if (activeSynchronization) return activeSynchronization;
  activeSynchronization = runSynchronization(requested, baselineLeagueIds).finally(() => {
    activeSynchronization = undefined;
  });
  return activeSynchronization;
}

async function reportAgentAttempt(
  configuration: BridgeConfiguration,
  requestId: string,
  attempt:
    | { readonly state: "started" }
    | {
        readonly state: "login-required" | "retryable-error" | "rejected";
        readonly errorCode: string;
      },
): Promise<void> {
  try {
    await fetch(
      `${configuration.apiBaseUrl}/v1/bridge/espn/refresh-requests/${encodeURIComponent(requestId)}/attempts`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bridge ${configuration.deviceToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(attempt),
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
      },
    );
  } catch {
    // Attempt reporting is diagnostic. Snapshot admission remains the authoritative success path,
    // and an older server may not expose this route during the extension rollout.
  }
}

async function pollAgentRequests(configuration: BridgeConfiguration): Promise<{
  readonly poll: ReturnType<typeof validateAgentPollResponse> | null;
  readonly unauthorized: boolean;
}> {
  const response = await fetch(`${configuration.apiBaseUrl}/v1/bridge/espn/refresh-requests/poll`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bridge ${configuration.deviceToken}`,
      "Content-Type": "application/json",
    },
    body: "{}",
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
  });
  if (response.status === 401 || response.status === 403) {
    return { poll: null, unauthorized: true };
  }
  if ([404, 405, 501, 503].includes(response.status)) {
    // Compatibility path while server support rolls out. The established six-hour upload remains.
    return { poll: null, unauthorized: false };
  }
  if (!response.ok) throw new Error("Laces Out refresh poll failed");
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (!contentType.includes("json")) throw new Error("Laces Out refresh poll was not JSON");
  const body = JSON.parse(await readBoundedText(response, 128 * 1024)) as unknown;
  return { poll: validateAgentPollResponse(body), unauthorized: false };
}

let activeMaintenance: Promise<void> | undefined;

async function runMaintenanceCycle(): Promise<void> {
  let configuration: BridgeConfiguration | undefined;
  try {
    configuration = await getConfiguration();
  } catch {
    configuration = undefined;
  }
  if (!configuration?.automaticSync) return;

  const now = new Date();
  let state = await getMaintenanceState();
  let poll: ReturnType<typeof validateAgentPollResponse> | null = null;
  const pollBackoffActive =
    state.pollBackoffUntil !== null && Date.parse(state.pollBackoffUntil) > now.getTime();
  if (!pollBackoffActive) {
    try {
      const result = await pollAgentRequests(configuration);
      if (result.unauthorized) {
        await setStatus({
          ...(await getStatus()),
          configured: true,
          state: "laces-out-auth-failed",
          message: "Laces Out pairing was rejected. Pair this browser again.",
          lastAttemptAt: now.toISOString(),
        });
        state = {
          ...state,
          lastPollAt: now.toISOString(),
          consecutivePollFailures: 0,
          pollBackoffUntil: null,
        };
        await setMaintenanceState(state);
        return;
      }
      poll = result.poll;
      state = {
        ...state,
        lastPollAt: now.toISOString(),
        consecutivePollFailures: 0,
        pollBackoffUntil: null,
      };
    } catch {
      const consecutivePollFailures = Math.min(state.consecutivePollFailures + 1, 100);
      state = {
        ...state,
        lastPollAt: now.toISOString(),
        consecutivePollFailures,
        pollBackoffUntil: pollFailureBackoffUntil(consecutivePollFailures, now),
      };
    }
  }

  const plan = maintenancePlan({ configuration, state, poll, now });
  if (plan.kind === "none") {
    await setMaintenanceState(state);
    return;
  }

  const status = await synchronize(
    plan.kind === "requested" ? plan.requests : null,
    plan.kind === "baseline" ? plan.leagueIds : undefined,
  );
  const leagueBackoffUntil = { ...state.leagueBackoffUntil };
  const leagueResults = { ...state.leagueResults };
  for (const result of status.results) {
    leagueResults[result.leagueId] = { state: result.state, at: now.toISOString() };
    if (result.state === "espn-login-required") {
      leagueBackoffUntil[result.leagueId] = new Date(
        now.getTime() + loginRequiredBackoffMs,
      ).toISOString();
    } else if (result.state === "error") {
      leagueBackoffUntil[result.leagueId] = new Date(
        now.getTime() + retryableLeagueBackoffMs,
      ).toISOString();
    } else if (result.state === "laces-out-auth-failed") {
      leagueBackoffUntil[result.leagueId] = new Date(
        now.getTime() + loginRequiredBackoffMs,
      ).toISOString();
    } else if (result.state === "synced") {
      delete leagueBackoffUntil[result.leagueId];
    }
  }
  await setMaintenanceState({
    ...state,
    lastBaselineAt: plan.kind === "baseline" ? now.toISOString() : state.lastBaselineAt,
    leagueBackoffUntil,
    leagueResults,
  });
}

function runMaintenance(): Promise<void> {
  if (activeMaintenance) return activeMaintenance;
  activeMaintenance = runMaintenanceCycle().finally(() => {
    activeMaintenance = undefined;
  });
  return activeMaintenance;
}

async function runManualSynchronization(): Promise<BridgeStatus> {
  const status = await synchronize();
  const state = await getMaintenanceState();
  await setMaintenanceState({ ...state, lastBaselineAt: new Date().toISOString() });
  return status;
}

function sessionReply(status: BridgeServerSessionStatus, ok = true): BridgeServerSessionResponse {
  return { ok, status };
}

async function captureEspnSessionFromCookieStore(): Promise<CapturedEspnSession | undefined> {
  try {
    const [swid, espnS2] = await Promise.all([
      chrome.cookies.get({ url: "https://fantasy.espn.com/football/", name: "SWID" }),
      chrome.cookies.get({ url: "https://fantasy.espn.com/football/", name: "espn_s2" }),
    ]);
    return capturedEspnSessionFromCookies(swid, espnS2, new Date().toISOString());
  } catch {
    return undefined;
  }
}

// League discovery answers a Laces Out page's DISCOVER_LEAGUES with the leagues
// on the signed-in ESPN account, so members pick from a list instead of typing
// IDs. Only the SWID cookie is read — for the URL path; `espn_s2` rides along
// via `credentials: "include"` and is never touched. Nothing is stored, and the
// in-flight/cache pair bounds how much ESPN traffic a polling page can cause.
const DISCOVERY_CACHE_TTL_MS = 30 * 1000;
let activeDiscovery:
  { readonly season: number; readonly promise: Promise<BridgeDiscoverLeaguesResponse> } | undefined;
let discoveryCache:
  | {
      readonly season: number;
      readonly at: number;
      readonly response: BridgeDiscoverLeaguesResponse;
    }
  | undefined;

async function readSwidFromCookieStore(): Promise<string | undefined> {
  let cookie: chrome.cookies.Cookie | null;
  try {
    cookie = await chrome.cookies.get({
      url: "https://fantasy.espn.com/football/",
      name: "SWID",
    });
  } catch {
    return undefined;
  }
  if (cookie?.name !== "SWID") return undefined;
  let swid = cookie.value;
  try {
    swid = decodeURIComponent(swid);
  } catch {
    // Keep the raw value; validation below decides.
  }
  swid = swid.trim();
  return isValidSwid(swid) ? swid : undefined;
}

async function performLeagueDiscovery(season: number): Promise<BridgeDiscoverLeaguesResponse> {
  const loginRequired: BridgeDiscoverLeaguesResponse = {
    ok: false,
    state: "espn-login-required",
    reason: "Sign in to ESPN in this browser, then try again.",
  };
  const swid = await readSwidFromCookieStore();
  if (swid === undefined) return loginRequired;
  let response: Response;
  try {
    response = await fetch(fanProfileEndpoint(swid), {
      method: "GET",
      headers: { Accept: "application/json" },
      credentials: "include",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
  } catch {
    return { ok: false, state: "error", reason: "ESPN could not be reached." };
  }
  if ([401, 403].includes(response.status)) return loginRequired;
  if (!response.ok) {
    return { ok: false, state: "error", reason: `ESPN returned status ${response.status}.` };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(await readBoundedText(response));
  } catch {
    return { ok: false, state: "error", reason: "ESPN returned an unreadable profile." };
  }
  const { leagues, seasonMatched } = parseFanProfileLeagues(payload, season);
  return { ok: true, state: "ok", leagues, seasonMatched };
}

function handleDiscoverLeagues(message: unknown): Promise<BridgeDiscoverLeaguesResponse> {
  let season: number;
  try {
    season = validateDiscoverLeaguesMessage(message);
  } catch (error) {
    return Promise.resolve({
      ok: false,
      state: "error",
      reason: error instanceof Error ? error.message : "Invalid discovery request",
    });
  }
  if (
    discoveryCache !== undefined &&
    discoveryCache.season === season &&
    Date.now() - discoveryCache.at < DISCOVERY_CACHE_TTL_MS
  ) {
    return Promise.resolve(discoveryCache.response);
  }
  if (activeDiscovery?.season === season) return activeDiscovery.promise;
  const promise = performLeagueDiscovery(season)
    .then((response) => {
      if (response.ok) discoveryCache = { season, at: Date.now(), response };
      return response;
    })
    .finally(() => {
      if (activeDiscovery?.promise === promise) activeDiscovery = undefined;
    });
  activeDiscovery = { season, promise };
  return promise;
}

async function handleBridgePing(senderOrigin: string | undefined): Promise<BridgePingResponse> {
  let configuration: BridgeConfiguration | undefined;
  try {
    configuration = await getConfiguration();
  } catch {
    configuration = undefined;
  }
  const [status, stored] = await Promise.all([
    getStatus(),
    chrome.storage.local.get(pendingPairingStorageKey),
  ]);
  const pending = validateStoredPendingOffer(stored[pendingPairingStorageKey]);
  return {
    ok: true,
    discovery: true,
    version: chrome.runtime.getManifest().version,
    configured: configuration !== undefined,
    pairedToThisOrigin:
      configuration !== undefined &&
      typeof senderOrigin === "string" &&
      senderOrigin === configuration.apiBaseUrl,
    pendingOffer: pending !== undefined && pairingOfferIsFresh(pending, Date.now()),
    state: status.state,
    lastSuccessfulAt: status.lastSuccessfulAt,
  };
}

async function pendingServerSessionEnable(): Promise<boolean> {
  const stored = await chrome.storage.local.get(serverSessionPendingStorageKey);
  const value = stored[serverSessionPendingStorageKey];
  if (
    !isRecord(value) ||
    typeof value.requestedAt !== "string" ||
    !Number.isFinite(Date.parse(value.requestedAt)) ||
    Date.now() - Date.parse(value.requestedAt) >= SERVER_SESSION_PENDING_TTL_MS
  ) {
    if (value !== undefined) await chrome.storage.local.remove(serverSessionPendingStorageKey);
    return false;
  }
  return true;
}

async function uploadServerSession(
  configuration: BridgeConfiguration,
  captured: CapturedEspnSession,
): Promise<BridgeServerSessionResponse> {
  let response: Response;
  try {
    response = await fetch(`${configuration.apiBaseUrl}/v1/bridge/espn/session-grants`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bridge ${configuration.deviceToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        swid: captured.swid,
        espnS2: captured.espnS2,
        capturedAt: captured.capturedAt,
      }),
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
  } catch {
    const status = await setServerSessionStatus({
      state: "error",
      message: "Laces Out could not be reached. Try again.",
      connectionId: null,
      updatedAt: new Date().toISOString(),
    });
    return sessionReply(status, false);
  }
  if (!response.ok) {
    const unavailable = response.status === 404 || response.status === 503;
    const status = await setServerSessionStatus({
      state: unavailable ? "unavailable" : "error",
      message: unavailable
        ? "This Laces Out instance does not offer always-on ESPN sync."
        : response.status === 401 || response.status === 403
          ? "Laces Out pairing was rejected. Pair this browser again."
          : "Always-on ESPN sync could not be enabled.",
      connectionId: null,
      updatedAt: new Date().toISOString(),
    });
    return sessionReply(status, false);
  }
  const raw = await readBoundedText(response, 32 * 1024);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    body = undefined;
  }
  if (
    !isRecord(body) ||
    typeof body.connectionId !== "string" ||
    !/^[0-9a-f-]{36}$/iu.test(body.connectionId)
  ) {
    const status = await setServerSessionStatus({
      state: "error",
      message: "Laces Out returned an invalid authorization response.",
      connectionId: null,
      updatedAt: new Date().toISOString(),
    });
    return sessionReply(status, false);
  }
  await chrome.storage.local.remove(serverSessionPendingStorageKey);
  const status = await setServerSessionStatus({
    state: "enabled",
    message: "Always-on ESPN sync is enabled.",
    connectionId: body.connectionId,
    updatedAt: new Date().toISOString(),
  });
  return sessionReply(status);
}

async function captureServerSessionFromTab(tabId: number): Promise<BridgeServerSessionResponse> {
  const configuration = await getConfiguration();
  if (!configuration) {
    return sessionReply(
      await setServerSessionStatus({
        state: "error",
        message: "Pair this bridge with Laces Out first.",
        connectionId: null,
        updatedAt: new Date().toISOString(),
      }),
      false,
    );
  }
  let tab: chrome.tabs.Tab | undefined;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    tab = undefined;
  }
  const tabUrl = tab?.url;
  const captured =
    typeof tabUrl === "string" && tabUrl.startsWith("https://fantasy.espn.com/football/")
      ? await captureEspnSessionFromCookieStore()
      : undefined;
  if (!captured) {
    return sessionReply(
      await setServerSessionStatus({
        state: "login-required",
        message: "Sign in to ESPN in the opened tab to finish enabling always-on sync.",
        connectionId: null,
        updatedAt: new Date().toISOString(),
      }),
      false,
    );
  }
  return uploadServerSession(configuration, captured);
}

async function beginServerSessionEnable(): Promise<BridgeServerSessionResponse> {
  const configuration = await getConfiguration();
  if (!configuration) {
    return sessionReply(
      await setServerSessionStatus({
        state: "error",
        message: "Pair this bridge with Laces Out first.",
        connectionId: null,
        updatedAt: new Date().toISOString(),
      }),
      false,
    );
  }
  const requestedAt = new Date().toISOString();
  await chrome.storage.local.set({ [serverSessionPendingStorageKey]: { requestedAt } });
  await setServerSessionStatus({
    state: "enabling",
    message: "Checking your ESPN sign-in…",
    connectionId: null,
    updatedAt: requestedAt,
  });
  const tabs = await chrome.tabs.query({ url: "https://fantasy.espn.com/football/*" });
  const tab = tabs.find((candidate) => candidate.active && candidate.id !== undefined) ?? tabs[0];
  if (tab?.id !== undefined) return captureServerSessionFromTab(tab.id);
  await chrome.tabs.create({ url: "https://fantasy.espn.com/football/", active: true });
  return sessionReply(await getServerSessionStatus());
}

async function continueServerSessionEnable(
  sender: chrome.runtime.MessageSender,
): Promise<BridgeServerSessionResponse> {
  if (!(await pendingServerSessionEnable())) return sessionReply(await getServerSessionStatus());
  const tabId = sender.tab?.id;
  const senderUrl = sender.url ?? sender.tab?.url;
  if (
    sender.id !== chrome.runtime.id ||
    tabId === undefined ||
    typeof senderUrl !== "string" ||
    !senderUrl.startsWith("https://fantasy.espn.com/football/")
  ) {
    return sessionReply(await getServerSessionStatus(), false);
  }
  return captureServerSessionFromTab(tabId);
}

// ---------------------------------------------------------------------------------------------
// Live ESPN draft feed
//
// The content script is untrusted input. Everything it claims is re-validated here, and the league
// it may claim is bounded by the browser-attested sender URL, not by the message body. The device
// credential is attached only in this file and is never echoed back to the content script or page.
// ---------------------------------------------------------------------------------------------

async function getLiveDraftStatus(): Promise<BridgeLiveDraftStatus> {
  const stored = await chrome.storage.local.get(liveDraftStatusStorageKey);
  return validateStoredLiveDraftStatus(stored[liveDraftStatusStorageKey]);
}

async function setLiveDraftStatus(
  update: Partial<BridgeLiveDraftStatus>,
): Promise<BridgeLiveDraftStatus> {
  const status: BridgeLiveDraftStatus = { ...(await getLiveDraftStatus()), ...update };
  await chrome.storage.local.set({ [liveDraftStatusStorageKey]: status });
  return status;
}

let liveDraftSessionTail: Promise<void> = Promise.resolve();

/** Serializes session-storage decisions across overlapping messages and queue callbacks. */
function withLiveDraftSessionLock<Result>(operation: () => Promise<Result>): Promise<Result> {
  const result = liveDraftSessionTail.then(operation, operation);
  liveDraftSessionTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function pageSessionFor(
  route: { readonly leagueId: string; readonly season: number },
  pageSessionId: string,
  sender: chrome.runtime.MessageSender,
): LiveDraftPageSession | null {
  const tabId = sender.tab?.id;
  return typeof tabId === "number" && validLiveDraftPageSessionId(pageSessionId)
    ? { ...route, pageSessionId, tabId }
    : null;
}

function activeMatchesObservation(
  active: ReturnType<typeof validateStoredLiveDraftPageSession>,
  observation: EspnLiveDraftObservationV1,
  nowMs: number,
): boolean {
  if (active === null) return false;
  const ageMs = nowMs - active.lastSeenAtMs;
  return (
    !active.departed &&
    ageMs >= 0 &&
    ageMs < liveDraftActiveSessionTtlMs &&
    active.leagueId === observation.leagueId &&
    active.season === observation.season &&
    active.pageSessionId === observation.pageSessionId
  );
}

async function storedActiveLiveDraftSession() {
  const stored = await chrome.storage.session.get(liveDraftActiveSessionStorageKey);
  return validateStoredLiveDraftPageSession(stored[liveDraftActiveSessionStorageKey]);
}

async function removePendingObservationForSession(pageSessionId: string): Promise<void> {
  const stored = await chrome.storage.local.get(liveDraftPendingStorageKey);
  try {
    const pending = validateEspnLiveDraftObservation(stored[liveDraftPendingStorageKey]);
    if (pending.pageSessionId === pageSessionId) {
      await chrome.storage.local.remove(liveDraftPendingStorageKey);
    }
  } catch {
    if (stored[liveDraftPendingStorageKey] !== undefined) {
      await chrome.storage.local.remove(liveDraftPendingStorageKey);
    }
  }
}

async function claimActiveLiveDraftSession(
  candidate: LiveDraftPageSession,
): Promise<LiveDraftPageSessionClaim> {
  return withLiveDraftSessionLock(async () => {
    const current = await storedActiveLiveDraftSession();
    const claim = claimLiveDraftPageSession(current, candidate, Date.now());
    if (claim.outcome === "standby") return claim;
    await chrome.storage.session.set({ [liveDraftActiveSessionStorageKey]: claim.active });
    if (claim.replaced !== null) {
      liveDraftQueue.clearSession(claim.replaced.pageSessionId);
      await removePendingObservationForSession(claim.replaced.pageSessionId);
    }
    return claim;
  });
}

/** Stops local work for the matching page without shortening the server-aligned failover TTL. */
async function departActiveLiveDraftSession(candidate: LiveDraftPageSession): Promise<boolean> {
  return withLiveDraftSessionLock(async () => {
    const active = await storedActiveLiveDraftSession();
    if (active === null || !sameLiveDraftPageSession(active, candidate)) return false;
    await chrome.storage.session.set({
      [liveDraftActiveSessionStorageKey]: { ...active, departed: true },
    });
    liveDraftQueue.clearSession(candidate.pageSessionId);
    await removePendingObservationForSession(candidate.pageSessionId);
    return true;
  });
}

/**
 * Retains the newest revision from the active page. The persisted copy repairs a queue abandonment
 * on the next heartbeat and survives a service-worker eviction.
 */
async function retainLatestActiveObservation(
  observation: EspnLiveDraftObservationV1,
): Promise<"retained" | "older" | "standby"> {
  return withLiveDraftSessionLock(async () => {
    const active = await storedActiveLiveDraftSession();
    if (!activeMatchesObservation(active, observation, Date.now())) return "standby";
    const stored = await chrome.storage.local.get(liveDraftPendingStorageKey);
    try {
      const pending = validateEspnLiveDraftObservation(stored[liveDraftPendingStorageKey]);
      if (
        pending.pageSessionId === observation.pageSessionId &&
        pending.revision >= observation.revision
      ) {
        return "older";
      }
    } catch {
      // A malformed retained value is replaced atomically by this validated observation.
    }
    await chrome.storage.local.set({ [liveDraftPendingStorageKey]: observation });
    return "retained";
  });
}

async function pendingObservationForActiveSession(
  source: Pick<EspnLiveDraftObservationV1, "leagueId" | "season" | "pageSessionId">,
): Promise<EspnLiveDraftObservationV1 | null> {
  return withLiveDraftSessionLock(async () => {
    const active = await storedActiveLiveDraftSession();
    const stored = await chrome.storage.local.get(liveDraftPendingStorageKey);
    let pending: EspnLiveDraftObservationV1;
    try {
      pending = validateEspnLiveDraftObservation(stored[liveDraftPendingStorageKey]);
    } catch {
      if (stored[liveDraftPendingStorageKey] !== undefined) {
        await chrome.storage.local.remove(liveDraftPendingStorageKey);
      }
      return null;
    }
    if (
      !activeMatchesObservation(active, pending, Date.now()) ||
      pending.leagueId !== source.leagueId ||
      pending.season !== source.season ||
      pending.pageSessionId !== source.pageSessionId
    ) {
      return null;
    }
    return pending;
  });
}

async function removePendingObservationIfCurrent(
  observation: EspnLiveDraftObservationV1,
): Promise<void> {
  const stored = await chrome.storage.local.get(liveDraftPendingStorageKey);
  try {
    const pending = validateEspnLiveDraftObservation(stored[liveDraftPendingStorageKey]);
    if (
      pending.leagueId === observation.leagueId &&
      pending.season === observation.season &&
      pending.pageSessionId === observation.pageSessionId &&
      pending.revision === observation.revision &&
      pending.checksumSha256 === observation.checksumSha256
    ) {
      await chrome.storage.local.remove(liveDraftPendingStorageKey);
    }
  } catch {
    // A later valid observation must not be removed because an older event could not parse it.
  }
}

function standbyLiveDraftReply(
  status: BridgeLiveDraftStatus,
  resolvedScope: BridgeLiveDraftScope | null = null,
): BridgeLiveDraftResponse {
  return liveDraftReply(
    {
      ...status,
      scope: "in-scope",
      state: "standby",
      message: "Another ESPN draft tab is the active read-only source; waiting for failover.",
      ...(resolvedScope === null
        ? {}
        : { leagueId: resolvedScope.leagueId, season: resolvedScope.season }),
    },
    false,
    resolvedScope,
  );
}

async function uploadLiveDraft(body: string): Promise<LiveDraftUploadOutcome> {
  const configuration = await getConfiguration();
  if (!configuration) return { kind: "unauthorized" };
  const expectation = liveDraftResponseExpectation(body);
  if (expectation === null) return { kind: "retry" };
  const deadline = createLiveDraftRequestDeadline();
  try {
    const response = await fetch(`${configuration.apiBaseUrl}${liveDraftIngestPath}`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bridge ${configuration.deviceToken}`,
        "Content-Type": "application/json",
      },
      body,
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: deadline.signal,
    });
    if (response.status < 200 || response.status >= 300) {
      return classifyLiveDraftIngestResponse(response.status, undefined, expectation);
    }
    const responseText = await readBoundedText(response, LIVE_DRAFT_MAXIMUM_RESPONSE_BYTES);
    return classifyLiveDraftIngestResponse(response.status, JSON.parse(responseText), expectation);
  } catch {
    // Laces Out unreachable: retry with backoff rather than dropping the board.
    return { kind: "retry" };
  } finally {
    deadline.clear();
  }
}

const uploadMessages: Readonly<Record<LiveDraftUploadOutcome["kind"], string>> = {
  accepted: "Live draft sync is current.",
  standby: "Another source currently owns this live draft; this board is retained for failover.",
  held: "Laces Out held this draft update for review instead of applying it.",
  rejected: "Laces Out could not accept the observed draft state.",
  unauthorized: "Laces Out pairing was rejected. Create a new bridge device token.",
  retry: "Laces Out is unreachable; retrying.",
};

function liveDraftStatusStateForUpload(
  outcome: LiveDraftUploadOutcome,
  draftState: BridgeLiveDraftStatus["draftState"],
): BridgeLiveDraftStatus["state"] {
  switch (outcome.kind) {
    case "accepted":
      return draftState === "complete" ? "complete" : "accepted";
    case "standby":
      return "standby";
    case "held":
      return "held";
    case "rejected":
      return "rejected";
    case "unauthorized":
      return "unauthorized";
    case "retry":
      return "offline";
  }
}

function heartbeatPreservesBoardOutcome(
  previous: BridgeLiveDraftStatus,
  outcome: LiveDraftUploadOutcome,
): boolean {
  // A heartbeat can answer standby simply because the latest held/rejected checksum never became
  // the feed checksum, and a transport retry is likewise not a new board decision. Keep the
  // actionable semantic result visible until a newer observation is evaluated.
  return (
    (previous.state === "held" || previous.state === "rejected") &&
    (outcome.kind === "accepted" || outcome.kind === "standby" || outcome.kind === "retry")
  );
}

const liveDraftQueue = new LiveDraftUploadQueue({
  transport: uploadLiveDraft,
  sleep: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  random: () => Math.random(),
  onEvent: (event) => {
    void withLiveDraftSessionLock(async () => {
      const active = await storedActiveLiveDraftSession();
      if (!activeMatchesObservation(active, event.observation, Date.now())) return;
      if (event.kind === "retrying") {
        await setLiveDraftStatus({ state: "offline", message: uploadMessages.retry });
        return;
      }
      if (event.kind === "abandoned" || event.kind === "oversized") {
        if (event.kind === "oversized") {
          await removePendingObservationIfCurrent(event.observation);
        }
        const previous = await getLiveDraftStatus();
        await setLiveDraftStatus({
          state: "error",
          message:
            event.kind === "oversized"
              ? "The observed draft board exceeded the safety limit and was discarded."
              : "Laces Out did not accept the latest draft update; retained state will retry.",
          consecutiveFailures: previous.consecutiveFailures + 1,
          queuedSnapshot: liveDraftQueue.queued.snapshot,
        });
        return;
      }
      const accepted = event.outcome.kind === "accepted";
      const retained = liveDraftRetainedObservationDisposition(event.outcome) === "retain";
      if (!retained) await removePendingObservationIfCurrent(event.observation);
      const previous = await getLiveDraftStatus();
      await setLiveDraftStatus({
        state: liveDraftStatusStateForUpload(event.outcome, previous.draftState),
        message: uploadMessages[event.outcome.kind],
        lastAcceptedAt: accepted ? new Date().toISOString() : previous.lastAcceptedAt,
        consecutiveFailures:
          accepted || event.outcome.kind === "standby" ? 0 : previous.consecutiveFailures + 1,
        queuedSnapshot: retained || liveDraftQueue.queued.snapshot,
      });
    });
  },
});

function liveDraftReply(
  status: BridgeLiveDraftStatus,
  ok = true,
  resolvedScope: BridgeLiveDraftScope | null = null,
): BridgeLiveDraftResponse {
  return { ok, status, resolvedScope };
}

async function rejectLiveDraft(message: string): Promise<BridgeLiveDraftResponse> {
  return liveDraftReply(
    await setLiveDraftStatus({ scope: "out-of-scope", state: "rejected", message }),
    false,
  );
}

/**
 * Re-derives the checksum from the durable fields rather than trusting the one that arrived.
 *
 * The server recomputes it too; doing it here as well means a content script that has been tampered
 * with cannot get a mismatched body accepted anywhere, and the failure is visible locally.
 */
async function checksumMatches(observation: EspnLiveDraftObservationV1): Promise<boolean> {
  const expected = await espnLiveDraftChecksum(espnLiveDraftDigestSource(observation));
  return expected === observation.checksumSha256;
}

async function handleLiveDraftRequest(
  request: BridgeLiveDraftRequest,
  sender: chrome.runtime.MessageSender,
): Promise<BridgeLiveDraftResponse> {
  const senderCheck = validateLiveDraftSender(sender, chrome.runtime.id);

  // The popup is an extension page, not a draft-room content script, so it has no tab and no ESPN
  // URL. It may read the stored bounded status and nothing else; every message that could move the
  // feed still requires a validated content-script sender.
  if (!senderCheck.ok && request.type === "GET_LIVE_DRAFT_STATUS") {
    if (sender.id !== chrome.runtime.id || sender.tab !== undefined) {
      return liveDraftReply({ ...defaultLiveDraftStatus, state: "rejected" }, false);
    }
    return liveDraftReply(await getLiveDraftStatus());
  }
  if (!senderCheck.ok) {
    return liveDraftReply(
      { ...defaultLiveDraftStatus, state: "rejected", message: "Live draft sender was refused." },
      false,
    );
  }
  const route = senderCheck.route;

  let configuration: BridgeConfiguration | undefined;
  try {
    configuration = await getConfiguration();
  } catch {
    configuration = undefined;
  }
  const routeResolution = resolveLiveDraftPageScope(
    route,
    configuration === undefined ? [] : [configuration],
  );

  if (request.type === "GET_LIVE_DRAFT_STATUS") {
    const current = await getLiveDraftStatus();
    const requestMatchesScope =
      routeResolution.ok &&
      (request.leagueId === undefined || request.leagueId === routeResolution.scope.leagueId) &&
      (request.season === undefined || request.season === routeResolution.scope.season);
    if (!requestMatchesScope || !routeResolution.ok) {
      return liveDraftReply(
        await setLiveDraftStatus({
          scope: configuration ? "out-of-scope" : "not-configured",
          state: "idle",
          message: configuration
            ? "This ESPN league is not paired with Laces Out on this browser."
            : "Pair this bridge with Laces Out to follow a draft.",
          leagueId: route.leagueId,
          season: route.season ?? null,
        }),
        false,
      );
    }
    const resolvedScope = routeResolution.scope;
    const page = pageSessionFor(resolvedScope, request.pageSessionId ?? "", sender);
    if (page === null) return rejectLiveDraft("A live draft page session identifier is required.");
    const claim = await claimActiveLiveDraftSession(page);
    if (claim.outcome === "standby") return standbyLiveDraftReply(current, resolvedScope);
    return liveDraftReply(
      await setLiveDraftStatus({
        scope: "in-scope",
        state: "observing",
        message: "Following this ESPN draft room.",
        leagueId: resolvedScope.leagueId,
        season: resolvedScope.season,
      }),
      true,
      resolvedScope,
    );
  }

  if (request.type === "LIVE_DRAFT_PAGE_LEFT") {
    const scope = validateLiveDraftScope(request, route, configuration);
    if (!scope.ok || !routeResolution.ok) {
      return rejectLiveDraft("This ESPN league is outside the paired bridge scope.");
    }
    const page = pageSessionFor(routeResolution.scope, request.pageSessionId, sender);
    if (page === null) return rejectLiveDraft("A malformed live draft page session was refused.");
    if (!(await departActiveLiveDraftSession(page))) {
      return standbyLiveDraftReply(await getLiveDraftStatus(), routeResolution.scope);
    }
    return liveDraftReply(
      await setLiveDraftStatus({
        state: "idle",
        message: "The ESPN draft room was closed on this browser.",
        queuedSnapshot: false,
      }),
    );
  }

  if (request.type === "LIVE_DRAFT_HEARTBEAT") {
    let heartbeat;
    try {
      heartbeat = validateEspnLiveDraftHeartbeat(request.heartbeat);
    } catch {
      return rejectLiveDraft("A malformed live draft heartbeat was discarded.");
    }
    const scope = validateLiveDraftScope(heartbeat, route, configuration);
    if (!scope.ok || !routeResolution.ok) {
      return rejectLiveDraft("This ESPN league is outside the paired bridge scope.");
    }
    const page = pageSessionFor(routeResolution.scope, heartbeat.pageSessionId, sender);
    if (page === null) return rejectLiveDraft("A malformed live draft page session was refused.");
    const claim = await claimActiveLiveDraftSession(page);
    if (claim.outcome === "standby") {
      return standbyLiveDraftReply(await getLiveDraftStatus(), routeResolution.scope);
    }

    // Repair an abandoned or worker-interrupted observation before asking the server to renew
    // freshness. Its revision/checksum fence refuses the heartbeat until this exact state lands.
    const pending = await pendingObservationForActiveSession(heartbeat);
    if (pending !== null) {
      await liveDraftQueue.submit(pending, "snapshot");
      // A bounded queue retry can span most of the local lease. Confirm this page still owns the
      // source before its trailing heartbeat can renew a lease after another tab took over.
      const renewed = await claimActiveLiveDraftSession(page);
      if (renewed.outcome === "standby") {
        return standbyLiveDraftReply(await getLiveDraftStatus(), routeResolution.scope);
      }
    }
    const outcome = await uploadLiveDraft(JSON.stringify(heartbeat));
    const previous = await getLiveDraftStatus();
    const accepted = outcome.kind === "accepted";
    const retained = liveDraftRetainedObservationDisposition(outcome) === "retain";
    const preserveBoardOutcome = heartbeatPreservesBoardOutcome(previous, outcome);
    return liveDraftReply(
      await setLiveDraftStatus({
        scope: "in-scope",
        state: preserveBoardOutcome
          ? previous.state
          : liveDraftStatusStateForUpload(outcome, heartbeat.state),
        message: preserveBoardOutcome ? previous.message : uploadMessages[outcome.kind],
        draftState: heartbeat.state,
        lastObservedAt: heartbeat.capturedAt,
        lastAcceptedAt:
          accepted && !preserveBoardOutcome ? new Date().toISOString() : previous.lastAcceptedAt,
        consecutiveFailures: preserveBoardOutcome
          ? previous.consecutiveFailures
          : accepted || outcome.kind === "standby"
            ? 0
            : previous.consecutiveFailures + 1,
        queuedSnapshot: retained && pending !== null,
      }),
      accepted,
    );
  }

  let observation: EspnLiveDraftObservationV1;
  try {
    observation = validateEspnLiveDraftObservation(request.observation);
  } catch {
    return rejectLiveDraft("A malformed live draft observation was discarded.");
  }
  const scope = validateLiveDraftScope(observation, route, configuration);
  if (!scope.ok || !routeResolution.ok) {
    return rejectLiveDraft("This ESPN league is outside the paired bridge scope.");
  }
  if (!(await checksumMatches(observation))) {
    return rejectLiveDraft("A live draft observation failed its checksum and was discarded.");
  }
  const page = pageSessionFor(routeResolution.scope, observation.pageSessionId, sender);
  if (page === null) return rejectLiveDraft("A malformed live draft page session was refused.");
  const claim = await claimActiveLiveDraftSession(page);
  if (claim.outcome === "standby") {
    return standbyLiveDraftReply(await getLiveDraftStatus(), routeResolution.scope);
  }

  // Both durable and transient revisions are retained. Otherwise a lost high-bid update could be
  // masked by later heartbeats while only the older server-side bid remained actionable.
  const retained = await retainLatestActiveObservation(observation);
  if (retained === "standby") {
    return standbyLiveDraftReply(await getLiveDraftStatus(), routeResolution.scope);
  }
  if (retained === "older") {
    return liveDraftReply(await getLiveDraftStatus());
  }
  void liveDraftQueue.submit(observation, request.transient ? "transient" : "snapshot");
  return liveDraftReply(
    await setLiveDraftStatus({
      scope: "in-scope",
      state: "observing",
      message: "Sending the observed draft state to Laces Out.",
      leagueId: observation.leagueId,
      season: observation.season,
      draftState: observation.state,
      pickCount: observation.picks.length,
      lastObservedAt: observation.capturedAt,
      lastChecksumSha256: observation.checksumSha256,
      queuedSnapshot: liveDraftQueue.queued.snapshot,
    }),
  );
}

/** Re-queues the one retained snapshot after the service worker was evicted mid-upload. */
async function restoreLiveDraftQueue(): Promise<void> {
  const stored = await chrome.storage.local.get(liveDraftPendingStorageKey);
  if (stored[liveDraftPendingStorageKey] === undefined) return;
  try {
    const observation = validateEspnLiveDraftObservation(stored[liveDraftPendingStorageKey]);
    const active = await storedActiveLiveDraftSession();
    if (
      activeMatchesObservation(active, observation, Date.now()) &&
      (await checksumMatches(observation))
    ) {
      void liveDraftQueue.submit(observation, "snapshot");
    } else {
      await chrome.storage.local.remove(liveDraftPendingStorageKey);
    }
  } catch {
    await chrome.storage.local.remove(liveDraftPendingStorageKey);
  }
}

async function handleRequest(
  request: BridgeRequest,
  sender: chrome.runtime.MessageSender,
): Promise<BridgeResponse | BridgeServerSessionResponse> {
  if (request.type === "GET_STATUS") return { ok: true, status: await getStatus() };
  if (request.type === "GET_SERVER_SESSION_STATUS") {
    return sessionReply(await getServerSessionStatus());
  }
  if (request.type === "ENABLE_SERVER_SESSION") return beginServerSessionEnable();
  if (request.type === "ESPN_SESSION_PAGE_READY") {
    return continueServerSessionEnable(sender);
  }
  if (request.type === "DISCONNECT") {
    await chrome.storage.local.remove([
      configurationStorageKey,
      statusStorageKey,
      maintenanceStorageKey,
      serverSessionStatusStorageKey,
      serverSessionPendingStorageKey,
      liveDraftStatusStorageKey,
      liveDraftPendingStorageKey,
    ]);
    await chrome.storage.session.remove(liveDraftActiveSessionStorageKey);
    liveDraftQueue.clear();
    await chrome.alarms.clear(syncAlarmName);
    void clearPairingNudge();
    return { ok: true, status: DEFAULT_STATUS };
  }
  if (request.type === "CONFIGURE") {
    const configuration = validateBridgeConfiguration(request.configuration);
    await chrome.storage.local.set({ [configurationStorageKey]: configuration });
    await setMaintenanceState(defaultMaintenanceState);
    if (configuration.automaticSync) {
      await chrome.alarms.create(syncAlarmName, {
        delayInMinutes: 1,
        periodInMinutes: maintenancePollIntervalMinutes,
      });
    } else {
      await chrome.alarms.clear(syncAlarmName);
    }
    const status = await setStatus({
      ...DEFAULT_STATUS,
      configured: true,
      state: "ready",
      message: `Paired for ${configuration.leagueIds.length} ESPN ${configuration.leagueIds.length === 1 ? "league" : "leagues"}. Sync while signed in to ESPN.`,
    });
    void clearPairingNudge();
    // First sync starts now rather than at the alarm's one-minute delay, and
    // deliberately does not block this response: the popup renders "paired"
    // immediately while data lands in the background.
    void runManualSynchronization();
    return { ok: true, status };
  }
  if (request.type === "SYNC_NOW") {
    return { ok: true, status: await runManualSynchronization() };
  }
  // Every request type is now explicit. A live draft message reaching here means the listener
  // routed it wrongly; fail closed rather than silently starting a full league sync — the old
  // implicit fallthrough would have turned a draft-room mutation into an ESPN refresh storm.
  throw new TypeError("Unsupported bridge request");
}

async function restoreAutomaticAlarm(): Promise<void> {
  try {
    const configuration = await getConfiguration();
    if (configuration?.automaticSync) {
      await chrome.alarms.create(syncAlarmName, {
        delayInMinutes: 1,
        periodInMinutes: maintenancePollIntervalMinutes,
      });
    } else {
      await chrome.alarms.clear(syncAlarmName);
    }
  } catch {
    await chrome.alarms.clear(syncAlarmName);
    const previous = await getStatus();
    await setStatus({
      ...DEFAULT_STATUS,
      state: "error",
      message: "Stored bridge configuration is invalid. Pair this browser again.",
      lastSuccessfulAt: previous.lastSuccessfulAt,
    });
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void restoreAutomaticAlarm();
});

chrome.runtime.onStartup.addListener(() => {
  void restoreAutomaticAlarm();
  void restoreLiveDraftQueue();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === syncAlarmName) void runMaintenance();
});

const DEFAULT_ACTION_TITLE = "Laces Out ESPN Bridge";

// Draws the member to the one remaining pairing step. `openPopup` exists from
// Chrome 127 and may throw (no focused window, popup already open); the badge
// is the always-available fallback. Cosmetic — never fails the pairing path.
async function showPairingNudge(): Promise<void> {
  try {
    await chrome.action.setBadgeBackgroundColor({ color: "#b45309" });
    await chrome.action.setBadgeText({ text: "1" });
    await chrome.action.setTitle({ title: "Laces Out — confirm pairing" });
  } catch {
    // Badge APIs are cosmetic.
  }
  if (typeof chrome.action.openPopup === "function") {
    try {
      await chrome.action.openPopup();
    } catch {
      // The badge remains as the nudge.
    }
  }
}

async function clearPairingNudge(): Promise<void> {
  try {
    await chrome.action.setBadgeText({ text: "" });
    await chrome.action.setTitle({ title: DEFAULT_ACTION_TITLE });
  } catch {
    // Badge APIs are cosmetic.
  }
}

// A Laces Out page (allowed via `externally_connectable`) can offer to pair the
// bridge with itself. Store a valid offer as PENDING and never configure or
// request permissions here — completion requires an explicit popup gesture. The
// token is never logged or echoed back.
async function handlePairingOffer(
  message: unknown,
  senderOrigin: string | undefined,
): Promise<BridgePairingOfferResponse> {
  let configuration: BridgeConfiguration;
  try {
    configuration = validateBridgePairingOffer(message, senderOrigin);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "Invalid pairing offer" };
  }
  await chrome.storage.local.set({
    [pendingPairingStorageKey]: createPendingPairingOffer(configuration, new Date().toISOString()),
  });
  void showPairingNudge();
  return { ok: true, state: "pending-confirmation" };
}

chrome.runtime.onMessageExternal.addListener(
  (
    message: unknown,
    sender,
    sendResponse: (
      response:
        | BridgePairingOfferResponse
        | BridgeServerSessionOfferResponse
        | BridgePingResponse
        | BridgeDiscoverLeaguesResponse,
    ) => void,
  ) => {
    void (async () => {
      if (isRecord(message) && message.type === "BRIDGE_PING") {
        return handleBridgePing(sender.origin);
      }
      if (isRecord(message) && message.type === "DISCOVER_LEAGUES") {
        return handleDiscoverLeagues(message);
      }
      if (isRecord(message) && message.type === "ENABLE_SERVER_SESSION") {
        const configuration = await getConfiguration();
        if (!configuration || sender.origin !== configuration.apiBaseUrl) {
          return sessionReply(
            {
              state: "error",
              message: "This page is not the paired Laces Out instance.",
              connectionId: null,
              updatedAt: new Date().toISOString(),
            },
            false,
          );
        }
        return beginServerSessionEnable();
      }
      return handlePairingOffer(message, sender.origin);
    })()
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false, reason: "Bridge request failed" }));
    return true;
  },
);

chrome.runtime.onMessage.addListener(
  (
    request: BridgeRequest,
    sender,
    sendResponse: (
      response: BridgeResponse | BridgeLiveDraftResponse | BridgeServerSessionResponse,
    ) => void,
  ) => {
    if (isBridgeLiveDraftRequest(request)) {
      void handleLiveDraftRequest(request, sender)
        .then(sendResponse)
        .catch(() => {
          sendResponse({
            ok: false,
            resolvedScope: null,
            status: {
              ...defaultLiveDraftStatus,
              state: "error",
              message: "The live draft update could not be processed.",
            },
          });
        });
      return true;
    }
    void handleRequest(request, sender)
      .then(sendResponse)
      .catch(async (error: unknown) => {
        if (
          request.type === "ENABLE_SERVER_SESSION" ||
          request.type === "GET_SERVER_SESSION_STATUS" ||
          request.type === "ESPN_SESSION_PAGE_READY"
        ) {
          sendResponse(
            sessionReply(
              await setServerSessionStatus({
                state: "error",
                message:
                  error instanceof Error
                    ? error.message.slice(0, 180)
                    : "Always-on sync request failed",
                connectionId: null,
                updatedAt: new Date().toISOString(),
              }),
              false,
            ),
          );
          return;
        }
        const status = await setStatus({
          ...DEFAULT_STATUS,
          state: "error",
          message: error instanceof Error ? error.message.slice(0, 180) : "Bridge request failed",
          lastAttemptAt: new Date().toISOString(),
        });
        sendResponse({ ok: false, status });
      });
    return true;
  },
);
