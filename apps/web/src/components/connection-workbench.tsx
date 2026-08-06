"use client";

import {
  ArrowRight,
  Check,
  Info,
  Link2,
  LoaderCircle,
  LockKeyhole,
  Laptop,
  RefreshCw,
  ServerCog,
  ShieldCheck,
  TriangleAlert,
  Unplug,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import {
  apiBaseUrl,
  parseEspnBridgeDeviceList,
  parseEspnLeagueRefreshStatus,
  parseEspnSessionConnectionList,
  parseLeagueListResponse,
  type EspnBridgeDeviceStatus,
  type EspnLeagueRefreshStatus,
  type EspnSessionConnectionList,
} from "../lib/api-client";
import { sendServerSessionOffer } from "../lib/bridge-extension";
import { publishYahooConnectionState } from "../lib/provider-connection-events";
import { yahooComingSoon } from "../lib/public-site";
import { loginUrlForCurrentPath } from "../lib/safe-return-to";
import { EspnPairingStepper } from "./espn-pairing-stepper";

type BridgeDevice = EspnBridgeDeviceStatus;
type EspnServerSessionConnection = EspnSessionConnectionList["connections"][number];

interface EspnLeagueRefreshItem {
  readonly leagueId: string;
  readonly leagueSeasonId: string;
  readonly name: string;
  readonly season: number;
  readonly status: EspnLeagueRefreshStatus;
}

type YahooHealth = "pending" | "healthy" | "degraded" | "reauthorize" | "disabled";

interface YahooLeagueStatus {
  readonly leagueId: string;
  readonly leagueSeasonId: string;
  readonly name: string;
  readonly externalKey: string;
  readonly season: number;
  readonly currentWeek: number | null;
  readonly lastSyncedAt: string | null;
  readonly currentUserTeamExternalKey: string | null;
}

interface YahooConnectionStatus {
  readonly connectionId: string;
  readonly displayName: string;
  readonly health: YahooHealth;
  readonly credentialExpiresAt: string | null;
  readonly lastSuccessfulAt: string | null;
  readonly lastErrorCode: string | null;
  readonly lastErrorAt: string | null;
  readonly leagues: readonly YahooLeagueStatus[];
}

type RequestState = "idle" | "working" | "done" | "error";

interface UiMessage {
  readonly tone: "error" | "success" | "warning";
  readonly text: string;
}

class ConnectionUiError extends Error {}

/* The ESPN bridge responses have schemas in `@fantasy/contracts` that the API already serves them
   through, so they are validated with those rather than re-described here. The Yahoo status below
   has no shared schema yet, so its hand-written predicates stay until one exists. */

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isYahooLeagueStatus(value: unknown): value is YahooLeagueStatus {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.leagueId === "string" &&
    typeof record.leagueSeasonId === "string" &&
    typeof record.name === "string" &&
    typeof record.externalKey === "string" &&
    typeof record.season === "number" &&
    (record.currentWeek === null || typeof record.currentWeek === "number") &&
    isNullableString(record.lastSyncedAt) &&
    isNullableString(record.currentUserTeamExternalKey)
  );
}

function isYahooConnectionStatus(value: unknown): value is YahooConnectionStatus {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.connectionId === "string" &&
    typeof record.displayName === "string" &&
    ["pending", "healthy", "degraded", "reauthorize", "disabled"].includes(String(record.health)) &&
    isNullableString(record.credentialExpiresAt) &&
    isNullableString(record.lastSuccessfulAt) &&
    isNullableString(record.lastErrorCode) &&
    isNullableString(record.lastErrorAt) &&
    Array.isArray(record.leagues) &&
    record.leagues.every(isYahooLeagueStatus)
  );
}

function formatBridgeTime(value: string | null): string {
  if (!value) return "Never synced";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Sync time unavailable";
  return `Last sync ${new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date)}`;
}

function formatYahooTime(value: string | null, emptyLabel: string): string {
  if (!value) return emptyLabel;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Time unavailable";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function yahooHealthLabel(health: YahooHealth): string {
  switch (health) {
    case "healthy":
      return "Connected";
    case "degraded":
      return "Needs attention";
    case "reauthorize":
      return "Reconnect required";
    case "disabled":
      return "Disabled";
    default:
      return "Sync pending";
  }
}

function artifactLabel(family: EspnLeagueRefreshStatus["artifacts"][number]["family"]): string {
  switch (family) {
    case "available-players":
      return "Players";
    case "weekly-box-scores":
      return "Box scores";
    case "completed-draft":
      return "Draft";
    case "transactions":
      return "Transactions";
    default:
      return "Core";
  }
}

function espnModeLabel(status: EspnLeagueRefreshStatus): string {
  const fulfillmentMode = status.request?.fulfillmentMode;
  if (fulfillmentMode === "server-session") return "Always-on";
  if (fulfillmentMode === "server-direct") return "Direct";
  if (fulfillmentMode === "chrome-agent" || fulfillmentMode === "native-agent") {
    return "Paired device";
  }
  if (
    status.direct.enabled &&
    status.direct.coreState === "available" &&
    status.direct.preferredMode !== "assisted"
  ) {
    return "Direct";
  }
  if (status.direct.preferredMode === "assisted") return "Paired device";
  if (status.agents.activeCount > 0) return "Paired device";
  return "Automatic";
}

function espnDirectStateLabel(status: EspnLeagueRefreshStatus): string {
  if (!status.direct.enabled || status.direct.coreState === "disabled")
    return "Disabled by operator";
  if (status.direct.coreState === "available") return "Verified public core";
  if (status.direct.coreState === "not-public") return "Private · paired device needed";
  if (status.direct.coreState === "degraded") return "Verified · temporarily degraded";
  return "Evidence not approved";
}

export function ConnectionWorkbench() {
  const [bridgeDevices, setBridgeDevices] = useState<readonly BridgeDevice[]>([]);
  const [bridgeDevicesState, setBridgeDevicesState] = useState<RequestState>("working");
  const [bridgeDevicesError, setBridgeDevicesError] = useState<string | null>(null);
  const [espnLeagueStatuses, setEspnLeagueStatuses] = useState<readonly EspnLeagueRefreshItem[]>(
    [],
  );
  const [espnLeagueStatusesState, setEspnLeagueStatusesState] = useState<RequestState>("working");
  const [espnLeagueStatusesError, setEspnLeagueStatusesError] = useState<string | null>(null);
  const [espnServerSessions, setEspnServerSessions] = useState<
    readonly EspnServerSessionConnection[]
  >([]);
  const [espnServerSessionsAvailable, setEspnServerSessionsAvailable] = useState(false);
  const [espnServerSessionsState, setEspnServerSessionsState] = useState<RequestState>("working");
  const [espnServerSessionsError, setEspnServerSessionsError] = useState<string | null>(null);
  const [espnServerSessionAction, setEspnServerSessionAction] = useState<
    "idle" | "enabling" | "removing"
  >("idle");
  const [refreshingEspnLeagueSeasonId, setRefreshingEspnLeagueSeasonId] = useState<string | null>(
    null,
  );
  const [signedOut, setSignedOut] = useState(false);
  const [revokingDeviceId, setRevokingDeviceId] = useState<string | null>(null);
  const [bridgeRevokeCandidate, setBridgeRevokeCandidate] = useState<string | null>(null);
  const [yahooState, setYahooState] = useState<RequestState>("idle");
  const [yahooError, setYahooError] = useState<string | null>(null);
  const [yahooConnections, setYahooConnections] = useState<readonly YahooConnectionStatus[]>([]);
  const [yahooConnectionsState, setYahooConnectionsState] = useState<RequestState>("working");
  const [yahooConnectionsError, setYahooConnectionsError] = useState<string | null>(null);
  const [yahooActionKey, setYahooActionKey] = useState<string | null>(null);
  const [yahooActionMessage, setYahooActionMessage] = useState<UiMessage | null>(null);
  const [yahooDisconnectCandidate, setYahooDisconnectCandidate] = useState<string | null>(null);
  const [callbackNotice, setCallbackNotice] = useState<UiMessage | null>(null);
  const refreshBridgeDevices = useCallback(async () => {
    setBridgeDevicesState("working");
    setBridgeDevicesError(null);
    try {
      const response = await fetch(`${apiBaseUrl}/v1/bridge/espn/devices`, {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (response.status === 401) {
        setBridgeDevicesState("idle");
        setSignedOut(true);
        return;
      }
      if (!response.ok)
        throw new ConnectionUiError("Paired ESPN sync devices could not be loaded.");
      const devices = parseEspnBridgeDeviceList(await response.json());
      if (!devices) throw new ConnectionUiError("The bridge device list was invalid.");
      setBridgeDevices(devices);
      setBridgeDevicesState("done");
    } catch (error) {
      setBridgeDevicesState("error");
      setBridgeDevicesError(
        error instanceof ConnectionUiError
          ? error.message
          : "Paired ESPN sync devices could not be loaded.",
      );
    }
  }, []);

  const refreshYahooConnections = useCallback(async () => {
    setYahooConnectionsState("working");
    setYahooConnectionsError(null);
    try {
      const response = await fetch(`${apiBaseUrl}/v1/connections/yahoo`, {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (response.status === 401) {
        setYahooConnectionsState("idle");
        setSignedOut(true);
        publishYahooConnectionState(false);
        return;
      }
      if (!response.ok) {
        throw new ConnectionUiError(
          response.status === 503
            ? "Yahoo sync is not configured on this server yet."
            : "Yahoo connection status could not be loaded.",
        );
      }
      const body = (await response.json()) as { connections?: unknown };
      if (!Array.isArray(body.connections) || !body.connections.every(isYahooConnectionStatus)) {
        throw new ConnectionUiError("Yahoo returned an invalid connection status.");
      }
      setYahooConnections(body.connections);
      setYahooConnectionsState("done");
      setYahooState(body.connections.length > 0 ? "done" : "idle");
      publishYahooConnectionState(body.connections.length > 0);
    } catch (error) {
      setYahooConnectionsState("error");
      setYahooConnectionsError(
        error instanceof ConnectionUiError
          ? error.message
          : "Yahoo connection status could not be loaded.",
      );
    }
  }, []);

  const refreshEspnServerSessions = useCallback(async (quiet = false) => {
    if (!quiet) setEspnServerSessionsState("working");
    setEspnServerSessionsError(null);
    try {
      const response = await fetch(`${apiBaseUrl}/v1/connections/espn/sessions`, {
        credentials: "include",
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (response.status === 401) {
        setEspnServerSessionsState("idle");
        setSignedOut(true);
        return;
      }
      if (!response.ok) throw new ConnectionUiError("Always-on ESPN status could not be loaded.");
      const result = parseEspnSessionConnectionList(await response.json());
      if (!result) throw new ConnectionUiError("Always-on ESPN returned an invalid status.");
      setEspnServerSessionsAvailable(result.available);
      setEspnServerSessions(result.connections);
      setEspnServerSessionsState("done");
    } catch (error) {
      setEspnServerSessionsState("error");
      setEspnServerSessionsError(
        error instanceof ConnectionUiError
          ? error.message
          : "Always-on ESPN status could not be loaded.",
      );
    }
  }, []);

  const refreshEspnLeagueStatuses = useCallback(async (quiet = false) => {
    if (!quiet) setEspnLeagueStatusesState("working");
    setEspnLeagueStatusesError(null);
    try {
      const leaguesResponse = await fetch(`${apiBaseUrl}/v1/leagues`, {
        credentials: "include",
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (leaguesResponse.status === 401) {
        setEspnLeagueStatusesState("idle");
        setSignedOut(true);
        return;
      }
      if (!leaguesResponse.ok) {
        throw new ConnectionUiError("Connected ESPN leagues could not be loaded.");
      }
      const portfolio = parseLeagueListResponse(await leaguesResponse.json());
      if (!portfolio) throw new ConnectionUiError("The league list response was invalid.");
      const espnLeagues = portfolio.leagues.filter(
        (league) => !league.archived && league.season?.provider === "espn",
      );
      const statuses = await Promise.all(
        espnLeagues.map(async (league): Promise<EspnLeagueRefreshItem> => {
          const season = league.season;
          if (!season || season.provider !== "espn") {
            throw new ConnectionUiError("An ESPN league was missing its season.");
          }
          const statusResponse = await fetch(
            `${apiBaseUrl}/v1/leagues/${encodeURIComponent(season.id)}/refresh/status`,
            {
              credentials: "include",
              headers: { Accept: "application/json" },
              cache: "no-store",
            },
          );
          if (!statusResponse.ok) {
            throw new ConnectionUiError(`${league.name} refresh health could not be loaded.`);
          }
          const status = parseEspnLeagueRefreshStatus(await statusResponse.json());
          if (!status) throw new ConnectionUiError(`${league.name} returned invalid sync health.`);
          return {
            leagueId: league.id,
            leagueSeasonId: season.id,
            name: league.name,
            season: season.season,
            status,
          };
        }),
      );
      setEspnLeagueStatuses(statuses);
      setEspnLeagueStatusesState("done");
    } catch (error) {
      setEspnLeagueStatusesState("error");
      setEspnLeagueStatusesError(
        error instanceof ConnectionUiError
          ? error.message
          : "Connected ESPN league health could not be loaded.",
      );
    }
  }, []);
  useEffect(() => {
    const parameters = new URLSearchParams(window.location.search);
    if (parameters.get("provider") !== "yahoo") return;

    const status = parameters.get("status");
    const sync = parameters.get("sync");
    const notice: UiMessage =
      status === "connected"
        ? sync === "complete"
          ? {
              tone: "success",
              text: "Yahoo connected and its available football leagues are synced.",
            }
          : sync === "failed"
            ? {
                tone: "warning",
                text: "Yahoo connected, but the first league sync failed. Retry it below; reconnecting is not required.",
              }
            : {
                tone: "success",
                text: "Yahoo authorization completed. Check the connection below before using roster data.",
              }
        : status === "denied"
          ? { tone: "warning", text: "Yahoo authorization was canceled. No connection was added." }
          : status === "unavailable"
            ? {
                tone: "warning",
                text: "Yahoo OAuth is not configured for this API process yet.",
              }
            : {
                tone: "error",
                text: "Yahoo authorization could not be completed. No provider details were saved by this screen.",
              };
    if (status === "connected") setYahooState("done");
    setCallbackNotice(notice);
    window.history.replaceState({}, "", window.location.pathname);
  }, []);

  const handleBridgeDevicesChanged = useCallback(() => {
    void refreshBridgeDevices();
  }, [refreshBridgeDevices]);

  const handleBridgeSyncActivity = useCallback(() => {
    void refreshEspnLeagueStatuses(true);
    void refreshEspnServerSessions(true);
  }, [refreshEspnLeagueStatuses, refreshEspnServerSessions]);

  useEffect(() => {
    void refreshBridgeDevices();
    void refreshEspnLeagueStatuses();
    void refreshEspnServerSessions();
    void refreshYahooConnections();
  }, [
    refreshBridgeDevices,
    refreshEspnLeagueStatuses,
    refreshEspnServerSessions,
    refreshYahooConnections,
  ]);

  useEffect(() => {
    const refreshAfterProviderTab = () => void refreshEspnServerSessions(true);
    window.addEventListener("focus", refreshAfterProviderTab);
    return () => window.removeEventListener("focus", refreshAfterProviderTab);
  }, [refreshEspnServerSessions]);

  useEffect(() => {
    const hasLiveRequest = espnLeagueStatuses.some(
      ({ status }) => status.request?.state === "queued" || status.request?.state === "processing",
    );
    if (!hasLiveRequest) return;
    let polling = false;
    const interval = window.setInterval(() => {
      if (polling) return;
      polling = true;
      void refreshEspnLeagueStatuses(true).finally(() => {
        polling = false;
      });
    }, 5_000);
    return () => window.clearInterval(interval);
  }, [espnLeagueStatuses, refreshEspnLeagueStatuses]);

  async function startYahoo() {
    setYahooState("working");
    setYahooError(null);
    try {
      const response = await fetch(`${apiBaseUrl}/v1/connections/yahoo/authorize`, {
        method: "POST",
        credentials: "include",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ returnTo: "/connections" }),
      });
      if (response.status === 401) {
        window.location.assign(loginUrlForCurrentPath());
        return;
      }
      if (!response.ok) {
        throw new ConnectionUiError(
          response.status === 503
            ? "Yahoo sign-in is unavailable on this server."
            : "Yahoo authorization could not be started.",
        );
      }
      const body = (await response.json()) as { authorizationUrl?: unknown };
      if (typeof body.authorizationUrl !== "string")
        throw new ConnectionUiError("Yahoo returned no login URL.");
      window.location.assign(body.authorizationUrl);
    } catch (error) {
      setYahooState("error");
      setYahooError(
        error instanceof ConnectionUiError
          ? error.message
          : "The API could not start Yahoo authorization. Try again in a moment.",
      );
    }
  }

  async function runYahooSync(
    connectionId: string,
    league?: Pick<YahooLeagueStatus, "externalKey" | "name">,
  ) {
    const actionKey = league ? `${connectionId}:${league.externalKey}` : `${connectionId}:discover`;
    setYahooActionKey(actionKey);
    setYahooActionMessage(null);
    setYahooConnectionsError(null);
    try {
      const path = league
        ? `/v1/connections/yahoo/${connectionId}/leagues/${encodeURIComponent(league.externalKey)}/sync`
        : `/v1/connections/yahoo/${connectionId}/discover`;
      const response = await fetch(`${apiBaseUrl}${path}`, {
        method: "POST",
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (response.status === 401) {
        window.location.assign(loginUrlForCurrentPath());
        return;
      }
      if (!response.ok) {
        const problem = (await response.json().catch(() => null)) as { detail?: unknown } | null;
        throw new ConnectionUiError(
          typeof problem?.detail === "string"
            ? problem.detail
            : league
              ? `${league.name} could not be synced.`
              : "Yahoo league discovery could not be completed.",
        );
      }
      setYahooActionMessage({
        tone: "success",
        text: league
          ? `${league.name} is up to date.`
          : "Yahoo league discovery and sync completed.",
      });
      await refreshYahooConnections();
    } catch (error) {
      setYahooActionMessage({
        tone: "error",
        text:
          error instanceof ConnectionUiError
            ? error.message
            : league
              ? `${league.name} could not be synced.`
              : "Yahoo league discovery could not be completed.",
      });
      await refreshYahooConnections();
    } finally {
      setYahooActionKey(null);
    }
  }

  async function disconnectYahoo(connectionId: string) {
    const actionKey = connectionId + ":disconnect";
    setYahooActionKey(actionKey);
    setYahooActionMessage(null);
    setYahooConnectionsError(null);
    try {
      const response = await fetch(
        apiBaseUrl + "/v1/connections/yahoo/" + encodeURIComponent(connectionId),
        {
          method: "DELETE",
          credentials: "include",
          headers: { Accept: "application/json" },
        },
      );
      if (response.status === 401) {
        window.location.assign(loginUrlForCurrentPath());
        return;
      }
      if (!response.ok) {
        const problem = (await response.json().catch(() => null)) as { detail?: unknown } | null;
        throw new ConnectionUiError(
          typeof problem?.detail === "string"
            ? problem.detail
            : "The stored Yahoo authorization could not be removed.",
        );
      }
      setYahooDisconnectCandidate(null);
      setYahooActionMessage({
        tone: "success",
        text: "Stored Yahoo authorization removed. Previously synchronized league data remains available as last-known data; no Yahoo revocation request was made.",
      });
      await refreshYahooConnections();
    } catch (error) {
      setYahooActionMessage({
        tone: "error",
        text:
          error instanceof ConnectionUiError
            ? error.message
            : "The stored Yahoo authorization could not be removed.",
      });
    } finally {
      setYahooActionKey(null);
    }
  }

  async function revokeBridgeDevice(deviceId: string) {
    setRevokingDeviceId(deviceId);
    setBridgeDevicesError(null);
    try {
      const response = await fetch(`${apiBaseUrl}/v1/bridge/espn/devices/${deviceId}`, {
        method: "DELETE",
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (response.status === 401) {
        window.location.assign(loginUrlForCurrentPath());
        return;
      }
      if (!response.ok) throw new ConnectionUiError("This bridge device could not be revoked.");
      setBridgeRevokeCandidate(null);
      await refreshBridgeDevices();
    } catch (error) {
      setBridgeDevicesError(
        error instanceof ConnectionUiError
          ? error.message
          : "This bridge device could not be revoked.",
      );
    } finally {
      setRevokingDeviceId(null);
    }
  }

  async function requestEspnLeagueRefresh(leagueSeasonId: string) {
    setRefreshingEspnLeagueSeasonId(leagueSeasonId);
    setEspnLeagueStatusesError(null);
    try {
      const response = await fetch(
        `${apiBaseUrl}/v1/leagues/${encodeURIComponent(leagueSeasonId)}/refresh`,
        {
          method: "POST",
          credentials: "include",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: "{}",
          cache: "no-store",
        },
      );
      if (response.status === 401) {
        window.location.assign(loginUrlForCurrentPath());
        return;
      }
      if (!response.ok) throw new ConnectionUiError("ESPN refresh could not be requested.");
      const status = parseEspnLeagueRefreshStatus(await response.json());
      if (!status) throw new ConnectionUiError("ESPN returned an invalid refresh status.");
      setEspnLeagueStatuses((current) =>
        current.map((league) =>
          league.leagueSeasonId === leagueSeasonId ? { ...league, status } : league,
        ),
      );
    } catch (error) {
      setEspnLeagueStatusesError(
        error instanceof ConnectionUiError ? error.message : "ESPN refresh could not be requested.",
      );
    } finally {
      setRefreshingEspnLeagueSeasonId(null);
    }
  }

  async function enableEspnServerSession() {
    setEspnServerSessionAction("enabling");
    setEspnServerSessionsError(null);
    try {
      const outcome = await sendServerSessionOffer();
      if (!outcome.ok && outcome.state === undefined) {
        throw new ConnectionUiError(
          "Update and pair the Chrome companion, then try enabling always-on sync again.",
        );
      }
      if (!outcome.ok && outcome.message) throw new ConnectionUiError(outcome.message);
      await refreshEspnServerSessions(true);
      if (outcome.message && outcome.state !== "enabled") {
        setEspnServerSessionsError(outcome.message);
      }
    } catch (error) {
      setEspnServerSessionsError(
        error instanceof ConnectionUiError
          ? error.message
          : "Always-on ESPN sync could not be enabled.",
      );
    } finally {
      setEspnServerSessionAction("idle");
    }
  }

  async function removeEspnServerSession(connectionId: string) {
    setEspnServerSessionAction("removing");
    setEspnServerSessionsError(null);
    try {
      const response = await fetch(
        `${apiBaseUrl}/v1/connections/espn/sessions/${encodeURIComponent(connectionId)}`,
        {
          method: "DELETE",
          credentials: "include",
          headers: { Accept: "application/json" },
        },
      );
      if (response.status === 401) {
        window.location.assign(loginUrlForCurrentPath());
        return;
      }
      if (!response.ok) throw new ConnectionUiError("Always-on ESPN sync could not be removed.");
      await refreshEspnServerSessions(true);
    } catch (error) {
      setEspnServerSessionsError(
        error instanceof ConnectionUiError
          ? error.message
          : "Always-on ESPN sync could not be removed.",
      );
    } finally {
      setEspnServerSessionAction("idle");
    }
  }

  const yahooLeagueCount = yahooConnections.reduce(
    (total, connection) => total + connection.leagues.length,
    0,
  );
  const yahooNeedsReauthorization = yahooConnections.some(
    (connection) => connection.health === "reauthorize",
  );
  const yahooPanelState =
    yahooConnectionsState === "working" && yahooConnections.length === 0
      ? "Checking status"
      : yahooNeedsReauthorization
        ? "Reconnect required"
        : yahooConnections.length > 0
          ? `Connected · ${yahooLeagueCount} ${yahooLeagueCount === 1 ? "league" : "leagues"}`
          : yahooComingSoon
            ? "Coming soon"
            : yahooConnectionsState === "error"
              ? "Setup required"
              : "Ready to connect";
  const activeBridgeDevices = bridgeDevices.filter((device) => device.state === "active");
  // Revoked devices are done, not informative; keep them out of the list a member
  // scans, without discarding them from the underlying data.
  const visibleBridgeDevices = bridgeDevices.filter((device) => device.state !== "revoked");
  const activeEspnServerSession = espnServerSessions.find(
    (connection) => connection.health !== "disabled",
  );
  const espnPanelState = activeBridgeDevices.some((device) => device.lastSeenAt !== null)
    ? "Connected"
    : activeBridgeDevices.length > 0
      ? "Awaiting first sync"
      : bridgeDevicesState === "working"
        ? "Checking status"
        : signedOut
          ? "Sign in to connect"
          : "Ready to connect";

  return (
    <div className="connections-page">
      {/* Every other workbench branches on signed-out; this one rendered a live
          ESPN form to anonymous visitors and bounced them on submit. */}
      {signedOut ? (
        <div className="connection-signed-out-notice" role="status">
          <Info size={17} aria-hidden="true" />
          <span>
            <strong>You are signed out</strong>
            Connecting a league needs an account, so nothing below will save yet.
          </span>
          {/* Plain anchor: the returnTo target is computed at render time, which
              `typedRoutes` cannot verify against the static route map. */}
          <a className="button button--dark button--small" href={loginUrlForCurrentPath()}>
            Sign in
          </a>
        </div>
      ) : null}

      <section className="page-heading connection-heading">
        <div>
          <p className="eyebrow">Provider access</p>
          <h1>League Sync</h1>
          <p className="page-subtitle">
            {yahooComingSoon
              ? "Keep ESPN leagues current with secure automatic refresh. Yahoo sign-in is coming soon."
              : "Connect Yahoo with official sign-in or keep ESPN leagues current automatically."}
          </p>
        </div>
        <div className="connection-security-chip">
          <ShieldCheck size={18} />
          <span>
            <strong>Read-only by default</strong>
            <small>No lineup or transaction writes</small>
          </span>
        </div>
      </section>

      {callbackNotice ? (
        <div
          className={`connection-notice connection-notice--${callbackNotice.tone}`}
          role={callbackNotice.tone === "error" ? "alert" : "status"}
        >
          {callbackNotice.tone === "success" ? <Check size={16} /> : <TriangleAlert size={16} />}
          <span>{callbackNotice.text}</span>
          <button
            type="button"
            onClick={() => setCallbackNotice(null)}
            aria-label="Dismiss Yahoo connection status"
          >
            <X size={15} />
          </button>
        </div>
      ) : null}

      <section className="connection-grid" aria-label="Fantasy provider connections">
        <article className="connection-provider connection-provider--espn" id="espn-connection">
          <div className="connection-provider__head">
            <span className="connection-provider-logo connection-provider-logo--espn">E</span>
            <div>
              <p className="eyebrow">Private-league sync · no password sharing</p>
              <h2>Connect ESPN</h2>
            </div>
            <span
              className={`connection-provider-state connection-provider-state--bridge${espnPanelState === "Connected" ? " connection-provider-state--connected" : ""}`}
            >
              {espnPanelState}
            </span>
          </div>
          <p>
            The Chrome companion finds the leagues on your signed-in ESPN account and keeps them
            current — read-only, and your ESPN password is never collected.
          </p>

          <EspnPairingStepper
            signedOut={signedOut}
            onDevicesChanged={handleBridgeDevicesChanged}
            onSyncActivity={handleBridgeSyncActivity}
          />

          <details className="connection-provider__footnote">
            <summary>Optional: direct refresh for public leagues</summary>
            <p>
              A league manager may follow ESPN&apos;s{" "}
              <a
                href="https://support.espn.com/hc/en-us/articles/47160849553940-Making-a-Private-League-Public-LM-Only"
                target="_blank"
                rel="noreferrer"
              >
                public-view instructions
              </a>{" "}
              to make server-side direct refresh eligible. It does not make the league joinable and
              does not imply ESPN endorsement.
            </p>
          </details>

          {/* A member on a host-disabled deployment can take no action here, so
              the whole panel is hidden rather than pinned open as "Host disabled"
              noise. It stays visible while loading, on errors, and whenever an
              existing connection needs managing. */}
          <div
            className="bridge-device-manager espn-always-on-manager"
            aria-live="polite"
            hidden={
              !espnServerSessionsAvailable &&
              !activeEspnServerSession &&
              espnServerSessionsState === "done" &&
              !espnServerSessionsError
            }
          >
            <div className="bridge-device-manager__heading">
              <span>
                <ServerCog size={16} />
                <strong>Always-on ESPN sync</strong>
              </span>
              <span
                className={`bridge-device-state ${activeEspnServerSession ? "bridge-device-state--active" : ""}`}
              >
                {espnServerSessionsState === "working"
                  ? "Checking"
                  : activeEspnServerSession
                    ? activeEspnServerSession.health === "healthy"
                      ? "Enabled"
                      : "Needs attention"
                    : espnServerSessionsAvailable
                      ? "Recommended"
                      : "Host disabled"}
              </span>
            </div>
            {activeEspnServerSession ? (
              <div className="espn-always-on-manager__body">
                <div>
                  <strong>
                    {activeEspnServerSession.health === "healthy"
                      ? "Refreshes continue without Chrome"
                      : "Renew your ESPN sign-in"}
                  </strong>
                  <p>
                    Session authorization is encrypted on this server and restricted to read-only
                    fantasy data. Your password is never stored.
                  </p>
                  <small>
                    {activeEspnServerSession.leagues.length} linked{" "}
                    {activeEspnServerSession.leagues.length === 1 ? "league" : "leagues"}
                    {activeEspnServerSession.lastSuccessfulAt
                      ? ` · ${formatBridgeTime(activeEspnServerSession.lastSuccessfulAt)}`
                      : " · awaiting first unattended refresh"}
                  </small>
                </div>
                <div className="espn-always-on-manager__actions">
                  {activeEspnServerSession.health === "reauthorize" ? (
                    <button
                      className="button button--lime button--small"
                      type="button"
                      onClick={() => void enableEspnServerSession()}
                      disabled={espnServerSessionAction !== "idle"}
                    >
                      {espnServerSessionAction === "enabling" ? (
                        <LoaderCircle className="spin" size={14} />
                      ) : (
                        <RefreshCw size={14} />
                      )}
                      Renew sign-in
                    </button>
                  ) : null}
                  <button
                    className="button button--outline button--small"
                    type="button"
                    onClick={() =>
                      void removeEspnServerSession(activeEspnServerSession.connectionId)
                    }
                    disabled={espnServerSessionAction !== "idle"}
                  >
                    {espnServerSessionAction === "removing" ? (
                      <LoaderCircle className="spin" size={14} />
                    ) : (
                      <Unplug size={14} />
                    )}
                    Remove
                  </button>
                </div>
              </div>
            ) : espnServerSessionsAvailable ? (
              <div className="espn-always-on-manager__body">
                <div>
                  <strong>Keep synced when Chrome is closed</strong>
                  <p>
                    The recommended setup sends ESPN session authorization through the paired
                    companion and stores it encrypted on your Laces Out server. It is used only for
                    read-only league refreshes and can be removed here at any time.
                  </p>
                </div>
                <button
                  className="button button--lime button--small"
                  type="button"
                  onClick={() => void enableEspnServerSession()}
                  disabled={espnServerSessionAction !== "idle"}
                >
                  {espnServerSessionAction === "enabling" ? (
                    <LoaderCircle className="spin" size={14} />
                  ) : (
                    <LockKeyhole size={14} />
                  )}
                  {espnServerSessionAction === "enabling" ? "Opening ESPN…" : "Enable always-on"}
                </button>
              </div>
            ) : espnServerSessionsState === "done" ? (
              <p className="bridge-device-manager__empty">
                This Laces Out server has not enabled encrypted always-on ESPN sync. The companion
                can still refresh leagues while its paired Chrome profile is open.
              </p>
            ) : null}
            {espnServerSessionsError ? (
              <p className="connection-error" role="alert">
                <TriangleAlert size={14} />
                {espnServerSessionsError}
              </p>
            ) : null}
          </div>

          <div className="bridge-device-manager espn-league-manager" aria-live="polite">
            <div className="bridge-device-manager__heading">
              <span>
                <RefreshCw size={16} />
                <strong>Connected ESPN leagues</strong>
              </span>
              <button
                className="button button--outline button--small"
                type="button"
                onClick={() => void refreshEspnLeagueStatuses()}
                disabled={espnLeagueStatusesState === "working"}
              >
                <RefreshCw
                  className={espnLeagueStatusesState === "working" ? "spin" : undefined}
                  size={14}
                />
                Refresh status
              </button>
            </div>
            {espnLeagueStatusesError ? (
              <p className="connection-error" role="alert">
                <TriangleAlert size={14} />
                {espnLeagueStatusesError}
              </p>
            ) : null}
            {espnLeagueStatusesState === "working" && espnLeagueStatuses.length === 0 ? (
              <p className="bridge-device-manager__empty">Checking league refresh health…</p>
            ) : espnLeagueStatuses.length === 0 ? (
              <p className="bridge-device-manager__empty">
                No ESPN league is connected yet. Use <strong>Find my ESPN leagues</strong> above and
                they appear here after the first sync.
              </p>
            ) : (
              <ul className="bridge-device-list espn-refresh-list">
                {espnLeagueStatuses.map((league) => {
                  const core = league.status.artifacts.find(
                    (artifact) => artifact.family === "core",
                  );
                  const requestState = league.status.request?.state ?? "none";
                  const hasAlwaysOnSync = espnServerSessions.some(
                    (connection) =>
                      connection.health !== "disabled" &&
                      connection.leagues.some(
                        (linkedLeague) => linkedLeague.leagueSeasonId === league.leagueSeasonId,
                      ),
                  );
                  return (
                    <li key={league.leagueSeasonId}>
                      <div className="bridge-device-list__summary">
                        <span
                          className={`espn-refresh-state espn-refresh-state--${league.status.display.code}`}
                        >
                          {league.status.current ? "Current" : "Needs refresh"}
                        </span>
                        <strong>
                          {league.name} · {league.season}
                        </strong>
                        <small>{league.status.display.label}</small>
                      </div>
                      <button
                        className="button button--outline button--small"
                        type="button"
                        onClick={() => void requestEspnLeagueRefresh(league.leagueSeasonId)}
                        disabled={refreshingEspnLeagueSeasonId !== null}
                      >
                        {refreshingEspnLeagueSeasonId === league.leagueSeasonId ? (
                          <LoaderCircle className="spin" size={14} />
                        ) : (
                          <RefreshCw size={14} />
                        )}
                        {refreshingEspnLeagueSeasonId === league.leagueSeasonId
                          ? "Requesting…"
                          : "Refresh league"}
                      </button>
                      <dl className="espn-refresh-list__facts">
                        <div>
                          <dt>Last accepted core sync</dt>
                          <dd>{formatBridgeTime(core?.observedAt ?? null)}</dd>
                        </div>
                        <div>
                          <dt>Detected mode</dt>
                          <dd>{espnModeLabel(league.status)}</dd>
                        </div>
                        <div>
                          <dt>Active sync devices</dt>
                          <dd>
                            {league.status.agents.activeCount}
                            {league.status.agents.mostRecentSeenAt
                              ? ` · ${formatBridgeTime(league.status.agents.mostRecentSeenAt)}`
                              : " · none seen recently"}
                          </dd>
                        </div>
                        <div>
                          <dt>Refresh request</dt>
                          <dd>{requestState}</dd>
                        </div>
                        {!hasAlwaysOnSync ? (
                          <div>
                            <dt>Direct read</dt>
                            <dd>
                              {espnDirectStateLabel(league.status)}
                              {league.status.direct.lastProbeAt
                                ? ` · checked ${formatBridgeTime(league.status.direct.lastProbeAt)}`
                                : ""}
                            </dd>
                          </div>
                        ) : null}
                        <div>
                          <dt>Latest attempt</dt>
                          <dd>
                            {league.status.request?.latestAttempt
                              ? `${league.status.request.latestAttempt.state} · ${formatBridgeTime(
                                  league.status.request.latestAttempt.finishedAt ??
                                    league.status.request.latestAttempt.startedAt,
                                )}`
                              : "No attempt recorded"}
                          </dd>
                        </div>
                      </dl>
                      <div
                        className="espn-refresh-list__artifacts"
                        aria-label={`${league.name} artifact freshness`}
                      >
                        {league.status.artifacts.map((artifact) => (
                          <span
                            className={`espn-artifact-state espn-artifact-state--${artifact.state}`}
                            key={artifact.family}
                            title={
                              artifact.observedAt
                                ? `${artifactLabel(artifact.family)} accepted ${new Date(
                                    artifact.observedAt,
                                  ).toLocaleString()}`
                                : `${artifactLabel(artifact.family)} has not been accepted yet`
                            }
                          >
                            {artifactLabel(artifact.family)} · {artifact.state}
                          </span>
                        ))}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="bridge-device-manager" aria-live="polite">
            <div className="bridge-device-manager__heading">
              <span>
                <Laptop size={16} />
                <strong>ESPN sync access</strong>
              </span>
              <button
                className="button button--outline button--small"
                type="button"
                onClick={() => void refreshBridgeDevices()}
                disabled={bridgeDevicesState === "working"}
              >
                <RefreshCw
                  className={bridgeDevicesState === "working" ? "spin" : undefined}
                  size={14}
                />
                Refresh
              </button>
            </div>
            {bridgeDevicesError ? (
              <p className="connection-error" role="alert">
                <TriangleAlert size={14} />
                {bridgeDevicesError}
              </p>
            ) : null}
            {bridgeDevicesState === "working" && visibleBridgeDevices.length === 0 ? (
              <p className="bridge-device-manager__empty">Checking ESPN sync status…</p>
            ) : visibleBridgeDevices.length === 0 ? (
              <p className="bridge-device-manager__empty">
                No browser is paired yet. Connect one with <strong>Find my ESPN leagues</strong>{" "}
                above; each paired browser is listed here.
              </p>
            ) : (
              <ul className="bridge-device-list">
                {visibleBridgeDevices.map((device) => (
                  <li key={device.deviceId}>
                    <div className="bridge-device-list__summary">
                      <span className={`bridge-device-state bridge-device-state--${device.state}`}>
                        {device.state === "active"
                          ? device.lastSeenAt
                            ? "Connected"
                            : "Awaiting first sync"
                          : device.state}
                      </span>
                      <strong>{device.name}</strong>
                      <small>
                        {device.clientKind === "ios-app"
                          ? "iOS sync agent"
                          : device.agentCapable
                            ? "Chrome sync agent"
                            : "Legacy browser credential"}
                        {" · "}
                        {formatBridgeTime(device.lastSeenAt)}
                      </small>
                    </div>
                    <div className="bridge-device-list__leagues">
                      {device.allowedLeagues.map((scope) => (
                        <span key={`${scope.externalLeagueId}:${scope.season ?? "all"}`}>
                          {scope.leagueName ?? `ESPN league ${scope.externalLeagueId}`}
                          {scope.season ? ` · ${scope.season}` : ""}
                        </span>
                      ))}
                    </div>
                    {device.state !== "revoked" ? (
                      <button
                        className="button button--danger button--small"
                        type="button"
                        onClick={() => setBridgeRevokeCandidate(device.deviceId)}
                        disabled={revokingDeviceId === device.deviceId}
                        aria-label={`Revoke ${device.name}`}
                      >
                        {revokingDeviceId === device.deviceId ? (
                          <LoaderCircle className="spin" size={14} />
                        ) : (
                          <Unplug size={14} />
                        )}
                        {revokingDeviceId === device.deviceId ? "Revoking…" : "Revoke"}
                      </button>
                    ) : null}
                    {bridgeRevokeCandidate === device.deviceId ? (
                      <div
                        className="bridge-revoke-confirmation"
                        role="alertdialog"
                        aria-modal="false"
                        aria-labelledby={`bridge-revoke-${device.deviceId}`}
                      >
                        <div>
                          <strong id={`bridge-revoke-${device.deviceId}`}>
                            Revoke ESPN sync access for {device.name}?
                          </strong>
                          <p>
                            Future syncs from this device will stop. Already-synced league data
                            remains available as last-known data.
                          </p>
                        </div>
                        <div>
                          <button
                            className="button button--outline button--small"
                            type="button"
                            onClick={() => setBridgeRevokeCandidate(null)}
                            disabled={revokingDeviceId !== null}
                          >
                            Keep access
                          </button>
                          <button
                            className="button button--danger button--small"
                            type="button"
                            onClick={() => void revokeBridgeDevice(device.deviceId)}
                            disabled={revokingDeviceId !== null}
                          >
                            {revokingDeviceId === device.deviceId ? (
                              <LoaderCircle className="spin" size={14} />
                            ) : (
                              <Unplug size={14} />
                            )}
                            {revokingDeviceId === device.deviceId
                              ? "Revoking access…"
                              : "Yes, revoke access"}
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </article>

        <article className="connection-provider connection-provider--yahoo">
          <div className="connection-provider__head">
            <span className="connection-provider-logo connection-provider-logo--yahoo">Y!</span>
            <div>
              <p className="eyebrow">
                {yahooComingSoon ? "Yahoo Fantasy · Coming soon" : "Official Yahoo sign-in"}
              </p>
              <h2>Connect Yahoo</h2>
            </div>
            <span
              className={`connection-provider-state${yahooConnections.length > 0 && !yahooNeedsReauthorization ? " connection-provider-state--connected" : yahooComingSoon ? " connection-provider-state--pending" : ""}`}
            >
              {yahooPanelState}
            </span>
          </div>
          <p>
            {yahooComingSoon
              ? "Yahoo sign-in and read-only league sync are coming soon."
              : "Authorize Laces Out without sharing your Yahoo password. Tokens remain encrypted on the configured server, and synced league access is read-only."}
          </p>
          <ul className="connection-capabilities">
            <li>
              <Check size={14} />
              {yahooComingSoon
                ? "Private league and team discovery"
                : "Connector path for private league and team discovery"}
            </li>
            <li>
              <Check size={14} /> Read-only settings, rosters, standings, and scoreboards
            </li>
            <li>
              <Check size={14} /> Server-side token exchange and encrypted token storage
            </li>
          </ul>
          {!yahooComingSoon || yahooConnections.length > 0 ? (
            <div className="yahoo-connection-manager" aria-live="polite">
              <div className="yahoo-connection-manager__heading">
                <span>
                  <ShieldCheck size={16} />
                  <strong>Yahoo connections</strong>
                </span>
                <button
                  className="button button--outline button--small"
                  type="button"
                  onClick={() => void refreshYahooConnections()}
                  disabled={yahooConnectionsState === "working" || yahooActionKey !== null}
                >
                  <RefreshCw
                    className={yahooConnectionsState === "working" ? "spin" : undefined}
                    size={14}
                  />
                  Refresh
                </button>
              </div>
              {yahooConnectionsError ? (
                <p className="connection-error" role="alert">
                  <TriangleAlert size={14} />
                  {yahooConnectionsError}
                </p>
              ) : null}
              {yahooConnectionsState === "working" && yahooConnections.length === 0 ? (
                <p className="yahoo-connection-manager__empty">Checking Yahoo connection status…</p>
              ) : yahooConnections.length === 0 ? (
                <p className="yahoo-connection-manager__empty">
                  {yahooComingSoon
                    ? "Yahoo sign-in is coming soon. No action is needed here yet."
                    : "No Yahoo account is connected yet. Select Connect Yahoo to begin."}
                </p>
              ) : (
                <ul className="yahoo-connection-list">
                  {yahooConnections.map((connection) => (
                    <li key={connection.connectionId}>
                      <div className="yahoo-connection-list__summary">
                        <span className={`provider-health provider-health--${connection.health}`}>
                          {yahooHealthLabel(connection.health)}
                        </span>
                        <strong>{connection.displayName}</strong>
                        <small>
                          Last successful sync:{" "}
                          {formatYahooTime(connection.lastSuccessfulAt, "Never")}
                        </small>
                      </div>
                      <div className="yahoo-connection-list__actions">
                        <button
                          className="button button--outline button--small"
                          type="button"
                          onClick={() => void runYahooSync(connection.connectionId)}
                          disabled={
                            yahooActionKey !== null ||
                            connection.health === "reauthorize" ||
                            connection.health === "disabled"
                          }
                        >
                          {yahooActionKey === `${connection.connectionId}:discover` ? (
                            <LoaderCircle className="spin" size={14} />
                          ) : (
                            <RefreshCw size={14} />
                          )}
                          Discover & sync
                        </button>
                        <button
                          className="button button--outline button--small"
                          type="button"
                          onClick={() => {
                            setYahooActionMessage(null);
                            setYahooDisconnectCandidate(connection.connectionId);
                          }}
                          disabled={yahooActionKey !== null}
                        >
                          <Unplug size={14} />
                          Disconnect
                        </button>
                      </div>
                      {yahooDisconnectCandidate === connection.connectionId ? (
                        <div
                          className="yahoo-disconnect-confirmation"
                          role="alertdialog"
                          aria-modal="false"
                          aria-labelledby={"yahoo-disconnect-" + connection.connectionId}
                        >
                          <div>
                            <strong id={"yahoo-disconnect-" + connection.connectionId}>
                              Remove stored Yahoo authorization?
                            </strong>
                            <p>
                              This deletes the locally stored Yahoo credential and stops future
                              syncs for this connection. Previously synchronized league data remains
                              as last-known data. This does not revoke access at Yahoo.
                            </p>
                          </div>
                          <div className="yahoo-disconnect-confirmation__actions">
                            <button
                              className="button button--outline button--small"
                              type="button"
                              onClick={() => setYahooDisconnectCandidate(null)}
                              disabled={yahooActionKey !== null}
                            >
                              Cancel
                            </button>
                            <button
                              className="button button--danger button--small"
                              type="button"
                              onClick={() => void disconnectYahoo(connection.connectionId)}
                              disabled={yahooActionKey !== null}
                            >
                              {yahooActionKey === connection.connectionId + ":disconnect" ? (
                                <LoaderCircle className="spin" size={14} />
                              ) : (
                                <Unplug size={14} />
                              )}
                              Remove stored authorization
                            </button>
                          </div>
                        </div>
                      ) : null}
                      {connection.lastErrorCode ? (
                        <p className="yahoo-connection-list__error">
                          Last attempt needs attention ·{" "}
                          {formatYahooTime(connection.lastErrorAt, "time unavailable")}
                        </p>
                      ) : null}
                      {connection.leagues.length > 0 ? (
                        <ul className="yahoo-league-list">
                          {connection.leagues.map((league) => {
                            const leagueActionKey = `${connection.connectionId}:${league.externalKey}`;
                            return (
                              <li key={league.leagueSeasonId}>
                                <div>
                                  <strong>{league.name}</strong>
                                  <small>
                                    {league.season}
                                    {league.currentWeek ? ` · Week ${league.currentWeek}` : ""} ·
                                    Last synced {formatYahooTime(league.lastSyncedAt, "never")}
                                  </small>
                                </div>
                                <button
                                  className="button button--outline button--small"
                                  type="button"
                                  onClick={() =>
                                    void runYahooSync(connection.connectionId, {
                                      externalKey: league.externalKey,
                                      name: league.name,
                                    })
                                  }
                                  disabled={yahooActionKey !== null}
                                  aria-label={`Sync ${league.name}`}
                                >
                                  {yahooActionKey === leagueActionKey ? (
                                    <LoaderCircle className="spin" size={14} />
                                  ) : (
                                    <RefreshCw size={14} />
                                  )}
                                  Sync
                                </button>
                              </li>
                            );
                          })}
                        </ul>
                      ) : (
                        <p className="yahoo-connection-list__empty">
                          No football leagues discovered yet.
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {yahooActionMessage ? (
                <p
                  className={`yahoo-action-message yahoo-action-message--${yahooActionMessage.tone}`}
                  role={yahooActionMessage.tone === "error" ? "alert" : "status"}
                >
                  {yahooActionMessage.tone === "success" ? (
                    <Check size={14} />
                  ) : (
                    <TriangleAlert size={14} />
                  )}
                  {yahooActionMessage.text}
                </p>
              ) : null}
            </div>
          ) : (
            <div className="yahoo-coming-soon-note" role="status">
              <ShieldCheck size={15} />
              <span>
                <strong>No setup needed yet.</strong> The connection button will appear here when
                Yahoo sync opens.
              </span>
            </div>
          )}
          {yahooError ? (
            <p className="connection-error" role="alert">
              <TriangleAlert size={14} />
              {yahooError}
            </p>
          ) : null}
          <button
            className="button button--dark button--full"
            type="button"
            onClick={() => void startYahoo()}
            disabled={
              yahooState === "working" ||
              yahooActionKey !== null ||
              (yahooComingSoon && yahooConnections.length === 0)
            }
          >
            {yahooState === "working" ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <Link2 size={16} />
            )}
            {yahooState === "working"
              ? "Opening Yahoo…"
              : yahooComingSoon && yahooConnections.length === 0
                ? "Yahoo coming soon"
                : yahooConnections.length > 0 || yahooState === "done"
                  ? "Reconnect Yahoo"
                  : "Connect Yahoo"}
            {yahooState !== "working" ? <ArrowRight size={15} /> : null}
          </button>
          <small className="provider-attribution">
            {yahooComingSoon
              ? "Official Yahoo Fantasy attribution appears throughout the locker room once Yahoo sync is enabled."
              : "Official Yahoo Fantasy attribution is displayed throughout the signed-in locker room."}
          </small>
        </article>
      </section>
    </div>
  );
}
