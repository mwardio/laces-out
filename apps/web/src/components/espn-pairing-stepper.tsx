"use client";

import {
  Check,
  Clipboard,
  ExternalLink,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  PackageCheck,
  RefreshCw,
  Search,
  TriangleAlert,
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";

import {
  absoluteApiOrigin,
  apiBaseUrl,
  parseEspnBridgeDeviceCredential,
  parseEspnBridgePairingSession,
  type EspnBridgePairingSession,
} from "../lib/api-client";
import {
  chromeWebStoreUrl,
  discoverLeagues,
  pingBridge,
  publishedBridgeAcceptsOrigin,
  sendPairingOffer,
  type BridgePingOutcome,
  type DiscoverLeaguesOutcome,
} from "../lib/bridge-extension";
import { currentEspnSeason, parseEspnLeagueIds } from "../lib/espn-league-ids";
import { deriveEspnPairingStep } from "../lib/espn-pairing-flow";
import { loginUrlForCurrentPath } from "../lib/safe-return-to";

class PairingUiError extends Error {}

const pingPollIntervalMs = 2000;
const pollingSteps = new Set(["extension-missing", "offer-sent", "paired-syncing"]);

interface EspnPairingStepperProps {
  readonly signedOut: boolean;
  /** The paired-device list changed (a device was minted or revoked). */
  readonly onDevicesChanged: () => void;
  /** Pairing completed or first sync progressed; refresh league health. */
  readonly onSyncActivity: () => void;
}

export function EspnPairingStepper({
  signedOut,
  onDevicesChanged,
  onSyncActivity,
}: EspnPairingStepperProps) {
  const [publishedOrigin, setPublishedOrigin] = useState(false);
  const [ping, setPing] = useState<BridgePingOutcome | undefined>(undefined);
  const [pingAt, setPingAt] = useState<number | undefined>(undefined);
  const [espnSeason, setEspnSeason] = useState(() => currentEspnSeason());
  const [deviceName, setDeviceName] = useState("My Chrome bridge");
  const [leagueIdsInput, setLeagueIdsInput] = useState("");
  const [manualEntryOpen, setManualEntryOpen] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [discovery, setDiscovery] = useState<DiscoverLeaguesOutcome | undefined>(undefined);
  const [selectedLeagueIds, setSelectedLeagueIds] = useState<ReadonlySet<string>>(new Set());
  const [pairing, setPairing] = useState(false);
  const [pairingError, setPairingError] = useState<string | null>(null);
  const [offerSentAt, setOfferSentAt] = useState<number | undefined>(undefined);
  const [offerLegacy, setOfferLegacy] = useState(false);
  const [selfHostedPairing, setSelfHostedPairing] = useState<EspnBridgePairingSession | null>(null);
  const [pairingCodeCopyState, setPairingCodeCopyState] = useState<"idle" | "done" | "error">(
    "idle",
  );
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setPublishedOrigin(publishedBridgeAcceptsOrigin(window.location.origin));
  }, []);

  const probeExtension = useCallback(async () => {
    const outcome = await pingBridge();
    setPing(outcome);
    setPingAt(Date.now());
    setNow(Date.now());
  }, []);

  const step = deriveEspnPairingStep({
    ping,
    pingAt,
    publishedOrigin,
    discovering,
    discovery,
    offerSentAt,
    now,
    selfHostedPairing: selfHostedPairing !== null,
  });

  // One probe on mount, then a 2-second cadence only while a step is actually
  // waiting on the extension (install, popup confirmation, first sync).
  useEffect(() => {
    void probeExtension();
  }, [probeExtension]);
  useEffect(() => {
    if (!pollingSteps.has(step)) return;
    const interval = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void probeExtension();
    }, pingPollIntervalMs);
    return () => window.clearInterval(interval);
  }, [step, probeExtension]);

  // Advancing into the paired states is the moment server-side data (device
  // lastSeenAt, league health) starts moving; let the parent panels catch up.
  const previousStepRef = useRef(step);
  useEffect(() => {
    if (previousStepRef.current === step) return;
    previousStepRef.current = step;
    if (step === "paired-syncing" || step === "connected") {
      onDevicesChanged();
      onSyncActivity();
    }
  }, [step, onDevicesChanged, onSyncActivity]);

  const runDiscovery = useCallback(async () => {
    const target = ping?.extensionId;
    if (target === undefined || ping?.supportsDiscovery !== true) return;
    setDiscovering(true);
    setPairingError(null);
    try {
      const outcome = await discoverLeagues(target, espnSeason);
      setDiscovery(outcome);
      if (outcome.ok) {
        setSelectedLeagueIds(new Set(outcome.leagues.map((league) => league.leagueId)));
        setManualEntryOpen(false);
      }
    } finally {
      setDiscovering(false);
    }
  }, [ping, espnSeason]);

  // After the member signs in on the ESPN tab and returns, retry without
  // another click. Only for the pre-pairing case: once paired, the extension's
  // own next sync clears the login-required state.
  useEffect(() => {
    if (step !== "espn-login-required" || ping?.pairedToThisOrigin === true) return;
    const retry = () => void runDiscovery();
    window.addEventListener("focus", retry);
    return () => window.removeEventListener("focus", retry);
  }, [step, ping, runDiscovery]);

  function toggleLeague(leagueId: string) {
    setSelectedLeagueIds((current) => {
      const next = new Set(current);
      if (next.has(leagueId)) {
        next.delete(leagueId);
      } else {
        next.add(leagueId);
      }
      return next;
    });
  }

  async function createSelfHostedPairing(credentialName: string, leagueIds: readonly string[]) {
    const response = await fetch(`${apiBaseUrl}/v1/bridge/espn/pairing-sessions`, {
      method: "POST",
      credentials: "include",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        name: credentialName,
        allowedLeagueIds: leagueIds,
        season: espnSeason,
      }),
    });
    if (response.status === 401) {
      window.location.assign(loginUrlForCurrentPath());
      return;
    }
    if (!response.ok) {
      throw new PairingUiError("A self-hosted pairing code could not be created.");
    }
    const pairingSession = parseEspnBridgePairingSession(await response.json());
    if (!pairingSession) throw new PairingUiError("The bridge returned an invalid pairing code.");
    setSelfHostedPairing(pairingSession);
  }

  async function pairBridge(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPairing(true);
    setPairingError(null);
    setPairingCodeCopyState("idle");
    try {
      const usingManual = manualEntryOpen || discovery?.ok !== true;
      let allowedLeagueIds: readonly string[];
      let season = espnSeason;
      if (usingManual) {
        try {
          allowedLeagueIds = parseEspnLeagueIds(leagueIdsInput);
        } catch (error) {
          throw new PairingUiError(
            error instanceof Error ? error.message : "The ESPN league ID list is invalid.",
          );
        }
      } else {
        const chosen = discovery.leagues.filter((league) => selectedLeagueIds.has(league.leagueId));
        if (chosen.length === 0) throw new PairingUiError("Choose at least one league to sync.");
        const seasons = [...new Set(chosen.map((league) => league.seasonId))];
        if (seasons.length > 1) {
          throw new PairingUiError(
            "Pick leagues from one season, pair, then repeat for the other season.",
          );
        }
        season = seasons[0] ?? espnSeason;
        allowedLeagueIds = chosen.map((league) => league.leagueId);
      }
      if (!Number.isSafeInteger(season) || season < 2000 || season > 2100) {
        throw new PairingUiError("Choose a valid ESPN fantasy season.");
      }
      const credentialName = deviceName.trim();

      // Probe again right before minting so no credential is ever created for
      // a companion that cannot receive it.
      const probe = await pingBridge();
      setPing(probe);
      setPingAt(Date.now());
      if (!probe.installed) {
        if (publishedOrigin) {
          throw new PairingUiError(
            "The Chrome companion did not respond. Check that it is installed and enabled, then try again.",
          );
        }
        await createSelfHostedPairing(credentialName, allowedLeagueIds);
        return;
      }

      const response = await fetch(`${apiBaseUrl}/v1/bridge/espn/devices`, {
        method: "POST",
        credentials: "include",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          name: credentialName,
          allowedLeagueIds,
          season,
          agentCapabilities: ["refresh-intents-v1"],
        }),
      });
      if (response.status === 401) {
        window.location.assign(loginUrlForCurrentPath());
        return;
      }
      if (!response.ok) {
        throw new PairingUiError(
          response.status === 503
            ? "The bridge API is temporarily unavailable. Check the database and API process."
            : "The bridge device could not be created.",
        );
      }
      const issued = parseEspnBridgeDeviceCredential(await response.json());
      if (!issued) throw new PairingUiError("The bridge returned an invalid credential.");

      // The token lives only in this scope and this message — never in
      // component state, a URL, a log, or the clipboard.
      const outcome = await sendPairingOffer({
        apiBaseUrl: window.location.origin,
        deviceToken: issued.deviceToken,
        leagues: allowedLeagueIds,
        season,
      });
      if (!outcome.ok) {
        // The credential never reached a companion; leave nothing behind.
        await fetch(`${apiBaseUrl}/v1/bridge/espn/devices/${issued.deviceId}`, {
          method: "DELETE",
          credentials: "include",
          headers: { Accept: "application/json" },
        }).catch(() => undefined);
        throw new PairingUiError(
          "The companion stopped responding before pairing finished. Try again.",
        );
      }
      setOfferSentAt(Date.now());
      setOfferLegacy(probe.supportsDiscovery !== true);
      setNow(Date.now());
      onDevicesChanged();
    } catch (error) {
      setPairingError(
        error instanceof PairingUiError
          ? error.message
          : "The API could not pair this bridge. Try again when it is available.",
      );
    } finally {
      setPairing(false);
    }
  }

  async function copySelfHostedPairingCode() {
    if (!selfHostedPairing) return;
    try {
      await navigator.clipboard.writeText(selfHostedPairing.pairingCode);
      setPairingCodeCopyState("done");
      window.setTimeout(() => setPairingCodeCopyState("idle"), 1800);
    } catch {
      setPairingCodeCopyState("error");
    }
  }

  function resetOffer() {
    setOfferSentAt(undefined);
    setOfferLegacy(false);
    setPairingError(null);
  }

  const manualFields = (open: boolean) => (
    <details
      className="bridge-manual-entry"
      open={open}
      onToggle={(event) => setManualEntryOpen((event.target as HTMLDetailsElement).open)}
    >
      <summary>Enter league IDs manually instead</summary>
      <div className="bridge-fields">
        <label htmlFor="espn-automatic-leagues">
          ESPN league URL or ID
          <input
            id="espn-automatic-leagues"
            value={leagueIdsInput}
            onChange={(event) => setLeagueIdsInput(event.target.value)}
            inputMode="url"
            placeholder="123456789"
            aria-describedby="espn-automatic-leagues-help"
          />
          <small id="espn-automatic-leagues-help">Add more than one with spaces or commas.</small>
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
          />
        </label>
      </div>
    </details>
  );

  const deviceNameField = (
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
  );

  const submitButton = (label: string) => (
    <button
      className="button button--lime button--full"
      type="submit"
      disabled={pairing || signedOut}
    >
      {pairing ? <LoaderCircle className="spin" size={16} /> : <KeyRound size={16} />}
      {pairing ? "Sending pairing…" : label}
    </button>
  );

  const pairingErrorNote = pairingError ? (
    <p className="connection-error" role="alert">
      <TriangleAlert size={14} />
      {pairingError}
    </p>
  ) : null;

  return (
    <div className="espn-method-panel" aria-live="polite">
      {step === "checking" ? (
        <p className="bridge-step-status" role="status">
          <LoaderCircle className="spin" size={14} />
          Checking for the Chrome companion…
        </p>
      ) : null}

      {step === "extension-missing" ? (
        <>
          <div className="bridge-readiness" role="note">
            <PackageCheck size={16} />
            <div>
              <strong>Step 1 of 2 · Install the Chrome companion</strong>
              <span>This page continues automatically after installation.</span>
              <a
                className="button button--outline button--small bridge-download"
                href={chromeWebStoreUrl}
                target="_blank"
                rel="noreferrer"
              >
                Install from Chrome Web Store
                <ExternalLink size={13} />
              </a>
            </div>
          </div>
        </>
      ) : null}

      {step === "ready-to-discover" || step === "discovering" ? (
        <>
          <form className="bridge-pair-form" onSubmit={(event) => void pairBridge(event)}>
            <div className="bridge-form-heading">
              <span>2</span>
              <div>
                <strong>Find your ESPN leagues</strong>
                <small>Lists leagues on your signed-in ESPN account.</small>
              </div>
            </div>
            {discovery !== undefined &&
            !discovery.ok &&
            discovery.state !== "espn-login-required" ? (
              <p className="connection-error" role="alert">
                <TriangleAlert size={14} />
                {discovery.reason ?? "League discovery failed. Try again."}
              </p>
            ) : null}
            <button
              className="button button--lime button--full"
              type="button"
              onClick={() => void runDiscovery()}
              disabled={discovering || signedOut}
            >
              {discovering ? <LoaderCircle className="spin" size={16} /> : <Search size={16} />}
              {discovering ? "Finding your leagues…" : "Find my ESPN leagues"}
            </button>
            {manualEntryOpen ? (
              <>
                <div className="bridge-fields">{deviceNameField}</div>
                {manualFields(true)}
                {submitButton("Connect & keep synced")}
              </>
            ) : (
              manualFields(false)
            )}
            {pairingErrorNote}
          </form>
        </>
      ) : null}

      {step === "espn-login-required" ? (
        <div className="bridge-token bridge-token--attention">
          <div>
            <TriangleAlert size={15} />
            <span>
              <strong>Sign in to ESPN in this browser</strong>
              <small>
                {ping?.pairedToThisOrigin === true
                  ? "The companion is paired but ESPN signed this browser out, so syncs are paused until you sign back in."
                  : "The companion needs your ESPN session to find your leagues. Sign in on the ESPN tab, then come back — this page retries automatically."}
              </small>
            </span>
          </div>
          <a
            className="button button--outline button--small"
            href="https://fantasy.espn.com/football/"
            target="_blank"
            rel="noreferrer"
          >
            Open ESPN Fantasy
            <ExternalLink size={13} />
          </a>
          {ping?.pairedToThisOrigin !== true ? (
            <button
              className="button button--outline button--small"
              type="button"
              onClick={() => void runDiscovery()}
              disabled={discovering}
            >
              {discovering ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}
              Check again
            </button>
          ) : null}
        </div>
      ) : null}

      {step === "league-selection" && discovery?.ok === true ? (
        <form className="bridge-pair-form" onSubmit={(event) => void pairBridge(event)}>
          <div className="bridge-form-heading">
            <span>2</span>
            <div>
              <strong>Choose leagues to keep synced</strong>
              <small>
                {discovery.leagues.length === 0
                  ? `No leagues were found for ${espnSeason} on this ESPN account.`
                  : discovery.seasonMatched
                    ? `Found on your ESPN account. Untick any league you don't want on Laces Out.`
                    : `None found for ${espnSeason}, so every discovered season is listed.`}
              </small>
            </div>
          </div>
          {discovery.leagues.length > 0 ? (
            <ul className="bridge-league-picker">
              {discovery.leagues.map((league) => (
                <li key={`${league.leagueId}:${league.seasonId}`}>
                  <label>
                    <input
                      type="checkbox"
                      checked={selectedLeagueIds.has(league.leagueId)}
                      onChange={() => toggleLeague(league.leagueId)}
                    />
                    <span>
                      <strong>{league.leagueName}</strong>
                      <small>
                        {league.teamName !== undefined ? `${league.teamName} · ` : ""}
                        {league.seasonId}
                        {" · ID "}
                        {league.leagueId}
                      </small>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="bridge-fields">{deviceNameField}</div>
          {manualFields(manualEntryOpen)}
          {submitButton("Connect & keep synced")}
          <button
            className="button button--outline button--small"
            type="button"
            onClick={() => void runDiscovery()}
            disabled={discovering}
          >
            {discovering ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}
            Refresh the list
          </button>
          {pairingErrorNote}
        </form>
      ) : null}

      {step === "offer-sent" ? (
        <div className="bridge-token">
          <div>
            <LockKeyhole size={15} />
            <span>
              <strong>One click left — confirm in the extension</strong>
              <small>
                {offerLegacy
                  ? "Open the Laces Out ESPN Bridge extension from the toolbar and press Connect."
                  : "Confirm in the extension popup that just opened, or click the Laces Out icon (badge “1”) in the toolbar. This page finishes on its own."}
              </small>
            </span>
          </div>
          <span className="bridge-copy-status" role="status">
            <LoaderCircle className="spin" size={13} /> Waiting for your confirmation…
          </span>
        </div>
      ) : null}

      {step === "offer-expired" ? (
        <div className="bridge-token bridge-token--attention">
          <div>
            <TriangleAlert size={15} />
            <span>
              <strong>The pairing offer was closed or expired</strong>
              <small>Nothing was connected. Send a fresh offer whenever you are ready.</small>
            </span>
          </div>
          <button
            className="button button--outline button--small"
            type="button"
            onClick={resetOffer}
          >
            <RefreshCw size={14} />
            Start over
          </button>
        </div>
      ) : null}

      {step === "paired-syncing" ? (
        <div className="bridge-token">
          <div>
            <Check size={15} />
            <span>
              <strong>Paired! First sync is running</strong>
              <small>
                League data is on its way — the connected leagues below fill in automatically.
              </small>
            </span>
          </div>
          <span className="bridge-copy-status" role="status">
            <LoaderCircle className="spin" size={13} /> Syncing from ESPN…
          </span>
        </div>
      ) : null}

      {step === "connected" ? (
        <div className="bridge-token">
          <div>
            <Check size={15} />
            <span>
              <strong>This browser is connected</strong>
              <small>
                {ping?.lastSuccessfulAt
                  ? `Last successful sync ${new Date(ping.lastSuccessfulAt).toLocaleString([], {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}.`
                  : "Pairing is active. Sync details appear in the panels below."}
              </small>
            </span>
          </div>
          <button
            className="button button--outline button--small"
            type="button"
            onClick={() => {
              resetOffer();
              setDiscovery(undefined);
              setSelectedLeagueIds(new Set());
              void runDiscovery();
            }}
            disabled={discovering}
          >
            {discovering ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}
            Add or change leagues
          </button>
        </div>
      ) : null}

      {step === "legacy-form" ? (
        <>
          <ol className="bridge-steps">
            <li>
              <span>1</span>
              <div>
                <strong>Install the Chrome companion</strong>
                <small>Use the Chrome Web Store listing for automatic, signed updates.</small>
              </div>
              <a
                href={chromeWebStoreUrl}
                target="_blank"
                rel="noreferrer"
                aria-label="Install Laces Out ESPN Bridge from the Chrome Web Store"
              >
                <ExternalLink size={17} />
              </a>
            </li>
            <li>
              <span>2</span>
              <div>
                <strong>Sign in directly on ESPN</strong>
                <small>Standard sync keeps ESPN authorization in this browser.</small>
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
          <form className="bridge-pair-form" onSubmit={(event) => void pairBridge(event)}>
            <div className="bridge-form-heading">
              <span>3</span>
              <div>
                <strong>Pair the companion</strong>
                <small>Create scoped access and send it directly to the installed extension.</small>
              </div>
            </div>
            <div className="bridge-fields bridge-fields--three">
              {deviceNameField}
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
            {submitButton("Connect & keep synced")}
            {pairingErrorNote}
          </form>
        </>
      ) : null}

      {step === "self-hosted-code" && selfHostedPairing ? (
        <div className="bridge-token bridge-token--pairing">
          <div>
            <KeyRound size={15} />
            <span>
              <strong>Finish pairing from the Chrome companion</strong>
              <small>
                Open the extension, choose Pair a self-hosted instance, and enter this instance URL
                with the one-time code below.
              </small>
            </span>
          </div>
          <dl className="bridge-pairing-code">
            <div>
              <dt>Instance URL</dt>
              <dd>{absoluteApiOrigin()}</dd>
            </div>
            <div>
              <dt>Pairing code</dt>
              <dd>
                <code>{selfHostedPairing.pairingCode}</code>
              </dd>
            </div>
          </dl>
          <button
            className="button button--outline button--small"
            type="button"
            onClick={() => void copySelfHostedPairingCode()}
          >
            {pairingCodeCopyState === "done" ? <Check size={14} /> : <Clipboard size={14} />}
            {pairingCodeCopyState === "done" ? "Code copied" : "Copy pairing code"}
          </button>
          <span className="bridge-copy-status" role="status">
            {pairingCodeCopyState === "error"
              ? "Clipboard access failed. Select and copy the code manually."
              : `Expires ${new Date(selfHostedPairing.expiresAt).toLocaleTimeString([], {
                  hour: "numeric",
                  minute: "2-digit",
                })}. The code can be used once.`}
          </span>
        </div>
      ) : null}
    </div>
  );
}
