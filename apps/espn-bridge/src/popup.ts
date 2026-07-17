import type {
  BridgeConfiguration,
  BridgeLeagueResultState,
  BridgeRequest,
  BridgeResponse,
  BridgeStatus,
} from "./protocol.js";
import { parseLeagueIds, validateBridgeConfiguration } from "./protocol.js";

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing popup element: ${id}`);
  return value as T;
}

const form = element<HTMLFormElement>("configuration-form");
const statusPanel = element<HTMLDivElement>("status");
const statusMessage = element<HTMLParagraphElement>("status-message");
const lastSync = element<HTMLSpanElement>("last-sync");
const leagueResults = element<HTMLUListElement>("league-results");
const syncButton = element<HTMLButtonElement>("sync-now");
const forgetBrowserButton = element<HTMLButtonElement>("forget-browser");
const loginButton = element<HTMLButtonElement>("open-espn");

function send(request: BridgeRequest): Promise<BridgeResponse> {
  return chrome.runtime.sendMessage(request);
}

function formString(data: FormData, name: string): string {
  const value = data.get(name);
  return typeof value === "string" ? value : "";
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
  form.hidden = status.configured;
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

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void (async () => {
    const data = new FormData(form);
    const configuration: BridgeConfiguration = validateBridgeConfiguration({
      apiBaseUrl: formString(data, "apiBaseUrl"),
      deviceToken: formString(data, "deviceToken"),
      leagueIds: parseLeagueIds(formString(data, "leagueIds")),
      season: Number(data.get("season")),
      automaticSync: data.get("automaticSync") === "on",
    });
    await requireApiPermission(configuration.apiBaseUrl);
    render((await send({ type: "CONFIGURE", configuration })).status);
  })().catch((error: unknown) => {
    statusMessage.textContent = error instanceof Error ? error.message : "Pairing failed";
    statusPanel.dataset.state = "error";
  });
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

void send({ type: "GET_STATUS" })
  .then((response) => render(response.status))
  .catch((error: unknown) => {
    statusMessage.textContent = error instanceof Error ? error.message : "Bridge status failed";
    statusPanel.dataset.state = "error";
  });
