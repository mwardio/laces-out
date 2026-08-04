"use client";

import {
  AlertCircle,
  Check,
  Clipboard,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  ShieldCheck,
  Trash2,
  UserPlus,
  UsersRound,
} from "lucide-react";
import Link from "next/link";
import { type FormEvent, useEffect, useState } from "react";

import { apiBaseUrl, parseAuthenticatedSession } from "../lib/api-client";

interface LeagueOption {
  readonly id: string;
  readonly name: string;
}

interface CreatedInvitation {
  readonly id: string;
  readonly invitationUrl: string;
  readonly email: string;
  readonly role: "member" | "admin";
  readonly scope: {
    readonly leagueId: string;
    readonly leagueRole: "commissioner" | "manager" | "viewer";
  } | null;
  readonly expiresAt: string;
}

export function MemberInvitations() {
  const [access, setAccess] = useState<"checking" | "admin" | "denied">("checking");
  const [leagues, setLeagues] = useState<readonly LeagueOption[]>([]);
  const [leaguesState, setLeaguesState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const [leagueId, setLeagueId] = useState("");
  const [leagueRole, setLeagueRole] = useState<"commissioner" | "manager" | "viewer">("manager");
  const [expiresInDays, setExpiresInDays] = useState("7");
  const [created, setCreated] = useState<CreatedInvitation | null>(null);
  const [state, setState] = useState<"idle" | "working" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [revokeArmed, setRevokeArmed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`${apiBaseUrl}/v1/auth/session`, {
      credentials: "include",
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) =>
        response.ok ? parseAuthenticatedSession(await response.json()) : null,
      )
      .then((session) => setAccess(session?.user.role === "admin" ? "admin" : "denied"))
      .catch(() => {
        if (!controller.signal.aborted) setAccess("denied");
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (access !== "admin") return;
    const controller = new AbortController();
    setLeaguesState("loading");
    void fetch(`${apiBaseUrl}/v1/leagues`, {
      credentials: "include",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("League access could not be loaded");
        return (await response.json()) as { leagues?: readonly LeagueOption[] };
      })
      .then((result) => {
        setLeagues(result.leagues ?? []);
        setLeaguesState("ready");
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setLeagues([]);
          setLeaguesState("error");
        }
      });
    return () => controller.abort();
  }, [access]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState("working");
    setMessage(null);
    setCreated(null);
    setCopied(false);
    setRevokeArmed(false);
    const days = Number(expiresInDays);
    try {
      const response = await fetch(`${apiBaseUrl}/v1/admin/invitations`, {
        method: "POST",
        credentials: "include",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          role,
          expiresInDays: days,
          ...(leagueId ? { leagueId, leagueRole } : {}),
        }),
      });
      if (!response.ok) {
        const detail =
          response.status === 401
            ? "Sign in before creating an invitation."
            : response.status === 403
              ? "Only an administrator can create invitations."
              : response.status === 503
                ? "Set a stable SESSION_SECRET and restart the API to enable invitations."
                : "The invitation could not be created.";
        throw new Error(detail);
      }
      const invitation = (await response.json()) as CreatedInvitation;
      setCreated(invitation);
      setEmail("");
      setRole("member");
      setLeagueId("");
      setLeagueRole("manager");
      setState("idle");
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : "The invitation could not be created.");
    }
  }

  async function copyInvitation() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.invitationUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setMessage("Clipboard access failed. Select and copy the invitation link manually.");
    }
  }

  async function revokeInvitation() {
    if (!created) return;
    if (!revokeArmed) {
      setRevokeArmed(true);
      setMessage(null);
      return;
    }
    setState("working");
    setMessage(null);
    try {
      const response = await fetch(`${apiBaseUrl}/v1/admin/invitations/${created.id}`, {
        method: "DELETE",
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (!response.ok && response.status !== 204) throw new Error("Revocation failed");
      setCreated(null);
      setRevokeArmed(false);
      setState("idle");
      setMessage("Invitation revoked. Its link can no longer be accepted.");
    } catch {
      setState("error");
      setMessage("The invitation could not be revoked.");
    }
  }

  if (access !== "admin") {
    return (
      <div className="connections-page">
        <section className="page-heading connection-heading">
          <div>
            <p className="eyebrow">Member access</p>
            <h1>
              {access === "checking"
                ? "Checking administrator access…"
                : "Administrator access required"}
            </h1>
            <p className="page-subtitle">
              {access === "checking"
                ? "Confirming your session before invitation controls are shown."
                : "Invitation controls are available only to the Laces Out host."}
            </p>
          </div>
          <div className="connection-security-chip">
            <ShieldCheck size={18} />
            <span>
              <strong>Protected controls</strong>
              <small>Administrator session required</small>
            </span>
          </div>
        </section>
        {access === "denied" ? (
          <section className="member-registration-note" role="status">
            <LockKeyhole size={18} />
            <div>
              <strong>This page is locked</strong>
              <span>Sign in with an administrator account to manage invitations.</span>
            </div>
            <Link className="button button--dark button--small" href="/login">
              Sign in
            </Link>
          </section>
        ) : null}
      </div>
    );
  }

  return (
    <div className="connections-page">
      <section className="page-heading connection-heading">
        <div>
          <p className="eyebrow">Member access</p>
          <h1>Invite your league mates.</h1>
          <p className="page-subtitle">
            Send league mates to registration when it is enabled, or create a one-time link for a
            specific account or league role.
          </p>
        </div>
        <div className="connection-security-chip">
          <ShieldCheck size={18} />
          <span>
            <strong>Separate accounts</strong>
            <small>Registration or scoped link</small>
          </span>
        </div>
      </section>

      <section className="member-registration-note" aria-labelledby="registration-access-title">
        <KeyRound size={18} />
        <div>
          <strong id="registration-access-title">Registration access</strong>
          <span>
            The registration page follows this deployment’s open or shared-code setting. One-time
            invitation links work separately.
          </span>
        </div>
        <Link className="button button--outline button--small" href="/register">
          Open registration
        </Link>
      </section>

      <section className="connection-grid" aria-label="Member invitation controls">
        <article className="connection-provider connection-provider--members">
          <div className="connection-provider__head">
            <span className="connection-provider-logo connection-provider-logo--members">
              <UserPlus size={19} />
            </span>
            <div>
              <p className="eyebrow">Administrator action</p>
              <h2>Create a one-time invitation</h2>
            </div>
          </div>

          <form className="bridge-pair-form" onSubmit={(event) => void submit(event)}>
            <div className="bridge-fields">
              <label htmlFor="invite-email">
                Friend’s email
                <input
                  id="invite-email"
                  type="email"
                  autoComplete="email"
                  inputMode="email"
                  required
                  maxLength={254}
                  value={email}
                  onChange={(event) => {
                    setEmail(event.target.value);
                    setMessage(null);
                  }}
                  placeholder="friend@example.com"
                />
                <small>The invitation works only for this email address.</small>
              </label>
              <label htmlFor="invite-account-role">
                Account role
                <select
                  id="invite-account-role"
                  value={role}
                  onChange={(event) => {
                    setRole(event.target.value as "member" | "admin");
                    setMessage(null);
                  }}
                >
                  <option value="member">Member (standard access)</option>
                  <option value="admin">Administrator (full control)</option>
                </select>
                <small>
                  Use Member unless this person should manage invitations and host settings.
                </small>
              </label>
              <label htmlFor="invite-league">
                League access
                <select
                  id="invite-league"
                  value={leagueId}
                  onChange={(event) => setLeagueId(event.target.value)}
                  disabled={leaguesState === "loading" || leaguesState === "error"}
                >
                  <option value="">
                    {leaguesState === "loading"
                      ? "Loading leagues…"
                      : leaguesState === "error"
                        ? "Leagues unavailable"
                        : "No specific league"}
                  </option>
                  {leagues.map((league) => (
                    <option value={league.id} key={league.id}>
                      {league.name}
                    </option>
                  ))}
                </select>
                <small>
                  {leaguesState === "error"
                    ? "League access could not be loaded. You can still create an account-only invitation."
                    : "Optional. Assign league access now or add it later."}
                </small>
              </label>
              <label htmlFor="invite-league-role">
                League role
                <select
                  id="invite-league-role"
                  value={leagueRole}
                  onChange={(event) =>
                    setLeagueRole(event.target.value as "commissioner" | "manager" | "viewer")
                  }
                  disabled={!leagueId}
                >
                  <option value="viewer">Viewer</option>
                  <option value="manager">Manager</option>
                  <option value="commissioner">Commissioner</option>
                </select>
              </label>
              <label htmlFor="invite-expiry">
                Expires in
                <select
                  id="invite-expiry"
                  value={expiresInDays}
                  onChange={(event) => setExpiresInDays(event.target.value)}
                >
                  <option value="1">1 day</option>
                  <option value="3">3 days</option>
                  <option value="7">7 days</option>
                  <option value="14">14 days</option>
                  <option value="30">30 days</option>
                </select>
              </label>
            </div>
            {role === "admin" ? (
              <div className="member-role-warning" role="status">
                <AlertCircle size={15} />
                <span>
                  <strong>Administrator access is powerful.</strong> This person will be able to
                  create invitations and use other host-only controls.
                </span>
              </div>
            ) : null}
            <button className="button button--lime button--full" disabled={state === "working"}>
              {state === "working" ? (
                <LoaderCircle className="spin" size={16} />
              ) : (
                <KeyRound size={16} />
              )}
              {state === "working" ? "Creating…" : "Create one-time invitation"}
            </button>
          </form>

          {message ? (
            <p
              className={state === "error" ? "connection-error" : "provider-attribution"}
              role={state === "error" ? "alert" : "status"}
            >
              {state === "error" ? <AlertCircle size={14} /> : <Check size={14} />}
              {message}
            </p>
          ) : null}
        </article>

        <article className="connection-provider connection-provider--invitation">
          <div className="connection-provider__head">
            <span className="connection-provider-logo connection-provider-logo--invitation">
              <UsersRound size={19} />
            </span>
            <div>
              <p className="eyebrow">Share safely</p>
              <h2>Current invitation</h2>
            </div>
          </div>

          {created ? (
            <div className="bridge-token">
              <div>
                <LockKeyhole size={15} />
                <span>
                  <strong>Copy this link now</strong>
                  <small>
                    For {created.email} · expires {new Date(created.expiresAt).toLocaleString()}
                  </small>
                </span>
              </div>
              <code aria-label="One-time invitation URL">{created.invitationUrl}</code>
              <button
                className="button button--outline button--small"
                type="button"
                onClick={() => void copyInvitation()}
              >
                {copied ? <Check size={14} /> : <Clipboard size={14} />}
                {copied ? "Copied" : "Copy link"}
              </button>
              <div className="invitation-actions">
                {revokeArmed ? (
                  <button
                    className="button button--outline button--small"
                    type="button"
                    onClick={() => setRevokeArmed(false)}
                    disabled={state === "working"}
                  >
                    Keep invitation
                  </button>
                ) : null}
                <button
                  className="button button--soft button--small"
                  type="button"
                  onClick={() => void revokeInvitation()}
                  disabled={state === "working"}
                >
                  {state === "working" ? (
                    <LoaderCircle className="spin" size={14} />
                  ) : (
                    <Trash2 size={14} />
                  )}
                  {state === "working"
                    ? "Revoking…"
                    : revokeArmed
                      ? "Yes, revoke link"
                      : "Revoke link"}
                </button>
              </div>
              <details className="invitation-security-detail">
                <summary>How this link is protected</summary>
                <small>
                  Its one-time secret stays after <code>#</code>, outside HTTP request targets and
                  referrers. Only a verification hash is stored.
                </small>
              </details>
            </div>
          ) : (
            <div className="bridge-readiness" role="note">
              <LockKeyhole size={16} />
              <div>
                <strong>No invitation displayed</strong>
                <span>Create one at left. Its access key is shown only once.</span>
              </div>
            </div>
          )}
        </article>
      </section>
    </div>
  );
}
