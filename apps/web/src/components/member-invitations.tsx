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
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const [leagueId, setLeagueId] = useState("");
  const [leagueRole, setLeagueRole] = useState<"commissioner" | "manager" | "viewer">("manager");
  const [expiresInDays, setExpiresInDays] = useState("7");
  const [created, setCreated] = useState<CreatedInvitation | null>(null);
  const [state, setState] = useState<"idle" | "working" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

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
    void fetch(`${apiBaseUrl}/v1/leagues`, {
      credentials: "include",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) return { leagues: [] };
        return (await response.json()) as { leagues?: readonly LeagueOption[] };
      })
      .then((result) => setLeagues(result.leagues ?? []))
      .catch(() => {
        if (!controller.signal.aborted) setLeagues([]);
      });
    return () => controller.abort();
  }, [access]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState("working");
    setMessage(null);
    setCreated(null);
    setCopied(false);
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
      setCreated((await response.json()) as CreatedInvitation);
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
            Share the group code for ordinary registration, or create a one-time link when someone
            needs a specific account or league role.
          </p>
        </div>
        <div className="connection-security-chip">
          <ShieldCheck size={18} />
          <span>
            <strong>Separate accounts</strong>
            <small>Shared code or scoped link</small>
          </span>
        </div>
      </section>

      <section className="member-registration-note" aria-labelledby="shared-code-title">
        <KeyRound size={18} />
        <div>
          <strong id="shared-code-title">Using the shared group code?</strong>
          <span>
            Send friends to the registration page with the code configured by the host. The same
            code can be used by the whole group.
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
                  autoComplete="off"
                  required
                  maxLength={254}
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </label>
              <label htmlFor="invite-workspace-role">
                Account role
                <select
                  id="invite-workspace-role"
                  value={role}
                  onChange={(event) => setRole(event.target.value as "member" | "admin")}
                >
                  <option value="member">Member</option>
                  <option value="admin">Administrator</option>
                </select>
              </label>
              <label htmlFor="invite-league">
                League access
                <select
                  id="invite-league"
                  value={leagueId}
                  onChange={(event) => setLeagueId(event.target.value)}
                >
                  <option value="">Locker room only</option>
                  {leagues.map((league) => (
                    <option value={league.id} key={league.id}>
                      {league.name}
                    </option>
                  ))}
                </select>
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
              role="status"
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
              <button
                className="button button--soft button--small"
                type="button"
                onClick={() => void revokeInvitation()}
                disabled={state === "working"}
              >
                <Trash2 size={14} /> Revoke link
              </button>
              <small>
                The secret lives after <code>#</code>, so browsers do not send it in HTTP request
                targets or referrers. Laces Out stores only its HMAC.
              </small>
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
