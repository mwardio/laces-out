import type {
  BridgeLeagueResultState,
  BridgeRequest,
  BridgeResponse,
  BridgeStatus,
  PendingPairingOffer,
} from "./protocol.js";
import {
  pairingOfferIsFresh,
  pendingPairingStorageKey,
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

let pendingOffer: PendingPairingOffer | undefined;

function send(request: BridgeRequest): Promise<BridgeResponse> {
  return chrome.runtime.sendMessage(request);
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
  void chrome.tabs.create({ url: "https://laces.mward.io/connections" });
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
