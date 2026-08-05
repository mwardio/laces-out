"use client";

import {
  BellRing,
  CheckCircle2,
  Download,
  KeyRound,
  LoaderCircle,
  ShieldAlert,
  Sparkles,
  Trash2,
  Unlink,
  UserRound,
  UsersRound,
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";

import {
  apiBaseUrl,
  parseAuthenticatedSession,
  parseLeagueDashboard,
  parseLeagueListResponse,
  parseLeagueRemovalResponse,
  parsePushConfiguration,
  parsePushDevice,
  parsePushDeviceList,
  parsePushTestResult,
  type LeagueDashboard,
  type LeagueListResponse,
  type PushConfiguration,
  type PushDeviceStatus,
  type SessionUser,
} from "../lib/api-client";
import { defaultClaimChoice, selectableClaimTeams } from "../lib/team-claim";
import { AiProviderSettings } from "./ai-provider-settings";
import { DataHealthPanel } from "./data-health-panel";
import styles from "./settings-panel.module.css";

type Status =
  | { readonly state: "idle" }
  | { readonly state: "saving" }
  | { readonly state: "saved"; readonly message: string }
  | { readonly state: "error"; readonly message: string };

/** One row's own dashboard read — independent per league, so one league's failure never blanks another's row. */
type TeamRowDashboard =
  | { readonly status: "loading" }
  | { readonly status: "unavailable" }
  | { readonly status: "ready"; readonly dashboard: LeagueDashboard };

const MINIMUM_PASSWORD_LENGTH = 12;
const ACCOUNT_DELETION_PHRASE = "DELETE MY ACCOUNT";

/** Lets this browser recognize its own row in the member's device list without ever seeing an endpoint. */
const LOCAL_PUSH_DEVICE_KEY = "laces-out.push-device-id";

type PushSupport = "ready" | "unsupported";

/**
 * A short, member-readable device name. Never the raw user-agent string: the point is to tell two
 * of your own devices apart, not to fingerprint one.
 */
function deviceLabel(): string {
  if (typeof navigator === "undefined") return "This device";
  const agent = navigator.userAgent;
  const platform = /iPhone/iu.test(agent)
    ? "iPhone"
    : /iPad/iu.test(agent)
      ? "iPad"
      : /Android/iu.test(agent)
        ? "Android"
        : /Macintosh/iu.test(agent)
          ? "Mac"
          : /Windows/iu.test(agent)
            ? "Windows"
            : /Linux/iu.test(agent)
              ? "Linux"
              : "Browser";
  const browser = /Edg\//u.test(agent)
    ? "Edge"
    : /OPR\//u.test(agent)
      ? "Opera"
      : /Firefox\//u.test(agent)
        ? "Firefox"
        : /Chrome\//u.test(agent)
          ? "Chrome"
          : /Safari\//u.test(agent)
            ? "Safari"
            : "Browser";
  return `${browser} on ${platform}`.slice(0, 80);
}

/** VAPID public keys travel as URL-safe base64; `subscribe` wants the raw bytes. */
function applicationServerKey(publicKey: string): ArrayBuffer {
  const padded = publicKey.padEnd(publicKey.length + ((4 - (publicKey.length % 4)) % 4), "=");
  const raw = window.atob(padded.replaceAll("-", "+").replaceAll("_", "/"));
  const buffer = new ArrayBuffer(raw.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return buffer;
}

function sameApplicationServerKey(current: ArrayBuffer | null, expected: ArrayBuffer): boolean {
  if (!current) return false;
  const currentBytes = new Uint8Array(current);
  const expectedBytes = new Uint8Array(expected);
  return (
    currentBytes.length === expectedBytes.length &&
    currentBytes.every((value, index) => value === expectedBytes[index])
  );
}

function pushSupport(): PushSupport {
  if (typeof window === "undefined") return "unsupported";
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window
    ? "ready"
    : "unsupported";
}

function formatDeviceTime(value: string | null, emptyLabel: string): string {
  if (!value) return emptyLabel;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return emptyLabel;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    date,
  );
}

function membershipRoleLabel(
  role: LeagueListResponse["leagues"][number]["membership"]["role"],
): string {
  const labels: Record<typeof role, string> = {
    owner: "Owner",
    commissioner: "Commissioner",
    manager: "Manager",
    viewer: "Viewer",
  };
  return labels[role];
}

async function problemDetail(response: Response, fallback: string): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (body && typeof body === "object" && "title" in body) {
      const { title } = body as { title?: unknown };
      if (typeof title === "string" && title.length > 0) return title;
    }
  } catch {
    // A non-JSON error body is not worth surfacing verbatim.
  }
  return fallback;
}

export function SettingsPanel() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [leagues, setLeagues] = useState<LeagueListResponse["leagues"]>([]);
  const [defaultLeagueId, setDefaultLeagueId] = useState("");
  const [loading, setLoading] = useState(true);
  const [preferenceStatus, setPreferenceStatus] = useState<Status>({ state: "idle" });
  const [passwordStatus, setPasswordStatus] = useState<Status>({ state: "idle" });
  const [exportStatus, setExportStatus] = useState<Status>({ state: "idle" });
  const [deletionStatus, setDeletionStatus] = useState<Status>({ state: "idle" });
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [deletionPassword, setDeletionPassword] = useState("");
  const [deletionConfirmation, setDeletionConfirmation] = useState("");
  const [pushConfiguration, setPushConfiguration] = useState<PushConfiguration | null>(null);
  const [pushDevices, setPushDevices] = useState<readonly PushDeviceStatus[]>([]);
  const [pushStatus, setPushStatus] = useState<Status>({ state: "idle" });
  const [pushBusy, setPushBusy] = useState(false);
  const [support, setSupport] = useState<PushSupport>("unsupported");
  const [localDeviceId, setLocalDeviceId] = useState<string | null>(null);
  const [teamRows, setTeamRows] = useState<Record<string, TeamRowDashboard>>({});
  const [teamChoices, setTeamChoices] = useState<Record<string, string>>({});
  const [teamSaves, setTeamSaves] = useState<Record<string, Status>>({});
  const [removalTargetId, setRemovalTargetId] = useState<string | null>(null);
  const [removalStatus, setRemovalStatus] = useState<Status>({ state: "idle" });

  /**
   * One league's own dashboard read, kept independent per row: a league whose dashboard fails to
   * load only blanks that row's select (see the "Team identity unavailable" fallback below), never
   * the whole panel. Reused both for the initial per-league load and to refresh a row after a save.
   */
  const loadTeamRow = useCallback(async (leagueId: string) => {
    setTeamRows((current) => ({ ...current, [leagueId]: { status: "loading" } }));
    try {
      const response = await fetch(
        `${apiBaseUrl}/v1/leagues/${encodeURIComponent(leagueId)}/dashboard`,
        {
          credentials: "include",
          cache: "no-store",
          headers: { Accept: "application/json" },
        },
      );
      if (!response.ok) {
        setTeamRows((current) => ({ ...current, [leagueId]: { status: "unavailable" } }));
        return;
      }
      const parsed = parseLeagueDashboard(await response.json());
      if (!parsed) {
        setTeamRows((current) => ({ ...current, [leagueId]: { status: "unavailable" } }));
        return;
      }
      setTeamRows((current) => ({
        ...current,
        [leagueId]: { status: "ready", dashboard: parsed },
      }));
      setTeamChoices((current) => ({ ...current, [leagueId]: defaultClaimChoice(parsed) }));
    } catch {
      setTeamRows((current) => ({ ...current, [leagueId]: { status: "unavailable" } }));
    }
  }, []);

  async function saveTeamRow(leagueId: string) {
    const choice = teamChoices[leagueId];
    if (!choice) return;
    setTeamSaves((current) => ({ ...current, [leagueId]: { state: "saving" } }));
    try {
      const response = await fetch(
        `${apiBaseUrl}/v1/leagues/${encodeURIComponent(leagueId)}/team-claim`,
        {
          method: "POST",
          credentials: "include",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({ teamId: choice }),
        },
      );
      if (!response.ok) {
        // Mirrors `claimTeam()` in dashboard-experience.tsx: this endpoint's errors carry a
        // problem-detail `detail` field, not the `title` field `problemDetail()` above reads for
        // the rest of this page's endpoints.
        const problem = (await response.json().catch(() => null)) as { detail?: unknown } | null;
        throw new Error(
          typeof problem?.detail === "string" ? problem.detail : "That team could not be saved.",
        );
      }
      setTeamSaves((current) => ({
        ...current,
        [leagueId]: { state: "saved", message: "Team claim saved." },
      }));
      await loadTeamRow(leagueId);
    } catch (error) {
      setTeamSaves((current) => ({
        ...current,
        [leagueId]: {
          state: "error",
          message: error instanceof Error ? error.message : "That team could not be saved.",
        },
      }));
    }
  }

  async function removeLeague(leagueId: string) {
    const league = leagues.find((candidate) => candidate.id === leagueId);
    if (!league || removalStatus.state === "saving") return;
    setRemovalStatus({ state: "saving" });
    try {
      const response = await fetch(
        `${apiBaseUrl}/v1/leagues/${encodeURIComponent(league.id)}/membership`,
        {
          method: "DELETE",
          credentials: "include",
          cache: "no-store",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({ confirmation: league.name }),
        },
      );
      if (!response.ok) {
        throw new Error(await problemDetail(response, "That league could not be removed."));
      }
      const removed = parseLeagueRemovalResponse(await response.json());
      if (!removed) throw new Error("League removal returned an invalid response.");

      setLeagues((current) => current.filter((candidate) => candidate.id !== league.id));
      if (defaultLeagueId === league.id) setDefaultLeagueId("");
      setTeamRows((current) => {
        const next = { ...current };
        delete next[league.id];
        return next;
      });
      setTeamChoices((current) => {
        const next = { ...current };
        delete next[league.id];
        return next;
      });
      setRemovalTargetId(null);
      setRemovalStatus({
        state: "saved",
        message: removed.leagueDeleted
          ? `${removed.leagueName} was removed and its unshared data was deleted.`
          : removed.ownershipTransferred
            ? `${removed.leagueName} was removed. Another member now owns the shared league.`
            : `${removed.leagueName} was removed from your account.`,
      });
    } catch (error) {
      setRemovalStatus({
        state: "error",
        message: error instanceof Error ? error.message : "That league could not be removed.",
      });
    }
  }

  const loadPushDevices = useCallback(async () => {
    const devices = await fetch(`${apiBaseUrl}/v1/push/subscriptions`, {
      credentials: "include",
      cache: "no-store",
      headers: { Accept: "application/json" },
    })
      .then(async (response) => (response.ok ? parsePushDeviceList(await response.json()) : null))
      .catch(() => null);
    setPushDevices(devices ?? []);
    return devices ?? [];
  }, []);

  const loadAll = useCallback(async () => {
    setLoading(true);
    const [session, leagueList, preferences, configuration] = await Promise.all([
      fetch(`${apiBaseUrl}/v1/auth/session`, {
        credentials: "include",
        cache: "no-store",
        headers: { Accept: "application/json" },
      })
        .then(async (response) =>
          response.ok ? parseAuthenticatedSession(await response.json()) : null,
        )
        .catch(() => null),
      fetch(`${apiBaseUrl}/v1/leagues`, {
        credentials: "include",
        cache: "no-store",
        headers: { Accept: "application/json" },
      })
        .then(async (response) =>
          response.ok ? parseLeagueListResponse(await response.json()) : null,
        )
        .catch(() => null),
      fetch(`${apiBaseUrl}/v1/preferences`, {
        credentials: "include",
        cache: "no-store",
        headers: { Accept: "application/json" },
      })
        .then(async (response) => (response.ok ? ((await response.json()) as unknown) : null))
        .catch(() => null),
      fetch(`${apiBaseUrl}/v1/push/config`, {
        credentials: "include",
        cache: "no-store",
        headers: { Accept: "application/json" },
      })
        .then(async (response) =>
          response.ok ? parsePushConfiguration(await response.json()) : null,
        )
        .catch(() => null),
    ]);
    setUser(session?.user ?? null);
    setLeagues(leagueList?.leagues ?? []);
    setPushConfiguration(configuration ?? { available: false, publicKey: null });
    if (
      preferences &&
      typeof preferences === "object" &&
      "defaultLeagueId" in preferences &&
      typeof (preferences as { defaultLeagueId?: unknown }).defaultLeagueId === "string"
    ) {
      setDefaultLeagueId((preferences as { defaultLeagueId: string }).defaultLeagueId);
    }
    if (configuration?.available && session?.user) await loadPushDevices();
    setLoading(false);
  }, [loadPushDevices]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    setSupport(pushSupport());
    setLocalDeviceId(window.localStorage.getItem(LOCAL_PUSH_DEVICE_KEY));
  }, []);

  // Members have few leagues (typically ≤3), so every row's dashboard loads up front on mount
  // rather than lazily per row. Runs once `leagues` (loaded by `loadAll`, session-gated by the API)
  // is populated; a signed-out visitor never reaches this panel at all (see the render guard below).
  useEffect(() => {
    if (!user || leagues.length === 0) return;
    for (const league of leagues) void loadTeamRow(league.id);
  }, [user, leagues, loadTeamRow]);

  async function savePreferences(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPreferenceStatus({ state: "saving" });
    try {
      const response = await fetch(`${apiBaseUrl}/v1/preferences`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ defaultLeagueId: defaultLeagueId || null }),
      });
      if (!response.ok) {
        throw new Error(await problemDetail(response, "Your preferences could not be saved."));
      }
      setPreferenceStatus({
        state: "saved",
        message: defaultLeagueId
          ? "Overview and Decision Desk will open this league first."
          : "No default league. Both surfaces fall back to your first league.",
      });
    } catch (error) {
      setPreferenceStatus({
        state: "error",
        message: error instanceof Error ? error.message : "Your preferences could not be saved.",
      });
    }
  }

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (newPassword !== confirmPassword) {
      setPasswordStatus({ state: "error", message: "The new passwords do not match." });
      return;
    }
    if (newPassword.length < MINIMUM_PASSWORD_LENGTH) {
      setPasswordStatus({
        state: "error",
        message: `Use at least ${MINIMUM_PASSWORD_LENGTH} characters.`,
      });
      return;
    }
    if (newPassword === currentPassword) {
      setPasswordStatus({
        state: "error",
        message: "The new password must differ from the current one.",
      });
      return;
    }
    setPasswordStatus({ state: "saving" });
    try {
      const response = await fetch(`${apiBaseUrl}/v1/auth/password`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      if (!response.ok) {
        throw new Error(await problemDetail(response, "Your password could not be changed."));
      }
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setPasswordStatus({
        state: "saved",
        message: "Password changed. Your other devices were signed out; this one stays signed in.",
      });
    } catch (error) {
      setPasswordStatus({
        state: "error",
        message: error instanceof Error ? error.message : "Your password could not be changed.",
      });
    }
  }

  async function downloadAccountData() {
    setExportStatus({ state: "saving" });
    try {
      const response = await fetch(`${apiBaseUrl}/v1/account/export`, {
        credentials: "include",
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) {
        throw new Error(await problemDetail(response, "Your data export could not be prepared."));
      }
      const blobUrl = window.URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = blobUrl;
      link.download = `laces-out-account-export-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => window.URL.revokeObjectURL(blobUrl), 0);
      setExportStatus({ state: "saved", message: "Your JSON export was downloaded." });
    } catch (error) {
      setExportStatus({
        state: "error",
        message: error instanceof Error ? error.message : "Your data export could not be prepared.",
      });
    }
  }

  async function deleteAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (deletionConfirmation !== ACCOUNT_DELETION_PHRASE) {
      setDeletionStatus({
        state: "error",
        message: `Type ${ACCOUNT_DELETION_PHRASE} exactly to confirm.`,
      });
      return;
    }
    setDeletionStatus({ state: "saving" });
    try {
      const response = await fetch(`${apiBaseUrl}/v1/account`, {
        method: "DELETE",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          currentPassword: deletionPassword,
          confirmation: deletionConfirmation,
        }),
      });
      if (!response.ok) {
        throw new Error(await problemDetail(response, "Your account could not be deleted."));
      }
      window.localStorage.removeItem(LOCAL_PUSH_DEVICE_KEY);
      window.location.replace("/account-deleted");
    } catch (error) {
      setDeletionStatus({
        state: "error",
        message: error instanceof Error ? error.message : "Your account could not be deleted.",
      });
    }
  }

  /**
   * The only place the app asks for notification permission. It runs from this click and never on
   * page load, so a member who never opens this section is never prompted.
   */
  async function enableAlerts() {
    const publicKey = pushConfiguration?.publicKey;
    if (!publicKey) return;
    setPushBusy(true);
    setPushStatus({ state: "saving" });
    try {
      if (support !== "ready") throw new Error("This browser cannot receive web push.");
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        throw new Error(
          permission === "denied"
            ? "Notifications are blocked for this site in your browser settings."
            : "Notification permission was dismissed.",
        );
      }
      const registration = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      const expectedKey = applicationServerKey(publicKey);
      let subscription = await registration.pushManager.getSubscription();
      if (
        subscription &&
        !sameApplicationServerKey(subscription.options.applicationServerKey, expectedKey)
      ) {
        await subscription.unsubscribe();
        subscription = null;
      }
      subscription ??= await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: expectedKey,
      });
      const payload = subscription.toJSON();
      const response = await fetch(`${apiBaseUrl}/v1/push/subscriptions`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          endpoint: subscription.endpoint,
          keys: { p256dh: payload.keys?.p256dh ?? "", auth: payload.keys?.auth ?? "" },
          label: deviceLabel(),
        }),
      });
      if (!response.ok) {
        throw new Error(await problemDetail(response, "This device could not be registered."));
      }
      const identifier = parsePushDevice(await response.json())?.subscriptionId ?? null;
      if (identifier) {
        window.localStorage.setItem(LOCAL_PUSH_DEVICE_KEY, identifier);
        setLocalDeviceId(identifier);
      }
      await loadPushDevices();
      setPushStatus({
        state: "saved",
        message: "Game day alerts are on for this device.",
      });
    } catch (error) {
      setPushStatus({
        state: "error",
        message: error instanceof Error ? error.message : "This device could not be registered.",
      });
    } finally {
      setPushBusy(false);
    }
  }

  async function revokeDevice(subscriptionId: string) {
    setPushBusy(true);
    setPushStatus({ state: "saving" });
    try {
      const response = await fetch(`${apiBaseUrl}/v1/push/subscriptions/${subscriptionId}`, {
        method: "DELETE",
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (!response.ok && response.status !== 404) {
        throw new Error(await problemDetail(response, "That device could not be removed."));
      }
      if (subscriptionId === localDeviceId) {
        window.localStorage.removeItem(LOCAL_PUSH_DEVICE_KEY);
        setLocalDeviceId(null);
        if (support === "ready") {
          const registration = await navigator.serviceWorker.getRegistration();
          const subscription = await registration?.pushManager.getSubscription();
          await subscription?.unsubscribe();
        }
      }
      await loadPushDevices();
      setPushStatus({ state: "saved", message: "That device will no longer receive alerts." });
    } catch (error) {
      setPushStatus({
        state: "error",
        message: error instanceof Error ? error.message : "That device could not be removed.",
      });
    } finally {
      setPushBusy(false);
    }
  }

  async function sendTestAlert() {
    setPushBusy(true);
    setPushStatus({ state: "saving" });
    try {
      const response = await fetch(`${apiBaseUrl}/v1/push/test`, {
        method: "POST",
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) {
        throw new Error(await problemDetail(response, "The test alert could not be sent."));
      }
      const delivered = parsePushTestResult(await response.json())?.delivered ?? 0;
      await loadPushDevices();
      setPushStatus({
        state: "saved",
        message:
          delivered > 0
            ? `Test alert sent to ${delivered} device${delivered === 1 ? "" : "s"}.`
            : "No device accepted the test alert. Turn alerts on again on this device.",
      });
    } catch (error) {
      setPushStatus({
        state: "error",
        message: error instanceof Error ? error.message : "The test alert could not be sent.",
      });
    } finally {
      setPushBusy(false);
    }
  }

  const alertsEnabledHere =
    localDeviceId !== null && pushDevices.some((device) => device.subscriptionId === localDeviceId);

  return (
    <div className={styles.page}>
      <header className={styles.hero}>
        <div>
          <p>Your account</p>
          <h1>Settings</h1>
        </div>
        <UserRound size={34} strokeWidth={1.5} aria-hidden="true" />
      </header>

      {loading ? (
        <div className={styles.stateCard} role="status">
          <LoaderCircle className={styles.spin} size={20} aria-hidden="true" />
          <div>
            <strong>Loading your account</strong>
            <span>Reading your session, leagues, and stored preferences.</span>
          </div>
        </div>
      ) : !user ? (
        <div className={styles.stateCard} role="alert">
          <ShieldAlert size={20} aria-hidden="true" />
          <div>
            <strong>Sign in to manage your account</strong>
            <span>Settings are only available to a signed-in member.</span>
          </div>
        </div>
      ) : (
        <>
          <section className={styles.panel} aria-labelledby="identity-title">
            <div className={styles.panelHeading}>
              <div>
                <p>Identity</p>
                <h2 id="identity-title">Who you are here</h2>
              </div>
            </div>
            <dl className={styles.identity}>
              <div>
                <dt>Display name</dt>
                <dd>{user.displayName}</dd>
              </div>
              <div>
                <dt>Email</dt>
                <dd>{user.email}</dd>
              </div>
              <div>
                <dt>Role</dt>
                <dd>{user.role}</dd>
              </div>
            </dl>
            <p className={styles.note}>
              Your name and email identify this account. Ask an admin if either needs to change.
            </p>
          </section>

          <section className={styles.panel} aria-labelledby="password-title">
            <div className={styles.panelHeading}>
              <div>
                <p>Security</p>
                <h2 id="password-title">Change password</h2>
              </div>
              <KeyRound size={18} aria-hidden="true" />
            </div>
            <form className={styles.form} onSubmit={changePassword}>
              <label>
                <span>Current password</span>
                <input
                  type="password"
                  autoComplete="current-password"
                  required
                  maxLength={128}
                  value={currentPassword}
                  onChange={(event) => setCurrentPassword(event.target.value)}
                />
              </label>
              <label>
                <span>New password</span>
                <input
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={MINIMUM_PASSWORD_LENGTH}
                  maxLength={128}
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                />
              </label>
              <label>
                <span>Confirm new password</span>
                <input
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={MINIMUM_PASSWORD_LENGTH}
                  maxLength={128}
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                />
              </label>
              <button type="submit" disabled={passwordStatus.state === "saving"}>
                {passwordStatus.state === "saving" ? (
                  <LoaderCircle className={styles.spin} size={15} aria-hidden="true" />
                ) : (
                  <KeyRound size={15} aria-hidden="true" />
                )}
                Change password
              </button>
            </form>
            <p className={styles.note}>
              At least {MINIMUM_PASSWORD_LENGTH} characters. Changing it signs out your other
              devices and leaves this one signed in.
            </p>
            <StatusLine status={passwordStatus} />
          </section>

          <section className={styles.panel} aria-labelledby="default-league-title">
            <div className={styles.panelHeading}>
              <div>
                <p>Preferences</p>
                <h2 id="default-league-title">Default league</h2>
              </div>
            </div>
            {leagues.length === 0 ? (
              <p className={styles.note}>
                Connect a league first and it will appear here as a choice.
              </p>
            ) : (
              <form className={styles.form} onSubmit={savePreferences}>
                <label>
                  <span>Open first</span>
                  <select
                    value={defaultLeagueId}
                    onChange={(event) => setDefaultLeagueId(event.target.value)}
                  >
                    <option value="">No default (use my first league)</option>
                    {leagues.map((league) => (
                      <option value={league.id} key={league.id}>
                        {league.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button type="submit" disabled={preferenceStatus.state === "saving"}>
                  {preferenceStatus.state === "saving" ? (
                    <LoaderCircle className={styles.spin} size={15} aria-hidden="true" />
                  ) : (
                    <CheckCircle2 size={15} aria-hidden="true" />
                  )}
                  Save
                </button>
              </form>
            )}
            <StatusLine status={preferenceStatus} />
          </section>

          <section className={styles.panel} aria-labelledby="teams-title">
            <div className={styles.panelHeading}>
              <div>
                <p>Leagues</p>
                <h2 id="teams-title">Your teams</h2>
              </div>
              <UsersRound size={18} aria-hidden="true" />
            </div>
            {leagues.length === 0 ? (
              <p className={styles.note}>
                Connect a league first and it will appear here to claim a team.
              </p>
            ) : (
              <>
                <p className={styles.panelIntro}>
                  Which team is yours in each league. Powers roster-aware analysis.
                </p>
                <ul className={styles.teamList}>
                  {leagues.map((league) => (
                    <TeamRow
                      key={league.id}
                      leagueName={league.name}
                      row={teamRows[league.id] ?? { status: "loading" }}
                      choice={teamChoices[league.id] ?? ""}
                      save={teamSaves[league.id] ?? { state: "idle" }}
                      onChoiceChange={(teamId) =>
                        setTeamChoices((current) => ({ ...current, [league.id]: teamId }))
                      }
                      onSave={() => void saveTeamRow(league.id)}
                    />
                  ))}
                </ul>
              </>
            )}
          </section>

          <section className={styles.panel} aria-labelledby="synced-leagues-title">
            <div className={styles.panelHeading}>
              <div>
                <p>League access</p>
                <h2 id="synced-leagues-title">Synced leagues</h2>
              </div>
              <Unlink size={18} aria-hidden="true" />
            </div>
            {leagues.length === 0 ? (
              <p className={styles.note}>No synced leagues are attached to this account.</p>
            ) : (
              <>
                <p className={styles.panelIntro}>
                  Remove a league you no longer want Laces Out to track for you.
                </p>
                <ul className={styles.leagueAccessList}>
                  {leagues.map((league) => {
                    const confirming = removalTargetId === league.id;
                    const provider = league.season?.provider;
                    return (
                      <li key={league.id}>
                        <div className={styles.leagueAccessSummary}>
                          <div>
                            <strong>{league.name}</strong>
                            <span>
                              {provider === "espn"
                                ? "ESPN"
                                : provider === "yahoo"
                                  ? "Yahoo"
                                  : "Manual"}
                              {league.season ? ` · ${league.season.season}` : ""} ·{" "}
                              {membershipRoleLabel(league.membership.role)}
                            </span>
                          </div>
                          <button
                            type="button"
                            onClick={() => {
                              setRemovalTargetId(confirming ? null : league.id);
                              setRemovalStatus({ state: "idle" });
                            }}
                            disabled={removalStatus.state === "saving"}
                            aria-expanded={confirming}
                            aria-controls={`remove-league-${league.id}`}
                          >
                            <Trash2 size={14} aria-hidden="true" />
                            Remove
                          </button>
                        </div>
                        {confirming ? (
                          <div
                            className={styles.leagueRemovalConfirmation}
                            id={`remove-league-${league.id}`}
                            role="alertdialog"
                            aria-modal="false"
                            aria-labelledby={`remove-league-title-${league.id}`}
                          >
                            <strong id={`remove-league-title-${league.id}`}>
                              Remove {league.name}?
                            </strong>
                            <p>
                              Syncing stops for your account. Other members keep their access. If
                              you are the only member, the stored league is deleted; otherwise,
                              ownership transfers automatically when needed.
                            </p>
                            <div className={styles.leagueRemovalActions}>
                              <button
                                type="button"
                                onClick={() => {
                                  setRemovalTargetId(null);
                                  setRemovalStatus({ state: "idle" });
                                }}
                                disabled={removalStatus.state === "saving"}
                              >
                                Keep league
                              </button>
                              <button
                                className={styles.leagueRemovalButton}
                                type="button"
                                onClick={() => void removeLeague(league.id)}
                                disabled={removalStatus.state === "saving"}
                              >
                                {removalStatus.state === "saving" ? (
                                  <LoaderCircle
                                    className={styles.spin}
                                    size={14}
                                    aria-hidden="true"
                                  />
                                ) : (
                                  <Trash2 size={14} aria-hidden="true" />
                                )}
                                Remove league
                              </button>
                            </div>
                          </div>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
            <StatusLine status={removalStatus} />
          </section>

          <section className={styles.panel} aria-labelledby="ai-provider-title">
            <div className={styles.panelHeading}>
              <div>
                <p>AI</p>
                <h2 id="ai-provider-title">AI provider (BYOK)</h2>
              </div>
              <Sparkles size={18} aria-hidden="true" />
            </div>
            <AiProviderSettings />
          </section>

          <section className={styles.panel} aria-labelledby="alerts-title">
            <div className={styles.panelHeading}>
              <div>
                <p>Notifications</p>
                <h2 id="alerts-title">Game day alerts</h2>
              </div>
              <BellRing size={18} aria-hidden="true" />
            </div>

            {!pushConfiguration?.available ? (
              <div className={styles.disabledNotice} role="note">
                <ShieldAlert size={16} aria-hidden="true" />
                <div>
                  <strong>Game day alerts are coming soon</strong>
                  <span>
                    This Laces Out instance is not sending browser notifications yet. No device
                    information is stored until alerts are available.
                  </span>
                </div>
              </div>
            ) : support !== "ready" ? (
              <div className={styles.disabledNotice} role="note">
                <ShieldAlert size={16} aria-hidden="true" />
                <div>
                  <strong>This browser cannot receive alerts</strong>
                  <span>
                    Web push is unavailable here. On iPhone and iPad, add Laces Out to your Home
                    Screen first — iOS only delivers web push to an installed app.
                  </span>
                </div>
              </div>
            ) : (
              <>
                <div className={styles.form}>
                  <p className={styles.alertLead}>
                    A heads-up before your first kickoff when a starter is ruled out, is on a bye,
                    or a starting slot is empty. One alert a day ahead, then a final warning two
                    hours out.
                  </p>
                  <div className={styles.alertActions}>
                    <button type="button" onClick={enableAlerts} disabled={pushBusy}>
                      {pushBusy ? (
                        <LoaderCircle className={styles.spin} size={15} aria-hidden="true" />
                      ) : (
                        <BellRing size={15} aria-hidden="true" />
                      )}
                      {alertsEnabledHere ? "Refresh this device" : "Turn on for this device"}
                    </button>
                    {alertsEnabledHere ? (
                      <button
                        className={styles.secondaryButton}
                        type="button"
                        onClick={sendTestAlert}
                        disabled={pushBusy}
                      >
                        Send test
                      </button>
                    ) : null}
                  </div>
                </div>

                {pushDevices.length === 0 ? (
                  <p className={styles.note}>
                    No device is registered yet. Turn alerts on from each device you want notified.
                  </p>
                ) : (
                  <ul className={styles.deviceList}>
                    {pushDevices.map((device) => (
                      <li key={device.subscriptionId}>
                        <div>
                          <strong>
                            {device.label ?? "Unnamed device"}
                            {device.subscriptionId === localDeviceId ? (
                              <span className={styles.deviceTag}>This device</span>
                            ) : null}
                          </strong>
                          <span>
                            Registered {formatDeviceTime(device.createdAt, "recently")} · Last alert{" "}
                            {formatDeviceTime(device.lastSuccessAt, "never")}
                            {device.lastFailureAt ? " · Last send failed" : ""}
                          </span>
                        </div>
                        <button
                          type="button"
                          aria-label={`Remove ${device.label ?? "this device"}`}
                          onClick={() => void revokeDevice(device.subscriptionId)}
                          disabled={pushBusy}
                        >
                          <Trash2 size={14} aria-hidden="true" />
                          Remove
                        </button>
                      </li>
                    ))}
                  </ul>
                )}

                <p className={styles.note}>
                  Alerts are built from the last roster Laces Out synced for you, not a live read of
                  your league — every alert says how old that roster is. A bye is only claimed where
                  the admitted NFL schedule covers both the team and the week. On iPhone and iPad,
                  add Laces Out to your Home Screen; iOS only delivers web push to an installed app.
                </p>
              </>
            )}
            <StatusLine status={pushStatus} />
          </section>

          <section className={styles.panel} id="account-data" aria-labelledby="account-data-title">
            <div className={styles.panelHeading}>
              <div>
                <p>Your data</p>
                <h2 id="account-data-title">Export account data</h2>
              </div>
              <Download size={18} aria-hidden="true" />
            </div>
            <div className={styles.dataAction}>
              <p>
                Download a portable JSON copy of your identity, preferences, memberships, private
                rankings and projections, activity, notification history, connection metadata, and
                Film Room usage. Password hashes, tokens, push endpoints, and encrypted credentials
                are never included.
              </p>
              <button
                type="button"
                onClick={() => void downloadAccountData()}
                disabled={exportStatus.state === "saving"}
              >
                {exportStatus.state === "saving" ? (
                  <LoaderCircle className={styles.spin} size={15} aria-hidden="true" />
                ) : (
                  <Download size={15} aria-hidden="true" />
                )}
                Download my data
              </button>
            </div>
            <StatusLine status={exportStatus} />
          </section>

          <section
            className={`${styles.panel} ${styles.dangerPanel}`}
            aria-labelledby="delete-account-title"
          >
            <div className={styles.panelHeading}>
              <div>
                <p>Danger zone</p>
                <h2 id="delete-account-title">Delete account</h2>
              </div>
              <Trash2 size={18} aria-hidden="true" />
            </div>
            <div className={styles.deletionExplanation} id="delete-account-explanation">
              <p>This permanently:</p>
              <ul>
                <li>
                  revokes every session, provider connection, API key, and notification device;
                </li>
                <li>
                  deletes your preferences, private rankings, imports, shares, and memberships;
                </li>
                <li>
                  transfers leagues with other members to another surviving member, preferring a
                  commissioner and then a manager;
                </li>
                <li>
                  deletes leagues where you are the only member and removes League Intel or recap
                  text you created, while deterministic shared league facts stay available without
                  your account attribution.
                </li>
              </ul>
              <p>
                The live account cannot be recovered. Deleted records may remain in encrypted
                backups until this deployment&apos;s backup rotation completes.
              </p>
            </div>
            <form
              className={styles.form}
              onSubmit={deleteAccount}
              aria-describedby="delete-account-explanation"
            >
              <label>
                <span>Current password</span>
                <input
                  type="password"
                  autoComplete="current-password"
                  required
                  maxLength={128}
                  value={deletionPassword}
                  onChange={(event) => setDeletionPassword(event.target.value)}
                />
              </label>
              <label>
                <span>
                  Type <strong>{ACCOUNT_DELETION_PHRASE}</strong>
                </span>
                <input
                  type="text"
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  required
                  value={deletionConfirmation}
                  onChange={(event) => setDeletionConfirmation(event.target.value)}
                />
              </label>
              <button
                className={styles.dangerButton}
                type="submit"
                disabled={
                  deletionStatus.state === "saving" ||
                  deletionConfirmation !== ACCOUNT_DELETION_PHRASE
                }
              >
                {deletionStatus.state === "saving" ? (
                  <LoaderCircle className={styles.spin} size={15} aria-hidden="true" />
                ) : (
                  <Trash2 size={15} aria-hidden="true" />
                )}
                Permanently delete my account
              </button>
            </form>
            <StatusLine status={deletionStatus} />
          </section>

          {/* Last, and collapsed. Source health is reference material, not something a member is
              being asked to act on, so it sits below everything else rather than competing for
              attention on the overview or League Sync pages. */}
          <DataHealthPanel />
        </>
      )}
    </div>
  );
}

interface TeamRowProps {
  readonly leagueName: string;
  readonly row: TeamRowDashboard;
  readonly choice: string;
  readonly save: Status;
  readonly onChoiceChange: (teamId: string) => void;
  readonly onSave: () => void;
}

function TeamRow({ leagueName, row, choice, save, onChoiceChange, onSave }: TeamRowProps) {
  if (row.status === "loading") {
    return (
      <li className={styles.teamRow}>
        <span className={styles.teamRowName}>{leagueName}</span>
        <span className={styles.teamRowNote}>
          <LoaderCircle className={styles.spin} size={13} aria-hidden="true" />
          Loading…
        </span>
      </li>
    );
  }

  if (row.status === "unavailable" || row.dashboard.teamClaim.mode === "unavailable") {
    return (
      <li className={styles.teamRow}>
        <span className={styles.teamRowName}>{leagueName}</span>
        <span className={styles.teamRowNote}>Team identity unavailable</span>
      </li>
    );
  }

  const { dashboard } = row;
  const teams = selectableClaimTeams(dashboard);
  if (teams.length === 0) {
    return (
      <li className={styles.teamRow}>
        <span className={styles.teamRowName}>{leagueName}</span>
        <span className={styles.teamRowNote}>No selectable team</span>
      </li>
    );
  }

  const claimedTeamId = dashboard.membership.claimedFantasyTeamId;
  const buttonLabel =
    claimedTeamId === null && dashboard.teamClaim.mode === "provider-mapped"
      ? "Confirm team"
      : "Save";

  return (
    <li className={styles.teamRow}>
      <span className={styles.teamRowName}>{leagueName}</span>
      <div className={styles.teamRowControls}>
        <label className="sr-only" htmlFor={`settings-team-claim-${dashboard.league.id}`}>
          Fantasy team for {leagueName}
        </label>
        <select
          id={`settings-team-claim-${dashboard.league.id}`}
          value={choice}
          onChange={(event) => onChoiceChange(event.target.value)}
        >
          {teams.map((team) => (
            <option value={team.id} key={team.id}>
              {team.name}
              {team.managerDisplayName ? ` · ${team.managerDisplayName}` : ""}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={!choice || save.state === "saving" || choice === claimedTeamId}
          onClick={onSave}
        >
          {save.state === "saving" ? (
            <LoaderCircle className={styles.spin} size={14} aria-hidden="true" />
          ) : (
            <CheckCircle2 size={14} aria-hidden="true" />
          )}
          {buttonLabel}
        </button>
      </div>
      <StatusLine status={save} />
    </li>
  );
}

function StatusLine({ status }: { readonly status: Status }) {
  if (status.state !== "saved" && status.state !== "error") return null;
  const isError = status.state === "error";
  return (
    <p
      className={isError ? styles.errorLine : styles.savedLine}
      role={isError ? "alert" : "status"}
    >
      {isError ? (
        <ShieldAlert size={15} aria-hidden="true" />
      ) : (
        <CheckCircle2 size={15} aria-hidden="true" />
      )}
      {status.message}
    </p>
  );
}
