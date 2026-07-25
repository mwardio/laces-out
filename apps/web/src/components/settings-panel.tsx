"use client";

import {
  BellRing,
  CheckCircle2,
  KeyRound,
  LoaderCircle,
  ShieldAlert,
  Trash2,
  UserRound,
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";

import {
  apiBaseUrl,
  parseAuthenticatedSession,
  parseLeagueListResponse,
  parsePushConfiguration,
  parsePushDevice,
  parsePushDeviceList,
  parsePushTestResult,
  type LeagueListResponse,
  type PushConfiguration,
  type PushDeviceStatus,
  type SessionUser,
} from "../lib/api-client";
import styles from "./settings-panel.module.css";

type Status =
  | { readonly state: "idle" }
  | { readonly state: "saving" }
  | { readonly state: "saved"; readonly message: string }
  | { readonly state: "error"; readonly message: string };

const MINIMUM_PASSWORD_LENGTH = 12;

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
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pushConfiguration, setPushConfiguration] = useState<PushConfiguration | null>(null);
  const [pushDevices, setPushDevices] = useState<readonly PushDeviceStatus[]>([]);
  const [pushStatus, setPushStatus] = useState<Status>({ state: "idle" });
  const [pushBusy, setPushBusy] = useState(false);
  const [support, setSupport] = useState<PushSupport>("unsupported");
  const [localDeviceId, setLocalDeviceId] = useState<string | null>(null);

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
      // Re-subscribing keeps the stored keys and the deployment's current VAPID key in step.
      const existing = await registration.pushManager.getSubscription();
      if (existing) await existing.unsubscribe();
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKey(publicKey),
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
          <span>
            Change your own password without an operator, and pick which league the locker room
            opens first.
          </span>
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
                  <strong>Not configured by the operator</strong>
                  <span>
                    Game day alerts need a VAPID key pair on the server. Until the operator sets{" "}
                    <code>VAPID_PUBLIC_KEY</code>, <code>VAPID_PRIVATE_KEY</code>, and{" "}
                    <code>VAPID_SUBJECT</code>, this deployment sends no push notifications and
                    nothing about your devices is stored.
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
                    One push before your first kickoff when a starter is ruled out, is on a bye, or
                    a starting slot is empty. A day ahead, then a final warning two hours out.
                  </p>
                  <div className={styles.alertActions}>
                    <button type="button" onClick={enableAlerts} disabled={pushBusy}>
                      {pushBusy ? (
                        <LoaderCircle className={styles.spin} size={15} aria-hidden="true" />
                      ) : (
                        <BellRing size={15} aria-hidden="true" />
                      )}
                      {alertsEnabledHere ? "Re-register this device" : "Turn on for this device"}
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
        </>
      )}
    </div>
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
