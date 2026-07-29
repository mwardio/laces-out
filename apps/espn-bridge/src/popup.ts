import type {
  BridgeLeagueResultState,
  BridgeLiveDraftRequest,
  BridgeLiveDraftResponse,
  BridgeLiveDraftStatus,
  BridgeRequest,
  BridgeResponse,
  BridgeStatus,
  PendingPairingOffer,
} from "./protocol.js";
import {
  configurationStorageKey,
  pairingOfferIsFresh,
  pendingPairingStorageKey,
  validateBridgeConfiguration,
  validateStoredPendingOffer,
} from "./protocol.js";

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing popup element: ${id}`);
  return value as T;
}

const statusPanel = element<HTMLDivElement>("status");
const statusMessage = element<HTMLParagraphElement>("status-message");
const lastSync = element<HTMLSpanElement>("last-sync");
const leagueResults = element<HTMLUListElement>("league-results");
const syncButton = element<HTMLButtonElement>("sync-now");
const forgetBrowserButton = element<HTMLButtonElement>("forget-browser");
const loginButton = element<HTMLButtonElement>("open-espn");
const pairingSection = element<HTMLElement>("pairing-offer");
const pairingOrigin = element<HTMLSpanElement>("pairing-origin");
const pairingCompleteButton = element<HTMLButtonElement>("pairing-complete");
const pairingDismissButton = element<HTMLButtonElement>("pairing-dismiss");
const unpairedActions = element<HTMLElement>("unpaired-actions");
const openConnectionsButton = element<HTMLButtonElement>("open-connections");
const liveDraftPanel = element<HTMLElement>("live-draft");
const liveDraftState = element<HTMLSpanElement>("live-draft-state");
const liveDraftMessage = element<HTMLElement>("live-draft-message");
const liveDraftDetail = element<HTMLElement>("live-draft-detail");

let pendingOffer: PendingPairingOffer | undefined;

function send(request: BridgeRequest): Promise<BridgeResponse> {
  return chrome.runtime.sendMessage(request);
}

function sendLiveDraft(request: BridgeLiveDraftRequest): Promise<BridgeLiveDraftResponse> {
  return chrome.runtime.sendMessage(request);
}

const liveDraftLabels: Readonly<Record<BridgeLiveDraftStatus["state"], string>> = {
  idle: "Not watching",
  observing: "Watching",
  accepted: "Live",
  standby: "Standby",
  held: "Needs review",
  rejected: "Not accepted",
  offline: "Reconnecting",
  unauthorized: "Pairing rejected",
  complete: "Draft complete",
  error: "Needs attention",
};

// Plain language only: the popup explains what a friend needs to do, never a status code, and
// never anything about the device credential.
function renderLiveDraft(status: BridgeLiveDraftStatus): void {
  liveDraftPanel.hidden = status.scope === "not-configured" && status.state === "idle";
  liveDraftPanel.dataset.state = status.state;
  liveDraftState.textContent = liveDraftLabels[status.state];
  liveDraftMessage.textContent = status.message;
  const parts: string[] = [];
  if (status.leagueId !== null) parts.push(`League ${status.leagueId}`);
  if (status.pickCount > 0) {
    parts.push(`${status.pickCount} ${status.pickCount === 1 ? "pick" : "picks"} observed`);
  }
  if (status.lastAcceptedAt !== null) {
    parts.push(`Updated ${new Date(status.lastAcceptedAt).toLocaleTimeString()}`);
  }
  liveDraftDetail.textContent = parts.join(" · ");
}

function render(status: BridgeStatus): void {
  statusPanel.dataset.state = status.state;
  statusMessage.textContent = status.message;
  lastSync.textContent = status.lastSuccessfulAt
    ? new Date(status.lastSuccessfulAt).toLocaleString()
    : "Never";
  syncButton.disabled = !status.configured || status.state === "syncing";
  forgetBrowserButton.hidden = !status.configured;
  loginButton.hidden = !(
    status.state === "espn-login-required" ||
    status.results.some((result) => result.state === "espn-login-required")
  );
  unpairedActions.hidden = status.configured || pendingOffer !== undefined;
  leagueResults.replaceChildren(
    ...status.results.map((result) => {
      const item = document.createElement("li");
      item.dataset.state = result.state;
      const league = document.createElement("strong");
      league.textContent = result.leagueId;
      const outcome = document.createElement("span");
      outcome.textContent = resultLabel(result.state);
      const message = document.createElement("small");
      message.textContent = result.message;
      item.append(league, outcome, message);
      return item;
    }),
  );
  leagueResults.hidden = status.results.length === 0;
}

function resultLabel(state: BridgeLeagueResultState): string {
  if (state === "synced") return "Synced";
  if (state === "espn-login-required") return "ESPN sign-in required";
  if (state === "laces-out-auth-failed") return "Pairing rejected";
  return "Failed";
}

async function requireApiPermission(apiBaseUrl: string): Promise<void> {
  const url = new URL(apiBaseUrl);
  // Extension match patterns are host-scoped and intentionally omit the configured port.
  // Network requests still go only to the exact validated origin stored by the service worker.
  const originPattern = `${url.protocol}//${url.hostname}/*`;
  const allowed = await chrome.permissions.request({ origins: [originPattern] });
  if (!allowed) throw new Error("Laces Out host permission was not granted");
}

openConnectionsButton.addEventListener("click", () => {
  // Follow the origin this device was paired against, so the button lands on whichever
  // domain the member actually uses (the API and web app share an origin in deployment).
  // Falls back to the canonical domain when unpaired or the stored configuration is invalid.
  void chrome.storage.local
    .get(configurationStorageKey)
    .then((stored) => {
      try {
        const configuration = validateBridgeConfiguration(stored[configurationStorageKey]);
        return new URL("/connections", configuration.apiBaseUrl).toString();
      } catch {
        return "https://laces.mward.io/connections";
      }
    })
    .then((url) => chrome.tabs.create({ url }))
    .then(
      () => undefined,
      () => undefined,
    );
});

syncButton.addEventListener("click", () => {
  syncButton.disabled = true;
  statusMessage.textContent = "Starting ESPN sync…";
  void send({ type: "SYNC_NOW" })
    .then((response) => render(response.status))
    .catch((error: unknown) => {
      syncButton.disabled = false;
      statusMessage.textContent = error instanceof Error ? error.message : "ESPN sync failed";
      statusPanel.dataset.state = "error";
    });
});

forgetBrowserButton.addEventListener("click", () => {
  void send({ type: "DISCONNECT" })
    .then((response) => render(response.status))
    .catch((error: unknown) => {
      statusMessage.textContent = error instanceof Error ? error.message : "Local forget failed";
      statusPanel.dataset.state = "error";
    });
});

loginButton.addEventListener("click", () => {
  void chrome.tabs.create({ url: "https://fantasy.espn.com/football/" });
});

async function clearPendingOffer(): Promise<void> {
  pendingOffer = undefined;
  pairingSection.hidden = true;
  await chrome.storage.local.remove(pendingPairingStorageKey);
}

async function loadPendingOffer(): Promise<void> {
  const stored = await chrome.storage.local.get(pendingPairingStorageKey);
  const offer = validateStoredPendingOffer(stored[pendingPairingStorageKey]);
  if (!offer || !pairingOfferIsFresh(offer, Date.now())) {
    if (stored[pendingPairingStorageKey] !== undefined) await clearPendingOffer();
    return;
  }
  pendingOffer = offer;
  pairingOrigin.textContent = offer.origin;
  pairingSection.hidden = false;
  unpairedActions.hidden = true;
}

pairingCompleteButton.addEventListener("click", () => {
  const offer = pendingOffer;
  if (!offer) return;
  pairingCompleteButton.disabled = true;
  void (async () => {
    await requireApiPermission(offer.configuration.apiBaseUrl);
    const response = await send({ type: "CONFIGURE", configuration: offer.configuration });
    await clearPendingOffer();
    render(response.status);
  })()
    .catch((error: unknown) => {
      statusMessage.textContent = error instanceof Error ? error.message : "Pairing failed";
      statusPanel.dataset.state = "error";
    })
    .finally(() => {
      pairingCompleteButton.disabled = false;
    });
});

pairingDismissButton.addEventListener("click", () => {
  void clearPendingOffer()
    .then(() => send({ type: "GET_STATUS" }))
    .then((response) => render(response.status));
});

void loadPendingOffer().catch(() => {
  pairingSection.hidden = true;
});

void send({ type: "GET_STATUS" })
  .then((response) => render(response.status))
  .catch((error: unknown) => {
    statusMessage.textContent = error instanceof Error ? error.message : "Bridge status failed";
    statusPanel.dataset.state = "error";
  });

// The popup is an extension page, not a content script, so this query carries no draft-room sender
// and the service worker answers with the stored bounded status only.
void sendLiveDraft({ type: "GET_LIVE_DRAFT_STATUS" })
  .then((response) => renderLiveDraft(response.status))
  .catch(() => {
    liveDraftPanel.hidden = true;
  });
