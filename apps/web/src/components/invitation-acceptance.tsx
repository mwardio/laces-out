"use client";

import {
  AlertCircle,
  ArrowRight,
  Check,
  LoaderCircle,
  LockKeyhole,
  MailCheck,
  UserPlus,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";

import { apiBaseUrl } from "../lib/api-client";
import { BACK_TO_SIGN_IN } from "../lib/copy";
import { leagueAccessLabel } from "../lib/invitation-access";

interface InvitationInspection {
  readonly emailHint: string;
  readonly role: "member" | "admin";
  readonly scope: {
    readonly leagueName: string | null;
    readonly leagueRole: "member" | "commissioner";
  } | null;
  readonly expiresAt: string;
  readonly requiresAuthentication: boolean;
}

type ViewState = "loading" | "ready" | "submitting" | "accepted" | "pending-confirmation" | "error";

function invitationToken(): string | null {
  const token = window.location.hash.slice(1);
  return /^[A-Za-z0-9_-]{43}$/u.test(token) ? token : null;
}

export function InvitationAcceptance() {
  const router = useRouter();
  const [token, setToken] = useState<string | null>(null);
  const [inspection, setInspection] = useState<InvitationInspection | null>(null);
  const [state, setState] = useState<ViewState>("loading");
  const [message, setMessage] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");

  useEffect(() => {
    const capability = invitationToken();
    if (!capability) {
      setMessage("This invitation link is incomplete or invalid.");
      setState("error");
      return;
    }
    setToken(capability);
    const controller = new AbortController();
    void fetch(`${apiBaseUrl}/v1/invitations/inspect`, {
      method: "POST",
      credentials: "include",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ token: capability }),
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("This invitation is expired, revoked, or unavailable.");
        return (await response.json()) as InvitationInspection;
      })
      .then((value) => {
        setInspection(value);
        setState("ready");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setMessage(error instanceof Error ? error.message : "The invitation could not be checked.");
        setState("error");
      });
    return () => controller.abort();
  }, []);

  async function accept(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token || !inspection || state === "submitting") return;
    if (!inspection.requiresAuthentication && password !== confirmation) {
      setMessage("The password confirmation does not match.");
      return;
    }
    setState("submitting");
    setMessage(null);
    try {
      const response = await fetch(`${apiBaseUrl}/v1/invitations/accept`, {
        method: "POST",
        credentials: "include",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          ...(inspection.requiresAuthentication
            ? {}
            : { displayName: displayName.trim(), password }),
        }),
      });
      if (!response.ok) {
        const problem: unknown = await response.json().catch(() => null);
        if (
          response.status === 403 &&
          problem !== null &&
          typeof problem === "object" &&
          "code" in problem &&
          problem.code === "email_verification_required"
        ) {
          window.history.replaceState(null, "", "/invite#confirmation-pending");
          setState("pending-confirmation");
          return;
        }
        const detail =
          response.status === 401
            ? "Sign in to the invited account, then return here and accept again."
            : response.status === 409
              ? "This invitation belongs to another account or was already used."
              : "The invitation could not be accepted.";
        throw new Error(detail);
      }
      window.history.replaceState(null, "", "/invite#accepted");
      setState("accepted");
      window.setTimeout(() => {
        router.replace("/app");
        router.refresh();
      }, 700);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The invitation could not be accepted.");
      setState("ready");
    }
  }

  return (
    <form className="login-form" onSubmit={(event) => void accept(event)}>
      <div className="login-form__heading">
        <span className="login-lock">
          {state === "accepted" ? (
            <Check size={17} />
          ) : state === "pending-confirmation" ? (
            <MailCheck size={17} />
          ) : (
            <UserPlus size={17} />
          )}
        </span>
        <div>
          <p className="eyebrow">Private invitation</p>
          <h1>
            {state === "accepted"
              ? "You’re in"
              : state === "pending-confirmation"
                ? "Check your inbox"
                : state === "error"
                  ? "This invitation can’t be opened"
                  : "Join the league room"}
          </h1>
          {inspection ? <p>Invitation for {inspection.emailHint}</p> : null}
        </div>
      </div>

      {message ? (
        <div className="login-error" role="alert">
          <AlertCircle size={16} />
          <span>{message}</span>
        </div>
      ) : null}

      {state === "loading" ? (
        <button className="button button--lime login-submit" type="button" disabled>
          <LoaderCircle className="spin" size={16} /> Checking invitation…
        </button>
      ) : null}

      {inspection && state !== "accepted" && state !== "pending-confirmation" ? (
        <>
          <div className="login-error" role="status">
            <LockKeyhole size={16} />
            <span>
              {inspection.scope
                ? `${leagueAccessLabel(inspection.scope.leagueRole)} access to ${inspection.scope.leagueName ?? "the invited league"}`
                : `${inspection.role} access to this private locker room`}
              {`. Expires ${new Date(inspection.expiresAt).toLocaleString()}.`}
            </span>
          </div>

          {!inspection.requiresAuthentication ? (
            <div className="login-fields">
              <label htmlFor="invite-display-name">Display name</label>
              <input
                id="invite-display-name"
                autoComplete="name"
                required
                maxLength={100}
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                disabled={state === "submitting"}
              />
              <label htmlFor="invite-password">Create a password</label>
              <input
                id="invite-password"
                type="password"
                autoComplete="new-password"
                minLength={12}
                maxLength={128}
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                disabled={state === "submitting"}
              />
              <label htmlFor="invite-password-confirmation">Confirm password</label>
              <input
                id="invite-password-confirmation"
                type="password"
                autoComplete="new-password"
                minLength={12}
                maxLength={128}
                required
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                disabled={state === "submitting"}
              />
            </div>
          ) : (
            <div className="login-demo-route">
              <span>Already have an account?</span>
              <Link href="/login" target="_blank" rel="noreferrer">
                Sign in, then return
              </Link>
            </div>
          )}

          <button
            className="button button--lime login-submit"
            type="submit"
            disabled={state === "submitting"}
          >
            {state === "submitting" ? <LoaderCircle className="spin" size={16} /> : null}
            {state === "submitting" ? "Joining…" : "Accept invitation"}
            {state !== "submitting" ? <ArrowRight size={15} /> : null}
          </button>
        </>
      ) : null}

      {state === "accepted" ? (
        <button className="button button--lime login-submit" type="button" disabled>
          <Check size={16} /> Opening your dashboard…
        </button>
      ) : null}

      {state === "pending-confirmation" ? (
        <>
          <Link className="button button--lime login-submit" href="/verify-email">
            Resend confirmation <ArrowRight size={15} />
          </Link>
          <div className="login-demo-route">
            <span>Already confirmed?</span>
            <Link href="/login">{BACK_TO_SIGN_IN}</Link>
          </div>
        </>
      ) : null}

      {state === "error" ? (
        <>
          <Link className="button button--lime login-submit" href="/app">
            Tour the locker room <ArrowRight size={15} />
          </Link>
          <div className="login-demo-route">
            <span>Already have an account?</span>
            <Link href="/login">{BACK_TO_SIGN_IN}</Link>
          </div>
        </>
      ) : null}
    </form>
  );
}
