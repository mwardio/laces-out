import {
  configurationStorageKey,
  statusStorageKey,
  summarizeBridgeResults,
  syncAlarmName,
  validateBridgeConfiguration,
  type BridgeConfiguration,
  type BridgeLeagueResult,
  type BridgeRequest,
  type BridgeResponse,
  type BridgeStatus,
  type BridgeStatusState,
} from "./protocol.js";

const ESPN_ORIGIN = "https://lm-api-reads.fantasy.espn.com";
const MAX_ESPN_BYTES = 5 * 1024 * 1024;
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

async function readBoundedText(response: Response): Promise<string> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_ESPN_BYTES) {
    throw new Error("ESPN response exceeded the 5 MiB safety limit");
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
    if (total > MAX_ESPN_BYTES) {
      await reader.cancel();
      throw new Error("ESPN response exceeded the 5 MiB safety limit");
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

async function synchronizeLeague(
  configuration: BridgeConfiguration,
  leagueId: string,
  capturedAt: string,
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
    if (!uploadResponse.ok) throw new Error(`Laces Out returned status ${uploadResponse.status}`);
    return { leagueId, state: "synced", message: "Synced successfully." };
  } catch (error) {
    return {
      leagueId,
      state: "error",
      message: error instanceof Error ? error.message.slice(0, 180) : "ESPN sync failed",
    };
  }
}

let activeSynchronization: Promise<BridgeStatus> | undefined;

async function runSynchronization(): Promise<BridgeStatus> {
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
  for (const [index, leagueId] of configuration.leagueIds.entries()) {
    await setStatus({
      ...previous,
      configured: true,
      state: "syncing",
      message: `Syncing ESPN league ${index + 1} of ${configuration.leagueIds.length}…`,
      lastAttemptAt: attemptedAt,
      results: [...results],
    });
    results.push(await synchronizeLeague(configuration, leagueId, attemptedAt));
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

function synchronize(): Promise<BridgeStatus> {
  if (activeSynchronization) return activeSynchronization;
  activeSynchronization = runSynchronization().finally(() => {
    activeSynchronization = undefined;
  });
  return activeSynchronization;
}

async function handleRequest(request: BridgeRequest): Promise<BridgeResponse> {
  if (request.type === "GET_STATUS") return { ok: true, status: await getStatus() };
  if (request.type === "DISCONNECT") {
    await chrome.storage.local.remove([configurationStorageKey, statusStorageKey]);
    await chrome.alarms.clear(syncAlarmName);
    return { ok: true, status: DEFAULT_STATUS };
  }
  if (request.type === "CONFIGURE") {
    const configuration = validateBridgeConfiguration(request.configuration);
    await chrome.storage.local.set({ [configurationStorageKey]: configuration });
    if (configuration.automaticSync) {
      await chrome.alarms.create(syncAlarmName, { delayInMinutes: 1, periodInMinutes: 360 });
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
  return { ok: true, status: await synchronize() };
}

async function restoreAutomaticAlarm(): Promise<void> {
  try {
    const configuration = await getConfiguration();
    if (configuration?.automaticSync) {
      await chrome.alarms.create(syncAlarmName, { delayInMinutes: 1, periodInMinutes: 360 });
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
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === syncAlarmName) void synchronize();
});

chrome.runtime.onMessage.addListener(
  (request: BridgeRequest, _sender, sendResponse: (response: BridgeResponse) => void) => {
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
