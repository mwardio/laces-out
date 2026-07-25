"use client";

import { CheckCircle2, KeyRound, LoaderCircle, ShieldAlert, UserRound } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";

import {
  apiBaseUrl,
  parseAuthenticatedSession,
  parseLeagueListResponse,
  type LeagueListResponse,
  type SessionUser,
} from "../lib/api-client";
import styles from "./settings-panel.module.css";

type Status =
  | { readonly state: "idle" }
  | { readonly state: "saving" }
  | { readonly state: "saved"; readonly message: string }
  | { readonly state: "error"; readonly message: string };

const MINIMUM_PASSWORD_LENGTH = 12;

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

  const loadAll = useCallback(async () => {
    setLoading(true);
    const [session, leagueList, preferences] = await Promise.all([
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
    ]);
    setUser(session?.user ?? null);
    setLeagues(leagueList?.leagues ?? []);
    if (
      preferences &&
      typeof preferences === "object" &&
      "defaultLeagueId" in preferences &&
      typeof (preferences as { defaultLeagueId?: unknown }).defaultLeagueId === "string"
    ) {
      setDefaultLeagueId((preferences as { defaultLeagueId: string }).defaultLeagueId);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

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
              Your name and email are set by whoever invited you. Ask an admin to change either.
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
