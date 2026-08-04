import {
  configurationStorageKey,
  createPendingPairingOffer,
  isBridgeLiveDraftRequest,
  maintenanceStorageKey,
  pendingPairingStorageKey,
  statusStorageKey,
  summarizeBridgeResults,
  syncAlarmName,
  validateBridgeConfiguration,
  validateBridgePairingOffer,
  type BridgeConfiguration,
  type BridgeLeagueResult,
  type BridgeLiveDraftRequest,
  type BridgeLiveDraftResponse,
  type BridgePairingOfferResponse,
  type BridgeRequest,
  type BridgeResponse,
  type BridgeStatus,
  type BridgeStatusState,
} from "./protocol.js";
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
  classifyUploadStatus,
  defaultLiveDraftStatus,
  liveDraftIngestPath,
  liveDraftPendingStorageKey,
  liveDraftStatusStorageKey,
  validateLiveDraftScope,
  validateLiveDraftSender,
  validateStoredLiveDraftStatus,
  type BridgeLiveDraftStatus,
  type LiveDraftUploadOutcome,
} from "./live-draft/uplink.js";

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

async function uploadLiveDraft(body: string): Promise<LiveDraftUploadOutcome> {
  const configuration = await getConfiguration();
  if (!configuration) return { kind: "unauthorized" };
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
    });
    return classifyUploadStatus(response.status);
  } catch {
    // Laces Out unreachable: retry with backoff rather than dropping the board.
    return { kind: "retry" };
  }
}

const uploadMessages: Readonly<Record<LiveDraftUploadOutcome["kind"], string>> = {
  accepted: "Live draft sync is current.",
  rejected: "Laces Out could not accept the observed draft state.",
  unauthorized: "Laces Out pairing was rejected. Create a new bridge device token.",
  retry: "Laces Out is unreachable; retrying.",
};

const liveDraftQueue = new LiveDraftUploadQueue({
  transport: uploadLiveDraft,
  sleep: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  random: () => Math.random(),
  onEvent: (event) => {
    void (async () => {
      if (event.kind === "retrying") {
        await setLiveDraftStatus({ state: "offline", message: uploadMessages.retry });
        return;
      }
      if (event.kind === "abandoned" || event.kind === "oversized") {
        const previous = await getLiveDraftStatus();
        await setLiveDraftStatus({
          state: "error",
          message:
            event.kind === "oversized"
              ? "The observed draft board exceeded the safety limit and was discarded."
              : "Laces Out did not accept the latest draft update; retrying on the next change.",
          consecutiveFailures: previous.consecutiveFailures + 1,
          queuedSnapshot: liveDraftQueue.queued.snapshot,
        });
        return;
      }
      const accepted = event.outcome.kind === "accepted";
      if (accepted && event.slot === "snapshot") {
        await chrome.storage.local.remove(liveDraftPendingStorageKey);
      }
      const previous = await getLiveDraftStatus();
      await setLiveDraftStatus({
        state:
          event.outcome.kind === "accepted"
            ? previous.draftState === "complete"
              ? "complete"
              : "accepted"
            : event.outcome.kind === "unauthorized"
              ? "unauthorized"
              : "rejected",
        message: uploadMessages[event.outcome.kind],
        lastAcceptedAt: accepted ? new Date().toISOString() : previous.lastAcceptedAt,
        consecutiveFailures: accepted ? 0 : previous.consecutiveFailures + 1,
        queuedSnapshot: liveDraftQueue.queued.snapshot,
      });
    })();
  },
});

function liveDraftReply(status: BridgeLiveDraftStatus, ok = true): BridgeLiveDraftResponse {
  return { ok, status };
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

  if (request.type === "GET_LIVE_DRAFT_STATUS") {
    const claimed =
      typeof request.leagueId === "string" && typeof request.season === "number"
        ? { leagueId: request.leagueId, season: request.season }
        : { leagueId: route.leagueId, season: route.season };
    const scope = validateLiveDraftScope(claimed, route, configuration);
    const current = await getLiveDraftStatus();
    return liveDraftReply(
      await setLiveDraftStatus({
        scope: scope.ok ? "in-scope" : configuration ? "out-of-scope" : "not-configured",
        state: scope.ok ? (current.state === "idle" ? "observing" : current.state) : "idle",
        message: scope.ok
          ? "Following this ESPN draft room."
          : configuration
            ? "This ESPN league is not paired with Laces Out on this browser."
            : "Pair this bridge with Laces Out to follow a draft.",
        leagueId: claimed.leagueId,
        season: claimed.season,
      }),
      scope.ok,
    );
  }

  if (request.type === "LIVE_DRAFT_PAGE_LEFT") {
    liveDraftQueue.clear();
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
    if (!scope.ok) return rejectLiveDraft("This ESPN league is outside the paired bridge scope.");
    await uploadLiveDraft(JSON.stringify(heartbeat));
    return liveDraftReply(
      await setLiveDraftStatus({
        scope: "in-scope",
        draftState: heartbeat.state,
        lastObservedAt: heartbeat.capturedAt,
      }),
    );
  }

  let observation: EspnLiveDraftObservationV1;
  try {
    observation = validateEspnLiveDraftObservation(request.observation);
  } catch {
    return rejectLiveDraft("A malformed live draft observation was discarded.");
  }
  const scope = validateLiveDraftScope(observation, route, configuration);
  if (!scope.ok) return rejectLiveDraft("This ESPN league is outside the paired bridge scope.");
  if (!(await checksumMatches(observation))) {
    return rejectLiveDraft("A live draft observation failed its checksum and was discarded.");
  }

  // Only the latest snapshot is retained. An unsent older one is superseded, never replayed.
  if (!request.transient) {
    await chrome.storage.local.set({ [liveDraftPendingStorageKey]: observation });
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
    if (await checksumMatches(observation)) void liveDraftQueue.submit(observation, "snapshot");
    else await chrome.storage.local.remove(liveDraftPendingStorageKey);
  } catch {
    await chrome.storage.local.remove(liveDraftPendingStorageKey);
  }
}

async function handleRequest(request: BridgeRequest): Promise<BridgeResponse> {
  if (request.type === "GET_STATUS") return { ok: true, status: await getStatus() };
  if (request.type === "DISCONNECT") {
    await chrome.storage.local.remove([
      configurationStorageKey,
      statusStorageKey,
      maintenanceStorageKey,
    ]);
    await chrome.alarms.clear(syncAlarmName);
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
  return { ok: true, state: "pending-confirmation" };
}

chrome.runtime.onMessageExternal.addListener(
  (message: unknown, sender, sendResponse: (response: BridgePairingOfferResponse) => void) => {
    void handlePairingOffer(message, sender.origin)
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false, reason: "Pairing offer failed" }));
    return true;
  },
);

chrome.runtime.onMessage.addListener(
  (
    request: BridgeRequest,
    sender,
    sendResponse: (response: BridgeResponse | BridgeLiveDraftResponse) => void,
  ) => {
    if (isBridgeLiveDraftRequest(request)) {
      void handleLiveDraftRequest(request, sender)
        .then(sendResponse)
        .catch(() => {
          sendResponse({
            ok: false,
            status: {
              ...defaultLiveDraftStatus,
              state: "error",
              message: "The live draft update could not be processed.",
            },
          });
        });
      return true;
    }
    void handleRequest(request)
      .then(sendResponse)
      .catch(async (error: unknown) => {
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
