"use client";

import {
  ArrowRight,
  Check,
  Clipboard,
  ExternalLink,
  KeyRound,
  Link2,
  LoaderCircle,
  LockKeyhole,
  Laptop,
  MonitorUp,
  PackageCheck,
  RefreshCw,
  ServerCog,
  ShieldCheck,
  TriangleAlert,
  Unplug,
  X,
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";

import { apiBaseUrl } from "../lib/api-client";
import { createEspnBookmarklet, currentEspnSeason } from "../lib/espn-bookmarklet";
import { parseEspnLeagueIds } from "../lib/espn-league-ids";
import { yahooDeveloperAccessPending } from "../lib/public-site";

interface BridgeCredential {
  readonly deviceId: string;
  readonly deviceToken: string;
  readonly expiresAt: string | null;
}

type EspnConnectionMethod = "one-click" | "automatic";

interface ScopedBridgeCredential extends BridgeCredential {
  readonly method: EspnConnectionMethod;
  readonly leagueIds: readonly string[];
  readonly season: number;
}

interface BridgeDevice {
  readonly deviceId: string;
  readonly name: string;
  readonly state: "active" | "expired" | "revoked";
  readonly allowedLeagues: readonly {
    readonly externalLeagueId: string;
    readonly season: number | null;
    readonly leagueId: string | null;
    readonly leagueName: string | null;
  }[];
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly lastSeenAt: string | null;
  readonly revokedAt: string | null;
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

function isBridgeCredential(value: unknown): value is BridgeCredential {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.deviceId === "string" &&
    typeof record.deviceToken === "string" &&
    (record.expiresAt === null || typeof record.expiresAt === "string")
  );
}

function isBridgeDevice(value: unknown): value is BridgeDevice {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.deviceId === "string" &&
    typeof record.name === "string" &&
    ["active", "expired", "revoked"].includes(String(record.state)) &&
    Array.isArray(record.allowedLeagues) &&
    typeof record.createdAt === "string" &&
    (record.expiresAt === null || typeof record.expiresAt === "string") &&
    (record.lastSeenAt === null || typeof record.lastSeenAt === "string") &&
    (record.revokedAt === null || typeof record.revokedAt === "string")
  );
}

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

export function ConnectionWorkbench() {
  const [espnMethod, setEspnMethod] = useState<EspnConnectionMethod>("one-click");
  const [leagueIdsInput, setLeagueIdsInput] = useState("");
  const [espnSeason, setEspnSeason] = useState(() => currentEspnSeason());
  const [deviceName, setDeviceName] = useState("My Chrome bridge");
  const [bridgeState, setBridgeState] = useState<RequestState>("idle");
  const [bridgeError, setBridgeError] = useState<string | null>(null);
  const [credential, setCredential] = useState<ScopedBridgeCredential | null>(null);
  const [bridgeDevices, setBridgeDevices] = useState<readonly BridgeDevice[]>([]);
  const [bridgeDevicesState, setBridgeDevicesState] = useState<RequestState>("working");
  const [bridgeDevicesError, setBridgeDevicesError] = useState<string | null>(null);
  const [revokingDeviceId, setRevokingDeviceId] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "done" | "error">("idle");
  const [yahooState, setYahooState] = useState<RequestState>("idle");
  const [yahooError, setYahooError] = useState<string | null>(null);
  const [yahooConnections, setYahooConnections] = useState<readonly YahooConnectionStatus[]>([]);
  const [yahooConnectionsState, setYahooConnectionsState] = useState<RequestState>("working");
  const [yahooConnectionsError, setYahooConnectionsError] = useState<string | null>(null);
  const [yahooActionKey, setYahooActionKey] = useState<string | null>(null);
  const [yahooActionMessage, setYahooActionMessage] = useState<UiMessage | null>(null);
  const [yahooDisconnectCandidate, setYahooDisconnectCandidate] = useState<string | null>(null);
  const [callbackNotice, setCallbackNotice] = useState<UiMessage | null>(null);
  const bookmarkletRef = useRef<HTMLAnchorElement>(null);

  const bookmarklet =
    credential?.method === "one-click"
      ? createEspnBookmarklet({
          apiBaseUrl,
          deviceToken: credential.deviceToken,
          leagueIds: credential.leagueIds,
          season: credential.season,
        })
      : null;

  useEffect(() => {
    if (!bookmarklet || !bookmarkletRef.current) return;
    // React blocks javascript: hrefs. This user-created bookmark is deliberately set after render.
    bookmarkletRef.current.setAttribute("href", bookmarklet);
  }, [bookmarklet]);

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
        return;
      }
      if (!response.ok) throw new ConnectionUiError("Paired ESPN browsers could not be loaded.");
      const body = (await response.json()) as { devices?: unknown };
      if (!Array.isArray(body.devices) || !body.devices.every(isBridgeDevice)) {
        throw new ConnectionUiError("The bridge device list was invalid.");
      }
      setBridgeDevices(body.devices);
      setBridgeDevicesState("done");
    } catch (error) {
      setBridgeDevicesState("error");
      setBridgeDevicesError(
        error instanceof ConnectionUiError
          ? error.message
          : "Paired ESPN browsers could not be loaded.",
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
    } catch (error) {
      setYahooConnectionsState("error");
      setYahooConnectionsError(
        error instanceof ConnectionUiError
          ? error.message
          : "Yahoo connection status could not be loaded.",
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

  useEffect(() => {
    void refreshBridgeDevices();
    void refreshYahooConnections();
  }, [refreshBridgeDevices, refreshYahooConnections]);

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
        window.location.assign("/login");
        return;
      }
      if (!response.ok) {
        throw new ConnectionUiError(
          response.status === 503
            ? "Yahoo sign-in is coming soon."
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
          : "The API could not start Yahoo authorization. Try again when it is available.",
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
        window.location.assign("/login");
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
        window.location.assign("/login");
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
        text: "Stored Yahoo authorization removed from Laces Out. Previously synchronized league data remains available as last-known data; no Yahoo revocation request was made.",
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

  async function pairBridge(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBridgeState("working");
    setBridgeError(null);
    setCredential(null);
    try {
      let allowedLeagueIds: readonly string[];
      try {
        allowedLeagueIds = parseEspnLeagueIds(leagueIdsInput);
      } catch (error) {
        throw new ConnectionUiError(
          error instanceof Error ? error.message : "The ESPN league ID list is invalid.",
        );
      }
      if (!Number.isSafeInteger(espnSeason) || espnSeason < 2000 || espnSeason > 2100) {
        throw new ConnectionUiError("Choose a valid ESPN fantasy season.");
      }
      const credentialName = espnMethod === "one-click" ? "One-click ESPN sync" : deviceName.trim();
      const response = await fetch(`${apiBaseUrl}/v1/bridge/espn/devices`, {
        method: "POST",
        credentials: "include",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ name: credentialName, allowedLeagueIds }),
      });
      if (response.status === 401) {
        window.location.assign("/login");
        return;
      }
      if (!response.ok) {
        throw new ConnectionUiError(
          response.status === 503
            ? "The bridge API is temporarily unavailable. Check the database and API process."
            : "The bridge device could not be created.",
        );
      }
      const body: unknown = await response.json();
      if (!isBridgeCredential(body)) {
        throw new ConnectionUiError("The bridge returned an invalid credential.");
      }
      setCredential({
        ...body,
        method: espnMethod,
        leagueIds: allowedLeagueIds,
        season: espnSeason,
      });
      setCopyState("idle");
      setBridgeState("done");
      await refreshBridgeDevices();
    } catch (error) {
      setBridgeState("error");
      setBridgeError(
        error instanceof ConnectionUiError
          ? error.message
          : "The API could not pair this bridge. Try again when it is available.",
      );
    }
  }

  async function copyToken() {
    if (!credential) return;
    try {
      await navigator.clipboard.writeText(credential.deviceToken);
      setCopyState("done");
      window.setTimeout(() => setCopyState("idle"), 1800);
    } catch {
      setCopyState("error");
    }
  }

  async function copyBookmarklet() {
    if (!bookmarklet) return;
    try {
      await navigator.clipboard.writeText(bookmarklet);
      setCopyState("done");
      window.setTimeout(() => setCopyState("idle"), 1800);
    } catch {
      setCopyState("error");
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
        window.location.assign("/login");
        return;
      }
      if (!response.ok) throw new ConnectionUiError("This bridge device could not be revoked.");
      if (credential?.deviceId === deviceId) setCredential(null);
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
          : yahooDeveloperAccessPending
            ? "Coming soon"
            : yahooConnectionsState === "error"
              ? "Setup required"
              : "Ready to connect";
  const activeBridgeDevices = bridgeDevices.filter((device) => device.state === "active");
  const espnPanelState = activeBridgeDevices.some((device) => device.lastSeenAt !== null)
    ? "Connected"
    : activeBridgeDevices.length > 0
      ? "Awaiting first sync"
      : bridgeDevicesState === "working"
        ? "Checking status"
        : "Ready to connect";

  return (
    <div className="connections-page">
      <section className="page-heading connection-heading">
        <div>
          <p className="eyebrow">League connections</p>
          <h1>Connections</h1>
          <p className="page-subtitle">
            {yahooDeveloperAccessPending
              ? "Connect ESPN with one-click sync or optional automatic refresh. Yahoo sign-in is coming soon."
              : "Connect Yahoo with official sign-in or ESPN with one-click sync and optional automatic refresh."}
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

      <section
        className="connection-grid"
        id="data-health"
        aria-label="Fantasy provider connections"
      >
        <article className="connection-provider connection-provider--yahoo">
          <div className="connection-provider__head">
            <span className="connection-provider-logo connection-provider-logo--yahoo">Y!</span>
            <div>
              <p className="eyebrow">Official Yahoo sign-in</p>
              <h2>Connect Yahoo</h2>
            </div>
            <span
              className={`connection-provider-state${yahooConnections.length > 0 && !yahooNeedsReauthorization ? " connection-provider-state--connected" : yahooDeveloperAccessPending ? " connection-provider-state--pending" : ""}`}
            >
              {yahooPanelState}
            </span>
          </div>
          <p>
            {yahooDeveloperAccessPending
              ? "Yahoo sign-in and read-only league sync are coming soon."
              : "Authorize Laces Out without sharing your Yahoo password. Tokens remain encrypted on the configured server, and synced league access is read-only."}
          </p>
          <ul className="connection-capabilities">
            <li>
              <Check size={14} /> Connector path for private league and team discovery
            </li>
            <li>
              <Check size={14} /> Read-only settings, rosters, standings, and scoreboards
            </li>
            <li>
              <Check size={14} /> Server-side token exchange and encrypted token storage
            </li>
          </ul>
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
                {yahooDeveloperAccessPending
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
                            Laces Out will delete its local Yahoo credential and stop future syncs
                            for this connection. Previously synchronized league data remains as
                            last-known data. This does not revoke access at Yahoo.
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
                                  {league.currentWeek ? ` · Week ${league.currentWeek}` : ""} · Last
                                  synced {formatYahooTime(league.lastSyncedAt, "never")}
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
              (yahooDeveloperAccessPending && yahooConnections.length === 0)
            }
          >
            {yahooState === "working" ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <Link2 size={16} />
            )}
            {yahooState === "working"
              ? "Opening Yahoo…"
              : yahooDeveloperAccessPending && yahooConnections.length === 0
                ? "Yahoo coming soon"
                : yahooConnections.length > 0 || yahooState === "done"
                  ? "Reconnect Yahoo"
                  : "Connect Yahoo"}
            {yahooState !== "working" ? <ArrowRight size={15} /> : null}
          </button>
          <small className="provider-attribution">
            Official Yahoo Fantasy attribution is displayed throughout the signed-in locker room.
          </small>
        </article>

        <article className="connection-provider connection-provider--espn">
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
            Choose one connection method. One-click sync is the quickest setup; the Chrome companion
            is only for automatic refreshes. Both send league data—not your ESPN password or
            cookies.
          </p>

          <div className="espn-method-switcher" role="tablist" aria-label="ESPN connection method">
            <button
              className={
                "espn-method-switcher__option" +
                (espnMethod === "one-click" ? " espn-method-switcher__option--active" : "")
              }
              type="button"
              role="tab"
              aria-selected={espnMethod === "one-click"}
              onClick={() => {
                setEspnMethod("one-click");
                setBridgeError(null);
                setCopyState("idle");
              }}
            >
              <span>One-Click Sync</span>
              <small>Recommended</small>
            </button>
            <button
              className={
                "espn-method-switcher__option" +
                (espnMethod === "automatic" ? " espn-method-switcher__option--active" : "")
              }
              type="button"
              role="tab"
              aria-selected={espnMethod === "automatic"}
              onClick={() => {
                setEspnMethod("automatic");
                setBridgeError(null);
                setCopyState("idle");
              }}
            >
              <span>Automatic Sync</span>
              <small>Chrome companion</small>
            </button>
          </div>

          {espnMethod === "one-click" ? (
            <div className="espn-method-panel" role="tabpanel">
              <div className="bridge-readiness" role="note" id="espn-one-click-note">
                <ShieldCheck size={16} />
                <div>
                  <strong>Fast, private setup</strong>
                  <span>
                    Create a scoped browser bookmark once. Run it while signed in on ESPN whenever
                    you want fresh league data.
                  </span>
                </div>
              </div>

              <form
                className="bridge-pair-form"
                onSubmit={(event) => void pairBridge(event)}
                aria-describedby="espn-one-click-note"
              >
                <div className="bridge-form-heading bridge-form-heading--plain">
                  <KeyRound size={17} />
                  <div>
                    <strong>Create your sync button</strong>
                    <small>Paste a league page URL or the numeric league ID.</small>
                  </div>
                </div>
                <div className="bridge-fields">
                  <label htmlFor="espn-one-click-leagues">
                    ESPN league URL or ID
                    <input
                      id="espn-one-click-leagues"
                      value={leagueIdsInput}
                      onChange={(event) => setLeagueIdsInput(event.target.value)}
                      inputMode="url"
                      placeholder="https://fantasy.espn.com/…?leagueId=123456789"
                      aria-describedby="espn-one-click-leagues-help"
                      required
                    />
                    <small id="espn-one-click-leagues-help">
                      Add more than one with spaces or commas.
                    </small>
                  </label>
                  <label htmlFor="espn-one-click-season">
                    Season
                    <input
                      id="espn-one-click-season"
                      type="number"
                      min="2000"
                      max="2100"
                      value={espnSeason}
                      onChange={(event) => setEspnSeason(Number(event.target.value))}
                      required
                    />
                  </label>
                </div>
                <button
                  className="button button--lime button--full"
                  type="submit"
                  disabled={bridgeState === "working"}
                >
                  {bridgeState === "working" ? (
                    <LoaderCircle className="spin" size={16} />
                  ) : (
                    <KeyRound size={16} />
                  )}
                  {bridgeState === "working" ? "Creating sync button…" : "Create my sync button"}
                </button>
              </form>

              {bridgeError ? (
                <p className="connection-error" role="alert">
                  <TriangleAlert size={14} />
                  {bridgeError}
                </p>
              ) : null}

              {credential?.method === "one-click" && bookmarklet ? (
                <div className="espn-bookmarklet">
                  <div className="espn-bookmarklet__heading">
                    <Check size={16} />
                    <span>
                      <strong>Your private sync button is ready</strong>
                      <small>
                        It can read only the ESPN leagues you listed and can be revoked below.
                      </small>
                    </span>
                  </div>
                  <div className="espn-bookmarklet__actions">
                    <a
                      ref={bookmarkletRef}
                      className="button button--lime espn-bookmarklet__link"
                      href="#espn-bookmarklet"
                      draggable
                      onClick={(event) => event.preventDefault()}
                    >
                      <Link2 size={15} />
                      Laces Out · Sync ESPN
                    </a>
                    <button
                      className="button button--outline"
                      type="button"
                      onClick={() => void copyBookmarklet()}
                    >
                      {copyState === "done" ? <Check size={14} /> : <Clipboard size={14} />}
                      {copyState === "done" ? "Copied" : "Copy Mobile Setup Code"}
                    </button>
                  </div>
                  <ol className="bridge-steps espn-bookmarklet__steps">
                    <li>
                      <span>1</span>
                      <div>
                        <strong>Save the sync button</strong>
                        <small>
                          Desktop: drag it to the bookmarks bar. Mobile: copy the code, bookmark
                          ESPN, then edit that bookmark and replace its URL.
                        </small>
                      </div>
                      <Clipboard size={17} />
                    </li>
                    <li>
                      <span>2</span>
                      <div>
                        <strong>Sign in directly on ESPN</strong>
                        <small>Your ESPN session stays in this browser.</small>
                      </div>
                      <a
                        href="https://fantasy.espn.com/football/"
                        target="_blank"
                        rel="noreferrer"
                        aria-label="Open ESPN Fantasy"
                      >
                        <ExternalLink size={17} />
                      </a>
                    </li>
                    <li>
                      <span>3</span>
                      <div>
                        <strong>Run Laces Out · Sync ESPN</strong>
                        <small>Use the saved bookmark from any ESPN Fantasy page.</small>
                      </div>
                      <ArrowRight size={17} />
                    </li>
                  </ol>
                  <span className="bridge-copy-status" role="status">
                    {copyState === "error"
                      ? "Clipboard access failed. Try again or drag the button on desktop."
                      : copyState === "done"
                        ? "Mobile setup code copied."
                        : ""}
                  </span>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="espn-method-panel" role="tabpanel">
              <div className="bridge-readiness" role="note">
                <PackageCheck size={16} />
                <div>
                  <strong>Automatic refresh for desktop Chrome</strong>
                  <span>
                    The companion refreshes every six hours while Chrome and your ESPN session are
                    available.
                  </span>
                  <a
                    className="button button--outline button--small bridge-download"
                    href="/downloads/laces-out-espn-bridge-v0.1.0.zip"
                    download
                  >
                    Download the Chrome companion
                  </a>
                </div>
              </div>
              <div
                className="bridge-readiness bridge-readiness--warning"
                role="note"
                id="bridge-api-note"
              >
                <ServerCog size={16} />
                <div>
                  <strong>These steps apply only to automatic sync</strong>
                  <span>Prefer One-Click Sync if you do not need background refreshes.</span>
                </div>
              </div>

              <ol className="bridge-steps">
                <li>
                  <span>1</span>
                  <div>
                    <strong>Load the Chrome companion</strong>
                    <small>
                      Extract the download, then choose its folder in chrome://extensions.
                    </small>
                  </div>
                  <MonitorUp size={17} />
                </li>
                <li>
                  <span>2</span>
                  <div>
                    <strong>Sign in directly on ESPN</strong>
                    <small>The ESPN session stays in this browser.</small>
                  </div>
                  <a
                    href="https://fantasy.espn.com/football/"
                    target="_blank"
                    rel="noreferrer"
                    aria-label="Open ESPN Fantasy"
                  >
                    <ExternalLink size={17} />
                  </a>
                </li>
              </ol>

              <form
                className="bridge-pair-form"
                onSubmit={(event) => void pairBridge(event)}
                aria-describedby="bridge-api-note"
              >
                <div className="bridge-form-heading">
                  <span>3</span>
                  <div>
                    <strong>Pair the companion</strong>
                    <small>Create a revocable credential for this browser and these leagues.</small>
                  </div>
                </div>
                <div className="bridge-fields bridge-fields--three">
                  <label htmlFor="bridge-device-name">
                    Device label
                    <input
                      id="bridge-device-name"
                      value={deviceName}
                      onChange={(event) => setDeviceName(event.target.value)}
                      maxLength={80}
                      required
                      autoComplete="off"
                    />
                  </label>
                  <label htmlFor="espn-automatic-leagues">
                    ESPN league URL or ID
                    <input
                      id="espn-automatic-leagues"
                      value={leagueIdsInput}
                      onChange={(event) => setLeagueIdsInput(event.target.value)}
                      inputMode="url"
                      placeholder="123456789"
                      aria-describedby="espn-automatic-leagues-help"
                      required
                    />
                    <small id="espn-automatic-leagues-help">
                      Add more than one with spaces or commas.
                    </small>
                  </label>
                  <label htmlFor="espn-automatic-season">
                    Season
                    <input
                      id="espn-automatic-season"
                      type="number"
                      min="2000"
                      max="2100"
                      value={espnSeason}
                      onChange={(event) => setEspnSeason(Number(event.target.value))}
                      required
                    />
                  </label>
                </div>
                <button
                  className="button button--lime button--full"
                  type="submit"
                  disabled={bridgeState === "working"}
                >
                  {bridgeState === "working" ? (
                    <LoaderCircle className="spin" size={16} />
                  ) : (
                    <KeyRound size={16} />
                  )}
                  {bridgeState === "working" ? "Creating credential…" : "Create secure pairing"}
                </button>
              </form>

              {bridgeError ? (
                <p className="connection-error" role="alert">
                  <TriangleAlert size={14} />
                  {bridgeError}
                </p>
              ) : null}

              {credential?.method === "automatic" ? (
                <div className="bridge-token">
                  <div>
                    <LockKeyhole size={15} />
                    <span>
                      <strong>Copy this pairing token now</strong>
                      <small>It is shown only for this pairing response.</small>
                    </span>
                  </div>
                  <code aria-label="One-time bridge device token">{credential.deviceToken}</code>
                  <button
                    className="button button--outline button--small"
                    type="button"
                    onClick={() => void copyToken()}
                  >
                    {copyState === "done" ? <Check size={14} /> : <Clipboard size={14} />}
                    {copyState === "done" ? "Copied" : "Copy Token"}
                  </button>
                  <span className="bridge-copy-status" role="status">
                    {copyState === "error"
                      ? "Clipboard access failed. Select and copy the token manually."
                      : copyState === "done"
                        ? "Token copied."
                        : ""}
                  </span>
                  <small>
                    Paste it into the companion with Laces Out URL <strong>{apiBaseUrl}</strong>,
                    league IDs <strong>{credential.leagueIds.join(", ")}</strong>, and season{" "}
                    <strong>{credential.season}</strong>.
                  </small>
                </div>
              ) : null}
            </div>
          )}

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
            {bridgeDevicesState === "working" && bridgeDevices.length === 0 ? (
              <p className="bridge-device-manager__empty">Checking ESPN sync status…</p>
            ) : bridgeDevices.length === 0 ? (
              <p className="bridge-device-manager__empty">
                No ESPN sync access yet. Create a one-click button or pair the Chrome companion
                above.
              </p>
            ) : (
              <ul className="bridge-device-list">
                {bridgeDevices.map((device) => (
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
                      <small>{formatBridgeTime(device.lastSeenAt)}</small>
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
                        onClick={() => void revokeBridgeDevice(device.deviceId)}
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
                  </li>
                ))}
              </ul>
            )}
          </div>
        </article>
      </section>
    </div>
  );
}
